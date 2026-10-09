// Resilience Batch 2b (Schichtplan): 2b-1 Duplikat-Rückfrage, 2b-2 kein Überschreiben aus veraltetem Dialog,
// 2b-3 Ladefehler sichtbar + nur jüngste Woche, 2b-4 Doppeltipp bei Tausch-Aktionen (Unit in errorPaths).
// Teil 1: rein + Quelltext + gezieltes i18n-Re-Baseline. Teil 2: ECHTE Seite Shifts.jsx in Headless Chrome gegen einen
// nachgebildeten Server (nur supabase ersetzt) – inkl. Gegenproben mit dem Stand vor 2b. Tausch-Server-Logik: tests/db/shift_swap.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { findSameStartShift, hhmm } from '../src/lib/shiftDuplicates.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = '28d4289'   // Stand vor Batch 2b
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

// ── Teil 1 ──
test('2b-1 Lib: gleiche Person/Tag/Start gefunden | nicht gefunden | Prüffehler → ok:false (nie „kein Duplikat“ raten)', async () => {
  const calls = []
  const client = rows => ({ from: t => { const q = { t, f: [] }; const api = {
    select: c => { q.c = c; return api }, eq: (k, v) => { q.f.push([k, v]); return api }, limit: n => { q.n = n; calls.push(q); return Promise.resolve(rows) } }; return api } })
  const r1 = await findSameStartShift(client({ data: [{ id: 'x', start_time: '08:00:00', end_time: '16:00:00' }], error: null }), { employeeId: 'e1', date: '2026-10-12', startTime: '08:00' })
  assert.deepEqual(r1, { ok: true, existing: { id: 'x', start_time: '08:00:00', end_time: '16:00:00' } })
  assert.deepEqual(calls[0], { t: 'shifts', c: 'id, start_time, end_time', f: [['employee_id', 'e1'], ['date', '2026-10-12'], ['start_time', '08:00']], n: 1 })
  assert.deepEqual(await findSameStartShift(client({ data: [], error: null }), { employeeId: 'e1', date: 'd', startTime: '08:00' }), { ok: true, existing: null })
  assert.deepEqual(await findSameStartShift(client({ data: null, error: { message: 'AbortError: request-timeout-read' }, status: 0 }), { employeeId: 'e1', date: 'd', startTime: '08:00' }), { ok: false })
  assert.deepEqual(await findSameStartShift({ from() { throw new Error('boom') } }, { employeeId: 'e1', date: 'd', startTime: '08:00' }), { ok: false })
  assert.equal(hhmm('08:30:00'), '08:30'); assert.equal(hhmm(null), '')
})

function checkShifts(src) {
  const add = src.slice(src.indexOf('  async function doAddShift() {'), src.indexOf('  async function openEditModal('))
  assert.ok(add.indexOf('findSameStartShift(supabase,') > 0 && add.indexOf('findSameStartShift(supabase,') < add.indexOf(".insert(["), 'Prüfung vor dem Insert')
  assert.match(add, /if \(!dup\.ok\) \{ toast\.error\(appMessage\('shifts\.dupCheckFailed'\), 9000\); return \}/, 'unbekannt → nichts anlegen')
  assert.match(add, /if \(dup\.existing && !window\.confirm\(tr\('shifts\.dupConfirm'/, 'Rückfrage statt Block')
  assert.match(add, /\.insert\(\[\{ \.\.\.form, planned_hours: hrs \}\]\)\n[\s\S]*?if \(error\) \{ toast\.error\(translateSupabaseError\(error, appMessage\("ui\.e83d6389c102"\)\)\); fetchData\(\); return \}/, 'nach Fehler neu laden')
  const upd = src.slice(src.indexOf('  async function doUpdateShift() {'), src.indexOf('  async function deleteShift('))
  assert.match(upd, /\.update\(\{ \.\.\.form, planned_hours: hrs \}\)\.eq\('id', editModal\.id\)\.eq\('employee_id', editModal\.employee_id\)\.eq\('date', editModal\.date\)\.eq\('start_time', editModal\.start_time\)\.eq\('end_time', editModal\.end_time\)\.select\('id'\)/)
  assert.match(upd, /if \(!changed\?\.length\) \{ toast\.warn\(appMessage\('shifts\.staleEdit'\), 10000\); setEditModal\(null\); fetchData\(\); return \}/)
  const fd = src.slice(src.indexOf('  async function fetchData() {'), src.indexOf('  async function fetchSwaps() {'))
  assert.match(fd, /const my = \+\+loadSeq\.current/); assert.match(fd, /if \(my !== loadSeq\.current\) return/)
  assert.match(fd, /if \(sErr \|\| eErr\) \{ setLoadError\(true\); setLoading\(false\); return \}/)
  assert.ok(fd.indexOf('setLoadError(true)') < fd.indexOf('setShifts('), 'bei Fehler werden Schichten nicht überschrieben')
  assert.match(src, /data-testid="shifts-load-error"/)
  for (const fn of ['submitSwap', 'approveSwap', 'rejectSwap']) {
    const body = src.slice(src.indexOf(`  async function ${fn}(`), src.indexOf('\n  }\n', src.indexOf(`  async function ${fn}(`)))
    assert.match(body, /swapGuard\.begin\(\)/, fn); assert.match(body, /swapGuard\.end\(\)/, fn)
  }
}
test('Shifts.jsx: Prüfung vor dem Insert, bedingtes Bearbeiten/Löschen, Ladefehler + Sequenz, Tausch-Sperre', () => checkShifts(read('src/pages/Shifts.jsx')))
test('Gegenprobe Quelltext: Stand vor 2b erfüllt die Prüfung nicht', () => assert.throws(() => checkShifts(atBefore('src/pages/Shifts.jsx'))))

test('Unverändert: Insert-Aufruf, Tausch-RPC/Statusübergänge, 4× notifyTimeDataChanged, ArbZG-Prüfung, genau ein useRefreshHandler', () => {
  const now = read('src/pages/Shifts.jsx'), was = atBefore('src/pages/Shifts.jsx')
  for (const k of [".insert([{ ...form, planned_hours: hrs }])", "supabase.rpc('approve_swap', { p_swap_id: swap.id })", ".update({ status }).eq('id', id).eq('status', 'open').select('id')",
    ".update({ status:'rejected' })", "function checkArbZG(empId, date, startTime, endTime) {"]) { assert.ok(now.includes(k) && was.includes(k), k) }
  assert.equal((now.match(/notifyTimeDataChanged\(\)/g) || []).length, 4)
  assert.equal((now.match(/useRefreshHandler\(/g) || []).length, 1)
  const fn = (s, n) => s.slice(s.indexOf(`function ${n}(`), s.indexOf('\n  }\n', s.indexOf(`function ${n}(`)))
  assert.equal(fn(now, 'checkArbZG'), fn(was, 'checkArbZG'))
  assert.equal(fn(now, 'updateOwnSwap'), fn(was, 'updateOwnSwap'), 'Tausch annehmen/ablehnen/zurückziehen unverändert')
})

// gezieltes i18n-Re-Baseline: im Archiv ändern sich ausschließlich die beiden freigegebenen Aufrufzeilen
function zipEntry(buf, name) {
  let off = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const n = buf.readUInt16LE(off + 10); let p = buf.readUInt32LE(off + 16)
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42)
    const fname = buf.toString('utf8', p + 46, p + 46 + nl)
    if (fname === name) { const lnl = buf.readUInt16LE(lo + 26), lxl = buf.readUInt16LE(lo + 28); const d = buf.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + csize); return (method === 8 ? zlib.inflateRawSync(d) : d).toString('utf8') }
    p += 46 + nl + xl + cl
  }
  return null
}
function zipNames(buf) {
  const off = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const n = buf.readUInt16LE(off + 10); let p = buf.readUInt32LE(off + 16); const out = []
  for (let i = 0; i < n; i++) { const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32); out.push(buf.toString('utf8', p + 46, p + 46 + nl)); p += 46 + nl + xl + cl }
  return out
}
test('i18n-Re-Baseline nur für die zwei freigegebenen Aufrufe (updateShift/deleteShift); alle anderen Archiv-Einträge byte-gleich', () => {
  const now = readFileSync('.i18n-work/baseline.zip'), was = execFileSync('git', ['show', `${BEFORE}:.i18n-work/baseline.zip`])
  assert.deepEqual(zipNames(now), zipNames(was))
  for (const name of zipNames(was)) if (name !== 'src/pages/Shifts.jsx') assert.equal(zipEntry(now, name), zipEntry(was, name), name)
  const a = zipEntry(was, 'src/pages/Shifts.jsx').split('\n'), b = zipEntry(now, 'src/pages/Shifts.jsx').split('\n')
  assert.equal(a.length, b.length)
  const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y)
  assert.equal(diff.length, 2, 'genau zwei Zeilen')
  assert.match(diff[0][1], /\.update\(\{ \.\.\.form, planned_hours: hrs \}\)\.eq\('id', editModal\.id\)\.eq\('employee_id', editModal\.employee_id\)/)
  assert.match(diff[1][1], /\.delete\(\)\.eq\('id', id\)\.eq\('employee_id', editModal\.employee_id\)/)
  for (const [x, y] of diff) assert.ok(y.startsWith(x), 'nur angehängt, nichts entfernt')
})

test('DE/EN/BN: neue Texte vollständig, Platzhalter gleich, BN in bengalischer Schrift', () => {
  for (const k of ['shifts.dupConfirm', 'shifts.dupCheckFailed', 'shifts.staleEdit', 'shifts.loadFailed', 'shifts.retry']) {
    assert.ok(de[k] && en[k] && bn[k], k); assert.match(bn[k], /[ঀ-৿]/, k)
    const ph = s => (s.match(/\{\w+\}/g) || []).sort().join()
    assert.equal(ph(en[k]), ph(de[k]), k); assert.equal(ph(bn[k]), ph(de[k]), k)
  }
  assert.doesNotMatch(de['shifts.staleEdit'], /gespeichert\b(?!.*nicht)/, 'kein falscher Erfolg')
})

// ── Teil 2: echte Seite im Browser ──
const FAKE = String.raw`
function makeFake() {
  const pad = n => String(n).padStart(2, '0'), ds = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  const now = new Date(), day = now.getDay() || 7, mon = new Date(now); mon.setDate(now.getDate() - day + 1)
  const week = Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return ds(x) })
  const db = { week, shifts: [], employees: [{ id: 'e1', first_name: 'Anna', last_name: 'Test', is_active: true }, { id: 'e2', first_name: 'Ben', last_name: 'Test', is_active: true }],
    log: [], fail: {}, delay: {}, seq: 1 }
  const kind = q => q.table === 'shifts' ? (q.op === 'select' ? (q.lim ? 'shifts:dup' : 'shifts:week') : 'shifts:' + q.op) : q.table
  function builder(table) {
    const q = { table, op: 'select', eq: [], gte: null, lte: null, lim: null, sel: false }
    const api = {
      select() { if (q.op !== 'select') q.sel = true; return api }, eq(k, v) { q.eq.push([k, v]); return api }, gte(k, v) { q.gte = v; return api }, lte(k, v) { q.lte = v; return api },
      in() { return api }, order() { return api }, limit(n) { q.lim = n; return api }, maybeSingle() { return api },
      insert(rows) { q.op = 'insert'; q.rows = rows; return api }, update(v) { q.op = 'update'; q.vals = v; return api }, delete() { q.op = 'delete'; return api },
      then(res, rej) { const k = kind(q); const d = typeof db.delay[k] === 'function' ? db.delay[k]() : (db.delay[k] || 0); const out = run(k); return new Promise(r => setTimeout(r, d)).then(() => out).then(res, rej) },
    }
    const match = r => q.eq.every(([k, v]) => String(r[k]).slice(0, k.endsWith('_time') ? 5 : 99) === String(v).slice(0, k.endsWith('_time') ? 5 : 99))
    function run(k) {
      db.log.push(k)
      const f = db.fail[k]; if (f) delete db.fail[k]
      if (f === 'error') return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }
      let data = null
      if (table === 'shift_swap_requests') data = []
      else if (q.op === 'select') data = db.shifts.filter(r => match(r) && (!q.gte || r.date >= q.gte) && (!q.lte || r.date <= q.lte)).slice(0, q.lim || 999).map(r => ({ ...r }))
      else if (q.op === 'insert') { for (const r of q.rows) db.shifts.push({ id: 'n' + (db.seq++), ...r, start_time: r.start_time + ':00', end_time: r.end_time + ':00' }) }
      else if (q.op === 'update') { const hit = db.shifts.filter(match); for (const r of hit) Object.assign(r, q.vals, { start_time: q.vals.start_time + ':00', end_time: q.vals.end_time + ':00' }); data = q.sel ? hit.map(r => ({ id: r.id })) : null }
      else if (q.op === 'delete') { const hit = db.shifts.filter(match); db.shifts = db.shifts.filter(r => !hit.includes(r)); data = q.sel ? hit.map(r => ({ id: r.id })) : null }
      if (f === 'lost') return { data: null, error: { message: 'AbortError: request-timeout-write', code: '' }, status: 0 }   // ausgeführt, Antwort verloren
      return { data, error: null, status: 200 }
    }
    return api
  }
  const client = { from: builder, rpc: (n) => Promise.resolve(n === 'get_employees_directory' ? (db.fail['dir'] ? (delete db.fail['dir'], { data: null, error: { message: 'x' } }) : { data: db.employees, error: null }) : { data: null, error: null }) }
  return { db, client }
}`
const STUB = `window.__sb = window.__sb || { current: null }
export const supabase = new Proxy({}, { get: (_, k) => window.__sb.current[k] })
export const getInitials = (a, b) => ((a || '')[0] || '') + ((b || '')[0] || '')`
const entry = which => `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import { ProfileContext } from ${JSON.stringify(resolve('src/context/ProfileContext.jsx'))}
import { DarkModeProvider } from ${JSON.stringify(resolve('src/context/DarkModeContext.jsx'))}
import { ToastProvider } from ${JSON.stringify(resolve('src/components/UI/Toast.jsx'))}
import { RefreshProvider, useRefresh } from ${JSON.stringify(resolve('src/context/RefreshContext.jsx'))}
import Shifts from ${JSON.stringify(which)}
${FAKE}
function Expose() { window.__refresh = useRefresh().refreshData; return null }
const root = createRoot(document.getElementById('app'))
let k = 0
window.__mount = setup => {
  const f = makeFake(); window.__db = f.db; window.__sb.current = f.client
  if (setup) (new Function('db', setup))(f.db)
  window.__confirms = []; window.__confirmAnswer = false; window.confirm = m => { window.__confirms.push(m); return window.__confirmAnswer }
  root.render(<LocaleProvider><DarkModeProvider><ToastProvider><RefreshProvider><Expose /><ProfileContext.Provider key={++k} value={{ isAdmin: true, isManager: true, profile: { id: 'u1', employee_id: null } }}><div className="main"><Shifts /></div></ProfileContext.Provider></RefreshProvider></ToastProvider></DarkModeProvider></LocaleProvider>)
}`

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
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(700)
  const front = () => send('Page.bringToFront')
  const state = () => ev(`({ pills: [...document.querySelectorAll('.shift-pill')].map(p => p.innerText.trim()), shifts: window.__db.shifts.map(s => [s.employee_id, s.date, s.start_time.slice(0,5)]),
    modal: !!document.querySelector('.modal-overlay'), loadError: document.querySelector('[data-testid="shifts-load-error"]')?.innerText ?? null,
    toasts: document.body.innerText, confirms: window.__confirms.slice(), loading: !document.querySelector('.shift-pill, td span[title]') })`)
  const settle = async () => { for (let i = 0; i < 200; i++) { if (await ev(`!!document.querySelector('td') && ![...document.querySelectorAll('div')].some(d => d.innerText === ${JSON.stringify(de['ui.ebbb1d1f265f'])})`)) return sleep(80); await sleep(25) } throw new Error('Seite lädt nicht') }
  const mount = async setup => { await ev(`window.__mount(${JSON.stringify(setup || '')})`); await settle() }
  const click = async jsSelectorExpr => { const ok = await ev(`(() => { const b = ${jsSelectorExpr}; if (!b) return false; b.click(); return true })()`); await sleep(400); return ok }
  return { ev, send, front, state, mount, click, settle, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-shifts-'))
  try {
    const esbuild = await import('esbuild')
    const plugin = { name: 'stubs', setup(b) {
      b.onResolve({ filter: /(^|\/)supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
      b.onResolve({ filter: /^before:Shifts$/ }, () => ({ path: 'Shifts.before.jsx', namespace: 'before' }))
      b.onLoad({ filter: /.*/, namespace: 'before' }, () => ({ contents: atBefore('src/pages/Shifts.jsx'), loader: 'jsx', resolveDir: resolve('src/pages') }))
    } }
    for (const [name, which] of [['now', resolve('src/pages/Shifts.jsx')], ['before', 'before:Shifts']]) {
      const js = (await esbuild.build({ stdin: { contents: entry(which), loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [plugin],
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"' }, logLevel: 'silent' })).outputFiles[0].text
      writeFileSync(join(dir, `${name}.html`), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${read('src/index.css')}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de') } catch {}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    }
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    pages.now = await openPage(join(dir, 'now.html')); pages.before = await openPage(join(dir, 'before.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { for (const p of Object.values(pages)) try { p.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async name => { assert.ok(pages[name], `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await pages[name].front(); return pages[name] }

const EXISTING = `db.shifts.push({ id: 's1', employee_id: 'e1', date: db.week[2], start_time: '08:00:00', end_time: '16:00:00', position: '', notes: '' })`
const SAVE = `[...document.querySelectorAll('.modal-overlay .btn-primary')].pop()`
// „+ Schicht“ (Kopfzeile) öffnen, Person + Tag wählen (Standard 08:00–16:00)
const openAddFor = (emp, dayIndex) => `(() => {
  [...document.querySelectorAll('.topbar-right .btn-primary')].pop().click()
  return new Promise(r => setTimeout(() => {
    const sel = document.querySelector('.modal-overlay select'), date = document.querySelector('.modal-overlay input[type=date]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(emp)}); sel.dispatchEvent(new Event('change', { bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(date, window.__db.week[${dayIndex}]); date.dispatchEvent(new Event('input', { bubbles: true }))
    setTimeout(() => r(true), 150)
  }, 200))
})()`

async function duplicateScenario(p) {
  await p.mount(EXISTING)
  await p.ev(openAddFor('e1', 2))
  await p.click(SAVE)                                   // gleiche Person, gleicher Tag, 08:00 → Rückfrage → „Abbrechen“
  return p.state()
}
test('Browser 2b-1: mögliches Duplikat → Rückfrage; „Abbrechen“ legt nichts an; „OK“ legt bewusst an (kein Block)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  let s = await duplicateScenario(p)
  assert.equal(s.confirms.length, 1); assert.match(s.confirms[0], /bereits eine Schicht ab 08:00 Uhr/)
  assert.equal(s.shifts.length, 1, 'nichts angelegt'); assert.equal(s.modal, true, 'Dialog bleibt offen (Eingaben erhalten)')
  await p.ev('window.__confirmAnswer = true'); await p.click(SAVE); await p.settle()
  s = await p.state()
  assert.equal(s.shifts.length, 2, 'bewusst bestätigt → angelegt (keine neue Fachregel)')
})
test('Gegenprobe Browser 2b-1: Stand vor 2b legt das Duplikat ohne Rückfrage an', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await duplicateScenario(await P('before'))
  assert.deepEqual([s.confirms.length, s.shifts.length], [0, 2])
})

test('Browser 2b-1: Prüfung nicht möglich → NICHTS angelegt, Hinweis; Antwort verloren → Woche neu geladen, nächster Versuch fragt nach', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount('')
  await p.ev(openAddFor('e2', 3))
  await p.ev(`window.__db.fail['shifts:dup'] = 'error'`)
  await p.click(SAVE)
  let s = await p.state()
  assert.equal(s.shifts.length, 0); assert.match(s.toasts, /Es wurde nichts angelegt/)
  // Insert wird ausgeführt, Antwort geht verloren (Schreib-Timeout)
  await p.ev(`window.__db.fail['shifts:insert'] = 'lost'`)
  await p.click(SAVE); await sleep(400)
  s = await p.state()
  assert.equal(s.shifts.length, 1, 'Server hat gespeichert'); assert.match(s.toasts, /möglicherweise trotzdem gespeichert/)
  assert.ok((await p.ev('window.__db.log')).slice(-2).includes('shifts:week'), 'Woche nach dem Fehler neu geladen')
  assert.equal(s.modal, true)
  await p.click(SAVE)                                   // erneut tippen → Rückfrage statt Duplikat
  s = await p.state()
  assert.equal(s.confirms.length, 1); assert.equal(s.shifts.length, 1, 'kein Duplikat')
})

async function staleEditScenario(p, action) {
  await p.mount(EXISTING)
  await p.click(`[...document.querySelectorAll('.shift-pill')][0]`)              // Bearbeiten-Dialog (Stand: Anna)
  await p.ev(`(() => { const s = window.__db.shifts.find(x => x.id === 's1'); s.employee_id = 'e2'; return true })()`)   // inzwischen getauscht (Server)
  if (action === 'save') await p.click(SAVE)
  else { await p.click(`[...document.querySelectorAll('.modal-overlay button')].find(b => /Schicht löschen|löschen/i.test(b.innerText) && !b.classList.contains('btn-danger'))`); await p.click(`document.querySelector('.modal-overlay .btn-danger')`) }
  await sleep(300)
  return p.state()
}
test('Browser 2b-2: Schicht inzwischen getauscht → Speichern überschreibt NICHT, Hinweis, Dialog zu, Stand neu', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleEditScenario(await P('now'), 'save')
  assert.deepEqual(s.shifts, [['e2', s.shifts[0][1], '08:00']], 'Tausch bleibt erhalten')
  assert.match(s.toasts, /inzwischen geändert, getauscht oder gelöscht/); assert.equal(s.modal, false)
})
test('Browser 2b-2: Schicht inzwischen getauscht → Löschen löscht NICHT die Schicht der neuen Person', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleEditScenario(await P('now'), 'delete')
  assert.equal(s.shifts.length, 1); assert.equal(s.shifts[0][0], 'e2')
  assert.match(s.toasts, /inzwischen geändert, getauscht oder gelöscht/)
})
test('Gegenprobe Browser 2b-2: Stand vor 2b setzt beim Speichern die alte Person zurück (Tausch rückgängig)', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleEditScenario(await P('before'), 'save')
  assert.equal(s.shifts[0][0], 'e1')
})
test('Browser 2b-2: unveränderte Schicht → normales Speichern funktioniert weiter', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount(EXISTING)
  await p.click(`[...document.querySelectorAll('.shift-pill')][0]`)
  await p.ev(`(() => { const i = document.querySelectorAll('.modal-overlay input')[1]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '17:00'); i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '0' })); return true })()`)
  await p.click(SAVE); await p.settle()
  const s = await p.state()
  const row = await p.ev(`window.__db.shifts.find(x => x.id === 's1')`)
  assert.equal(s.modal, false, 'Dialog nach Erfolg zu')
  assert.deepEqual([row.employee_id, row.end_time], ['e1', '17:00:00'], 'Änderung gespeichert')
  assert.ok((await p.ev('window.__db.log')).includes('shifts:update'))
})

test('Browser 2b-3: Ladefehler → Hinweis, zuletzt geladener Stand bleibt (keine scheinbar leere Woche); erneut laden → weg', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount(EXISTING)
  assert.equal((await p.state()).pills.length, 1)
  await p.ev(`window.__db.fail['shifts:week'] = 'error'; window.__refresh()`); await sleep(500)
  let s = await p.state()
  assert.match(s.loadError || '', /konnte nicht geladen werden/); assert.equal(s.pills.length, 1, 'Stand bleibt')
  await p.click(`document.querySelector('[data-testid="shifts-load-error"] button')`); await p.settle()
  s = await p.state(); assert.equal(s.loadError, null); assert.equal(s.pills.length, 1)
})
test('Gegenprobe Browser 2b-3: Stand vor 2b zeigt bei Ladefehler eine leere Woche ohne Hinweis', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('before')
  await p.mount(EXISTING)
  await p.ev(`window.__db.fail['shifts:week'] = 'error'; window.__refresh()`); await sleep(600)
  const s = await p.state()
  assert.deepEqual([s.pills.length, s.loadError], [0, null])
})

async function staleWeekScenario(p) {
  await p.mount(EXISTING + `; let n = 0; db.delay['shifts:week'] = () => (++n === 2 ? 900 : 0)`)   // 2. Ladung (Woche vor) langsam
  await p.click(`[...document.querySelectorAll('.topbar-right .btn-sm')][0]`)    // ← Vorwoche (langsam)
  await p.click(`[...document.querySelectorAll('.topbar-right .btn-sm')][1]`)    // „Heute“ (schnell)
  await sleep(1400)
  return p.state()
}
test('Browser 2b-3: schnelles Blättern – veraltete Wochen-Antwort überschreibt nie die angezeigte Woche', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleWeekScenario(await P('now'))
  assert.equal(s.pills.length, 1, 'aktuelle Woche mit ihrer Schicht bleibt')
})
test('Gegenprobe Browser 2b-3: Stand vor 2b lässt die veraltete (leere) Vorwoche gewinnen', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await staleWeekScenario(await P('before'))
  assert.equal(s.pills.length, 0)
})

test('Browser 2b-1: zulässige Schichten werden nie behindert – andere Startzeit (geteilte Schicht) und Nachtschicht ohne Rückfrage', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount(EXISTING)                                                   // Anna, Tag 2, 08:00–16:00
  // geteilte Schicht: 17:00–21:00 am selben Tag
  await p.ev(openAddFor('e1', 2))
  for (const [i, v] of [[0, '17:00'], [1, '21:00']]) await p.ev(`(() => { const el = document.querySelectorAll('.modal-overlay input:not([type=date])')[${i}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '0' })); return true })()`)
  await p.click(SAVE); await p.settle()
  let s = await p.state()
  assert.equal(s.confirms.length, 0, 'keine Rückfrage bei anderer Startzeit'); assert.equal(s.shifts.length, 2)
  // Nachtschicht 22:00–06:00 für eine andere Person
  await p.ev(openAddFor('e2', 4))
  for (const [i, v] of [[0, '22:00'], [1, '06:00']]) await p.ev(`(() => { const el = document.querySelectorAll('.modal-overlay input:not([type=date])')[${i}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '0' })); return true })()`)
  await p.click(SAVE); await p.settle()
  s = await p.state()
  assert.equal(s.confirms.length, 0); assert.equal(s.shifts.length, 3)
  assert.deepEqual(s.shifts.slice(1).map(x => x[2]), ['17:00', '22:00'])
})
