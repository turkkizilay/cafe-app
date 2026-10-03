// Migration 34: Pausen + Zeitkorrektur serverseitig gehärtet (Audit C1–C7). Netto = Arbeitsintervall − erfasste
// Pausenintervalle, nur serverseitig; kein Weg an den Prüfungen vorbei; Altbestand unverändert; Lohn/DATEV-Grundlage
// vor und nach der Migration identisch.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, EMP, day, MIGRATIONS, migration } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2, E3, E4] = [1, 2, 3, 4, 5, 6]
let db
const SAVE = `SELECT admin_save_time_entry($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) v`
const save = async (c, { id = null, emp = EMP(E1), date, inT, outT, breaks = [], breakMin = null, reason = 'Korrektur', expected = null }) =>
  (await one(c, SAVE, [id, emp, date, inT, outT, JSON.stringify(breaks), breakMin, '', reason, expected])).v
const state = async id => (await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s
const entry = id => one(db.sys, `SELECT employee_id, date::text d, clock_in, clock_out, break_minutes, hours_worked::float h, notes FROM time_entries WHERE id = $1`, [id])
const breaksOf = async id => (await rows(db.sys, `SELECT to_char(break_start AT TIME ZONE 'Europe/Berlin', 'HH24:MI') s, to_char(break_end AT TIME ZONE 'Europe/Berlin', 'HH24:MI') e, closed_by FROM time_entry_breaks WHERE time_entry_id = $1 ORDER BY break_start`, [id])).map(b => `${b.s}-${b.e}`)
const corrections = async id => (await one(db.sys, `SELECT count(*)::int n FROM time_corrections WHERE time_entry_id = $1`, [id])).n
const snap = async id => JSON.stringify([await entry(id), await breaksOf(id), await corrections(id)])
const closeAll = () => db.sys.query(`UPDATE time_entries SET clock_out = clock_in + interval '1 hour', hours_worked = 1, break_minutes = 0 WHERE clock_out IS NULL`)
async function clockedIn(n, hoursAgo) {
  const c = await db.as(n)
  const { id } = await one(c, `INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now()) RETURNING id`, [EMP(n)])
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - make_interval(secs => $2::float8 * 3600) WHERE id = $1`, [id, hoursAgo])
  return { c, id }
}
// Altbestand: pauschale Minuten ohne Pausenzeilen (wie vor Migration 17), direkt im Systemkontext angelegt
const legacy = async (date, inH, outH, breakMin, emp = E1) => (await one(db.sys, `
  INSERT INTO time_entries (employee_id, date, clock_in, clock_out, break_minutes, hours_worked, approved)
  VALUES ($1, $2::date, ($2::date + make_interval(hours => $3)) AT TIME ZONE 'Europe/Berlin', ($2::date + make_interval(hours => $4)) AT TIME ZONE 'Europe/Berlin',
          $5::int, ROUND(($4 - $3) - $5::int / 60.0, 2), true) RETURNING id`, [EMP(emp), date, inH, outH, breakMin])).id

before(async () => {
  db = await startDb()
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)   // wie Production
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee'], [E3, 'employee'], [E4, 'employee']])
})
after(async () => { await db?.stop() })

test('Netto aus Intervallen: keine / eine / mehrere Pausen; Pause hinzufügen, bearbeiten, löschen – je mit Protokoll', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-30), inT: '10:00', outT: '18:00' })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes], [8, 0], 'keine Pause')
  await save(a, { id: r.id, date: day(-30), inT: '10:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:30' }], expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes], [7.5, 30], 'Pause hinzugefügt')
  await save(a, { id: r.id, date: day(-30), inT: '10:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:45' }, { start: '16:00', end: '16:15' }], expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes, await breaksOf(r.id)], [7, 60, ['13:00-13:45', '16:00-16:15']], 'bearbeitet + zweite')
  await save(a, { id: r.id, date: day(-30), inT: '10:00', outT: '18:00', breaks: [{ start: '16:00', end: '16:15' }], expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes, await breaksOf(r.id)], [7.75, 15, ['16:00-16:15']], 'versehentliche Pause gelöscht')
  await save(a, { id: r.id, date: day(-30), inT: '10:00', outT: '18:00', breaks: [], expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes, await breaksOf(r.id)], [8, 0, []], 'alle Pausen gelöscht')
  assert.equal(await corrections(r.id), 5, 'jede Änderung protokolliert (wer/was/vorher/nachher/Grund)')
  const log = await one(db.sys, `SELECT old_value, new_value FROM time_corrections WHERE time_entry_id = $1 ORDER BY created_at DESC, id LIMIT 1`, [r.id])
  assert.ok(log.old_value.includes('Pausen: 16:00–16:15') && !log.new_value.includes('Pausen'), JSON.stringify(log))
})

test('Ungültige Pausen werden serverseitig abgelehnt (RPC und Guard), nichts wird geändert', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-31), inT: '09:00', outT: '17:00', breaks: [{ start: '12:00', end: '12:30' }] })
  const s0 = await snap(r.id)
  const cases = [
    ['vor Clock-In', [{ start: '08:30', end: '09:30' }], /Pause 1 \(08:30–09:30\) liegt außerhalb der Arbeitszeit \(09:00 – 17:00\)/],
    ['nach Clock-Out', [{ start: '16:45', end: '17:15' }], /außerhalb der Arbeitszeit/],
    ['vollständig außerhalb', [{ start: '18:00', end: '18:30' }], /außerhalb der Arbeitszeit/],
    ['überlappend', [{ start: '12:00', end: '12:30' }, { start: '12:15', end: '12:45' }], /überschneiden/],
    ['doppelt', [{ start: '12:00', end: '12:30' }, { start: '12:00', end: '12:30' }], /überschneiden/],
    ['negativ', [{ start: '12:30', end: '12:00' }], /Ende muss nach dem Beginn/],
    ['0 Minuten', [{ start: '12:00', end: '12:00' }], /Ende muss nach dem Beginn/],
    ['offen bei beendeter Schicht', [{ start: '12:00', end: null }], /Bitte ein Ende angeben/],
    ['ohne Beginn', [{ start: '', end: '12:00' }], /Beginn/],
  ]
  for (const [name, breaks, re] of cases) {
    assert.match(await err(async () => save(a, { id: r.id, date: day(-31), inT: '09:00', outT: '17:00', breaks, expected: await state(r.id) })), re, name)
    assert.equal(await snap(r.id), s0, `${name}: nichts geändert`)
  }
  // Guard gilt für jeden Schreibweg (hier Systemkontext): teilweise außerhalb, negativ, Überschneidung, zweite offene Pause
  const ins = (s, e) => db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end) SELECT id, employee_id, clock_in + $2::interval, clock_in + $3::interval FROM time_entries WHERE id = $1`, [r.id, s, e])
  assert.match(await err(() => ins('-10 minutes', '20 minutes')), /vor dem Einclocken/)
  assert.match(await err(() => ins('7 hours 50 minutes', '8 hours 10 minutes')), /vor dem Ausclocken/)
  assert.match(await err(() => ins('2 hours', '1 hour')), /nach dem Pausenbeginn/)
  assert.match(await err(() => ins('3 hours 10 minutes', '3 hours 20 minutes')), /überschneiden/)
  const { id } = await clockedIn(E3, 3)
  await (await db.as(E3)).query(`SELECT start_break()`)
  assert.match(await err(() => db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start) VALUES ($1, $2, now() - interval '2 hours')`, [id, EMP(E3)])), /überschneiden/, 'zweite offene Pause')
  await db.sys.query('BEGIN'); await db.sys.query('SET LOCAL session_replication_role = replica')
  const idx = await err(() => db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start) VALUES ($1, $2, now() - interval '2 hours')`, [id, EMP(E3)]))
  await db.sys.query('ROLLBACK')
  assert.match(idx, /duplicate key|unique/i, 'Unique-Index hält auch ohne Trigger')
  await closeAll()
})

test('Zeitkorrektur verschiebt Arbeitszeit über Pausen → klar blockiert (welche Pause), nie still verschoben/gelöscht', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-32), inT: '10:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:30' }] })
  const s0 = await snap(r.id)
  const keep = [{ start: '13:00', end: '13:30' }]
  await save(a, { id: r.id, date: day(-32), inT: '11:00', outT: '18:00', breaks: keep, expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, await breaksOf(r.id)], [6.5, ['13:00-13:30']], 'Beginn 11:00: Pause bleibt, Netto neu')
  const s1 = await snap(r.id)
  for (const [inT, outT, name] of [['14:00', '18:00', 'Beginn hinter Pause'], ['11:00', '12:45', 'Ende vor Pause'], ['11:00', '13:15', 'Ende mitten in Pause']]) {
    const m = await err(async () => save(a, { id: r.id, date: day(-32), inT, outT, breaks: keep, expected: await state(r.id) }))
    assert.match(m, new RegExp(`Pause 1 \\(13:00–13:30\\) liegt außerhalb der Arbeitszeit \\(${inT} – ${outT}\\)\\. Bitte diese Pause zuerst anpassen oder löschen`), name)
    assert.equal(await snap(r.id), s1, `${name}: nichts geändert`)
  }
  assert.notEqual(s0, s1)
  // Schritt für Schritt wie verlangt: erst Pause anpassen, dann Zeit → erlaubt
  await save(a, { id: r.id, date: day(-32), inT: '14:00', outT: '18:00', breaks: [{ start: '15:00', end: '15:30' }], expected: await state(r.id) })
  assert.deepEqual([(await entry(r.id)).h, await breaksOf(r.id)], [3.5, ['15:00-15:30']])
  // mehrere Pausen + Zeitkorrektur: die zweite (außerhalb) wird benannt
  const m = await err(async () => save(a, { id: r.id, date: day(-32), inT: '14:00', outT: '16:00', breaks: [{ start: '15:00', end: '15:30' }, { start: '16:30', end: '16:45' }], expected: await state(r.id) }))
  assert.match(m, /Pause 2 \(16:30–16:45\)/)
})

test('Mitternacht: Schicht und Pause über Mitternacht', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-33), inT: '22:00', outT: '06:00', breaks: [{ start: '23:45', end: '00:15' }, { start: '03:00', end: '03:10' }] })
  assert.deepEqual([(await entry(r.id)).h, (await entry(r.id)).break_minutes], [7.33, 40])
  assert.match(await err(async () => save(a, { id: r.id, date: day(-33), inT: '22:00', outT: '02:00', breaks: [{ start: '23:45', end: '00:15' }, { start: '03:00', end: '03:10' }], expected: await state(r.id) })), /Pause 2 \(03:00–03:10\)/)
})

test('C1: keine direkten Tabellenwege – Admin, Manager, Mitarbeiter, anonym', async () => {
  const a = await db.as(ADMIN), m = await db.as(MANAGER), e = await db.as(E1), anon = await db.anon()
  const r = await save(await db.session(ADMIN), { emp: EMP(E2), date: day(-34), inT: '10:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:30' }] })
  const s0 = await snap(r.id)
  for (const [who, c] of [['Admin', a], ['Manager', m], ['Mitarbeiter', e]]) {
    assert.match(await err(() => c.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end) SELECT id, employee_id, clock_in + interval '6 hours', clock_in + interval '7 hours' FROM time_entries WHERE id = $1`, [r.id])), /permission denied/, `${who}: Pause einfügen`)
    assert.match(await err(() => c.query(`UPDATE time_entry_breaks SET break_end = break_end + interval '1 hour' WHERE time_entry_id = $1`, [r.id])), /permission denied/, `${who}: Pause ändern`)
    assert.match(await err(() => c.query(`DELETE FROM time_entry_breaks WHERE time_entry_id = $1`, [r.id])), /permission denied/, `${who}: Pause löschen`)
    assert.match(await err(() => c.query(`DELETE FROM time_entries WHERE id = $1`, [r.id])), /permission denied/, `${who}: Eintrag löschen`)
    assert.match(await err(() => c.query(`TRUNCATE time_entry_breaks`)), /permission denied/, `${who}: truncate`)
    assert.match(await err(() => c.query(`INSERT INTO time_corrections (time_entry_id, employee_id, field_changed, reason) VALUES ($1, $2, 'x', 'gefälscht')`, [r.id, EMP(E2)])), /permission denied/, `${who}: Protokoll fälschen`)
    for (const set of [`hours_worked = 99`, `clock_in = clock_in + interval '4 hours'`, `break_minutes = 0`, `employee_id = '${EMP(E1)}'`])
      assert.equal((await c.query(`UPDATE time_entries SET ${set} WHERE id = $1`, [r.id])).rowCount, 0, `${who}: ${set}`)
  }
  assert.match(await err(() => anon.query(`UPDATE time_entries SET hours_worked = 1`)), /permission denied/)
  assert.match(await err(() => anon.query(`SELECT start_break()`)), /permission denied/)
  assert.match(await err(() => a.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, now() - interval '3 hours', now(), 3)`, [EMP(E2), day(0)])), /andere Personen/, 'Admin legt keinen fremden Eintrag direkt an')
  for (const fn of ['_payroll_month_locked(gen_random_uuid(), current_date)', 'time_entry_consistency_check()'])
    assert.match(await err(() => a.query(`SELECT ${fn}`)), /permission denied|trigger functions can only be called/, fn)
  assert.equal(await snap(r.id), s0, 'nichts geändert')
  // Auch eine (künftige, fehlerhafte) SECURITY-DEFINER-Funktion kann keine inkonsistenten Werte festschreiben
  await db.sys.query(`CREATE FUNCTION test_bad_write(p uuid, k text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
    BEGIN
      PERFORM set_config('cafe.time_correction', 'on', true);
      IF k = 'hours' THEN UPDATE time_entries SET hours_worked = 1 WHERE id = p;
      ELSIF k = 'breakmin' THEN UPDATE time_entries SET break_minutes = 5, hours_worked = 7.92 WHERE id = p;
      ELSIF k = 'clockin' THEN UPDATE time_entries SET clock_in = clock_in + interval '4 hours', hours_worked = 3.5 WHERE id = p;
      ELSIF k = 'breakdel' THEN DELETE FROM time_entry_breaks WHERE time_entry_id = p;
      END IF;
    END $$; GRANT EXECUTE ON FUNCTION test_bad_write(uuid, text) TO authenticated;`)
  try {
    const c = await db.as(ADMIN)
    assert.match(await err(() => c.query(`SELECT test_bad_write($1, 'hours')`, [r.id])), /Nettoarbeitszeit stimmt nicht/)
    assert.match(await err(() => c.query(`SELECT test_bad_write($1, 'breakmin')`, [r.id])), /Pausenminuten stimmen nicht/)
    assert.match(await err(() => c.query(`SELECT test_bad_write($1, 'clockin')`, [r.id])), /Die Pause .* liegt außerhalb der Arbeitszeit/)
    assert.match(await err(() => c.query(`SELECT test_bad_write($1, 'breakdel')`, [r.id])), /Pausenminuten stimmen nicht/)
  } finally { await db.sys.query(`DROP FUNCTION test_bad_write(uuid, text)`) }
  assert.equal(await snap(r.id), s0, 'Konsistenzprüfung am Transaktionsende → nichts geändert')
})

test('C2: laufende Schicht – Pause/Arbeitsbeginn in der Zukunft abgelehnt; Ausstempeln bleibt möglich', async () => {
  await closeAll()
  const a = await db.session(ADMIN)
  const { c, id } = await clockedIn(E4, 3)
  const t = await one(db.sys, `SELECT (clock_in AT TIME ZONE 'Europe/Berlin')::date::text d, to_char(clock_in AT TIME ZONE 'Europe/Berlin', 'HH24:MI') i,
     to_char((clock_in - interval '60 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') before_in,
     to_char((clock_in - interval '45 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') before_in2,
     to_char((now() + interval '60 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') fut, to_char((now() + interval '75 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') fut2,
     to_char((clock_in + interval '30 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') p1, to_char((clock_in + interval '45 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') p2
     FROM time_entries WHERE id = $1`, [id])
  const s0 = await snap(id)
  assert.match(await err(async () => save(a, { id, emp: EMP(E4), date: t.d, inT: t.i, outT: null, breaks: [{ start: t.before_in, end: t.before_in2 }], expected: await state(id) })), /außerhalb der Arbeitszeit/, 'vor Arbeitsbeginn getippt (→ Folgetag)')
  assert.match(await err(async () => save(a, { id, emp: EMP(E4), date: t.d, inT: t.i, outT: null, breaks: [{ start: t.fut, end: t.fut2 }], expected: await state(id) })), /außerhalb der Arbeitszeit/, 'Pause in der Zukunft')
  assert.match(await err(async () => save(a, { id, emp: EMP(E4), date: t.d, inT: t.fut, outT: null, expected: await state(id) })), /nicht in der Zukunft beginnen/, 'Arbeitsbeginn in der Zukunft')
  assert.equal(await snap(id), s0)
  assert.match(await err(() => db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start) VALUES ($1, $2, now() + interval '1 hour')`, [id, EMP(E4)])), /Zukunft/, 'Guard')
  await save(a, { id, emp: EMP(E4), date: t.d, inT: t.i, outT: null, breaks: [{ start: t.p1, end: t.p2 }], expected: await state(id) })
  await c.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [id])
  const e = await entry(id)
  assert.ok(e.clock_out && e.break_minutes === 15, 'Mitarbeiter stempelt normal aus')
})

test('C3: abgeschlossener Lohnmonat – Korrektur, Verschieben, Neuanlage, Löschen gesperrt; nach Wiederöffnen erlaubt', async () => {
  const a = await db.session(ADMIN)
  const d = day(-120), dOther = day(-60)
  const r = await save(a, { date: d, inT: '10:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:30' }] })
  const free = await save(a, { date: dOther, inT: '10:00', outT: '14:00' })
  const ym = async x => one(db.sys, `SELECT EXTRACT(YEAR FROM $1::date)::int y, EXTRACT(MONTH FROM $1::date)::int m`, [x])
  const { y, m } = await ym(d)
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month, actual_hours, is_finalized) VALUES ($1, $2, $3, 7.5, true)`, [EMP(E1), y, m])
  const s0 = await snap(r.id), f0 = await snap(free.id)
  assert.match(await err(async () => save(a, { id: r.id, date: d, inT: '10:00', outT: '14:00', expected: await state(r.id) })), /Lohnmonat .* abgeschlossen/, 'Zeit ändern')
  assert.match(await err(async () => save(a, { id: r.id, date: d, inT: '10:00', outT: '18:00', breaks: [], expected: await state(r.id) })), /abgeschlossen/, 'Pause löschen')
  assert.match(await err(async () => save(a, { id: free.id, date: d, inT: '10:00', outT: '14:00', expected: await state(free.id) })), /abgeschlossen/, 'in gesperrten Monat verschieben')
  assert.match(await err(async () => save(a, { date: d, inT: '06:00', outT: '08:00' })), /abgeschlossen/, 'neu anlegen')
  assert.match(await err(async () => a.query(`SELECT admin_delete_time_entry($1, 'weg', $2)`, [r.id, await state(r.id)])), /abgeschlossen/, 'löschen')
  assert.deepEqual([await snap(r.id), await snap(free.id)], [s0, f0])
  // andere Person im selben Monat: nicht gesperrt (Abschluss gilt je Person)
  await save(a, { emp: EMP(E2), date: d, inT: '06:00', outT: '08:00' })
  // „Monat wieder öffnen“ (bestehendes Modell) → Korrektur wieder möglich
  await db.sys.query(`UPDATE payroll_months SET is_finalized = false WHERE employee_id = $1 AND year = $2 AND month = $3`, [EMP(E1), y, m])
  await save(a, { id: r.id, date: d, inT: '10:00', outT: '14:00', expected: await state(r.id) })
  assert.equal((await entry(r.id)).h, 4)
  // Laufende Schicht im (ungewöhnlich früh) abgeschlossenen Monat: Ausstempeln bleibt möglich (keine Zeit verlieren)
  await closeAll()
  const cur = await ym(day(0))
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month, is_finalized) VALUES ($1, $2, $3, true)`, [EMP(E3), cur.y, cur.m])
  const { c, id } = await clockedIn(E3, 2)
  await c.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [id])
  assert.equal((await entry(id)).h, 2)
  await db.sys.query(`DELETE FROM payroll_months WHERE employee_id = $1`, [EMP(E3)])
})

test('C4: neue Korrekturen nur mit Intervallen; Altbestand (nur break_minutes) bleibt lesbar/gültig; Grenzen per CHECK', async () => {
  const a = await db.session(ADMIN)
  assert.match(await err(async () => save(a, { date: day(-40), inT: '09:00', outT: '17:00', breakMin: 30 })), /Pauschale Pausenminuten/, 'neu: keine Pauschale')
  const old = await legacy(day(-41), 9, 17, 30)
  assert.deepEqual([(await entry(old)).h, (await entry(old)).break_minutes, await breaksOf(old)], [7.5, 30, []], 'Altbestand unverändert lesbar')
  // Altbestand: gleiche Pauschale beibehalten (z. B. nur Uhrzeit korrigiert) → erlaubt, Netto neu
  await save(a, { id: old, date: day(-41), inT: '08:00', outT: '17:00', breakMin: 30, expected: await state(old) })
  assert.deepEqual([(await entry(old)).h, (await entry(old)).break_minutes], [8.5, 30])
  assert.match(await err(async () => save(a, { id: old, date: day(-41), inT: '08:00', outT: '17:00', breakMin: 45, expected: await state(old) })), /Pauschale Pausenminuten/, 'Pauschale ändern')
  assert.match(await err(async () => save(a, { id: old, date: day(-41), inT: '08:00', outT: '17:00', breakMin: 30, breaks: [{ start: '12:00', end: '12:30' }], expected: await state(old) })), /Pauschale Pausenminuten/, 'Pauschale + Intervall')
  assert.match(await err(async () => save(a, { id: old, date: day(-41), inT: '08:00', outT: '08:20', breakMin: 30, expected: await state(old) })), /länger als die Arbeitszeit/, 'Pauschale > Schicht')
  // in Intervalle umwandeln → ab dann Intervalle; Pauschale danach nicht mehr möglich
  await save(a, { id: old, date: day(-41), inT: '08:00', outT: '17:00', breaks: [{ start: '12:00', end: '12:45' }], expected: await state(old) })
  assert.deepEqual([(await entry(old)).h, (await entry(old)).break_minutes, await breaksOf(old)], [8.25, 45, ['12:00-12:45']])
  assert.match(await err(async () => save(a, { id: old, date: day(-41), inT: '08:00', outT: '17:00', breakMin: 45, expected: await state(old) })), /Pauschale Pausenminuten/)
  // Pauschale entfernen (0) ist immer möglich
  const old2 = await legacy(day(-42), 9, 13, 15)
  await save(a, { id: old2, date: day(-42), inT: '09:00', outT: '13:00', breakMin: 0, expected: await state(old2) })
  assert.deepEqual([(await entry(old2)).h, (await entry(old2)).break_minutes], [4, 0])
  // CHECKs: Pausenminuten / Stunden nie länger als die Schicht – für jeden Schreibweg
  assert.match(await err(() => db.sys.query(`UPDATE time_entries SET break_minutes = 600 WHERE id = $1`, [old2])), /break_within_shift/)
  assert.match(await err(() => db.sys.query(`UPDATE time_entries SET hours_worked = 4.5 WHERE id = $1`, [old2])), /hours_within_shift/)
  assert.match(await err(() => db.sys.query(`UPDATE time_entries SET hours_worked = -1 WHERE id = $1`, [old2])), /hours_nonneg/)
})

test('C5: Admin stempelt sich selbst wie alle – Serverzeit, laufende Pause endet, > 12 h-Regel, Doppelklick', async () => {
  await closeAll()
  const c = await db.as(ADMIN)
  const r = await one(c, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked, approved) VALUES ($1, '2026-01-01', '2026-01-01T06:00:00Z', '2026-01-01T20:00:00Z', 14, true) RETURNING id, clock_in, clock_out, hours_worked, approved`, [EMP(ADMIN)])
  assert.ok(r.clock_out === null && r.hours_worked === null && r.approved === false && Math.abs(new Date(r.clock_in) - Date.now()) < 60000, 'Serverzeit statt App-Werte')
  assert.match(await err(() => c.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now())`, [EMP(ADMIN)])), /bereits eingeclockt/, 'ein offener Eintrag')
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '4 hours' WHERE id = $1`, [r.id])
  await c.query(`SELECT start_break()`)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '30 minutes' WHERE time_entry_id = $1`, [r.id])
  const res = await Promise.all([db.as(ADMIN), db.as(ADMIN)].map(async p => (await (await p).query(`UPDATE time_entries SET clock_out = now() + interval '5 hours', hours_worked = 20, break_minutes = 0 WHERE id = $1 AND clock_out IS NULL`, [r.id])).rowCount))
  assert.deepEqual(res.sort(), [0, 1], 'Doppelklick: genau ein Ausstempeln')
  const e = await entry(r.id)
  assert.ok(Math.abs(new Date(e.clock_out) - Date.now()) < 60000, 'Serverzeit (nicht +5 h)')
  assert.deepEqual([e.h, e.break_minutes, await breaksOf(r.id).then(b => b.length)], [3.5, 30, 1], 'laufende Pause endet, Netto serverseitig')
  const r2 = await one(c, `INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now()) RETURNING id`, [EMP(ADMIN)])
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '14 hours' WHERE id = $1`, [r2.id])
  await c.query(`UPDATE time_entries SET clock_out = now(), hours_worked = 14 WHERE id = $1`, [r2.id])
  const e2 = await entry(r2.id)
  assert.ok(e2.h === 0 && /AUSSTEMPELN VERGESSEN/.test(e2.notes), '> 12 h → 0 Std. + Markierung (wie bei allen)')
})

test('C6: Mitarbeiter eines bestehenden Eintrags nicht änderbar; fremder Mitarbeiter/Manager ohne Korrekturrecht', async () => {
  const a = await db.session(ADMIN)
  const r = await save(a, { emp: EMP(E1), date: day(-50), inT: '10:00', outT: '12:00' })
  const s0 = await snap(r.id)
  assert.match(await err(async () => save(a, { id: r.id, emp: EMP(E2), date: day(-50), inT: '10:00', outT: '12:00', expected: await state(r.id) })), /Mitarbeiter eines bestehenden Zeiteintrags kann nicht geändert werden/)
  assert.equal(await snap(r.id), s0)
  for (const n of [E2, MANAGER]) {
    const c = await db.as(n)
    assert.match(await err(async () => save(c, { id: r.id, emp: EMP(E1), date: day(-50), inT: '10:00', outT: '11:00', expected: await state(r.id) })), /Nicht autorisiert/)
    assert.match(await err(() => c.query(`SELECT end_break()`)), /keine Pause/)
  }
  assert.equal(await snap(r.id), s0)
})

test('C7 + Parallel: Pause starten ↔ Ausstempeln gleichzeitig, Doppelklick Pause, zwei Admins', async () => {
  await closeAll()
  const { id } = await clockedIn(E2, 2)
  const c1 = await db.as(E2), c2 = await db.as(E2)
  await c1.query('BEGIN'); await c1.query('SELECT now()')         // Ausstempel-Transaktion hat bereits begonnen
  await new Promise(r => setTimeout(r, 30))
  await c2.query(`SELECT start_break()`)                           // Pause startet danach
  await c1.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [id])
  await c1.query('COMMIT')
  const e = await entry(id)
  assert.ok(e.clock_out && e.h > 1.9, 'Ausstempeln gelingt (clock_timestamp nach Sperre)')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`, [id])).n, 0, 'keine offene Pause bleibt')
  // 10× „Pause starten“ und 10× „Pause beenden“ parallel
  const x = await clockedIn(E2, 2)
  const starts = await Promise.allSettled(Array.from({ length: 10 }, async () => (await db.as(E2)).query(`SELECT start_break()`)))
  assert.equal(starts.filter(s => s.status === 'fulfilled').length, 1)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '10 minutes' WHERE time_entry_id = $1`, [x.id])
  const ends = await Promise.allSettled(Array.from({ length: 10 }, async () => (await db.as(E2)).query(`SELECT end_break()`)))
  assert.equal(ends.filter(s => s.status === 'fulfilled').length, 1)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '40 minutes', break_end = now() - interval '30 minutes' WHERE time_entry_id = $1`, [x.id])
  // Ende ↔ Ausstempeln gleichzeitig: kein Deadlock, Pause genau einmal gezählt
  await (await db.as(E2)).query(`SELECT start_break()`)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '5 minutes' WHERE time_entry_id = $1 AND break_end IS NULL`, [x.id])
  const both = await Promise.allSettled([(await db.as(E2)).query(`SELECT end_break()`), (await db.as(E2)).query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [x.id])])
  assert.equal(both[1].status, 'fulfilled', both[1].reason?.message)
  const ex = await entry(x.id)
  assert.equal(ex.break_minutes, 15, 'beide Pausen genau einmal')
  // „Pause beenden“ (noch nicht committet) ↔ Admin-Korrektur mit dem Stand davor: Korrektur muss als veraltet scheitern,
  // statt das Pausenende still zu überschreiben (end_break sperrt zuerst den Eintrag – gleiche Reihenfolge wie alle)
  await closeAll()
  const y = await clockedIn(E2, 3)
  await (await db.as(E2)).query(`SELECT start_break()`)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '20 minutes' WHERE time_entry_id = $1`, [y.id])
  const seen = await state(y.id)
  const t = await one(db.sys, `SELECT (clock_in AT TIME ZONE 'Europe/Berlin')::date::text d, to_char(clock_in AT TIME ZONE 'Europe/Berlin', 'HH24:MI') i,
     to_char((now() - interval '20 minutes') AT TIME ZONE 'Europe/Berlin', 'HH24:MI') bs FROM time_entries WHERE id = $1`, [y.id])
  const emp = await db.as(E2)
  await emp.query('BEGIN'); await emp.query(`SELECT end_break()`)
  const adminSave = (async () => err(async () => save(await db.as(ADMIN), { id: y.id, emp: EMP(E2), date: t.d, inT: t.i, outT: null, breaks: [{ start: t.bs, end: null }], expected: seen })))()
  await new Promise(r => setTimeout(r, 150))
  await emp.query('COMMIT')
  assert.match(await adminSave, /inzwischen geändert/, 'veraltete Korrektur überschreibt das Pausenende nicht')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`, [y.id])).n, 0, 'Pause bleibt beendet')
  // zwei Admins mit demselben Stand
  const a = await db.session(ADMIN)
  const r = await save(a, { date: day(-55), inT: '08:00', outT: '16:00' })
  const s = await state(r.id)
  const res = await Promise.all([[{ start: '12:00', end: '12:30' }], [{ start: '13:00', end: '13:15' }]].map(async breaks => err(async () => save(await db.as(ADMIN), { id: r.id, date: day(-55), inT: '08:00', outT: '16:00', breaks, expected: s }))))
  assert.equal(res.filter(v => v === null).length, 1, JSON.stringify(res))
})

test('Offene Pause / Ausstempeln während Pause / keine automatische Pause', async () => {
  await closeAll()
  const { c, id } = await clockedIn(E1, 6)
  assert.match(await err(() => c.query(`SELECT end_break()`)), /keine Pause/)
  await c.query(`SELECT start_break()`)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '45 minutes' WHERE time_entry_id = $1`, [id])
  await c.query(`UPDATE time_entries SET clock_out = now(), hours_worked = 6, break_minutes = 0 WHERE id = $1`, [id])
  const e = await entry(id)
  assert.deepEqual([e.h, e.break_minutes], [5.25, 45])
  assert.equal((await one(db.sys, `SELECT closed_by FROM time_entry_breaks WHERE time_entry_id = $1`, [id])).closed_by, 'clock_out')
  const n = await clockedIn(E1, 5)
  await n.c.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [n.id])
  assert.deepEqual([(await entry(n.id)).h, (await entry(n.id)).break_minutes], [5, 0], 'keine Pause abgezogen')
})

test('Lohn-/DATEV-Grundlage: Migration 34 ändert keine bestehenden Daten (vorher = nachher)', async () => {
  const db0 = await startDb({ migrations: MIGRATIONS.slice(0, MIGRATIONS.indexOf('34_break_hardening.sql')) })   // Stand vor 34 (ohne spätere Migrationen)
  try {
    await db0.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)
    await addPeople(db0.sys, [[1, 'admin'], [3, 'employee'], [4, 'employee', { employment_type: 'werkstudent', hours_per_week: 20 }]])
    const a = await db0.session(1)
    const sv = (p) => one(a, SAVE, [null, p.emp, p.date, p.inT, p.outT, JSON.stringify(p.breaks || []), p.breakMin ?? null, '', 'Seed', null])
    await sv({ emp: EMP(3), date: '2026-08-03', inT: '09:00', outT: '17:30', breaks: [{ start: '12:00', end: '12:30' }, { start: '15:00', end: '15:10' }] })
    await sv({ emp: EMP(3), date: '2026-08-04', inT: '22:00', outT: '06:00', breaks: [{ start: '23:50', end: '00:20' }] })
    await sv({ emp: EMP(4), date: '2026-08-05', inT: '10:00', outT: '14:00', breakMin: 15 })   // Altbestand (vor Migration 34 noch möglich)
    await sv({ emp: EMP(4), date: '2026-09-01', inT: '08:00', outT: '12:00' })
    await db0.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, break_minutes, hours_worked, notes) VALUES ($1, '2026-08-06', '2026-08-06T06:00:00Z', '2026-08-06T20:00:00Z', 0, 0, '⚠️ AUSSTEMPELN VERGESSEN – Zeit bitte korrigieren (14.0 Std. offen)')`, [EMP(3)])
    await db0.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in) VALUES ($1, current_date, now() - interval '2 hours')`, [EMP(4)])
    await db0.sys.query(`INSERT INTO payroll_months (employee_id, year, month, actual_hours, is_finalized) VALUES ($1, 2026, 8, 15.33, true)`, [EMP(3)])
    // Was Payroll/DATEV lesen: time_entries (employee_id, hours_worked, date, clock_out, notes) + payroll_months; dazu alles Übrige
    const snapAll = async () => JSON.stringify(await Promise.all([
      `SELECT * FROM time_entries ORDER BY id`, `SELECT * FROM time_entry_breaks ORDER BY id`, `SELECT * FROM time_corrections ORDER BY id`, `SELECT * FROM payroll_months ORDER BY id`,
      `SELECT employee_id, to_char(date, 'YYYY-MM') ym, round(sum(coalesce(hours_worked, 0)), 2)::text h, count(*) FILTER (WHERE clock_out IS NULL OR notes LIKE '%VERGESSEN%') unresolved FROM time_entries GROUP BY 1, 2 ORDER BY 1, 2`,
    ].map(async q => (await db0.sys.query(q)).rows)))
    const before = await snapAll()
    await db0.sys.query(migration('34_break_hardening.sql'))
    assert.equal(await snapAll(), before, 'Zeit-, Pausen-, Protokoll- und Lohndaten byte-gleich')
    await db0.sys.query(migration('34_break_hardening.sql'))
    assert.equal(await snapAll(), before, 'wiederholt ausführbar, weiterhin unverändert')
    assert.match(before, /"h":"15.33"/, 'Monatssumme August (Person 3) = eingefrorener Wert')
  } finally { await db0.stop() }
})
