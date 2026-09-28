// Zentraler Daten-Refresh: nur Aktualisieren-Button, bewusst KEINE eigene Pull-Geste.
// Gestenfolgen werden gegen ein simuliertes Dokument mit allen App-Listenern gespielt: Scrollen gehört
// vollständig dem Browser (kein preventDefault, kein Refresh). Refresh nur per Button → refreshData().
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSingleFlight, createRefreshController } from '../src/lib/refreshController.js'

const read = f => readFileSync(f, 'utf8')
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const SRC = walk('src').filter(f => /\.(jsx?|css)$/.test(f))

// ── Simuliertes Gerät: Dokument + Haupt-Scroller .content + App-Listener (Auto-Logout-Aktivität) ──
function device() {
  const listeners = []
  const doc = {
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
    removeEventListener: (type, fn) => { const i = listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1) },
    fire(type, ev) { for (const l of listeners.filter(l => l.type === type)) l.fn(ev) },
  }
  // einzige globale Touch-/Scroll-Listener der App: Aktivitätsmessung für den Auto-Logout (passiv)
  const src = read('src/hooks/useAutoLogout.js')
  const events = JSON.parse(src.match(/const ACTIVITY_EVENTS = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  let activity = 0
  for (const e of events) doc.addEventListener(e, () => { activity++ }, { passive: true })

  let refreshes = 0, prevented = 0, y = 0
  const c = createRefreshController({ getHandler: () => async () => { refreshes++ } })
  const content = { scrollTop: 0 }
  const target = zone => ({ zone })
  const ev = (zone, extra = {}) => ({ target: target(zone), touches: [{ clientX: 100, clientY: y }], cancelable: true, preventDefault() { prevented++ }, ...extra })
  const d = {
    content, controller: c, get refreshes() { return refreshes }, get prevented() { return prevented }, get activity() { return activity }, listeners,
    down(top, zone = 'content') { content.scrollTop = top; y = 300; doc.fire('touchstart', ev(zone)) },
    move(dy, top, zone = 'content', extra) { y += dy; if (top !== undefined) content.scrollTop = top; doc.fire('touchmove', ev(zone, extra)); doc.fire('scroll', { target: target(zone) }) },
    hmove(dx, zone = 'content') { doc.fire('touchmove', { ...ev(zone), touches: [{ clientX: 100 + dx, clientY: y }] }) },
    up(zone = 'content') { doc.fire('touchend', { target: target(zone), touches: [] }) },
    coast(tops) { for (const t of tops) { content.scrollTop = t; doc.fire('scroll', { target: target('content') }) } },
    pull(zone = 'content') { d.down(0, zone); for (let i = 0; i < 8; i++) d.move(50, 0, zone); d.up(zone) },
    button() { return c.refresh() },
  }
  return d
}

test('Architektur: keine eigene Pull-Geste – keine Gesten-Datei, keine Touch/Pointer-Logik für Refresh', () => {
  assert.equal(existsSync('src/components/PullToRefresh.jsx'), false)
  assert.equal(existsSync('src/lib/pullToRefresh.js'), false)
  for (const f of SRC) {
    const s = read(f)
    if (f.endsWith('.css')) { assert.doesNotMatch(s, /\.ptr-|touch-action:\s*none/, f); continue }
    assert.doesNotMatch(s, /attachPullToRefresh|createPullTracker|PullToRefresh/, f)
    // Touch-Handler gibt es nur im Bild-Zuschnitt (Dialog) und passiv im Auto-Logout
    if (/addEventListener\(['"](touch|pointer)|onTouch(Start|Move|End)|onPointer(Down|Move)/.test(s))
      assert.ok(['src/components/UI/ImageCropper.jsx'].includes(f), `${f}: unerwarteter Touch-/Pointer-Handler`)
  }
  assert.match(read('src/hooks/useAutoLogout.js'), /addEventListener\(ev, recordActivity, \{ passive: true \}\)/)
  // refreshData wird nur vom Button ausgelöst
  const callers = SRC.filter(f => /\.jsx?$/.test(f) && /refreshData\(\)/.test(read(f)))
  assert.deepEqual(callers.sort(), ['src/components/RefreshButton.jsx', 'src/context/RefreshContext.jsx'])
})

test('Gesten 1: oben → runter → wieder hoch → oben ankommen → weiter wischen → 0 Refreshes', () => {
  const d = device()
  d.down(0); for (const t of [80, 200, 400, 650]) d.move(-80, t); d.up()
  d.down(650); for (const t of [500, 300, 100, 0]) d.move(80, t); for (let i = 0; i < 5; i++) d.move(60, 0); d.up()
  for (let i = 0; i < 5; i++) { d.down(0); for (let j = 0; j < 5; j++) d.move(70, 0); d.up() }   // oben weiter wischen
  assert.equal(d.refreshes, 0); assert.equal(d.prevented, 0, 'Scrollen nie blockiert')
})

test('Gesten 2: mehrfach runter/hoch scrollen → 0 Refreshes', () => {
  const d = device(); let top = 0
  for (let r = 0; r < 30; r++) { const dn = r % 2 === 0; d.down(top); for (let i = 0; i < 4; i++) { top = Math.max(0, top + (dn ? 90 : -120)); d.move(dn ? -70 : 70, top) } d.up() }
  assert.equal(d.refreshes, 0); assert.equal(d.prevented, 0)
})

test('Gesten 3: schnell hochscrollen + Momentum/Überfedern bis oben → 0 Refreshes', () => {
  const d = device()
  d.down(1500); d.move(150, 1300); d.move(150, 1100); d.up()
  d.coast([800, 400, 120, 0, -30, -12, 0])
  d.down(-12); for (let i = 0; i < 6; i++) d.move(60, -40); d.up()
  d.down(0); for (let i = 0; i < 6; i++) d.move(60, 0, 'content', { cancelable: false }); d.up()
  assert.equal(d.refreshes, 0); assert.equal(d.prevented, 0)
})

test('Gesten 4: Geste beginnt bei scrollTop > 0, erreicht 0 während der Geste → 0 Refreshes', () => {
  const d = device()
  d.down(240); for (const t of [160, 80, 0, 0, 0, 0]) d.move(80, t); d.up()
  assert.equal(d.refreshes, 0); assert.equal(d.prevented, 0)
})

test('Gesten 5: Loslassen → neue Geste bei 0 → eindeutig nach unten über Schwelle → Release', () => {
  // Ohne eigene Geste löst ein Zug nach unten nichts aus (0 Refreshes, Browser-Verhalten unverändert).
  // Der verlässliche Weg ist der Button: genau 1 Refresh.
  const d = device()
  d.down(240); d.move(80, 160); d.up()
  d.pull()
  assert.equal(d.refreshes, 0, 'Pull löst bewusst keinen App-Refresh aus')
  assert.equal(d.prevented, 0)
  return d.button().then(() => assert.equal(d.refreshes, 1, 'Button: genau ein Refresh'))
})

test('Gesten 6–9: horizontaler Swipe, Modal, Tabelle/innerer Container, Input/Select → 0 Refreshes', () => {
  const d = device()
  d.down(0); for (let i = 0; i < 6; i++) d.hmove(60 * (i + 1)); d.up()
  for (const zone of ['modal', 'table-scroller', 'input', 'select', 'sidebar']) d.pull(zone)
  assert.equal(d.refreshes, 0); assert.equal(d.prevented, 0)
  assert.ok(d.activity > 0, 'Auto-Logout sieht Aktivität weiterhin')
  assert.ok(d.listeners.every(l => l.opts && l.opts.passive === true), 'nur passive Listener → Scrollen nie verzögert')
})

test('10: Refresh läuft bereits → weitere Auslöser → genau 1 laufender Refresh', async () => {
  let loads = 0, release
  const c = createRefreshController({ getHandler: () => () => { loads++; return new Promise(r => { release = r }) } })
  const runs = [c.refresh(), c.refresh(), c.refresh()]
  await Promise.resolve(); await Promise.resolve()
  assert.equal(c.running, true)
  release(); await Promise.all(runs)
  assert.equal(loads, 1)
  const next = c.refresh(); await Promise.resolve(); await Promise.resolve(); release(); await next
  assert.equal(loads, 2, 'danach wieder möglich')
})

test('11: Refresh-Button nutzt exakt die zentrale refreshData(); Ladezustand sichtbar', () => {
  const btn = read('src/components/RefreshButton.jsx')
  assert.match(btn, /onClick=\{\(\) => refreshData\(\)\}/)
  assert.match(btn, /disabled=\{busy\}/)
  assert.match(btn, /refresh-spin/)
  assert.match(btn, /aria-busy=\{busy\}/)
  const ctx = read('src/context/RefreshContext.jsx')
  assert.match(ctx, /const refreshData = useCallback\(\(\) => controller\.refresh\(\), \[controller\]\)/)
  assert.match(ctx, /\}\), \[\]\)/, 'Steuerung stabil über Renderings')
  const app = read('src/App.jsx')
  assert.match(app, /<RefreshProvider>\s*\n\s*<div className="app-shell">\s*\n\s*<RefreshButton \/>/)
  assert.equal((app.match(/<RefreshButton \/>/g) || []).length, 1)
})

test('Haupt-Scroller: .content scrollt, Dokument nicht; overscroll nur dort (kein harter Browser-Reload)', () => {
  const css = read('src/index.css')
  assert.match(css, /\.app-shell \{\s*display: flex;\s*height: 100vh;\s*overflow: hidden;/)
  assert.match(css, /\.content \{\s*flex: 1;\s*overflow-y: auto;[^}]*overscroll-behavior-y: contain;/)
  assert.doesNotMatch(css, /(^|[\s,}])(html|body)\s*[,{][^}]*overscroll-behavior/m, 'nicht global (html/body-Selektoren; .modal-body ist kein body)')
  assert.match('html, body { overscroll-behavior: none }', /(^|[\s,}])(html|body)\s*[,{][^}]*overscroll-behavior/m, 'Muster erkennt globale Regel weiterhin')
  assert.doesNotMatch(css, /touch-action/, 'Browser-Gesten unverändert')
})

test('Single-Flight: Fehler gibt die Sperre frei', async () => {
  let calls = 0, release
  const f = createSingleFlight(() => { calls++; return new Promise(r => { release = r }) })
  const a = f.run(), b = f.run()
  assert.equal(a, b)
  await Promise.resolve(); release(); await a
  assert.equal(calls, 1); assert.equal(f.running, false)
  const failing = createSingleFlight(() => { throw new Error('offline') })
  await assert.rejects(failing.run(), /offline/)
  assert.equal(failing.running, false)
})

test('Steuerung: Erfolg/Fehler → Status immer zurück, Fehler gemeldet, kein Seiten-Reload', async () => {
  const log = { status: [], notes: [] }
  const mk = handler => createRefreshController({ getHandler: () => handler, setStatus: s => log.status.push(s), notify: k => log.notes.push(k) })
  await mk(async () => {}).refresh()
  assert.deepEqual(log.status, ['refreshing', 'idle'])
  await mk(async () => { throw new Error('Supabase 500') }).refresh()
  assert.deepEqual(log.notes, ['failed']); assert.equal(log.status.at(-1), 'idle')
  for (const f of SRC.filter(f => /refresh/i.test(f))) assert.doesNotMatch(read(f), /location\.reload/, f)
})

test('Dialog offen/Eingabe aktiv → kein Laden, Hinweis; offline → alte Daten bleiben', async () => {
  let loads = 0
  const notes = []
  const blocked = createRefreshController({ getHandler: () => async () => { loads++ }, isBlocked: () => true, notify: k => notes.push(k) })
  assert.equal(await blocked.refresh(), 'blocked')
  const offline = createRefreshController({ getHandler: () => async () => { loads++ }, isOffline: () => true, notify: k => notes.push(k) })
  assert.equal(await offline.refresh(), 'offline')
  assert.equal(loads, 0); assert.deepEqual(notes, ['blocked', 'offline'])
  const src = read('src/context/RefreshContext.jsx')
  const fnSrc = src.slice(src.indexOf('export function refreshBlocked'), src.indexOf('export function RefreshProvider')).replace('export ', '')
  const refreshBlocked = new Function(`${fnSrc}; return refreshBlocked`)()
  const doc = (modal, active) => ({ querySelector: s => (s === '.modal-overlay' && modal ? {} : null), activeElement: active })
  assert.equal(refreshBlocked(doc(true, null)), true)
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(refreshBlocked(doc(false, { tagName: tag })), true, tag)
  assert.equal(refreshBlocked(doc(false, { tagName: 'BUTTON' })), false)
})

test('Alle Seiten mit Daten melden ihre bestehende Ladefunktion an', () => {
  const pages = ['Dashboard', 'ClockIn', 'Shifts', 'Vacation', 'MyHours', 'Timesheet', 'PayrollDocuments', 'Account', 'AbsenceCalendar', 'Employees', 'Payroll', 'TimeManagement', 'UserManagement', 'ActivityLog']
  for (const p of pages) assert.equal((read(`src/pages/${p}.jsx`).match(/useRefreshHandler\(/g) || []).length, 1, p)
  assert.match(read('src/pages/Timesheet.jsx'), /\}, \[ym, canManage, profile\?\.employee_id, reloadTick\]\)/)
})

test('DE/EN vollständig, keine Pull-Texte mehr', async () => {
  const { de, en } = await import('../src/i18n/catalogs.js')
  for (const k of ['refresh.refreshing', 'refresh.button', 'refresh.failed', 'refresh.blocked', 'refresh.offline'])
    assert.ok(de[k] && en[k] && de[k] !== en[k], k)
  assert.equal(de['refresh.pull'], undefined); assert.equal(en['refresh.release'], undefined)
})
