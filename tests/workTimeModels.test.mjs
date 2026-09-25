import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { monthlyModel, monthlyTargetHours, FULLTIME_MONTHLY_TARGET_H, FULLTIME_MONTHLY_CAP_H, WEEKS_PER_MONTH, STUDENT_MONTHLY_LIMIT_H } from '../src/lib/workTimeModels.js'

const vz = { employment_type: 'vollzeit', hours_per_week: 40 }
const tz = h => ({ employment_type: 'teilzeit', hours_per_week: h })
const ws = { employment_type: 'werkstudent', hours_per_week: 20 }

test('rules live in one place', () => {
  assert.equal(FULLTIME_MONTHLY_TARGET_H, 172)
  assert.equal(FULLTIME_MONTHLY_CAP_H, 220)
  assert.equal(WEEKS_PER_MONTH, 4.3)
  assert.equal(STUDENT_MONTHLY_LIMIT_H, 80)
})

test('Vollzeit: Soll 172 h fix, Überstunden darüber, Warnung über 220 h ohne Kürzung', () => {
  assert.equal(monthlyTargetHours(vz), 172)
  assert.equal(monthlyTargetHours({ employment_type: 'vollzeit', hours_per_week: 38 }), 172)   // fix, unabhängig von Wochenstunden
  assert.deepEqual(monthlyModel(vz, 172), { type: 'vollzeit', actual: 172, target: 172, limit: 220, overtime: 0, status: 'ok' })
  assert.equal(monthlyModel(vz, 180).overtime, 8)
  assert.equal(monthlyModel(vz, 180).status, 'overtime')
  assert.equal(monthlyModel(vz, 220).overtime, 48)
  assert.equal(monthlyModel(vz, 220).status, 'overtime')
  const over = monthlyModel(vz, 221)
  assert.equal(over.actual, 221)          // Stunden bleiben vollständig erhalten
  assert.equal(over.overtime, 49)         // keine Kappung bei 48
  assert.equal(over.status, 'over_cap')
  assert.equal(monthlyModel(vz, 150).overtime, 0)   // Unterstunden sind keine negativen Überstunden
})

test('Teilzeit: Soll = Wochenstunden × 4,3, auch für andere Wochenstunden', () => {
  assert.equal(monthlyTargetHours(tz(16)), 68.8)
  assert.equal(monthlyTargetHours(tz(20)), 86)
  assert.equal(monthlyTargetHours(tz(24)), 103.2)
  assert.equal(monthlyTargetHours(tz(12.5)), 53.75)
  assert.equal(monthlyModel(tz(16), 75).overtime, 6.2)
  assert.equal(monthlyModel(tz(16), 75).status, 'overtime')
  assert.equal(monthlyModel(tz(16), 60).overtime, 0)          // nie negativ
  assert.equal(monthlyModel(tz(16), 60).status, 'ok')
  assert.equal(monthlyModel(tz(24), 300).status, 'overtime')  // keine 220-h-Schwelle für Teilzeit
})

test('Werkstudent: betriebliche 80-h-Grenze mit Hinweis ab 90 %, Stunden bleiben erhalten', () => {
  assert.equal(monthlyModel(ws, 60).status, 'ok')
  assert.equal(monthlyModel(ws, 71.99).status, 'ok')
  assert.equal(monthlyModel(ws, 72).status, 'near')
  assert.equal(monthlyModel(ws, 80).status, 'reached')
  assert.equal(monthlyModel(ws, 80).overtime, 0)
  const over = monthlyModel(ws, 85.5)
  assert.equal(over.status, 'over')
  assert.equal(over.actual, 85.5)
  assert.equal(over.overtime, 5.5)
  assert.equal(over.limit, 80)
})

test('Minijob bleibt bei der Verdienst-Prüfung; fehlende Daten sind robust', () => {
  assert.equal(monthlyModel({ employment_type: 'minijob', hours_per_week: 10 }, 50).status, 'ok')
  assert.equal(monthlyTargetHours({ employment_type: 'minijob', hours_per_week: 10 }), 43)
  assert.equal(monthlyTargetHours(null), 0)
  assert.equal(monthlyModel(tz(null), 5).overtime, 5)
})

test('no magic numbers for the rules outside the central module', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/pages/MyHours.jsx', 'src/pages/Timesheet.jsx', 'src/pages/Employees.jsx']) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /(?<!:\s?)\b(172|220)\b|\b4[.,]3\b/, f)   // Stilwerte wie minWidth:220 ausgenommen
    assert.doesNotMatch(src, /WERKSTUDENT_LIMIT\s*=\s*80/, f)
  }
})
