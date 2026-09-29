// Layout-Regressionstest mit echtem Browser (Headless Chrome, keine Dependency): Dialoge sind auf kleinen
// Mobile-Viewports vollständig erreichbar, Inhalt scrollt vertikal, Aktionsbutton sichtbar, Hintergrund gesperrt,
// Benutzerverwaltungs-Tabellen ohne unerreichbare Aktionen; Desktop unverändert. Nutzt das echte src/index.css.
// Ohne installiertes Chrome/Chromium wird der Test übersprungen (CHROME_BIN setzt einen eigenen Pfad).
// Jede Größe wird in einem iframe exakter Größe gemessen (Headless-Chrome erzwingt sonst eine Mindestfensterbreite).
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
const CHROME = CANDIDATES.find(p => existsSync(p))
const CSS = readFileSync('src/index.css', 'utf8')

const field = i => `<div class="form-group"><label>Feld ${i}</label><input value="Wert ${i}"></div>`
const longMail = 'sehr.lange.adresse.fuer.einen.test.mit.vielen.zeichen@example-mitarbeiterportal.test'
// Eine App-ähnliche Seite (Haupt-Scroller .content, Tabelle, offener Dialog) mit dem echten CSS
const PAGE = (withBody = true) => `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${CSS}</style><style>*{animation:none!important;transition:none!important}</style></head><body>
<div class="app-shell"><div class="main"><div class="content" id="content">
  ${Array.from({ length: 60 }, (_, i) => `<p>Hintergrundzeile ${i}</p>`).join('')}
  <div class="card"><div class="table-wrap"><table class="table-stack" id="tbl"><thead><tr><th>Benutzer</th><th>E-Mail</th><th>Gültig bis</th><th>Aktionen</th></tr></thead>
    <tbody><tr><td data-label="Benutzer"><strong>Anna Beispiel</strong></td><td data-label="E-Mail" id="mail">${longMail}</td><td data-label="Gültig bis">05.10.2026</td>
    <td data-label="Aktionen"><div class="flex gap-2"><button class="btn btn-sm">🔗 Link kopieren</button><button class="btn btn-sm btn-danger" id="rowAction">Zurückziehen</button></div></td></tr></tbody></table></div></div>
  <div class="card"><div class="lifecycle-row" id="lrow"><div style="flex:1;min-width:0"><div style="font-weight:500;font-size:13px;overflow-wrap:anywhere" id="lmail">${longMail}<span class="badge badge-amber" style="margin-left:6px">E-Mail nicht bestätigt</span><span class="badge badge-accent" style="margin-left:6px">Adresse gehört zu einem Mitarbeiter</span></div></div>
    <button class="btn btn-sm btn-danger" id="lbtn">🧹 Anmeldung entfernen</button></div></div>
  <div class="modal-overlay" id="overlay"><div class="modal" id="modal" style="max-width:460px">
    <div class="modal-header"><div class="modal-title">Neuen Mitarbeiter einladen</div><button class="btn btn-sm">✕</button></div>
    ${withBody ? `<div class="modal-body" id="body">${Array.from({ length: 22 }, (_, i) => field(i)).join('')}<div id="last">Letztes Feld</div></div>
    <div class="modal-footer"><button class="btn">Abbrechen</button><button class="btn btn-primary" id="confirm">Einladung erstellen</button></div>`
      : `${Array.from({ length: 30 }, (_, i) => field(i)).join('')}<button class="btn btn-primary" id="confirm">OK</button>`}
  </div></div>
</div></div></div></body></html>`

// Messung im jeweiligen Frame (Viewport = exakte iframe-Größe; Media Queries gelten für diese Breite)
function metrics(win) {
  const d = win.document, r = id => d.getElementById(id)?.getBoundingClientRect().toJSON(), cs = (id, p) => win.getComputedStyle(d.getElementById(id))[p]
  const out = { vw: win.innerWidth, vh: win.innerHeight, modal: r('modal'), confirm: r('confirm'), contentOverflowY: cs('content', 'overflowY'),
    modalOverflowY: cs('modal', 'overflowY'), docScrollW: d.documentElement.scrollWidth, modalScrollW: d.getElementById('modal').scrollWidth,
    modalClientW: d.getElementById('modal').clientWidth, trDisplay: win.getComputedStyle(d.querySelector('#tbl tr')).display,
    theadDisplay: win.getComputedStyle(d.querySelector('#tbl thead')).display, rowAction: r('rowAction'),
    mailOverflow: d.getElementById('mail').scrollWidth - d.getElementById('mail').clientWidth,
    lifecycleBtn: r('lbtn'), lifecycleOverflow: d.getElementById('lrow').scrollWidth - d.getElementById('lrow').clientWidth }
  const body = d.getElementById('body')
  if (body) { out.bodyOverflowY = cs('body', 'overflowY'); out.bodyScrollable = body.scrollHeight > body.clientHeight; body.scrollTop = body.scrollHeight; out.lastAfterScroll = r('last'); out.bodyAfter = r('body') }
  else { const m = d.getElementById('modal'); out.modalScrollable = m.scrollHeight > m.clientHeight; m.scrollTop = m.scrollHeight; out.confirmAfterScroll = r('confirm') }
  return out
}

const SCENARIOS = { phone: [375, 667, true], landscape: [667, 375, true], mini: [320, 568, true], nobody: [375, 667, false], desktop: [1280, 800, true],
  iphone15: [390, 844, true], promax: [430, 932, true], landscape15: [844, 390, true] }
let M = null, SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
async function measureAll() {
  const dir = mkdtempSync(join(tmpdir(), 'cafe-modal-'))
  const frames = Object.entries(SCENARIOS).map(([k, [w, h, b]]) => `<iframe id="${k}" style="width:${w}px;height:${h}px;border:0;display:block" srcdoc="${PAGE(b).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`).join('')
  const host = `<!doctype html><html><body style="margin:0">${frames}<pre id="out"></pre><script>
    const metrics = ${metrics.toString()};
    window.onload = () => { const res = {}; for (const f of document.querySelectorAll('iframe')) res[f.id] = metrics(f.contentWindow); document.getElementById('out').textContent = JSON.stringify(res) }
  </script></body></html>`
  const file = join(dir, 'host.html'); writeFileSync(file, host)
  try {
    return await new Promise((resolve, reject) => {
      const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-background-networking',
        '--disable-sync', '--hide-scrollbars', `--user-data-dir=${join(dir, 'profile')}`, '--window-size=1400,4200', '--dump-dom', pathToFileURL(file).href], { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      const done = (fn, v) => { clearTimeout(timer); ch.kill('SIGKILL'); fn(v) }
      const timer = setTimeout(() => done(reject, new Error('Chrome lieferte keine Ausgabe (Timeout)')), 30000)
      ch.stdout.on('data', c => {
        buf += c
        const m = buf.match(/<pre id="out">([\s\S]*?)<\/pre>/)
        if (m && m[1]) done(resolve, JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')))
      })
      ch.on('error', e => done(reject, e))
    })
  } finally {
    // Chrome schreibt nach dem Beenden kurz weiter ins Profil → mit Wiederholung aufräumen, Aufräumfehler ignorieren
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Temp-Ordner, räumt das System auf */ }
  }
}
// Startet Chrome nicht (z. B. eingeschränkte Umgebung), werden die Tests sichtbar übersprungen – nie still „grün“
before(async () => { if (CHROME) { try { M = await measureAll() } catch (e) { SKIP = `Chrome nicht startbar: ${e.message}` } } })
const measure = (w, h, withBody = true) => M[Object.entries(SCENARIOS).find(([, v]) => v[0] === w && v[1] === h && v[2] === withBody)[0]]
const inside = (rect, m) => rect.top >= -0.5 && rect.left >= -0.5 && rect.bottom <= m.vh + 0.5 && rect.right <= m.vw + 0.5

test('9–12: iPhone-Hochformat (375×667) – langer Dialog vollständig erreichbar, Inhalt scrollt, Button sichtbar, Hintergrund gesperrt', t => {
  if (SKIP) return t.skip(SKIP)
  const m = measure(375, 667)
  assert.ok(inside(m.modal, m), `Dialog im Viewport: ${JSON.stringify(m.modal)}`)
  assert.ok(inside(m.confirm, m), `Aktionsbutton sichtbar: ${JSON.stringify(m.confirm)}`)
  assert.equal(m.bodyOverflowY, 'auto'); assert.equal(m.bodyScrollable, true, 'Inhalt scrollt vertikal')
  assert.ok(m.lastAfterScroll.bottom <= m.bodyAfter.bottom + 0.5 && m.lastAfterScroll.top >= m.bodyAfter.top - 0.5, 'letztes Feld nach Scrollen erreichbar')
  assert.equal(m.contentOverflowY, 'hidden', 'Hintergrund scrollt nicht mit')
  assert.ok(m.docScrollW <= m.vw && m.modalScrollW <= m.modalClientW, 'kein horizontaler Überlauf')
})

test('Querformat klein (667×375) und iPhone Mini (320×568): Dialog passt, Button erreichbar', t => {
  if (SKIP) return t.skip(SKIP)
  for (const [w, h] of [[667, 375], [320, 568]]) {
    const m = measure(w, h)
    assert.ok(inside(m.modal, m) && inside(m.confirm, m), `${w}×${h}: ${JSON.stringify({ modal: m.modal, confirm: m.confirm })}`)
    assert.equal(m.bodyScrollable, true)
  }
})

test('Dialog ohne .modal-body (lange Inhalte): scrollt als Ganzes, Button per Scrollen erreichbar', t => {
  if (SKIP) return t.skip(SKIP)
  const m = measure(375, 667, false)
  assert.ok(inside(m.modal, m)); assert.equal(m.modalOverflowY, 'auto'); assert.equal(m.modalScrollable, true)
  assert.ok(inside(m.confirmAfterScroll, m), `Button nach Scrollen sichtbar: ${JSON.stringify(m.confirmAfterScroll)}`)
})

test('13: Benutzerverwaltung mobil – Tabellen gestapelt, Aktionen im Viewport, lange E-Mails umbrechen', t => {
  if (SKIP) return t.skip(SKIP)
  const m = measure(375, 667)
  assert.equal(m.theadDisplay, 'none'); assert.equal(m.trDisplay, 'block')
  assert.ok(m.rowAction.right <= m.vw + 0.5 && m.rowAction.left >= -0.5, `Aktion erreichbar: ${JSON.stringify(m.rowAction)}`)
  assert.ok(m.mailOverflow <= 0, 'E-Mail bricht um statt überzulaufen')
})

test('14: Desktop (1280×800) unverändert – Tabelle als Tabelle, Dialog in gewohnter Breite, zentriert', t => {
  if (SKIP) return t.skip(SKIP)
  const m = measure(1280, 800)
  assert.equal(m.trDisplay, 'table-row'); assert.equal(m.theadDisplay, 'table-header-group')
  assert.ok(m.modal.width <= 460.5 && m.modal.width >= 459.5, `Breite ${m.modal.width}`)
  assert.ok(Math.abs((m.modal.left + m.modal.right) / 2 - m.vw / 2) < 2, 'horizontal zentriert')
  assert.ok(inside(m.modal, m) && inside(m.confirm, m))
})

test('Aktuelle iPhones (390×844, 430×932) und Querformat 844×390: Dialog passt, Button erreichbar, kein Querscrollen', t => {
  if (SKIP) return t.skip(SKIP)
  for (const [w, h] of [[390, 844], [430, 932], [844, 390]]) {
    const m = measure(w, h)
    assert.ok(inside(m.modal, m) && inside(m.confirm, m), `${w}×${h}: ${JSON.stringify({ modal: m.modal, confirm: m.confirm })}`)
    assert.equal(m.bodyScrollable, true, `${w}×${h}: Inhalt scrollt`)
    assert.ok(m.docScrollW <= m.vw && m.modalScrollW <= m.modalClientW, `${w}×${h}: kein horizontaler Überlauf`)
  }
})

test('Lifecycle-Zeilen (verwaiste Anmeldung/abgelaufene Einladung): lange Adresse bricht um, Aktion bleibt im Viewport', t => {
  if (SKIP) return t.skip(SKIP)
  for (const [w, h] of Object.values(SCENARIOS).filter(v => v[2])) {
    const m = measure(w, h)
    assert.ok(m.lifecycleOverflow <= 0, `${w}×${h}: Zeile läuft nicht über (${m.lifecycleOverflow})`)
    assert.ok(m.lifecycleBtn.left >= -0.5 && m.lifecycleBtn.right <= m.vw + 0.5, `${w}×${h}: ${JSON.stringify(m.lifecycleBtn)}`)
  }
})
