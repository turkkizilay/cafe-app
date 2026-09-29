// Finales Audit-Fixset (Migration 27 + Frontend): Mitternachts-Logik und Ausgangsstand der Zeitkorrektur (M3/M4),
// DATEV-Personalnummer + vollständiger Export (H3/M6), Offboarding-Hinweise ohne automatische Aktion (M7).
// DB-Seite: tests/db/time_correction.test.mjs, tests/db/prod_functions.test.mjs, tests/db/ops_integrity.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { correctionPlan, endsNextDay, shiftOffsetMin, timeEntryState, berlinTime } from '../src/lib/workHours.js'
import { missingPersonnelNumbers } from '../src/lib/compensation.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i)) }

test('Mitternacht (Client-Vorschau = DB-Regel): Zeiten vor der Einstempelzeit gehören zum Folgetag', () => {
  assert.equal(shiftOffsetMin('22:00', '06:00'), 480)
  assert.equal(shiftOffsetMin('08:00', '16:30'), 510)
  assert.equal(endsNextDay('22:00', '06:00'), true)
  assert.equal(endsNextDay('08:00', '16:00'), false)
  assert.equal(endsNextDay('08:00', '08:00'), false)
  const night = correctionPlan({ inT: '22:00', outT: '06:00', breaks: [{ start: '23:30', end: '23:45' }, { start: '01:00', end: '01:30' }] })
  assert.deepEqual([night.outMin, night.breakMin, night.hours], [480, 45, 7.25])
  const day = correctionPlan({ inT: '08:00', outT: '16:30', breaks: [{ start: '12:00', end: '12:30' }] })
  assert.deepEqual([day.outMin, day.breakMin, day.hours], [510, 30, 8], 'normale Schicht unverändert')
  assert.equal(correctionPlan({ inT: '08:00', outT: '08:00' }).error.code, 'sameInOut')
  assert.equal(correctionPlan({ inT: '', outT: '08:00' }).error.code, 'missingIn')
  assert.equal(correctionPlan({ inT: '22:00', outT: '02:00', breaks: [{ start: '02:30', end: '03:00' }] }).error.code, 'outside')
  assert.equal(correctionPlan({ inT: '08:00', outT: '16:00', breaks: [{ start: '12:00', end: '12:30' }, { start: '12:15', end: '12:45' }] }).error.code, 'overlap')
  assert.equal(correctionPlan({ inT: '08:00', outT: '16:00', breaks: [{ start: '12:00', end: '' }] }).error.code, 'missing')
  const open = correctionPlan({ inT: '08:00', outT: '', breaks: [{ start: '10:00', end: '' }] })
  assert.deepEqual([open.error, open.outMin, open.hours], [undefined, null, null], 'offene Schicht mit laufender Pause erlaubt')
})

test('Formularwerte immer Europe/Berlin 24 h (auch über Sommer-/Winterzeit), Ausgangsstand wie _time_entry_state()', () => {
  assert.equal(berlinTime('2026-10-25T00:30:00Z'), '02:30', 'vor der Umstellung (CEST)')
  assert.equal(berlinTime('2026-10-25T01:30:00Z'), '02:30', 'nach der Umstellung (CET)')
  assert.equal(berlinTime('2026-07-01T20:05:00Z'), '22:05')
  assert.equal(berlinTime(null), '')
  const s = timeEntryState({ clock_in: '2026-09-01T06:00:00.123456+00:00', clock_out: null },
    [{ break_start: '2026-09-01T10:00:00Z', break_end: null }, { break_start: '2026-09-01T08:00:00Z', break_end: '2026-09-01T08:15:00Z' }])
  assert.deepEqual(s, { clock_in: 1788242400, clock_out: null, breaks: [[1788249600, 1788250500], [1788256800, null]] }, 'sortiert, Sekunden abgerundet, null explizit')
})

test('Zeitkorrektur-UI: Werte in Berlin-Zeit, „+1 Tag“ sichtbar, Vorschau aus derselben Regel', () => {
  const t = read('src/pages/TimeManagement.jsx')
  assert.match(t, /clock_in_time:\s+berlinTime\(entry\.clock_in\)/)
  assert.match(t, /start: berlinTime\(b\.break_start\), end: berlinTime\(b\.break_end\)/)
  assert.match(t, /\{nextDayHint\(form\.clock_out_time\)\}/)
  assert.match(t, /const formPlan\s+= correctionPlan\(/)
  assert.doesNotMatch(t, /new Date\(`2000-01-01T\$\{form\.clock_out_time\}`\)/, 'keine Vorschau mit Gleicher-Tag-Annahme')
})

test('DATEV (H3/M6): feste Personalnummer; fehlt sie, wird gestoppt; Export immer aller abgerechneten Zeilen', () => {
  assert.deepEqual(missingPersonnelNumbers([{ personnel_number: '1001' }, { personnel_number: null }, { personnel_number: '' }, { personnel_number: 'A1' }, {}]).length, 4)
  assert.deepEqual(missingPersonnelNumbers([{ personnel_number: '1001' }, { personnel_number: '0042' }]), [])
  const p = read('src/pages/Payroll.jsx')
  const h = fn(p, 'handleDatevExport')
  assert.ok(h.indexOf('missingPersonnelNumbers(allRows)') < h.indexOf('confirmUnresolved()') && h.indexOf('confirmUnresolved()') < h.indexOf('exportDATEV(allRows'), 'erst Personalnummern, dann Bestätigung, dann Export')
  assert.match(h, /if \(missing\.length\) \{ toast\.error\([^;]+\); return \}/)
  assert.match(p, /onClick=\{\(\) => handleDatevExport\(rows, exportMonthLabel\)\}/, 'alle Zeilen, nicht die gefilterte Ansicht')
  assert.doesNotMatch(p, /handleDatevExport\(filtered/)
  assert.match(p, /\{filter !== 'all' && !loading && \(/, 'Hinweis bei aktivem Filter')
  const datev = p.slice(p.indexOf('function exportDATEV('), p.indexOf('export default function Payroll'))
  assert.match(datev, /String\(r\.personnel_number \?\? ''\)/)
  assert.doesNotMatch(datev, /padStart\(4/)
})

test('Mitarbeiter: Personalnummer nur gesendet, wenn die Spalte existiert (Rollout-sicher), Format + Dublette verständlich', () => {
  const e = read('src/pages/Employees.jsx')
  assert.match(e, /const pnFeatureOn\s+= employees\.some\(e => 'personnel_number' in e\)/)
  assert.match(e, /\.\.\.\(pnFeatureOn \? \{ personnel_number: pn \|\| null \} : \{\}\)/)
  assert.match(e, /if \(pnFeatureOn && pn && !\/\^\[0-9\]\{1,10\}\$\/\.test\(pn\)\)/)
  assert.match(e, /\/personnel_number\/\.test\(err\.message \|\| ''\) \? appMessage\("employee\.personnelNumberTaken"\)/)
})

test('Offboarding (M7): offene Punkte serverseitig lesen, nur Hinweise + Sprünge – keine automatische Lösch-/Ablehnaktion', () => {
  const e = read('src/pages/Employees.jsx')
  assert.match(fn(e, 'handleDeactivate'), /supabase\.rpc\('admin_offboarding_check', \{ p_employee_id: id \}\)/)
  const comp = e.slice(e.indexOf('function OffboardingHints('))
  assert.doesNotMatch(comp, /supabase\.|\.delete\(|\.update\(/, 'Hinweis-Komponente schreibt nichts')
  assert.match(comp, /onGo\('\/schichten'\)/); assert.match(comp, /onGo\('\/urlaub'\)/)
  assert.match(comp, /c\.offboardingError/, 'Prüffehler wird angezeigt, nicht verschluckt')
  assert.doesNotMatch(fn(e, 'doDeactivate'), /shifts|vacation_requests|shift_swap_requests/, 'Deaktivieren fasst Schichten/Urlaub nicht an')
})

test('i18n: neue Texte DE/EN vollständig, Platzhalter identisch', () => {
  const keys = Object.keys(de).filter(k => /^(offboarding\.|employee\.personnelNumber|payroll\.(personnelNumberMissing|exportAllHint)|time\.(saveFailed|deleteFailed|sameInOut|nextDay))/.test(k))
  assert.ok(keys.length >= 20, keys.length)
  for (const k of keys) {
    assert.ok(en[k], k); assert.notEqual(de[k], en[k], k)
    assert.deepEqual((en[k].match(/\{\w+\}/g) || []).sort(), (de[k].match(/\{\w+\}/g) || []).sort(), k)
  }
})
