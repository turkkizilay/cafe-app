// Migration 38: Zugang zurücksetzen (nur Admin, serverseitig), Pflicht zur Passwortänderung als Server-Sperre
// (PostgREST-Pre-Request + Storage-Policy), Sitzungen beendet (auch noch gültige Access-Tokens), Generation gegen
// Doppelklick/zwei Admins, Pflichtprotokoll ohne Geheimnisse, keine Änderung an Mitarbeiter-/Zeit-/Lohndaten.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, EMP, U } from './harness.mjs'

const [ADMIN, ADMIN2, MANAGER, E1, E2, OWNER, INACTIVE, DISABLED] = [1, 2, 3, 4, 5, 6, 7, 8]
let db

// Anfrage wie über PostgREST: Rolle authenticated + Claims inkl. session_id; path = request.path
async function client(n, { sid = null, claims = {} } = {}) {
  const c = await db.connect()
  await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U(n), role: 'authenticated', ...(sid ? { session_id: sid } : {}), ...claims })])
  await c.query('SET ROLE authenticated')
  return c
}
async function service() {
  const c = await db.connect()
  await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })])
  await c.query('SET ROLE service_role')
  return c
}
const login = async n => (await one(db.sys, `INSERT INTO auth.sessions (user_id) VALUES ($1) RETURNING id`, [U(n)])).id
const gate = async (c, path) => err(async () => { await c.query(`SELECT set_config('request.path', $1, false)`, [path]); await c.query('SELECT access_gate()') })
const begin = async (c, emp, gen) => (await one(c, `SELECT admin_begin_access_reset($1, $2) r`, [EMP(emp), gen])).r
const finish = async (n, gen) => (await one(await service(), `SELECT service_access_reset_finish($1, $2) r`, [U(n), gen])).r
const sec = n => one(db.sys, `SELECT * FROM account_security WHERE user_id = $1`, [U(n)])
const audit = n => rows(db.sys, `SELECT event, generation, actor_id, employee_id, must_change_password, detail FROM account_reset_audit WHERE user_id = $1 ORDER BY id`, [U(n)])
const sessionsOf = async n => (await one(db.sys, `SELECT count(*)::int c FROM auth.sessions WHERE user_id = $1`, [U(n)])).c
// Vollständiger Reset wie die Edge Function (Passwort selbst setzt Auth – hier nicht beteiligt)
async function fullReset(emp) {
  const a = await client(ADMIN)
  const st = (await one(a, `SELECT admin_access_reset_state($1) r`, [EMP(emp)])).r
  const b = await begin(a, emp, st.generation)
  assert.equal(b.ok, true, JSON.stringify(b))
  assert.equal((await finish(emp, b.generation)).ok, true)
  return b.generation
}
const snapshot = () => one(db.sys, `SELECT md5(string_agg(t, '|' ORDER BY t)) h FROM (
  SELECT 'p' || row(p.*)::text t FROM profiles p UNION ALL SELECT 'e' || row(e.*)::text FROM employees e
  UNION ALL SELECT 't' || row(x.*)::text FROM time_entries x UNION ALL SELECT 'u' || row(u.*)::text FROM auth.users u) s`)

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [ADMIN2, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee'],
                           [OWNER, 'employee'], [INACTIVE, 'employee', { active: false }], [DISABLED, 'employee', { status: 'disabled' }]])
  await db.sys.query(`SET session_replication_role = replica; UPDATE profiles SET is_owner = true WHERE id = $1; SET session_replication_role = origin`.replace('$1', `'${U(OWNER)}'`))
  // Storage-Policies wie live (im Dashboard angelegt, siehe storage_sick_certs.test.mjs): eigene Atteste lesen/hochladen.
  // Migration 38 wurde in startDb schon angewendet – RESTRICTIVE wirkt erst mit aktivem RLS, das hier wie live eingeschaltet wird.
  const own = `(storage.foldername(name))[1] = (SELECT (profiles.employee_id)::text FROM profiles WHERE profiles.id = auth.uid())`
  await db.sys.query(`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY sick_certs_download ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'sick-certs' AND ((${own}) OR is_manager_or_admin()));
    CREATE POLICY sick_certs_upload_own ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'sick-certs' AND (${own}));`)
})
const setRole = (n, role) => db.sys.query(`SET session_replication_role = replica; UPDATE profiles SET role = '${role}' WHERE id = '${U(n)}'; SET session_replication_role = origin`)
after(async () => { await db?.stop() })
beforeEach(() => db.sys.query(`DELETE FROM account_security; DELETE FROM account_reset_audit; DELETE FROM auth.sessions; DELETE FROM activity_log;`))

test('Admin setzt zurück: Pflicht + Generation, alle Sitzungen samt Refresh-Tokens beendet, Protokoll ohne Geheimnisse', async () => {
  const s1 = await login(E1), s2 = await login(E1)
  await db.sys.query(`INSERT INTO auth.refresh_tokens (session_id, token) VALUES ($1, 'rt1'), ($2, 'rt2')`, [s1, s2])
  const before = await snapshot()
  const a = await client(ADMIN)
  const st = (await one(a, `SELECT admin_access_reset_state($1) r`, [EMP(E1)])).r
  assert.deepEqual(st, { eligible: true, reason: null, generation: 0, must_change_password: false, in_progress: false })
  const b = await begin(a, E1, 0)
  assert.deepEqual([b.ok, b.generation, b.user_id], [true, 1, U(E1)], 'Ziel serverseitig aus employee_id abgeleitet')
  assert.equal(await sessionsOf(E1), 0, 'Sitzungen beendet')
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM auth.refresh_tokens`)).c, 0, 'Refresh-Tokens gelöscht (CASCADE)')
  assert.ok((await sec(E1)).reset_in_progress_until, 'Sperre während die Edge Function läuft')
  assert.deepEqual(await finish(E1, 1), { ok: true })
  const s = await sec(E1)
  assert.deepEqual([s.must_change_password, s.reset_generation, s.reset_in_progress_until], [true, 1, null])
  assert.deepEqual((await audit(E1)).map(r => [r.event, r.generation, r.actor_id, r.employee_id, r.detail]),
    [['reset_started', 1, U(ADMIN), EMP(E1), null], ['reset_completed', 1, U(ADMIN), EMP(E1), null]])
  const log = await one(db.sys, `SELECT actor_id, action, summary, target_id FROM activity_log WHERE action = 'employee.access_reset'`)
  assert.deepEqual([log.actor_id, log.target_id], [U(ADMIN), EMP(E1)])
  assert.doesNotMatch(JSON.stringify(log), /pass(wort|word)\s*[:=]/i)
  assert.equal((await snapshot()).h, before.h, 'Profile, Mitarbeiter, Zeiten, Auth-Konten unverändert')
})

test('Nur Admin: Manager, Mitarbeiter, anonym, gefälschte Claims → abgelehnt (protokolliert), nichts geändert', async () => {
  for (const n of [MANAGER, E2]) {
    assert.deepEqual(await begin(await client(n), E1, 0), { ok: false, reason: 'forbidden' })
    assert.match(await err(async () => (await client(n)).query(`SELECT admin_access_reset_state($1)`, [EMP(E1)])), /Nicht autorisiert/)
  }
  // Rolle im JWT gefälscht: maßgeblich ist die Profilrolle (live)
  assert.deepEqual(await begin(await client(E2, { claims: { user_role: 'admin', app_metadata: { role: 'admin' } } }), E1, 0), { ok: false, reason: 'forbidden' })
  const anon = await db.anon()
  assert.match(await err(() => anon.query(`SELECT admin_begin_access_reset($1, 0)`, [EMP(E1)])), /permission denied/)
  assert.match(await err(() => anon.query(`SELECT my_access_state()`)), /permission denied/)
  assert.equal(await sec(E1), undefined, 'keine Pflicht gesetzt')
  assert.deepEqual((await rows(db.sys, `SELECT actor_id, detail FROM account_reset_audit WHERE event = 'reset_rejected' ORDER BY id`)).map(r => r.detail),
                   ['forbidden', 'forbidden', 'forbidden'])
})

test('Server-Funktionen nur mit service_role: Admin, Mitarbeiter, gefälschter Rollen-Claim → verweigert', async () => {
  for (const c of [await client(ADMIN), await client(E1), await client(E1, { claims: { role: 'service_role' } })]) {
    for (const q of [`SELECT service_access_reset_finish('${U(E1)}', 1)`, `SELECT service_complete_password_change('${U(E1)}', 1, NULL)`,
                     `SELECT service_access_reset_failed('${U(E1)}', 1, 'x')`, `SELECT service_password_change_failed('${U(E1)}', 'x')`])
      assert.match(await err(() => c.query(q)), /permission denied/, q)
  }
  // service_role-Grant, aber Claim nicht service_role (z. B. falsch konfigurierter Server) → Laufzeitprüfung
  const c = await db.connect(); await c.query(`SET ROLE service_role`)
  assert.match(await err(() => c.query(`SELECT service_access_reset_finish($1, 1)`, [U(E1)])), /Nur für den Server/)
})

test('Ziel-Regeln: nicht sich selbst, nicht Inhaber, kein Admin, nur aktiv/freigeschaltet, nur mit Login', async () => {
  const a = await client(ADMIN)
  await db.sys.query(`INSERT INTO employees (id, first_name, last_name, email, hourly_rate, start_date) VALUES ($1, 'Ohne', 'Login', 'x@example.test', 15, '2026-01-01')`, [EMP(9)])
  for (const [emp, reason] of [[ADMIN, 'self'], [ADMIN2, 'privileged_role'], [OWNER, 'owner'], [INACTIVE, 'inactive_employee'], [DISABLED, 'not_active'], [9, 'no_login']]) {
    assert.deepEqual(await begin(a, emp, 0), { ok: false, reason }, `Ziel ${emp}`)
    assert.equal((await one(a, `SELECT admin_access_reset_state($1) r`, [EMP(emp)])).r.reason, reason)
  }
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM account_security`)).c, 0)
  assert.ok((await begin(a, MANAGER, 0)).ok, 'Manager darf zurückgesetzt werden')
})

test('Pflicht zur Passwortänderung sperrt JEDE Data-API-Anfrage außer my_access_state – auch Definer-RPCs, auch ohne Pfad', async () => {
  await fullReset(E1)
  const sid = await login(E1)                     // Anmeldung mit dem temporären Passwort (neue Sitzung)
  const c = await client(E1, { sid })
  assert.equal(await gate(c, '/rpc/my_access_state'), null)
  assert.deepEqual((await one(c, `SELECT my_access_state() r`)).r, { must_change_password: true, generation: 1 })
  for (const p of ['/profiles', '/employees', '/time_entries', '/rpc/log_activity', '/rpc/clock_in_remote', '/rpc/start_break', '/vacation_requests',
                   '/sick_leave', '/employee_documents', '/payroll_documents', '/rpc/my_access_state/../profiles', '/rpc/my_access_state_x', ''])
    assert.match(await gate(c, p) || '', /neues Passwort festlegen/, `Pfad ${p || '(leer)'}`)
  const e = await one(db.sys, `SELECT 1 FROM pg_roles WHERE rolname = 'authenticator' AND 'pgrst.db_pre_request=public.access_gate' = ANY(rolconfig)`)
  assert.ok(e, 'Pre-Request für PostgREST registriert')
  // Unbeteiligte unverändert
  assert.equal(await gate(await client(E2, { sid: await login(E2) }), '/time_entries'), null)
  assert.equal(await gate(await client(ADMIN), '/employees'), null)
  assert.equal(await gate(await db.anon(), '/invitations'), null)
  assert.equal(await gate(await service(), '/employees'), null)
})

test('Beendete Sitzung: noch gültiges Access-Token (alte session_id) wird überall abgewiesen – auch my_access_state', async () => {
  const old = await login(E1)
  const c = await client(E1, { sid: old })
  assert.equal(await gate(c, '/time_entries'), null, 'vorher erlaubt')
  await fullReset(E1)
  for (const p of ['/time_entries', '/rpc/my_access_state'])
    assert.match(await gate(c, p) || '', /Sitzung beendet/, p)
  assert.match(await err(() => c.query(`SELECT my_access_state()`)), /Sitzung beendet/)
  assert.match(await gate(await client(E1), '/rpc/my_access_state') || '', /Sitzung beendet/, 'Token ohne session_id nach Reset gesperrt')
  // Sitzung existiert zwar (z. B. Löschung gescheitert), begann aber vor dem Reset → trotzdem gesperrt
  const early = await one(db.sys, `INSERT INTO auth.sessions (user_id, created_at) VALUES ($1, now() - interval '1 hour') RETURNING id`, [U(E1)])
  assert.match(await gate(await client(E1, { sid: early.id }), '/rpc/my_access_state') || '', /Sitzung beendet/)
  // Fremde session_id (anderer Nutzer) zählt nicht
  assert.match(await gate(await client(E1, { sid: await login(E2) }), '/rpc/my_access_state') || '', /Sitzung beendet/)
})

test('Storage: gesperrte Person liest/lädt keine Dateien (RESTRICTIVE), Unbeteiligte unverändert', async () => {
  await db.sys.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('sick-certs', $1), ('sick-certs', $2)`, [`${EMP(E1)}/a.pdf`, `${EMP(E2)}/b.pdf`])
  const count = async (n, sid) => (await one(await client(n, { sid }), `SELECT count(*)::int c FROM storage.objects WHERE bucket_id = 'sick-certs'`)).c
  const s1 = await login(E1)
  assert.equal(await count(E1, s1), 1, 'vorher eigene Datei sichtbar')
  await fullReset(E1)
  const s1b = await login(E1)
  assert.equal(await count(E1, s1b), 0, 'Pflicht zur Passwortänderung')
  assert.equal(await count(E1, s1), 0, 'alte Sitzung')
  assert.match(await err(async () => (await client(E1, { sid: s1b })).query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('sick-certs', $1)`, [`${EMP(E1)}/neu.pdf`])), /row-level security/)
  assert.equal(await count(E2, await login(E2)), 1, 'andere Person unverändert')
})

test('Kein direkter Zugriff: Person kann Pflicht/Status weder lesen noch ändern; Protokoll nur Admin lesend, nie schreibbar', async () => {
  await fullReset(E1)
  const c = await client(E1, { sid: await login(E1) })
  for (const q of [`UPDATE account_security SET must_change_password = false`, `DELETE FROM account_security`, `SELECT * FROM account_security`,
                   `INSERT INTO account_security (user_id) VALUES ('${U(E2)}')`, `INSERT INTO account_reset_audit (event) VALUES ('password_changed')`,
                   `SELECT _access_reset_audit('${U(E1)}', NULL, NULL, 'password_changed', 1, false, NULL)`])
    assert.match(await err(() => c.query(q)), /permission denied/, q)
  assert.equal((await sec(E1)).must_change_password, true)
  assert.equal((await one(c, `SELECT count(*)::int c FROM account_reset_audit`)).c, 0, 'Mitarbeiter sieht kein Protokoll')
  assert.equal((await one(await client(MANAGER), `SELECT count(*)::int c FROM account_reset_audit`)).c, 0, 'Manager sieht kein Protokoll')
  assert.equal((await one(await client(ADMIN), `SELECT count(*)::int c FROM account_reset_audit`)).c, 2, 'Admin liest')
  for (const q of [`UPDATE account_reset_audit SET detail = NULL`, `DELETE FROM account_reset_audit`])
    assert.match(await err(async () => (await client(ADMIN)).query(q)), /permission denied/, q)
  assert.match(await err(() => db.sys.query(`INSERT INTO account_reset_audit (event, detail) VALUES ('reset_failed', 'Passwort: Abc-123')`)), /account_reset_audit_detail_check/, 'Freitext (Passwort) im Protokoll unmöglich')
})

test('Doppelklick / zwei Tabs / zwei Admins: genau ein Reset; veraltete Ansicht und laufender Reset abgelehnt', async () => {
  const [a1, a2] = [await client(ADMIN), await client(ADMIN2)]
  const r = await Promise.all([begin(a1, E1, 0), begin(a2, E1, 0), begin(await client(ADMIN), E1, 0)])
  assert.equal(r.filter(x => x.ok).length, 1, JSON.stringify(r))
  assert.deepEqual(r.filter(x => !x.ok).map(x => x.reason).sort(), ['in_progress', 'in_progress'])
  assert.deepEqual(await begin(a2, E1, 1), { ok: false, reason: 'in_progress' }, 'auch mit aktueller Generation, solange die Edge Function läuft')
  assert.equal((await one(a2, `SELECT admin_access_reset_state($1) r`, [EMP(E1)])).r.in_progress, true)
  await finish(E1, 1)
  assert.deepEqual(await begin(a2, E1, 0), { ok: false, reason: 'stale', generation: 1 }, 'veraltete Ansicht (Generation 0)')
  assert.equal((await sec(E1)).reset_generation, 1)
  // Sperre abgelaufen (Edge Function abgestürzt) → neuer Reset wieder möglich
  await db.sys.query(`UPDATE account_security SET reset_in_progress_until = now() - interval '1 second' WHERE user_id = $1`, [U(E1)])
  assert.equal((await begin(a2, E1, 1)).ok, true)
})

test('Zweiter Reset: Generation 2, Sitzungen mit Passwort A beendet; verspäteter Abschluss von Reset 1 → superseded', async () => {
  await fullReset(E1)
  const sA = await login(E1)
  await fullReset(E1)
  assert.equal(await sessionsOf(E1), 0, 'Sitzung mit Passwort A beendet')
  assert.match(await gate(await client(E1, { sid: sA }), '/rpc/my_access_state') || '', /Sitzung beendet/)
  assert.deepEqual(await finish(E1, 1), { ok: false, reason: 'superseded' }, 'alter Abschluss zeigt kein Passwort')
  const svc = await service()
  assert.deepEqual((await one(svc, `SELECT service_complete_password_change($1, 1, NULL) r`, [U(E1)])).r, { ok: false, reason: 'superseded' })
  assert.equal((await sec(E1)).must_change_password, true, 'Passwortänderung mit Stand von Reset 1 löscht die Pflicht nicht')
})

test('Passwort geändert: Pflicht gelöscht, aktuelle Sitzung bleibt, übrige beendet; idempotent; danach normaler Zugriff', async () => {
  await fullReset(E1)
  const [keep, other] = [await login(E1), await login(E1)]
  const svc = await service()
  const done = (await one(svc, `SELECT service_complete_password_change($1, 1, $2) r`, [U(E1), keep])).r
  assert.deepEqual(done, { ok: true, already: false })
  assert.deepEqual((await rows(db.sys, `SELECT id FROM auth.sessions WHERE user_id = $1`, [U(E1)])).map(r => r.id), [keep])
  assert.equal(await gate(await client(E1, { sid: keep }), '/time_entries'), null, 'normaler Zugriff')
  assert.match(await gate(await client(E1, { sid: other }), '/time_entries') || '', /Sitzung beendet/)
  assert.deepEqual((await one(svc, `SELECT service_complete_password_change($1, 1, $2) r`, [U(E1), keep])).r, { ok: true, already: true }, 'Wiederholung')
  assert.deepEqual((await audit(E1)).map(r => [r.event, r.must_change_password]),
    [['reset_started', true], ['reset_completed', true], ['password_changed', false]])
  // Neue Anmeldung später funktioniert normal (Sitzung nach dem Reset begonnen)
  assert.equal(await gate(await client(E1, { sid: await login(E1) }), '/employees'), null)
})

test('Passwort setzen gescheitert: Sperre frei, Pflicht bleibt (sicherer Zustand), Fehlercode protokolliert, nie Freitext', async () => {
  const a = await client(ADMIN)
  const b = await begin(a, E1, 0)
  const svc = await service()
  await svc.query(`SELECT service_access_reset_failed($1, $2, 'auth_timeout')`, [U(E1), b.generation])
  await svc.query(`SELECT service_access_reset_failed($1, $2, 'Passwort: Abc-defg-123')`, [U(E1), b.generation])
  const s = await sec(E1)
  assert.deepEqual([s.must_change_password, s.reset_in_progress_until], [true, null])
  assert.deepEqual((await audit(E1)).filter(r => r.event === 'reset_failed').map(r => r.detail), ['auth_timeout', 'unknown'])
  assert.equal((await begin(a, E1, 1)).ok, true, 'neuer Versuch möglich')
  await svc.query(`SELECT service_password_change_failed($1, 'weak_password')`, [U(E1)])
  assert.equal((await audit(E1)).at(-1).event, 'password_change_failed')
})

test('Admin mit offener Pflicht (z. B. später befördert) kann nicht zurücksetzen; Rollenwechsel wirkt live', async () => {
  await fullReset(MANAGER)
  await setRole(MANAGER, 'admin')
  assert.deepEqual(await begin(await client(MANAGER, { sid: await login(MANAGER) }), E1, 0), { ok: false, reason: 'forbidden' })
  await setRole(MANAGER, 'manager')
  await setRole(ADMIN2, 'employee')
  assert.deepEqual(await begin(await client(ADMIN2), E1, 0), { ok: false, reason: 'forbidden' }, 'Admin-Rolle entzogen → sofort gesperrt')
  await setRole(ADMIN2, 'admin')
})

test('Konto gelöscht (Registrierungs-Reset/Aufbewahrung): Status folgt per CASCADE, Protokoll bleibt ohne Personenbezug', async () => {
  await db.sys.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'tmp9@example.test')`, [U(9)])
  await db.sys.query(`INSERT INTO employees (id, first_name, last_name, email, hourly_rate, start_date) VALUES ($1, 'Tmp', 'Nine', 'tmp9@example.test', 15, '2026-01-01') ON CONFLICT (id) DO NOTHING`, [EMP(9)])
  await db.sys.query(`DELETE FROM profiles WHERE employee_id = $1`, [EMP(9)])
  await db.sys.query(`INSERT INTO profiles (id, role, status, employee_id) VALUES ($1, 'employee', 'approved', $2) ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, status = 'approved'`, [U(9), EMP(9)])
  await fullReset(9)
  await db.sys.query(`DELETE FROM auth.users WHERE id = $1`, [U(9)])
  assert.equal(await sec(9), undefined)
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM account_reset_audit WHERE employee_id = $1 AND user_id IS NULL`, [EMP(9)])).c, 2)
})
