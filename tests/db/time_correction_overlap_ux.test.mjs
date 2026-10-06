// Zeitkorrektur-Überschneidung (06.10.2026): echte Serverfehler aus admin_save_time_entry → verständliche Meldung im
// Browser (src/lib/timeCorrectionErrors.js). Datenlage wie Production 05.10. (Fehlstempel von 5 s + zwei Blöcke),
// nur erfundene Personen. Gleichzeitig: Schutzregeln unverändert (Überschneidung, Zukunft, Lohnmonat, offenes Ende).
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, one, EMP } from './harness.mjs'
import { timeCorrectionSaveError } from '../../src/lib/timeCorrectionErrors.js'
import { setRuntimeLocale, localizeMessage } from '../../src/i18n/runtime.js'

const [ADMIN, E1] = [1, 3]
let db
const SAVE = `SELECT admin_save_time_entry($1, $2, $3, $4, $5, '[]'::jsonb, NULL, '', 'Korrektur', $6) v`
const save = async (c, { id = null, d, inT, outT, expected = null }) => (await one(c, SAVE, [id, EMP(E1), d, inT, outT, expected])).v
const fail = async fn => { try { await fn(); return null } catch (e) { return e } }
const count = async () => (await one(db.sys, `SELECT count(*)::int n FROM time_entries`)).n
const berlin = async minutes => one(db.sys, `SELECT to_char(t AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') d, to_char(t AT TIME ZONE 'Europe/Berlin', 'HH24:MI') t FROM (SELECT now() + make_interval(mins => $1) t) x`, [minutes])

before(async () => {
  db = await startDb()
  await db.sys.query(`ALTER DATABASE cafe_test SET timezone TO 'UTC'`)
  await addPeople(db.sys, [[ADMIN, 'admin'], [E1, 'employee']])
  setRuntimeLocale('de')
})
after(async () => { await db?.stop() })
beforeEach(async () => {
  await db.sys.query(`DELETE FROM time_entries; DELETE FROM time_corrections; DELETE FROM payroll_months;`)
  for (const [a, b] of [['09:03:31', '09:03:36'], ['09:04:11', '14:04:58'], ['14:05:03', '18:40:21']])
    await db.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, approved) VALUES ($1, '2026-10-05', ('2026-10-05 ' || $2)::timestamp AT TIME ZONE 'Europe/Berlin', ('2026-10-05 ' || $3)::timestamp AT TIME ZONE 'Europe/Berlin', true)`, [EMP(E1), a, b])
})

test('Production-Fall: neu 08:00–16:00 → abgelehnt (HINT entry_overlap), nichts gespeichert, Meldung verständlich', async () => {
  const e = await fail(async () => save(await db.as(ADMIN), { d: '2026-10-05', inT: '08:00', outT: '16:00' }))
  assert.equal(e?.hint, 'entry_overlap')
  assert.equal(await count(), 3, 'Schutz unverändert: kein Eintrag angelegt')
  assert.equal(localizeMessage(timeCorrectionSaveError(e)),
    'Zeitkorrektur nicht möglich: Für diesen Zeitraum ist bei dieser Person bereits Arbeitszeit erfasst (Eintrag am 05.10. um 09:03, kürzer als 1 Minute). Bitte den bestehenden Eintrag prüfen und anpassen oder löschen. Es wurde nichts gespeichert.')
})

test('Bearbeiten in einen belegten Zeitraum → ebenfalls klare Meldung; Eintrag unverändert', async () => {
  const id = (await one(db.sys, `SELECT id FROM time_entries ORDER BY clock_in DESC LIMIT 1`)).id
  const st = (await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s
  const e = await fail(async () => save(await db.as(ADMIN), { id, d: '2026-10-05', inT: '12:00', outT: '18:40', expected: JSON.stringify(st) }))
  assert.equal(e?.hint, 'entry_overlap')
  assert.match(localizeMessage(timeCorrectionSaveError(e)), /\(Eintrag am 05\.10\. von 09:04 bis 14:04\)/)
  assert.deepEqual((await one(db.sys, `SELECT _time_entry_state($1) s`, [id])).s, st)
})

test('Normale Korrektur an freiem Tag speichert weiterhin (08:00–16:00 = 8,00 h); offenes Ende = NULL', async () => {
  const a = await db.as(ADMIN)
  const r = await save(a, { d: '2026-10-04', inT: '08:00', outT: '16:00' })
  assert.equal(r.success, true)
  assert.equal((await one(db.sys, `SELECT hours_worked::float h FROM time_entries WHERE id = $1`, [r.id])).h, 8)
  const s = await berlin(-90)
  await db.sys.query(`DELETE FROM time_entries WHERE date = $1`, [s.d])
  const o = await save(a, { d: s.d, inT: s.t, outT: null })
  assert.equal(o.success, true)
  assert.equal((await one(db.sys, `SELECT clock_out FROM time_entries WHERE id = $1`, [o.id])).clock_out, null)
})

test('Zukunft und Lohnmonat-Sperre lehnen weiterhin ab – mit ihrer eigenen Meldung (nicht als Überschneidung)', async () => {
  const a = await db.as(ADMIN), f = await berlin(120)
  const fut = await fail(() => save(a, { d: f.d, inT: f.t, outT: null }))
  assert.equal(fut?.hint, 'entry_future'); assert.equal(timeCorrectionSaveError(fut), null)
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month, is_finalized) VALUES ($1, 2026, 9, true)`, [EMP(E1)])
  const pay = await fail(() => save(a, { d: '2026-09-10', inT: '08:00', outT: '12:00' }))
  assert.equal(pay?.hint, 'payroll_locked'); assert.equal(timeCorrectionSaveError(pay), null)
  assert.equal(await count(), 3)
})
