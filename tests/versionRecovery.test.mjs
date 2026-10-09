// Resilience Safe Batch 1: F7-a (äußere Fehlergrenze), F8 (App-Version + Chunk-Fehler), F9-c (Timeout-Texte).
// Teil 1: reine Logik + Quelltext + echter Vite-Build (version.json = Build-ID im Bundle). Teil 2: echte Komponenten in
// Headless Chrome – Absturz → Fehleranzeige statt weißer Seite, nie automatisches Neuladen, Banner mit Schutz ungespeicherter Eingaben.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createVersionChecker, isChunkLoadError, isBuildId, CHECK_MIN_GAP_MS, CHECK_TIMEOUT_MS } from '../src/lib/versionCheck.js'
import { setRuntimeLocale, localizeMessage, errorMessage, messageParts, message } from '../src/i18n/runtime.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const read = f => readFileSync(f, 'utf8')
const BEFORE = '408621e'   // Stand vor Safe Batch 1
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const ID_A = 'a'.repeat(40), ID_B = 'b'.repeat(40)

function fakeTimers() {
  const timers = new Map(); let id = 0
  return { timers, setTimer: (f, ms) => { timers.set(++id, { f, ms }); return id }, clearTimer: i => timers.delete(i), fireAll() { for (const [i, t] of [...timers]) { timers.delete(i); t.f() } } }
}
const json = body => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })

// ── F8: Versionsprüfung ──
test('F8: gleiche Build-ID → kein Hinweis; andere → Hinweis; ohne gültige eigene ID (Entwicklung) → Prüfung aus', async () => {
  let t = 0; const calls = []
  const c = createVersionChecker({ currentId: ID_A, now: () => t, fetchImpl: (url, init) => { calls.push({ url, init }); return json({ build: ID_A }) }, ...fakeTimers() })
  assert.equal(await c.check(), 'current'); assert.equal(c.getState().available, false)
  assert.match(calls[0].url, /^\/version\.json\?t=\d+$/); assert.equal(calls[0].init.cache, 'no-store')
  t += CHECK_MIN_GAP_MS
  const d = createVersionChecker({ currentId: ID_A, now: () => t, fetchImpl: () => json({ build: ID_B }), ...fakeTimers() })
  const seen = []; d.subscribe(s => seen.push(s))
  assert.equal(await d.check(), 'new'); assert.deepEqual(d.getState(), { available: true, reason: 'version' }); assert.equal(seen.length, 1)
  for (const id of ['dev', '', null, undefined, 'unknown'])
    assert.equal(await createVersionChecker({ currentId: id, fetchImpl: () => { throw new Error('darf nicht abrufen') } }).check(), 'disabled', String(id))
  assert.ok(isBuildId(ID_A) && isBuildId('408621e') && !isBuildId('dev'))
})

test('F8: höchstens alle 60 s, nie parallel; Zeitgrenze; Fehler/offline/ungültige Antwort → still, kein Hinweis', async () => {
  let t = 1e6, n = 0, release
  const tm = fakeTimers()
  const c = createVersionChecker({ currentId: ID_A, now: () => t, ...tm, fetchImpl: () => { n++; return new Promise(r => { release = r }) } })
  const p1 = c.check(), p2 = c.check()
  assert.equal(p1, p2, 'derselbe Lauf'); await flush(); release({ ok: true, json: () => ({ build: ID_A }) }); await p1
  assert.equal(await Promise.race([c.check(), new Promise(r => setTimeout(() => r('hängt'), 200))]), 'throttled', 'innerhalb 60 s kein neuer Abruf'); t += CHECK_MIN_GAP_MS
  const hang = createVersionChecker({ currentId: ID_A, now: () => t, ...tm, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))) })
  const ph = hang.check(); await flush()
  assert.ok([...tm.timers.values()].some(x => x.ms === CHECK_TIMEOUT_MS)); tm.fireAll()
  assert.equal(await ph, 'error'); assert.equal(hang.getState().available, false)
  for (const impl of [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.resolve({ ok: false }), () => json({ build: 'kaputt' }), () => json(null)]) {
    const x = createVersionChecker({ currentId: ID_A, fetchImpl: impl, ...fakeTimers() })
    await x.check(); assert.equal(x.getState().available, false)
  }
  assert.equal(n, 1)
})

test('F8: „Später“ blendet diese Version aus, bis eine ANDERE erscheint oder ein Chunk fehlt; Abonnenten-Fehler stören nie', async () => {
  let t = 0, served = ID_B
  const c = createVersionChecker({ currentId: ID_A, now: () => t, fetchImpl: () => json({ build: served }), ...fakeTimers() })
  c.subscribe(() => { throw new Error('Anzeige kaputt') })
  await c.check(); assert.equal(c.getState().available, true)
  c.dismiss(); assert.equal(c.getState().available, false)
  t += CHECK_MIN_GAP_MS; await c.check(); assert.equal(c.getState().available, false, 'gleiche neue Version: nicht erneut')
  served = 'c'.repeat(40); t += CHECK_MIN_GAP_MS; await c.check(); assert.equal(c.getState().available, true, 'noch neuere Version')
  c.dismiss(); c.reportChunkFailure(); assert.deepEqual(c.getState(), { available: true, reason: 'chunk' })
})

test('F8: Chunk-Ladefehler aller Browser erkannt, normale Fehler nicht', () => {
  for (const m of ['Failed to fetch dynamically imported module: https://x/assets/IntegrationCenter-abc.js', 'Importing a module script failed.',
    'error loading dynamically imported module', 'Loading chunk 42 failed.', 'Unable to preload CSS for /assets/x.css'])
    assert.equal(isChunkLoadError(new TypeError(m)), true, m)
  assert.equal(isChunkLoadError({ name: 'ChunkLoadError', message: '' }), true)
  for (const m of ["Cannot read properties of undefined (reading 'x')", 'TypeError: Failed to fetch', 'request-timeout-read'])
    assert.equal(isChunkLoadError(new Error(m)), false, m)
})

test('F8: Einbindung – nur bestehende Ereignisse (F4-Auslöser), Hinweis statt Neuladen, Fehlergrenze + Banner in main.jsx', () => {
  const ctx = read('src/context/RefreshContext.jsx')
  assert.equal((ctx.match(/createResumeTrigger\(/g) || []).length, 1, 'kein zweiter Auslöser')
  assert.match(ctx, /onTrigger: \(\) => \{ checkForNewVersion\(\); return controller\.refresh\(\{ auto: true \}\) \}/)
  for (const f of ['src/lib/versionCheck.js', 'src/context/RefreshContext.jsx', 'src/main.jsx', 'src/components/AppErrorBoundary.jsx'])
    assert.doesNotMatch(read(f).replace(/\/\/.*$/gm, ''), /setInterval|addEventListener\('(visibilitychange|focus|pageshow|online)'/, `${f}: kein eigenes Polling/keine neuen Lebenszyklus-Listener`)
  assert.doesNotMatch(read('src/lib/versionCheck.js').replace(/\/\/.*$/gm, ''), /location\.reload/, 'Prüfung lädt nie neu')
  const main = read('src/main.jsx')
  assert.match(main, /<AppErrorBoundary>\s*\n\s*<App \/>\s*\n\s*<\/AppErrorBoundary>\s*\n\s*<UpdateBanner \/>/)
  assert.match(main, /installModalA11y\(document\)/); assert.doesNotMatch(main, /key=\{locale\}/)
  assert.match(main, /addEventListener\('vite:preloadError', \(\) => \{ reportChunkFailure\(\) \}\)/)
  const preloadLine = main.split('\n').find(l => l.includes('vite:preloadError'))
  assert.doesNotMatch(preloadLine, /preventDefault/, 'Chunk-Fehler wird nicht verschluckt (Fehlergrenze zeigt ihn)')
  // PWA-Strategie unverändert: Service Worker ohne Cache, kein Fetch-Handler
  assert.equal(read('public/sw.js'), execFileSync('git', ['show', `${BEFORE}:public/sw.js`], { encoding: 'utf8' }))
  assert.doesNotMatch(read('public/sw.js'), /addEventListener\('fetch'/)
  const v = JSON.parse(read('vercel.json'))
  const hdr = v.headers.find(h => h.source === '/version.json')
  assert.ok(hdr && /no-store/.test(hdr.headers.find(x => x.key === 'Cache-Control').value), 'version.json nie gecacht')
  assert.deepEqual(v.rewrites, [{ source: '/(.*)', destination: '/index.html' }], 'SPA-Rewrite unverändert')
})

test('F8: echter Vite-Build – version.json und Bundle tragen dieselbe Build-ID (Vercel-Commit)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'cafe-build-'))
  const prev = process.env.VERCEL_GIT_COMMIT_SHA
  process.env.VERCEL_GIT_COMMIT_SHA = 'DEADBEEF'.toLowerCase() + '0'.repeat(32)
  try {
    const vite = await import('vite')
    await vite.build({ configFile: resolve('vite.config.js'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })
    const ver = JSON.parse(read(join(out, 'version.json')))
    assert.equal(ver.build, process.env.VERCEL_GIT_COMMIT_SHA)
    const js = readdirSync(join(out, 'assets')).filter(f => /^index-.*\.js$/.test(f)).map(f => read(join(out, 'assets', f))).join('')
    assert.ok(js.includes(`"${ver.build}"`), 'Build-ID im Bundle')
  } finally {
    if (prev === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA; else process.env.VERCEL_GIT_COMMIT_SHA = prev
    rmSync(out, { recursive: true, force: true })
  }
})

// ── F9-c: Timeout-Texte ──
test('F9-c: errorMessage zeigt Timeouts verständlich in DE/EN/BN (Deskriptor, sprachwechselfest); andere Texte unverändert', () => {
  const read_ = errorMessage({ message: 'AbortError: request-timeout-read', hint: 'Request was aborted (timeout or manual cancellation)', code: '' })
  const write = errorMessage({ message: 'AbortError: request-timeout-write' })
  const inParts = messageParts([message('ui.85443be5173c'), write])
  for (const [loc, cat] of [['de', de], ['en', en], ['bn', bn]]) {
    setRuntimeLocale(loc)
    assert.equal(localizeMessage(read_), cat['error.timeoutRead'])
    assert.equal(localizeMessage(write), cat['error.timeoutWrite'])
    assert.ok(localizeMessage(inParts).endsWith(cat['error.timeoutWrite']))
    assert.doesNotMatch(localizeMessage(inParts), /AbortError|request-timeout/)
  }
  setRuntimeLocale('de')
  assert.equal(errorMessage({ message: 'Die IBAN ist ungültig.' }), 'Die IBAN ist ungültig.')
  assert.equal(errorMessage({ message: 'TypeError: Failed to fetch' }), 'TypeError: Failed to fetch')
  assert.equal(errorMessage({ displayMessage: 'X', message: 'AbortError: request-timeout-read' }), 'X', 'eigene Anzeige hat Vorrang')
  assert.equal(errorMessage(null), undefined)
  assert.doesNotMatch(de['error.timeoutWrite'], /fehlgeschlagen/i)
})

test('DE/EN/BN: alle neuen Texte vorhanden, BN in bengalischer Schrift', () => {
  const keys = ['errorBoundary.title', 'errorBoundary.text', 'errorBoundary.chunkTitle', 'errorBoundary.chunkText', 'errorBoundary.reload', 'errorBoundary.home',
    'update.available', 'update.chunk', 'update.reload', 'update.later', 'update.unsavedConfirm']
  for (const k of keys) { assert.ok(de[k] && en[k] && bn[k], k); assert.match(bn[k], /[ঀ-৿]/, k) }
  for (const k of keys) assert.doesNotMatch(de[k] + en[k], /stack|undefined|Error:/i, `${k}: keine technischen Details`)
})

// ── Teil 2: echte Komponenten im Browser ──
const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, page = null, HARNESS_ERR = null

const ENTRY = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import AppErrorBoundary from ${JSON.stringify(resolve('src/components/AppErrorBoundary.jsx'))}
import UpdateBanner from ${JSON.stringify(resolve('src/components/UpdateBanner.jsx'))}
import { checkForNewVersion, reportChunkFailure } from ${JSON.stringify(resolve('src/lib/versionCheck.js'))}
window.__checkForNewVersion = checkForNewVersion
window.__reportChunkFailure = reportChunkFailure
window.__served = ${JSON.stringify(ID_A)}
const realFetch = window.fetch
window.fetch = (url, init) => String(url).startsWith('/version.json') ? Promise.resolve(new Response(JSON.stringify({ build: window.__served }), { status: 200 })) : realFetch(url, init)
window.__reloads = 0
window.__marker = 'unverändert'
function Bomb({ kind }) {
  if (kind === 'render') throw new Error("Cannot read properties of undefined (reading 'secretField')")
  if (kind === 'chunk') throw new TypeError('Failed to fetch dynamically imported module: https://x/assets/IntegrationCenter-old.js')
  return <div id="ok">ok</div>
}
const root = createRoot(document.getElementById('app'))
window.__mount = kind => root.render(<LocaleProvider><AppErrorBoundary key={Math.random()}><Bomb kind={kind} /></AppErrorBoundary><UpdateBanner /><input id="field" /></LocaleProvider>)`

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-version-'))
  try {
    const esbuild = await import('esbuild')
    const stub = { name: 'stubs', setup(b) {
      b.onResolve({ filter: /(^|\/)supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const supabase = {}', loader: 'js' }))
    } }
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [stub],
      define: { 'process.env.NODE_ENV': '"production"', __APP_BUILD_ID__: JSON.stringify(ID_A), 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"' }, logLevel: 'silent' })).outputFiles[0].text
    // location.reload ist im Browser nicht überschreibbar → Zähler über einen Proxy im Bundle ist nicht möglich; stattdessen:
    // ein Neuladen würde window.__marker zurücksetzen (neue Seite) – die Tests prüfen, dass der Marker erhalten bleibt.
    writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${read('src/index.css')}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de') } catch {}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    let id = 0; const pending = new Map()
    const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
    const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
    const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
    await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(join(dir, 'p.html')).href }); await sleep(800)
    await send('Page.bringToFront')
    page = { ev, close: () => ws.close() }
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { try { page?.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = () => { assert.ok(page, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); return page }
const view = p => p.ev(`({ boundary: !!document.querySelector('[data-testid="app-error-boundary"]'), text: document.querySelector('[data-testid="app-error-boundary"]')?.innerText ?? document.body.innerText,
  buttons: [...document.querySelectorAll('[data-testid="app-error-boundary"] button')].map(b => b.innerText),
  banner: document.querySelector('[data-testid="update-banner"]')?.innerText ?? null, ok: !!document.getElementById('ok'), marker: window.__marker })`)

test('Browser F7-a: Darstellungsfehler → verständliche Fehleranzeige statt weißer Seite, KEINE technischen Details, kein Auto-Neuladen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P()
  await p.ev(`window.__mount('none')`); await sleep(200)
  assert.equal((await view(p)).ok, true)
  await p.ev(`window.__mount('render')`); await sleep(1500)
  const v = await view(p)
  assert.equal(v.boundary, true, 'keine weiße Seite')
  assert.match(v.text, /Hier ist etwas schiefgelaufen/)
  assert.deepEqual(v.buttons, ['Neu laden', 'Zur Startseite'])
  assert.doesNotMatch(v.text, /secretField|Cannot read|undefined|at Bomb|\.jsx/, 'keine Fehlermeldung/Stacktrace sichtbar')
  assert.equal(v.marker, 'unverändert', 'kein automatisches Neuladen')
})

test('Browser F7-a/F8: Chunk-Ladefehler → Hinweis „Teil der App …“ + Banner „neue Version“, kein Auto-Neuladen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P()
  await p.ev(`window.__mount('chunk')`); await sleep(1500)
  const v = await view(p)
  assert.equal(v.boundary, true)
  assert.match(v.text, /Ein Teil der App konnte nicht geladen werden/)
  assert.doesNotMatch(v.text, /IntegrationCenter|assets\//)
  assert.match(v.banner || '', /Ein Teil der App konnte nicht geladen werden/)
  assert.equal(v.marker, 'unverändert')
})

test('Browser F8: neue Version → Banner; „Neu laden“ bei ungespeicherter Eingabe fragt vorher und lädt bei „Abbrechen“ NICHT', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P()
  await p.ev(`window.__mount('none')`); await sleep(200)
  await p.ev(`(() => { const b = document.querySelector('[data-testid="update-banner"] button:last-child'); b && b.click() })()`)   // evtl. Banner aus vorherigem Test schließen
  await p.ev(`window.__served = ${JSON.stringify(ID_B)}`)
  const r = await p.ev(`window.__checkForNewVersion()`)
  assert.equal(r, 'new'); await sleep(200)
  assert.match((await view(p)).banner || '', /Eine neue Version der App ist verfügbar/)
  await p.ev(`(() => { document.getElementById('field').value = 'ungespeichert'; window.__asked = 0; window.confirm = () => { window.__asked++; return false } })()`)
  await p.ev(`[...document.querySelectorAll('[data-testid="update-banner"] button')].find(b => /Neu laden/.test(b.innerText)).click()`)
  await sleep(800)
  assert.equal(await p.ev('window.__asked'), 1, 'vorher gefragt')
  assert.equal((await view(p)).marker, 'unverändert', 'nicht neu geladen')
  assert.equal(await p.ev(`document.getElementById('field').value`), 'ungespeichert', 'Eingabe erhalten')
  await p.ev(`[...document.querySelectorAll('[data-testid="update-banner"] button')].find(b => /Später/.test(b.innerText)).click()`)
  await sleep(200)
  assert.equal((await view(p)).banner, null, '„Später“ blendet aus')
})
