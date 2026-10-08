// Resilience F2: Stempelstatus explizit (LOADING / WORKING / ON_BREAK / OFF_CLOCK / UNKNOWN). Ein Ladefehler ist NIE
// „ausgestempelt“. Teil 1: reine Ableitung + Quelltext. Teil 2: die ECHTE Seite ClockIn.jsx in Headless Chrome gegen einen
// nachgebildeten Server (nur src/lib/supabase.js ersetzt) – inkl. Gegenprobe mit dem Stand vor F2 (zeigt den Fehler).
// Die Stempel-Regeln selbst prüft der Server (tests/db/time_tracking, break_hardening, remote_clock) – hier unverändert.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attendanceLoadState, deriveClockStatus, CLOCK_STATUS } from '../src/lib/clockStatus.js'

const BEFORE = '3940e9f'   // Stand vor Resilience F1–F4
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

// ── Teil 1: Ableitung ──
test('Ableitung: Fehler → UNKNOWN (nie OFF_CLOCK); OFF_CLOCK nur nach erfolgreicher Abfrage', () => {
  assert.deepEqual(CLOCK_STATUS, ['LOADING', 'WORKING', 'ON_BREAK', 'OFF_CLOCK', 'UNKNOWN'])
  const entry = { id: 't1', clock_in: '2026-10-08T07:00:00Z' }
  assert.equal(deriveClockStatus({ load: 'loading', openEntry: null, breakUi: 'idle' }), 'LOADING')
  assert.equal(deriveClockStatus({ load: 'ok', openEntry: null, breakUi: 'idle' }), 'OFF_CLOCK')
  assert.equal(deriveClockStatus({ load: 'ok', openEntry: entry, breakUi: 'idle' }), 'WORKING')
  assert.equal(deriveClockStatus({ load: 'ok', openEntry: entry, breakUi: 'running' }), 'ON_BREAK')
  assert.equal(deriveClockStatus({ load: 'ok', openEntry: entry, breakUi: 'error' }), 'WORKING', 'Pausenstand unbekannt: eingestempelt bleibt bestätigt')
  for (const openEntry of [null, entry]) for (const breakUi of ['idle', 'running', 'error', 'loading', 'hidden'])
    assert.equal(deriveClockStatus({ load: 'error', openEntry, breakUi }), 'UNKNOWN')
  assert.equal(attendanceLoadState({ employeeError: null, openEntryError: null }), 'ok')
  assert.equal(attendanceLoadState({ employeeError: { message: 'x' }, openEntryError: null }), 'error')
  assert.equal(attendanceLoadState({ employeeError: null, openEntryError: { message: 'x' } }), 'error')
})

function checkClockIn(src) {
  const fd = src.slice(src.indexOf('  async function fetchData() {'), src.indexOf('  async function clockIn() {'))
  assert.match(fd, /const my = \+\+loadSeq\.current/, 'Sequenz-Ref')
  const lb = src.slice(src.indexOf('  async function loadBreaks(entryId) {'), src.indexOf('  // Lokales Datum'))
  assert.match(lb, /const my = \+\+breakSeq\.current[\s\S]*if \(my !== breakSeq\.current\) return/, 'Pausen-Sequenz')
  assert.match(fd, /\{ data: openRows, error: openErr \}/, 'Fehler der Abfrage „offener Eintrag“ wird gelesen')
  assert.match(fd, /attendanceLoadState\(\{ employeeError: empErr, openEntryError: openErr \}\) === 'error'/)
  assert.ok(fd.indexOf("setAttendance('error')") < fd.indexOf('setOpen(openEntry)'), 'bei Fehler wird der offene Eintrag nicht überschrieben')
  assert.doesNotMatch(fd, /setLoading\(true\)/, 'kein Vollbild-Laden nach dem ersten Stand')
  assert.match(src, /const clockStatus\s+= deriveClockStatus\(\{ load: attendance, openEntry, breakUi \}\)/)
  assert.match(src, /\{employee && clockStatus === 'OFF_CLOCK' && \(/, 'Einstempeln nur bei bestätigtem OFF_CLOCK')
  assert.doesNotMatch(src, /\{employee && !openEntry && \(/)
  assert.match(src, /\{employee && openEntry && \(clockStatus === 'WORKING' \|\| clockStatus === 'ON_BREAK'\) && \(/)
  assert.match(src, /data-testid="clock-status-unknown"/)
  for (const fn of ['clockIn', 'onEndBreak', 'clockOut']) assert.match(src, new RegExp(`async function ${fn}\\(\\) \\{\\n    if \\(working \\|\\| attendance !== 'ok'\\) return`), fn)
  assert.match(src, /async function onStartBreak\(\) \{\n    if \(working \|\| !openEntry \|\| attendance !== 'ok'\) return/)
}

test('ClockIn.jsx: Ladefehler → UNKNOWN, Aktionen nur bei bestätigtem Stand, Sequenz-Ref, Laden im Hintergrund', () => {
  checkClockIn(read('src/pages/ClockIn.jsx'))
})
test('Gegenprobe Quelltext: Stand vor F2 erfüllt die Prüfung nicht', () => {
  assert.throws(() => checkClockIn(atBefore('src/pages/ClockIn.jsx')))
})
test('Server-Weg unverändert: dieselben Insert/Update/RPC-Aufrufe wie vorher', () => {
  const calls = s => (s.match(/supabase\.(from|rpc)\([^)]*\)[^\n]*/g) || []).join('\n')
  assert.equal(calls(read('src/pages/ClockIn.jsx')), calls(atBefore('src/pages/ClockIn.jsx')))
  for (const k of ['clock.statusUnknown', 'clock.statusUnknownHint', 'clock.statusLastKnown', 'clock.statusRetry'])
    assert.match(read('src/i18n/catalogBn.js'), new RegExp(`"${k.replace(/\./g, '\\.')}"`), k)
})

// ── Teil 2: echte Seite im Browser ──
const FAKE_SRC = String.raw`
function makeFake() {
  const db = { cafe: { id: 1, gps_lat: null, gps_lng: null, gps_radius_m: 50 },
    emp: { id: 'e1', first_name: 'Test', last_name: 'Person', position: 'Barista', is_active: true },
    entries: [], breaks: [], fail: {}, delay: {}, log: [] }
  const key = q => q.table + (q.filters.some(f => f[0] === 'is' && f[1] === 'clock_out') ? ':open' : '')
  function builder(table) {
    const q = { table, op: 'select', filters: [] }
    const api = {
      select() { return api }, eq(c, v) { q.filters.push(['eq', c, v]); return api }, is(c, v) { q.filters.push(['is', c, v]); return api },
      not() { return api }, gte() { return api }, lt() { return api }, order() { return api }, limit() { return api },
      maybeSingle() { q.single = true; return api }, abortSignal() { return api },
      insert(rows) { q.op = 'insert'; q.rows = rows; return api }, update(v) { q.op = 'update'; q.values = v; return api },
      then(res, rej) { const k = key(q); const d = typeof db.delay[k] === 'function' ? db.delay[k]() : (db.delay[k] || 0)
        const out = JSON.parse(JSON.stringify(run(k)))   // Serverstand zum Zeitpunkt der Anfrage
        return new Promise(r => setTimeout(r, d)).then(() => out).then(res, rej) },
    }
    function run(k) {
      db.log.push(k + ':' + q.op)
      if (db.fail[k] > 0) { db.fail[k]--; return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 } }
      if (table === 'cafe_settings') return { data: db.cafe, error: null, status: 200 }
      if (table === 'employees') return { data: db.emp, error: null, status: 200 }
      if (table === 'time_entry_breaks') return { data: db.breaks, error: null, status: 200 }
      if (table === 'time_entries') {
        if (q.op === 'insert') { db.entries.push({ id: 't' + db.entries.length, ...q.rows[0], clock_out: null }); return { data: null, error: null, status: 201 } }
        const open = db.entries.filter(e => !e.clock_out)
        if (k.endsWith(':open')) return { data: open.slice(0, 1), error: null, status: 200 }
        return { data: db.entries, error: null, status: 200 }
      }
      return { data: null, error: null, status: 200 }
    }
    return api
  }
  const client = { from: builder, rpc: name => Promise.resolve(name === 'clock_network_status' ? { data: { configured: false }, error: null } : { data: null, error: null }) }
  return { db, client }
}`
const SUPABASE_STUB = `window.__sb = window.__sb || { current: null }
export const supabase = new Proxy({}, { get: (_, k) => window.__sb.current[k] })
export const getDistanceMeters = () => 0`
const entry = which => `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import { ProfileContext } from ${JSON.stringify(resolve('src/context/ProfileContext.jsx'))}
import ClockIn from ${JSON.stringify(which)}
import { RefreshProvider, useRefresh } from ${JSON.stringify(resolve('src/context/RefreshContext.jsx'))}
function ExposeRefresh() { const { refreshData } = useRefresh(); window.__refresh = refreshData; return null }
${FAKE_SRC}
const root = createRoot(document.getElementById('app'))
let k = 0
window.__errors = []
window.addEventListener('error', e => window.__errors.push(String(e.message)))
window.addEventListener('unhandledrejection', e => window.__errors.push('unhandled: ' + String(e.reason && (e.reason.stack || e.reason))))
const origErr = console.error; console.error = (...a) => { window.__errors.push(a.map(String).join(' ')); origErr(...a) }
window.__mount = (setup) => {
  const fake = makeFake(); window.__db = fake.db; window.__sb.current = fake.client
  if (setup) (new Function('db', setup))(fake.db)
  const profile = { id: 'user-1', role: 'employee', employee_id: 'e1' }
  root.render(<LocaleProvider><ProfileContext.Provider key={++k} value={{ isAdmin: false, isManager: false, profile }}><RefreshProvider><ExposeRefresh /><div className="main-content"><ClockIn session={{}} /></div></RefreshProvider></ProfileContext.Provider></LocaleProvider>)
}
window.__unmount = () => root.render(<div />)`

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, pages = {}, HARNESS_ERR = null

async function openPage(file) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(600)
  const state = () => ev(`(() => ({
    loading: !document.querySelector('.clock-widget'),
    unknown: !!document.querySelector('[data-testid="clock-status-unknown"]'),
    lastKnown: document.querySelector('[data-testid="clock-status-unknown"]')?.innerText.includes('Zuletzt bestätigt') || false,
    clockIn: !!document.querySelector('.btn-clock-in, .btn-clock-blocked:not(.btn-clock-out)') && !document.querySelector('.clock-actions'),
    clockOut: !!document.querySelector('.clock-actions'),
    errors: window.__errors.slice(),
  }))()`)
  const waitFor = async (pred, what) => { for (let i = 0; i < 500; i++) { const s = await state(); if (pred(s)) return s; await sleep(20) } throw new Error('Zustand nicht erreicht: ' + what + ' ' + JSON.stringify(await state())) }
  const mount = setup => ev(`window.__mount(${JSON.stringify(setup || '')})`)
  return { ev, state, waitFor, mount, front: () => send('Page.bringToFront'), close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-clock-status-'))
  try {
    const esbuild = await import('esbuild')
    const stub = { name: 'stubs', setup(b) {
      b.onResolve({ filter: /(^|\/)supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }))   // auch './supabase' (lib/breaks.js)
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: SUPABASE_STUB, loader: 'js' }))
      // Gegenprobe: Stand vor F2 als virtuelle Datei im selben Verzeichnis (gleiche relativen Importe)
      b.onResolve({ filter: /^before:ClockIn$/ }, () => ({ path: 'ClockIn.before.jsx', namespace: 'before' }))
      b.onLoad({ filter: /.*/, namespace: 'before' }, () => ({ contents: atBefore('src/pages/ClockIn.jsx'), loader: 'jsx', resolveDir: resolve('src/pages') }))
    } }
    const css = read('src/index.css')
    for (const [name, which] of [['now', resolve('src/pages/ClockIn.jsx')], ['before', 'before:ClockIn']]) {
      const js = (await esbuild.build({ stdin: { contents: entry(which), loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [stub], define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"' }, logLevel: 'silent' })).outputFiles[0].text
      writeFileSync(join(dir, `${name}.html`), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de') } catch {}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    }
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    pages.now = await openPage(join(dir, 'now.html'))
    pages.before = await openPage(join(dir, 'before.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { for (const p of Object.values(pages)) try { p.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
// Chrome vorhanden, aber Harness ohne Ergebnis → FEHLSCHLAGEN (nicht überspringen; ENGINEERING_MEMORY „Browser-Tests“)
const P = name => { assert.ok(pages[name], `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); return pages[name] }
const OPEN = `db.entries.push({ id: 't0', employee_id: 'e1', date: new Date().toISOString().slice(0, 10), clock_in: new Date(Date.now() - 3600e3).toISOString(), clock_out: null })`

test('Browser: bestätigt ausgestempelt → Einstempeln; bestätigt eingestempelt → Ausstempeln/Pause', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now')
  await p.mount('')
  let s = await p.waitFor(s => !s.loading, 'geladen')
  assert.deepEqual([s.unknown, s.clockIn, s.clockOut], [false, true, false])
  await p.mount(OPEN)
  s = await p.waitFor(s => !s.loading, 'geladen')
  assert.deepEqual([s.unknown, s.clockIn, s.clockOut], [false, false, true])
})

test('Browser: Stempelstatus nicht ladbar (erste Ladung) → UNBEKANNT, KEIN Einstempeln/Ausstempeln angeboten', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now')
  await p.mount(OPEN + `; db.fail['time_entries:open'] = 1`)
  const s = await p.waitFor(s => !s.loading, 'geladen')
  assert.deepEqual([s.unknown, s.clockIn, s.clockOut], [true, false, false], 'eingestempelte Person sieht nie „Einstempeln“')
})

test('Gegenprobe Browser: Stand vor F2 zeigt bei demselben Fehler „Einstempeln“ (der behobene Fehler)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('before')
  await p.mount(OPEN + `; db.fail['time_entries:open'] = 1`)
  const s = await p.waitFor(s => !s.loading, 'geladen')
  assert.deepEqual([s.unknown, s.clockIn, s.clockOut], [false, true, false])
})

test('Browser: eingestempelt, Neuladen scheitert → UNBEKANNT mit letztem bestätigtem Stand; „Erneut laden“ → wieder eingestempelt', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now')
  await p.mount(OPEN)
  await p.waitFor(s => s.clockOut, 'eingestempelt')
  await p.ev(`window.__db.fail['time_entries:open'] = 1`)
  await p.ev(`window.__refresh()`)   // ↻ bzw. Rückkehr in die App (F4) – Neuladen scheitert
  let s = await p.waitFor(s => s.unknown, 'unbekannt')
  assert.equal(s.lastKnown, true, 'letzter bestätigter Stand als Hinweis')
  assert.deepEqual([s.clockIn, s.clockOut], [false, false])
  await p.ev(`[...document.querySelectorAll('[data-testid="clock-status-unknown"] button')][0].click()`)
  s = await p.waitFor(s => !s.unknown && s.clockOut, 'wieder eingestempelt')
  assert.equal(s.clockIn, false)
})

async function staleScenario(p) {
  // 1. Ladung (Seitenstart) sieht „ausgestempelt“, kommt aber erst nach 700 ms an
  await p.mount(`let n = 0; db.delay['time_entries:open'] = () => (++n === 1 ? 700 : 0)`)
  await sleep(100)
  // inzwischen eingestempelt (anderes Gerät) und 2. Ladung (↻) – schnell
  await p.ev(`window.__db.entries.push({ id: 't9', employee_id: 'e1', date: new Date().toISOString().slice(0, 10), clock_in: new Date().toISOString(), clock_out: null })`)
  await p.ev(`window.__refresh()`)
  await sleep(1600)   // 2. Ladung (schnell) und danach die veraltete 1. Antwort sind eingetroffen
  return p.state()
}
test('Browser: veraltete Antwort überschreibt nie eine neuere (langsame 1. Ladung „aus“, schnelle 2. Ladung „ein“)', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleScenario(P('now'))
  assert.deepEqual([s.clockOut, s.clockIn], [true, false], 'veraltete Antwort verworfen')
})
test('Gegenprobe Browser: Stand vor F2 lässt die veraltete Antwort gewinnen („Einstempeln“ trotz offenem Eintrag)', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleScenario(P('before'))
  assert.deepEqual([s.clockOut, s.clockIn], [false, true])
})

test('Browser: Verlassen der Seite während laufender Ladung → keine Fehler, keine späte Anzeige', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now')
  await p.mount(`db.delay['time_entries:open'] = 400`)
  await sleep(50)
  await p.ev('window.__unmount()')
  await sleep(600)
  const s = await p.state()
  assert.equal(s.loading, true, 'nichts mehr gerendert')
  assert.deepEqual(s.errors.filter(e => !/Failed to fetch/.test(e)), [])
})

test('Browser (F4 integriert): offline → online + pageshow/focus-Bündel → Stempelseite lädt genau EINMAL neu, nie parallel', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now')
  await p.front()   // sichtbarer Tab (Hintergrund-Tabs sind „hidden“ – dort wird bewusst nur vorgemerkt)
  assert.equal(await p.ev('document.visibilityState'), 'visible')
  await p.mount(OPEN)
  await p.waitFor(s => s.clockOut, 'eingestempelt')
  await sleep(300)
  const loads = () => p.ev(`window.__db.log.filter(x => x === 'time_entries:open:select').length`)
  const before = await loads()
  await p.ev(`(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online'));
    for (let i = 0; i < 10; i++) { window.dispatchEvent(new Event('focus')); const e = new Event('pageshow'); e.persisted = true; window.dispatchEvent(e) } })()`)
  await sleep(2500)
  assert.equal(await loads() - before, 1, 'genau ein Neuladen')
  const s = await p.state()
  assert.deepEqual([s.clockOut, s.unknown], [true, false])
})

async function staleBreakScenario(p) {
  // 1. Ladung: Pausenabfrage langsam (sieht „keine Pause“); dann Pause auf dem Server, 2. Ladung schnell (sieht „Pause läuft“)
  await p.mount(OPEN + `; let n = 0; db.delay['time_entry_breaks'] = () => (++n === 1 ? 700 : 0)`)
  await sleep(150)
  await p.ev(`window.__db.breaks.push({ id: 'b1', time_entry_id: 't0', break_start: new Date().toISOString(), break_end: null, closed_by: null })`)
  await p.ev(`window.__refresh()`)
  await sleep(1600)
  return p.ev(`!!document.querySelector('.break-panel-timer')`)
}
test('Browser: veraltete PAUSEN-Antwort überschreibt nie einen neueren Pausenstand (ON_BREAK bleibt)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now'); await p.front()
  assert.equal(await staleBreakScenario(p), true, 'laufende Pause bleibt sichtbar')
})
test('Gegenprobe Browser: ohne Pausen-Sequenz (Stand vor F2) gewinnt die veraltete Pausen-Antwort', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('before'); await p.front()
  assert.equal(await staleBreakScenario(p), false)
})

test('Browser (F4): gefülltes Textfeld außerhalb eines Dialogs (inline bearbeitet, ohne Fokus) → KEIN automatisches Neuladen; leer → Neuladen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P('now'); await p.front()
  await p.mount(OPEN)
  await p.waitFor(s => s.clockOut, 'eingestempelt')
  await sleep(300)
  const loads = () => p.ev(`window.__db.log.filter(x => x === 'time_entries:open:select').length`)
  await p.ev(`(() => { const i = document.createElement('input'); i.id = 'inline-edit'; i.value = 'DE89 3704 0044'; document.querySelector('.main-content').appendChild(i); i.blur() })()`)
  const before = await loads()
  await p.ev(`window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online'))`)
  await sleep(1500)
  assert.equal(await loads() - before, 0, 'ungespeicherte Eingabe geschützt')
  assert.equal(await p.ev(`document.getElementById('inline-edit').value`), 'DE89 3704 0044')
  await p.ev(`(() => { document.getElementById('inline-edit').value = ''; window.dispatchEvent(new Event('focus')) })()`)
  await sleep(1500)
  assert.equal(await loads() - before, 1, 'vorgemerkter Lauf wird nachgeholt, sobald nichts mehr verloren gehen kann')
})
