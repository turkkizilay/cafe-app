// Migration 37 im Browser: Vorprüfung „Zeitkorrektur nur für Vergangenes“ (Berliner Wanduhrzeit, Folgetag-Regel,
// Sommer-/Winterzeit), Überschneidungs-Meldung in der Live-Steuerung – und alles Übrige byte-gleich.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { wallTimeToMs, correctionFutureProblem } from '../src/lib/timeCorrectionRules.js'
import { liveErrorKind } from '../src/lib/liveTimeControl.js'
import { pinView } from './pinView.mjs'   // Pin-Ausnahme Production-Polish (nur a11y + Schichttausch-Fix; Lohn/Stundennachweis ohne Ausnahme)

const read = f => readFileSync(f, 'utf8')
const BEFORE = 'cccbfd8'   // Stand vor dem H1/M1-Fix
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

test('REGRESSION: Lohn/DATEV, Timesheet, Pausenregeln, Live-Kosten, Stempeln, Migrationen 34–36 byte-gleich', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workHours.js', 'src/lib/workTimeModels.js', 'src/lib/breakRules.js',
                   'src/pages/Timesheet.jsx', 'src/lib/timesheetPdf.js', 'src/pages/MyHours.jsx', 'src/lib/sickLeaveLogic.js', 'src/lib/vacationLogic.js',
                   'src/lib/laborCost.js', 'src/lib/useLiveLaborCost.js', 'src/components/LiveLaborCostCard.jsx', 'src/components/LiveTimeControl.jsx',
                   'src/pages/ClockIn.jsx', 'src/lib/remoteClock.js', 'src/lib/breaks.js', 'src/pages/Shifts.jsx',
                   'supabase/migrations_onboarding/34_break_hardening.sql', 'supabase/migrations_onboarding/35_labor_cost_today.sql',
                   'supabase/migrations_onboarding/36_staff_live_action.sql'])
    assert.equal(pinView(f, read(f)), pinView(f, atBefore(f)), f)
})

test('Berliner Wanduhrzeit → Zeitpunkt, unabhängig vom Gerät; Sommer/Winter und Umstellungstage', () => {
  assert.equal(new Date(wallTimeToMs('2026-07-01', '12:00')).toISOString(), '2026-07-01T10:00:00.000Z', 'Sommerzeit')
  assert.equal(new Date(wallTimeToMs('2026-01-15', '12:00')).toISOString(), '2026-01-15T11:00:00.000Z', 'Winterzeit')
  assert.equal(new Date(wallTimeToMs('2026-03-29', '01:30')).toISOString(), '2026-03-29T00:30:00.000Z', 'vor Umstellung (Frühjahr)')
  assert.equal(new Date(wallTimeToMs('2026-03-29', '03:30')).toISOString(), '2026-03-29T01:30:00.000Z', 'nach Umstellung (Frühjahr)')
  assert.equal(new Date(wallTimeToMs('2025-10-26', '04:00')).toISOString(), '2025-10-26T03:00:00.000Z', 'nach Umstellung (Herbst)')
  assert.equal(new Date(wallTimeToMs('2026-10-03', '06:00', 1)).toISOString(), '2026-10-04T04:00:00.000Z', 'Folgetag')
})

test('Vorprüfung: Beginn/Ende höchstens 1 Min. in der Zukunft; Folgetag-Regel; offene Schicht', () => {
  const now = Date.parse('2026-10-03T12:04:00Z')   // 14:04 Berlin (wie der Production-Fall)
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '08:30', outT: '18:00', nowMs: now }), 'future', 'Production-Fall 08:30–18:00 um 14:04')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '08:30', outT: '14:04', nowMs: now }), null, 'Ende = jetzt')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '08:30', outT: '14:05', nowMs: now }), null, '1 Min. Toleranz')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '08:30', outT: '14:06', nowMs: now }), 'future')
  assert.equal(correctionFutureProblem({ date: '2026-10-02', inT: '22:00', outT: '06:00', nowMs: now }), null, 'Nachtschicht gestern → heute früh')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '22:00', outT: '06:00', nowMs: now }), 'future', 'Nachtschicht heute Abend')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '10:00', outT: '09:00', nowMs: now }), 'future', 'Ende 09:00 vor Beginn 10:00 = morgen früh → Zukunft')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '15:00', outT: null, nowMs: now }), 'future', 'offene Schicht beginnt später')
  assert.equal(correctionFutureProblem({ date: '2026-10-03', inT: '10:00', outT: null, nowMs: now }), null, 'offene Schicht seit 10:00')
  assert.equal(correctionFutureProblem({ date: '2026-10-04', inT: '08:00', outT: '12:00', nowMs: now }), 'future', 'morgen')
})

test('Korrektur-Dialog prüft vor dem Serveraufruf; Live-Steuerung meldet Überschneidung verständlich', () => {
  const t = read('src/pages/TimeManagement.jsx')
  const i = t.indexOf("correctionFutureProblem({ date: form.date, inT: form.clock_in_time, outT: form.clock_out_time || null })"), j = t.indexOf("supabase.rpc('admin_save_time_entry'")
  assert.ok(i > 0 && i < j, 'Vorprüfung vor dem Speichern')
  assert.match(t, /toast\.warn\(appMessage\("time\.futureNotAllowed"\)\); return \}/)
  assert.equal(liveErrorKind({ code: 'P0001', hint: 'entry_overlap', message: 'x' }), 'overlap')
  assert.match(read('src/pages/Dashboard.jsx'), /overlap: 'live\.overlap'/)
})

test('Migration 37: nur Funktionen + Index, keine Datenänderung, kein Exclusion-Constraint, search_path gesetzt', () => {
  const sql = read('supabase/migrations_onboarding/37_time_correction_past_only.sql')
  const outside = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--.*$/gm, '')
  assert.doesNotMatch(outside, /^\s*(UPDATE\s+\S+\s+SET|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE)\b/im)
  assert.doesNotMatch(outside, /EXCLUDE/i)
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$(function)?\$/g)) assert.match(m[0], /SECURITY DEFINER\s+SET search_path TO 'public'/)
  assert.match(sql, /HINT = 'entry_future'/); assert.equal((sql.match(/HINT = 'entry_overlap'/g) || []).length, 4)
  assert.match(sql, /v_out > clock_timestamp\(\) \+ interval '1 minute'/)
})
