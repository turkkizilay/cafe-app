// Recovery festhängender Registrierungen (Migration 24): Auth-Status nur für Admin, Bestätigungs-E-Mail nur für
// unbestätigte Konten anfordern, abgebrochene Registrierung wieder öffnen – ohne Datenverlust, ohne Duplikate.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, U, EMP } from './harness.mjs'

const [ADMIN, MANAGER, E1, STUCK, CONFIRMED, LINKED] = [1, 2, 3, 5, 6, 7]
const JOB = { role: 'employee', employment_type: 'teilzeit', hours_per_week: 20, hourly_rate: 16.5, pay_type: 'hourly', start_date: '2026-10-01', vacation_days: 28 }
let db, invId, onbId

// Systemseitiger Zustandswechsel ohne Trigger (Testaufbau = was reject_onboarding in Production tut)
const bypass = async (sql, params) => { await db.sys.query('BEGIN'); await db.sys.query('SET LOCAL session_replication_role = replica'); await db.sys.query(sql, params); await db.sys.query('COMMIT') }

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [LINKED, 'employee']])
  // Festhängendes Konto: registriert per Einladung (eingelöst, Vertragsdaten in job), E-Mail nie bestätigt, kein Mitarbeiter
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, confirmation_sent_at, last_sign_in_at) VALUES ($1, 'neu@example.test', NULL, now() - interval '2 hours', NULL)`, [U(STUCK)])
  await db.sys.query(`INSERT INTO profiles (id, email, role, status) VALUES ($1, 'neu@example.test', 'employee', 'pending')`, [U(STUCK)])
  invId = (await one(db.sys, `INSERT INTO invitations (email, role, used_at, job) VALUES ('neu@example.test', 'employee', now() - interval '2 hours', $1) RETURNING id`, [JOB])).id
  const req = (await db.sys.query(`SELECT column_name FROM information_schema.columns WHERE table_name='employee_onboarding' AND is_nullable='NO' AND column_default IS NULL`)).rows.map(r => r.column_name)
  const row = { profile_id: U(STUCK), invitation_id: invId, email: 'neu@example.test', role: 'employee' }; for (const c of req) if (!(c in row)) row[c] = 'x'
  onbId = (await one(db.sys, `INSERT INTO employee_onboarding (${Object.keys(row)}) VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`)}) RETURNING id`, Object.values(row))).id
  // Bestätigtes Konto ohne Mitarbeiter (z. B. Onboarding läuft)
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, last_sign_in_at) VALUES ($1, 'ok@example.test', now(), now())`, [U(CONFIRMED)])
  await db.sys.query(`INSERT INTO profiles (id, email, role, status) VALUES ($1, 'ok@example.test', 'employee', 'pending')`, [U(CONFIRMED)])
})
after(async () => { await db?.stop() })

const count = async (sql, p) => (await one(db.sys, sql, p)).n

test('1: Auth-Status nur für Admin, nur minimale Felder; unbestätigtes Konto korrekt erkannt', async () => {
  const a = await db.session(ADMIN)
  const r = await a.query(`SELECT * FROM admin_account_states()`)
  assert.deepEqual(r.fields.map(f => f.name), ['profile_id', 'email_confirmed', 'confirmation_sent_at', 'ever_signed_in'])
  const byId = Object.fromEntries(r.rows.map(x => [x.profile_id, x]))
  assert.equal(byId[U(STUCK)].email_confirmed, false); assert.equal(byId[U(STUCK)].ever_signed_in, false); assert.ok(byId[U(STUCK)].confirmation_sent_at)
  assert.equal(byId[U(CONFIRMED)].email_confirmed, true)
  for (const who of [E1, MANAGER]) assert.match(await err(() => db.session(who).then(c => c.query(`SELECT * FROM admin_account_states()`))), /Nicht autorisiert/, `Rolle ${who}`)
  assert.match(await err(() => db.anon().then(c => c.query(`SELECT * FROM admin_account_states()`))), /permission denied/)
})

test('2/3/4/5: Bestätigung erneut anfordern – nur Admin, nur unbestätigte Konten, protokolliert', async () => {
  const a = await db.session(ADMIN)
  const r = await one(a, `SELECT admin_prepare_confirmation_resend($1) v`, [U(STUCK)])
  assert.equal(r.v.email, 'neu@example.test')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'employee.confirmation_resent' AND target_id = $1`, [U(STUCK)]), 1)
  assert.match(await err(() => a.query(`SELECT admin_prepare_confirmation_resend($1)`, [U(CONFIRMED)])), /bereits bestätigt/, '5: bestätigtes Konto')
  assert.match(await err(() => a.query(`SELECT admin_prepare_confirmation_resend($1)`, [U(9)])), /nicht gefunden/)
  for (const who of [E1, MANAGER]) assert.match(await err(() => db.session(who).then(c => c.query(`SELECT admin_prepare_confirmation_resend($1)`, [U(STUCK)]))), /Nicht autorisiert/, `Rolle ${who}`)
  assert.match(await err(() => db.anon().then(c => c.query(`SELECT admin_prepare_confirmation_resend($1)`, [U(STUCK)]))), /permission denied/)
  assert.equal((await one(db.sys, `SELECT email_confirmed_at FROM auth.users WHERE id = $1`, [U(STUCK)])).email_confirmed_at, null, 'nichts wird als bestätigt markiert')
})

test('6/7: Abgebrochene Registrierung wieder öffnen – kein neuer Mitarbeiter, Einladung + Vergütungsdaten unverändert', async () => {
  const employeesBefore = await count(`SELECT count(*)::int n FROM employees`)
  const jobBefore = (await one(db.sys, `SELECT job, used_at FROM invitations WHERE id = $1`, [invId]))
  await bypass(`UPDATE employee_onboarding SET status = 'rejected', reviewed_at = now() WHERE id = $1`, [onbId])
  await bypass(`UPDATE profiles SET status = 'disabled' WHERE id = $1`, [U(STUCK)])
  for (const who of [E1, MANAGER]) assert.match(await err(() => db.session(who).then(c => c.query(`SELECT admin_reopen_registration($1)`, [U(STUCK)]))), /Nicht autorisiert/, `Rolle ${who}`)
  const a = await db.session(ADMIN)
  assert.equal((await one(a, `SELECT admin_reopen_registration($1) v`, [U(STUCK)])).v.success, true)
  const st = await one(db.sys, `SELECT p.status ps, o.status os, o.reviewed_at FROM profiles p JOIN employee_onboarding o ON o.profile_id = p.id WHERE p.id = $1`, [U(STUCK)])
  assert.deepEqual([st.ps, st.os, st.reviewed_at], ['pending', 'draft', null])
  assert.equal(await count(`SELECT count(*)::int n FROM employees`), employeesBefore, 'kein Mitarbeiter angelegt/dupliziert')
  const jobAfter = await one(db.sys, `SELECT job, used_at FROM invitations WHERE id = $1`, [invId])
  assert.deepEqual(jobAfter.job, JOB); assert.equal(+jobAfter.used_at, +jobBefore.used_at, 'Einladung/Vertragsdaten unverändert')
  assert.equal(await count(`SELECT count(*)::int n FROM profiles WHERE lower(email) = 'neu@example.test'`), 1, 'kein zweites Konto')
  assert.match(await err(() => a.query(`SELECT admin_reopen_registration($1)`, [U(STUCK)])), /nicht wieder geöffnet/, 'nur aus „abgebrochen“')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'employee.registration_reopened'`), 1)
})

test('7: Konten mit Mitarbeiter-Datensatz werden nicht angefasst (Vergütung, Verknüpfung bleiben)', async () => {
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2500 WHERE id = $1`, [EMP(LINKED)])
  await bypass(`UPDATE profiles SET status = 'disabled' WHERE id = $1`, [U(LINKED)])
  const before = await one(db.sys, `SELECT e.hourly_rate::float r, e.monthly_salary::float m, e.pay_type, p.employee_id FROM employees e JOIN profiles p ON p.employee_id = e.id WHERE p.id = $1`, [U(LINKED)])
  assert.match(await err(() => db.session(ADMIN).then(c => c.query(`SELECT admin_reopen_registration($1)`, [U(LINKED)]))), /bereits mit einem Mitarbeiter verknüpft/)
  const after = await one(db.sys, `SELECT e.hourly_rate::float r, e.monthly_salary::float m, e.pay_type, p.employee_id, p.status FROM employees e JOIN profiles p ON p.employee_id = e.id WHERE p.id = $1`, [U(LINKED)])
  assert.deepEqual({ r: after.r, m: after.m, pay_type: after.pay_type, employee_id: after.employee_id }, before)
  assert.equal(after.status, 'disabled')
})
