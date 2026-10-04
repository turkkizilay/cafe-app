// Dialoge (lib/modalA11y.js): Rolle/aria, Fokus hinein und zurück, Tab bleibt im Dialog, Escape = Klick auf den
// Hintergrund (respektiert nicht schließbare Dialoge), nur der oberste Dialog reagiert; autoFocus bleibt erhalten.
// Echter Browser (Headless Chrome) mit React – synthetische Events laufen wie in der App.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
const CHROME = CANDIDATES.find(p => existsSync(p))
let R = null, HARNESS_ERR = null
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
// Chrome vorhanden, aber kein Ergebnis (Seite abgestürzt/Timeout) = Fehler, nicht „übersprungen“ – sonst verdeckt ein Absturz eine Regression
const result = () => { assert.ok(R, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); return R }

const ENTRY = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { installModalA11y } from ${JSON.stringify(resolve('src/lib/modalA11y.js'))}
let api
function Harness() {
  const [a, setA] = useState(false), [b, setB] = useState(false), [locked, setLocked] = useState(false), [auto, setAuto] = useState(false)
  api = { setA, setB, setLocked, setAuto, state: { a, b, locked, auto } }
  return <>
    <button id="openA" onClick={() => setA(true)}>open</button>
    {a && <div className="modal-overlay" id="ovA" onClick={e => e.target === e.currentTarget && setA(false)}>
      <div className="modal"><div className="modal-header"><div className="modal-title">Titel A</div></div>
        <div className="modal-body"><input id="a1" /><select id="a2"><option>x</option></select><button id="a3" disabled>dis</button><button id="a4">ok</button></div>
      </div></div>}
    {b && <div className="modal-overlay" id="ovB" onClick={() => setB(false)}><div className="modal" onClick={e => e.stopPropagation()}><div className="modal-title">Titel B</div><button id="b1">b</button></div></div>}
    {locked && <div className="modal-overlay" id="ovL"><div className="modal"><div className="modal-title">Gesperrt</div><button id="l1">nur per Button</button></div></div>}
    {auto && <div className="modal-overlay" onClick={() => setAuto(false)}><div className="modal" onClick={e => e.stopPropagation()}><input id="auto" autoFocus /></div></div>}
  </>
}
installModalA11y(document)
const root = createRoot(document.getElementById('app'))
flushSync(() => root.render(<Harness />))
const tick = () => new Promise(r => setTimeout(r, 20))
const key = (k, shift = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }))
const tab = (shift = false) => { const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(ev); return ev.defaultPrevented }
const out = {}
;(async () => {
  document.getElementById('openA').focus()
  document.getElementById('openA').click(); await tick()
  const dlg = document.querySelector('#ovA .modal')
  out.aria = { role: dlg.getAttribute('role'), modal: dlg.getAttribute('aria-modal'), label: document.getElementById(dlg.getAttribute('aria-labelledby'))?.textContent, focusIsDialog: document.activeElement === dlg }
  // Tab-Falle: vom Container → erstes Feld; vom letzten → erstes; Shift+Tab vom ersten → letztes; deaktiviert übersprungen
  tab(); out.t1 = document.activeElement.id
  document.getElementById('a4').focus(); out.wrap = tab(); out.t2 = document.activeElement.id
  out.shiftWrap = tab(true); out.t3 = document.activeElement.id
  // Zweiter Dialog oben drauf: Escape schließt nur ihn
  flushSync(() => api.setB(true)); await tick()
  key('Escape'); await tick()
  out.afterEscB = { a: !!document.getElementById('ovA'), b: !!document.getElementById('ovB') }
  // Escape schließt A (Hintergrund-Klick mit e.target === e.currentTarget), Fokus zurück zum Auslöser
  document.getElementById('a1').focus(); key('Escape'); await tick()
  out.afterEscA = { a: !!document.getElementById('ovA'), focus: document.activeElement.id }
  // Nicht schließbarer Dialog (kein Hintergrund-Handler) bleibt offen
  flushSync(() => api.setLocked(true)); await tick()
  key('Escape'); await tick()
  out.locked = !!document.getElementById('ovL')
  flushSync(() => api.setLocked(false)); await tick()
  // autoFocus im Dialog bleibt erhalten (Fokus nicht auf den Container gezogen)
  flushSync(() => api.setAuto(true)); await tick()
  out.autoFocus = document.activeElement.id
  // ohne offenen Dialog: Escape/Tab unberührt
  flushSync(() => api.setAuto(false)); await tick()
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); out.noDialogTab = ev.defaultPrevented
  document.getElementById('out').textContent = JSON.stringify(out)
})()
`

before(async () => {
  if (!CHROME) return
  const dir = mkdtempSync(join(tmpdir(), 'cafe-modal-'))
  try {
    const esbuild = await import('esbuild')
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })).outputFiles[0].text
    const file = join(dir, 'page.html')
    writeFileSync(file, `<!doctype html><html lang="de"><body><div id="app"></div><pre id="out"></pre><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    R = await new Promise((res, rej) => {
      const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-background-networking',
        '--disable-sync', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href], { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      const done = (fn, v) => { clearTimeout(timer); ch.kill('SIGKILL'); fn(v) }
      const timer = setTimeout(() => done(rej, new Error('Chrome lieferte keine Ausgabe (Timeout)')), 30000)
      ch.stdout.on('data', c => { buf += c; const m = buf.match(/<pre id="out">([\s\S]*?)<\/pre>/); if (m && m[1]) done(res, JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))) })
      ch.on('error', e => done(rej, e))
    })
  } catch (e) { HARNESS_ERR = e.message }
  finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Temp-Ordner */ } }
})

test('Dialog: role/aria-modal/Titel, Fokus auf den Dialog (keine Tastatur auf dem Handy)', t => {
  if (SKIP) return t.skip(SKIP)
  assert.deepEqual(result().aria, { role: 'dialog', modal: 'true', label: 'Titel A', focusIsDialog: true })
})

test('Tab bleibt im Dialog (deaktivierte Elemente übersprungen), Shift+Tab rückwärts', t => {
  if (SKIP) return t.skip(SKIP)
  assert.equal(result().t1, 'a1', 'vom Container zum ersten Feld')
  assert.deepEqual([result().wrap, result().t2], [true, 'a1'], 'vom letzten zum ersten')
  assert.deepEqual([result().shiftWrap, result().t3], [true, 'a4'], 'vom ersten rückwärts zum letzten (a3 deaktiviert)')
})

test('Escape: nur oberster Dialog; wie Klick auf den Hintergrund; Fokus zurück; nicht schließbare Dialoge bleiben offen', t => {
  if (SKIP) return t.skip(SKIP)
  assert.deepEqual(result().afterEscB, { a: true, b: false })
  assert.deepEqual(result().afterEscA, { a: false, focus: 'openA' })
  assert.equal(result().locked, true)
  assert.equal(result().autoFocus, 'auto', 'autoFocus im Dialog bleibt')
  assert.equal(result().noDialogTab, false, 'ohne Dialog keine Tastatur-Eingriffe')
})

test('Verdrahtung: einmal global installiert; Dialog-Container ohne Fokusrahmen; Ergebnisdialog des Account-Resets bleibt per Hintergrund/Escape unschließbar', () => {
  assert.match(readFileSync('src/main.jsx', 'utf8'), /installModalA11y\(document\)/)
  assert.match(readFileSync('src/index.css', 'utf8'), /\.modal:focus \{ outline: none; \}/)
  assert.match(readFileSync('src/components/AccessResetDialog.jsx', 'utf8'), /onClick=\{e => \{ if \(!result && e\.target === e\.currentTarget && phase !== 'working'\) close\(\) \}\}/)
})
