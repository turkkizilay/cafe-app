// Resilience Batch 2a: F6-1 „Abmelden nur dieses Gerät“ (lib/signOutScope.js im Abmelde-Wrapper von supabase.js) und
// F6-2 „nicht angemeldet bleiben“ + neuer Tab (lib/sessionTabs.js, main.jsx). Teil 1: rein + Quelltext. Teil 2: echtes
// auth-js (Scope an den Server, offline). Teil 3: echter Chrome mit mehreren Tabs desselben Browsers (gemeinsamer Speicher,
// BroadcastChannel): Handshake, Abmelden in allen Tabs dieses Geräts. Server-Sperren (Zugang-Reset, access_gate) prüft tests/db.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { deviceSignOutOptions } from '../src/lib/signOutScope.js'
import { prepareSessionFlag, answerSessionPings, askForActiveTab, SESSION_CHANNEL, HANDSHAKE_MS, FLAG_ACTIVE, FLAG_NO_REMEMBER } from '../src/lib/sessionTabs.js'
import { pinView } from './pinView.mjs'

const BEFORE = '35c4035'   // Stand vor Batch 2a
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

// ── Teil 1: F6-1 Scope ──
test('F6-1: Standard „nur dieses Gerät“; ausdrücklicher Scope (global/others) und weitere Optionen bleiben', () => {
  assert.deepEqual(deviceSignOutOptions(), { scope: 'local' })
  assert.deepEqual(deviceSignOutOptions(undefined), { scope: 'local' })
  assert.deepEqual(deviceSignOutOptions({}), { scope: 'local' })
  assert.deepEqual(deviceSignOutOptions({ scope: 'local' }), { scope: 'local' })
  assert.deepEqual(deviceSignOutOptions({ scope: 'global' }), { scope: 'global' })
  assert.deepEqual(deviceSignOutOptions({ scope: 'others' }), { scope: 'others' })
  assert.deepEqual(deviceSignOutOptions('unsinn'), { scope: 'local' })
})

test('F6-1: supabase.js – nur der Scope im bestehenden Wrapper; Push-Trennung, Timeout, Skew-Retry unverändert', () => {
  const now = read('src/lib/supabase.js'), before = atBefore('src/lib/supabase.js')
  assert.match(now, /return _signOut\(deviceSignOutOptions\(args\[0\]\)\)/)
  assert.doesNotMatch(before, /deviceSignOutOptions/, 'Gegenprobe: vorher global')
  const wrapper = s => s.slice(s.indexOf('const _signOut'), s.indexOf('// ── Hilfsfunktionen'))
  assert.equal(wrapper(now).replace('_signOut(deviceSignOutOptions(args[0]))   // nur dieses Gerät (lib/signOutScope.js); ausdrücklicher Scope gilt weiter', '_signOut(...args)'), wrapper(before), 'sonst nichts am Wrapper geändert (Push-Trennung zuerst)')
  const rest = s => s.replace(/import \{ deviceSignOutOptions \} from '\.\/signOutScope'\n/, '').replace(wrapper(s), '')
  assert.equal(rest(now), rest(before), 'Rest von supabase.js byte-gleich')
  // keine Aufrufstelle erzwingt künftig „global“; die Sperre bei widerrufener Sitzung bleibt ausdrücklich lokal
  for (const f of ['src/App.jsx', 'src/components/Layout/Sidebar.jsx', 'src/components/Auth/Login.jsx', 'src/pages/Onboarding.jsx', 'src/components/DeleteAccountCard.jsx'])
    assert.doesNotMatch(read(f), /scope:\s*'global'/, f)
  assert.match(read('src/App.jsx'), /if \(access\.revoked\) \{ await supabase\.auth\.signOut\(\{ scope: 'local' \}\)/)
})

// ── Teil 2: echtes auth-js ──
const URL_ = 'https://proj.supabase.co', KEY = 'sb-proj-auth-token'
function memStorage(init = {}) { const m = new Map(Object.entries(init)); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) }, map: m } }
const session = () => ({ access_token: 'aaa.bbb.ccc', refresh_token: 'refresh-1', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })
function authClient(fetchImpl) {
  const storage = memStorage({ [KEY]: JSON.stringify(session()) })
  const client = createClient(URL_, 'anon-key', { auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetchImpl } })
  return { client, storage }
}

test('echtes auth-js: Abmelden mit dem neuen Standard → Server bekommt scope=local, Sitzung dieses Geräts entfernt, SIGNED_OUT', async () => {
  const calls = []
  const { client, storage } = authClient(async (url, init) => { calls.push({ url: String(url), method: init?.method }); return new Response(null, { status: 204 }) })
  const events = []; client.auth.onAuthStateChange(e => events.push(e))
  await client.auth.getSession()
  const { error } = await client.auth.signOut(deviceSignOutOptions())
  assert.equal(error, null)
  const logout = calls.find(c => c.url.includes('/auth/v1/logout'))
  assert.ok(logout, 'Server wurde informiert (Refresh-Token dieser Sitzung widerrufen)')
  assert.match(logout.url, /[?&]scope=local\b/)
  assert.equal(storage.getItem(KEY), null, 'Sitzung auf diesem Gerät entfernt')
  assert.ok(events.includes('SIGNED_OUT'))
})

test('echtes auth-js: offline abmelden beendet trotzdem die Sitzung dieses Geräts (kein Hängen in „angemeldet“)', async () => {
  const { client, storage } = authClient(async () => { throw new TypeError('Failed to fetch') })
  await client.auth.getSession()
  await client.auth.signOut(deviceSignOutOptions())
  assert.equal(storage.getItem(KEY), null)
})

test('echtes auth-js: ausdrücklich „global“ bleibt global; Gegenprobe – ohne Standard war jede Abmeldung global', async () => {
  for (const [opts, expected] of [[deviceSignOutOptions({ scope: 'global' }), 'global'], [undefined, 'global']]) {
    const calls = []
    const { client } = authClient(async url => { calls.push(String(url)); return new Response(null, { status: 204 }) })
    await client.auth.getSession(); await client.auth.signOut(opts)
    assert.match(calls.find(u => u.includes('/auth/v1/logout')), new RegExp(`scope=${expected}\\b`))
  }
})

// ── Teil 1b: F6-2 Handshake (rein, mit nachgebildetem BroadcastChannel) ──
function bus() {
  const chans = new Set()
  class Ch { constructor(name) { this.name = name; this.onmessage = null; this.closed = false; chans.add(this) }
    postMessage(data) { for (const c of chans) if (c !== this && !c.closed && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data })) }
    close() { this.closed = true; chans.delete(this) } }
  return { Ch, open: () => [...chans].filter(c => !c.closed).length }
}
const store = (init = {}) => memStorage(init)
function timers() { const t = new Map(); let id = 0; return { setTimer: (f, ms) => { t.set(++id, { f, ms }); return id }, clearTimer: i => t.delete(i), fire() { for (const [i, x] of [...t]) { t.delete(i); x.f() } }, t } }

test('F6-2: nichts zu tun bei „angemeldet bleiben“ oder vorhandenem Flag; ohne BroadcastChannel unverändertes Verhalten', async () => {
  const { Ch } = bus()
  assert.equal(await prepareSessionFlag({ session: store(), local: store(), Channel: Ch }), 'remember')
  assert.equal(await prepareSessionFlag({ session: store({ [FLAG_ACTIVE]: '1' }), local: store({ [FLAG_NO_REMEMBER]: '1' }), Channel: Ch }), 'active')
  const s = store()
  assert.equal(await prepareSessionFlag({ session: s, local: store({ [FLAG_NO_REMEMBER]: '1' }), Channel: null }), 'no-channel')
  assert.equal(s.getItem(FLAG_ACTIVE), null, 'ohne BroadcastChannel: Startprüfung meldet wie bisher ab')
})

test('F6-2: lebender angemeldeter Tab antwortet → neuer Tab übernimmt das Flag; kein lebender Tab → nach Zeitgrenze „none“', async () => {
  const { Ch, open } = bus()
  const aliveTab = store({ [FLAG_ACTIVE]: '1' })
  const stop = answerSessionPings({ Channel: Ch, session: aliveTab })
  const newTab = store()
  assert.equal(await prepareSessionFlag({ session: newTab, local: store({ [FLAG_NO_REMEMBER]: '1' }), Channel: Ch }), 'adopted')
  assert.equal(newTab.getItem(FLAG_ACTIVE), '1')
  aliveTab.removeItem(FLAG_ACTIVE)   // Tab A meldet ab → antwortet nicht mehr
  const tm = timers(), another = store()
  const p = prepareSessionFlag({ session: another, local: store({ [FLAG_NO_REMEMBER]: '1' }), Channel: Ch, ...tm })
  await flush(); assert.ok([...tm.t.values()].some(x => x.ms === HANDSHAKE_MS)); tm.fire()
  assert.equal(await p, 'none'); assert.equal(another.getItem(FLAG_ACTIVE), null)
  stop(); assert.equal(open(), 0, 'alle Kanäle geschlossen')
})

test('F6-2: fremde Antwort (andere ID) wird ignoriert; Kanal-Fehler und gesperrter Speicher → sicheres „nicht übernehmen“', async () => {
  const { Ch } = bus()
  const liar = new Ch(SESSION_CHANNEL); liar.onmessage = () => liar.postMessage({ type: 'alive', id: 'falsche-id' })
  const tm = timers()
  const p = askForActiveTab({ Channel: Ch, ...tm, makeId: () => 'meine-id' })
  await flush(); tm.fire()
  assert.equal(await p, false)
  liar.close()
  class Broken { constructor() { throw new Error('nicht verfügbar') } }
  assert.equal(await askForActiveTab({ Channel: Broken }), false)
  assert.doesNotThrow(() => answerSessionPings({ Channel: Broken, session: store() })())
  const throwing = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('SecurityError') } }
  assert.equal(await prepareSessionFlag({ session: throwing, local: throwing, Channel: Ch }), 'remember', 'gesperrter Speicher: kein Absturz')
  const { Ch: Ch2 } = bus(); answerSessionPings({ Channel: Ch2, session: store({ [FLAG_ACTIVE]: '1' }) })
  assert.equal(await prepareSessionFlag({ session: { getItem: () => null, setItem() { throw new Error('quota') } }, local: store({ [FLAG_NO_REMEMBER]: '1' }), Channel: Ch2 }), 'none', 'Flag nicht setzbar → nicht übernehmen')
})

test('F6-2: main.jsx – Antwort-Kanal vor dem Rendern, Rendern nach dem Handshake, gesperrter Speicher abgefangen; App.jsx unverändert', () => {
  const main = read('src/main.jsx')
  assert.match(main, /const storage = name => \{ try \{ return window\[name\] \} catch \{ return null \} \}/)
  assert.ok(main.indexOf('answerSessionPings(') < main.indexOf('prepareSessionFlag('))
  assert.match(main, /prepareSessionFlag\(\{ session: storage\('sessionStorage'\), local: storage\('localStorage'\), Channel \}\)\.catch\(\(\) => 'error'\)\.finally\(renderApp\)/)
  assert.doesNotMatch(main.replace(/\/\/.*$/gm, ''), /(^|[^.\w])(sessionStorage|localStorage)\./m, 'kein ungeschützter Speicherzugriff auf Modulebene')
  // App.jsx: gegenüber dem Stand vor 2a nur die ausdrücklich freigegebenen, wörtlich zurückgeführten Ausnahmen (pinView, z. B. Batch 2c)
  assert.equal(pinView('src/App.jsx', read('src/App.jsx')), pinView('src/App.jsx', atBefore('src/App.jsx')), 'App.jsx: keine anderen Änderungen (gepinnt)')
  // … und die Startprüfung „nicht angemeldet bleiben“ selbst ist wörtlich unverändert (zusätzlich, unabhängig von pinView)
  const startCheck = s => s.slice(s.indexOf("    const noRemember    = localStorage.getItem('cafe_no_remember') === '1'"), s.indexOf('  }, [])', s.indexOf("    const noRemember    = localStorage.getItem('cafe_no_remember') === '1'")))
  assert.ok(startCheck(read('src/App.jsx')).length > 100)
  assert.equal(startCheck(read('src/App.jsx')), startCheck(atBefore('src/App.jsx')), 'Startprüfung wörtlich unverändert')
  assert.match(read('src/components/Auth/Login.jsx'), /sessionStorage\.setItem\('cafe_session_active', '1'\)/, 'Login setzt das Flag weiterhin')
})

// ── Teil 3: echter Chrome, mehrere Tabs desselben Browsers ──
const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, server, origin, HARNESS_ERR = null

const ENTRY = `
import { createClient } from '@supabase/supabase-js'
import { prepareSessionFlag, answerSessionPings } from ${JSON.stringify(resolve('src/lib/sessionTabs.js'))}
import { deviceSignOutOptions } from ${JSON.stringify(resolve('src/lib/signOutScope.js'))}
window.__calls = []
const fakeFetch = async (url, init) => { window.__calls.push(String(url)); return new Response(null, { status: 204 }) }
window.__startPings = () => answerSessionPings({ Channel: BroadcastChannel, session: sessionStorage })
window.__prepare = () => prepareSessionFlag({ session: sessionStorage, local: localStorage, Channel: BroadcastChannel })
window.__client = () => {
  if (!window.__sb) { window.__sb = createClient('https://proj.supabase.co', 'anon-key', { auth: { autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fakeFetch } }); window.__events = []; window.__sb.auth.onAuthStateChange(e => window.__events.push(e)) }
  return window.__sb
}
window.__signOut = () => window.__client().auth.signOut(deviceSignOutOptions())`

async function openTab() {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?${encodeURIComponent(origin + '/p.html')}`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  for (let i = 0; i < 50 && !(await ev('typeof window.__prepare === "function"').catch(() => false)); i++) await sleep(100)
  return { ev, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-session-'))
  try {
    const esbuild = await import('esbuild')
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'js', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', logLevel: 'silent' })).outputFiles[0].text
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`
    server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html) })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${server.address().port}`   // echter Ursprung: gemeinsamer Speicher + BroadcastChannel zwischen Tabs
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { proc?.ch.kill('SIGKILL'); server?.close(); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const ready = () => assert.ok(proc?.port && origin, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`)

test('Browser (2 Tabs, „nicht angemeldet bleiben“): neuer Tab übernimmt die Sitzung, solange ein angemeldeter Tab lebt; danach nicht mehr', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const a = await openTab()
  await a.ev(`localStorage.setItem('cafe_no_remember', '1'); sessionStorage.setItem('cafe_session_active', '1'); window.__startPings(); true`)
  const b = await openTab()
  assert.equal(await b.ev('sessionStorage.getItem("cafe_session_active")'), null, 'neuer Tab startet ohne Flag (sessionStorage je Tab)')
  assert.equal(await b.ev('window.__prepare()'), 'adopted')
  assert.equal(await b.ev('sessionStorage.getItem("cafe_session_active")'), '1')
  await a.ev(`sessionStorage.removeItem('cafe_session_active'); true`)   // Tab A meldet ab (App entfernt das Flag)
  await b.ev(`sessionStorage.removeItem('cafe_session_active'); true`)
  const c = await openTab()
  assert.equal(await c.ev('window.__prepare()'), 'none', 'kein angemeldeter Tab mehr → Startprüfung meldet wie bisher ab')
  for (const x of [a, b, c]) x.close()
})

test('Browser (2 Tabs): Abmelden in Tab A beendet die Sitzung in ALLEN Tabs dieses Geräts (SIGNED_OUT in Tab B), Server: scope=local', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const a = await openTab(), b = await openTab()
  const s = JSON.stringify(session())
  await a.ev(`localStorage.setItem('sb-proj-auth-token', ${JSON.stringify(s)}); true`)
  await a.ev('window.__client().auth.getSession().then(() => true)'); await b.ev('window.__client().auth.getSession().then(() => true)')
  assert.equal(await b.ev('window.__client().auth.getSession().then(r => !!r.data.session)'), true)
  await a.ev('window.__signOut().then(() => true)')
  await sleep(500)
  assert.equal(await a.ev(`localStorage.getItem('sb-proj-auth-token')`), null)
  assert.ok((await b.ev('window.__events')).includes('SIGNED_OUT'), 'Tab B erfährt die Abmeldung')
  assert.equal(await b.ev('window.__client().auth.getSession().then(r => r.data.session)'), null)
  assert.match((await a.ev('window.__calls')).find(u => u.includes('/auth/v1/logout')), /scope=local\b/)
  a.close(); b.close()
})
