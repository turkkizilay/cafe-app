// Test-Harness für DB/RLS/Concurrency-Tests.
// Startet ein TEMPORÄRES lokales PostgreSQL 17 (embedded-postgres) auf einem freien Port in einem Temp-Ordner,
// spielt die Schema-Vorlage (Production-Struktur vor Migration 17) und danach die Repository-Migrationen 17–35 ein.
// Sicherheit: Es werden KEINE Verbindungsdaten aus der Umgebung gelesen (kein DATABASE_URL o. Ä.) – Verbindungen
// gehen ausschließlich an 127.0.0.1 auf den selbst gestarteten Server. Production kann nie erreicht werden.
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', '..', 'supabase', 'migrations_onboarding')
export const MIGRATIONS = [
  '17_break_tracking.sql', '18_compensation_model.sql', '19_manager_data_minimization.sql', '20_swap_approve_atomic.sql',
  '21_one_open_time_entry.sql', '22_sick_certs_no_manager_delete.sql', '23_privacy_notice_acknowledgements.sql',
  '24_account_recovery.sql', '25_account_lifecycle_hardening.sql', '26_registration_reset.sql', '27_ops_integrity.sql',
  '28_onboarding_resumable.sql', '29_remote_clock.sql', '30_fixed_pay_hourly_optional.sql', '31_hessen_holidays.sql',
  '32_onboarding_emergency_optional.sql', '33_sick_cases.sql', '34_break_hardening.sql', '35_labor_cost_today.sql',
]
// Migrationen, die Invite/Auth/Onboarding-Funktionen ersetzen: nach der Production-Vorlage (loadLifecycle) erneut
// einspielen, sonst prüften Tests den Stand VOR der Migration. Diese Dateien sind wiederholt ausführbar geschrieben.
export const LIFECYCLE_MIGRATIONS = ['28_onboarding_resumable.sql', '30_fixed_pay_hourly_optional.sql', '32_onboarding_emergency_optional.sql']
export const migration = name => readFileSync(join(MIGRATIONS_DIR, name), 'utf8')

// Was Supabase selbst bereitstellt: Rollen, auth.uid()/auth.users, extensions, storage.objects, Default-Grants
const PLATFORM = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA storage;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}', raw_app_meta_data jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(),
                           email_confirmed_at timestamptz DEFAULT now(), confirmation_sent_at timestamptz, last_sign_in_at timestamptz);
  CREATE UNIQUE INDEX users_email_key ON auth.users (email);   -- wie Supabase: eine Adresse = ein Auth-Konto
  CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now());
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
  CREATE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  GRANT USAGE ON SCHEMA public, auth, extensions, storage TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION storage.foldername(text) TO anon, authenticated, service_role;
  GRANT ALL ON storage.objects TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer(); srv.unref(); srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
  })
}

// Synthetische IDs: U(n) = auth-/Profil-ID, EMP(n) = Mitarbeiter-ID (n = 1..9)
export const U = n => `00000000-0000-0000-0000-00000000000${n}`
export const EMP = n => `10000000-0000-0000-0000-00000000000${n}`

// Datum relativ zu heute (Server-Datum), damit Tests nicht „veralten“
export const day = offset => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10) }

export async function startDb({ migrations = MIGRATIONS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cafe-db-test-'))
  const port = await freePort()
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, onLog: () => {}, onError: () => {} })
  await server.initialise(); await server.start(); await server.createDatabase('cafe_test')
  const connect = async () => { const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'test', database: 'cafe_test' }); await c.connect(); return c }
  const sys = await connect()   // Superuser ohne JWT = Server-/Systemkontext (auth.uid() ist NULL)
  await sys.query(PLATFORM)
  await sys.query(readFileSync(join(HERE, 'fixtures', 'schema_before_17.sql'), 'utf8'))
  for (const m of migrations) await sys.query(migration(m))
  const open = new Set()
  // Verbindung als angemeldete Person – wie PostgREST: Rolle authenticated + JWT-Claims
  const as = async n => {
    const c = await connect(); open.add(c)
    await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U(n), role: 'authenticated' })])
    await c.query('SET ROLE authenticated')
    return c
  }
  // Eine wiederverwendete Sitzung je Person für nacheinander ablaufende Schritte (as() = neue Verbindung, für Parallelität)
  const sessions = new Map()
  const session = async n => { if (!sessions.has(n)) sessions.set(n, await as(n)); return sessions.get(n) }
  const anon = async () => { const c = await connect(); open.add(c); await c.query('SET ROLE anon'); return c }
  const stop = async () => {
    for (const c of open) await c.end().catch(() => {})
    await sys.end().catch(() => {})
    await server.stop().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
  return { sys, connect, as, session, anon, stop }
}

// Synthetische Personen: [[n, role, { employment_type, hours_per_week, active }], …] – keine echten Daten
export async function addPeople(sys, list) {
  for (const [n, role, opt = {}] of list) {
    await sys.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [U(n), `person${n}@example.test`])
    await sys.query(`INSERT INTO employees (id, first_name, last_name, email, hourly_rate, start_date, employment_type, hours_per_week, is_active, iban, tax_id, social_security_number)
                     VALUES ($1, 'Test', $2, $3, 15, '2026-01-01', $4, $5, $6, $7, $8, $9)`,
      [EMP(n), `Person${n}`, `person${n}@example.test`, opt.employment_type || 'vollzeit', opt.hours_per_week ?? 40, opt.active ?? true, `DE00TEST${n}`, `TAX${n}`, `SV${n}`])
    await sys.query(`INSERT INTO profiles (id, role, status, employee_id) VALUES ($1, $2, $3, $4)`, [U(n), role, opt.status || 'approved', EMP(n)])
  }
}

// Invite/Auth/Onboarding-Funktionen wie in Production (inkl. on_auth_user_created). Erst NACH addPeople laden,
// weil der Trigger bei jedem neuen auth.users-Eintrag ein Profil anlegt. Danach die Migrationen, die diese Funktionen
// ersetzen (Stand nach dem Rollout).
export async function loadLifecycle(sys) {
  await sys.query(readFileSync(join(HERE, 'fixtures', 'lifecycle_functions.sql'), 'utf8'))
  for (const m of LIFECYCLE_MIGRATIONS) await sys.query(migration(m))
}
// Weitere go-live-relevante Production-Funktionen (Konto löschen, Aufbewahrung, …) – NACH loadLifecycle laden
export const loadProdFunctions = sys => sys.query(readFileSync(join(HERE, 'fixtures', 'prod_functions.sql'), 'utf8'))

// Fehlermeldung einer Operation (null = erfolgreich)
export const err = async fn => { try { await fn(); return null } catch (e) { return e.message } }
export const rows = async (c, sql, params) => (await c.query(sql, params)).rows
export const one = async (c, sql, params) => (await c.query(sql, params)).rows[0]
