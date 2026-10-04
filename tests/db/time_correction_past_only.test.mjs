// Migration 37 (Audit H1/M1): Zeitkorrektur nur für Vergangenes; keine überlappenden Zeiteinträge derselben Person –
// in der Korrektur, beim Einstempeln (selbst/remote/stellvertretend) und am Transaktionsende. Altbestand unverändert.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, EMP, day, MIGRATIONS, migration } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const SAVE = `SELECT admin_save_time_entry($1, $2, $3, $4, $5, $6, NULL, '', 'Test', $7) v`
const save = async (c, { id = null, emp = EMP(E1), date, inT, outT, breaks = [], expected = null }) =>
  (await one(c, SAVE, [id, emp, date, inT, outT, JSON.stringify(breaks), expected])).v
const state = async id => (await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s
const snapshot = async () => JSON.stringify((await rows(db.sys, `SELECT * FROM time_entries ORDER BY id`)).concat(await rows(db.sys, `SELECT * FROM time_entry_breaks ORDER BY id`)))
const berlin = async sql => one(db.sys, `SELECT (x AT TIME ZONE 'Europe/Berlin')::date::text d, to_char(x AT TIME ZONE 'Europe/Berlin', 'HH24:MI') t FROM (SELECT ${sql} x) s`)

before(async () => {
  db = await startDb()
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
})
after(async () => { await db?.stop() })
beforeEach(() => db.sys.query(`DELETE FROM time_entries; DELETE FROM payroll_months;`))

test('H1: Ende/Beginn in der Zukunft abgelehnt – neu und beim Bearbeiten, offen und beendet; nichts geändert', async () => {
  const a = await db.session(ADMIN)
  const past = await berlin(`now() - interval '6 hours'`), soon = await berlin(`now() + interval '3 hours'`), nowT = await berlin(`now()`)
  const crossesMidnight = soon.d !== past.d
  if (!crossesMidnight) {
    assert.match(await err(() => save(a, { date: past.d, inT: past.t, outT: soon.t })), /in der Zukunft/, 'Ende +3 h (wie Production: 08:30–18:00 um 14:04)')
  }
  const s0 = await snapshot()
  const fut = await berlin(`now() + interval '2 hours'`)
  assert.match(await err(() => save(a, { date: fut.d, inT: fut.t, outT: null })), /in der Zukunft/, 'offene Schicht beginnt in der Zukunft')
  assert.match(await err(() => save(a, { date: day(1), inT: '08:00', outT: '12:00' })), /in der Zukunft/, 'ganzer Eintrag morgen')
  assert.equal(await snapshot(), s0)
  // Bestehender Eintrag: Ende nachträglich in die Zukunft schieben → abgelehnt
  const r = await save(a, { date: day(-2), inT: '08:00', outT: '12:00' })
  assert.ok((await save(a, { id: r.id, date: day(-2), inT: '08:00', outT: '12:00', expected: await state(r.id) })).success, 'unverändert speichern geht')
  assert.match(await err(async () => save(a, { id: r.id, date: day(1), inT: '08:00', outT: '12:00', expected: await state(r.id) })), /in der Zukunft/)
  // Bis „jetzt“ (Minutengenauigkeit, Toleranz 1 Min.) ist erlaubt
  const start = await berlin(`now() - interval '2 hours'`)
  if (start.d === nowT.d) {
    const ok = await save(a, { emp: EMP(E2), date: start.d, inT: start.t, outT: nowT.t })
    assert.ok(ok.success, 'Ende = aktuelle Minute erlaubt')
  }
})

test('M1: Überschneidung mit einem anderen Eintrag derselben Person abgelehnt (mit Zeiten), angrenzend erlaubt, andere Person unabhängig', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-3), inT: '10:00', outT: '14:00' })
  const s0 = await snapshot()
  for (const [inT, outT, name] of [['09:00', '11:00', 'beginnt davor'], ['13:00', '16:00', 'endet danach'], ['11:00', '12:00', 'liegt innen'], ['09:00', '15:00', 'umschließt']])
    assert.match(await err(() => save(a, { date: day(-3), inT, outT })), /überschneiden sich mit einem anderen Eintrag dieser Person \(\d\d\.\d\d\. 10:00 – 14:00\)/, name)
  assert.equal(await snapshot(), s0, 'nichts angelegt')
  assert.ok((await save(a, { date: day(-3), inT: '14:00', outT: '16:00' })).success, 'angrenzend (Ende = Beginn) erlaubt')
  assert.ok((await save(a, { date: day(-3), inT: '06:00', outT: '10:00' })).success, 'angrenzend davor erlaubt')
  assert.ok((await save(a, { emp: EMP(E2), date: day(-3), inT: '10:00', outT: '14:00' })).success, 'andere Person: kein Konflikt')
  // Bearbeiten: sich selbst nie als Konflikt; in einen Nachbarn hineinschieben → abgelehnt
  assert.ok((await save(a, { id: r.id, date: day(-3), inT: '10:30', outT: '13:30', expected: await state(r.id) })).success)
  assert.match(await err(async () => save(a, { id: r.id, date: day(-3), inT: '10:30', outT: '15:00', expected: await state(r.id) })), /überschneiden/)
  // Überschneidung über Mitternacht
  const n = await save(a, { date: day(-5), inT: '22:00', outT: '06:00' })
  assert.match(await err(() => save(a, { date: day(-4), inT: '05:00', outT: '09:00' })), /überschneiden/, 'Nachtschicht vom Vortag')
  assert.ok(n.success)
})

test('M1: Korrektur, die eine laufende Schicht überlappt, abgelehnt; Lohnmonat-Sperre hat Vorrang', async () => {
  const a = await db.session(ADMIN)
  const c = await db.as(E1)
  const { id } = await one(c, `INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now()) RETURNING id`, [EMP(E1)])
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '3 hours' WHERE id = $1`, [id])
  const t = await berlin(`now() - interval '4 hours'`), u = await berlin(`now() - interval '2 hours'`)
  if (t.d === u.d) assert.match(await err(() => save(a, { date: t.d, inT: t.t, outT: u.t })), /überschneiden.*– offen\)/, 'laufende Schicht')
  const r = await save(a, { date: day(-40), inT: '10:00', outT: '14:00' })
  const ym = await one(db.sys, `SELECT EXTRACT(YEAR FROM $1::date)::int y, EXTRACT(MONTH FROM $1::date)::int m`, [day(-40)])
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month, is_finalized) VALUES ($1, $2, $3, true)`, [EMP(E1), ym.y, ym.m])
  assert.match(await err(() => save(a, { date: day(-40), inT: '11:00', outT: '12:00' })), /Lohnmonat .* abgeschlossen/, 'Sperre zuerst')
  assert.ok(r.success)
})

test('M1: Einstempeln (selbst, stellvertretend) abgelehnt, solange ein Eintrag der Person noch nicht zu Ende ist (Altbestand mit Ende in der Zukunft)', async () => {
  // Altbestand wie in Production (vor Migration 37 möglich): beendeter Eintrag mit Ende in 3 h
  const { id } = await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, break_minutes)
    VALUES ($1, current_date, now() - interval '5 hours', now() + interval '3 hours', 8, 0) RETURNING id`, [EMP(E1)])
  const s0 = await snapshot()
  const m = await db.as(MANAGER)
  const res = await err(() => m.query(`SELECT staff_live_action($1, 'clock_in', 'OFF_CLOCK', true)`, [EMP(E1)]))
  assert.match(res, /bereits einen Zeiteintrag bis .* überschneiden/, 'stellvertretend')
  assert.match(await err(async () => (await db.as(E1)).query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E1)])), /bereits einen Zeiteintrag bis/, 'selbst')
  assert.equal(await snapshot(), s0, 'nichts gebucht')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM time_live_actions`)).n, 0, 'kein Audit für fehlgeschlagene Aktion')
  // Andere Personen unberührt
  assert.ok((await one(m, `SELECT staff_live_action($1, 'clock_in', 'OFF_CLOCK', true) r`, [EMP(E2)])).r.success)
  // Admin kann den Altbestand korrigieren (Ende auf jetzt/früher) – danach geht Einstempeln wieder
  const a = await db.session(ADMIN)
  const t = await one(db.sys, `SELECT (clock_in AT TIME ZONE 'Europe/Berlin')::date::text d, to_char(clock_in AT TIME ZONE 'Europe/Berlin', 'HH24:MI') i,
     to_char((now() - interval '1 hour') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') o FROM time_entries WHERE id = $1`, [id])
  await save(a, { id, date: t.d, inT: t.i, outT: t.o, expected: await state(id) })
  assert.ok((await one(m, `SELECT staff_live_action($1, 'clock_in', 'OFF_CLOCK', true) r`, [EMP(E1)])).r.success)
})

test('M1: Konsistenzprüfung am Transaktionsende fängt Überschneidungen auch aus anderen (künftigen) Server-Funktionen', async () => {
  await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, break_minutes) VALUES ($1, current_date - 2, now() - interval '50 hours', now() - interval '46 hours', 4, 0) RETURNING id`, [EMP(E1)])
  await db.sys.query(`CREATE FUNCTION test_overlap_write(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
    BEGIN
      PERFORM set_config('cafe.time_correction', 'on', true);
      INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, break_minutes)
      VALUES (p, current_date - 2, now() - interval '48 hours', now() - interval '44 hours', 4, 0);
    END $$; GRANT EXECUTE ON FUNCTION test_overlap_write(uuid) TO authenticated;`)
  try {
    const s0 = await snapshot()
    assert.match(await err(async () => (await db.as(ADMIN)).query(`SELECT test_overlap_write($1)`, [EMP(E1)])), /überschneidet sich mit einem anderen Eintrag derselben Person/)
    assert.equal(await snapshot(), s0)
  } finally { await db.sys.query(`DROP FUNCTION test_overlap_write(uuid)`) }
})

test('Migration 37: bestehende Daten (inkl. überlappendem Altbestand und Ende in der Zukunft) unverändert, wiederholt ausführbar', async () => {
  const db0 = await startDb({ migrations: MIGRATIONS.slice(0, MIGRATIONS.indexOf('37_time_correction_past_only.sql')) })
  try {
    await addPeople(db0.sys, [[1, 'admin'], [3, 'employee']])
    await db0.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, break_minutes, notes) VALUES
      ($1, current_date, now() - interval '6 hours', now() + interval '4 hours', 9.33, 10, '[ADMIN-KORREKTUR]'),
      ($1, current_date, now() - interval '10 minutes', now() - interval '9 minutes', 0, 0, NULL)`, [EMP(3)])
    const snap = async () => JSON.stringify(await Promise.all(['time_entries', 'time_entry_breaks', 'time_corrections', 'payroll_months', 'time_live_actions']
      .map(async t => (await db0.sys.query(`SELECT * FROM ${t} ORDER BY id`)).rows)))
    const s0 = await snap()
    await db0.sys.query(migration('37_time_correction_past_only.sql')); await db0.sys.query(migration('37_time_correction_past_only.sql'))
    assert.equal(await snap(), s0)
  } finally { await db0.stop() }
})
