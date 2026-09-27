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
