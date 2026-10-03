// Migration 36: stellvertretende Live-Buchung (Manager/Admin, Serverzeit, keine Korrektur).
// Zustandsmaschine OFF_CLOCK → WORKING ⇄ ON_BREAK → OFF_CLOCK; dieselben Trigger/Pausenregeln wie das Selbststempeln;
// Standort nur für die stellvertretende Aktion ausgesetzt; Audit nicht fälschbar; Parallelität sicher.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, EMP, U } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2, M2, INACTIVE] = [1, 2, 3, 4, 5, 6]
const CAFE = { lat: 50.1109, lng: 8.6821 }
let db
const act = async (c, emp, action, expected, confirmed = true) =>
  (await one(c, `SELECT staff_live_action($1, $2, $3, $4) r`, [EMP(emp), action, expected, confirmed])).r
const state = async n => {
  const e = await one(db.sys, `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(n)])
  if (!e) return 'OFF_CLOCK'
  return (await one(db.sys, `SELECT count(*)::int c FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`, [e.id])).c ? 'ON_BREAK' : 'WORKING'
}
const audit = n => rows(db.sys, `SELECT actor_id, actor_role, action, previous_state, new_state, server_time, source, time_entry_id FROM time_live_actions WHERE employee_id = $1 ORDER BY created_at, server_time`, [EMP(n)])
const openCounts = async n => one(db.sys, `SELECT (SELECT count(*)::int FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL) entries,
  (SELECT count(*)::int FROM time_entry_breaks WHERE employee_id = $1 AND break_end IS NULL) breaks`, [EMP(n)])
const reset = () => db.sys.query(`DELETE FROM time_entries; DELETE FROM time_live_actions; DELETE FROM activity_log;`)

before(async () => {
  db = await startDb()
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee'], [M2, 'manager'], [INACTIVE, 'employee', { active: false }]])
  // Standortpflicht aktiv (GPS-Radius): Selbststempeln ohne Standort wird abgelehnt
  await db.sys.query(`INSERT INTO cafe_settings (id, gps_lat, gps_lng, gps_radius_m) VALUES (1, $1, $2, 200)`, [CAFE.lat, CAFE.lng])
})
after(async () => { await db?.stop() })
beforeEach(reset)

test('Manager: einstempeln → Pause → Pause beenden → ausstempeln; Serverzeit, ohne Standort, vollständiges Audit', async () => {
  const m = await db.as(MANAGER)
  assert.match(await err(async () => (await db.as(E1)).query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E1)])), /nur im Café/, 'Selbststempeln ohne Standort weiterhin gesperrt')
  const t0 = Date.now()
  const r1 = await act(m, E1, 'clock_in', 'OFF_CLOCK')
  assert.deepEqual([r1.success, r1.previous_state, r1.state], [true, 'OFF_CLOCK', 'WORKING'])
  const e = await one(db.sys, `SELECT clock_in, clock_in_method, gps_lat_in, gps_ok_in, approved, date::text d FROM time_entries WHERE id = $1`, [r1.entry_id])
  assert.ok(Math.abs(new Date(e.clock_in) - t0) < 5000, 'Serverzeit')
  assert.deepEqual([e.clock_in_method, e.gps_lat_in, e.gps_ok_in, e.approved], ['live_action', null, false, false])
  await db.sys.query(`UPDATE time_entries SET clock_in = clock_in - interval '3 hours' WHERE id = $1`, [r1.entry_id])
  assert.equal((await act(m, E1, 'break_start', 'WORKING')).state, 'ON_BREAK')
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = break_start - interval '30 minutes' WHERE time_entry_id = $1`, [r1.entry_id])
  assert.equal((await act(m, E1, 'break_end', 'ON_BREAK')).state, 'WORKING')
  assert.equal((await one(db.sys, `SELECT closed_by FROM time_entry_breaks WHERE time_entry_id = $1`, [r1.entry_id])).closed_by, 'live_action')
  const r4 = await act(m, E1, 'clock_out', 'WORKING')
  assert.deepEqual([r4.success, r4.state], [true, 'OFF_CLOCK'])
  const done = await one(db.sys, `SELECT clock_out, clock_out_method, break_minutes, hours_worked::float h FROM time_entries WHERE id = $1`, [r1.entry_id])
  assert.equal(done.clock_out_method, 'live_action')
  assert.equal(done.break_minutes, 30); assert.ok(Math.abs(done.h - 2.5) < 0.02, `Netto 3 h − 30 Min. (${done.h})`)
  assert.deepEqual(await openCounts(E1), { entries: 0, breaks: 0 })
  const a = await audit(E1)
  assert.deepEqual(a.map(x => [x.action, x.previous_state, x.new_state, x.actor_id, x.actor_role, x.source]), [
    ['clock_in', 'OFF_CLOCK', 'WORKING', U(MANAGER), 'manager', 'MANAGER_LIVE_ACTION'],
    ['break_start', 'WORKING', 'ON_BREAK', U(MANAGER), 'manager', 'MANAGER_LIVE_ACTION'],
    ['break_end', 'ON_BREAK', 'WORKING', U(MANAGER), 'manager', 'MANAGER_LIVE_ACTION'],
    ['clock_out', 'WORKING', 'OFF_CLOCK', U(MANAGER), 'manager', 'MANAGER_LIVE_ACTION']])
  assert.ok(a.every(x => x.time_entry_id === r1.entry_id))
  assert.equal(new Date(a[3].server_time).getTime(), new Date(done.clock_out).getTime(), 'Audit-Zeit = gebuchte Serverzeit')
  const log = await rows(db.sys, `SELECT action, category, actor_id, target_id, metadata FROM activity_log ORDER BY created_at`)
  assert.equal(log.length, 4); assert.ok(log.every(l => l.metadata.source === 'MANAGER_LIVE_ACTION' && l.actor_id === U(MANAGER) && l.category === 'time'))
})

test('Admin: einstempeln; Ausstempeln während Pause schließt die Pause (gleiche Serverzeit), nichts bleibt offen', async () => {
  const a = await db.as(ADMIN)
  const r = await act(a, E2, 'clock_in', 'OFF_CLOCK')
  await db.sys.query(`UPDATE time_entries SET clock_in = clock_in - interval '2 hours' WHERE id = $1`, [r.entry_id])
  await act(a, E2, 'break_start', 'WORKING')
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = break_start - interval '20 minutes' WHERE time_entry_id = $1`, [r.entry_id])
  const o = await act(a, E2, 'clock_out', 'ON_BREAK')
  assert.deepEqual([o.success, o.previous_state, o.state], [true, 'ON_BREAK', 'OFF_CLOCK'])
  const e = await one(db.sys, `SELECT clock_out, break_minutes, hours_worked::float h FROM time_entries WHERE id = $1`, [r.entry_id])
  const b = await one(db.sys, `SELECT break_end, closed_by FROM time_entry_breaks WHERE time_entry_id = $1`, [r.entry_id])
  assert.equal(new Date(b.break_end).getTime(), new Date(e.clock_out).getTime(), 'Pause endet exakt mit dem Ausstempeln')
  assert.equal(b.closed_by, 'clock_out', 'bestehende Semantik aus Migration 34')
  assert.ok(e.break_minutes === 20 && Math.abs(e.h - (2 - 20 / 60)) < 0.02)
  assert.deepEqual(await openCounts(E2), { entries: 0, breaks: 0 })
  assert.equal((await audit(E2))[2].actor_role, 'admin')
})

test('Ungültige Übergänge und veraltete Ansicht: nichts passiert, kein Audit', async () => {
  const m = await db.as(MANAGER)
  for (const [action, expected] of [['break_start', 'OFF_CLOCK'], ['break_end', 'OFF_CLOCK'], ['clock_out', 'OFF_CLOCK']])
    assert.deepEqual(await act(m, E1, action, expected), { success: false, code: 'invalid_transition', state: 'OFF_CLOCK' }, `${action} ohne Clock-In`)
  assert.deepEqual(await act(m, E1, 'clock_in', 'WORKING'), { success: false, code: 'stale', state: 'OFF_CLOCK' })
  await act(m, E1, 'clock_in', 'OFF_CLOCK')
  assert.deepEqual(await act(m, E1, 'clock_in', 'OFF_CLOCK'), { success: false, code: 'stale', state: 'WORKING' }, 'zweimal einstempeln')
  assert.deepEqual(await act(m, E1, 'clock_in', 'WORKING'), { success: false, code: 'invalid_transition', state: 'WORKING' })
  assert.deepEqual(await act(m, E1, 'break_end', 'WORKING'), { success: false, code: 'invalid_transition', state: 'WORKING' }, 'Pause beenden ohne Pause')
  await act(m, E1, 'break_start', 'WORKING')
  assert.deepEqual(await act(m, E1, 'break_start', 'ON_BREAK'), { success: false, code: 'invalid_transition', state: 'ON_BREAK' }, 'zweite Pause')
  assert.deepEqual(await act(m, E1, 'break_start', 'WORKING'), { success: false, code: 'stale', state: 'ON_BREAK' })
  assert.deepEqual(await openCounts(E1), { entries: 1, breaks: 1 })
  assert.equal((await audit(E1)).length, 2, 'nur die zwei erfolgreichen Aktionen')
})

test('Rechte: Mitarbeiter/inaktiver Manager/anonym nie; nicht für sich selbst; Pflichtbestätigung; IDs nicht manipulierbar', async () => {
  const e = await db.as(E1)
  assert.match(await err(() => act(e, E2, 'clock_in', 'OFF_CLOCK')), /Nur Manager und Admins/)
  assert.match(await err(async () => (await db.anon()).query(`SELECT staff_live_action($1, 'clock_in', 'OFF_CLOCK', true)`, [EMP(E2)])), /permission denied/)
  const m = await db.as(MANAGER)
  assert.match(await err(() => act(m, MANAGER, 'clock_in', 'OFF_CLOCK')), /Für dich selbst/, 'kein Standort-Umweg für sich selbst')
  assert.match(await err(() => act(m, E1, 'clock_in', 'OFF_CLOCK', false)), /ausdrücklich bestätigen/)
  assert.match(await err(() => act(m, E1, 'clock_in_at_10', 'OFF_CLOCK')), /Unbekannte Aktion/)
  assert.match(await err(() => act(m, E1, 'clock_in', 'X')), /Unbekannter Ausgangszustand/)
  assert.match(await err(() => m.query(`SELECT staff_live_action(gen_random_uuid(), 'clock_in', 'OFF_CLOCK', true)`)), /nicht gefunden/)
  assert.match(await err(() => act(m, INACTIVE, 'clock_in', 'OFF_CLOCK')), /nicht aktiv/)
  assert.match(await err(() => m.query(`SELECT staff_live_action($1, 'clock_in', 'OFF_CLOCK', true, now() - interval '2 hours')`, [EMP(E1)])), /does not exist/, 'kein Zeit-Parameter')
  // Status entzogen → sofort keine Live-Steuerung (Rolle live aus profiles)
  const a = await db.session(ADMIN)
  await a.query(`UPDATE profiles SET status = 'pending' WHERE id = $1`, [U(M2)])
  assert.match(await err(async () => act(await db.as(M2), E1, 'clock_in', 'OFF_CLOCK')), /Nur Manager und Admins/)
  await a.query(`UPDATE profiles SET status = 'approved' WHERE id = $1`, [U(M2)])
  // Direkte Wege bleiben zu: fremde Einträge, Audit, interne Funktionen; Flag setzt ein Client nicht wirksam
  assert.match(await err(() => m.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E1)])), /row-level security|nur im Café/, 'fremder Eintrag direkt: abgelehnt (Trigger oder RLS)')
  await m.query(`SELECT set_config('cafe.live_action', 'on', false)`)
  assert.match(await err(() => m.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(MANAGER)])), /nur im Café/, 'Flag hebt Standort für sich selbst nie auf')
  assert.match(await err(() => m.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E1)])), /row-level security|nur im Café/, 'fremder Eintrag direkt: abgelehnt (Trigger oder RLS)')
  await m.query(`SELECT set_config('cafe.live_action', '', false)`)
  for (const c of [m, await db.as(ADMIN)]) {
    assert.match(await err(() => c.query(`INSERT INTO time_live_actions (employee_id, actor_id, actor_role, action, previous_state, new_state, server_time) VALUES ($1, $2, 'admin', 'clock_in', 'OFF_CLOCK', 'WORKING', now())`, [EMP(E1), U(ADMIN)])), /permission denied/, 'Audit nicht fälschbar')
    assert.match(await err(() => c.query(`DELETE FROM time_live_actions`)), /permission denied/)
    assert.match(await err(() => c.query(`SELECT _break_start_for($1)`, [EMP(E1)])), /permission denied/)
    assert.match(await err(() => c.query(`SELECT _break_end_for($1, 'live_action')`, [EMP(E1)])), /permission denied/)
  }
  // Keine historischen Korrekturrechte: Zeitkorrektur bleibt Admin-only
  assert.match(await err(() => m.query(`SELECT admin_save_time_entry(NULL, $1, current_date - 1, '10:00', '12:00', '[]', NULL, '', 'x', NULL)`, [EMP(E1)])), /Nicht autorisiert/)
  // Audit lesen: Admin + betroffene Person, nicht Manager/andere
  const r = await act(m, E1, 'clock_in', 'OFF_CLOCK')
  assert.ok(r.success)
  assert.equal((await rows(await db.as(ADMIN), `SELECT id FROM time_live_actions`)).length, 1)
  assert.equal((await rows(await db.as(E1), `SELECT id FROM time_live_actions`)).length, 1)
  assert.equal((await rows(await db.as(E2), `SELECT id FROM time_live_actions`)).length, 0)
  assert.equal((await rows(m, `SELECT id FROM time_live_actions`)).length, 0)
})

test('Parallel: Doppelklick (10×), zwei Manager, Manager + Mitarbeiter gleichzeitig – genau ein Ergebnis, Audit passt', async () => {
  const conns = await Promise.all(Array.from({ length: 10 }, () => db.as(MANAGER)))
  const res = await Promise.all(conns.map(c => act(c, E1, 'clock_in', 'OFF_CLOCK')))
  assert.equal(res.filter(r => r.success).length, 1); assert.ok(res.filter(r => !r.success).every(r => r.code === 'stale' && r.state === 'WORKING'))
  assert.deepEqual(await openCounts(E1), { entries: 1, breaks: 0 }); assert.equal((await audit(E1)).length, 1)
  const [m1, m2] = [await db.as(MANAGER), await db.as(M2)]
  const two = await Promise.all([act(m1, E1, 'break_start', 'WORKING'), act(m2, E1, 'clock_out', 'WORKING')])
  assert.equal(two.filter(r => r.success).length, 1, JSON.stringify(two))
  assert.equal((await audit(E1)).length, 2)
  // Mitarbeiter stempelt selbst ein (im Café), Manager gleichzeitig stellvertretend
  await reset()
  const emp = await db.as(E2)
  const both = await Promise.allSettled([
    emp.query(`INSERT INTO time_entries (employee_id, date, clock_in, gps_lat_in, gps_lng_in) VALUES ($1, current_date, now(), $2, $3)`, [EMP(E2), CAFE.lat, CAFE.lng]),
    act(await db.as(MANAGER), E2, 'clock_in', 'OFF_CLOCK')])
  assert.deepEqual(await openCounts(E2), { entries: 1, breaks: 0 }, JSON.stringify(both.map(b => b.status === 'fulfilled' ? (b.value.rows?.[0]?.r ?? 'ok') : b.reason.message)))
  assert.equal((await audit(E2)).length, both[1].status === 'fulfilled' && both[1].value.success ? 1 : 0)
  // Mitarbeiter stempelt selbst aus, Manager gleichzeitig
  const id = (await one(db.sys, `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(E2)])).id
  const outs = await Promise.allSettled([
    emp.query(`UPDATE time_entries SET clock_out = now(), gps_lat_out = $2, gps_lng_out = $3 WHERE id = $1 AND clock_out IS NULL`, [id, CAFE.lat, CAFE.lng]),
    act(await db.as(MANAGER), E2, 'clock_out', 'WORKING')])
  const empDid = outs[0].status === 'fulfilled' && outs[0].value.rowCount === 1, mgrDid = outs[1].status === 'fulfilled' && outs[1].value.success
  assert.ok(empDid !== mgrDid, 'genau einer stempelt aus')
  assert.deepEqual(await openCounts(E2), { entries: 0, breaks: 0 })
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entries WHERE employee_id = $1`, [EMP(E2)])).c, 1)
})

test('Selbststempeln, Remote und Pausen-RPCs unverändert; > 12 h-Regel gilt auch stellvertretend; Live-Personalkosten erkennen es', async () => {
  const e = await db.as(E1)
  await e.query(`INSERT INTO time_entries (employee_id, date, clock_in, gps_lat_in, gps_lng_in) VALUES ($1, current_date, now(), $2, $3)`, [EMP(E1), CAFE.lat, CAFE.lng])
  const b = await one(e, `SELECT * FROM start_break()`)
  assert.equal(b.closed_by, null)
  assert.match(await err(() => e.query(`SELECT start_break()`)), /läuft bereits/)
  const eb = await one(e, `SELECT * FROM end_break()`); assert.equal(eb.closed_by, 'employee')
  assert.match(await err(() => e.query(`SELECT end_break()`)), /keine Pause/)
  const self = await one(db.sys, `SELECT clock_in_method FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(E1)])
  assert.notEqual(self.clock_in_method, 'live_action')
  // Live-Personalkosten (Migration 35): stellvertretende Buchung zählt wie Selbststempeln
  const m = await db.as(MANAGER)
  const before = (await one(db.sys, `SELECT _labor_cost_at(now()) r`)).r.today.running
  const r = await act(m, E2, 'clock_in', 'OFF_CLOCK')
  assert.equal((await one(db.sys, `SELECT _labor_cost_at(now()) r`)).r.today.running, before + 1)
  await act(m, E2, 'break_start', 'WORKING')
  assert.equal((await one(db.sys, `SELECT _labor_cost_at(now()) r`)).r.today.on_break, 1)
  await act(m, E2, 'break_end', 'ON_BREAK')
  // > 12 h offen → stellvertretendes Ausstempeln markiert wie üblich (0 Std. bis zur Korrektur)
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '13 hours' WHERE id = $1`, [r.entry_id])
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '12 hours', break_end = now() - interval '11 hours' WHERE time_entry_id = $1`, [r.entry_id])
  await act(m, E2, 'clock_out', 'WORKING')
  const x = await one(db.sys, `SELECT hours_worked::float h, notes FROM time_entries WHERE id = $1`, [r.entry_id])
  assert.ok(x.h === 0 && /AUSSTEMPELN VERGESSEN/.test(x.notes))
  assert.equal((await one(db.sys, `SELECT _labor_cost_at(now()) r`)).r.today.running, before)
})

test('Serialisierung je Person: gleicher Sperrschlüssel wie Remote-Stempeln – parallele Aktion wartet, statt zu kollidieren', async () => {
  const holder = await db.as(MANAGER)
  await holder.query('BEGIN')
  await holder.query(`SELECT pg_advisory_xact_lock(hashtext('cafe.clock:' || $1::text))`, [EMP(E1)])   // z. B. laufendes clock_in_remote
  const m = await db.as(M2)
  await m.query(`SET statement_timeout = '400ms'`)
  assert.match(await err(() => act(m, E1, 'clock_in', 'OFF_CLOCK')), /statement timeout|canceling statement/, 'wartet auf die laufende Aktion derselben Person')
  await m.query(`SET statement_timeout = 0`)
  await holder.query('ROLLBACK')
  assert.equal((await act(m, E1, 'clock_in', 'OFF_CLOCK')).success, true, 'danach normal')
  assert.equal((await act(await db.as(MANAGER), E2, 'clock_in', 'OFF_CLOCK')).success, true, 'andere Person nie blockiert')
})
