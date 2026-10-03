// Feiertage (Migration 31) – App-Seite: keine eigene Feiertagsliste/Osterformel im Frontend (einzige Quelle ist die
// View public_holidays), Lohn/DATEV lesen keine Feiertage, Zählung zeitzonenunabhängig, Stundenzettel-Vermerke,
// days_count-Warnung nur als Hinweis. DB-Seite und App↔Server-Abgleich: tests/db/holidays.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { calculateRequestedDays, vacationDaysMismatch } from '../src/lib/vacationLogic.js'

const read = f => readFileSync(f, 'utf8')
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const SRC = walk('src').filter(f => /\.(js|jsx)$/.test(f) && !f.startsWith(join('src', 'i18n')) && !f.startsWith(join('src', 'legal')))
// erwartete Hessen-Feiertage (fachlich bestätigt; identisch mit tests/db/holidays.test.mjs)
const H = {
  2026: ['01-01', '04-03', '04-06', '05-01', '05-14', '05-25', '06-04', '10-03', '12-25', '12-26'],
  2027: ['01-01', '03-26', '03-29', '05-01', '05-06', '05-17', '05-27', '10-03', '12-25', '12-26'],
}
const holidays = Object.entries(H).flatMap(([y, ds]) => ds.map(d => ({ date: `${y}-${d}` })))

test('Eine Quelle: das Frontend enthält keine eigene Feiertagsliste und keine Osterformel; gelesen wird nur public_holidays', () => {
  for (const f of SRC) {
    const s = read(f)
    assert.doesNotMatch(s, /Karfreitag|Ostermontag|Pfingst|Fronleichnam|Himmelfahrt|Allerheiligen|Reformationstag/, `${f}: Feiertagsnamen`)
    assert.doesNotMatch(s, /easter|ostersonntag|%\s*19\b/i, `${f}: Osterberechnung`)
    assert.doesNotMatch(s, /['"]\d{4}-12-2[56]['"]|['"]\d{2}-12-2[56]['"]/, `${f}: feste Feiertagsdaten`)
    assert.doesNotMatch(s, /public_holidays_manual/, `${f}: alte Handliste`)
  }
  const readers = SRC.filter(f => /from\('public_holidays'\)/.test(read(f))).map(f => f.replace(/\\/g, '/')).sort()
  assert.deepEqual(readers, ['src/lib/sickCasesApi.js', 'src/pages/Account.jsx', 'src/pages/MyHours.jsx', 'src/pages/Timesheet.jsx', 'src/pages/Vacation.jsx'])   // sickCasesApi: Fall-Vorschläge (Migration 33)
})

test('Lohn/DATEV und Arbeitszeitmodelle lesen keine Feiertage (Fix berührt keine Vergütungsregel)', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workTimeModels.js', 'src/lib/workHours.js', 'src/lib/sickLeaveLogic.js'])
    assert.doesNotMatch(read(f), /holiday|public_holidays|Feiertag/i, f)
})

test('Zählung über Monats- und Jahreswechsel ist unabhängig von der Browser-Zeitzone', () => {
  const script = `import { calculateRequestedDays } from './src/lib/vacationLogic.js'
    const h = ${JSON.stringify(holidays)}
    const r = [['2026-12-28','2027-01-08'],['2026-12-31','2027-01-01'],['2027-03-25','2027-03-30'],['2027-04-29','2027-05-07'],['2026-10-30','2026-11-03']]
    console.log(JSON.stringify(r.map(([a,b]) => calculateRequestedDays(a, b, h))))`
  const out = tz => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim()
  const expected = JSON.stringify([9, 1, 2, 6, 3])
  for (const tz of ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) assert.equal(out(tz), expected, tz)
})

// Echte Stundenzettel-Berechnung aus Timesheet.jsx
function sheetFns() {
  const src = read('src/pages/Timesheet.jsx')
  const grab = name => { const s = src.indexOf(`function ${name}(`); let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1; while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- } return src.slice(s, i) }
  const toLocalDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const tr = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k)
  return new Function('tr', 'toLocalDateStr', 'sourceLabel', `${grab('monthBounds')}; ${grab('computeSheet')}; return { monthBounds, computeSheet }`)(tr, toLocalDateStr, x => x)
}

test('Stundenzettel: Feiertagsvermerk nur an echten Feiertagen (kein Allerheiligen), Monatswechsel korrekt', () => {
  const { monthBounds, computeSheet } = sheetFns()
  const hol = Object.fromEntries([['2026-12-25', '1. Weihnachtstag'], ['2026-12-26', '2. Weihnachtstag'], ['2027-01-01', 'Neujahr']])
  const emp = { id: 'e1' }
  const nov = computeSheet(emp, { te: [{ id: 't', employee_id: 'e1', date: '2026-11-01', clock_in: '2026-11-01T08:00:00Z', clock_out: '2026-11-01T12:00:00Z', hours_worked: 4 }], vac: [], sick: [], hol }, monthBounds('2026-11'))
  assert.equal(nov.rows.length, 30); assert.equal(nov.rows[0].d, '2026-11-01')
  assert.ok(nov.rows.every(r => !/ui\.7da052b999c6/.test(r.note)), 'kein Feiertagsvermerk im November 2026 (Allerheiligen ist keiner)')
  const dec = computeSheet(emp, { te: [], vac: [{ employee_id: 'e1', start_date: '2026-12-21', end_date: '2027-01-08' }], sick: [], hol }, monthBounds('2026-12'))
  assert.equal(dec.rows.length, 31)
  assert.equal(dec.vacDays, 8, 'Urlaubstage Dezember ohne Wochenende und 25.12.')
  const jan = computeSheet(emp, { te: [], vac: [{ employee_id: 'e1', start_date: '2026-12-21', end_date: '2027-01-08' }], sick: [], hol }, monthBounds('2027-01'))
  assert.equal(jan.vacDays, 5, 'Januar: 01.01. Feiertag, nicht als Urlaubstag')
})

test('days_count-Warnung: nur Hinweis, nur für geladene Jahre, Anzeige nur für Manager/Admin ohne Schreibaufruf', () => {
  const years = [2026, 2027]
  assert.equal(vacationDaysMismatch({ start_date: '2027-03-22', end_date: '2027-03-31', days_count: 8 }, holidays, years), 6)
  assert.equal(vacationDaysMismatch({ start_date: '2027-03-22', end_date: '2027-03-31', days_count: 6 }, holidays, years), null)
  assert.equal(vacationDaysMismatch({ start_date: '2028-01-03', end_date: '2028-01-07', days_count: 9 }, holidays, years), null, 'nicht geladenes Jahr')
  assert.equal(vacationDaysMismatch({ start_date: '2026-12-21', end_date: '2026-12-31' }, holidays, years), null, 'ohne days_count')
  const v = read('src/pages/Vacation.jsx')
  assert.match(v, /\{canManage && \(\(\) => \{\n\s*const expected = vacationDaysMismatch\(v, holidays, holidayYears\)/)
  assert.match(v, /tab === 'urlaub' && canManage && \(\(\) => \{/)
  assert.doesNotMatch(v.slice(v.indexOf('vacationDaysMismatch(v, holidays'), v.indexOf('vacationDaysMismatch(v, holidays') + 600), /supabase|update\(|insert\(/)
  assert.equal(calculateRequestedDays('2026-12-21', '2026-12-31', holidays), 8)
})
