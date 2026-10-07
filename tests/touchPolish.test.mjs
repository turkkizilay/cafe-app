// Real-World-Feinschliff Touch (07.10.2026): echtes src/index.css + echte PasswordInput-Komponente in Headless Chrome,
// einmal mit Touch (pointer: coarse, 390 px), einmal Desktop. Belegt: kein iOS-Auto-Zoom mehr (Felder ≥ 16 px auf
// Touch), Fingergröße für Menü-Knopf (auch in voller mobiler Leiste), Menü schließen, Hell/Dunkel, „Passwort
// vergessen?“/„Zurück zur Anmeldung“ und das Passwort-Auge; Desktop bleibt bei 13,5 px. Echte iOS-Tastatur/Zoom kann
// Headless Chrome nicht nachstellen – geprüft wird die Ursache (Schriftgröße < 16 px), die Safari zum Zoomen bringt.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, page = null, HARNESS_ERR = null

const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import PasswordInput from ${JSON.stringify(resolve('src/components/UI/PasswordInput.jsx'))}
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
function H() {
  return <>
    <div className="mobile-bar"><button className="mobile-menu-btn" id="menu">☰</button><div style={{ whiteSpace: 'nowrap' }}>Café Buur · Ein sehr langer Seitentitel ohne Umbruch</div><button style={{ width: 120, flexShrink: 1 }}>DE EN বাংলা</button></div>
    <aside className="sidebar"><button className="sidebar-close" id="close">✕</button><button className="dark-toggle" id="dark">🌙 Dunkel</button></aside>
    <div className="login-card">
      <input type="email" id="email" />
      <PasswordInput id="pw" value="" onChange={() => {}} />
      <button id="forgot" style={{ background:'none', border:'none', fontSize:13 }}>Passwort vergessen?</button>
      <button id="back" style={{ background:'none', border:'none', fontSize:13 }}>← Zurück zur Anmeldung</button>
      <button className="btn btn-primary" id="submit">Anmelden</button>
      <label><input type="checkbox" id="cb" /> Angemeldet bleiben</label>
    </div>
    <select id="sel"><option>2026</option></select><textarea id="ta" /><select id="inl" style={{ fontSize: 12 }}><option>wie SickCasesPanel</option></select>
  </>
}
createRoot(document.getElementById('app')).render(<LocaleProvider><H /></LocaleProvider>)`

async function openPage(file) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.text); return x.result.value }
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(700)
  const mode = async coarse => {
    await send('Emulation.setDeviceMetricsOverride', coarse ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: coarse ? 5 : 1 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: coarse ? 'coarse' : 'fine' }] })
    await sleep(80)
  }
  const measure = () => ev(`(() => {
    const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }
    const fs = id => getComputedStyle(document.getElementById(id)).fontSize
    const eye = document.getElementById('pw').parentElement.querySelector('button').getBoundingClientRect()
    const pwr = document.getElementById('pw').getBoundingClientRect()
    return { font: { email: fs('email'), pw: fs('pw'), sel: fs('sel'), ta: fs('ta'), cb: fs('cb'), inl: fs('inl') },
      menu: box('menu'), close: box('close'), dark: box('dark'), forgot: box('forgot'), back: box('back'), submit: box('submit'), eye: [Math.round(eye.width), Math.round(eye.height)], eyeInField: Math.abs(eye.top - pwr.top) < 1 && Math.abs(eye.bottom - pwr.bottom) < 1 }
  })()`)
  return { mode, measure, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-touch-polish-'))
  try {
    const esbuild = await import('esbuild')
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })).outputFiles[0].text
    // Mobile-Regeln (max-width: 768px) zeigen .mobile-bar/.sidebar-close – beide Größen werden im selben CSS gemessen
    writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${readFileSync('src/index.css', 'utf8')}</style></head><body><div id="app"></div><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    page = await openPage(join(dir, 'p.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { try { page?.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = () => { assert.ok(page, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); return page }

test('Touch (390 px): Felder 16 px (kein iOS-Auto-Zoom), Checkbox unverändert', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P(); await p.mode(true); const m = await p.measure()
  assert.deepEqual([m.font.email, m.font.pw, m.font.sel, m.font.ta], ['16px', '16px', '16px', '16px'])
  assert.equal(m.font.inl, '16px', 'auch Felder mit eigener (Inline-)Schriftgröße')
  assert.equal(m.font.cb, '13.5px')
})

test('Touch: Menü-Knopf bleibt 44 × 44 auch neben langem Titel; Menü schließen, Hell/Dunkel, Textlinks, Auge fingergroß', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P(); await p.mode(true); const m = await p.measure()
  assert.deepEqual(m.menu, [44, 44], 'Menü-Knopf schrumpft nicht')
  assert.deepEqual(m.close, [44, 44])
  assert.ok(m.dark[1] >= 44, `Hell/Dunkel ${m.dark}`)
  assert.ok(m.forgot[1] >= 44 && m.back[1] >= 44, `Textlinks ${m.forgot} ${m.back}`)
  assert.ok(m.eye[0] >= 42 && m.eye[1] >= 34, `Auge ${m.eye} (vorher ~29 × 25)`)   // Höhe = Feldhöhe; höher ginge nur mit höheren Feldern
  assert.equal(m.eyeInField, true, 'Auge genau so hoch wie das Feld – ragt nicht über das nächste Element ')
  assert.ok(m.submit[1] >= 44)
})

test('Desktop (1280 px, Maus): Schrift und Textlinks unverändert', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = P(); await p.mode(false); const m = await p.measure()
  assert.deepEqual([m.font.email, m.font.pw, m.font.sel, m.font.ta], ['13.5px', '13.5px', '13.5px', '13.5px'])
  assert.ok(m.forgot[1] < 30, 'Desktop: Textlink bleibt kompakt')
})

test('Toast respektiert den iPhone-Home-Balken (PWA), Position sonst unverändert', () => {
  const s = readFileSync('src/components/UI/Toast.jsx', 'utf8')
  assert.match(s, /bottom:'calc\(24px \+ env\(safe-area-inset-bottom\)\)', right:24/)
})
