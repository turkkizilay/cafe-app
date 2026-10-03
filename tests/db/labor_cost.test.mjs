// Migration 35: labor_cost_today() – Live-Personalkosten des Berliner Kalendertags (nur Admin, nur Summen).
// Netto = Arbeitsintervall ∩ Tag − Pausen; Mitternacht/DST korrekt; nur Stundenlohn; Fixgehalt nie eingerechnet;
// geplant ohne Urlaub/Krankheit/Ausgeschiedene; Fortschreiben über running_rate stimmt mit der Serverrechnung überein.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, EMP, U, MIGRATIONS, migration } from './harness.mjs'

const [ADMIN, MANAGER, H1, H2, H3, FV, FT, OLD, ADMIN2] = [1, 2, 3, 4, 5, 6, 7, 8, 9]
let db
const at = async iso => (await one(db.sys, `SELECT _labor_cost_at($1::timestamptz) r`, [iso])).r
const reset = () => db.sys.query(`DELETE FROM time_entries; DELETE FROM shifts; DELETE FROM vacation_requests; DELETE FROM sick_leave;`)
// Zeiteintrag im Systemkontext (wie bestehende Daten); hours = Netto wie vom Server berechnet
const entry = async (n, cin, cout = null, hours = null, breaks = [], extra = {}) => {
  const { id } = await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, break_minutes, notes)
    VALUES ($1, ($2::timestamptz AT TIME ZONE 'Europe/Berlin')::date, $2, $3, $4, $5, $6) RETURNING id`,
    [EMP(n), cin, cout, hours, extra.breakMin ?? 0, extra.notes ?? null])
  for (const [s, e] of breaks) await db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end) VALUES ($1, $2, $3, $4)`, [id, EMP(n), s, e])
  return id
}
const shift = (n, date, s, e) => db.sys.query(`INSERT INTO shifts (employee_id, date, start_time, end_time) VALUES ($1, $2, $3, $4)`, [EMP(n), date, s, e])
const B = s => `${s}+02:00`   // Sommerzeit (September)
const close = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps

before(async () => {
  db = await startDb()
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)   // wie Production
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [H1, 'employee'], [H2, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }],
    [H3, 'employee', { employment_type: 'minijob', hours_per_week: 8 }], [FV, 'employee'], [FT, 'employee', { employment_type: 'teilzeit', hours_per_week: 25 }], [OLD, 'employee'], [ADMIN2, 'admin']])
  await db.sys.query(`UPDATE employees SET hourly_rate = 15 WHERE id = $1`, [EMP(H1)])
  await db.sys.query(`UPDATE employees SET hourly_rate = 20 WHERE id = $1`, [EMP(H2)])
  await db.sys.query(`UPDATE employees SET hourly_rate = 13 WHERE id = $1`, [EMP(H3)])
  // Fixgehalt: Vollzeit mit (internem) Stundensatz, Teilzeit ohne – beides darf nie eingerechnet werden
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 4670, hourly_rate = 10 WHERE id = $1`, [EMP(FV)])
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2000, hourly_rate = NULL WHERE id = $1`, [EMP(FT)])
  await db.sys.query(`UPDATE employees SET is_active = false, end_date = '2026-08-31' WHERE id = $1`, [EMP(OLD)])
})
after(async () => { await db?.stop() })

test('Stundenlohn: keine / eine / mehrere / offene Pause – Netto × Satz; laufend vs. Pause', async () => {
  const now = B('2026-09-15T14:00:00')
  await reset(); await entry(H1, B('2026-09-15T10:00:00'))
  let r = await at(now)
  assert.deepEqual([Number(r.today.net_seconds), Number(r.today.cost), r.today.running_hourly, Number(r.today.running_rate)], [14400, 60, 1, 15], 'ohne Pause')
  await reset(); await entry(H1, B('2026-09-15T10:00:00'), null, null, [[B('2026-09-15T12:00:00'), B('2026-09-15T12:30:00')]])
  r = await at(now); assert.deepEqual([Number(r.today.net_seconds), Number(r.today.cost)], [12600, 52.5], 'eine Pause (3,5 h)')
  await reset(); await entry(H1, B('2026-09-15T10:00:00'), null, null, [[B('2026-09-15T11:00:00'), B('2026-09-15T11:30:00')], [B('2026-09-15T13:00:00'), B('2026-09-15T13:15:00')]])
  r = await at(now); assert.deepEqual([Number(r.today.net_seconds), Number(r.today.cost)], [11700, 48.75], 'mehrere Pausen')
  await reset(); await entry(H1, B('2026-09-15T10:00:00'), null, null, [[B('2026-09-15T13:30:00'), null]])
  r = await at(now)
  assert.deepEqual([Number(r.today.net_seconds), r.today.running, r.today.on_break, Number(r.today.running_rate)], [12600, 0, 1, 0], 'offene Pause: Kosten stehen')
  r = await at(B('2026-09-15T15:00:00'))
  assert.equal(Number(r.today.cost), 52.5, 'eine Stunde später in der Pause: unverändert')
})

test('Ausgestempelt: hours_worked maßgeblich (wie Timesheet/Payroll); Zeitkorrektur und Pausenänderung wirken', async () => {
  await reset()
  const a = await db.session(ADMIN)
  const save = (p) => one(a, `SELECT admin_save_time_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v`, [p.id ?? null, EMP(H1), '2026-09-15', p.inT, p.outT, JSON.stringify(p.breaks || []), null, '', 'Test', p.expected ?? null])
  const st = async id => (await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s
  const { v } = await save({ inT: '10:00', outT: '13:00', breaks: [{ start: '11:00', end: '11:20' }] })
  const now = B('2026-09-15T20:00:00')
  let r = await at(now)
  assert.deepEqual([Number(r.today.net_seconds), Number(r.today.cost), r.today.running], [Math.round(2.67 * 3600), 40.05, 0], 'Netto = hours_worked 2,67 h')
  await save({ id: v.id, inT: '09:00', outT: '13:00', breaks: [{ start: '11:00', end: '11:20' }], expected: await st(v.id) })
  r = await at(now); assert.equal(Number(r.today.net_seconds), Math.round(3.67 * 3600), 'Zeitkorrektur')
  await save({ id: v.id, inT: '09:00', outT: '13:00', breaks: [{ start: '11:00', end: '11:50' }], expected: await st(v.id) })
  r = await at(now); assert.equal(Number(r.today.net_seconds), Math.round(3.17 * 3600), 'Pause nachträglich geändert')
  await save({ id: v.id, inT: '09:00', outT: '13:00', breaks: [], expected: await st(v.id) })
  r = await at(now); assert.equal(Number(r.today.cost), 60, 'Pause gelöscht')
})

test('Mitternacht: Schicht und Pause über Mitternacht werden an der Berliner Tagesgrenze geteilt', async () => {
  await reset()
  await entry(H1, B('2026-09-14T22:00:00'), B('2026-09-15T02:00:00'), 4)
  let r = await at(B('2026-09-15T14:00:00'))
  assert.deepEqual([Number(r.today.net_seconds), Number(r.today.cost)], [7200, 30], 'am 15.: nur 00:00–02:00')
  r = await at(B('2026-09-14T23:30:00'))
  assert.equal(Number(r.today.net_seconds), 5400, 'am 14. um 23:30: 22:00–23:30 (laufend aus Sicht des Zeitpunkts)')
  r = await at(B('2026-09-15T14:00:00'))
  assert.equal(Number(r.week.cost), 60, 'Woche (Mo 14.–jetzt): beide Teile')
  await reset()
  await entry(H1, B('2026-09-14T22:00:00'), B('2026-09-15T06:00:00'), 7.5, [[B('2026-09-14T23:45:00'), B('2026-09-15T00:15:00')]], { breakMin: 30 })
  r = await at(B('2026-09-15T12:00:00')); assert.equal(Number(r.today.net_seconds), 5.75 * 3600, 'Pause über Mitternacht: 15 Min. auf jeden Tag')
  r = await at(B('2026-09-14T23:59:00')); assert.equal(Number(r.today.net_seconds), 119 * 60 - 14 * 60, 'Vortag bis 23:59: 1:59 Arbeit − 14 Min. Pause')
  await reset()
  await entry(H1, B('2026-09-14T22:00:00'))
  r = await at(B('2026-09-15T01:00:00'))
  assert.deepEqual([Number(r.today.net_seconds), r.today.running], [3600, 1], 'laufende Nachtschicht vom Vortag: nur ab 00:00')
  r = await at('2026-09-14T22:30:00Z')   // 00:30 Berlin am 15.
  assert.equal(r.day, '2026-09-15', 'Tagesgrenze Europe/Berlin, nicht UTC')
})

test('Sommer-/Winterzeit: 25-h- und 23-h-Tag, Schichten über die Umstellung', async () => {
  await reset()
  await entry(H1, '2026-10-25T00:00:00+02:00', '2026-10-25T06:00:00+01:00', 7)
  await shift(H1, '2026-10-25', '00:00', '06:00')
  let r = await at('2026-10-25T12:00:00+01:00')
  assert.deepEqual([Number(r.today.net_seconds), Number(r.planned.seconds)], [7 * 3600, 7 * 3600], 'Winterzeit: 00–06 Uhr = 7 h')
  assert.equal((new Date(r.day_end) - new Date(r.day_start)) / 3600000, 25)
  await reset()
  await entry(H1, '2026-03-29T00:00:00+01:00', '2026-03-29T06:00:00+02:00', 5)
  await shift(H1, '2026-03-29', '00:00', '06:00')
  r = await at('2026-03-29T12:00:00+02:00')
  assert.deepEqual([Number(r.today.net_seconds), Number(r.planned.seconds)], [5 * 3600, 5 * 3600], 'Sommerzeit: 00–06 Uhr = 5 h')
  assert.equal((new Date(r.day_end) - new Date(r.day_start)) / 3600000, 23)
})

test('Fixgehalt (Vollzeit mit internem Satz, Teilzeit ohne): Zeit zählt, Kosten nie – weder Ist noch Plan', async () => {
  await reset()
  await entry(FV, B('2026-09-15T08:00:00'))
  await entry(FT, B('2026-09-15T09:00:00'), B('2026-09-15T12:00:00'), 3)
  await entry(H1, B('2026-09-15T10:00:00'))
  await shift(FV, '2026-09-15', '08:00', '16:00'); await shift(H1, '2026-09-15', '10:00', '18:00')
  const r = await at(B('2026-09-15T14:00:00'))
  assert.equal(Number(r.today.cost), 60, 'nur Stundenlohn (4 h × 15 €), kein interner Satz')
  assert.equal(Number(r.today.net_seconds), (6 + 3 + 4) * 3600, 'Heute geleistet: alle Personen')
  assert.equal(Number(r.today.net_seconds_hourly), 4 * 3600)
  assert.deepEqual([r.today.running, r.today.running_hourly, Number(r.today.running_rate), r.today.fixed_working], [2, 1, 15, 2])
  assert.deepEqual([Number(r.planned.cost), r.planned.fixed_shifts], [120, 1], 'Plan: Fixgehalt nicht als Stundenlohn')
  const later = await at(B('2026-09-15T16:00:00'))
  assert.equal(Number(later.today.cost), 90, 'Fixgehalt läuft nie mit')
})

test('Geplant: nur echte Arbeitsschichten – Nachtschicht anteilig, Urlaub/Krankheit/Ausgeschiedene nicht, nie negativ', async () => {
  await reset()
  await shift(H1, '2026-09-15', '10:00', '18:00')        // 8 h × 15 = 120
  await shift(H2, '2026-09-15', '22:00', '06:00')        // heute 2 h × 20 = 40
  await shift(H3, '2026-09-14', '22:00', '06:00')        // Vortag → heute 6 h × 13 = 78
  await shift(H3, '2026-09-15', '12:00', '12:00')        // Beginn = Ende → 0
  let r = await at(B('2026-09-15T09:00:00'))
  assert.deepEqual([Number(r.planned.cost), Number(r.planned.seconds) / 3600, r.planned.shifts], [238, 16, 3])
  await db.sys.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, status) VALUES ($1, '2026-09-15', '2026-09-16', 2, 'approved')`, [EMP(H1)])
  await db.sys.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, status) VALUES ($1, '2026-09-15', '2026-09-15', 1, 'pending')`, [EMP(H2)])
  await db.sys.query(`INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, '2026-09-10', NULL)`, [EMP(H3)])
  await shift(OLD, '2026-09-15', '10:00', '14:00')
  r = await at(B('2026-09-15T09:00:00'))
  assert.deepEqual([Number(r.planned.cost), r.planned.shifts, r.planned.excluded_absent], [40, 1, 2], 'Urlaub (genehmigt) + Krankmeldung raus, beantragter Urlaub zählt, Ausgeschiedene raus')
  await reset()
  r = await at(B('2026-09-15T09:00:00'))
  assert.deepEqual([Number(r.planned.cost), Number(r.today.cost)], [0, 0], 'Plan = 0')
})

test('Mehrere gleichzeitig, ungeplante Arbeit, Ist > Plan, Altbestand, „Ausstempeln vergessen“', async () => {
  await reset()
  await entry(H1, B('2026-09-15T10:00:00'), null, null, [[B('2026-09-15T12:00:00'), B('2026-09-15T12:30:00')]])   // 3,5 h × 15
  await entry(H2, B('2026-09-15T08:00:00'), B('2026-09-15T12:00:00'), 3.5, [[B('2026-09-15T10:00:00'), B('2026-09-15T10:30:00')]], { breakMin: 30 })  // × 20
  await entry(H3, B('2026-09-15T13:00:00'))                                                                       // 1 h × 13
  await shift(H3, '2026-09-15', '13:00', '14:00')
  let r = await at(B('2026-09-15T14:00:00'))
  assert.equal(Number(r.today.cost), 52.5 + 70 + 13)
  assert.deepEqual([r.today.running_hourly, Number(r.today.running_rate)], [2, 28])
  assert.ok(Number(r.today.cost) > Number(r.planned.cost), 'Ist > Plan möglich')
  await reset()
  await entry(H1, B('2026-09-15T08:00:00'), B('2026-09-15T12:00:00'), 3.75, [], { breakMin: 15 })   // Altbestand: nur Minuten
  await entry(H2, B('2026-09-14T22:00:00'), B('2026-09-15T02:00:00'), 3.5, [], { breakMin: 30 })    // Altbestand über Mitternacht
  await entry(H3, B('2026-09-14T08:00:00'), B('2026-09-15T09:00:00'), 0, [], { notes: '⚠️ AUSSTEMPELN VERGESSEN – Zeit bitte korrigieren (25.0 Std. offen)' })
  r = await at(B('2026-09-15T14:00:00'))
  assert.equal(Number(r.today.net_seconds), 3.75 * 3600 + 1.75 * 3600, 'Altbestand exakt bzw. anteilig, vergessen = 0 (wie Payroll)')
})

test('Fortschreiben im Client = Serverrechnung, solange sich nichts ändert (running_rate, running)', async () => {
  await reset()
  await entry(H1, B('2026-09-15T10:00:00')); await entry(H2, B('2026-09-15T11:00:00'), null, null, [[B('2026-09-15T13:50:00'), null]])
  await entry(H3, B('2026-09-15T09:00:00'))
  const a = await at(B('2026-09-15T14:00:00')), b = await at(B('2026-09-15T14:10:00'))
  assert.ok(close(Number(a.today.cost) + Number(a.today.running_rate) * 600 / 3600, b.today.cost), JSON.stringify([a.today, b.today]))
  assert.ok(close(Number(a.today.net_seconds) + a.today.running * 600, b.today.net_seconds))
  assert.ok(close(Number(a.week.cost) + Number(a.today.running_rate) * 600 / 3600, b.week.cost))
})

test('Rollen: nur Admin; nur Summen (keine IDs, Namen, Einzelsätze); interne Funktionen nicht aufrufbar', async () => {
  await reset(); await entry(H1, B('2026-09-15T10:00:00'))
  const r = (await one(await db.as(ADMIN), `SELECT labor_cost_today() r`)).r
  assert.ok(r.today && r.planned && r.week && r.server_now)
  const keys = JSON.stringify(r)
  assert.doesNotMatch(keys, /employee|first_name|last_name|hourly_rate|monthly_salary|[0-9a-f]{8}-[0-9a-f]{4}-/i, 'keine Personendaten')
  for (const n of [MANAGER, H1, FV]) assert.match(await err(async () => (await db.as(n)).query(`SELECT labor_cost_today()`)), /Nicht autorisiert/, `Rolle ${n}`)
  assert.match(await err(async () => (await db.anon()).query(`SELECT labor_cost_today()`)), /permission denied/)
  const a = await db.as(ADMIN)
  assert.match(await err(() => a.query(`SELECT _labor_cost_at(now())`)), /permission denied/)
  assert.match(await err(() => a.query(`SELECT _entry_net_seconds(gen_random_uuid(), now(), now(), now(), now(), now())`)), /permission denied/)
  // Status über eine Admin-Sitzung ändern (Systemverbindung würde vom Eskalationsschutz still zurückgesetzt)
  assert.equal((await a.query(`UPDATE profiles SET status = 'pending' WHERE id = $1`, [U(ADMIN2)])).rowCount, 1)
  assert.equal((await one(db.sys, `SELECT status FROM profiles WHERE id = $1`, [U(ADMIN2)])).status, 'pending')
  assert.match(await err(async () => (await db.as(ADMIN2)).query(`SELECT labor_cost_today()`)), /Nicht autorisiert/, 'nicht freigeschalteter Admin')
})

test('Migration 35 ändert keine Daten (Zeit, Pausen, Lohn, Krankheit vorher = nachher)', async () => {
  const db0 = await startDb({ migrations: MIGRATIONS.filter(m => m !== '35_labor_cost_today.sql') })
  try {
    await addPeople(db0.sys, [[1, 'admin'], [3, 'employee']])
    await db0.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, break_minutes) VALUES ($1, '2026-09-15', '2026-09-15T08:00:00Z', '2026-09-15T12:00:00Z', 3.75, 15)`, [EMP(3)])
    await db0.sys.query(`INSERT INTO payroll_months (employee_id, year, month, actual_hours, is_finalized) VALUES ($1, 2026, 9, 3.75, true)`, [EMP(3)])
    await db0.sys.query(`INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-02')`, [EMP(3)])
    const snap = async () => JSON.stringify(await Promise.all(['time_entries', 'time_entry_breaks', 'time_corrections', 'payroll_months', 'sick_leave', 'shifts', 'employees']
      .map(async t => (await db0.sys.query(`SELECT * FROM ${t} ORDER BY id`)).rows)))
    const s0 = await snap()
    await db0.sys.query(migration('35_labor_cost_today.sql')); await db0.sys.query(migration('35_labor_cost_today.sql'))
    assert.equal(await snap(), s0)
  } finally { await db0.stop() }
})
