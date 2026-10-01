// Fixgehalt ohne Stundenlohn (Migration 30) – Client: Regel je Vergütungsart, echter Freischaltungs-Handler aus
// OnboardingReview.jsx gegen eine nachgebildete RPC, Lohn/DATEV mit leerem Stundenlohn, Mitarbeiterformular, DE/EN.
// Server-/DB-Seite: tests/db/fixed_salary.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as comp from '../src/lib/compensation.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return src.slice(src.lastIndexOf('\n', start) + 1, i).trim()
}

test('Regel je Vergütungsart: Stundenlohn Pflicht nur bei „Stundenlohn“; bei Fixgehalt optional, wenn angegeben > 0', () => {
  const v = (pay_type, hourly_rate) => comp.validateHourlyRate({ pay_type, hourly_rate })
  assert.equal(v('hourly', ''), 'rateMissing'); assert.equal(v('hourly', null), 'rateMissing'); assert.equal(v(undefined, ''), 'rateMissing', 'ohne Angabe = Stundenlohn')
  assert.equal(v('hourly', '0'), 'rateInvalid'); assert.equal(v('hourly', 'abc'), 'rateInvalid'); assert.equal(v('hourly', '-3'), 'rateInvalid')
  assert.equal(v('hourly', '13,90'), null); assert.equal(v('hourly', 15.5), null)
  assert.equal(v('fixed', ''), null); assert.equal(v('fixed', null), null); assert.equal(v('fixed', '  '), null)
  assert.equal(v('fixed', '0'), 'rateInvalid'); assert.equal(v('fixed', 'x'), 'rateInvalid'); assert.equal(v('fixed', '17,5'), null)
  assert.equal(comp.parseHourlyRate(''), null); assert.equal(comp.parseHourlyRate('13,905'), 13.91); assert.ok(Number.isNaN(comp.parseHourlyRate('0')))
})

// Echter approve()-Handler mit nachgebildeten Abhängigkeiten
function approveHarness(job) {
  const h = { err: '', rpc: [], toasts: [], done: 0, busy: false }
  const src = read('src/components/OnboardingReview.jsx')
  const deps = {
    get busy() { return h.busy }, setBusy: v => { h.busy = v }, setErr: m => { h.err = m },
    appMessage: (k, p) => ({ k, p }), errorMessage: e => e?.message, job,
    rate: comp.parseHourlyRate(job.hourly_rate), validatePayModel: comp.validatePayModel, validateHourlyRate: comp.validateHourlyRate,
    payTypeOf: comp.payTypeOf, parseMonthlySalary: comp.parseMonthlySalary, PAY_FIXED: comp.PAY_FIXED,
    row: { id: 'onb-1' }, name: 'Test Person', onDone: () => { h.done++ },
    toast: { success: m => h.toasts.push(m) },
    supabase: { rpc: async (fn, args) => { h.rpc.push([fn, args]); return { data: { success: true, employee_id: 'e1' }, error: null } } },
  }
  const names = Object.keys(deps).filter(k => k !== 'busy')
  const fn = new Function(...names, 'getBusy', `return (${extractFn(src, 'approve').replace(/if \(busy\) return/, 'if (getBusy()) return')})`)
  h.run = fn(...names.map(k => deps[k]), () => h.busy)
  return h
}
const JOB = { role: 'employee', position: 'Service', employment_type: 'vollzeit', hours_per_week: 40, hourly_rate: '', pay_type: 'fixed', monthly_salary: '3200', start_date: '2026-10-05', vacation_days: 28 }

test('A/B) Fixgehalt + Monatsgehalt + leerer Stundenlohn (Vollzeit/Teilzeit) → Freischaltung wird gesendet, Satz NULL', async () => {
  for (const extra of [{}, { employment_type: 'teilzeit', hours_per_week: 20, monthly_salary: '1650,50' }]) {
    const h = approveHarness({ ...JOB, ...extra })
    await h.run()
    assert.equal(h.err, '', JSON.stringify(h.err))
    assert.equal(h.rpc.length, 1); assert.equal(h.rpc[0][0], 'approve_onboarding_with_pay')
    const a = h.rpc[0][1]
    assert.equal(a.p_pay_type, 'fixed'); assert.equal(a.p_hourly_rate, null, 'kein erfundener Stundenlohn')
    assert.equal(a.p_monthly_salary, extra.monthly_salary ? 1650.5 : 3200)
    assert.equal(h.done, 1)
  }
})

test('C) Fixgehalt ohne Monatsgehalt → Meldung zum Monatsgehalt (nicht zum Stundenlohn), nichts gesendet', async () => {
  const h = approveHarness({ ...JOB, monthly_salary: '' })
  await h.run()
  assert.equal(h.err.k, 'payModel.salaryMissing'); assert.equal(h.rpc.length, 0)
})

test('D/E) Stundenlohn: gültig → gesendet mit Satz; leer → „Bitte einen Stundenlohn angeben.“; ungültig → eigene Meldung', async () => {
  let h = approveHarness({ ...JOB, pay_type: 'hourly', employment_type: 'minijob', hours_per_week: 10, hourly_rate: '14,50', monthly_salary: '999' })
  await h.run()
  assert.equal(h.err, ''); assert.equal(h.rpc[0][1].p_hourly_rate, 14.5); assert.equal(h.rpc[0][1].p_monthly_salary, null)
  h = approveHarness({ ...JOB, pay_type: 'hourly', hourly_rate: '' })
  await h.run()
  assert.equal(h.err.k, 'ui.fb10bc721e8c'); assert.equal(h.rpc.length, 0)
  h = approveHarness({ ...JOB, pay_type: 'fixed', hourly_rate: '0' })
  await h.run()
  assert.equal(h.err.k, 'payModel.rateInvalid'); assert.equal(h.rpc.length, 0)
})

test('F) Werkstudent/Minijob + Fixgehalt → weiterhin blockiert', async () => {
  for (const employment_type of ['werkstudent', 'minijob']) {
    const h = approveHarness({ ...JOB, employment_type, hours_per_week: 15 })
    await h.run()
    assert.equal(h.err.k, 'payModel.fixedNotAllowed'); assert.equal(h.rpc.length, 0)
  }
})

test('I) Lohn: Fixgehalt = Monatsgehalt, unabhängig von Stunden und ohne Stundenlohn; Stundenlohn unverändert', () => {
  const fixedNoRate = { employment_type: 'vollzeit', pay_type: 'fixed', monthly_salary: 3200, hourly_rate: null }
  for (const hours of [0, 40, 172, 250]) assert.equal(comp.monthlyGross(fixedNoRate, hours), 3200)
  assert.equal(comp.monthlyGross({ ...fixedNoRate, hourly_rate: 99 }, 172), 3200, 'auch ein vorhandener Satz wird nicht verwendet')
  assert.equal(comp.sickPayAmount(fixedNoRate, 16), 0)
  assert.equal(comp.monthlyGross({ pay_type: 'hourly', hourly_rate: 15.5 }, 100), 1550)
  const pay = read('src/pages/Payroll.jsx')
  assert.match(pay, /const grossSalary  = monthlyGross\(emp, paidHours\)/)
  assert.doesNotMatch(pay, /paidHours \* (emp|r)\.hourly_rate/)
})

test('H) DATEV: Fixgehalt ohne Stundenlohn → Stundenlohn-Spalte leer, Brutto = Monatsgehalt, Hinweis FIXGEHALT (echte Exportfunktion)', async () => {
  const src = read('src/pages/Payroll.jsx')
  let saved = null
  const exportDATEV = new Function('saveFile', 'datevRateCell', 'datevHintCell', `return (${extractFn(src, 'exportDATEV')})`)(b => { saved = b }, comp.datevRateCell, comp.datevHintCell)
  const base = { employment_type: 'vollzeit', monthTarget: 172, actualHours: 180, vacationHours: 0, sickHours: 0, overtime: 8, isAlert: false }
  exportDATEV([{ ...base, personnel_number: '1', last_name: 'Fix', first_name: 'Ohne', pay_type: 'fixed', monthly_salary: 3200, hourly_rate: null, total: 3200 },
               { ...base, personnel_number: '2', last_name: 'Std', first_name: 'Lohn', pay_type: 'hourly', hourly_rate: 15.5, total: 2790 }], 'Test')
  const lines = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(await saved.arrayBuffer())).slice(1).split('\n').map(l => l.split(';'))
  assert.equal(lines[1][9], '""'); assert.equal(lines[1][10], '"3200,00"'); assert.equal(lines[1][11], '"FIXGEHALT"')
  assert.equal(lines[2][9], '"15,50"'); assert.equal(lines[2][10], '"2790,00"')
})

test('Kein Absturz bei leerem Stundenlohn (Fixgehalt): Anzeigen nutzen den Satz nur für Stundenlohn/Minijob', () => {
  const pay = read('src/pages/Payroll.jsx')
  for (const m of pay.matchAll(/(\w+)\.hourly_rate\.toFixed/g)) assert.fail('toFixed auf hourly_rate in Payroll: ' + m[0])
  assert.match(read('src/lib/compensation.js'), /return payTypeOf\(row\) === PAY_FIXED \? '' : row\.hourly_rate\.toFixed/)
  const my = read('src/pages/MyHours.jsx')
  assert.match(my, /employee\.employment_type === 'minijob'\) \{\n\s*const earnings = monthlyHours \* employee\.hourly_rate/)
  assert.match(my, /payTypeOf\(employee\) === PAY_FIXED \? \(<>/)
})

test('Mitarbeiterformular (spätere Änderungen): Regel nach Vergütungsart, Mindestlohn nur bei angegebenem Satz, leerer Satz → NULL', () => {
  const src = read('src/pages/Employees.jsx')
  const save = extractFn(src, 'handleSave')
  assert.match(save, /const rateErr = validateHourlyRate\(\{ pay_type: formPayType, hourly_rate: form\.hourly_rate \}\)/)
  assert.match(save, /const formPayType = payFeatureOn \? payTypeOf\(form\) : PAY_HOURLY/)
  assert.match(save, /if \(rate !== null && rate < MINDESTLOHN\)/)
  assert.match(save, /hourly_rate:\s+rate,/)
  assert.doesNotMatch(save, /if \(!form\.hourly_rate \|\|/, 'alte Bedingung „Stundenlohn immer Pflicht“ entfernt')
  assert.match(src, /value=\{form\.hourly_rate \?\? ''\}/)
  // Liste: Mindestlohn-Warnung nur bei Stundenlohn (null < 13,90 wäre in JS true → falscher Alarm bei Fixgehalt ohne Satz)
  assert.match(src, /\{payTypeOf\(emp\) !== PAY_FIXED && emp\.hourly_rate < MINDESTLOHN && <span/)
  assert.equal(null < 13.9, true, 'Grund für die Bedingung')
  // Kein grauer Platzhalter-„Wert“ bei Fixgehalt (sah wie ein ausgegrauter, vorbelegter Stundenlohn aus)
  assert.match(src, /placeholder=\{payFeatureOn && payTypeOf\(form\) === PAY_FIXED \? '' : String\(MINDESTLOHN\)\}/)
  assert.match(read('src/pages/UserManagement.jsx'), /placeholder=\{payTypeOf\(inviteJob\) === PAY_FIXED \? '' : MINDESTLOHN/)
  const onb = read('src/components/OnboardingReview.jsx')
  assert.match(onb, /placeholder=\{payTypeOf\(job\) === PAY_FIXED \? '' : MINDESTLOHN/)
  assert.doesNotMatch(onb, /if \(!rate \|\| rate <= 0\)/)
  assert.match(onb, /value=\{job\.hourly_rate \?\? ''\}/)
})

test('J) DE/EN: Meldungen und Feldbezeichnung passend zur Vergütungsart', () => {
  for (const k of ['payModel.hourlyOptional', 'payModel.rateInvalid', 'payModel.salaryMissing', 'payModel.fixedNotAllowed', 'ui.fb10bc721e8c', 'payModel.hourlyInternal'])
    assert.ok(de[k] && en[k] && de[k] !== en[k], k)
  assert.equal(de['ui.fb10bc721e8c'], 'Bitte einen Stundenlohn angeben.'); assert.equal(en['ui.fb10bc721e8c'], 'Please enter an hourly rate.')
  assert.match(de['payModel.hourlyOptional'], /optional/); assert.match(en['payModel.hourlyOptional'], /optional/)
  assert.doesNotMatch(de['payModel.hourlyOptional'], /\*/, 'kein Pflicht-Stern bei Fixgehalt')
  assert.match(de['payModel.hourlyInternal'], /nicht verwendet/); assert.match(en['payModel.hourlyInternal'], /not used/)
})
