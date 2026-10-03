// Admin-Zeitkorrektur atomar (Migration 27): Eintrag + Pausen + Stunden + Korrekturprotokoll in einer Transaktion,
// veraltete Ansicht → Abbruch, Schichten über Mitternacht, Sommer-/Winterzeit (Europe/Berlin), keine Kollision mit
// laufender Schicht. Dazu: Personalnummer (H3) und Offboarding-Übersicht (M7).
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, U, EMP, day } from './harness.mjs'
import { timeEntryState, berlinTime, correctionPlan } from '../../src/lib/workHours.js'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const count = async (sql, p) => (await one(db.sys, sql, p)).n
const SAVE = `SELECT admin_save_time_entry($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) v`
const save = async (c, { id = null, emp = EMP(E1), date, inT, outT, breaks = [], breakMin = null, notes = '', reason = 'Korrektur', expected = null }) =>
  (await one(c, SAVE, [id, emp, date, inT, outT, JSON.stringify(breaks), breakMin, notes, reason, expected])).v
const state = async id => (await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s
const entry = async id => one(db.sys, `SELECT date::text d, clock_in, clock_out, break_minutes, hours_worked::float h, notes FROM time_entries WHERE id = $1`, [id])
const berlin = async ts => (await one(db.sys, `SELECT to_char($1::timestamptz AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') t`, [ts])).t
const breaksOf = async id => (await db.sys.query(`SELECT to_char(break_start AT TIME ZONE 'Europe/Berlin', 'DD HH24:MI') s, to_char(break_end AT TIME ZONE 'Europe/Berlin', 'DD HH24:MI') e FROM time_entry_breaks WHERE time_entry_id = $1 ORDER BY break_start`, [id])).rows

before(async () => {
  db = await startDb()
  // Wie Production (read-only geprüft): Sitzungs-Zeitzone UTC – die Berlin-Umrechnung darf nicht davon abhängen
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
})
after(async () => { await db?.stop() })

test('Nur Admin: Mitarbeiter/Manager/anonym dürfen weder anlegen noch korrigieren noch löschen', async () => {
  for (const n of [E1, MANAGER]) {
    const c = await db.session(n)
    assert.match(await err(async () => save(c, { date: day(-2), inT: '08:00', outT: '16:00' })), /Nicht autorisiert/)
    assert.match(await err(() => c.query(`SELECT admin_delete_time_entry(gen_random_uuid(), 'x', '{}'::jsonb)`)), /Nicht autorisiert/)
  }
  assert.match(await err(async () => (await db.anon()).query(SAVE, [null, EMP(E1), day(-2), '08:00', '16:00', '[]', null, '', 'x', null])), /permission denied/)
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries`), 0)
})

test('Normale Schicht: Stunden = Anwesenheit − Pausen (serverseitig), Protokoll im selben Schritt', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-3), inT: '08:00', outT: '16:30', breaks: [{ start: '12:00', end: '12:30' }], notes: 'nachgetragen', reason: 'Stempeluhr defekt' })
  const e = await entry(r.id)
  assert.deepEqual([e.d, e.h, e.break_minutes, e.notes], [day(-3), 8, 30, '[ADMIN-KORREKTUR] nachgetragen'])
  assert.equal(await berlin(e.clock_in), `${day(-3)} 08:00`)
  const log = await one(db.sys, `SELECT field_changed, corrected_by, reason, new_value FROM time_corrections WHERE time_entry_id = $1`, [r.id])
  assert.deepEqual([log.field_changed, log.corrected_by, log.reason], ['new_entry', U(ADMIN), 'Stempeluhr defekt'])
  assert.match(log.new_value, /08:00 – 16:30 \| Pausen: 12:00–12:30/)
  // Neue Einträge: keine pauschalen Pausenminuten mehr (Migration 34) – Altbestand: tests/db/break_hardening
  assert.match(await err(async () => save(a, { date: day(-4), inT: '09:00', outT: '13:00', breakMin: 15 })), /Pauschale Pausenminuten/)
})

test('Über Mitternacht: Zeiten vor der Einstempelzeit gehören zum Folgetag – Ende, Pausen, Stunden, Datum eindeutig', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-6), inT: '22:00', outT: '06:00', breaks: [{ start: '23:30', end: '23:45' }, { start: '01:00', end: '01:30' }] })
  const e = await entry(r.id)
  assert.equal(e.d, day(-6), 'Datum = Tag des Einstempelns')
  assert.equal(await berlin(e.clock_out), `${day(-5)} 06:00`)
  assert.deepEqual([e.h, e.break_minutes], [7.25, 45])
  assert.deepEqual((await breaksOf(r.id)).map(b => [b.s.slice(3), b.e.slice(3)]), [['23:30', '23:45'], ['01:00', '01:30']])
  assert.equal((await breaksOf(r.id))[1].s.slice(0, 2), day(-5).slice(8), 'Pause nach Mitternacht am Folgetag')
  // Korrigieren (Rundreise wie die UI) ohne Änderung der Tagesgrenze
  const r2 = await save(a, { id: r.id, date: day(-6), inT: '21:30', outT: '05:30', breaks: [{ start: '01:00', end: '01:30' }], expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes], [7.5, 30])
  assert.equal(r2.id, r.id)
  // Gleiche Zeit ist keine 24-h-Schicht, sondern ein Fehler
  assert.match(await err(async () => save(a, { date: day(-7), inT: '08:00', outT: '08:00' })), /nicht gleich/)
  // Pause außerhalb der Schicht (nach Schichtende am Folgetag)
  assert.match(await err(async () => save(a, { date: day(-7), inT: '22:00', outT: '02:00', breaks: [{ start: '02:30', end: '03:00' }] })), /außerhalb der Arbeitszeit/)
})

test('Sommer-/Winterzeit: Nachtschichten über die Umstellung zählen echte Stunden (Europe/Berlin)', async () => {
  const a = await db.session(ADMIN)
  const fall = await save(a, { date: '2026-10-24', inT: '22:00', outT: '06:00' })     // Uhr 03:00 → 02:00
  const spring = await save(a, { date: '2026-03-28', inT: '22:00', outT: '06:00' })   // Uhr 02:00 → 03:00
  const normal = await save(a, { date: '2026-06-13', inT: '22:00', outT: '06:00' })
  assert.deepEqual([(await entry(fall.id)).h, (await entry(spring.id)).h, (await entry(normal.id)).h], [9, 7, 8])
})

test('Atomar: jeder Fehler (ungültige Pause, Protokoll-Fehler) hinterlässt Eintrag, Pausen und Protokoll unverändert', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-8), inT: '08:00', outT: '16:00', breaks: [{ start: '12:00', end: '12:30' }] })
  const snap = async () => JSON.stringify([await entry(r.id), await breaksOf(r.id), await count(`SELECT count(*)::int n FROM time_corrections WHERE time_entry_id = $1`, [r.id])])
  const s0 = await snap()
  assert.match(await err(async () => save(a, { id: r.id, date: day(-8), inT: '08:00', outT: '15:00', breaks: [{ start: '12:00', end: '12:30' }, { start: '12:15', end: '12:45' }], expected: await state(r.id) })), /überschneiden/)
  assert.equal(await snap(), s0, 'überlappende Pausen → nichts geändert')
  assert.match(await err(async () => save(a, { id: r.id, date: day(-8), inT: '08:00', outT: '15:00', reason: '  ', expected: await state(r.id) })), /Grund/)
  assert.equal(await snap(), s0)
  await db.sys.query(`CREATE FUNCTION test_fail_corr() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulierter Protokollfehler'; END $$;
                      CREATE TRIGGER test_fail_corr BEFORE INSERT ON time_corrections FOR EACH ROW EXECUTE FUNCTION test_fail_corr();`)
  try {
    assert.match(await err(async () => save(a, { id: r.id, date: day(-8), inT: '07:00', outT: '15:00', breaks: [], expected: await state(r.id) })), /simulierter Protokollfehler/)
    assert.match(await err(async () => a.query(`SELECT admin_delete_time_entry($1, 'weg', $2)`, [r.id, await state(r.id)])), /simulierter Protokollfehler/)
  } finally { await db.sys.query(`DROP TRIGGER test_fail_corr ON time_corrections; DROP FUNCTION test_fail_corr();`) }
  assert.equal(await snap(), s0, 'Protokoll-Fehler → keine halbe Korrektur, nichts gelöscht')
})

test('Veraltete Ansicht / parallel: geänderter Eintrag (Pause, Ausstempeln, anderer Admin) → Abbruch; genau eine von zwei Korrekturen', async () => {
  const a = await db.session(ADMIN)
  // offene Schicht von E2; Admin lädt, dann startet E2 eine Pause
  const open = (await one(await db.session(E2), `INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, $2, now()) RETURNING id`, [EMP(E2), day(0)])).id
  const seen = await state(open)
  await (await db.session(E2)).query(`SELECT start_break()`)
  assert.match(await err(async () => save(a, { id: open, emp: EMP(E2), date: day(0), inT: '06:00', outT: null, expected: seen })), /inzwischen geändert/)
  assert.equal(await count(`SELECT count(*)::int n FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`, [open]), 1, 'Pause der Person bleibt')
  assert.match(await err(async () => save(a, { id: open, emp: EMP(E2), date: day(0), inT: '06:00', outT: null, expected: null })), /inzwischen geändert/, 'ohne Stand keine Korrektur')
  // zwei Admins korrigieren denselben Eintrag gleichzeitig mit demselben Ausgangsstand
  const r = await save(a, { date: day(-9), inT: '08:00', outT: '16:00' })
  const s = await state(r.id)
  const res = await Promise.all([['09:00', '16:00'], ['08:00', '17:00']].map(async ([i, o]) => err(async () => save(await db.as(ADMIN), { id: r.id, date: day(-9), inT: i, outT: o, expected: s }))))
  assert.equal(res.filter(x => x === null).length, 1, JSON.stringify(res))
  assert.equal(await count(`SELECT count(*)::int n FROM time_corrections WHERE time_entry_id = $1 AND field_changed = 'manual_edit'`, [r.id]), 1)
})

test('Laufende Schicht der Person stört nicht: vergangenen Eintrag anlegen/korrigieren; offene Schicht korrigieren bleibt offen', async () => {
  const a = await db.session(ADMIN)
  const open = (await one(db.sys, `SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(E2)])).id
  const past = await save(a, { emp: EMP(E2), date: day(-11), inT: '08:00', outT: '12:00' })
  assert.equal((await entry(past.id)).h, 4, 'anlegen trotz laufender Schicht')
  await save(a, { id: past.id, emp: EMP(E2), date: day(-11), inT: '08:00', outT: '13:00', expected: await state(past.id) })
  assert.equal((await entry(past.id)).h, 5, 'korrigieren trotz laufender Schicht')
  // offene Schicht nur Einstempelzeit korrigieren (Pause der Person ist inzwischen Teil des Stands)
  await (await db.session(E2)).query(`SELECT end_break()`)
  // Pause in die Vergangenheit legen (Ende + 1 Min. darf nicht in der Zukunft liegen – Migration 34)
  await db.sys.query(`UPDATE time_entries SET clock_in = clock_in - interval '2 hours' WHERE id = $1`, [open])
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '90 minutes', break_end = now() - interval '80 minutes' WHERE time_entry_id = $1`, [open])
  const s = await state(open)
  const brk = s.breaks[0]
  const hhmm = async sec => (await one(db.sys, `SELECT to_char(to_timestamp($1) AT TIME ZONE 'Europe/Berlin', 'HH24:MI') t`, [sec])).t
  const inT = await hhmm(s.clock_in - 3600)
  await save(a, { id: open, emp: EMP(E2), date: day(0), inT, outT: null, breaks: [{ start: await hhmm(brk[0]), end: await hhmm(brk[1] + 60) }], expected: s })
  const e = await entry(open)
  assert.deepEqual([e.clock_out, e.h], [null, null], 'bleibt offen, Stunden erst beim Ausstempeln')
  assert.match(await err(async () => save(a, { emp: EMP(E2), date: day(-1), inT: '08:00', outT: null })), /duplicate key|one_open/, 'zweite offene Schicht per Index verhindert')
})

test('Löschen: atomar mit Protokoll, veraltete Ansicht abgewiesen, doppelt → „bereits gelöscht“', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-12), inT: '08:00', outT: '16:00', breaks: [{ start: '12:00', end: '12:30' }] })
  const s = await state(r.id)
  assert.match(await err(async () => a.query(`SELECT admin_delete_time_entry($1, 'x', $2)`, [r.id, JSON.stringify({ ...s, clock_out: s.clock_out + 60 })])), /inzwischen geändert/)
  assert.match(await err(async () => a.query(`SELECT admin_delete_time_entry($1, ' ', $2)`, [r.id, s])), /Grund/)
  const d = (await one(a, `SELECT admin_delete_time_entry($1, 'doppelt erfasst', $2) v`, [r.id, s])).v
  assert.deepEqual([d.success, d.already], [true, false])
  assert.equal(await count(`SELECT count(*)::int n FROM time_entries WHERE id = $1`, [r.id]), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM time_entry_breaks WHERE time_entry_id = $1`, [r.id]), 0)
  const log = await one(db.sys, `SELECT time_entry_id, old_value, reason FROM time_corrections WHERE field_changed = 'deleted' AND reason = 'doppelt erfasst'`)
  assert.equal(log.time_entry_id, null, 'Protokoll bleibt, Verweis geleert')
  assert.match(log.old_value, /08:00 – 16:00/)
  assert.equal((await one(a, `SELECT admin_delete_time_entry($1, 'nochmal', $2) v`, [r.id, s])).v.already, true)
})

test('Personalnummer (H3): nur Ziffern, eindeutig über alle (auch Ausgeschiedene), nur Admin setzt', async () => {
  const a = await db.session(ADMIN)
  await a.query(`UPDATE employees SET personnel_number = '1001' WHERE id = $1`, [EMP(E1)])
  assert.match(await err(async () => a.query(`UPDATE employees SET personnel_number = '1001' WHERE id = $1`, [EMP(E2)])), /duplicate key|personnel_number_key/)
  await db.sys.query(`UPDATE employees SET is_active = false, end_date = $2 WHERE id = $1`, [EMP(E1), day(-1)])
  assert.match(await err(async () => a.query(`UPDATE employees SET personnel_number = '1001' WHERE id = $1`, [EMP(E2)])), /duplicate key|personnel_number_key/, 'keine Wiederverwendung nach Austritt')
  for (const bad of ['A12', '12 3', '', '12345678901']) assert.match(await err(async () => a.query(`UPDATE employees SET personnel_number = $2 WHERE id = $1`, [EMP(E2), bad])), /personnel_number_format/, bad)
  for (const n of [E2, MANAGER]) assert.equal((await (await db.session(n)).query(`UPDATE employees SET personnel_number = '2002' WHERE id = $1`, [EMP(E2)])).rowCount, 0)
  assert.equal((await one(db.sys, `SELECT personnel_number FROM employees WHERE id = $1`, [EMP(E2)])).personnel_number, null)
  await db.sys.query(`UPDATE employees SET is_active = true, end_date = NULL WHERE id = $1`, [EMP(E1)])
})

test('Offboarding-Übersicht (M7): nur Admin, zählt offene Punkte, ändert nichts', async () => {
  await db.sys.query(`INSERT INTO shifts (employee_id, date, start_time, end_time) VALUES ($1, $2, '08:00', '16:00'), ($1, $3, '08:00', '16:00'), ($1, $4, '08:00', '16:00')`, [EMP(E1), day(3), day(9), day(-3)])
  await db.sys.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, status) VALUES ($1, $2, $3, 5, 'pending'), ($1, $4, $5, 5, 'approved')`, [EMP(E1), day(30), day(36), day(40), day(46)])
  await db.sys.query(`INSERT INTO sick_leave (employee_id, start_date, days_count) VALUES ($1, $2, 1)`, [EMP(E1), day(-1)])
  const shift = (await one(db.sys, `SELECT id FROM shifts WHERE employee_id = $1 AND date = $2`, [EMP(E1), day(3)])).id
  await db.sys.query(`INSERT INTO shift_swap_requests (requester_id, requester_shift_id, target_id, status) VALUES ($1, $2, $3, 'open')`, [EMP(E1), shift, EMP(E2)])
  for (const n of [E1, MANAGER]) assert.match(await err(async () => (await db.session(n)).query(`SELECT admin_offboarding_check($1)`, [EMP(E1)])), /Nicht autorisiert/)
  const before1 = await count(`SELECT (SELECT count(*) FROM shifts) + (SELECT count(*) FROM vacation_requests) + (SELECT count(*) FROM shift_swap_requests)::int n`)
  const c = (await one(await db.session(ADMIN), `SELECT admin_offboarding_check($1) v`, [EMP(E1)])).v
  assert.deepEqual([c.future_shifts, c.next_shift, c.open_swaps, c.pending_vacation, c.future_vacation, c.open_sick_leave, c.open_time_entry],
                   [2, day(3), 1, 1, 1, 1, false])
  assert.equal(await count(`SELECT (SELECT count(*) FROM shifts) + (SELECT count(*) FROM vacation_requests) + (SELECT count(*) FROM shift_swap_requests)::int n`), before1, 'nichts gelöscht/abgelehnt')
})

test('Frontend ↔ DB: timeEntryState() = _time_entry_state(); Rundreise der UI (Berlin-Zeit laden → speichern) ändert nichts; Vorschau = DB-Stunden', async () => {
  const a = await db.session(ADMIN)
  for (const [date, inT, outT, breaks] of [[day(-20), '08:00', '16:30', [{ start: '12:00', end: '12:30' }]], [day(-21), '22:00', '06:00', [{ start: '01:00', end: '01:20' }]], ['2026-10-24', '21:00', '05:00', []]]) {
    const r = await save(a, { date, inT, outT, breaks })
    const e = await one(db.sys, `SELECT * FROM time_entries WHERE id = $1`, [r.id])
    const b = (await db.sys.query(`SELECT break_start, break_end FROM time_entry_breaks WHERE time_entry_id = $1`, [r.id])).rows
    assert.deepEqual(timeEntryState(e, b), await state(r.id), `${date} ${inT}: Browser-Stand = DB-Stand`)
    // UI lädt Werte in Berlin-Zeit und speichert unverändert → identische Zeiten/Stunden
    const form = { inT: berlinTime(e.clock_in), outT: berlinTime(e.clock_out), breaks: b.map(x => ({ start: berlinTime(x.break_start), end: berlinTime(x.break_end) })) }
    assert.deepEqual([form.inT, form.outT], [inT, outT])
    const before1 = await state(r.id), h1 = (await entry(r.id)).h
    await save(a, { id: r.id, date: e.date instanceof Date ? date : e.date, inT: form.inT, outT: form.outT, breaks: form.breaks, expected: timeEntryState(e, b) })
    assert.deepEqual(await state(r.id), before1, 'Rundreise ohne Änderung')
    assert.equal((await entry(r.id)).h, h1)
    if (date !== '2026-10-24') assert.equal(Math.round(correctionPlan(form).hours * 100) / 100, h1, 'Vorschau = DB (2 Nachkommastellen, außerhalb der Zeitumstellung)')
  }
})
