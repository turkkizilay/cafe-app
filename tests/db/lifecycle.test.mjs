// Account-Lifecycle (Invite → Auth → Onboarding → Freischaltung → Recovery) mit den Production-Funktionen
// (fixtures/lifecycle_functions.sql) + Migrationen 24/25. Signup wird wie Supabase simuliert: INSERT in auth.users
// (unbestätigt) löst on_auth_user_created aus. Nur synthetische Personen/Adressen, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startDb, addPeople, loadLifecycle, err, one, U, EMP, day } from './harness.mjs'

const [ADMIN, MANAGER, E1] = [1, 2, 3]
let db
const asId = async id => { const c = await db.connect(); await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('SET ROLE authenticated'); return c }
const count = async (sql, p) => (await one(db.sys, sql, p)).n

async function invite({ email, employeeId = null, role = 'employee', job = null, expiresIn = '7 days' }) {
  const a = await db.session(ADMIN)
  return one(a, `INSERT INTO invitations (email, employee_id, role, created_by, job, expires_at) VALUES ($1, $2, $3, $4, $5, now() + $6::interval) RETURNING id, token`, [email, employeeId, role, U(ADMIN), job, expiresIn])
}
// Supabase-signUp nachbilden: unbestätigtes Auth-Konto mit Einladungs-Token in den Metadaten
async function signup(email, token) {
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, NULL, $3)`, [id, email, token ? { invite_token: token } : {}])
  return id
}
const VALID = { first_name: 'Ada', last_name: 'Müller-Lüdenscheidt', birth_date: '1995-04-01', street: 'Testweg', house_number: '1a', postal_code: '60311', city: 'Frankfurt', phone: '+49 69 123', iban: 'DE89370400440532013000', account_holder: 'Ada Müller', tax_id: '12345678901', social_security_number: '12345678A123', health_insurance: 'TK', other_employment: false, emergency_contact_name: 'Bo', emergency_contact_phone: '+49 170 1', privacy_accepted: true }
const submitted = async email => { const id = await signup(email, (await invite({ email })).token); const c = await asId(id); const r = await one(c, `SELECT save_onboarding($1, true) v`, [{ ...VALID }]); assert.equal(r.v.success, true, JSON.stringify(r.v)); return { id, onb: (await one(db.sys, `SELECT id FROM employee_onboarding WHERE profile_id = $1`, [id])).id } }
const approveArgs = (onb, pay = 'hourly', employment = 'teilzeit', salary = null) => [onb, 'employee', 'Service', employment, 20, 15.5, day(3), 28, pay, salary]
const approveSql = `SELECT approve_onboarding_with_pay($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) v`

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }]])
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2100 WHERE id = $1`, [EMP(E1)])
  await db.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, 8)`, [EMP(E1), day(-3), `${day(-3)}T08:00:00Z`, `${day(-3)}T16:00:00Z`])
  await loadLifecycle(db.sys)
})
after(async () => { await db?.stop() })

test('Einladung neuer Person: Signup (Groß-/Kleinschreibung, Leerzeichen) → Profil wartend + Onboarding-Entwurf, kein Mitarbeiter', async () => {
  const emps = await count(`SELECT count(*)::int n FROM employees`)
  const inv = await invite({ email: 'neu1@example.test', job: { hourly_rate: 16 } })
  const id = await signup('Neu1@Example.test', inv.token)
  const p = await one(db.sys, `SELECT status, employee_id FROM profiles WHERE id = $1`, [id])
  assert.deepEqual([p.status, p.employee_id], ['pending', null])
  assert.equal((await one(db.sys, `SELECT status FROM employee_onboarding WHERE profile_id = $1`, [id])).status, 'draft')
  assert.ok((await one(db.sys, `SELECT used_at FROM invitations WHERE id = $1`, [inv.id])).used_at, 'Einladung beim Signup eingelöst')
  assert.equal(await count(`SELECT count(*)::int n FROM employees`), emps, 'kein Mitarbeiter vor der Freischaltung')
  const states = await (await db.session(ADMIN)).query(`SELECT * FROM admin_account_states() WHERE profile_id = $1`, [id])
  assert.equal(states.rows[0].email_confirmed, false, 'Admin sieht: Bestätigung ausstehend')
})

test('Retry/zweites Gerät: gleiche Adresse kein zweites Konto; gleicher Link mit anderer Adresse wird nicht verknüpft', async () => {
  const inv = await invite({ email: 'neu2@example.test' })
  await signup('neu2@example.test', inv.token)
  assert.match(await err(() => signup('neu2@example.test', inv.token)), /duplicate key|unique/i)
  // Migration 28: fremde Adresse mit dem Link → gar kein Konto (vorher: wartendes Konto ohne Onboarding = Sackgasse)
  assert.match(await err(() => signup('fremd@example.test', inv.token)), /nicht mehr gültig/)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE email = 'fremd@example.test'`), 0, 'kein Konto')
  assert.equal(await count(`SELECT count(*)::int n FROM profiles WHERE email = 'fremd@example.test'`), 0, 'kein Profil')
  const info = await one(await db.anon(), `SELECT get_invitation_info($1) v`, [inv.token])
  assert.equal(info.v.reason, 'used')
})

test('Abgelaufene/zurückgezogene Einladung: kein Konto, klare Gründe; wartende Registrierung ohne Einladung kann der Admin sauber ablehnen (keine Waise)', async () => {
  const exp = await invite({ email: 'alt@example.test', expiresIn: '-1 day' })
  assert.equal((await one(await db.anon(), `SELECT get_invitation_info($1) v`, [exp.token])).v.reason, 'expired')
  // Migration 28: Registrierung mit abgelaufenem Link legt nichts an (vorher: wartendes Konto ohne Onboarding)
  assert.match(await err(() => signup('alt@example.test', exp.token)), /nicht mehr gültig/)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE email = 'alt@example.test'`), 0)
  assert.equal((await one(db.sys, `SELECT used_at FROM invitations WHERE id = $1`, [exp.id])).used_at, null, 'Einladung unverändert')
  // Registrierung ganz ohne Einladung bleibt möglich (wartet auf Admin) → Admin lehnt sauber ab
  const id = await signup('alt@example.test', null)
  assert.equal(await count(`SELECT count(*)::int n FROM employee_onboarding WHERE profile_id = $1`, [id]), 0)
  for (const who of [E1, MANAGER]) assert.match(await err(() => db.session(who).then(c => c.query(`SELECT admin_reject_pending_login($1)`, [id]))), /Nicht autorisiert/)
  await (await db.session(ADMIN)).query(`SELECT admin_reject_pending_login($1)`, [id])
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [id]), 0, 'Auth-Konto mit entfernt')
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id)`), 0, 'keine verwaiste Anmeldung')
  const inv2 = await invite({ email: 'alt@example.test' })
  assert.equal((await one(await db.anon(), `SELECT get_invitation_info($1) v`, [inv2.token])).v.valid, true, 'neu einladbar')
})

test('Bestehender Mitarbeiter: Signup verknüpft genau einmal; zweite Einladung erzeugt keine zweite Verknüpfung', async () => {
  const emp = (await one(db.sys, `INSERT INTO employees (first_name, last_name, email, hourly_rate, start_date, employment_type, hours_per_week) VALUES ('Bea', 'Bestand', 'bea@example.test', 15, '2026-01-01', 'minijob', 10) RETURNING id`)).id
  const id = await signup('bea@example.test', (await invite({ email: 'bea@example.test', employeeId: emp })).token)
  assert.deepEqual(Object.values(await one(db.sys, `SELECT status, employee_id FROM profiles WHERE id = $1`, [id])), ['approved', emp])
  const st = (await (await db.session(ADMIN)).query(`SELECT email_confirmed FROM admin_account_states() WHERE profile_id = $1`, [id])).rows[0]
  assert.equal(st.email_confirmed, false, 'freigeschaltet, aber E-Mail offen → Admin sieht es')
  // Migration 28: zweite Verknüpfung scheitert → gar kein Konto (vorher: wartendes Konto ohne Verknüpfung)
  const inv2 = await invite({ email: 'bea2@example.test', employeeId: emp })
  assert.ok(await err(() => signup('bea2@example.test', inv2.token)), 'Registrierung abgelehnt')
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE email = 'bea2@example.test'`), 0, 'kein Konto ohne Verknüpfung')
  assert.equal((await one(db.sys, `SELECT used_at FROM invitations WHERE id = $1`, [inv2.id])).used_at, null, 'Einladung nicht verbraucht')
  assert.equal(await count(`SELECT count(*)::int n FROM profiles WHERE employee_id = $1`, [emp]), 1)
})

test('Onboarding: Entwurf mehrfach speichern idempotent; ungültige Einreichung ändert nichts; doppeltes/paralleles Einreichen sicher', async () => {
  const id = await signup('neu3@example.test', (await invite({ email: 'neu3@example.test' })).token)
  const c = await asId(id)
  for (let i = 0; i < 3; i++) assert.equal((await one(c, `SELECT save_onboarding($1, false) v`, [{ first_name: 'Ada', city: 'Frankfurt' }])).v.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM employee_onboarding WHERE profile_id = $1`, [id]), 1)
  const bad = await one(c, `SELECT save_onboarding($1, true) v`, [{ ...VALID, tax_id: '123' }])
  assert.equal(bad.v.field, 'tax_id')
  assert.equal((await one(db.sys, `SELECT status FROM employee_onboarding WHERE profile_id = $1`, [id])).status, 'draft')
  const noPrivacy = await one(c, `SELECT save_onboarding($1, true) v`, [{ ...VALID, privacy_accepted: false }])
  assert.equal(noPrivacy.v.field, 'privacy_accepted')
  const [x, y] = [await asId(id), await asId(id)]
  const res = await Promise.all([x, y].map(k => one(k, `SELECT save_onboarding($1, true) v`, [{ ...VALID }])))
  // Migration 28: Einreichen ist idempotent – beide melden Erfolg, genau eine echte Einreichung
  assert.equal(res.filter(r => r.v.success && !r.v.already).length, 1, 'genau eine Einreichung')
  assert.equal(res.filter(r => r.v.success && r.v.already).length, 1, 'zweite: bereits eingereicht, kein Fehler')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'employee.onboarding_submitted' AND target_id = (SELECT id::text FROM employee_onboarding WHERE profile_id = $1)`, [id]), 1)
  const after1 = await one(db.sys, `SELECT status, tax_id, submitted_at FROM employee_onboarding WHERE profile_id = $1`, [id])
  assert.equal(after1.status, 'submitted')
  const late = (await one(c, `SELECT save_onboarding($1, true) v`, [{ ...VALID, tax_id: '99999999999' }])).v
  assert.deepEqual([late.success, late.already], [true, true], 'nach Einreichung: Erfolg, aber Daten nicht übernommen')
  assert.equal((await one(db.sys, `SELECT tax_id FROM employee_onboarding WHERE profile_id = $1`, [id])).tax_id, after1.tax_id)
  assert.equal((await one(c, `SELECT save_onboarding($1, false) v`, [{ ...VALID, tax_id: '99999999999' }])).v.success, false, 'Entwurf nach Einreichung abgelehnt')
})

test('Freischaltung mit Vergütung: nur Admin, atomar (Fixgehalt oder gar nichts), kein Duplikat bei Retry/parallel', async () => {
  const s1 = await submitted('neu4@example.test')
  for (const who of [E1, MANAGER]) assert.match(await err(() => db.session(who).then(c => c.query(approveSql, approveArgs(s1.onb, 'fixed', 'teilzeit', 1800)))), /Nicht autorisiert/)
  const a = await db.session(ADMIN)
  assert.match((await one(a, approveSql, approveArgs(s1.onb, 'fixed', 'werkstudent', 900))).v.error, /nur bei Vollzeit oder Teilzeit/)
  assert.equal((await one(db.sys, `SELECT status FROM employee_onboarding WHERE id = $1`, [s1.onb])).status, 'submitted', 'nichts freigeschaltet')
  const ok = (await one(a, approveSql, approveArgs(s1.onb, 'fixed', 'teilzeit', 1800))).v
  assert.equal(ok.success, true)
  const e = await one(db.sys, `SELECT pay_type, monthly_salary::float m, hourly_rate::float r, email FROM employees WHERE id = $1`, [ok.employee_id])
  assert.deepEqual([e.pay_type, e.m, e.r, e.email], ['fixed', 1800, 15.5, 'neu4@example.test'])
  assert.equal((await one(db.sys, `SELECT employee_id FROM profiles WHERE id = $1`, [s1.id])).employee_id, ok.employee_id)
  assert.equal((await one(db.sys, `SELECT iban FROM employee_onboarding WHERE id = $1`, [s1.onb])).iban, null, 'Onboarding-Personaldaten nach Übernahme gelöscht')
  assert.equal((await one(a, approveSql, approveArgs(s1.onb, 'fixed', 'teilzeit', 1800))).v.success, false, 'Retry ohne Wirkung')
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE lower(email) = 'neu4@example.test'`), 1)

  // Atomarität: schlägt das Anlegen mit Fixgehalt fehl (seit Migration 30 ein INSERT), wird die gesamte Freischaltung zurückgerollt
  const s2 = await submitted('neu5@example.test')
  await db.sys.query(`CREATE FUNCTION test_fail_pay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pay_type = 'fixed' THEN RAISE EXCEPTION 'simulierter Fehler'; END IF; RETURN NEW; END $$;
                      CREATE TRIGGER test_fail_pay BEFORE INSERT OR UPDATE OF pay_type ON employees FOR EACH ROW EXECUTE FUNCTION test_fail_pay();`)
  assert.match(await err(() => a.query(approveSql, approveArgs(s2.onb, 'fixed', 'vollzeit', 3000))), /simulierter Fehler/)
  await db.sys.query(`DROP TRIGGER test_fail_pay ON employees; DROP FUNCTION test_fail_pay();`)
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE lower(email) = 'neu5@example.test'`), 0, 'kein halb angelegter Mitarbeiter')
  assert.equal((await one(db.sys, `SELECT status FROM employee_onboarding WHERE id = $1`, [s2.onb])).status, 'submitted')
  assert.equal((await one(db.sys, `SELECT status, employee_id FROM profiles WHERE id = $1`, [s2.id])).employee_id, null)

  // Zwei Admins/Tabs gleichzeitig
  const [k1, k2] = [await db.as(ADMIN), await db.as(ADMIN)]
  const both = await Promise.all([k1, k2].map(k => one(k, approveSql, approveArgs(s2.onb)).then(r => r.v)))
  assert.equal(both.filter(r => r.success).length, 1)
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE lower(email) = 'neu5@example.test'`), 1)
})

test('Verwaiste Anmeldung (Auth ohne Profil): Admin sieht sie, entfernt nur sie; danach normale Einladung + neue Bestätigung', async () => {
  const emp = (await one(db.sys, `INSERT INTO employees (first_name, last_name, email, hourly_rate, start_date) VALUES ('Olga', 'Orphan', 'olga@example.test', 15, '2026-01-01') RETURNING id`)).id
  const orphan = await signup('olga@example.test', null)
  await db.sys.query('BEGIN'); await db.sys.query('SET LOCAL session_replication_role = replica')
  await db.sys.query(`DELETE FROM profiles WHERE id = $1`, [orphan]); await db.sys.query('COMMIT')     // wie das frühere „Registrierung ablehnen“
  assert.match(await err(() => signup('olga@example.test', null)), /duplicate key|unique/i, 'Sackgasse vorher: Registrierung unmöglich')
  const a = await db.session(ADMIN)
  const list = (await a.query(`SELECT * FROM admin_login_orphans()`)).rows
  const row = list.find(r => r.user_id === orphan)
  assert.deepEqual([row.email, row.email_confirmed, row.employee_match], ['olga@example.test', false, true])
  for (const who of [E1, MANAGER]) {
    assert.match(await err(() => db.session(who).then(c => c.query(`SELECT * FROM admin_login_orphans()`))), /Nicht autorisiert/)
    assert.match(await err(() => db.session(who).then(c => c.query(`SELECT admin_remove_orphan_login($1)`, [orphan]))), /Nicht autorisiert/)
  }
  assert.match(await err(() => a.query(`SELECT admin_remove_orphan_login($1)`, [U(E1)])), /ohne Benutzerkonto/, 'Konten mit Profil nie')
  assert.match(await err(() => a.query(`SELECT admin_remove_orphan_login($1)`, [U(ADMIN)])), /eigene Konto/)
  assert.equal((await one(a, `SELECT admin_remove_orphan_login($1) v`, [orphan])).v.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [orphan]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'employee.orphan_login_removed'`), 1)
  const fresh = await signup('olga@example.test', (await invite({ email: 'olga@example.test', employeeId: emp })).token)
  assert.equal((await one(db.sys, `SELECT email_confirmed_at FROM auth.users WHERE id = $1`, [fresh])).email_confirmed_at, null, 'Bestätigung wird nicht umgangen')
  assert.equal((await one(db.sys, `SELECT employee_id FROM profiles WHERE id = $1`, [fresh])).employee_id, emp, 'Verknüpfung nur über die Einladung')
})

test('Invarianten: Recovery ändert keine Vergütung/Mitarbeiter-ID/Historie, keine doppelten Mitarbeiter, keine Umgehung der Bestätigung', async () => {
  const e1 = await one(db.sys, `SELECT id, pay_type, monthly_salary::float m, hourly_rate::float r FROM employees WHERE id = $1`, [EMP(E1)])
  assert.deepEqual([e1.id, e1.pay_type, e1.m, e1.r], [EMP(E1), 'fixed', 2100, 15])
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries WHERE employee_id = $1`, [EMP(E1)]), 1)
  assert.equal(await count(`SELECT count(*)::int n FROM (SELECT lower(email) FROM employees GROUP BY 1 HAVING count(*) > 1) x`), 0)
  assert.match(await err(() => db.session(ADMIN).then(c => c.query(`SELECT admin_reject_pending_login($1)`, [U(E1)]))), /Nur wartende Registrierungen/, 'aktive Konten nicht löschbar')
  const src = (await db.sys.query(`SELECT string_agg(prosrc, ' ') s FROM pg_proc WHERE proname IN ('admin_account_states','admin_prepare_confirmation_resend','admin_reopen_registration','approve_onboarding_with_pay','admin_login_orphans','admin_remove_orphan_login','admin_reject_pending_login')`)).rows[0].s
  assert.doesNotMatch(src, /email_confirmed_at\s*=|confirmed_at\s*=/, 'keine Funktion setzt die E-Mail als bestätigt')
  const anon = await db.anon()
  for (const f of ['admin_login_orphans()', `admin_remove_orphan_login('${U(9)}')`, `admin_reject_pending_login('${U(9)}')`]) assert.match(await err(() => anon.query(`SELECT ${f}`)), /permission denied/, f)
})

test('Registrierung ablehnen (Auth + Profil): nur wartend, ohne Mitarbeiter, ohne Onboarding; nie eigenes/Owner-Konto', async () => {
  const a = await db.session(ADMIN)
  const reject = id => err(() => a.query(`SELECT admin_reject_pending_login($1)`, [id]))
  // Onboarding vorhanden (eingeladene Person) → nicht auf diesem Weg löschbar, Daten bleiben
  const withOnb = await signup('onb-reject@example.test', (await invite({ email: 'onb-reject@example.test' })).token)
  assert.match(await reject(withOnb), /Nur wartende Registrierungen/)
  assert.equal(await count(`SELECT count(*)::int n FROM employee_onboarding WHERE profile_id = $1`, [withOnb]), 1)
  // Gesperrtes Konto ohne Mitarbeiter/Onboarding → nicht abgelehnt (Status-Guard)
  const locked = await signup('gesperrt@example.test')
  await db.sys.query(`BEGIN; SET LOCAL app.bypass_privilege_trigger = 'on'; UPDATE profiles SET status = 'disabled' WHERE id = '${locked}'; COMMIT`)
  assert.match(await reject(locked), /Nur wartende Registrierungen/)
  // Eigenes Konto nie
  assert.match(await reject(U(ADMIN)), /kann nicht abgelehnt werden/)
  for (const id of [withOnb, locked, U(ADMIN)]) assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [id]), 1, 'Konto unverändert')
  // Gegenprobe: wartend ohne alles → Auth + Profil weg, keine Waise
  const plain = await signup('wartend@example.test')
  assert.equal((await one(a, `SELECT admin_reject_pending_login($1) v`, [plain])).v.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [plain]), 0)
  assert.equal((await a.query(`SELECT * FROM admin_login_orphans() WHERE user_id = $1`, [plain])).rowCount, 0)
})
