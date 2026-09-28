// Zeiterfassung & Pausen: Server-Guards, keine automatische Pause, max. ein offener Eintrag / eine offene Pause,
// echte Parallelität beim Einstempeln (Migration 21). Nur synthetische Daten, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, EMP } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2, E3, INACTIVE] = [1, 2, 3, 4, 5, 6]
let db
before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee'], [E3, 'employee'], [INACTIVE, 'employee', { active: false }]])
})
after(async () => { await db?.stop() })

// Jeder Test beginnt ohne offene Einträge (Unabhängigkeit der Tests)
const closeAllOpen = () => db.sys.query(`UPDATE time_entries SET clock_out = now() WHERE clock_out IS NULL`)
const openCount = async n => (await one(db.sys, `SELECT count(*)::int c FROM time_entries WHERE employee_id=$1 AND clock_out IS NULL`, [EMP(n)])).c
const clockInSql = n => [`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now()) RETURNING id`, [EMP(n)]]
// Einstempeln wie die App, danach Beginn systemseitig in die Vergangenheit legen (Testaufbau)
async function clockedIn(n, hoursAgo) {
  const c = await db.as(n)
  const { id } = await one(c, ...clockInSql(n))
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - make_interval(secs => $2::float8 * 3600) WHERE id = $1`, [id, hoursAgo])
  return { c, id }
}
const moveBreak = (id, startAgo, endAgo) => db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - $2::interval, break_end = CASE WHEN $3::text IS NULL THEN break_end ELSE now() - $3::interval END WHERE id = $1`, [id, startAgo, endAgo])
const entry = id => one(db.sys, `SELECT clock_in, clock_out, break_minutes, hours_worked::float h, notes, approved FROM time_entries WHERE id = $1`, [id])

test('Einstempeln: Server setzt Zeit, ignoriert Rückdatierung/Freigabe, kein Doppel, nicht für andere', async () => {
  const c = await db.as(E1)
  const r = await one(c, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, approved) VALUES ($1, '2026-01-01', '2026-01-01T06:00:00Z', '2026-01-01T20:00:00Z', 14, true) RETURNING id, clock_in, clock_out, hours_worked, approved`, [EMP(E1)])
  assert.ok(r.clock_out === null && r.hours_worked === null && r.approved === false && Math.abs(new Date(r.clock_in) - Date.now()) < 60000)
  assert.match(await err(() => c.query(...clockInSql(E1))), /bereits eingeclockt/)
  assert.match(await err(() => c.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E2)])), /row-level security/)
  await c.query(`UPDATE time_entries SET clock_in = now() - interval '5 hours', approved = true WHERE id = $1`, [r.id])
  const e = await entry(r.id)
  assert.ok(e.approved === false && Math.abs(new Date(e.clock_in) - Date.now()) < 60000, 'offene Schicht nicht manipulierbar')
  await c.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [r.id])
})

test('Ausstempeln: keine automatische Pause, > 12 h → 0 h + Markierung, Client-Stunden ignoriert, kein zweites Ausstempeln', async () => {
  for (const [h, exp] of [[5, 5], [8, 8], [10, 10]]) {
    const { c, id } = await clockedIn(E1, h)
    await c.query(`UPDATE time_entries SET clock_out = now(), hours_worked = 99, break_minutes = 0 WHERE id = $1`, [id])
    const e = await entry(id)
    assert.equal(e.break_minutes, 0, `${h} h ohne Pause`); assert.equal(e.h, exp, `${h} h netto`)
  }
  const { c, id } = await clockedIn(E1, 13)
  await c.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [id])
  const e = await entry(id)
  assert.equal(e.h, 0); assert.match(e.notes, /VERGESSEN/)
  // zweites (veraltetes) Ausstempeln: mit Filter der App keine Wirkung – Mitarbeiter wie Admin
  assert.equal((await c.query(`UPDATE time_entries SET clock_out = now(), hours_worked = 1 WHERE id = $1 AND clock_out IS NULL RETURNING id`, [id])).rowCount, 0)
  const a = await db.as(ADMIN)
  assert.equal((await a.query(`UPDATE time_entries SET clock_out = now(), hours_worked = 9 WHERE id = $1 AND clock_out IS NULL RETURNING id`, [id])).rowCount, 0)
  assert.equal((await entry(id)).h, 0)
})

test('Pausen: Start/Ende per RPC, keine Doppelstarts, mehrere Pausen, Ausstempeln beendet laufende Pause, Netto korrekt', async () => {
  await closeAllOpen()
  const { c, id } = await clockedIn(E2, 8)
  assert.match(await err(() => c.query(`SELECT end_break()`)), /keine Pause/)
  const b1 = await one(c, `SELECT * FROM start_break()`)
  assert.equal(b1.time_entry_id, id)
  assert.match(await err(() => c.query(`SELECT start_break()`)), /läuft bereits/)
  await moveBreak(b1.id, '5 hours', null)
  const e1 = await one(c, `SELECT * FROM end_break()`)
  assert.ok(e1.break_end && e1.closed_by === 'employee')
  await moveBreak(b1.id, '5 hours', '4 hours 40 minutes')                  // 20 Min
  const b2 = await one(c, `SELECT * FROM start_break()`); await moveBreak(b2.id, '3 hours', '2 hours 50 minutes')   // 10 Min
  const b3 = await one(c, `SELECT * FROM start_break()`); await moveBreak(b3.id, '15 minutes', null)                 // läuft 15 Min
  await c.query(`UPDATE time_entries SET clock_out = now(), break_minutes = 0, hours_worked = 99 WHERE id = $1`, [id])
  const e = await entry(id)
  assert.equal(e.break_minutes, 45, 'nur erfasste Pausen, jede genau einmal'); assert.equal(e.h, 7.25)
  assert.equal((await one(db.sys, `SELECT closed_by FROM time_entry_breaks WHERE id = $1`, [b3.id])).closed_by, 'clock_out')
  assert.match(await err(() => c.query(`SELECT start_break()`)), /nicht eingeclockt/)
})

test('Pausen: höchstens eine offene Pause je Eintrag (Unique-Index), nur per RPC, nur eigene', async () => {
  await closeAllOpen()
  const { c, id } = await clockedIn(E3, 2)
  const b = await one(c, `SELECT * FROM start_break()`)
  // Guard lehnt eine zweite offene Pause bereits fachlich ab …
  assert.match(await err(() => db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start) VALUES ($1, $2, now())`, [id, EMP(E3)])), /überschneiden|läuft bereits/)
  // … und der Unique-Index hält auch ohne Trigger (letzte Verteidigungslinie)
  await db.sys.query('BEGIN'); await db.sys.query('SET LOCAL session_replication_role = replica')
  const idx = await err(() => db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start) VALUES ($1, $2, now())`, [id, EMP(E3)]))
  await db.sys.query('ROLLBACK')
  assert.match(idx, /duplicate key|unique/i)
  assert.match(await err(() => c.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end) SELECT id, employee_id, clock_in + interval '5 minutes', clock_in + interval '10 minutes' FROM time_entries WHERE id = $1`, [id])), /row-level security/)
  assert.equal((await c.query(`UPDATE time_entry_breaks SET break_start = break_start - interval '1 hour' WHERE employee_id = $1`, [EMP(E3)])).rowCount, 0)
  assert.equal((await c.query(`DELETE FROM time_entry_breaks WHERE employee_id = $1`, [EMP(E3)])).rowCount, 0)
  const other = await db.as(E1)
  assert.equal((await other.query(`SELECT id FROM time_entry_breaks WHERE id = $1`, [b.id])).rowCount, 0, 'fremde Pause unsichtbar')
  assert.match(await err(() => other.query(`SELECT end_break()`)), /nicht eingeclockt|keine Pause/)
  const m = await db.as(MANAGER)
  assert.ok((await m.query(`SELECT id FROM time_entry_breaks WHERE id = $1`, [b.id])).rowCount === 1, 'Manager liest')
  assert.equal((await m.query(`UPDATE time_entry_breaks SET break_end = now() WHERE id = $1`, [b.id])).rowCount, 0, 'Manager korrigiert nicht')
  const inactive = await db.as(INACTIVE)
  assert.match(await err(() => inactive.query(`SELECT start_break()`)), /nicht aktiv/)
  await c.query(`SELECT end_break()`); await c.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [id])
})

test('Admin-Korrektur von Pausen: Guard lehnt unmögliche Zeiten ab', async () => {
  const { id } = await clockedIn(E1, 4)
  await db.sys.query(`UPDATE time_entries SET clock_out = now() - interval '10 minutes', hours_worked = 3.8 WHERE id = $1`, [id])
  const a = await db.as(ADMIN)
  const ins = (s, e) => a.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end) VALUES ($1, $2, now() - $3::interval, now() - $4::interval)`, [id, EMP(E1), s, e])
  assert.equal(await err(() => ins('2 hours', '1 hour 40 minutes')), null)
  assert.match(await err(() => ins('1 hour 50 minutes', '1 hour 30 minutes')), /überschneiden/)
  assert.match(await err(() => ins('5 minutes', '1 minute')), /vor dem Ausclocken enden/)
  assert.match(await err(() => ins('5 hours', '4 hours 50 minutes')), /vor dem Einclocken/)
  assert.match(await err(() => ins('1 hour', '70 minutes')), /nach dem Pausenbeginn/)
})

test('Parallel: zwei Geräte gleichzeitig → der zweite Request wartet und scheitert, genau ein offener Eintrag', async () => {
  await closeAllOpen()
  const [a, b] = [await db.as(E2), await db.as(E2)]
  await a.query('BEGIN'); await b.query('BEGIN')
  assert.equal(await err(() => a.query(...clockInSql(E2))), null)
  const second = err(() => b.query(...clockInSql(E2)))        // blockiert auf dem Unique-Index
  await new Promise(r => setTimeout(r, 300))
  await a.query('COMMIT')
  assert.match(await second, /duplicate key|unique/i)
  await b.query('ROLLBACK')
  assert.equal(await openCount(E2), 1)
  await db.sys.query(`UPDATE time_entries SET clock_out = now() WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(E2)])
})

test('Parallel: erster Request bricht ab (Netzfehler) → zweiter stempelt korrekt ein', async () => {
  await closeAllOpen()
  const [a, b] = [await db.as(E3), await db.as(E3)]
  await a.query('BEGIN'); await b.query('BEGIN')
  await a.query(...clockInSql(E3))
  const second = err(() => b.query(...clockInSql(E3)))
  await new Promise(r => setTimeout(r, 300))
  await a.query('ROLLBACK')
  assert.equal(await second, null); await b.query('COMMIT')
  assert.equal(await openCount(E3), 1)
  await db.sys.query(`UPDATE time_entries SET clock_out = now() WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(E3)])
})

test('Parallel: 20 gleichzeitige Einstempel-Requests (Doppelklick/Retry/Tabs) → genau 1 Erfolg; andere Personen unabhängig', async () => {
  await closeAllOpen()
  const conns = await Promise.all(Array.from({ length: 20 }, () => db.as(E1)))
  const res = await Promise.all(conns.map(c => err(() => c.query(...clockInSql(E1)))))
  assert.equal(res.filter(r => r === null).length, 1)
  assert.equal(await openCount(E1), 1)
  const [x, y] = [await db.as(E2), await db.as(E3)]
  await Promise.all([x.query(...clockInSql(E2)), y.query(...clockInSql(E3))])
  assert.equal(await openCount(E2), 1); assert.equal(await openCount(E3), 1)
  const adm = await db.as(ADMIN)
  assert.match(await err(() => adm.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E1)])), /duplicate key|unique/i, 'auch Admin legt keinen zweiten offenen Eintrag an')
})
