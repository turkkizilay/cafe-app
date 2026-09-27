// Downloads & PDF-Stundennachweis + Mitarbeiter-Anlage mit Vergütung – nur synthetische Daten.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPdf, toWinAnsi, textWidth, fitText, safeFileName } from '../src/lib/pdf.js'
import { timesheetPdf } from '../src/lib/timesheetPdf.js'

const read = f => readFileSync(f, 'utf8')
const latin1 = bytes => Array.from(bytes, b => String.fromCharCode(b)).join('')

// Struktur prüfen wie ein PDF-Leser: Signatur, EOF, startxref → xref, jede Objekt-Adresse zeigt auf "n 0 obj"
function assertValidPdf(bytes) {
  const s = latin1(bytes)
  assert.ok(bytes.length > 500, 'nicht leer')
  assert.equal(s.slice(0, 8), '%PDF-1.4')
  assert.ok(s.trimEnd().endsWith('%%EOF'))
  const startxref = Number(s.match(/startxref\n(\d+)\n%%EOF\s*$/)[1])
  assert.equal(s.slice(startxref, startxref + 4), 'xref')
  const [, first, count] = s.slice(startxref).match(/^xref\n(\d+) (\d+)\n/)
  const entries = s.slice(startxref).split('\n').slice(2, 2 + Number(count))
  entries.slice(1).forEach((line, i) => {
    const off = Number(line.slice(0, 10))
    assert.ok(s.startsWith(`${Number(first) + i + 1} 0 obj`, off), `Objekt ${i + 1} @ ${off}`)
  })
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length
    assert.equal(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream', 'Stream-Länge stimmt')
  }
  return s
}

test('buildPdf erzeugt gültige PDF-Bytes', () => {
  const s = assertValidPdf(buildPdf([[{ t: 'text', x: 40, y: 40, text: 'Hallo (Test) \\ ok', size: 12 }, { t: 'line', x1: 40, y1: 50, x2: 200, y2: 50 }]], { title: 'Test' }))
  assert.match(s, /\(Hallo \\\(Test\\\) \\\\ ok\) Tj/)                // Klammern/Backslash maskiert
  assert.match(s, /\/Count 1 >>/)
})

test('Umlaute, € und Gedankenstrich in WinAnsi; Emoji entfallen', () => {
  assert.deepEqual(toWinAnsi('äöüÄÖÜß'), [0xe4, 0xf6, 0xfc, 0xc4, 0xd6, 0xdc, 0xdf])
  assert.deepEqual(toWinAnsi('€–„“'), [0x80, 0x96, 0x84, 0x93])
  assert.deepEqual(toWinAnsi('⚠️ A'), [0x20, 0x41])
  assert.ok(textWidth('WWW', 10) > textWidth('iii', 10))
  assert.ok(textWidth(fitText('Sehr langer Bemerkungstext für die Spalte', 8.5, 60), 8.5) <= 60)
})

test('Dateiname ohne Sonderzeichen', () => {
  assert.equal(safeFileName('Stundennachweis_Müller_Jörg_2026-09'), 'Stundennachweis_Mueller_Joerg_2026-09')
  assert.equal(safeFileName('Timesheet_O\'Brien Smith/Test_2026-10'), 'Timesheet_O_Brien_Smith_Test_2026-10')
  assert.equal(safeFileName('   '), 'Dokument')
})

const sheet = (name, n, withBreaks) => ({
  cafeName: 'Test-Café', cafeAddress: 'Musterstraße 1\n60311 Frankfurt', title: 'Arbeitszeitnachweis', subtitle: 'gem. § 17 MiLoG', monthLabel: 'September 2026',
  empLines: [['Mitarbeiter/in', name], ['Beschäftigung', 'Teilzeit'], ['Zeitraum', '01.09.2026 – 30.09.2026']],
  header: ['Datum', 'Tag', 'Beginn', 'Ende', 'Pause', 'Stunden', 'Bemerkung'],
  rows: Array.from({ length: n }, (_, i) => ({ weekend: i % 7 > 4, cells: [`${String(i % 30 + 1).padStart(2, '0')}.09.`, 'Mo', '08:00', '16:30', withBreaks ? '30 Min.' : '0 Min.', withBreaks ? '8,00 h' : '8,50 h', i === 3 ? 'Urlaub – sehr lange Bemerkung, die abgeschnitten werden muss' : ''] })),
  sums: [['Summe', '170,00 h'], ['Arbeitstage', '20'], ['Urlaubstage', '1'], ['Krankheitstage', '0']],
  warn: '1 Eintrag noch ohne Arbeitsende.', footnote: 'Tatsächlich erfasste Pausen sind abgezogen.', sign: ['Unterschrift MA', 'Unterschrift AG'], created: 'Erstellt am 27.09.2026',
})

test('Stundennachweis-PDF: gültig, Seitenumbruch, Umlaute, mit/ohne Pausen', () => {
  const one = assertValidPdf(timesheetPdf([sheet('Jörg Müller', 30, true)], { title: 'Arbeitszeitnachweis September 2026' }))
  assert.match(one, /\/Count 1 >>/)
  assert.ok(one.includes('(J\\366rg M\\374ller) Tj'), 'Umlaute als WinAnsi-Oktal-Escape (ö=\\366, ü=\\374)')
  assert.ok(one.includes('(Arbeitszeitnachweis) Tj'))
  assert.ok(one.includes('(30 Min.) Tj'))
  const many = assertValidPdf(timesheetPdf([sheet('A B', 70, false), sheet('C D', 5, true)]))
  assert.match(many, /\/Count [3-9] >>/)                                   // lange Liste → mehrere Seiten, 2. Mitarbeiter eigene Seite
  const empty = assertValidPdf(timesheetPdf([sheet('Leer', 0, false)]))
  assert.match(empty, /\/Count 1 >>/)
})

test('Stundennachweis: Button erzeugt echte PDF-Datei über zentralen Download', () => {
  const src = read('src/pages/Timesheet.jsx')
  assert.match(src, /onClick=\{downloadPdf\}/)
  assert.match(src, /saveFile\(bytes, `\$\{safeFileName\(.*\)\}\.pdf`, 'application\/pdf'\)/)
  assert.match(src, /function computeSheet\(emp, data, b\)/)
  assert.equal((src.match(/computeSheet\(emp, data, b\)/g) || []).length, 3)   // Definition + Ansicht + PDF
  assert.match(src, /onClick=\{\(\) => window\.print\(\)\}/)                   // Drucken bleibt zusätzlich
})

test('Zentraler Download-Helfer: URL nicht sofort freigeben, Link im Dokument, iOS teilen', () => {
  const dl = read('src/lib/download.js')
  assert.match(dl, /document\.body\.appendChild\(a\); a\.click\(\); a\.remove\(\)/)
  assert.match(dl, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 60000\)/)
  assert.match(dl, /navigator\.share\(\{ files: \[file\]/)
  const payroll = read('src/pages/Payroll.jsx')
  const datev = payroll.slice(payroll.indexOf('function exportDATEV('), payroll.indexOf('export default function Payroll'))
  assert.match(datev, /saveFile\(blob, `Cafe-Buur-Lohn-\$\{monthLabel\}\.csv`, 'text\/csv;charset=utf-8;'\)/)
  assert.doesNotMatch(datev, /revokeObjectURL/)
})

test('Fußnote Stundennachweis: keine Aussage über automatische Pausen nach § 4 ArbZG', async () => {
  const { de, en } = await import('../src/i18n/catalogs.js')
  assert.doesNotMatch(de['ui.9f9667bee298'], /§ 4 ArbZG/)
  assert.match(de['ui.9f9667bee298'], /Tatsächlich erfasste Pausen/)
  assert.match(en['ui.9f9667bee298'], /Actually recorded breaks/)
})

test('Mitarbeiter einladen / freischalten: Vergütung wie im Mitarbeiterformular', () => {
  const um = read('src/pages/UserManagement.jsx')
  assert.match(um, /validatePayModel\(\{ employment_type: inviteJob\.employment_type, pay_type: payTypeOf\(inviteJob\), monthly_salary: inviteJob\.monthly_salary \}\)/)
  assert.match(um, /pay_type: payTypeOf\(inviteJob\),\s*\n\s*monthly_salary: payTypeOf\(inviteJob\) === PAY_FIXED \? parseMonthlySalary\(inviteJob\.monthly_salary\) : null,/)
  assert.match(um, /pay_type: canHaveFixedPay\(t\) \? payTypeOf\(j\) : PAY_HOURLY/)       // Wechsel zu Werkstudent/Minijob → Stundenlohn
  assert.match(um, /<PayModelFields name="invite_pay_type"/)
  const onb = read('src/components/OnboardingReview.jsx')
  assert.match(onb, /pay_type: payTypeOf\(j\),/)                                            // Vorbelegung aus Einladung
  assert.match(onb, /validatePayModel\(\{ employment_type: job\.employment_type, pay_type: payTypeOf\(job\), monthly_salary: job\.monthly_salary \}\)/)
  assert.match(onb, /if \(payTypeOf\(job\) === PAY_FIXED\) \{\s*\n\s*const \{ error: payError \} = await setEmployeePay\(data\.employee_id, PAY_FIXED, parseMonthlySalary\(job\.monthly_salary\)\)/)
  assert.match(onb, /if \(!canHaveFixedPay\(e\.target\.value\)\) setJ\('pay_type', PAY_HOURLY\)/)
  const fields = read('src/components/PayModelFields.jsx')
  assert.match(fields, /disabled=\{!fixedOk\}/)
  assert.match(read('src/lib/compensationApi.js'), /update\(\{ pay_type: payType, monthly_salary: payType === PAY_FIXED \? monthlySalary : null \}\)/)
})

test('DATEV-Export zur Laufzeit: echte exportDATEV-Funktion erzeugt gültige CSV (Stundenlohn + Fixgehalt)', async () => {
  const { datevRateCell, datevHintCell } = await import('../src/lib/compensation.js')
  const src = read('src/pages/Payroll.jsx')
  const start = src.indexOf('function exportDATEV(')
  let i = src.indexOf('{', start) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  let saved = null
  const saveFile = (blob, name, type) => { saved = { blob, name, type } }
  const exportDATEV = new Function('saveFile', 'datevRateCell', 'datevHintCell', `return (${src.slice(start, i)})`)(saveFile, datevRateCell, datevHintCell)
  const rows = [
    { last_name: 'Müller', first_name: 'Jörg', employment_type: 'vollzeit', pay_type: 'hourly', hourly_rate: 15.5, monthTarget: 172, actualHours: 180, vacationHours: 0, sickHours: 8, overtime: 8, total: 2914, isAlert: true },
    { last_name: 'Weiß', first_name: 'Anna', employment_type: 'teilzeit', pay_type: 'fixed', monthly_salary: 2000, hourly_rate: 15, monthTarget: 86, actualHours: 90, vacationHours: 0, sickHours: 0, overtime: 4, total: 2000, isAlert: true, partialMonth: true },
  ]
  exportDATEV(rows, 'September 2026')
  assert.equal(saved.name, 'Cafe-Buur-Lohn-September 2026.csv')
  assert.match(saved.type, /^text\/csv/)
  const bytes = new Uint8Array(await saved.blob.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM für Excel/DATEV')
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1)
  const lines = text.split('\n')
  assert.equal(lines.length, 3)
  const cells = lines.map(l => l.split(';'))
  assert.ok(cells.every(c => c.length === cells[0].length), 'gleiche Spaltenzahl')
  assert.ok(cells.flat().every(c => /^".*"$/.test(c)), 'alle Zellen in Anführungszeichen')
  assert.equal(cells[1][1], '"Müller"'); assert.equal(cells[1][2], '"Jörg"')      // Umlaute unverändert (UTF-8)
  assert.equal(cells[1][9], '"15,50"'); assert.equal(cells[1][10], '"2914,00"'); assert.equal(cells[1][11], '"ÜBERSTUNDEN"')
  assert.equal(cells[2][9], '""'); assert.equal(cells[2][10], '"2000,00"'); assert.equal(cells[2][11], '"FIXGEHALT / TEILMONAT PRÜFEN / ÜBERSTUNDEN"')
  assert.equal(cells[1][4], '"172,00"'); assert.equal(cells[2][4], '"86,00"')     // Soll nach Arbeitszeitmodell
})

test('Stundennachweis „PDF herunterladen“ zur Laufzeit: echte PDF-Datei, kein Druckdialog', async () => {
  const { timesheetPdf } = await import('../src/lib/timesheetPdf.js')
  const src = read('src/pages/Timesheet.jsx')
  const start = src.indexOf('function downloadPdf()')
  let i = src.indexOf('{', start) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  const TR = { 'timesheet.fileName': 'Arbeitszeitnachweis', 'ui.2ee8d088f45d': 'Arbeitszeitnachweis' }
  const run = (emps, ym = '2026-09') => {
    const saved = []; let printed = 0
    const deps = {
      data: { te: [] }, sheetEmps: emps, cafe: { cafe_name: 'Test-Café' }, b: {}, monthLabel: 'September 2026', ym,
      tr: k => TR[k] ?? k, timesheetPdf, safeFileName,
      sheetPdfData: emp => sheet(`${emp.first_name} ${emp.last_name}`, 3, true),
      saveFile: (bytes, name, type) => saved.push({ bytes, name, type }),
      window: { print: () => printed++ },
    }
    new Function(...Object.keys(deps), `${src.slice(start, i)}; return downloadPdf()`)(...Object.values(deps))
    return { saved, printed }
  }
  const one = run([{ first_name: 'Jörg', last_name: 'Müller-Lüdenscheidt' }])
  assert.equal(one.saved.length, 1, 'Download ausgelöst')
  assert.equal(one.printed, 0, 'kein window.print()')
  assert.equal(one.saved[0].type, 'application/pdf')
  assert.equal(one.saved[0].name, 'Arbeitszeitnachweis_Joerg_Mueller-Luedenscheidt_2026-09.pdf')
  assertValidPdf(one.saved[0].bytes)
  assert.equal(latin1(one.saved[0].bytes.slice(0, 5)), '%PDF-')
  const long = run([{ first_name: 'Anna-Maria Sophie', last_name: 'von Überlänge-Nachnamenträgerin' }], '2026-10')
  assert.match(long.saved[0].name, /^Arbeitszeitnachweis_Anna-Maria_Sophie_von_Ueberlaenge-Nachnamentraegerin_2026-10\.pdf$/)
  const all = run([{ first_name: 'A', last_name: 'B' }, { first_name: 'C', last_name: 'D' }])
  assert.equal(all.saved[0].name, 'Arbeitszeitnachweis_2026-09.pdf')
  assert.match(latin1(all.saved[0].bytes), /\/Count 2 >>/)                    // ein Blatt je Mitarbeiter
  assert.equal(run([]).saved.length, 0, 'ohne Mitarbeiter kein leerer Download')
})

test('Stundennachweis: getrennte Aktionen – „PDF herunterladen“ und „Drucken“ (DE/EN)', async () => {
  const { de, en } = await import('../src/i18n/catalogs.js')
  const src = read('src/pages/Timesheet.jsx')
  assert.match(src, /onClick=\{downloadPdf\}[^>]*>\{tr\("timesheet\.downloadPdf"\)\}/)
  assert.match(src, /onClick=\{\(\) => window\.print\(\)\}[^>]*>\{tr\("ui\.197d7ae2d1bd"\)\}/)   // Drucken bleibt Druckweg
  const dl = src.slice(src.indexOf('function downloadPdf()'), src.indexOf('const pickerEmps'))
  assert.doesNotMatch(dl, /print/)
  assert.equal(de['ui.197d7ae2d1bd'], '🖨️ Drucken'); assert.equal(en['ui.197d7ae2d1bd'], '🖨️ Print')
  assert.equal(de['timesheet.downloadPdf'], '📄 PDF herunterladen'); assert.equal(en['timesheet.downloadPdf'], '📄 Download PDF')
  for (const cat of [de, en]) assert.doesNotMatch(cat['ui.197d7ae2d1bd'], /PDF/, 'Drucken-Button verspricht keine PDF mehr')
  assert.match(de['ui.73b61df128e0'], /PDF herunterladen/); assert.match(en['ui.73b61df128e0'], /Download PDF/)
})

test('Stundennachweis: Tag/Monat sprachrichtig (DE „01.09.“, EN „01/09“ ohne Schrägstrich am Ende)', async () => {
  const { t, getIntlLocale, setRuntimeLocale } = await import('../src/i18n/runtime.js')
  const src = read('src/pages/Timesheet.jsx')
  const line = src.split('\n').find(l => l.startsWith('const fmtDayMonth'))
  assert.ok(line, 'fmtDayMonth vorhanden')
  const fmtDayMonth = new Function('getIntlLocale', `${line}; return fmtDayMonth`)(getIntlLocale)
  setRuntimeLocale('de'); assert.equal(fmtDayMonth('2026-09-01'), '01.09.')
  setRuntimeLocale('en'); assert.equal(fmtDayMonth('2026-09-01'), '01/09')
  setRuntimeLocale('de')
  assert.doesNotMatch(src, /fmtDate\(r\.d\)\.slice\(0, 6\)/)
  assert.equal((src.match(/fmtDayMonth\(r\.d\)/g) || []).length, 2)      // Ansicht/Druck + PDF
  void t
})
