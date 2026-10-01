// Fixgehalt ohne Stundenlohn (Migration 30): Freischaltung (approve_onboarding_with_pay) und spätere Stammdaten-
// Änderungen mit pay_type als Quelle der Wahrheit. Stundenlohn: Satz Pflicht. Fixgehalt: Monatsgehalt Pflicht, Satz
// optional (NULL), nie ein Ersatzwert. Bestehende Daten unverändert. Production-Funktionen (Vorlage) + Migrationen.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startDb, addPeople, loadLifecycle, err, one, U, EMP, day } from './harness.mjs'

const [ADMIN, MANAGER, FIXED_OLD, HOURLY_OLD] = [1, 2, 3, 4]
let db
const asId = async id => { const c = await db.connect(); await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('SET ROLE authenticated'); return c }
const VALID = { first_name: 'Fia', last_name: 'Fix', birth_date: '1990-02-03', street: 'Testweg', house_number: '2', postal_code: '60311', city: 'Frankfurt', phone: '+49 69 1234', iban: 'DE89370400440532013000', account_holder: 'Fia Fix', tax_id: '12345678901', social_security_number: '12345678A123', health_insurance: 'TK', other_employment: false, emergency_contact_name: 'Bo', emergency_contact_phone: '+49 170 1', privacy_accepted: true }
let seq = 0
// Einladung → Signup → Onboarding eingereicht (synthetische Person)
async function submitted() {
  const email = `fix${++seq}@example.test`
  const a = await db.session(ADMIN)
  const { token } = await one(a, `INSERT INTO invitations (email, role, created_by, expires_at) VALUES ($1, 'employee', $2, now() + interval '7 days') RETURNING token`, [email, U(ADMIN)])
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, now(), $3)`, [id, email, { invite_token: token }])
  const r = await one(await asId(id), `SELECT save_onboarding($1, true) v`, [{ ...VALID }])
  assert.equal(r.v.success, true, JSON.stringify(r.v))
  return { id, email, onb: (await one(db.sys, `SELECT id FROM employee_onboarding WHERE profile_id = $1`, [id])).id }
}
const approve = (c, onb, { employment = 'vollzeit', rate = null, pay = 'fixed', salary = null, hours = 40 } = {}) =>
  one(c, `SELECT approve_onboarding_with_pay($1, 'employee', 'Service', $2, $3, $4, $5, 28, $6, $7) v`, [onb, employment, hours, rate, day(3), pay, salary]).then(r => r.v)
const emp = id => one(db.sys, `SELECT pay_type, monthly_salary::float s, hourly_rate::float r, employment_type t FROM employees WHERE id = $1`, [id])
const status = onb => one(db.sys, `SELECT status FROM employee_onboarding WHERE id = $1`, [onb]).then(r => r.status)

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [FIXED_OLD, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }], [HOURLY_OLD, 'employee']])
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2100 WHERE id = $1`, [EMP(FIXED_OLD)])
  await loadLifecycle(db.sys)
})
after(async () => { await db?.stop() })

test('A) Vollzeit + Fixgehalt + Monatsgehalt + KEIN Stundenlohn → freigeschaltet, Satz bleibt NULL (kein Ersatzwert)', async () => {
  const s = await submitted()
  const v = await approve(await db.session(ADMIN), s.onb, { employment: 'vollzeit', salary: 3200 })
  assert.equal(v.success, true, JSON.stringify(v))
  assert.deepEqual(await emp(v.employee_id), { pay_type: 'fixed', s: 3200, r: null, t: 'vollzeit' })
  assert.equal(await status(s.onb), 'approved')
  assert.equal((await one(db.sys, `SELECT status, employee_id FROM profiles WHERE id = $1`, [s.id])).employee_id, v.employee_id)
})

test('B) Teilzeit + Fixgehalt + Monatsgehalt + KEIN Stundenlohn → freigeschaltet', async () => {
  const s = await submitted()
  const v = await approve(await db.session(ADMIN), s.onb, { employment: 'teilzeit', hours: 20, salary: 1650.5 })
  assert.equal(v.success, true, JSON.stringify(v))
  assert.deepEqual(await emp(v.employee_id), { pay_type: 'fixed', s: 1650.5, r: null, t: 'teilzeit' })
})

test('A2) Fixgehalt MIT optionalem Stundenlohn → gespeichert wie angegeben; Satz ≤ 0 abgelehnt', async () => {
  const a = await db.session(ADMIN)
  const s = await submitted()
  assert.match((await approve(a, s.onb, { salary: 3000, rate: 0 })).error, /größer als 0 sein oder leer/)
  assert.match((await approve(a, s.onb, { salary: 3000, rate: -5 })).error, /größer als 0 sein oder leer/)
  assert.equal(await status(s.onb), 'submitted')
  const v = await approve(a, s.onb, { salary: 3000, rate: 17.25 })
  assert.deepEqual(await emp(v.employee_id), { pay_type: 'fixed', s: 3000, r: 17.25, t: 'vollzeit' })
})

test('C) Fixgehalt ohne (gültiges) Monatsgehalt → sauber blockiert, nichts angelegt', async () => {
  const a = await db.session(ADMIN)
  const s = await submitted()
  const n = (await one(db.sys, `SELECT count(*)::int n FROM employees`)).n
  for (const salary of [null, 0, -100]) assert.match((await approve(a, s.onb, { salary })).error, /Brutto-Monatsgehalt/)
  assert.match((await approve(a, s.onb, { salary: null, rate: 20 })).error, /Brutto-Monatsgehalt/, 'Stundenlohn ersetzt kein Monatsgehalt')
  assert.equal(await status(s.onb), 'submitted')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM employees`)).n, n)
})

test('D/E) Stundenlohn: mit gültigem Satz freigeschaltet; ohne/ungültig blockiert; Monatsgehalt wird nicht übernommen', async () => {
  const a = await db.session(ADMIN)
  const s = await submitted()
  for (const rate of [null, 0, -1]) assert.match((await approve(a, s.onb, { pay: 'hourly', employment: 'minijob', hours: 10, rate })).error, /Stundenlohn an/)
  assert.equal(await status(s.onb), 'submitted')
  const v = await approve(a, s.onb, { pay: 'hourly', employment: 'minijob', hours: 10, rate: 14.5, salary: 999 })
  assert.equal(v.success, true)
  assert.deepEqual(await emp(v.employee_id), { pay_type: 'hourly', s: null, r: 14.5, t: 'minijob' })
})

test('F) Werkstudent/Minijob + Fixgehalt → weiterhin blockiert (Server und Tabellenregel)', async () => {
  const a = await db.session(ADMIN)
  const s = await submitted()
  for (const employment of ['werkstudent', 'minijob'])
    assert.match((await approve(a, s.onb, { employment, hours: 15, salary: 1200 })).error, /nur bei Vollzeit oder Teilzeit/)
  assert.equal(await status(s.onb), 'submitted')
  assert.match(await err(() => a.query(`UPDATE employees SET employment_type = 'minijob' WHERE id = $1`, [EMP(FIXED_OLD)])), /employees_fixed_pay_types/)
})

test('Ungültiges Vergütungsmodell / nur Admin / alte Signatur unverändert (immer Stundenlohn, Satz Pflicht)', async () => {
  const a = await db.session(ADMIN)
  const s = await submitted()
  assert.match((await approve(a, s.onb, { pay: 'salary', salary: 3000 })).error, /Ungültiges Vergütungsmodell/)
  assert.match((await approve(a, s.onb, { pay: null, salary: 3000 })).error, /Ungültiges Vergütungsmodell/)
  for (const who of [MANAGER, FIXED_OLD]) assert.match(await err(() => db.session(who).then(c => approve(c, s.onb, { salary: 3000 }))), /Nicht autorisiert/)
  const legacy = sql => one(a, `SELECT approve_onboarding($1, 'employee', 'Service', 'vollzeit', 40, ${sql}, $2, 28) v`, [s.onb, day(3)]).then(r => r.v)
  assert.match((await legacy('NULL')).error, /Stundenlohn an/, 'alte Funktion: Satz weiterhin Pflicht')
  const v = await legacy('16')
  assert.deepEqual(await emp(v.employee_id), { pay_type: 'hourly', s: null, r: 16, t: 'vollzeit' })
  // interner Kern nicht direkt aufrufbar
  assert.match(await err(() => a.query(`SELECT _approve_onboarding_core($1, 'employee', '', 'vollzeit', 40, NULL, $2, 28, 'fixed', 3000)`, [s.onb, day(3)])), /permission denied/)
})

test('Parallel/Retry: zwei Admins schalten gleichzeitig mit Fixgehalt frei → genau ein Mitarbeiter', async () => {
  const s = await submitted()
  const [x, y] = [await db.as(ADMIN), await db.as(ADMIN)]
  const res = await Promise.all([x, y].map(c => approve(c, s.onb, { salary: 2800 })))
  assert.equal(res.filter(r => r.success).length, 1)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM employees WHERE email = $1`, [s.email])).n, 1)
  assert.equal((await approve(x, s.onb, { salary: 2800 })).success, false, 'Retry ohne Wirkung')
})

test('Stammdaten später (Admin): Stundenlohn ↔ Fixgehalt; Satz nur bei Stundenlohn Pflicht; nie ein Ersatzwert', async () => {
  const a = await db.session(ADMIN)
  const id = EMP(HOURLY_OLD)
  // Stundenlohn → Fixgehalt, Satz geleert
  await a.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2500, hourly_rate = NULL WHERE id = $1`, [id])
  assert.deepEqual(await emp(id), { pay_type: 'fixed', s: 2500, r: null, t: 'vollzeit' })
  // Fixgehalt → Stundenlohn ohne Satz: von der Tabellenregel abgelehnt
  assert.match(await err(() => a.query(`UPDATE employees SET pay_type = 'hourly', monthly_salary = NULL WHERE id = $1`, [id])), /employees_hourly_rate_required/)
  assert.equal((await emp(id)).pay_type, 'fixed', 'unverändert')
  // … mit Satz: erlaubt
  await a.query(`UPDATE employees SET pay_type = 'hourly', monthly_salary = NULL, hourly_rate = 15.75 WHERE id = $1`, [id])
  assert.deepEqual(await emp(id), { pay_type: 'hourly', s: null, r: 15.75, t: 'vollzeit' })
  // Stundenlohn-Mitarbeiter: Satz löschen / 0 → abgelehnt
  assert.match(await err(() => a.query(`UPDATE employees SET hourly_rate = NULL WHERE id = $1`, [id])), /employees_hourly_rate_required/)
  assert.match(await err(() => a.query(`UPDATE employees SET hourly_rate = 0 WHERE id = $1`, [id])), /employees_hourly_rate_positive/)
  // Neuer Mitarbeiter direkt (Mitarbeiterformular): Stundenlohn ohne Satz abgelehnt, Fixgehalt ohne Satz erlaubt
  assert.match(await err(() => a.query(`INSERT INTO employees (first_name, last_name, email, start_date) VALUES ('N', 'N', 'n1@example.test', '2026-10-01')`)), /employees_hourly_rate_required/)
  await a.query(`INSERT INTO employees (first_name, last_name, email, start_date, employment_type, pay_type, monthly_salary) VALUES ('N', 'F', 'n2@example.test', '2026-10-01', 'vollzeit', 'fixed', 3100)`)
  // Fixgehalt ohne Monatsgehalt weiterhin abgelehnt (Migration 18)
  assert.match(await err(() => a.query(`INSERT INTO employees (first_name, last_name, email, start_date, employment_type, pay_type) VALUES ('N', 'X', 'n3@example.test', '2026-10-01', 'vollzeit', 'fixed')`)), /employees_pay_model_complete/)
  // Manager ändert keine Vergütung
  const m = await db.session(MANAGER)
  assert.equal((await m.query(`UPDATE employees SET hourly_rate = NULL WHERE id = $1 RETURNING id`, [EMP(FIXED_OLD)])).rowCount, 0)
})

test('G) Bestehende Daten: Migration ändert nichts (Fixgehalt-Bestand behält Satz/Gehalt; alle Stundenlohn-Zeilen haben einen Satz)', async () => {
  assert.deepEqual(await emp(EMP(FIXED_OLD)), { pay_type: 'fixed', s: 2100, r: 15, t: 'teilzeit' })
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM employees WHERE pay_type = 'hourly' AND hourly_rate IS NULL`)).n, 0)
  // Migration erneut ausführbar (Vorlage spielt approve_onboarding neu ein → LIFECYCLE_MIGRATIONS)
  const { migration } = await import('./harness.mjs')
  await db.sys.query(migration('30_fixed_pay_hourly_optional.sql'))
  assert.deepEqual(await emp(EMP(FIXED_OLD)), { pay_type: 'fixed', s: 2100, r: 15, t: 'teilzeit' })
  const con = await one(db.sys, `SELECT count(*)::int n FROM pg_constraint WHERE conname = 'employees_hourly_rate_required'`)
  assert.equal(con.n, 1)
})
