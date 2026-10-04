// Schichtplan-Zeitfelder im 24-Stunden-Format (TimeInput24): kein AM/PM, kein unbrauchbarer Zwischenzustand.
// Ursache des Bugs: natives <input type="time"> formatiert nach Browser-/OS-Locale (12 h mit AM/PM möglich); gelöschte
// Segmente machen den Wert leer und das kontrollierte Feld hängt. Hier: Parser-Regeln + echter Browser-Test der
// React-Komponente (Headless Chrome mit englischer Browsersprache, echte input/focusout-Events).
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseTime24, parseCompleteTime24, sanitizeTimeDraft } from '../src/lib/time24.js'

test('parseTime24: eindeutige 24-h-Normalisierung, nie 12-h-Deutung, Unvollständiges/Ungültiges → null', () => {
  const ok = { '08:30': '08:30', '8:30': '08:30', '8.30': '08:30', '8,30': '08:30', '0830': '08:30', '830': '08:30', '8': '08:00', '18': '18:00',
    '00:00': '00:00', '0': '00:00', '23:59': '23:59', '2359': '23:59', ' 18:00 ': '18:00', '18h30': '18:30', '12:00': '12:00' }
  for (const [i, o] of Object.entries(ok)) assert.equal(parseTime24(i), o, i)
  for (const bad of ['', '8:3', '24:00', '24', '12:60', '1:2:3', 'ab', '08:30 AM', '8 PM', '123456', ':30', '08:', null, undefined]) assert.equal(parseTime24(bad), null, String(bad))
  assert.equal(sanitizeTimeDraft('08:30 AM'), '08:30')
  assert.equal(sanitizeTimeDraft('abc'), '')
  assert.equal(sanitizeTimeDraft('18.305'), '18.30')
})

test('parseCompleteTime24: beim Tippen gilt nur eine vollständige Uhrzeit – Kurzformen bleiben Zwischenstand', () => {
  for (const partial of ['1', '18', '18:', '18:0', '8', '830', '083', '183', '', '18:00 x']) assert.equal(parseCompleteTime24(partial), null, partial)
  const ok = { '18:00': '18:00', '1800': '18:00', '8:30': '08:30', '8.30': '08:30', '0830': '08:30', '00:00': '00:00' }
  for (const [i, o] of Object.entries(ok)) assert.equal(parseCompleteTime24(i), o, i)
  assert.equal(parseCompleteTime24('25:00'), null)
})

test('Schichtplan: kein natives Zeitfeld mehr; Anlegen + Bearbeiten nutzen TimeInput24; Speichern prüft weiter auf leere Zeit', () => {
  const s = readFileSync('src/pages/Shifts.jsx', 'utf8')
  assert.doesNotMatch(s, /type="time"/)
  assert.equal((s.match(/<TimeInput24 value=\{form\.start_time\} onChange=\{v => f\('start_time', v\)\}/g) || []).length, 2, 'Beginn in beiden Dialogen')
  assert.equal((s.match(/<TimeInput24 value=\{form\.end_time\} onChange=\{v => f\('end_time', v\)\}/g) || []).length, 2, 'Ende in beiden Dialogen')
  assert.match(s, /if \(!form\.employee_id \|\| !form\.date \|\| !form\.start_time \|\| !form\.end_time\)/, 'Anlegen ohne gültige Zeit blockiert')
  assert.match(s, /if \(!form\.start_time \|\| !form\.end_time\) \{ toast\.warn/, 'Bearbeiten ohne gültige Zeit blockiert')
  const c = readFileSync('src/components/UI/TimeInput24.jsx', 'utf8')
  assert.match(c, /type="text" inputMode="numeric"/, 'kein Locale-abhängiges Zeit-Widget')
  assert.match(c, /const p = parseCompleteTime24\(next\)\s*\n\s*emit\(p \|\| '', next !== '' && !p\)/, 'beim Tippen nur vollständige Uhrzeiten nach außen')
  const blur = c.slice(c.indexOf('onBlur={'), c.indexOf('/>', c.indexOf('onBlur={')))
  assert.doesNotMatch(blur, /emit\(|onChange\(/, 'Verlassen des Feldes ändert nie den Formularwert (sonst verschiebt sich das Layout unter dem Mausklick)')
  assert.match(blur, /const p = parseCompleteTime24\(draft\)\s*\n\s*if \(p && p !== draft\) setDraft\(p\)/, 'nur Anzeige-Formatierung')
  assert.match(c, /position: 'relative', height: 0/, 'Hinweis ohne Layout-Verschiebung')
  assert.match(s, /\} else \{\s*\n\s*setArbzgWarnings\(\[\]\)/, 'keine ArbZG-Warnungen auf Basis eines unvollständigen/alten Werts')
})

// ── Echter Browser ──
const CANDIDATES = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
const CHROME = CANDIDATES.find(p => existsSync(p))
let R = null, SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'

const ENTRY = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import TimeInput24 from ${JSON.stringify(resolve('src/components/UI/TimeInput24.jsx'))}
document.documentElement.lang = 'en'   // App auf Englisch – der Fall, in dem natives type=time AM/PM zeigen kann
let form = { start_time: '08:00' }, setExternal
const log = []   // jeder Wert, der das Formular erreicht (= was Validierung/ArbZG sehen würden)
function Harness() {
  const [f, setF] = useState(form)
  setExternal = v => setF(x => ({ ...x, start_time: v }))
  form = f
  return <TimeInput24 id="t" value={f.start_time} onChange={(v, meta) => { log.push([v, !!meta?.incomplete]); setF(x => ({ ...x, start_time: v })) }} invalidText="INVALID" />
}
const root = createRoot(document.getElementById('app'))
flushSync(() => root.render(<Harness />))
const el = () => document.getElementById('t')
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
const type = v => flushSync(() => { setter.call(el(), v); el().dispatchEvent(new Event('input', { bubbles: true })) })
const blur = () => flushSync(() => el().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
const snap = () => ({ shown: el().value, form: form.start_time, type: el().type, invalid: el().getAttribute('aria-invalid'), hint: document.getElementById('app').textContent.includes('INVALID') })
const out = {}
out.initial = snap()
type('08:3'); out.partial = snap()                 // Teil einer Uhrzeit gelöscht
type(''); out.cleared = snap()                     // komplett gelöscht
blur(); out.clearedBlur = snap()
type('18:30 PM'); out.amPmTyped = snap()           // AM/PM-Reste werden ignoriert
type('25:00'); blur(); out.invalid = snap()        // ungültig → markiert, Formular leer
type('2315'); out.recovered = snap()               // danach wieder gültige Eingabe möglich
blur(); out.recoveredBlur = snap()
log.length = 0; type('8'); const n8 = log.length; blur(); out.single = { ...snap(), blurEmits: log.length - n8 }
log.length = 0; type('18.30'); const nDot = log.length; blur(); out.dot = { ...snap(), blurEmits: log.length - nDot }
flushSync(() => setExternal('22:00')); out.external = snap()   // Schicht zum Bearbeiten geladen
// „18“ als Zwischenzustand: nichts Halbes ans Formular, erst „18:00“ bzw. Verlassen liefert 18:00
log.length = 0
const steps = []
for (const v of ['', '1', '18', '18:', '18:0']) { type(v); steps.push(snap()) }
out.typing18 = { steps, log: log.slice() }
type('18:00'); out.typed1800 = { snap: snap(), log: log.slice() }
log.length = 0; type(''); type('1'); type('18'); out.short18 = { before: snap(), log: log.slice() }; blur(); out.short18.after = snap(); out.short18.logAfter = log.slice()
// komplett löschen und neu eingeben
log.length = 0; type(''); for (const v of ['0', '07', '07:', '07:4', '07:45']) type(v); out.retype = { snap: snap(), log: log.slice() }
// ungültig → Formular erfährt „unvollständig“ (für Felder, in denen leer eine Bedeutung hat)
log.length = 0; type('25:00'); blur(); out.flag = { snap: snap(), log: log.slice() }
// Vorbelegter Wert („16:00“, Zeitkorrektur-Ende) Zeichen für Zeichen gelöscht: zuletzt „leer + vollständig“ melden,
// sonst bleibt das Formular als „unvollständig“ blockiert, obwohl das Feld leer ist (Production-Fall 04.10.2026)
flushSync(() => setExternal('16:00')); log.length = 0
for (const v of ['16:0', '16:', '16', '1', '']) type(v)
out.backspace = { snap: snap(), log: log.slice() }
flushSync(() => setExternal('16:00')); log.length = 0; type(''); out.clearAll = { snap: snap(), log: log.slice() }
document.getElementById('out').textContent = JSON.stringify(out)
`

before(async () => {
  if (!CHROME) return
  const dir = mkdtempSync(join(tmpdir(), 'cafe-time24-'))
  try {
    const esbuild = await import('esbuild')
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })).outputFiles[0].text
    const file = join(dir, 'page.html')
    writeFileSync(file, `<!doctype html><html lang="de"><body><div id="app"></div><pre id="out"></pre><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    R = await new Promise((res, rej) => {
      const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-background-networking',
        '--disable-sync', '--lang=en-US', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', pathToFileURL(file).href], { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      const done = (fn, v) => { clearTimeout(timer); ch.kill('SIGKILL'); fn(v) }
      const timer = setTimeout(() => done(rej, new Error('Chrome lieferte keine Ausgabe (Timeout)')), 30000)
      ch.stdout.on('data', c => { buf += c; const m = buf.match(/<pre id="out">([\s\S]*?)<\/pre>/); if (m && m[1]) done(res, JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))) })
      ch.on('error', e => done(rej, e))
    })
  } catch (e) { SKIP = `Browser-Test nicht ausführbar: ${e.message}` }
  finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Temp-Ordner */ } }
})

test('Browser (Chrome, englische Browsersprache): 24 h ohne AM/PM; Löschen/Teillöschen nie kaputt; jederzeit wieder gültig eingebbar', t => {
  if (SKIP) return t.skip(SKIP)
  assert.deepEqual(R.initial, { shown: '08:00', form: '08:00', type: 'text', invalid: null, hint: false }, '24-h-Anzeige, kein AM/PM')
  assert.deepEqual([R.partial.shown, R.partial.form], ['08:3', ''], 'Teilwert bleibt editierbar, Formular erhält keinen halben Wert')
  assert.deepEqual([R.cleared.shown, R.cleared.form, R.clearedBlur.invalid], ['', '', null], 'leer ist erlaubt (Speichern blockiert per Pflichtprüfung)')
  assert.deepEqual([R.amPmTyped.shown, R.amPmTyped.form], ['18:30', '18:30'], 'AM/PM-Reste ignoriert, 24 h')
  assert.deepEqual([R.invalid.shown, R.invalid.form, R.invalid.invalid, R.invalid.hint], ['25:00', '', 'true', true], 'ungültig sichtbar markiert')
  assert.deepEqual([R.recovered.form, R.recoveredBlur.shown, R.recoveredBlur.invalid, R.recoveredBlur.hint], ['23:15', '23:15', null, false], 'nach Fehler wieder gültig')
  assert.deepEqual([R.single.shown, R.single.form, R.single.invalid, R.single.hint, R.single.blurEmits], ['8', '', 'true', true, 0], 'Kurzform „8“ bleibt unvollständig – kein 08:00 durch Verlassen')
  assert.deepEqual([R.dot.shown, R.dot.form, R.dot.blurEmits], ['18:30', '18:30', 0], 'vollständige Schreibweise „18.30“: Wert beim Tippen, Blur formatiert nur')
  assert.deepEqual([R.external.shown, R.external.form], ['22:00', '22:00'], 'geladener Wert (Bearbeiten) wird übernommen')
})

test('Browser: „18“ ist Zwischenzustand – nie „01:00“ o. ä. ans Formular; erst „18:00“ liefert 18:00; Verlassen ändert nichts; Löschen + Neueingabe', t => {
  if (SKIP) return t.skip(SKIP)
  const { steps, log } = R.typing18
  assert.deepEqual(steps.map(x => x.shown), ['', '1', '18', '18:', '18:0'], 'Eingabe springt nicht zurück')
  assert.ok(steps.every(x => x.form === ''), 'Formular sieht während des Tippens keinen Wert')
  assert.ok(log.every(([v]) => v === ''), `keine Zwischenwerte wie 01:00: ${JSON.stringify(log)}`)
  assert.ok(log.every(([v, incomplete], i) => i === 0 ? true : incomplete), 'als unvollständig gemeldet')
  assert.deepEqual([R.typed1800.snap.shown, R.typed1800.snap.form, R.typed1800.log.at(-1)], ['18:00', '18:00', ['18:00', false]])
  assert.ok(!R.typed1800.log.some(([v]) => v && v !== '18:00'), 'nur der Endwert')
  assert.deepEqual([R.short18.before.shown, R.short18.before.form], ['18', ''], '„18“ ohne Verlassen: lokal, kein Formularwert')
  assert.ok(!R.short18.log.some(([v]) => v), `kein Wert vor dem Verlassen: ${JSON.stringify(R.short18.log)}`)
  assert.deepEqual([R.short18.after.shown, R.short18.after.form, R.short18.after.invalid, R.short18.after.hint], ['18', '', 'true', true], '„18“ + Verlassen: bleibt unvollständig, rot + Hinweis')
  assert.equal(R.short18.logAfter.length, R.short18.log.length, 'Verlassen meldet keinen Wert ans Formular')
  assert.deepEqual([R.retype.snap.shown, R.retype.snap.form], ['07:45', '07:45'])
  assert.deepEqual(R.retype.log.filter(([v]) => v), [['07:45', false]], `nach Löschen nur der vollständige Wert: ${JSON.stringify(R.retype.log)}`)
  assert.deepEqual([R.flag.snap.form, R.flag.snap.invalid, R.flag.log.at(-1)], ['', 'true', ['', true]], 'ungültig → leer + „unvollständig“')
})

test('Browser: vorbelegtes „16:00“ mit Rücktaste ganz gelöscht → zuletzt „leer, vollständig“ gemeldet (leer = offen erlaubt)', t => {
  if (SKIP) return t.skip(SKIP)
  const { snap, log } = R.backspace
  assert.deepEqual([snap.shown, snap.form, snap.invalid, snap.hint], ['', '', null, false], 'Feld leer, nicht markiert')
  assert.deepEqual(log.at(-1), ['', false], `letzte Meldung „leer, vollständig“: ${JSON.stringify(log)}`)
  assert.ok(log.slice(0, -1).every(([v, inc]) => v === '' && inc), 'Zwischenstände unvollständig, nie ein halber Wert')
  assert.deepEqual([R.clearAll.snap.form, R.clearAll.log], ['', [['', false]]], 'auf einmal gelöscht: ebenfalls „leer, vollständig“')
})

// ── Admin-Zeitkorrektur (TimeManagement) ──
function extractFn(file, name) {
  const src = readFileSync(file, 'utf8'); const start = src.indexOf(`async function ${name}(`); assert.ok(start >= 0, name)
  let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return src.slice(start, i)
}

test('Zeitkorrektur: alle vier Zeitfelder 24 h (TimeInput24), Unvollständiges blockiert Speichern (leeres Ende hieße sonst „offen“)', async () => {
  const s = readFileSync('src/pages/TimeManagement.jsx', 'utf8')
  assert.doesNotMatch(s, /type="time"/)
  for (const re of [/<TimeInput24 value=\{form\.clock_in_time\} onChange=\{timeChange\('in', v => f\('clock_in_time', v\)\)\}/,
                    /<TimeInput24 value=\{form\.clock_out_time\} onChange=\{timeChange\('out', v => f\('clock_out_time', v\)\)\}/,
                    /<TimeInput24 aria-label=\{tr\("time\.breakStart"\)\} value=\{b\.start\} onChange=\{timeChange\(`bs:\$\{b\.key\}`, v => setBreak\(i, 'start', v\)\)\}/,
                    /<TimeInput24 aria-label=\{tr\("time\.breakEnd"\)\} value=\{b\.end\} onChange=\{timeChange\(`be:\$\{b\.key\}`, v => setBreak\(i, 'end', v\)\)\}/]) assert.match(s, re)
  assert.match(s, /const timeChange = \(key, apply\) => \(v, meta\) => \{ setBadTimes\(t => \(\{ \.\.\.t, \[key\]: !!meta\?\.incomplete \}\)\); apply\(v\) \}/)
  assert.equal((s.match(/setBadTimes\(\{\}\)/g) || []).length, 2, 'Anlegen + Bearbeiten starten ohne Altlasten')
  assert.match(s, /function removeBreak\(i\) \{[\s\S]*?setBadTimes\(t => \(\{ \.\.\.t, \[`bs:\$\{key\}`\]: false, \[`be:\$\{key\}`\]: false \}\)\)/, 'entfernte Pause blockiert nicht mehr')
  assert.match(s, /clock_in_time:\s+berlinTime\(entry\.clock_in\)/, 'Bearbeiten lädt gespeicherte Werte als HH:MM (Berlin)')
  // Speichern mit unvollständigem Ausstempelfeld: Warnung, KEIN Serveraufruf (sonst würde als offene Schicht gespeichert)
  const calls = [], toast = { calls: [], warn: (...a) => toast.calls.push(['warn', ...a]), error: () => {}, success: () => {} }
  const deps = { badTimes: { out: true }, toast, appMessage: k => k, form: { employee_id: 'e1', reason: 'x', clock_in_time: '08:00', clock_out_time: '', breaks: [] },
    supabase: { rpc: (...a) => { calls.push(a); return { data: { success: true }, error: null } } }, setSaving: () => {}, correctionPlan: () => ({}), BREAK_ERROR_KEY: {} }
  await new Function(...Object.keys(deps), `return (${extractFn('src/pages/TimeManagement.jsx', 'doSave')})`)(...Object.values(deps))()
  assert.deepEqual(toast.calls.map(c => c.slice(0, 2)), [['warn', 'time.invalid24']])
  assert.equal(calls.length, 0, 'nichts gespeichert')
})

// ── Schichtplan: §5-Ruhezeit mit Nachbarschichten im DB-Format (HH:MM:SS) ──
test('ArbZG §5: Ruhezeit-Warnung mit DB-Zeiten „HH:MM:SS“ (vorher „…:00:00“ → ungültiges Datum → nie gewarnt)', () => {
  const src = readFileSync('src/pages/Shifts.jsx', 'utf8')
  const start = src.indexOf('function checkArbZG(')
  let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  const fnSrc = src.slice(start, i)
  const pad = n => String(n).padStart(2, '0')
  const deps = {
    shifts: [{ employee_id: 'e1', date: '2026-09-28', start_time: '15:00:00', end_time: '23:00:00' }, { employee_id: 'e1', date: '2026-09-30', start_time: '06:00:00', end_time: '14:00:00' }],
    appMessage: (k, v) => ({ k, v }), formatParam: (_t, n) => n,
    toLocalDateStr: d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  }
  const check = new Function(...Object.keys(deps), `return (${fnSrc})`)(...Object.values(deps))
  const rest = w => w.filter(x => x.k === 'ui.384cf75871d5' || x.k === 'ui.48591bbeef02').map(x => [x.k, Math.round(x.v.p1 * 10) / 10])
  assert.deepEqual(rest(check('e1', '2026-09-29', '06:00', '14:00')), [['ui.384cf75871d5', 7]], 'nur 7 h seit Vortag 23:00')
  assert.deepEqual(rest(check('e1', '2026-09-29', '08:00', '16:00')), [['ui.384cf75871d5', 9]])
  assert.deepEqual(rest(check('e1', '2026-09-29', '12:00', '22:00')), [['ui.48591bbeef02', 8]], 'nur 8 h bis zur Folgeschicht 06:00')
  assert.deepEqual(rest(check('e1', '2026-09-29', '11:00', '18:00')), [], '12 h / 12 h → keine Warnung')
})
