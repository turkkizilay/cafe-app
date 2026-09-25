import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calcWorkedHours } from '../src/lib/workHours.js'

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
