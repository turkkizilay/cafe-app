import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calcWorkedHours, BREAK_WARNING_MINUTES, openBreak, sumBreakMinutes, breakElapsedMinutes, isBreakTooLong, netWorkedHours, validateBreaks } from '../src/lib/workHours.js'

const IN = '2026-09-25T08:00:00.000Z'
const at = (h, m = 0) => new Date(Date.parse(IN) + (h * 60 + m) * 60000).toISOString()
const round = h => Math.round(h * 100) / 100

test('no automatic break is deducted when no break was recorded', () => {
  assert.equal(calcWorkedHours(IN, at(5)), 5)
  assert.equal(round(calcWorkedHours(IN, at(6, 10))), 6.17)   // 6h10, NICHT 5h40
  assert.equal(calcWorkedHours(IN, at(8)), 8)
  assert.equal(calcWorkedHours(IN, at(10)), 10)
  assert.equal(calcWorkedHours(IN, at(10), 0), 10)
  assert.equal(calcWorkedHours(IN, at(10), null), 10)
})

test('an actually recorded break is still respected', () => {
  assert.equal(calcWorkedHours(IN, at(8), 30), 7.5)
  assert.equal(calcWorkedHours(IN, at(8), '45'), 7.25)
})

test('open or missing times yield null', () => {
  assert.equal(calcWorkedHours(IN, null), null)
  assert.equal(calcWorkedHours(null, at(5)), null)
})

test('clock-out and admin form do not reintroduce a duration-based break', () => {
  for (const f of ['src/pages/ClockIn.jsx', 'src/pages/TimeManagement.jsx']) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /[>]\s*9\s*\?\s*45\s*:/, f)
    assert.doesNotMatch(src, /[>]\s*6\s*\?\s*30\s*:/, f)
  }
  assert.match(readFileSync('src/pages/TimeManagement.jsx', 'utf8'), /break_minutes: 0, notes/)
})

test('DB trigger migration keeps only the recorded break on clock-out', () => {
  const sql = readFileSync('supabase/migrations_onboarding/16_no_auto_break.sql', 'utf8')
  assert.match(sql, /v_break := COALESCE\(OLD\.break_minutes, 0\);/)
  assert.doesNotMatch(sql, /WHEN v_total > 9 THEN 45/)
  assert.doesNotMatch(sql, /WHEN v_total > 6 THEN 30/)
})

// ── Erfasste Pausen ──
const brk = (fromH, fromM, toH, toM) => ({ break_start: at(fromH, fromM), break_end: toH == null ? null : at(toH, toM) })

test('sumBreakMinutes adds recorded breaks and counts an open break until now', () => {
  assert.equal(sumBreakMinutes([]), 0)
  assert.equal(sumBreakMinutes(null), 0)
  assert.equal(sumBreakMinutes([brk(2, 0, 2, 20)]), 20)
  assert.equal(sumBreakMinutes([brk(2, 0, 2, 20), brk(5, 0, 5, 15)]), 35)
  assert.equal(sumBreakMinutes([brk(2, 0, 2, 20), brk(7, 45, null)], at(8)), 35)
  assert.equal(sumBreakMinutes([{ break_start: at(3), break_end: at(2) }]), 0)   // ungültig → 0, nie negativ
})

test('sumBreakMinutes rounds the total seconds like the DB trigger', () => {
  const s = sec => new Date(Date.parse(IN) + sec * 1000).toISOString()
  assert.equal(sumBreakMinutes([{ break_start: s(0), break_end: s(29) }]), 0)
  assert.equal(sumBreakMinutes([{ break_start: s(0), break_end: s(30) }]), 1)
  // zweimal 40 s = 80 s → 1 Min (nicht je Pause gerundet = 2)
  assert.equal(sumBreakMinutes([{ break_start: s(0), break_end: s(40) }, { break_start: s(100), break_end: s(140) }]), 1)
})

test('netWorkedHours subtracts only recorded breaks', () => {
  assert.equal(netWorkedHours(IN, at(8), []), 8)
  assert.equal(round(netWorkedHours(IN, at(6, 10), [])), 6.17)
  assert.equal(round(netWorkedHours(IN, at(8), [brk(2, 0, 2, 20), brk(7, 45, null)])), 7.42)   // offene Pause endet mit dem Ausclocken
  assert.equal(netWorkedHours(IN, null, [brk(1, 0, 1, 30)], at(4)), 3.5)                          // laufende Schicht
  assert.equal(netWorkedHours(IN, null, [brk(3, 0, null)], at(4)), 3)                             // laufende Pause
})

test('openBreak and 90-minute warning', () => {
  const running = brk(1, 0, null)
  assert.equal(openBreak([brk(0, 30, 0, 45), running]), running)
  assert.equal(openBreak([brk(0, 30, 0, 45)]), null)
  assert.equal(BREAK_WARNING_MINUTES, 90)
  assert.equal(breakElapsedMinutes(running, at(1, 14)), 14)
  assert.equal(isBreakTooLong(running, at(2, 29)), false)
  assert.equal(isBreakTooLong(running, at(2, 30)), true)    // ab 90 Min
  assert.equal(isBreakTooLong(brk(1, 0, 3, 0), at(4)), false) // beendete Pause warnt nicht
  assert.equal(isBreakTooLong(null), false)
})

test('ClockIn maps every break RPC error of migration 17 to a bilingual message', () => {
  const sql = readFileSync('supabase/migrations_onboarding/17_break_tracking.sql', 'utf8')
  const page = readFileSync('src/pages/ClockIn.jsx', 'utf8')
  const rpcBody = name => sql.slice(sql.indexOf(`FUNCTION public.${name}()`), sql.indexOf('END $function$', sql.indexOf(`FUNCTION public.${name}()`)))
  const raised = [...rpcBody('start_break').matchAll(/RAISE EXCEPTION '([^']+)'/g), ...rpcBody('end_break').matchAll(/RAISE EXCEPTION '([^']+)'/g)].map(m => m[1])
  const handled = [...page.matchAll(/m\.includes\('([^']+)'\)/g)].map(m => m[1])
  assert.ok(raised.length >= 4)
  for (const msg of raised) assert.ok(handled.some(h => msg.includes(h)), `unmapped: ${msg}`)
})

test('validateBreaks mirrors the DB guard rules for admin corrections', () => {
  const OUT = at(8)
  assert.equal(validateBreaks([], IN, OUT), null)
  assert.equal(validateBreaks([brk(2, 0, 2, 20), brk(5, 0, 5, 15)], IN, OUT), null)
  assert.equal(validateBreaks([brk(5, 0, 5, 15), brk(2, 0, 2, 20)], IN, OUT), null)               // Reihenfolge egal
  assert.deepEqual(validateBreaks([{ break_start: null, break_end: at(2) }], IN, OUT), { code: 'missing', index: 0 })
  assert.deepEqual(validateBreaks([brk(2, 0, 2, 20), brk(3, 0, null)], IN, OUT), { code: 'missing', index: 1 })  // geschlossene Schicht braucht Ende
  assert.equal(validateBreaks([brk(3, 0, null)], IN, null), null)                                  // offene Schicht: laufende Pause ok
  assert.deepEqual(validateBreaks([brk(3, 0, null), brk(4, 0, null)], IN, null), { code: 'multipleOpen', index: 1 })
  assert.deepEqual(validateBreaks([brk(3, 0, 2, 50)], IN, OUT), { code: 'order', index: 0 })
  assert.deepEqual(validateBreaks([brk(3, 0, 3, 0)], IN, OUT), { code: 'order', index: 0 })
  assert.deepEqual(validateBreaks([{ break_start: at(-1), break_end: at(0, 10) }], IN, OUT), { code: 'outside', index: 0 })
  assert.deepEqual(validateBreaks([brk(7, 50, 8, 10)], IN, OUT), { code: 'outside', index: 0 })
  assert.deepEqual(validateBreaks([brk(2, 0, 2, 30), brk(2, 20, 2, 40)], IN, OUT), { code: 'overlap', index: 1 })
  assert.equal(validateBreaks([brk(2, 0, 2, 30), brk(2, 30, 2, 40)], IN, OUT), null)               // direkt anschließend ok
  assert.deepEqual(validateBreaks([brk(2, 0, null), brk(3, 0, 3, 10)], IN, null), { code: 'overlap', index: 1 })
})

test('ClockIn: unknown break status is never treated as "no break"', async () => {
  const { breakUiState } = await import('../src/lib/workHours.js')
  const running = [brk(1, 0, null)]
  assert.equal(breakUiState({ featureOn: true, loadState: 'ok', breaks: running }), 'running')
  assert.equal(breakUiState({ featureOn: true, loadState: 'ok', breaks: [] }), 'idle')
  assert.equal(breakUiState({ featureOn: true, loadState: 'error', breaks: [] }), 'error')
  assert.equal(breakUiState({ featureOn: true, loadState: 'loading', breaks: [] }), 'loading')
  assert.equal(breakUiState({ featureOn: true, loadState: undefined, breaks: [] }), 'error')
  assert.equal(breakUiState({ featureOn: false, loadState: 'ok', breaks: [] }), 'hidden')
  const page = readFileSync('src/pages/ClockIn.jsx', 'utf8')
  // „Pause starten/beenden“ nur bei bekanntem Status; bei Fehler Hinweis + Erneut laden
  assert.match(page, /\{\(breakUi === 'idle' \|\| breakUi === 'running'\) && \(/)
  assert.match(page, /breakUi === 'error' && \([\s\S]*?clock\.breakStatusUnknown[\s\S]*?onClick=\{\(\) => loadBreaks\(openEntry\.id\)\}[\s\S]*?clock\.breakStatusRetry/)
  assert.match(page, /if \(error\) \{ setBreaks\(\[\]\); setBreakLoad\('error'\); return \}/)
  assert.match(page, /catch \{\s*setBreaks\(\[\]\); setBreakLoad\('error'\)/)
  assert.doesNotMatch(page, /setBreaks\(bErr \? \[\] : rows\)/)          // alter Fehlerpfad („leer = keine Pause“) ist weg
})
