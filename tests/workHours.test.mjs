import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calcWorkedHours, BREAK_WARNING_MINUTES, openBreak, sumBreakMinutes, breakElapsedMinutes, isBreakTooLong, netWorkedHours } from '../src/lib/workHours.js'

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
