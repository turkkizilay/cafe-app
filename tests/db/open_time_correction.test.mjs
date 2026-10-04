// Zeitkorrektur mit leerem Arbeitsende (Production-Fall 04.10.2026): Ein Admin legt für eine Person, die sich nicht
// selbst einstempeln kann, einen OFFENEN Eintrag an. admin_save_time_entry unterstützt das seit Migration 27/34/37
// (p_out = NULL); hier abgesichert: Schutzregeln (Zukunft, zweiter offener Eintrag, Überschneidung, Lohnmonat-Sperre,
// Pausen im Intervall) und dass der Eintrag danach wie ein normaler offener Eintrag behandelt wird (Einstempeln
// gesperrt, Pause, Ausstempeln, Live-Steuerung, Live-Personalkosten, spätere Korrektur, Korrekturprotokoll).
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, EMP, U } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const SAVE = `SELECT admin_save_time_entry($1, $2, $3, $4, $5, $6, NULL, '', $7, $8) v`
const save = async (c, { id = null, emp = E1, d, inT, outT = null, breaks = [], reason = 'Mitarbeiter konnte nicht einstempeln', expected = null }) =>
  (await one(c, SAVE, [id, emp === null ? null : EMP(emp), d, inT, outT, JSON.stringify(breaks), reason, expected === null ? null : JSON.stringify(expected)])).v
// Berliner Datum/Uhrzeit vor bzw. nach N Minuten (Tests laufen zu jeder Uhrzeit)
const berlin = async minutes => one(db.sys, `SELECT to_char(t AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') d, to_char(t AT TIME ZONE 'Europe/Berlin', 'HH24:MI') t
  FROM (SELECT now() + make_interval(mins => $1) t) x`, [minutes])
const state = async n => {   // Zustand wie ihn die Live-Steuerung sieht – Sonde ohne Wirkung (falscher Ausgangszustand / ungültiger Übergang)
  const r = (await one(await db.as(MANAGER), `SELECT staff_live_action($1, 'clock_in', 'WORKING', true) r`, [EMP(n)])).r
  assert.equal(r.success, false); return r.state
}
const live = async (n, action, expected) => (await one(await db.as(MANAGER), `SELECT staff_live_action($1, $2, $3, true) r`, [EMP(n), action, expected])).r
const entryOf = id => one(db.sys, `SELECT clock_in, clock_out, hours_worked::float h, break_minutes, notes, approved, date::text FROM time_entries WHERE id = $1`, [id])
const stateJson = async id => (await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s
const cost = async () => (await one(db.sys, `SELECT _labor_cost_at(now()) r`)).r.today

before(async () => {
  db = await startDb()
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)   // Sitzungs-TZ wie Production
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
})
after(async () => { await db?.stop() })
beforeEach(() => db.sys.query(`DELETE FROM time_entries; DELETE FROM time_corrections; DELETE FROM time_live_actions; DELETE FROM payroll_months;`))

test('A: Beginn gesetzt, Ende leer → offener Eintrag; Person gilt als eingestempelt; Korrekturgrund protokolliert', async () => {
  const a = await db.as(ADMIN), s = await berlin(-120)
  const r = await save(a, { d: s.d, inT: s.t })
  assert.equal(r.success, true)
  const e = await entryOf(r.id)
  assert.deepEqual([e.clock_out, e.h, e.break_minutes, e.approved, e.date], [null, null, 0, true, s.d], 'offen, keine Stunden, Berliner Datum')
  assert.equal((await one(db.sys, `SELECT to_char(clock_in AT TIME ZONE 'Europe/Berlin', 'HH24:MI') t FROM time_entries WHERE id = $1`, [r.id])).t, s.t, 'Beginn = eingegebene Berliner Uhrzeit')
  assert.match(e.notes, /^\[ADMIN-KORREKTUR\]/)
  const corr = await one(db.sys, `SELECT field_changed, reason, corrected_by, new_value FROM time_corrections WHERE time_entry_id = $1`, [r.id])
  assert.deepEqual([corr.field_changed, corr.reason, corr.corrected_by], ['new_entry', 'Mitarbeiter konnte nicht einstempeln', U(ADMIN)])
  assert.equal(await state(E1), 'WORKING', 'Live-Steuerung: arbeitet')
  // Normales erneutes Einstempeln (Person selbst) wird verhindert
  assert.match(await err(async () => (await db.as(E1)).query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(E1)])), /bereits eingeclockt/)
  // … und stellvertretend ebenso (Zustand stimmt nicht)
  assert.deepEqual(await live(E1, 'clock_in', 'OFF_CLOCK'), { success: false, code: 'stale', state: 'WORKING' })
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entries WHERE employee_id = $1`, [EMP(E1)])).c, 1)
})

test('B: Beginn + Ende → abgeschlossener Eintrag (unverändert); C: Beginn leer → abgelehnt; D: ungültiges Ende → abgelehnt', async () => {
  const a = await db.as(ADMIN)
  const r = await save(a, { d: (await berlin(-2 * 24 * 60)).d, inT: '08:00', outT: '16:30' })
  const e = await entryOf(r.id)
  assert.ok(e.clock_out); assert.equal(e.h, 8.5)
  const d = (await berlin(-60)).d
  assert.match(await err(() => save(a, { d, inT: null })), /Einstempelzeit sind Pflicht/)
  assert.match(await err(() => save(a, { d, inT: '08:00', outT: 'abc' })), /invalid input syntax for type time/)
  assert.match(await err(() => save(a, { d, inT: 'abc' })), /invalid input syntax for type time/)
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entries`)).c, 1, 'nur der gültige Eintrag')
})

test('E: offener Eintrag mit Beginn in der Zukunft → serverseitig abgelehnt (auch 2 Minuten)', async () => {
  const a = await db.as(ADMIN)
  for (const mins of [120, 2]) {
    const s = await berlin(mins)
    const e = await err(() => save(a, { d: s.d, inT: s.t }))
    assert.match(e, /Zukunft/, `+${mins} Min`)
  }
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entries`)).c, 0)
})

test('F: bereits offener Eintrag → kein zweiter offener Eintrag (davor, danach, parallel); G: Überschneidung mit abgeschlossenem Eintrag', async () => {
  const a = await db.as(ADMIN)
  const s = await berlin(-60), earlier = await berlin(-180), later = await berlin(-30)
  await (await db.as(E1)).query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now() - interval '60 minutes')`, [EMP(E1)])
  for (const t of [earlier, later]) assert.match(await err(() => save(a, { d: t.d, inT: t.t })), /überschneiden sich/, `offen ab ${t.t}`)
  // parallel: zwei Admins legen gleichzeitig einen offenen Eintrag für E2 an → genau einer
  const p = await Promise.all([save(await db.as(ADMIN), { emp: E2, d: s.d, inT: s.t }).catch(e => e.message), save(await db.as(ADMIN), { emp: E2, d: earlier.d, inT: earlier.t }).catch(e => e.message)])
  assert.equal(p.filter(x => x?.success).length, 1, JSON.stringify(p))
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(E2)])).c, 1)
  // G: abgeschlossener Eintrag 4 h bis 1 h vorher; offener Beginn 2 h vorher überschneidet
  await db.sys.query(`DELETE FROM time_entries WHERE employee_id = $1`, [EMP(E2)])
  const c4 = await berlin(-240), c1 = await berlin(-60), o2 = await berlin(-120)
  const closed = await save(a, { emp: E2, d: c4.d, inT: c4.t, outT: c1.t })
  assert.equal(closed.success, true)
  assert.match(await err(() => save(a, { emp: E2, d: o2.d, inT: o2.t })), /überschneiden sich/)
  const after0 = await berlin(-30)
  assert.equal((await save(a, { emp: E2, d: after0.d, inT: after0.t })).success, true, 'offen nach dem Ende → erlaubt')
})

test('Lohnmonat abgeschlossen → offener Eintrag abgelehnt', async () => {
  const s = await berlin(-60)
  const [y, m] = s.d.split('-').map(Number)
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month, is_finalized) VALUES ($1, $2, $3, true)`, [EMP(E1), y, m])
  assert.match(await err(async () => save(await db.as(ADMIN), { d: s.d, inT: s.t })), /Lohnmonat .* abgeschlossen/)
})

test('H: offener Eintrag mit Pause; Pause in der Zukunft / außerhalb → abgelehnt; spätere Korrektur, die die Pause ausschließt → abgelehnt', async () => {
  const a = await db.as(ADMIN)
  const s = await berlin(-180), bs = await berlin(-120), be = await berlin(-100), fut = await berlin(30)
  assert.match(await err(() => save(a, { d: s.d, inT: s.t, breaks: [{ start: bs.t, end: fut.t }] })), /außerhalb der Arbeitszeit/, 'Pausenende in der Zukunft')
  const r = await save(a, { d: s.d, inT: s.t, breaks: [{ start: bs.t, end: be.t }] })
  assert.equal(r.success, true)
  const exp = await stateJson(r.id)
  // Beginn auf nach der Pause verschieben → Pause läge vor Arbeitsbeginn → abgelehnt, nichts verändert
  const late = await berlin(-90)
  assert.match(await err(() => save(a, { id: r.id, emp: E1, d: late.d, inT: late.t, breaks: [{ start: bs.t, end: be.t }], expected: exp })), /außerhalb der Arbeitszeit|Ende muss nach dem Beginn/)
  assert.deepEqual(await stateJson(r.id), exp, 'unverändert')
})

test('I/J/K: offener Admin-Eintrag → Pause (selbst) → Pause (Live-Steuerung) → Ausstempeln; Zustände korrekt', async () => {
  const a = await db.as(ADMIN), s = await berlin(-180)
  const r = await save(a, { d: s.d, inT: s.t })
  const me = await db.as(E1)
  // J: Pause selbst starten/beenden
  await me.query(`SELECT * FROM start_break()`)
  assert.equal(await state(E1), 'ON_BREAK')
  await me.query(`SELECT * FROM end_break()`)
  assert.equal(await state(E1), 'WORKING')
  // K: Manager-Live-Steuerung erkennt und führt Pause durch
  assert.equal((await live(E1, 'break_start', 'WORKING')).state, 'ON_BREAK')
  assert.equal((await live(E1, 'break_end', 'ON_BREAK')).state, 'WORKING')
  // I: normal ausstempeln (selbst)
  await me.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [r.id])
  const e = await entryOf(r.id)
  assert.ok(e.clock_out && e.h >= 2.9 && e.h <= 3.05, `Stunden berechnet: ${e.h}`)   // Beginn auf volle Minute, Pausen nur Sekunden
  assert.equal(await state(E1), 'OFF_CLOCK')
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`, [r.id])).c, 0)
})

test('K: Manager beendet den offenen Admin-Eintrag über die Live-Steuerung; danach spätere Korrektur mit Protokoll', async () => {
  const a = await db.as(ADMIN), s = await berlin(-150)
  const r = await save(a, { d: s.d, inT: s.t })
  const out = await live(E1, 'clock_out', 'WORKING')
  assert.deepEqual([out.success, out.state, out.entry_id], [true, 'OFF_CLOCK', r.id])
  const e = await entryOf(r.id)
  assert.ok(e.clock_out && e.h > 2 && e.h <= 2.6)
  // 8: spätere Zeitkorrektur funktioniert (Ende 30 Min früher), Protokoll new_entry + manual_edit
  const end = await berlin(-30)
  const c = await save(a, { id: r.id, emp: E1, d: s.d, inT: s.t, outT: end.t, reason: 'Ende korrigiert', expected: await stateJson(r.id) })
  assert.equal(c.success, true)
  assert.deepEqual((await rows(db.sys, `SELECT field_changed, reason FROM time_corrections WHERE time_entry_id = $1 ORDER BY created_at`, [r.id])).map(x => [x.field_changed, x.reason]),
    [['new_entry', 'Mitarbeiter konnte nicht einstempeln'], ['manual_edit', 'Ende korrigiert']])
})

test('L: Live-Personalkosten zählen den offenen Admin-Eintrag als laufend (auch in der Pause korrekt)', async () => {
  const before0 = await cost()
  const a = await db.as(ADMIN), s = await berlin(-60)
  // Beginn kann (kurz nach Mitternacht) am Vortag liegen – gezählt wird nur der Teil des heutigen Berliner Tags
  const r = await save(a, { d: s.d, inT: s.t })
  const t = await cost()
  assert.equal(t.running - before0.running, 1, 'läuft')
  const sinceDay = (await one(db.sys, `SELECT EXTRACT(EPOCH FROM now() - GREATEST(clock_in, date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'))::float s FROM time_entries WHERE id = $1`, [r.id])).s
  assert.ok(Math.abs((t.net_seconds - before0.net_seconds) - sinceDay) < 5, `heute geleistet ≈ ${sinceDay}s, gezählt ${t.net_seconds - before0.net_seconds}s`)
  assert.ok(t.cost > before0.cost, 'Kosten steigen (Stundenlohn)')
  await (await db.as(E1)).query(`SELECT * FROM start_break()`)
  assert.equal((await cost()).on_break - before0.on_break, 1, 'in der Pause erkannt')
})
