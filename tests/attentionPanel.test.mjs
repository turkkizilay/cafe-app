// Handlungsbedarf – echte Komponente (AttentionPanel) mit echtem src/index.css in Headless Chrome: Rollen, „nichts zu
// erledigen“, alle Hinweise + Begrenzung, Klickziele (Route bzw. Live-Steuerung), DE/EN/BN, 320/390 px Touch,
// Tastatur-Fokus, Screenreader-Beschriftung, kein Springen beim Aktualisieren.
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
import { MemoryRouter, useLocation } from 'react-router-dom'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import AttentionPanel from ${JSON.stringify(resolve('src/components/AttentionPanel.jsx'))}
function Where() { const l = useLocation(); window.__path = l.pathname + l.search + l.hash; return null }
const root = createRoot(document.getElementById('app'))
let k = 0
window.__render = (props, remount = true) => {
  window.__live = null
  if (remount) k++
  root.render(<LocaleProvider key={k}><MemoryRouter><Where /><div className="content"><AttentionPanel {...props} onOpenLive={t => { window.__live = t }} /></div></MemoryRouter></LocaleProvider>)
}`

async function openPage(file) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(700)
  const device = async (w, touch) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: touch ? 2 : 1, mobile: touch })
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: touch ? 'coarse' : 'fine' }] })
    await sleep(60)
  }
  const render = async (props, locale = 'de') => { await ev(`localStorage.setItem('cafe-buur-locale', '${locale}')`); await ev(`window.__render(${JSON.stringify(props)})`); await sleep(150) }
  const state = () => ev(`(() => {
    const p = document.querySelector('[data-testid=attention-panel]'); if (!p) return null
    const rows = [...p.querySelectorAll('.attention-item')]
    return { title: p.querySelector('#attention-title')?.innerText, labelledby: p.getAttribute('aria-labelledby'), count: p.querySelector('.attention-count')?.innerText ?? null,
      empty: p.querySelector('.attention-empty')?.innerText ?? null, more: p.querySelector('.attention-more')?.innerText ?? null,
      rows: rows.map(li => { const a = li.querySelector('.attention-row'); const r = a.getBoundingClientRect()
        return { kind: li.dataset.kind, tag: a.tagName, href: a.getAttribute('href'), text: a.innerText.replace(/\\s+/g, ' ').trim(), sr: li.querySelector('.sr-only')?.textContent, w: r.width, h: r.height, right: r.right } }),
      vw: innerWidth, sw: document.documentElement.scrollWidth }
  })()`)
  return { ev, send, device, render, state, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-attention-'))
  try {
    const esbuild = await import('esbuild')
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })).outputFiles[0].text
    writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${readFileSync('src/index.css', 'utf8')}</style></head><body><div id="app"></div><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    page = await openPage(join(dir, 'p.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { try { page?.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async (w = 390, touch = true) => { assert.ok(page, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await page.device(w, touch); return page }

const now = Date.now(), iso = ms => new Date(now - ms).toISOString()
const EMPTY = { liveClockIns: [], liveBreaks: {}, forgottenCount: 0, pendingVacations: [], swapsAccepted: 0, onboardingSubmitted: 0, backupDays: 3, retentionDue: 0 }
const soon = new Date(now + 3 * 86400e3), soonStr = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
const FULL = { ...EMPTY,
  liveClockIns: [
    { id: 'a', employee_id: 'e-a', clock_in: iso(13 * 3600e3), clock_out: null, employees: { first_name: 'Alex', last_name: 'Demo' } },
    { id: 'b', employee_id: 'e-b', clock_in: iso(4 * 3600e3), clock_out: null, employees: { first_name: 'Sam', last_name: 'Sample' } }],
  liveBreaks: { b: [{ break_start: iso(100 * 60e3), break_end: null }] },
  forgottenCount: 2, pendingVacations: [{ status: 'pending', start_date: soonStr }, { status: 'pending', start_date: '2099-01-01' }], swapsAccepted: 1, onboardingSubmitted: 1, backupDays: -1,
  retentionDue: [{ key: 'verwaist', due: 2, title: 'x' }] }

test('Mitarbeiter: Panel wird nie gerendert', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.render({ role: 'employee', loading: false, data: FULL })
  assert.equal(await p.state(), null)
})

test('0 Hinweise: „Aktuell nichts zu erledigen.“ ohne Zähler; erstes Laden zeigt „Wird geprüft …“ (Admin und Manager)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  for (const role of ['admin', 'manager']) {
    await p.render({ role, loading: true, data: EMPTY })
    let s = await p.state(); assert.deepEqual([s.title, s.empty, s.count, s.rows.length], ['Handlungsbedarf', 'Wird geprüft …', null, 0])
    await p.render({ role, loading: false, data: EMPTY })
    s = await p.state(); assert.deepEqual([s.empty, s.count, s.rows.length], ['✓ Aktuell nichts zu erledigen.', null, 0])
  }
})

test('Admin: alle 8 Arten, Reihenfolge, höchstens 5 sichtbar + „3 weitere Punkte“, Klickziele, Screenreader-Stufe', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.render({ role: 'admin', loading: false, data: FULL })
  let s = await p.state()
  assert.equal(s.count, '8'); assert.equal(s.labelledby, 'attention-title')
  assert.deepEqual(s.rows.map(r => r.kind), ['longOpen', 'forgotten', 'vacation', 'swaps', 'onboarding'])
  assert.equal(s.more, '3 weitere Punkte')
  assert.match(s.rows[0].text, /^⛔ Dringend: Alex Demo ist seit über 12 Stunden eingestempelt seit .* · Echtes Ende in der Zeitkorrektur eintragen →$/)
  assert.deepEqual(s.rows.map(r => r.sr), ['Dringend: ', 'Zu erledigen: ', 'Zu erledigen: ', 'Zu erledigen: ', 'Zu erledigen: '])
  assert.deepEqual(s.rows.map(r => [r.tag, r.href]), [['A', '/zeitkorrekturen'], ['A', '/zeitkorrekturen'], ['A', '/urlaub?tab=urlaub'], ['A', '/schichten'], ['A', '/benutzer']])
  assert.match(s.rows[2].text, /2 Urlaubsanträge warten auf Entscheidung Frühester Beginn: /)
  await p.ev(`document.querySelector('.attention-more').click()`); await new Promise(r => setTimeout(r, 100))
  s = await p.state()
  assert.deepEqual(s.rows.map(r => r.kind), ['longOpen', 'forgotten', 'vacation', 'swaps', 'onboarding', 'backup', 'longBreak', 'retention']); assert.equal(s.more, null)
  assert.match(s.rows[5].text, /Du hast noch nie eine Datensicherung heruntergeladen\. Bitte einmal im Monat sichern\./, 'bisheriger Banner-Text vollständig')
  assert.match(s.rows[7].text, /Zum Löschen fällig \(Datenschutz\) 2 Datei\(en\) ohne Zuordnung\. Bitte vorher ansehen – jede Datei ist einzeln aufgelistet\./, 'bisheriger Banner-Text vollständig')
  assert.deepEqual([s.rows[5].href, s.rows[7].href, s.rows[6].tag], ['/einstellungen#datensicherung', '/einstellungen#aufbewahrung', 'BUTTON'])
  // Klick: Route bzw. Live-Steuerung
  await p.ev(`document.querySelectorAll('.attention-row')[1].click()`); await new Promise(r => setTimeout(r, 80))
  assert.equal(await p.ev('window.__path'), '/zeitkorrekturen')
  await p.ev(`[...document.querySelectorAll('.attention-item')].find(li => li.dataset.kind === 'longBreak').querySelector('button').click()`)
  assert.deepEqual(await p.ev('window.__live'), { employeeId: 'e-b', name: 'Sam Sample' })
})

test('Manager: nur erlaubte Hinweise; 12-h-Hinweis öffnet Live-Steuerung mit Bescheid-Text; keine Admin-/Lohn-Inhalte', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.render({ role: 'manager', loading: false, data: FULL })
  const s = await p.state()
  assert.deepEqual(s.rows.map(r => r.kind), ['longOpen', 'vacation', 'swaps', 'longBreak'])
  assert.equal(s.rows[0].tag, 'BUTTON'); assert.match(s.rows[0].text, /Bitte einen Admin informieren/)
  const body = await p.ev(`document.body.innerText`)
  assert.doesNotMatch(body, /Ausstempeln vergessen|Registrierung|Datensicherung|Löschen|€|Lohn|Stundenlohn/)
  await p.ev(`document.querySelector('.attention-row').click()`)
  assert.deepEqual(await p.ev('window.__live'), { employeeId: 'e-a', name: 'Alex Demo' })
})

test('DE/EN/BN: Titel, „nichts zu erledigen“, Hinweistexte ohne rohe Schlüssel', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  const want = { de: ['Handlungsbedarf', 'Aktuell nichts zu erledigen.'], en: ['Needs attention', 'Nothing to do right now.'], bn: ['করণীয়', 'এই মুহূর্তে কিছু করার নেই।'] }
  for (const [loc, [title, none]] of Object.entries(want)) {
    await p.render({ role: 'admin', loading: false, data: EMPTY }, loc)
    let s = await p.state(); assert.deepEqual([s.title, s.empty.replace('✓ ', '')], [title, none], loc)
    await p.render({ role: 'admin', loading: false, data: FULL }, loc)
    s = await p.state()
    assert.equal(s.rows.length, 5, loc)
    for (const r of s.rows) assert.doesNotMatch(r.text, /attention\.|ui\.[0-9a-f]{6}|undefined|NaN|\{/, `${loc}: ${r.text}`)
  }
  await p.render({ role: 'admin', loading: false, data: EMPTY }, 'de')
})

test('Mobil 320/390 px Touch: kein Überlauf, ganze Zeile ≥ 44 px und volle Breite; Desktop unverändert lesbar', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const [w, touch] of [[320, true], [390, true], [1280, false]]) {
    const p = await P(w, touch)
    for (const loc of ['de', 'bn']) {
      await p.render({ role: 'admin', loading: false, data: FULL }, loc)
      await p.ev(`document.querySelector('.attention-more').click()`); await new Promise(r => setTimeout(r, 80))
      const s = await p.state()
      assert.ok(s.sw <= s.vw, `${w} ${loc}: kein Querscrollen (${s.sw} > ${s.vw})`)
      for (const r of s.rows) { assert.ok(r.h >= 44, `${w} ${loc} ${r.kind}: Höhe ${r.h}`); assert.ok(r.right <= s.vw, `${w} ${loc}: Zeile im Bild`) }
      if (touch) assert.ok(s.rows.every(r => r.w >= w - 60), `${w}: Zeilen nahezu volle Breite`)
    }
  }
  await page.render({ role: 'admin', loading: false, data: EMPTY }, 'de')
})

test('Tastatur: Tab erreicht jede Zeile in Reihenfolge, Fokus sichtbar (Rahmen), Enter öffnet das Ziel', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P(1280, false)
  await p.render({ role: 'admin', loading: false, data: FULL })
  const tab = async () => { for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await new Promise(r => setTimeout(r, 40)) }
  const seen = []
  for (let i = 0; i < 6; i++) {
    await tab()
    seen.push(await p.ev(`(() => { const a = document.activeElement; return { kind: a.closest('.attention-item')?.dataset.kind ?? a.className, outline: getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth } })()`))
  }
  assert.deepEqual(seen.map(x => x.kind), ['longOpen', 'forgotten', 'vacation', 'swaps', 'onboarding', 'attention-more'])
  assert.ok(seen.every(x => /solid 2px/.test(x.outline)), JSON.stringify(seen))
  await p.render({ role: 'admin', loading: false, data: FULL })
  await tab(); await tab()
  for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(await p.ev('window.__path'), '/zeitkorrekturen')
})

test('Aktualisieren (Dashboard setzt loading erneut, gleiche Komponente): Liste und Höhe bleiben stehen – kein Springen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.render({ role: 'admin', loading: false, data: FULL })
  const before = await p.state()
  const h = () => p.ev(`document.querySelector('[data-testid=attention-panel]').getBoundingClientRect().height`)
  const h1 = await h()
  await p.ev(`window.__render(${JSON.stringify({ role: 'admin', loading: true, data: FULL })}, false)`); await new Promise(r => setTimeout(r, 120))
  const during = await p.state()
  assert.equal(during.empty, null, 'kein „Wird geprüft …“ beim Aktualisieren')
  assert.deepEqual(during.rows.map(r => r.kind), before.rows.map(r => r.kind))
  assert.equal(await h(), h1)
})
