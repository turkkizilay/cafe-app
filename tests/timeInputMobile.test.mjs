// Uhrzeit-Eingaben auf dem Handy (05.10.2026): Ziffern-Tastatur ohne „:“ (inputMode numeric, iPhone). Echte Komponente
// TimeInput24 in Headless Chrome, gesteuert über das DevTools-Protokoll mit echten Tastaturereignissen (insertText,
// Rücktaste, Cursor/Markierung) – einmal mit Touch (pointer: coarse), einmal Desktop. Gilt für ALLE Uhrzeitfelder,
// denn alle 8 nutzen diese Komponente (Inventur unten). Echtes iOS-Tastaturverhalten beweist das NICHT – nur die Logik
// bei genau den Zeichen, die eine Ziffern-Tastatur erzeugen kann.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, page = null, HARNESS_ERR = null

const ENTRY = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import TimeInput24 from ${JSON.stringify(resolve('src/components/UI/TimeInput24.jsx'))}
function H() {
  const [v, setV] = useState(''), [k, setK] = useState(0)
  window.__set = x => { setK(n => n + 1); setV(x) }; window.__val = v
  return <><TimeInput24 key={k} id="t" value={v} onChange={(x, m) => { window.__inc = !!m?.incomplete; setV(x) }} invalidText="HINWEIS" /><button id="other">x</button></>
}
createRoot(document.getElementById('app')).render(<H />)`

// Minimaler CDP-Treiber (ein Tab)
async function openPage(file) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.text); return x.result.value }
  const mode = async coarse => {   // Touch (iPhone/Android-artig) oder Desktop – in DERSELBEN (Vordergrund-)Seite
    await send('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: coarse ? 5 : 1 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: coarse ? 'coarse' : 'fine' }] })
    await sleep(30)
  }
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(600)
  const key = async k => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: k === 'Backspace' ? 8 : 0 }); await sleep(30) }
  const type = async s => { for (const ch of s) { await send('Input.insertText', { text: ch }); await sleep(25) } }
  const paste = async s => { await send('Input.insertText', { text: s }); await sleep(40) }
  const tap = async () => {   // echtes Antippen/Klicken in das Feld
    await ev(`document.getElementById('other').focus()`); await sleep(30)
    const r = await ev(`(() => { const b = document.getElementById('t').getBoundingClientRect(); return { x: b.x + b.width - 6, y: b.y + b.height / 2 } })()`)
    for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await sleep(80)
  }
  const reset = async v => { await ev(`window.__set(${JSON.stringify(v)})`); await sleep(60) }
  const caret = async (a, b = a) => { await ev(`(() => { const e = document.getElementById('t'); e.focus(); setTimeout(() => e.setSelectionRange(${a}, ${b}), 20) })()`); await sleep(80) }   // „zweites Antippen“ setzt Cursor/Auswahl
  const blur = async () => { await ev(`document.getElementById('other').focus()`); await sleep(50) }
  const state = () => ev(`(() => { const e = document.getElementById('t'); return { shown: e.value, form: window.__val, invalid: e.getAttribute('aria-invalid') === 'true', hint: document.body.innerText.includes('HINWEIS'), inputmode: e.inputMode, sel: [e.selectionStart, e.selectionEnd] } })()`)
  return { key, type, paste, tap, reset, caret, blur, state, mode, ev, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-time-mobile-'))
  try {
    const esbuild = await import('esbuild')
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })).outputFiles[0].text
    writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="de"><body><div id="app"></div><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    page = await openPage(join(dir, 'p.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { try { page?.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async which => { assert.ok(page, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await page.mode(which === 'touch'); return page }

for (const which of ['touch', 'desk']) {
  test(`${which}: Ziffern-Tastatur – gültige Uhrzeiten ohne „:“ und mit „:“`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    const cases = { '0000': '00:00', '0800': '08:00', '0915': '09:15', '1515': '15:15', '2359': '23:59', '915': '09:15', '830': '08:30',
                    '00:00': '00:00', '08:00': '08:00', '09:15': '09:15', '15:15': '15:15', '23:59': '23:59', '9:15': '09:15', '15,15': '15:15', '15.15': '15:15' }
    for (const [typed, want] of Object.entries(cases)) {
      await p.reset(''); await p.tap(); await p.type(typed); await p.blur()
      const s = await p.state()
      assert.deepEqual([s.form, s.shown, s.invalid], [want, want, false], typed)
    }
    assert.equal((await p.state()).inputmode, 'numeric', 'Ziffern-Tastatur')
  })

  test(`${which}: Einfügen (auch über bestehenden Wert)`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    for (const [txt, want] of [['08:00', '08:00'], ['0800', '08:00'], ['15:15', '15:15'], ['1515', '15:15']]) {
      await p.reset('11:11'); await p.caret(0, 5); await p.paste(txt)
      assert.equal((await p.state()).form, want, txt)
    }
  })

  test(`${which}: Bearbeiten – Doppelpunkt löschen, Ziffer löschen, alles löschen, Cursor Mitte, Überschreiben`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    // Doppelpunkt löschen → „1515“ bleibt 15:15 (kein Doppelpunkt nötig); Verlassen zeigt wieder 15:15
    await p.reset('15:15'); await p.caret(3); await p.key('Backspace')
    let s = await p.state(); assert.deepEqual([s.shown, s.form, s.invalid], ['1515', '15:15', false])
    await p.blur(); assert.equal((await p.state()).shown, '15:15')
    // … und danach normal weiter: letzte Ziffer ersetzen → 15:12 ohne „:“-Taste; am Ende getippt → sofort sichtbar HH:MM
    await p.reset('15:15'); await p.caret(3); await p.key('Backspace'); await p.caret(4); await p.key('Backspace'); await p.type('2')
    s = await p.state(); assert.deepEqual([s.shown, s.form], ['15:12', '15:12'])
    // einzelne Minuten-Ziffer löschen + neu
    await p.reset('15:15'); await p.caret(5); await p.key('Backspace'); await p.type('0')
    assert.equal((await p.state()).form, '15:10')
    // Cursor Mitte: Stunden-Ziffer ersetzen
    await p.reset('15:15'); await p.caret(2); await p.key('Backspace'); await p.type('8')
    assert.equal((await p.state()).form, '18:15')
    // alles löschen → leer (kein 00:00, keine aktuelle Uhrzeit)
    await p.reset('15:15'); await p.caret(0, 5); await p.key('Backspace')
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.invalid], ['', '', false])
    // markieren + überschreiben
    await p.reset('15:15'); await p.caret(0, 5); await p.type('0745')
    assert.equal((await p.state()).form, '07:45')
    // Rücktaste Zeichen für Zeichen bis leer: Formular am Ende „leer“, nicht hängend
    await p.reset('15:15'); await p.caret(5); for (let i = 0; i < 5; i++) await p.key('Backspace')
    s = await p.state(); assert.deepEqual([s.shown, s.form], ['', ''])
  })

  test(`${which}: Ungültiges wird nie umgedeutet (Fehler sichtbar, Formular leer); Buchstaben/Sonderzeichen kommen nicht ins Feld`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    for (const bad of ['2400', '24:00', '2500', '25:00', '1260', '12:60', '1299', '12:99', '999', '15315']) {
      await p.reset(''); await p.tap(); await p.type(bad); await p.blur()
      const s = await p.state()
      assert.deepEqual([s.form, s.invalid, s.hint], ['', true, true], bad)
    }
    for (const junk of ['abcd', '!?#']) {
      await p.reset(''); await p.tap(); await p.type(junk); await p.blur()
      const s = await p.state(); assert.deepEqual([s.shown, s.form, s.invalid], ['', '', false], junk)
    }
  })
}

// Sichtbare HH:MM-Normalisierung (05.10.2026): Auf dem iPhone blieb „1700“ stehen, solange das Feld fokussiert war
// (Anzeige wurde nur beim Verlassen formatiert). Jetzt sofort beim Tippen/Einfügen am Ende – ohne Verlassen des Feldes.
for (const which of ['touch', 'desk']) {
  test(`${which}: sichtbar HH:MM schon während das Feld fokussiert ist; Cursor am Ende`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    const cases = { '1700': '17:00', '1730': '17:30', '0800': '08:00', '815': '08:15', '0000': '00:00', '2359': '23:59', '17:00': '17:00', '08:00': '08:00', '8:30': '08:30' }
    for (const [typed, want] of Object.entries(cases)) {
      await p.reset(''); await p.tap(); await p.type(typed)
      const s = await p.state()   // KEIN blur
      assert.deepEqual([s.shown, s.form, s.sel], [want, want, [5, 5]], typed)
      assert.equal(await p.ev(`document.activeElement.id`), 't', `${typed}: Fokus bleibt (Tastatur bleibt offen)`)
    }
    // Zwischenstände werden nicht vorschnell umgebaut
    for (const [typed, shown] of [['1', '1'], ['17', '17'], ['170', '170'], ['08', '08'], ['081', '081'], ['18', '18'], ['123', '123'], ['8', '8'], ['17:', '17:'], ['17:0', '17:0']]) {
      await p.reset(''); await p.tap(); await p.type(typed)
      const s = await p.state(); assert.deepEqual([s.shown, s.form], [shown, ''], typed)
    }
  })

  test(`${which}: Ungültiges bleibt sichtbar wie getippt (nie umgedeutet); fünfte Ziffer wird nicht verschluckt`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    for (const bad of ['2400', '2500', '1260', '1299']) {
      await p.reset(''); await p.tap(); await p.type(bad)
      let s = await p.state(); assert.deepEqual([s.shown, s.form], [bad, ''], bad)
      await p.blur(); s = await p.state(); assert.deepEqual([s.shown, s.form, s.invalid], [bad, '', true], bad)
    }
    await p.reset(''); await p.tap(); await p.type('abcd')
    assert.deepEqual([(await p.state()).shown, (await p.state()).form], ['', ''])
    await p.reset(''); await p.tap(); await p.type('15315')
    let s = await p.state(); assert.deepEqual([s.shown, s.form], ['15:315', ''], 'Tippfehler bleibt sichtbar, Formular leer (Speichern gesperrt)')
    await p.key('Backspace'); s = await p.state(); assert.deepEqual([s.shown, s.form], ['15:31', '15:31'], 'Rücktaste repariert')
  })

  test(`${which}: Bearbeiten bleibt frei – Doppelpunkt/Ziffer löschen wird nicht zurückformatiert, Cursor springt nicht`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    await p.reset('17:00'); await p.caret(3); await p.key('Backspace')
    let s = await p.state(); assert.deepEqual([s.shown, s.form, s.sel], ['1700', '17:00', [2, 2]], 'Doppelpunkt gelöscht bleibt gelöscht')
    await p.reset('17:00'); await p.caret(5); await p.key('Backspace')
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.sel], ['17:0', '', [4, 4]], 'Ziffer gelöscht: kein Auffüllen')
    await p.type('5'); s = await p.state(); assert.deepEqual([s.shown, s.form], ['17:05', '17:05'])
    // Löschen am Ende, das eine gültige Uhrzeit ergibt, wird nicht umgebaut (Löschen manipuliert nie die Anzeige)
    await p.reset('8:300'); await p.caret(5); await p.key('Backspace')
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.sel], ['8:30', '08:30', [4, 4]])
    // Cursor in der Mitte: Stunde ersetzen ohne Springen
    await p.reset('17:00'); await p.caret(1, 2); await p.type('8')
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.sel], ['18:00', '18:00', [2, 2]], 'Cursor bleibt hinter der geänderten Ziffer')
    await p.reset('1700'); await p.caret(1, 2); await p.type('8')
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.sel], ['1800', '18:00', [2, 2]], 'gültig, aber mitten im Text: nicht umbauen, Cursor bleibt')
    await p.reset('1700'); await p.caret(2); await p.type('3')
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.sel], ['17300', '', [3, 3]], 'Einfügen in der Mitte wird nicht umgebaut')
    // markieren + überschreiben, komplett leeren
    await p.reset('17:00'); await p.caret(0, 5); await p.type('0815')
    s = await p.state(); assert.deepEqual([s.shown, s.form], ['08:15', '08:15'])
    await p.reset('17:00'); await p.caret(0, 5); await p.key('Backspace')
    s = await p.state(); assert.deepEqual([s.shown, s.form], ['', ''])
  })

  test(`${which}: Einfügen HHMM / HH:MM / HH:MM:SS → sofort sichtbar HH:MM`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    for (const [txt, want] of [['1700', '17:00'], ['17:00', '17:00'], ['0800', '08:00'], ['17:00:00', '17:00'], ['815', '08:15']]) {
      await p.reset(''); await p.caret(0); await p.paste(txt)
      let s = await p.state(); assert.deepEqual([s.shown, s.form], [want, want], txt)
      await p.reset('11:11'); await p.caret(0, 5); await p.paste(txt)
      s = await p.state(); assert.deepEqual([s.shown, s.form], [want, want], `${txt} über bestehendem Wert`)
    }
    await p.reset(''); await p.caret(0); await p.paste('2400')
    assert.deepEqual([(await p.state()).shown, (await p.state()).form], ['2400', ''])
  })

  test(`${which}: Arbeitsende leer bleibt leer – nie 00:00 oder eine andere Uhrzeit`, async t => {
    if (SKIP) return t.skip(SKIP)
    const p = await P(which)
    await p.reset(''); await p.tap(); await p.blur()
    let s = await p.state(); assert.deepEqual([s.shown, s.form, s.invalid], ['', '', false], 'leer betreten/verlassen')
    await p.reset('16:00'); await p.caret(0, 5); await p.key('Backspace'); await p.blur()
    s = await p.state(); assert.deepEqual([s.shown, s.form, s.invalid, await p.ev('window.__inc')], ['', '', false, false], 'vorbelegtes Ende geleert → leer, vollständig (offener Eintrag erlaubt)')
    await p.reset('16:00'); await p.caret(5); for (let i = 0; i < 5; i++) await p.key('Backspace'); await p.blur()
    s = await p.state(); assert.deepEqual([s.shown, s.form, await p.ev('window.__inc')], ['', '', false], 'Zeichen für Zeichen gelöscht → leer')
  })
}

test('touch: Antippen markiert den ganzen Wert – Ziffern ersetzen ihn (kein Einfügen in ein volles „15:15“)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('touch')
  await p.reset('15:15'); await p.tap()
  assert.deepEqual((await p.state()).sel, [0, 5], 'alles markiert')
  await p.type('1530'); assert.equal((await p.state()).form, '15:30')
  await p.reset('15:15'); await p.tap(); await p.key('Backspace')
  assert.deepEqual([(await p.state()).shown, (await p.state()).form], ['', ''], 'Rücktaste leert – leer bleibt leer')
})

test('desktop: Klick markiert NICHT alles (Cursor wie gewohnt)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('desk')
  await p.reset('15:15'); await p.tap()
  const [a, b] = (await p.state()).sel
  assert.equal(a, b, 'keine Markierung')
})

test('Inventur: alle Uhrzeit-Eingaben der App laufen über TimeInput24 (8 Felder); kein natives type="time"; Hinweistexte ohne Pflicht-„:“', () => {
  const walk = d => readdirSync(d).flatMap(n => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f] })
  const src = walk('src').filter(f => /\.(jsx?|mjs)$/.test(f))
  const uses = src.flatMap(f => (readFileSync(f, 'utf8').match(/<TimeInput24\b/g) || []).map(() => f))
  assert.deepEqual([...new Set(uses)].sort(), [join('src', 'pages', 'Shifts.jsx'), join('src', 'pages', 'TimeManagement.jsx')])
  assert.equal(uses.length, 8, 'Zeitkorrektur: Beginn, Ende, Pause Beginn/Ende; Schichtplan: Beginn/Ende (Anlegen + Bearbeiten)')
  for (const f of src) assert.doesNotMatch(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''), /<input\b[^>]*type="(time|datetime-local)"/, f)   // Kommentare ausgenommen
  for (const f of ['src/i18n/catalogs.js', 'src/i18n/catalogBn.js']) {
    const s = readFileSync(f, 'utf8')
    for (const k of ['time.invalid24', 'time.invalid24Short']) for (const m of s.matchAll(new RegExp(`"${k.replace('.', '\\.')}": "([^"]+)"`, 'g')))
      assert.match(m[1], /\b(0830|1800)\b/, `${f} ${k}: nennt die Ziffern-Schreibweise`)
  }
})

test('Zeitkorrektur: Arbeitsende leer bleibt offener Eintrag (p_out = null), Beginn Pflicht – unverändert', () => {
  const t = readFileSync('src/pages/TimeManagement.jsx', 'utf8')
  assert.match(t, /p_out:\s+form\.clock_out_time \|\| null,/)
  assert.match(readFileSync('tests/openTimeCorrection.test.mjs', 'utf8'), /p_out = null \(kein Ersatzwert wie 23:59\/00:00\/jetzt\)/)
})
