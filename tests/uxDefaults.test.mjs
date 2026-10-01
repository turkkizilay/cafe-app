// Stundennachweis startet im aktuellen LOKALEN Monat (auch an UTC-/Berlin-Datumskanten und Jahreswechseln);
// bewusste Monatsauswahl bleibt in der laufenden Ansicht, neue Aufrufe (Menü, „Meine Stunden“) tragen keinen Monat.
// Zeitkorrekturen: kein Mitarbeiter vorausgewählt, Platzhalter DE/EN, ohne Auswahl keine Daten und keine Mutation,
// veraltete Antworten beim Wechsel A → B werden verworfen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { currentLocalYm, resolveTimesheetMonth, isValidYm } from '../src/lib/timesheetMonth.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')

test('Stundennachweis: Startmonat = aktueller lokaler Monat (Okt/Dez 2026, Jan 2027, Jahreswechsel)', () => {
  assert.equal(currentLocalYm(new Date(2026, 9, 1, 0, 5)), '2026-10')
  assert.equal(currentLocalYm(new Date(2026, 9, 31, 23, 59)), '2026-10')
  assert.equal(currentLocalYm(new Date(2026, 11, 31, 23, 59)), '2026-12')
  assert.equal(currentLocalYm(new Date(2027, 0, 1, 0, 0)), '2027-01')
  assert.equal(resolveTimesheetMonth(null, new Date(2026, 9, 1)), '2026-10', 'ohne Auswahl → aktueller Monat')
  assert.equal(resolveTimesheetMonth('', new Date(2027, 0, 1)), '2027-01')
  assert.equal(resolveTimesheetMonth('2026-13', new Date(2026, 9, 1)), '2026-10', 'ungültig → aktueller Monat')
  assert.equal(resolveTimesheetMonth('2026-08', new Date(2026, 9, 1)), '2026-08', 'bewusste Auswahl bleibt')
  assert.ok(isValidYm('2026-12') && !isValidYm('2026-1') && !isValidYm('2026-00'))
})

test('Stundennachweis: Datumskante UTC ↔ Europe/Berlin – lokale Uhr des Geräts entscheidet', () => {
  const script = `import { currentLocalYm } from './src/lib/timesheetMonth.js'
    console.log(JSON.stringify(['2026-09-30T22:30:00Z', '2026-12-31T23:30:00Z', '2026-10-31T23:30:00Z'].map(s => currentLocalYm(new Date(s)))))`
  const run = tz => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }))
  // 30.09. 22:30 UTC = 01.10. 00:30 Berlin; 31.12. 23:30 UTC = 01.01.2027 00:30 Berlin; 31.10. 23:30 UTC = 01.11. 00:30 (Winterzeit)
  assert.deepEqual(run('Europe/Berlin'), ['2026-10', '2027-01', '2026-11'])
  assert.deepEqual(run('UTC'), ['2026-09', '2026-12', '2026-10'])
})

test('Stundennachweis: neue Aufrufe tragen keinen Monat; Auswahl in der Ansicht bleibt (URL), Seite nutzt die Hilfsfunktion', () => {
  const ts = read('src/pages/Timesheet.jsx')
  assert.match(ts, /const ym = resolveTimesheetMonth\(params\.get\('monat'\)\)/)
  assert.match(ts, /const nowYm = currentLocalYm\(\)/)
  assert.doesNotMatch(ts, /toLocalDateStr\(\)\.slice\(0, 7\)|toISOString\(\)\.slice\(0, ?7\)/)
  assert.match(ts, /setParam\('monat', shiftMonth\(ym, -1\)\)/, 'Monatswechsel in der Ansicht über URL')
  // Ursache des Fehlers: „Meine Stunden“ verlinkte mit dem Monat des Wochen-Montags (01.10.2026 → 28.09. → September)
  assert.match(read('src/pages/MyHours.jsx'), /<Link to="\/stundennachweis" className="btn btn-sm">/)
  for (const f of ['src/pages/MyHours.jsx', 'src/components/Layout/Sidebar.jsx', 'src/pages/Payroll.jsx', 'src/pages/Dashboard.jsx'])
    assert.doesNotMatch(read(f), /stundennachweis\?monat=/, f)
})

test('Zeitkorrekturen: kein Mitarbeiter vorausgewählt, Platzhalter zuerst, ohne Auswahl keine Daten/Aktion', () => {
  const tm = read('src/pages/TimeManagement.jsx')
  assert.match(tm, /const \[filterEmp, +setFilterEmp\] += useState\(''\)/)
  assert.doesNotMatch(tm, /setFilterEmp\(first|find\(e => e\.is_active\) \|\| data\?\.\[0\]/, 'keine automatische Auswahl')
  assert.match(tm, /\.then\(\(\{ data \}\) => setEmployees\(data \|\| \[\]\)\)/)
  assert.match(tm, /\[\{ id: '', placeholder: true \}, \.\.\.employees\]\.map\(e => <option key=\{e\.id \|\| 'none'\} value=\{e\.id\}>\{e\.placeholder \? tr\("time\.selectEmployee"\)/)
  assert.match(tm, /if \(filterEmp\) \{ fetchEntries\(\); return \}\n\s+fetchSeq\.current\+\+\s+\/\/[^\n]*\n\s+setEntries\(\[\]\); setBreaksByEntry\(\{\}\); setLoading\(false\)/)
  assert.match(tm, /useRefreshHandler\(\(\) => \(filterEmp \? fetchEntries\(\) : null\)\)/)
  assert.match(tm, /onClick=\{openAdd\} disabled=\{!filterEmp\}/)
  assert.match(tm, /function openAdd\(\) \{\n\s+if \(!filterEmp\) \{ toast\.warn/)
  assert.match(tm, /async function doSave\(\) \{\n\s+if \(!form\.employee_id\) \{ toast\.warn/, 'nie ohne Mitarbeiter speichern')
  assert.match(tm, /\{!filterEmp \? \(\n\s+<div className="empty-state">/)
})

test('Zeitkorrekturen: Wechsel A → B – nur die zuletzt angeforderte Auswahl setzt die Anzeige (echter Code)', async () => {
  const tm = read('src/pages/TimeManagement.jsx')
  const s = tm.indexOf('async function fetchEntries('); let i = tm.indexOf('{', tm.indexOf(')', s)) + 1, d = 1
  while (d) { const c = tm[i++]; if (c === '{') d++; else if (c === '}') d-- }
  const src = tm.slice(s, i)
  const state = { entries: null, loading: null, breaks: null }
  const fetchSeq = { current: 0 }
  const pending = []
  // Supabase-Nachbildung: jede Abfrage wartet, bis der Test sie freigibt (Reihenfolge der Antworten steuerbar)
  const supabase = { from: () => { let emp; const q = { select: () => q, eq: (k, v) => { emp = v; return q }, gte: () => q, lte: () => q, order: () => q,
    then: (res) => new Promise(r => pending.push({ emp, release: () => r({ data: [{ id: `${emp}-1`, employee_id: emp }], error: null }) })).then(res) }; return q } }
  const make = emp => new Function('supabase', 'fetchSeq', 'getDateRange', 'setLoading', 'setEntries', 'setBreaksOn', 'setBreaksByEntry', 'fetchBreaksForEntries', 'isBreakFeatureMissing', 'toast', 'messageParts', 'appMessage', 'errorMessage', 'filterEmp',
    `return (${src})`)(supabase, fetchSeq, () => ({ start: '2026-10-01', end: '2026-10-31' }), v => { state.loading = v }, v => { state.entries = v }, () => {}, v => { state.breaks = v },
    async ids => ({ byEntry: Object.fromEntries(ids.map(x => [x, []])), error: null }), () => false, { error: () => {} }, x => x, x => x, x => x, emp)
  const a = make('A')(), b = make('B')()
  await new Promise(r => setImmediate(r))
  pending.find(p => p.emp === 'B').release(); await b           // B antwortet zuerst
  pending.find(p => p.emp === 'A').release(); await a           // A (veraltet) antwortet später
  assert.deepEqual(state.entries.map(e => e.employee_id), ['B'], 'Daten von B bleiben, A wird verworfen')
  assert.deepEqual(Object.keys(state.breaks), ['B-1'])
  assert.equal(state.loading, false)
})

test('Zeitkorrekturen: Speichern ohne Mitarbeiter → Hinweis, KEIN Serveraufruf (echter doSave)', async () => {
  const tm = read('src/pages/TimeManagement.jsx')
  const s = tm.indexOf('async function doSave('); let i = tm.indexOf('{', tm.indexOf(')', s)) + 1, d = 1
  while (d) { const c = tm[i++]; if (c === '{') d++; else if (c === '}') d-- }
  const calls = [], warns = []
  const deps = { badTimes: {}, toast: { warn: m => warns.push(m), error: () => {}, success: () => {} }, appMessage: k => k,
    form: { employee_id: '', reason: 'Korrektur', clock_in_time: '08:00', clock_out_time: '12:00', breaks: [] },
    supabase: { rpc: (...a) => { calls.push(a); return { data: { success: true }, error: null } } }, setSaving: () => {}, correctionPlan: () => ({}), BREAK_ERROR_KEY: {} }
  await new Function(...Object.keys(deps), `return (${tm.slice(s, i)})`)(...Object.values(deps))()
  assert.deepEqual(warns, ['time.selectEmployeeFirst'])
  assert.equal(calls.length, 0, 'keine Mutation ohne Mitarbeiter')
})

test('Platzhalter DE/EN', () => {
  assert.equal(de['time.selectEmployee'], '– Mitarbeiter auswählen –')
  assert.equal(en['time.selectEmployee'], '– Select employee –')
  assert.equal(de['time.selectEmployeeFirst'], 'Bitte zuerst einen Mitarbeiter auswählen.')
  assert.equal(en['time.selectEmployeeFirst'], 'Please select an employee first.')
})
