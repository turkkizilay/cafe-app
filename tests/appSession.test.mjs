// Resilience Batch 2c (App.jsx): 2c-1 späte Profil-/Zugangs-Antworten verworfen (Kontowechsel, Abmelden, konkurrierende
// Anfragen), 2c-2 Fehlergrenze je Seite ohne Rohmeldung, 2c-3 Hinweise/Dokument-Links beim Abmelden entfernt.
// Teil 1: rein + Quelltext. Teil 2: ECHTE App.jsx (Seitenleiste, Routen, Seiten) in Headless Chrome gegen einen nachgebildeten
// Supabase-Client mit steuerbaren Auth-Ereignissen – inkl. Gegenproben mit dem Stand vor 2c. RLS/Server: tests/db.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequestGate } from '../src/lib/profileRequests.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = 'eac5e22'   // Stand vor Batch 2c
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

// ── Teil 1 ──
test('2c-1 Gate: neuere Anfrage gewinnt; Personenwechsel und Abmelden machen ungültig; erneute Anmeldung = neue Generation', () => {
  const g = createRequestGate()
  g.setUser('A')
  const a1 = g.begin('A'); assert.equal(g.isCurrent(a1), true)
  const a2 = g.begin('A'); assert.equal(g.isCurrent(a1), false, 'ältere Anfrage derselben Person'); assert.equal(g.isCurrent(a2), true)
  g.setUser('A'); assert.equal(g.isCurrent(a2), true, 'gleiche Person erneut gemeldet (z. B. Token erneuert): bleibt gültig')
  g.setUser(null); assert.equal(g.isCurrent(a2), false, 'Abmelden')
  g.setUser('B'); const b = g.begin('B'); assert.equal(g.isCurrent(b), true)
  assert.equal(g.isCurrent({ seq: b.seq, uid: 'A' }), false, 'fremde Person nie gültig')
  g.setUser(null); g.setUser('A'); assert.equal(g.isCurrent(a2), false, 'A nach Abmelden + Anmelden: alte Anfrage bleibt ungültig')
  assert.equal(g.isCurrent(null), false); assert.equal(g.isCurrent(undefined), false)
  assert.equal(g.user, 'A')
})

function checkApp(src) {
  const fp = src.slice(src.indexOf('  const fetchProfile = useCallback('), src.indexOf('  }, [])', src.indexOf('  const fetchProfile = useCallback(')))
  assert.match(fp, /const req = profileGate\.begin\(uid\)/)
  assert.equal((fp.match(/if \(!profileGate\.isCurrent\(req\)\) return/g) || []).length, 5, 'nach jedem await geprüft (Zugang, Profil, Kenntnisnahme, Zähler, Ausnahme)')
  const order = ['loadMyAccessState(supabase)', 'if (access.revoked)', ".from('profiles')", 'if (error) {', 'loadPrivacyAck(supabase, uid)', 'setPrivacyAck(prev']
  for (let i = 1; i < order.length; i++) assert.ok(fp.indexOf(order[i - 1]) < fp.indexOf(order[i]), order[i])
  const checkIdx = [...fp.matchAll(/if \(!profileGate\.isCurrent\(req\)\) return/g)].map(m => m.index)
  assert.ok(checkIdx[0] > fp.indexOf('loadMyAccessState(supabase)') && checkIdx[0] < fp.indexOf('if (access.revoked)'), 'veraltetes „revoked“ meldet nie ab')
  assert.equal((src.match(/profileGate\.setUser\(/g) || []).length, 3, 'Start, Auth-Ereignisse, Sichtbarkeit ohne Sitzung')
  assert.match(src, /setProfile\(null\)\s*\n\s*clearToasts\(\)/, 'Abmelden entfernt Hinweise')
  assert.doesNotMatch(src, /class ErrorBoundary|this\.state\.error\.message|localizeMessage\(this\.state\.error/, 'keine innere Grenze mit Rohmeldung')
  assert.match(src, /<RouteErrorBoundary>\s*\n\s*<Routes>/)
  assert.match(src, /<\/Routes>\s*\n\s*<\/RouteErrorBoundary>/)
}
test('App.jsx: Gate nach jedem await, setUser an allen Auth-Stellen, Seiten-Grenze, Hinweise beim Abmelden entfernt', () => checkApp(read('src/App.jsx')))
test('Gegenprobe Quelltext: Stand vor 2c erfüllt die Prüfung nicht', () => assert.throws(() => checkApp(atBefore('src/App.jsx'))))

test('App.jsx: unverändert – Reihenfolge der Bildschirme, F1-Pfad, Abmelden-Reset, Routen-Rechte, Shell-Struktur; keine neuen API-Aufrufe', () => {
  const now = read('src/App.jsx'), was = atBefore('src/App.jsx')
  const screens = s => ['if (loading && !profile) return (', 'if (!session) return (', 'if (mustChangePw) return (', 'if (fetchErr) return (', "if (profile?.status === 'disabled') return (", "if (profile?.status === 'pending') return ("].map(k => s.indexOf(k))
  assert.deepEqual(screens(now).map((x, i, a) => i === 0 || x > a[i - 1]), screens(was).map((x, i, a) => i === 0 || x > a[i - 1]))
  assert.ok(screens(now).every(x => x > 0))
  for (const k of ["if (profileLoadOutcome({ failed: true, transient: isTransientFailure(status), uid, loadedUid: loadedUidRef.current }) === 'keep') {",
    "if (access.revoked) { await supabase.auth.signOut({ scope: 'local' }); setLoading(false); return }",
    "setPrivacyAck({ uid: null, state: 'checking' })", 'path="/lohn"            element={isAdmin   ? <Payroll />        : <AccessDenied />}', '<RefreshButton />'])
    assert.ok(now.includes(k) && was.includes(k), k)
  const calls = s => (s.match(/supabase\s*\.(from|rpc|auth\.\w+)\([^)]*\)/g) || []).join('\n')
  assert.equal(calls(now), calls(was), 'API-/Auth-Aufrufe unverändert')
})

test('Toast.jsx: nur clearToasts ergänzt (Hinweise + Dokument-Link-Dialog), sonst unverändert', () => {
  const now = read('src/components/UI/Toast.jsx'), was = atBefore('src/components/UI/Toast.jsx')
  const block = now.slice(now.indexOf('\n// Beim Abmelden/Personenwechsel'), now.indexOf('export function useToast()'))
  assert.match(block, /export function clearToasts\(\) \{\n  _map\.clear\(\)\n  _notify\(\)\n  clearOpenFallback\(\)\n\}/)
  assert.equal(now.replace(block, '\n'), was, 'Rest byte-gleich')
})

test('DE/EN/BN: Texte der Seiten-Fehlergrenze vollständig, BN bengalisch, keine technischen Details', () => {
  for (const k of ['routeError.title', 'routeError.text', 'routeError.reload', 'routeError.home']) {
    assert.ok(de[k] && en[k] && bn[k], k); assert.match(bn[k], /[ঀ-৿]/, k)
    assert.doesNotMatch(de[k] + en[k], /stack|undefined|Error:/i)
  }
})

// ── Teil 2: echte App im Browser ──
const FAKE = String.raw`
(() => {
  const S = window.__S = { session: null, subs: [], users: {}, accessDelay: {}, accessRevoked: {}, profileDelay: {}, profileQueue: {}, signOuts: 0, log: [] }
  const mkSession = uid => ({ access_token: 'tok-' + uid + '-' + Math.random(), user: { id: uid, email: S.users[uid].email } })
  const emit = (ev, s) => { for (const fn of S.subs.slice()) fn(ev, s) }
  window.__login = uid => { S.session = mkSession(uid); emit('SIGNED_IN', S.session) }
  window.__logout = () => { S.session = null; emit('SIGNED_OUT', null) }
  window.__emit = ev => emit(ev, S.session)
  const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms || 0))
  const caller = () => S.session ? S.session.user.id : null
  function builder(table) {
    const q = { table, eq: [], head: false, one: false }
    const api = new Proxy(function () {}, { get(_, k) {
      if (k === 'then') return (res, rej) => run().then(res, rej)
      if (k === 'eq') return (c, v) => { q.eq.push([c, v]); return api }
      if (k === 'select') return (c, o) => { if (o && o.head) q.head = true; return api }
      if (k === 'maybeSingle' || k === 'single') return () => { q.one = true; return api }
      return () => api
    }, apply: () => api })
    async function run() {
      const uid = caller(); S.log.push(table + ':' + uid)
      if (table === 'profiles' && !q.head && q.eq.some(([c]) => c === 'id')) {
        const id = q.eq.find(([c]) => c === 'id')[1]
        const queue = S.profileQueue[id]
        const step = queue && queue.length ? queue.shift() : { ms: S.profileDelay[id] || 0, row: S.users[id].profile }
        return delay(step.ms, { data: q.one ? step.row : [step.row], error: null, status: 200 })
      }
      if (table === 'privacy_notice_acknowledgements') { const row = { notice_version: '2026-09-28' }; return { data: q.one ? row : [row], error: null, status: 200 } }
      if (q.head) return { data: null, count: 0, error: null, status: 200 }
      return { data: q.one ? null : [], error: null, status: 200 }
    }
    return api
  }
  window.__supabase = {
    from: builder,
    rpc: async name => {
      if (name === 'my_access_state') {
        const uid = caller(); const ms = S.accessDelay[uid] || 0; const revoked = S.accessRevoked[uid]
        return delay(ms, revoked ? { data: null, error: { message: 'revoked', hint: 'session_revoked' } } : { data: { must_change_password: false }, error: null })
      }
      return { data: null, error: null }
    },
    auth: {
      getSession: async () => ({ data: { session: S.session }, error: null }),
      getUser: async () => ({ data: { user: S.session ? S.session.user : null }, error: null }),
      onAuthStateChange: fn => { S.subs.push(fn); return { data: { subscription: { unsubscribe: () => { S.subs = S.subs.filter(x => x !== fn) } } } } },
      signOut: async () => { S.signOuts++; S.session = null; emit('SIGNED_OUT', null); return { error: null } },
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/doc' }, error: null }) }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  }
})()`
const STUB_SUPABASE = `export const supabase = window.__supabase
export const getInitials = (a, b) => ((a || '')[0] || '') + ((b || '')[0] || '')
export const getAvatarColor = () => 'blue'
export const formatDate = d => d || '–'
export const formatDateLong = d => d || '–'
export const formatDateShort = d => d || '–'
export const formatDateTime = d => d || '–'
export const formatMonthYear = (y, m) => y + '-' + m
export const toLocalDateStr = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
export const todayISO = () => toLocalDateStr(new Date())
export const parseISODate = d => (d ? new Date(d + 'T00:00:00') : null)
export const formatTime = s => s || '–'
export const formatCurrency = a => String(a)
export const getDistanceMeters = () => 0
export const fetchWithSkewRetry = (...a) => fetch(...a)`
// „Meine Stunden“ wird für den Seitenfehler-Test durch eine Seite ersetzt, die auf Wunsch abstürzt
const STUB_MYHOURS = `export default function MyHoursStub() {
  if (window.__boom === 'chunk') throw new TypeError('Failed to fetch dynamically imported module: https://cafe.example/assets/MyHours-old.js')
  if (window.__boom) throw new Error("Cannot read properties of undefined (reading 'secretPayrollField')"); return null }`
const entry = which => `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import { showToast } from ${JSON.stringify(resolve('src/components/UI/Toast.jsx'))}
import { openSignedFile } from ${JSON.stringify(resolve('src/lib/openFile.js'))}
import App from ${JSON.stringify(which)}
window.__toast = showToast
window.__openDoc = () => { window.open = () => null; return openSignedFile(async () => 'https://signed.example/payroll-alice.pdf', 'Lohnabrechnung Alice') }
window.__mount = () => createRoot(document.getElementById('app')).render(<LocaleProvider><App /></LocaleProvider>)`

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, HARNESS_ERR = null
const files = {}, servers = [], origins = {}

async function openPage(which) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  await send('Page.enable'); await send('Page.navigate', { url: origins[which] + '/' }); await sleep(600); await send('Page.bringToFront')
  const text = () => ev('document.body.innerText')
  const waitText = async (re, what) => { for (let i = 0; i < 200; i++) { if (re.test(await text())) return; await sleep(25) } throw new Error('nicht erreicht: ' + what + ' | ' + (await text()).slice(0, 200)) }
  return { ev, text, waitText, close: () => ws.close() }
}
// Personen: Alice (Admin), Bruno (Mitarbeiter) – synthetisch
const SETUP = `(() => { const S = window.__S
  S.users.A = { email: 'alice@example.invalid', profile: { id: 'A', role: 'admin', status: 'approved', employee_id: null, first_name: 'Alice', last_name: 'Admin', email: 'alice@example.invalid' } }
  S.users.B = { email: 'bruno@example.invalid', profile: { id: 'B', role: 'employee', status: 'approved', employee_id: null, first_name: 'Bruno', last_name: 'Staff', email: 'bruno@example.invalid' } }
  return true })()`
// eine frische Seite je Szenario (eigener Modulzustand), angemeldet als A
async function fresh(which) {
  const p = await openPage(which)
  await p.ev(SETUP); await p.ev(`window.__S.session = { access_token: 't', user: { id: 'A', email: 'alice@example.invalid' } }; window.__mount(); true`)
  await p.waitText(/alice@example\.invalid/, 'Shell von Alice')
  // Start ohne jede Fehlergrenze (sonst wären die folgenden Prüfungen nicht aussagekräftig)
  assert.equal(await p.ev(`!!document.querySelector('[data-testid="route-error-boundary"], [data-testid="app-error-boundary"]') || /Etwas ist schiefgelaufen/.test(document.body.innerText)`), false, 'App startet fehlerfrei')
  return p
}
// Abtasten: erscheint während B's Sitzung irgendwann Alice?
async function sample(p, ms) {
  const seen = new Set(); const end = Date.now() + ms
  while (Date.now() < end) { const t = await p.text(); if (/alice@example\.invalid|Alice/.test(t)) seen.add('alice'); if (/bruno@example\.invalid/.test(t)) seen.add('bruno'); await sleep(40) }
  return seen
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-app-session-'))
  try {
    const esbuild = await import('esbuild')
    const plugin = { name: 'stubs', setup(b) {
      b.onResolve({ filter: /(^|\/)supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }))
      b.onResolve({ filter: /(^|\/)pages\/MyHours(\.jsx)?$/ }, () => ({ path: 'myhours-stub', namespace: 'stub' }))
      b.onLoad({ filter: /^supabase-stub$/, namespace: 'stub' }, () => ({ contents: STUB_SUPABASE, loader: 'js' }))
      b.onLoad({ filter: /^myhours-stub$/, namespace: 'stub' }, () => ({ contents: STUB_MYHOURS, loader: 'jsx' }))
      b.onResolve({ filter: /^before:App$/ }, () => ({ path: 'App.before.jsx', namespace: 'before' }))
      b.onLoad({ filter: /.*/, namespace: 'before' }, () => ({ contents: atBefore('src/App.jsx'), loader: 'jsx', resolveDir: resolve('src') }))
    } }
    for (const [name, which] of [['now', resolve('src/App.jsx')], ['before', 'before:App']]) {
      const js = (await esbuild.build({ stdin: { contents: entry(which), loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [plugin],
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"' }, logLevel: 'silent' })).outputFiles[0].text
      files[name] = join(dir, `${name}.html`)
      const html = `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${read('src/index.css')}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de') } catch {}</script><script>${FAKE}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`
      writeFileSync(files[name], html)
      const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html) })
      await new Promise(r => srv.listen(0, '127.0.0.1', r)); servers.push(srv)
      origins[name] = `http://127.0.0.1:${srv.address().port}`
    }
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { proc?.ch.kill('SIGKILL'); for (const s of servers) s.close(); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const ready = () => assert.ok(proc?.port && files.now, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`)

async function switchScenario(which) {
  const p = await fresh(which)
  // A's Profil lädt jetzt langsam; Neuladen anstoßen (wie „Profil geändert“), dann sofort abmelden und als B anmelden
  await p.ev(`window.__S.profileDelay.A = 900; window.__emit('USER_UPDATED'); true`)
  await sleep(60)
  await p.ev(`window.__logout(); window.__login('B'); true`)
  const seen = await sample(p, 1800)
  const final = await p.text()
  p.close()
  return { seen, final }
}
test('Browser 2c-1: Kontowechsel A → B mit verspäteter Profilantwort – B sieht NIE Daten von A', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const { seen, final } = await switchScenario('now')
  assert.ok(seen.has('bruno'), 'B angemeldet'); assert.ok(!seen.has('alice'), 'A erscheint zu keinem Zeitpunkt')
  assert.match(final, /bruno@example\.invalid/); assert.doesNotMatch(final, /Alice|alice@example/)
})
test('Gegenprobe Browser 2c-1: Stand vor 2c zeigt nach dem Wechsel A’s Profil in B’s Sitzung', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const { seen } = await switchScenario('before')
  assert.ok(seen.has('alice'))
})

async function revokedScenario(which) {
  const p = await fresh(which)
  await p.ev(`window.__S.accessDelay.A = 700; window.__S.accessRevoked.A = true; window.__emit('USER_UPDATED'); true`)   // spätes „revoked“ für A
  await sleep(60)
  await p.ev(`window.__logout(); window.__S.signOuts = 0; window.__login('B'); true`)
  await sleep(1400)
  const r = { signOuts: await p.ev('window.__S.signOuts'), session: await p.ev('window.__S.session && window.__S.session.user.id'), text: await p.text() }
  p.close(); return r
}
test('Browser 2c-1: veraltete my_access_state-Antwort („revoked“ für A) meldet B NICHT ab', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const r = await revokedScenario('now')
  assert.deepEqual([r.signOuts, r.session], [0, 'B']); assert.match(r.text, /bruno@example\.invalid/)
})
test('Gegenprobe Browser 2c-1: Stand vor 2c meldet B durch A’s veraltete Antwort ab', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const r = await revokedScenario('before')
  assert.ok(r.signOuts >= 1); assert.equal(r.session, null)
})

async function concurrentScenario(which) {
  const p = await fresh(which)
  // zwei Ladungen derselben Person: die erste (alt: Admin) kommt spät, die zweite (neu: Mitarbeiter) sofort
  await p.ev(`(() => { const S = window.__S, old = { ...S.users.A.profile }, neu = { ...S.users.A.profile, role: 'employee' }
    S.users.A.profile = neu; S.profileQueue.A = [{ ms: 900, row: old }, { ms: 0, row: neu }]; window.__emit('USER_UPDATED'); setTimeout(() => window.__emit('USER_UPDATED'), 50); return true })()`)
  await sleep(1500)
  const r = await p.ev(`[...document.querySelectorAll('aside.sidebar a[href]')].map(a => a.getAttribute('href'))`)   // nur die Navigation (Rechte aus dem Profil)
  p.close(); return r
}
test('Browser 2c-1: zwei konkurrierende Profilanfragen – die neuere gewinnt (Rolle neu: kein Admin-Menü mehr)', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const links = await concurrentScenario('now')
  assert.ok(!links.includes('/benutzer') && !links.includes('/lohn'), 'veraltete Admin-Antwort überschreibt nicht')
})
test('Gegenprobe Browser 2c-1: Stand vor 2c lässt die ältere (Admin-)Antwort gewinnen', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const links = await concurrentScenario('before')
  assert.ok(links.includes('/benutzer'))
})

test('Browser 2c-1: Abmelden und erneute Anmeldung derselben Person – Profil wird normal geladen (kein Hängen)', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const p = await fresh('now')
  await p.ev(`window.__logout(); true`); await p.waitText(/Anmelden|E-Mail/, 'Anmeldung')
  await p.ev(`window.__login('A'); true`); await p.waitText(/alice@example\.invalid/, 'wieder angemeldet')
  assert.doesNotMatch(await p.text(), /Wird geladen|Lädt/)
  p.close()
})

async function toastScenario(which) {
  const p = await fresh(which)
  await p.ev(`window.__toast('Urlaub von Alice Admin genehmigt', 'success', 10000); window.__openDoc(); true`)
  await sleep(300)
  const beforeLogout = await p.text()
  await p.ev(`window.__logout(); window.__login('B'); true`)
  await p.waitText(/bruno@example\.invalid/, 'B angemeldet'); await sleep(300)
  // Realistischer Auslöser: B bekommt einen eigenen Hinweis – gespeicherte Hinweise von A würden dabei wieder erscheinen
  await p.ev(`window.__toast('Hinweis für Bruno', 'info', 5000); true`); await sleep(300)
  const r = { beforeLogout, after: await p.text(), dialog: await p.ev(`[...document.querySelectorAll('.modal-overlay a[href]')].map(a => a.href)`) }
  p.close(); return r
}
test('Browser 2c-3: Hinweise und Dokument-Link der vorherigen Person sind nach dem Kontowechsel weg', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const r = await toastScenario('now')
  assert.match(r.beforeLogout, /Urlaub von Alice Admin genehmigt/, 'Testaufbau: Hinweis sichtbar')
  assert.match(r.beforeLogout, /Lohnabrechnung Alice/, 'Testaufbau: Dokument-Link-Dialog sichtbar')
  assert.match(r.after, /Hinweis für Bruno/, 'B’s eigener Hinweis erscheint')
  assert.doesNotMatch(r.after, /Urlaub von Alice Admin genehmigt|Lohnabrechnung Alice/)
  assert.deepEqual(r.dialog, [], 'kein Link auf A’s Dokument')
})
test('Gegenprobe Browser 2c-3: Stand vor 2c zeigt A’s gespeicherten Hinweis bei B, sobald B einen Hinweis bekommt', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const r = await toastScenario('before')
  assert.match(r.after, /Hinweis für Bruno/)
  assert.match(r.after, /Urlaub von Alice Admin genehmigt/, 'A’s gespeicherter Hinweis erscheint bei B')
})

async function pageCrashScenario(which) {
  const p = await fresh(which)
  await p.ev(`window.__boom = true; history.pushState({}, '', '/stunden'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(500)
  const crashed = { text: await p.text(), nav: await p.ev(`document.querySelectorAll('a[href="/"]').length`), boundary: await p.ev(`!!document.querySelector('[data-testid="route-error-boundary"]')`), url: await p.ev('location.pathname') }
  await p.ev(`window.__boom = false; history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(500)
  const recovered = { boundary: await p.ev(`!!document.querySelector('[data-testid="route-error-boundary"]')`), text: await p.text(), url: await p.ev('location.pathname') }
  p.close(); return { crashed, recovered }
}
test('Browser 2c-2: Seitenfehler → Hinweis nur im Inhaltsbereich, Navigation bleibt, keine Fehlermeldung; Seitenwechsel stellt wieder her', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const { crashed, recovered } = await pageCrashScenario('now')
  assert.equal(crashed.boundary, true); assert.ok(crashed.nav > 0, 'Seitenleiste/Navigation noch da')
  assert.match(crashed.text, /Diese Seite konnte nicht angezeigt werden/)
  assert.match(crashed.text, /alice@example\.invalid/, 'Sitzung/Shell bleibt')
  assert.doesNotMatch(crashed.text, /secretPayrollField|Cannot read|undefined|at MyHoursStub/)
  assert.equal(crashed.url, '/stunden', 'kein automatisches Neuladen/Umleiten')
  assert.deepEqual([recovered.boundary, recovered.url], [false, '/'])
})
test('Gegenprobe Browser 2c-2: Stand vor 2c ersetzt die ganze Shell und zeigt die Rohmeldung', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const { crashed } = await pageCrashScenario('before')
  assert.match(crashed.text, /secretPayrollField|Cannot read/)
  assert.equal(crashed.nav, 0)
})

test('Browser 2c-2: Chunk-Ladefehler einer Seite → Hinweis „neue Version/Verbindung“, Navigation bleibt, kein Auto-Neuladen, keine URL/Details', async t => {
  if (SKIP) return t.skip(SKIP)
  ready()
  const p = await fresh('now')
  await p.ev(`window.__marker = 'unverändert'; window.__boom = 'chunk'; history.pushState({}, '', '/stunden'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await sleep(600)
  const text = await p.text()
  assert.match(text, /Ein Teil der App konnte nicht geladen werden/)
  assert.doesNotMatch(text, /MyHours-old|assets\/|Failed to fetch/)
  assert.ok(await p.ev(`document.querySelectorAll('aside.sidebar a[href]').length > 0`), 'Navigation bleibt')
  assert.deepEqual([await p.ev('window.__marker'), await p.ev('location.pathname')], ['unverändert', '/stunden'], 'kein Neuladen/Umleiten')
  p.close()
})
