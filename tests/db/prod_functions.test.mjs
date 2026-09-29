// Go-live-relevante Production-Funktionen, die bisher nie gegen echtes Postgres liefen (fixtures/prod_functions.sql):
// Konto selbst löschen (+ Datenschutz-Nachweise an der Personalakte, Migration 27), Onboarding-Korrektur anfordern,
// Freischaltung alter Registrierungen, Aufbewahrungs-Löschung, Protokoll. Rechte + echte Mutation + Fehler/Wiederholung.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startDb, addPeople, loadLifecycle, loadProdFunctions, err, one, U, EMP, day } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2, E3] = [1, 2, 3, 4, 5]
let db
const count = async (sql, p) => (await one(db.sys, sql, p)).n
const asId = async id => { const c = await db.connect(); await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('SET ROLE authenticated'); return c }
const year = new Date().getFullYear()
const HISTORY = ['time_entries', 'time_entry_breaks', 'sick_leave', 'vacation_requests', 'payroll_months', 'payroll_documents', 'employee_documents']
const history = async emp => { const o = {}; for (const t of HISTORY) o[t] = await count(`SELECT count(*)::int n FROM ${t} WHERE employee_id = $1`, [emp]); return o }
async function seed(emp) {
  const te = (await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, 8) RETURNING id`, [emp, day(-3), `${day(-3)}T08:00:00Z`, `${day(-3)}T16:00:00Z`])).id
  await db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end) VALUES ($1, $2, $3, $4)`, [te, emp, `${day(-3)}T12:00:00Z`, `${day(-3)}T12:30:00Z`])
  await db.sys.query(`INSERT INTO sick_leave (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $2, 1)`, [emp, day(-10)])
  await db.sys.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, status) VALUES ($1, $2, $3, 5, 'approved')`, [emp, day(20), day(26)])
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month) VALUES ($1, $2, 1)`, [emp, year])
  await db.sys.query(`INSERT INTO payroll_documents (employee_id, year, month, file_name, file_path) VALUES ($1, $2, 1, 'l.pdf', 'x/l.pdf')`, [emp, year])
  await db.sys.query(`INSERT INTO employee_documents (employee_id, title, file_path, file_name) VALUES ($1, 'Vertrag', 'x/v.pdf', 'v.pdf')`, [emp])
}

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee'], [E3, 'employee']])
  // Wie in Production (read-only geprüft): jedes Profil hat Name/E-Mail – sonst wäre die Protokoll-Zusammenfassung NULL
  await db.sys.query(`UPDATE profiles p SET email = u.email, first_name = 'Test', last_name = 'Person' || right(p.id::text, 1) FROM auth.users u WHERE u.id = p.id`)
  await loadLifecycle(db.sys)
  await loadProdFunctions(db.sys)
})
after(async () => { await db?.stop() })

test('delete_own_account: nur angemeldet; einziger Admin und Eingestempelte blockiert, nichts geändert', async () => {
  assert.match(await err(async () => (await db.anon()).query(`SELECT delete_own_account()`)), /permission denied/)
  const a = await one(await db.as(ADMIN), `SELECT delete_own_account() v`)
  assert.deepEqual([a.v.success, /einzige Admin/.test(a.v.error)], [false, true])
  await db.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, $2, now())`, [EMP(E2), day(0)])
  const b = await one(await db.as(E2), `SELECT delete_own_account() v`)
  assert.deepEqual([b.v.success, /eingestempelt/.test(b.v.error)], [false, true])
  for (const n of [ADMIN, E2]) assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [U(n)]), 1)
})

test('delete_own_account (Mitarbeiter): Login + Konto weg; Personalakte, gesamte Historie und Datenschutz-Nachweise bleiben an der Personalakte', async () => {
  await seed(EMP(E1))
  await (await db.as(E1)).query(`SELECT acknowledge_privacy_notice('2026-09-28')`)
  await db.sys.query(`INSERT INTO employee_onboarding (profile_id, email, status, employee_id, privacy_accepted_at) VALUES ($1, 'person3@example.test', 'approved', $2, now() - interval '30 days')`, [U(E1), EMP(E1)])
  await db.sys.query(`UPDATE employees SET avatar_url = 'https://example.test/a.png' WHERE id = $1`, [EMP(E1)])
  const before1 = await history(EMP(E1))
  const c = await db.as(E1)
  assert.equal((await one(c, `SELECT delete_own_account() v`)).v.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [U(E1)]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM profiles WHERE id = $1`, [U(E1)]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [U(E1)]), 0, 'Kontodaten weg')
  const e = await one(db.sys, `SELECT id, is_active, avatar_url, hourly_rate::float r FROM employees WHERE id = $1`, [EMP(E1)])
  assert.deepEqual([e.id, e.is_active, e.avatar_url, e.r], [EMP(E1), true, null, 15], 'Personalakte bleibt, nur Profilbild entfernt')
  assert.deepEqual(await history(EMP(E1)), before1, 'Historie vollständig erhalten')
  const proofs = (await db.sys.query(`SELECT source, notice_version FROM privacy_proof_history WHERE employee_id = $1 ORDER BY source`, [EMP(E1)])).rows
  assert.deepEqual(proofs, [{ source: 'onboarding', notice_version: 'onboarding' }, { source: 'portal', notice_version: '2026-09-28' }], 'Nachweise an der Personalakte')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'account.deleted' AND target_id = $1`, [U(E1)]), 1)
  // Wiederholung (Doppelklick/alte Sitzung): keine Änderung, keine Doppel-Nachweise
  await one(c, `SELECT delete_own_account() v`)
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_proof_history WHERE employee_id = $1`, [EMP(E1)]), 2)
  assert.deepEqual(await history(EMP(E1)), before1)
  // Lesen: nur Admin
  assert.equal((await (await db.as(E3)).query(`SELECT * FROM privacy_proof_history`)).rowCount, 0)
  assert.equal((await (await db.as(MANAGER)).query(`SELECT * FROM privacy_proof_history`)).rowCount, 0)
  assert.equal((await (await db.as(ADMIN)).query(`SELECT * FROM privacy_proof_history WHERE employee_id = $1`, [EMP(E1)])).rowCount, 2)
  assert.match(await err(async () => (await db.as(ADMIN)).query(`DELETE FROM privacy_proof_history`)), /permission denied/, 'niemand löscht Nachweise per API')
  // Neu einladen verknüpft wieder dieselbe Personalakte
  const inv = await one(db.sys, `INSERT INTO invitations (email, employee_id, role, created_by) VALUES ('person3@example.test', $1, 'employee', $2) RETURNING token`, [EMP(E1), U(ADMIN)])
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, 'person3@example.test', NULL, $2)`, [id, { invite_token: inv.token }])
  assert.equal((await one(db.sys, `SELECT employee_id FROM profiles WHERE id = $1`, [id])).employee_id, EMP(E1))
})

test('delete_own_account (Registrierung ohne Personalakte): Konto + Kenntnisnahme weg, keine Historie angelegt', async () => {
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, 'reg@example.test', now())`, [id])
  const c = await asId(id)
  await c.query(`SELECT acknowledge_privacy_notice('2026-09-28')`)
  const before1 = await count(`SELECT count(*)::int n FROM privacy_proof_history`)
  assert.equal((await one(c, `SELECT delete_own_account() v`)).v.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [id]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_proof_history`), before1)
})

test('request_onboarding_changes: nur Admin, Pflicht-Notiz, nur aus „eingereicht“, parallel genau einmal; danach kann die Person korrigieren', async () => {
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, 'onb@example.test', now())`, [id])
  const onb = (await one(db.sys, `INSERT INTO employee_onboarding (profile_id, email, status, first_name, last_name, privacy_accepted_at, submitted_at) VALUES ($1, 'onb@example.test', 'submitted', 'Ona', 'Test', now(), now()) RETURNING id`, [id])).id
  for (const n of [E3, MANAGER]) assert.match(await err(async () => (await db.as(n)).query(`SELECT request_onboarding_changes($1, 'x')`, [onb])), /Nicht autorisiert/)
  assert.match(await err(async () => (await db.anon()).query(`SELECT request_onboarding_changes($1, 'x')`, [onb])), /permission denied/)
  const a = await db.as(ADMIN)
  assert.equal((await one(a, `SELECT request_onboarding_changes($1, '  ') v`, [onb])).v.success, false, 'Notiz Pflicht')
  const res = await Promise.all([await db.as(ADMIN), await db.as(ADMIN)].map(c => one(c, `SELECT request_onboarding_changes($1, 'IBAN prüfen') v`, [onb]).then(r => r.v)))
  assert.equal(res.filter(r => r.success).length, 1, 'parallel genau einmal')
  const o = await one(db.sys, `SELECT status, review_note, reviewed_by FROM employee_onboarding WHERE id = $1`, [onb])
  assert.deepEqual([o.status, o.review_note, o.reviewed_by], ['changes_requested', 'IBAN prüfen', U(ADMIN)])
  assert.equal((await one(await asId(id), `SELECT save_onboarding($1, false) v`, [{ first_name: 'Ona', city: 'Frankfurt' }])).v.success, true, 'Person kann korrigieren')
  await db.sys.query(`UPDATE employee_onboarding SET status = 'approved' WHERE id = $1`, [onb])
  assert.equal((await one(a, `SELECT request_onboarding_changes($1, 'x') v`, [onb])).v.success, false, 'nicht nach Freischaltung')
})

test('approve_user: nur Admin, gültige Rolle, keine Doppelverknüpfung', async () => {
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'alt@example.test')`, [id])
  assert.match(await err(async () => (await db.as(MANAGER)).query(`SELECT approve_user($1, 'employee', NULL)`, [id])), /Nicht autorisiert/)
  const a = await db.as(ADMIN)
  assert.match(await err(() => a.query(`SELECT approve_user($1, 'boss', NULL)`, [id])), /Ungültige Rolle/)
  assert.match(await err(() => a.query(`SELECT approve_user($1, 'employee', $2)`, [id, EMP(E3)])), /bereits mit einem anderen Konto/)
  assert.equal((await one(db.sys, `SELECT status FROM profiles WHERE id = $1`, [id])).status, 'pending', 'nichts geändert')
  const emp = (await one(db.sys, `INSERT INTO employees (first_name, last_name, email, hourly_rate, start_date) VALUES ('Alt', 'Konto', 'alt@example.test', 15, '2026-01-01') RETURNING id`)).id
  await a.query(`SELECT approve_user($1, 'employee', $2)`, [id, emp])
  const p = await one(db.sys, `SELECT status, role, employee_id FROM profiles WHERE id = $1`, [id])
  assert.deepEqual([p.status, p.role, p.employee_id], ['approved', 'employee', emp])
})

test('Aufbewahrung: nur Admin; Probelauf ändert nichts; löscht nur Abgelaufenes; Ausgeschiedene samt Nachweisen erst nach Frist; Dateien blockieren', async () => {
  const old = `${year - 4}-06-02`, recent = day(-5)
  const mkEmp = async (email, active, end) => (await one(db.sys, `INSERT INTO employees (first_name, last_name, email, hourly_rate, start_date, is_active, end_date) VALUES ('R', 'Test', $1, 15, '2010-01-01', $2, $3) RETURNING id`, [email, active, end])).id
  const cur = await mkEmp('cur@example.test', true, null)
  const oldTe = (await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, 8) RETURNING id`, [cur, old, `${old}T08:00:00Z`, `${old}T16:00:00Z`])).id
  const newTe = (await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, 8) RETURNING id`, [cur, recent, `${recent}T08:00:00Z`, `${recent}T16:00:00Z`])).id
  // Rechte
  for (const n of [E3, MANAGER]) assert.equal((await one(await db.as(n), `SELECT retention_purge('zeiten', false, NULL) v`)).v.success, false)
  assert.match(await err(async () => (await db.as(ADMIN)).query(`SELECT _retention_purge_do('zeiten')`)), /permission denied/, 'interne Funktion nicht per API')
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries WHERE id = $1`, [oldTe]), 1)
  const a = await db.as(ADMIN)
  // Probelauf
  const logs = await count(`SELECT count(*)::int n FROM activity_log`)
  assert.equal((await one(a, `SELECT retention_purge('zeiten', true, NULL) v`)).v.dry_run, true)
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries WHERE id = $1`, [oldTe]), 1, 'Probelauf löscht nichts')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log`), logs, 'Probelauf protokolliert nichts')
  // Echt: nur Abgelaufenes
  const r = (await one(a, `SELECT retention_purge('zeiten', false, NULL) v`)).v
  assert.equal(r.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries WHERE id = $1`, [oldTe]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries WHERE id = $1`, [newTe]), 1, 'Aktuelles bleibt')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'retention.purged' AND target_name = 'zeiten'`), 1)
  // Ausgeschiedene: nur nach Ablauf (end_date vor Cut8); frisch Ausgeschiedene + Aktive bleiben
  const former = await mkEmp('former@example.test', false, `${year - 9}-03-31`)
  const fresh = await mkEmp('fresh@example.test', false, `${year - 1}-03-31`)
  const fid = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'former@example.test')`, [fid])
  await db.sys.query(`BEGIN; SET LOCAL app.bypass_privilege_trigger = 'on'; UPDATE profiles SET status = 'approved', employee_id = '${former}' WHERE id = '${fid}'; COMMIT`)
  assert.equal((await one(db.sys, `SELECT employee_id FROM profiles WHERE id = $1`, [fid])).employee_id, former, 'Testaufbau: Login verknüpft')
  await db.sys.query(`INSERT INTO privacy_proof_history (employee_id, source, notice_version, acknowledged_at) VALUES ($1, 'portal', '2017-01-01', now()), ($2, 'portal', '2025-01-01', now())`, [former, fresh])
  await db.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, 8)`, [fresh, recent, `${recent}T08:00:00Z`, `${recent}T16:00:00Z`])
  // Datei des Ausgeschiedenen vorhanden → blockiert, nichts gelöscht
  await db.sys.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('employee-documents', $1)`, [`${former}/vertrag.pdf`])
  const blocked = (await one(a, `SELECT retention_purge('ehemalige', false, NULL) v`)).v
  assert.equal(blocked.success, false)
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE id = $1`, [former]), 1)
  await db.sys.query(`DELETE FROM storage.objects WHERE name = $1`, [`${former}/vertrag.pdf`])
  assert.equal((await one(a, `SELECT retention_purge('ehemalige', false, NULL) v`)).v.success, true)
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE id = $1`, [former]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [fid]), 0, 'Login des Ausgeschiedenen mit entfernt')
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_proof_history WHERE employee_id = $1`, [former]), 0, 'Nachweise teilen die Frist der Personalakte')
  for (const id of [fresh, cur, EMP(E1)]) assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE id = $1`, [id]), 1, 'vor Fristablauf bleibt alles')
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_proof_history WHERE employee_id = $1`, [fresh]), 1)
  // Attest-Datei vorhanden → Krankmeldung wird übersprungen, nicht gelöscht
  const sick = (await one(db.sys, `INSERT INTO sick_leave (employee_id, start_date, end_date, days_count, certificate_file_path) VALUES ($1, $2, $2, 1, $3) RETURNING id`, [cur, old, `${cur}/au.pdf`])).id
  await db.sys.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('sick-certs', $1)`, [`${cur}/au.pdf`])
  const k = (await one(a, `SELECT retention_purge('krank', false, NULL) v`)).v
  assert.deepEqual([k.success, k.skipped], [true, 1])
  assert.equal(await count(`SELECT count(*)::int n FROM sick_leave WHERE id = $1`, [sick]), 1)
  assert.equal((await one(a, `SELECT retention_purge('gibtsnicht', false, NULL) v`)).v.success, false)
})

test('log_activity: Akteur kommt vom Server (Fälschung ignoriert), anonym verweigert', async () => {
  const id = (await one(await db.as(E3), `SELECT log_activity('x.test', 'test', 'Chefin hat alles gelöscht.', 'Admin Chefin', 'admin') v`)).v
  const r = await one(db.sys, `SELECT actor_id, actor_role, actor_name FROM activity_log WHERE id = $1`, [id])
  assert.deepEqual([r.actor_id, r.actor_role, r.actor_name], [U(E3), 'employee', 'Test Person5'])
  assert.match(await err(async () => (await db.anon()).query(`SELECT log_activity('a', 'b', 'c')`)), /permission denied/)
})

test('update_own_personal_data: nur eigene Personalakte, nur freigeschaltet; Validierung ändert nichts; Vergütung/Rolle unantastbar; protokolliert', async () => {
  const c = await db.as(E3)
  const before1 = await one(db.sys, `SELECT iban, tax_id, hourly_rate::float r, pay_type, personnel_number FROM employees WHERE id = $1`, [EMP(E3)])
  for (const [data, field] of [[{ iban: 'DE00 1234' }, 'iban'], [{ tax_id: '123' }, 'tax_id'], [{ postal_code: '1234' }, 'postal_code'], [{ birth_date: 'kein Datum' }, 'birth_date']]) {
    assert.equal((await one(c, `SELECT update_own_personal_data($1) v`, [data])).v.field, field)
  }
  assert.deepEqual(await one(db.sys, `SELECT iban, tax_id, hourly_rate::float r, pay_type, personnel_number FROM employees WHERE id = $1`, [EMP(E3)]), before1, 'ungültig → nichts geändert')
  const ok = (await one(c, `SELECT update_own_personal_data($1) v`, [{ iban: 'DE89 3704 0044 0532 0130 00', hourly_rate: 99, pay_type: 'fixed', personnel_number: '999' }])).v
  assert.deepEqual([ok.success, ok.changed], [true, ['Bankverbindung']])
  const after1 = await one(db.sys, `SELECT iban, hourly_rate::float r, pay_type, personnel_number FROM employees WHERE id = $1`, [EMP(E3)])
  assert.deepEqual([after1.iban, after1.r, after1.pay_type, after1.personnel_number], ['DE89370400440532013000', before1.r, before1.pay_type, before1.personnel_number], 'nur erlaubte Felder, Vergütung/Personalnummer unverändert')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'employee.personal_data_updated' AND target_id = $1`, [EMP(E3)]), 1)
  // gesperrt / ohne Personalakte / anonym
  await db.sys.query(`BEGIN; SET LOCAL app.bypass_privilege_trigger = 'on'; UPDATE profiles SET status = 'disabled' WHERE id = '${U(E3)}'; COMMIT`)
  assert.equal((await one(await db.as(E3), `SELECT update_own_personal_data($1) v`, [{ phone: '1' }])).v.success, false, 'gesperrt → keine Änderung')
  await db.sys.query(`BEGIN; SET LOCAL app.bypass_privilege_trigger = 'on'; UPDATE profiles SET status = 'approved' WHERE id = '${U(E3)}'; COMMIT`)
  assert.equal((await one(await db.as(MANAGER), `SELECT update_own_personal_data($1) v`, [{ phone: '2' }])).v.success, true, 'Manager nur eigene Akte')
  assert.equal((await one(db.sys, `SELECT phone FROM employees WHERE id = $1`, [EMP(E3)])).phone, null, 'fremde Akte unverändert')
  assert.match(await err(async () => (await db.anon()).query(`SELECT update_own_personal_data('{}'::jsonb)`)), /permission denied/)
})
