// Vergütungsmodell – nur synthetische Beispieldaten (keine echten Mitarbeiter, Namen oder Gehälter).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { payTypeOf, canHaveFixedPay, parseMonthlySalary, validatePayModel, monthlyGross, sickPayAmount, isPartialMonth, datevRateCell, datevHintCell } from '../src/lib/compensation.js'

const hourly = (rate, extra = {}) => ({ employment_type: 'vollzeit', pay_type: 'hourly', hourly_rate: rate, ...extra })
const fixed  = (salary, extra = {}) => ({ employment_type: 'vollzeit', pay_type: 'fixed', monthly_salary: salary, hourly_rate: 15, ...extra })
const oldGross = (paidHours, rate) => Math.round(paidHours * rate * 100) / 100   // Formel vor Migration 18

test('Stundenlohn: Brutto exakt wie bisher (Stunden × Satz)', () => {
  for (const [h, r] of [[0, 14], [172, 15.5], [184.25, 16.75], [68.8, 14.2], [221, 18]]) {
    assert.equal(monthlyGross(hourly(r), h), oldGross(h, r))
    assert.equal(monthlyGross({ employment_type: 'teilzeit', hourly_rate: r }, h), oldGross(h, r))   // ohne pay_type (Altbestand) = Stundenlohn
  }
  assert.equal(sickPayAmount(hourly(15), 16), 240)
})

test('Fixgehalt: Brutto = Monatsgehalt, unabhängig von Stunden/Überstunden, keine Teilmonats-Kürzung', () => {
  for (const paidHours of [0, 100, 172, 190, 260]) assert.equal(monthlyGross(fixed(3100), paidHours), 3100)
  assert.equal(monthlyGross(fixed('2750.5'), 172), 2750.5)
  assert.equal(sickPayAmount(fixed(3100), 24), 0)   // Lohnfortzahlung im Gehalt enthalten
  assert.equal(monthlyGross({ ...fixed(3100), employment_type: 'teilzeit', hours_per_week: 20 }, 60), 3100)
})

test('Beschäftigungsart und Vergütung sind unabhängig; Werkstudent/Minijob nur Stundenlohn', () => {
  assert.equal(canHaveFixedPay('vollzeit'), true)
  assert.equal(canHaveFixedPay('teilzeit'), true)
  assert.equal(canHaveFixedPay('werkstudent'), false)
  assert.equal(canHaveFixedPay('minijob'), false)
  assert.equal(validatePayModel({ employment_type: 'vollzeit', pay_type: 'fixed', monthly_salary: '3000' }), null)
  assert.equal(validatePayModel({ employment_type: 'teilzeit', pay_type: 'fixed', monthly_salary: 1500 }), null)
  assert.equal(validatePayModel({ employment_type: 'werkstudent', pay_type: 'fixed', monthly_salary: 1200 }), 'fixedNotAllowed')
  assert.equal(validatePayModel({ employment_type: 'minijob', pay_type: 'fixed', monthly_salary: 500 }), 'fixedNotAllowed')
  assert.equal(validatePayModel({ employment_type: 'vollzeit', pay_type: 'fixed', monthly_salary: '' }), 'salaryMissing')
  assert.equal(validatePayModel({ employment_type: 'vollzeit', pay_type: 'fixed', monthly_salary: 0 }), 'salaryMissing')
  assert.equal(validatePayModel({ employment_type: 'werkstudent', pay_type: 'hourly' }), null)
  assert.equal(payTypeOf({}), 'hourly')
  assert.equal(parseMonthlySalary('2 950,40'), 2950.4)
  assert.equal(parseMonthlySalary('-5'), null)
})

test('Teilmonat wird nur erkannt, nicht gekürzt', () => {
  assert.equal(isPartialMonth({ start_date: '2026-10-15' }, '2026-10-01', '2026-10-31'), true)
  assert.equal(isPartialMonth({ start_date: '2026-01-01', end_date: '2026-10-20' }, '2026-10-01', '2026-10-31'), true)
  assert.equal(isPartialMonth({ start_date: '2026-01-01' }, '2026-10-01', '2026-10-31'), false)
  assert.equal(monthlyGross(fixed(3100, { start_date: '2026-10-15' }), 80), 3100)
})

test('DATEV-Zellen: Stundenlohn-Zeilen unverändert, Fixgehalt gekennzeichnet', () => {
  const oldRate = r => r.hourly_rate.toFixed(2).replace('.', ',')
  const oldHint = r => r.isAlert ? (r.employment_type === 'minijob' ? 'MINIJOB-GRENZE PRÜFEN' : 'ÜBERSTUNDEN') : ''
  for (const r of [hourly(15.5), hourly(14, { isAlert: true }), { ...hourly(14), employment_type: 'minijob', isAlert: true }, { employment_type: 'teilzeit', hourly_rate: 16 }]) {
    assert.equal(datevRateCell(r), oldRate(r))
    assert.equal(datevHintCell(r), oldHint(r))
  }
  assert.equal(datevRateCell(fixed(3100)), '')
  assert.equal(datevHintCell(fixed(3100)), 'FIXGEHALT')
  assert.equal(datevHintCell({ ...fixed(3100), isAlert: true }), 'FIXGEHALT / ÜBERSTUNDEN')
  assert.equal(datevHintCell({ ...fixed(3100), partialMonth: true }), 'FIXGEHALT / TEILMONAT PRÜFEN')
})

test('Payroll nutzt das Modul; Abschluss friert das Modell nur mit Migration 18 ein', () => {
  const src = readFileSync('src/pages/Payroll.jsx', 'utf8')
  assert.match(src, /const grossSalary  = monthlyGross\(emp, paidHours\)/)
  assert.doesNotMatch(src, /paidHours \* emp\.hourly_rate/)
  assert.match(src, /sick_pay:\s+sickPayAmount\(r, r\.sickHours\)/)
  assert.match(src, /\.\.\.\(r\.pay_type !== undefined \? \{ pay_type: payTypeOf\(r\), monthly_salary: r\.monthly_salary \?\? null \} : \{\}\)/)
  assert.match(src, /datevRateCell\(r\)/)
  assert.match(src, /datevHintCell\(r\)/)
  const emp = readFileSync('src/pages/Employees.jsx', 'utf8')
  assert.match(emp, /const payFeatureOn = employees\.some\(e => 'pay_type' in e\)/)
  assert.match(emp, /\.\.\.\(payFeatureOn \? \{/)
  assert.doesNotMatch(emp, /<option value="(hourly|fixed)"/)
})

test('Migration 18: Default Stundenlohn, Constraints wie im Modul', () => {
  const sql = readFileSync('supabase/migrations_onboarding/18_compensation_model.sql', 'utf8').replace(/--.*$/gm, '')   // nur SQL, keine Kommentare
  assert.match(sql, /pay_type text NOT NULL DEFAULT 'hourly'/)
  assert.match(sql, /CHECK \(pay_type IN \('hourly', 'fixed'\)\)/)
  assert.match(sql, /CHECK \(pay_type = 'hourly' OR monthly_salary IS NOT NULL\)/)
  assert.match(sql, /CHECK \(pay_type = 'hourly' OR employment_type IN \('vollzeit', 'teilzeit'\)\)/)
  assert.doesNotMatch(sql, /POLICY|GRANT|REVOKE|UPDATE public\.employees SET/i)
})
