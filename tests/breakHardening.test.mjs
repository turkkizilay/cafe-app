// Pausen-/Zeitkorrektur-Härtung (Migration 34): Client-Vorprüfung wie die DB, Altbestand-Regel, Pausenzeiten im
// Stundennachweis, keine direkten Schreibwege im Frontend – und Lohn/DATEV-Code byte-gleich zum Stand davor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { correctionPlan } from '../src/lib/workHours.js'
import { correctionCheck, legacyBreakMinutes, breakTimesLabel } from '../src/lib/breakRules.js'

const read = f => readFileSync(f, 'utf8')
const BEFORE = '2adac7c'   // letzter Stand vor der Härtung (Phase A live)
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })

test('LOHN/DATEV-SICHERHEIT: Lohnberechnung, DATEV und alle Netto-Leser byte-gleich zum Stand vor der Härtung', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workTimeModels.js', 'src/lib/workHours.js',
                   'src/lib/sickLeaveLogic.js', 'src/lib/vacationLogic.js', 'src/pages/MyHours.jsx', 'src/lib/timesheetPdf.js'])
    // Dashboard.jsx ab Live-Personalkosten (Migration 35) bewusst geändert – eigene Absicherung in tests/laborCost.test.mjs
    assert.equal(read(f), atBefore(f), f)
})

test('Altbestand: nur pauschale Minuten OHNE Pausenzeilen gelten als Altbestand', () => {
  assert.equal(legacyBreakMinutes({ break_minutes: 30 }, []), 30)
  assert.equal(legacyBreakMinutes({ break_minutes: 30 }, [{ break_start: 'x' }]), 0, 'aus Pausenzeilen berechnet → kein Altbestand')
  assert.equal(legacyBreakMinutes({ break_minutes: 0 }, []), 0)
  assert.equal(legacyBreakMinutes({ break_minutes: null }), 0)
})

test('Vorprüfung wie die DB: „außerhalb“ vor „Ende vor Beginn“, sonst identisch zu correctionPlan', () => {
  const p = { inT: '09:00', outT: '17:00' }
  assert.deepEqual(correctionCheck({ ...p, breaks: [{ start: '08:30', end: '09:30' }] }).error, { code: 'outside', index: 0 }, 'vor Arbeitsbeginn getippt')
  assert.deepEqual(correctionCheck({ ...p, breaks: [{ start: '12:00', end: '12:30' }, { start: '08:30', end: '09:30' }] }).error, { code: 'outside', index: 1 })
  assert.deepEqual(correctionCheck({ ...p, breaks: [{ start: '12:30', end: '12:00' }] }).error, { code: 'order', index: 0 }, 'negativ')
  assert.deepEqual(correctionCheck({ ...p, breaks: [{ start: '12:00', end: '12:00' }] }).error, { code: 'order', index: 0 }, '0 Minuten')
  assert.deepEqual(correctionCheck({ inT: '14:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:30' }] }).error, { code: 'outside', index: 0 }, 'Beginn hinter Pause')
  assert.deepEqual(correctionCheck({ inT: '11:00', outT: '13:15', breaks: [{ start: '13:00', end: '13:30' }] }).error, { code: 'outside', index: 0 }, 'Ende mitten in Pause')
  for (const c of [{ ...p, breaks: [] }, { ...p, breaks: [{ start: '12:00', end: '12:30' }] }, { inT: '22:00', outT: '06:00', breaks: [{ start: '23:45', end: '00:15' }] },
                   { ...p, breaks: [{ start: '12:00', end: '12:30' }, { start: '12:15', end: '12:45' }] }])
    assert.deepEqual(correctionCheck(c), correctionPlan(c))
  assert.equal(correctionCheck({ inT: '10:00', outT: '18:00', breaks: [{ start: '13:00', end: '13:30' }] }).hours, 7.5)
})

test('Stundennachweis/PDF: Pausenzeiten als Bemerkung – Minuten und Stunden unverändert aus dem Zeiteintrag', () => {
  assert.equal(breakTimesLabel([{ break_start: '2026-08-03T12:00:00Z', break_end: null }], v => new Date(v).toISOString().slice(11, 16)), '12:00–…', 'laufende Pause')
  assert.equal(breakTimesLabel(undefined, x => x), '')
  const iso = [{ break_start: '2026-08-03T13:00:00Z', break_end: '2026-08-03T13:30:00Z' }, { break_start: '2026-08-03T10:00:00Z', break_end: '2026-08-03T10:15:00Z' }]
  const hhmm = v => new Date(v).toISOString().slice(11, 16)
  assert.equal(breakTimesLabel(iso, hhmm), '10:00–10:15, 13:00–13:30', 'sortiert')
  // echte computeSheet aus Timesheet.jsx
  const src = read('src/pages/Timesheet.jsx')
  const grab = name => { const s = src.indexOf(`function ${name}(`); let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1; while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- } return src.slice(s, i) }
  const tr = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k)
  const { computeSheet, monthBounds } = new Function('tr', 'toLocalDateStr', 'sourceLabel', 'breakTimesLabel', 'fmtTime',
    `${grab('monthBounds')}; ${grab('computeSheet')}; return { monthBounds, computeSheet }`)(tr, () => '2026-09-30', x => x, breakTimesLabel, hhmm)
  const te = [{ id: 't1', employee_id: 'e1', date: '2026-08-03', clock_in: '2026-08-03T08:00:00Z', clock_out: '2026-08-03T16:30:00Z', break_minutes: 45, hours_worked: 7.75, notes: '' },
              { id: 't2', employee_id: 'e1', date: '2026-08-04', clock_in: '2026-08-04T08:00:00Z', clock_out: '2026-08-04T12:00:00Z', break_minutes: 30, hours_worked: 3.5, notes: '' }]
  const base = { te, vac: [], sick: [], hol: {} }
  const b = monthBounds('2026-08')
  const without = computeSheet({ id: 'e1' }, base, b), withB = computeSheet({ id: 'e1' }, { ...base, brk: { t1: iso } }, b)
  assert.equal(withB.sumH, without.sumH, 'Summe unverändert')
  assert.equal(withB.sumH, 11.25)
  const r1 = withB.rows.find(r => r.key === 't1'), r2 = withB.rows.find(r => r.key === 't2')
  assert.match(r1.note, /timesheet\.breakTimes:\{"times":"10:00–10:15, 13:00–13:30"\}/)
  assert.doesNotMatch(r2.note, /breakTimes/, 'Altbestand ohne Zeilen: nur Minuten (wie bisher)')
  assert.equal(r1.t.break_minutes, 45)
})

test('Korrektur-Dialog: Person beim Bearbeiten gesperrt, Pauschale nur für Altbestand, RPC-Aufruf unverändert', () => {
  const t = read('src/pages/TimeManagement.jsx')
  assert.match(t, /onChange=\{e => f\('employee_id', e\.target\.value\)\} disabled=\{modal === 'edit'\}/)
  assert.match(t, /break_minutes:\s+legacyBreak,/, 'Bearbeiten: Minutenfeld nur mit Altbestand vorbelegt')
  assert.match(t, /form\.breaks\.length === 0 \? \(form\.legacyBreak > 0 \?/)
  assert.match(t, /\[0, form\.legacyBreak\]\.map\(m => <option/, 'Altbestand: nur beibehalten oder entfernen')
  assert.doesNotMatch(t, /\[0,15,30,45,60\]/, 'keine freie Pauschalauswahl mehr')
  assert.match(t, /p_break_minutes: form\.breaks\.length \? null : \(parseInt\(form\.break_minutes\) \|\| 0\)/)
  assert.doesNotMatch(t, /break_minutes: x\.breaks\.length === 1 \? 0/, 'Entfernen der letzten Pause setzt Altbestand nicht still auf 0')
})

test('Frontend schreibt Pausen/Protokoll nie direkt; Zeiteinträge nur eigenes Ein-/Ausstempeln', () => {
  const files = walk('src').filter(f => /\.(js|jsx)$/.test(f) && !f.includes('/i18n/'))
  for (const f of files) {
    const s = read(f)
    assert.doesNotMatch(s, /from\('time_entry_breaks'\)\s*\.(insert|update|upsert|delete)/, f)
    assert.doesNotMatch(s, /from\('time_corrections'\)\s*\.(insert|update|upsert|delete)/, f)
    if (f !== join('src', 'pages', 'ClockIn.jsx')) assert.doesNotMatch(s, /from\('time_entries'\)\s*\.(insert|update|upsert|delete)/, f)
  }
  assert.doesNotMatch(read('src/lib/breaks.js'), /syncBreaks|logBreakCorrection/, 'toter Direktschreib-Code entfernt')
})

test('Migration 34: keine Datenänderung außerhalb von Funktionen; jede SECURITY-DEFINER-Funktion mit search_path', () => {
  const sql = read('supabase/migrations_onboarding/34_break_hardening.sql')
  const outside = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--.*$/gm, '')
  assert.doesNotMatch(outside, /^\s*(UPDATE\s+\S+\s+SET|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/im, 'kein Backfill, keine Bereinigung')
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?(?:AS \$\$|AS \$function\$)/g))
    if (/SECURITY DEFINER/.test(m[0])) assert.match(m[0], /SET search_path TO 'public'/, m[0].slice(0, 80))
  assert.match(sql, /DROP POLICY IF EXISTS breaks_admin/)
  assert.match(sql, /DROP POLICY IF EXISTS time_admin/)
  assert.match(sql, /DROP POLICY IF EXISTS corr_insert/)
  assert.match(sql, /NEW\.clock_out := clock_timestamp\(\)/)
})
