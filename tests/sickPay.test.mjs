// Krankheit ≠ Datei: Eine fehlende AU-/Attest-Datei in der App führt nicht mehr automatisch zu 0 bezahlten
// Krankheitsstunden (eAU: gesetzlich Versicherte legen keine Bescheinigung vor, § 5 Abs. 1a EFZG).
// Bewusst UNVERÄNDERT (offene Fachentscheidungen): 42-Tage-Grenze je Datensatz, Urlaub + Krankheit, Feiertage, Wartezeit.
// Prüft die echte getPaidAbsenceDays aus Payroll.jsx, die echte Vergütung und den echten DATEV-Export.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { monthlyGross, sickPayAmount, datevRateCell, datevHintCell } from '../src/lib/compensation.js'

const toLocalDateStr = (x = new Date()) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
const grabFn = (src, name) => { const s = src.indexOf(`function ${name}(`); let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1; while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- } return src.slice(s, i) }
const load = src => new Function('toLocalDateStr', `return (${grabFn(src, 'getPaidAbsenceDays')})`)(toLocalDateStr)
const NOW = readFileSync('src/pages/Payroll.jsx', 'utf8')
const OLD = execFileSync('git', ['show', '8cffd70:src/pages/Payroll.jsx'], { encoding: 'utf8' })   // fester Stand VOR dem Fix (Commit 8cffd70) – bleibt auch nach weiteren Commits der Vergleich
const paid = load(NOW), paidOld = load(OLD)

const add = (ds, n) => { const x = new Date(ds + 'T12:00:00'); x.setDate(x.getDate() + n); return toLocalDateStr(x) }
// Krankmeldung wie in der DB: continued_pay_end = start + 42 (Trigger), Nachweis-Varianten
const leave = (start, end, evidence = 'none') => ({ start_date: start, end_date: end, continued_pay_end: add(start, 42),
  certificate_received: evidence !== 'none', certificate_file_path: evidence === 'file' ? `e/${start}.pdf` : null })
const OCT = ['2026-10-01', '2026-10-31']
const run = (fn, leaves, vac = [], worked = [], range = OCT) => fn(vac, leaves, new Set(worked), ...range)

test('Krankheit ohne Datei wird nicht mehr allein wegen fehlender Datei mit 0 bezahlt (vorher 0)', () => {
  for (const [s, e, days] of [['2026-10-07', '2026-10-07', 1], ['2026-10-05', '2026-10-07', 3], ['2026-10-05', '2026-10-16', 10]]) {
    assert.equal(run(paid, [leave(s, e, 'none')]).sickDays, days, `${s}–${e}`)
    assert.equal(run(paidOld, [leave(s, e, 'none')]).sickDays, 0, 'Altverhalten (Fehler) belegt')
  }
})

test('Mit Datei unverändert; eAU ohne App-Datei (Nachweis außerhalb der App) technisch abbildbar und bezahlt', () => {
  for (const ev of ['file', 'eau', 'none']) assert.equal(run(paid, [leave('2026-10-05', '2026-10-09', ev)]).sickDays, 5, ev)
  assert.equal(run(paidOld, [leave('2026-10-05', '2026-10-09', 'file')]).sickDays, 5)
})

test('Datei allein erzeugt keinen zusätzlichen Anspruch: gleiche Tage mit/ohne Datei, nichts außerhalb des Zeitraums, Doppelmeldungen einmal', () => {
  const a = run(paid, [leave('2026-10-05', '2026-10-09', 'file')]), b = run(paid, [leave('2026-10-05', '2026-10-09', 'none')])
  assert.deepEqual(a, b)
  // Tag 43+ (continued_pay_end überschritten) zählt auch mit Datei nicht
  assert.equal(run(paid, [leave('2026-08-03', '2026-10-30', 'file')]).sickDays, 0)
  assert.equal(run(paid, [leave('2026-08-03', '2026-10-30', 'none')]).sickDays, 0)
  // zwei überlappende Meldungen (mit und ohne Datei) → jeder Tag einmal
  assert.equal(run(paid, [leave('2026-10-05', '2026-10-09', 'file'), leave('2026-10-07', '2026-10-09', 'none')]).sickDays, 5)
  // an Tagen mit erfasster Arbeitszeit kein zusätzlicher Krankheitstag
  assert.equal(run(paid, [leave('2026-10-07', '2026-10-07', 'file')], [], ['2026-10-07']).sickDays, 0)
})

test('Unverändert: Urlaub + Krankheit (ohne Nachweis bleibt Urlaubstag, mit Nachweis Krankheitstag), 42 Tage je Datensatz, Feiertag, Wochenende', () => {
  const vac = [{ start_date: '2026-10-05', end_date: '2026-10-09' }]
  for (const ev of ['none', 'file', 'eau']) assert.deepEqual(run(paid, [leave('2026-10-07', '2026-10-07', ev)], vac), run(paidOld, [leave('2026-10-07', '2026-10-07', ev)], vac), ev)
  assert.deepEqual(run(paid, [leave('2026-10-07', '2026-10-07', 'none')], vac), { vacationDays: 5, sickDays: 0 })
  assert.deepEqual(run(paid, [leave('2026-10-07', '2026-10-07', 'file')], vac), { vacationDays: 4, sickDays: 1 })
  const SEP = ['2026-09-01', '2026-09-30']
  assert.equal(run(paid, [leave('2026-08-03', '2026-09-30', 'file')], [], [], SEP).sickDays, 10, '42-Tage-Grenze wie bisher (inkl. Tag 43)')
  assert.equal(run(paid, [leave('2026-08-03', '2026-09-11', 'file'), leave('2026-09-12', '2026-09-30', 'file')], [], [], SEP).sickDays, 22, 'Folge-AU je Datensatz wie bisher')
  assert.equal(run(paid, [leave('2026-12-24', '2026-12-28', 'file')], [], [], ['2026-12-01', '2026-12-31']).sickDays, 3, 'Feiertag wie bisher')
  assert.equal(run(paid, [leave('2026-10-10', '2026-10-11', 'none')]).sickDays, 0, 'Wochenende wie bisher')
})

test('Äquivalenz: hat jede Krankmeldung einen Nachweis, ist das Ergebnis identisch mit vorher; ohne Nachweis nie weniger', () => {
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
  const base = '2026-09-20'
  for (let k = 0; k < 400; k++) {
    const leaves = Array.from({ length: 1 + rnd(3) }, () => { const s = add(base, rnd(40)); return leave(s, rnd(4) ? add(s, rnd(12)) : null, ['none', 'file', 'eau'][rnd(3)]) })
    const vac = rnd(2) ? [{ start_date: add(base, rnd(40)), end_date: add(base, 40 + rnd(10)) }] : []
    const worked = Array.from({ length: rnd(4) }, () => add(base, rnd(45)))
    const allProof = leaves.map(l => ({ ...l, certificate_received: true }))
    assert.deepEqual(run(paid, allProof, vac, worked), run(paidOld, allProof, vac, worked), `#${k}`)
    const n = run(paid, leaves, vac, worked), o = run(paidOld, leaves, vac, worked)
    assert.ok(n.sickDays >= o.sickDays && n.sickDays + n.vacationDays >= o.sickDays + o.vacationDays, `#${k}`)
  }
})

// Brutto je Beschäftigungsart (wie Payroll: dailyH = Wochenstunden / 5, Brutto aus monthlyGross)
const gross = (emp, leaves, worked = 0) => { const { sickDays, vacationDays } = run(paid, leaves); const dh = emp.hours_per_week / 5
  return { sickH: sickDays * dh, gross: monthlyGross(emp, worked + (sickDays + vacationDays) * dh), sickPay: sickPayAmount(emp, sickDays * dh) } }
const EMP = {
  vollzeit:    { employment_type: 'vollzeit', pay_type: 'hourly', hourly_rate: 15, hours_per_week: 40 },
  teilzeit:    { employment_type: 'teilzeit', pay_type: 'hourly', hourly_rate: 15, hours_per_week: 20 },
  werkstudent: { employment_type: 'werkstudent', pay_type: 'hourly', hourly_rate: 14, hours_per_week: 20 },
  minijob:     { employment_type: 'minijob', pay_type: 'hourly', hourly_rate: 13.9, hours_per_week: 10 },
  fixgehalt:   { employment_type: 'vollzeit', pay_type: 'fixed', monthly_salary: 3000, hourly_rate: null, hours_per_week: 40 },
}

test('Stundenlohn (Vollzeit/Teilzeit), Werkstudent, Minijob: 5 Krankheitstage ohne Datei = mit Datei; Fixgehalt unverändert', () => {
  const week = ev => [leave('2026-10-05', '2026-10-09', ev)]
  const expect = { vollzeit: 600, teilzeit: 300, werkstudent: 280, minijob: 139, fixgehalt: 3000 }
  for (const [k, emp] of Object.entries(EMP)) {
    const a = gross(emp, week('none')), b = gross(emp, week('file'))
    assert.deepEqual(a, b, k)
    assert.equal(a.gross, expect[k], k)
  }
  assert.equal(gross(EMP.fixgehalt, []).gross, 3000, 'Fixgehalt ohne Krankheit gleich')
  assert.equal(gross(EMP.fixgehalt, [leave('2026-10-05', '2026-10-09', 'none')]).sickPay, 0)
})

test('DATEV: Spalten/Format unverändert; Krankheitsstunden und Brutto erscheinen jetzt auch ohne Datei', () => {
  const start = NOW.indexOf('function exportDATEV(')
  assert.equal(grabFn(NOW, 'exportDATEV'), grabFn(OLD, 'exportDATEV'), 'exportDATEV byte-gleich (eingefroren)')
  let blob
  const exportDATEV = new Function('saveFile', 'datevRateCell', 'datevHintCell', `return (${grabFn(NOW, 'exportDATEV')})`)(b => { blob = b }, datevRateCell, datevHintCell)
  assert.ok(start > 0)
  const g = gross(EMP.teilzeit, [leave('2026-10-05', '2026-10-09', 'none')], 60)
  exportDATEV([{ ...EMP.teilzeit, personnel_number: '1001', first_name: 'Test', last_name: 'Person', monthTarget: 86, actualHours: 60, vacationHours: 0,
    sickHours: g.sickH, overtime: 0, total: g.gross, isAlert: false }], 'Oktober 2026')
  return blob.text().then(t => {
    const [head, line] = t.replace(/^﻿/, '').split('\n')
    assert.equal(head, '"Personalnummer";"Nachname";"Vorname";"Beschäftigungsart";"Stunden Soll";"Stunden Ist";"Urlaubsstunden (§11 BUrlG)";"Krankheitsstunden (Lohnfortzahlung §3 EFZG)";"Überstunden";"Stundenlohn EUR";"Bruttolohn EUR";"Hinweise"')
    assert.equal(line, '"1001";"Person";"Test";"Teilzeit";"86,00";"60,00";"0,00";"20,00";"0,00";"15,00";"1200,00";""')
  })
})

test('Fix ist rein rechnerisch: keine neuen Schreibzugriffe, kein Backfill, Daten bleiben unverändert', () => {
  const calls = s => [...s.matchAll(/\.(from|rpc|insert|update|upsert|delete)\s*\(/g)].length
  assert.equal(calls(NOW), calls(OLD))
  assert.equal(NOW.match(/supabase\.from\('sick_leave'\)[^\n]*/)[0], OLD.match(/supabase\.from\('sick_leave'\)[^\n]*/)[0], 'gleiche Abfrage')
  assert.doesNotMatch(grabFn(NOW, 'getPaidAbsenceDays'), /if \(!hasAttest\) return false/)
})
