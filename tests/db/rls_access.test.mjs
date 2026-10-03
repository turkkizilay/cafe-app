// RLS/Rollen: Mitarbeiter sehen nur eigene Daten, Manager nur operative Daten (keine Vergütung/Bank/Steuer/SV),
// Admin vollständig, anonym nichts. Vergütungs-Constraints (Migration 18). Nur synthetische Daten, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, U, EMP, day } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db, te2, sick1, sick2, te1
const SENSITIVE = ['hourly_rate', 'monthly_salary', 'pay_type', 'iban', 'account_holder', 'tax_id', 'social_security_number', 'health_insurance', 'street']
const OTHER_TABLES = ['time_entries', 'time_entry_breaks', 'vacation_requests', 'sick_leave', 'payroll_months', 'payroll_documents', 'employee_documents', 'time_corrections']

// Pflichtspalten ohne Default mit Platzhaltern füllen (erlaubte CHECK-Werte werden übernommen)
async function insertRow(table, values) {
  const cols = await rows(db.sys, `SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table])
  const checks = await rows(db.sys, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ('public.' || $1)::regclass AND contype = 'c'`, [table])
  const row = { ...values }
  for (const c of cols) if (!(c.column_name in row)) {
    const inList = checks.map(x => x.d.match(new RegExp(`\\(\\(?${c.column_name}\\)?(?:::text)? = ANY \\(\\(?ARRAY\\['([^']+)'`))).find(Boolean)
    row[c.column_name] = inList ? inList[1]
      : /int|numeric/.test(c.udt_name) ? 1 : c.udt_name === 'bool' ? false : c.udt_name === 'date' ? day(-20)
      : /timestamp/.test(c.udt_name) ? new Date().toISOString() : c.udt_name === 'uuid' ? U(9) : c.udt_name === 'jsonb' ? '{}' : 'x'
  }
  const keys = Object.keys(row)
  return one(db.sys, `INSERT INTO public.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, keys.map(k => row[k]))
}

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }]])
  await db.sys.query(`UPDATE employees SET pay_type='fixed', monthly_salary=2000 WHERE id=$1`, [EMP(E2)])
  te2 = await insertRow('time_entries', { employee_id: EMP(E2), date: day(-10), clock_in: `${day(-10)}T08:00:00Z`, clock_out: `${day(-10)}T16:00:00Z`, hours_worked: 8 })
  await insertRow('time_entry_breaks', { time_entry_id: te2.id, employee_id: EMP(E2), break_start: `${day(-10)}T12:00:00Z`, break_end: `${day(-10)}T12:20:00Z` })
  await insertRow('vacation_requests', { employee_id: EMP(E2), start_date: day(20), end_date: day(24) })
  sick2 = await insertRow('sick_leave', { employee_id: EMP(E2), start_date: day(-15), end_date: day(-14) })
  await insertRow('payroll_months', { employee_id: EMP(E2), year: 2026, month: 9 })
  await insertRow('payroll_documents', { employee_id: EMP(E2), year: 2026, month: 9 })
  await insertRow('employee_documents', { employee_id: EMP(E2) })
  await insertRow('time_corrections', { employee_id: EMP(E2), time_entry_id: te2.id, reason: 'x' })
  await insertRow('activity_log', { action: 'x', category: 'x', summary: 'x' })
  await insertRow('invitations', { email: 'neu@example.test' })
  te1 = await insertRow('time_entries', { employee_id: EMP(E1), date: day(-9), clock_in: `${day(-9)}T08:00:00Z`, clock_out: `${day(-9)}T14:00:00Z`, hours_worked: 6 })
  sick1 = await insertRow('sick_leave', { employee_id: EMP(E1), start_date: day(-5), end_date: day(-4) })
})
after(async () => { await db?.stop() })

test('Mitarbeiter: keine fremden sensiblen Daten, keine Admin-Bereiche', async () => {
  const c = await db.as(E1)
  for (const t of OTHER_TABLES) assert.equal((await one(c, `SELECT count(*)::int n FROM public.${t} WHERE employee_id = $1`, [EMP(E2)])).n, 0, t)
  const emp = await one(c, `SELECT count(*)::int n, bool_and(id = $1) own FROM employees`, [EMP(E1)])
  assert.equal(emp.own, true, 'employees: nur eigene Zeile')
  assert.equal((await one(c, `SELECT count(*)::int n FROM profiles`)).n, 1)
  for (const t of ['activity_log', 'invitations', 'cafe_networks', 'employee_onboarding']) assert.equal((await one(c, `SELECT count(*)::int n FROM public.${t}`)).n, 0, t)
  assert.equal((await one(c, `SELECT count(*)::int n FROM get_staff_operational()`)).n, 0, 'operatives Verzeichnis nur für Manager/Admin')
})

test('Mitarbeiter: keine Schreibzugriffe auf Fremdes, eigene Daten nur im erlaubten Rahmen', async () => {
  const c = await db.as(E1)
  assert.equal((await c.query(`UPDATE time_entries SET hours_worked = 99 WHERE id = $1`, [te2.id])).rowCount, 0)
  assert.equal((await c.query(`DELETE FROM sick_leave WHERE id = $1`, [sick2.id])).rowCount, 0)
  assert.match(await err(() => c.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E2)])), /row-level security/)
  assert.match(await err(() => c.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 2)`, [EMP(E2), day(40), day(41)])), /row-level security/)
  assert.match(await err(() => c.query(`INSERT INTO payroll_months (employee_id, year, month) VALUES ($1, 2026, 10)`, [EMP(E1)])), /row-level security/)
  const v = await one(c, `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, status) VALUES ($1, $2, $3, 5, 'approved') RETURNING status`, [EMP(E1), day(50), day(54)])
  assert.equal(v.status, 'pending', 'eigener Urlaub wird auf „pending“ gezwungen')
  await c.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [U(E1)])
  assert.equal((await one(db.sys, `SELECT role FROM profiles WHERE id = $1`, [U(E1)])).role, 'employee', 'keine Selbst-Beförderung')
  assert.equal((await c.query(`UPDATE time_entries SET hours_worked = 12 WHERE id = $1`, [te1.id])).rowCount, 0, 'abgeschlossener eigener Eintrag nicht änderbar')
  assert.match(await err(() => c.query(`DELETE FROM time_entries WHERE id = $1`, [te1.id])), /permission denied/, 'Löschen nur über admin_delete_time_entry (Migration 34)')
  await c.query(`UPDATE sick_leave SET start_date = '2026-01-01' WHERE id = $1`, [sick1.id])
  assert.equal((await one(db.sys, `SELECT start_date::text s FROM sick_leave WHERE id = $1`, [sick1.id])).s, day(-5), 'Krankmeldungszeitraum nicht nachträglich änderbar')
  assert.match(await err(() => c.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 1)`, [EMP(E1), day(60), day(58)])), /Zeitraum/)
})

test('Mitarbeiter: eigene Vergütung sichtbar, fremde nicht', async () => {
  const c = await db.as(E2)
  assert.equal((await one(c, `SELECT monthly_salary::float m FROM employees WHERE id = $1`, [EMP(E2)])).m, 2000)
  assert.equal((await rows(c, `SELECT monthly_salary FROM employees WHERE id <> $1`, [EMP(E2)])).length, 0)
})

test('Manager: operative Daten ja, Vergütung/Bank/Steuer/SV/Lohn/Personalunterlagen nein', async () => {
  const c = await db.as(MANAGER)
  for (const t of ['time_entries', 'time_entry_breaks', 'vacation_requests', 'sick_leave'])
    assert.ok((await one(c, `SELECT count(*)::int n FROM public.${t} WHERE employee_id = $1`, [EMP(E2)])).n > 0, `liest ${t}`)
  for (const t of ['payroll_months', 'payroll_documents', 'employee_documents', 'time_corrections'])
    assert.equal((await one(c, `SELECT count(*)::int n FROM public.${t} WHERE employee_id = $1`, [EMP(E2)])).n, 0, `kein ${t}`)
  assert.equal((await one(c, `SELECT count(*)::int n FROM activity_log`)).n, 0)
  assert.equal((await one(c, `SELECT count(*)::int n FROM invitations`)).n, 0)
  assert.equal((await one(c, `SELECT bool_and(id = $1) own FROM employees`, [EMP(MANAGER)])).own, true, 'employees nur eigene Zeile')
  for (const col of SENSITIVE) assert.equal((await rows(c, `SELECT ${col} FROM employees WHERE id <> $1`, [EMP(MANAGER)])).length, 0, col)
  const cols = (await c.query(`SELECT * FROM get_staff_operational() LIMIT 1`)).fields.map(f => f.name)
  assert.ok(!cols.some(x => SENSITIVE.includes(x)), `Verzeichnis ohne sensible Spalten: ${cols}`)
  assert.equal((await one(c, `SELECT count(*)::int n FROM get_staff_operational()`)).n, 4)
  assert.equal((await c.query(`UPDATE time_entries SET hours_worked = 1 WHERE id = $1`, [te2.id])).rowCount, 0, 'keine Zeitkorrektur')
  assert.equal((await c.query(`UPDATE payroll_months SET year = 2025 WHERE employee_id = $1`, [EMP(E2)])).rowCount, 0)
  assert.equal((await c.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [U(E2)])).rowCount, 0, 'keine Rollenänderung')
  assert.equal((await c.query(`UPDATE employees SET monthly_salary = 9999 WHERE id = $1`, [EMP(E2)])).rowCount, 0, 'keine Gehaltsänderung')
})

test('Admin: vollständiger Zugriff inkl. Vergütung und Korrekturen', async () => {
  const c = await db.as(ADMIN)
  for (const t of OTHER_TABLES) assert.ok((await one(c, `SELECT count(*)::int n FROM public.${t} WHERE employee_id = $1`, [EMP(E2)])).n > 0, t)
  assert.ok((await one(c, `SELECT count(*)::int n FROM activity_log`)).n > 0)
  assert.equal((await one(c, `SELECT count(iban)::int n FROM employees`)).n, 4)
  // Zeitdaten anderer: nur über admin_save_time_entry (Prüfung + Protokoll), keine direkte Tabellenänderung (Migration 34)
  assert.equal((await c.query(`UPDATE time_entries SET notes = 'korr' WHERE id = $1`, [te2.id])).rowCount, 0)
  assert.equal((await c.query(`UPDATE employees SET monthly_salary = 2100 WHERE id = $1`, [EMP(E2)])).rowCount, 1)
})

test('Vergütung (Migration 18): Fixgehalt nur Voll-/Teilzeit, Beträge positiv', async () => {
  for (const type of ['werkstudent', 'minijob'])
    assert.match(await err(() => db.sys.query(`UPDATE employees SET employment_type=$2, pay_type='fixed', monthly_salary=900 WHERE id=$1`, [EMP(E1), type])), /fixed_pay_types/, type)
  assert.match(await err(() => db.sys.query(`UPDATE employees SET pay_type='fixed', monthly_salary=NULL WHERE id=$1`, [EMP(E1)])), /pay_model_complete/)
  assert.match(await err(() => db.sys.query(`UPDATE employees SET monthly_salary=0, pay_type='fixed' WHERE id=$1`, [EMP(E1)])), /monthly_salary_positive/)
  assert.match(await err(() => db.sys.query(`UPDATE employees SET hourly_rate=0 WHERE id=$1`, [EMP(E1)])), /hourly_rate_positive/)
})

test('Anonym: kein Zugriff auf Personal-, Zeit- und Lohndaten', async () => {
  const c = await db.anon()
  for (const t of [...OTHER_TABLES, 'employees', 'profiles', 'activity_log', 'invitations', 'shift_swap_requests']) {
    const e = await err(async () => { const n = (await one(c, `SELECT count(*)::int n FROM public.${t}`)).n; if (n > 0) throw new Error(`LEAK ${n}`) })
    assert.ok(e === null || /permission denied/.test(e), `${t}: ${e}`)
  }
  assert.match(await err(() => c.query(`SELECT * FROM get_staff_operational()`)), /permission denied/)
})
