// Pull-to-Refresh & Aktualisieren-Button: Gestenlogik, Single-Flight, Schutz von Eingaben, Verdrahtung.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPullTracker, createSingleFlight, dampen, isIgnoredTarget, attachPullToRefresh, createRefreshController, PULL_THRESHOLD, PULL_MAX } from '../src/lib/pullToRefresh.js'

const read = f => readFileSync(f, 'utf8')
// Zieh-Geste: Start bei (100, 100), dann Schritte nach (x, y)
function gesture(steps, { scrollTop = 0, blocked = false, moveScrollTop } = {}) {
  const t = createPullTracker()
  t.start(100, 100, { scrollTop, blocked })
  let last = null
  for (const [x, y] of steps) last = t.move(x, y, { scrollTop: moveScrollTop ?? scrollTop })
  return { last, ...t.end() }
}

test('Pull ganz oben über Schwelle + Loslassen → genau ein Refresh', () => {
  const r = gesture([[100, 120], [101, 200], [100, 300]])
  assert.equal(r.last.capture, true)
  assert.equal(r.last.state, 'ready')
  assert.equal(r.fire, true)
  const t = createPullTracker(); t.start(0, 0, { scrollTop: 0 }); t.move(0, 300, { scrollTop: 0 }); assert.equal(t.end().fire, true); assert.equal(t.end().fire, false)   // zweites end() feuert nicht
})

test('Kein Pull, wenn die Seite nicht ganz oben ist', () => {
  assert.equal(gesture([[100, 300]], { scrollTop: 5 }).fire, false)
  assert.equal(gesture([[100, 300]], { scrollTop: 0, moveScrollTop: 12 }).fire, false)   // während der Geste gescrollt
})

test('Unter der Schwelle → kein Refresh, Anzeige „ziehen“', () => {
  const r = gesture([[100, 130]])
  assert.equal(r.last.state, 'pulling')
  assert.equal(r.fire, false)
})

test('Horizontales Wischen, Hochscrollen und Mini-Bewegungen → kein Refresh, Scrollen bleibt frei', () => {
  const h = gesture([[180, 120], [300, 160]]); assert.equal(h.last.capture, false); assert.equal(h.fire, false)
  const up = gesture([[100, 60], [100, -200]]); assert.equal(up.last.capture, false); assert.equal(up.fire, false)
  const tiny = gesture([[103, 104]]); assert.equal(tiny.last.capture, false); assert.equal(tiny.fire, false)
})

test('Gesperrtes Ziel (Formularfeld, Dialog, eigener Scrollbereich) → kein Refresh', () => {
  assert.equal(gesture([[100, 400]], { blocked: true }).fire, false)
})

test('Widerstand: gedämpft, monoton, nie über Maximum; Schwelle erreichbar', () => {
  assert.equal(dampen(0), 0); assert.equal(dampen(-50), 0)
  assert.ok(dampen(50) < 50 && dampen(100) > dampen(50))
  assert.ok(dampen(5000) <= PULL_MAX)
  assert.ok(dampen(200) >= PULL_THRESHOLD)
})

test('Single-Flight: während eines Refresh kein zweiter, Fehler gibt die Sperre frei', async () => {
  let calls = 0, release
  const f = createSingleFlight(() => { calls++; return new Promise(r => { release = r }) })
  const a = f.run(), b = f.run(), c = f.run()
  assert.equal(a, b); assert.equal(b, c)
  assert.equal(f.running, true)
  await Promise.resolve(); release(); await a
  assert.equal(calls, 1, 'drei Auslöser → ein Lauf')
  assert.equal(f.running, false)
  const failing = createSingleFlight(() => { throw new Error('offline') })
  await assert.rejects(failing.run(), /offline/)
  assert.equal(failing.running, false, 'nach Fehler erneut möglich')
})

// Minimal-DOM: Element mit closest() über eine Selektor-Liste der Vorfahren
const el = (...ancestors) => ({ closest: sel => sel.split(',').map(s => s.trim()).some(s => ancestors.includes(s)) ? {} : null })
test('Startziele: Seiteninhalt ja; Formularfelder, Dialoge, Navigation, außerhalb des Inhalts nein', () => {
  assert.equal(isIgnoredTarget(el('.content')), false)
  assert.equal(isIgnoredTarget(el('.content', 'button')), false)                 // z. B. großer Einstempel-Button
  for (const blocker of ['input', 'textarea', 'select', '.modal-overlay', '.modal', '.sidebar', '.mobile-bar', '[data-no-pull]'])
    assert.equal(isIgnoredTarget(el('.content', blocker)), true, blocker)
  assert.equal(isIgnoredTarget(el()), true, 'außerhalb .content')
  assert.equal(isIgnoredTarget(null), true)
})

test('Eingaben schützen: Refresh gesperrt bei offenem Dialog oder aktivem Formularfeld', async () => {
  const src = read('src/context/RefreshContext.jsx')
  const fnSrc = src.slice(src.indexOf('export function refreshBlocked'), src.indexOf('export function RefreshProvider')).replace('export ', '')
  const refreshBlocked = new Function(`${fnSrc}; return refreshBlocked`)()
  const doc = (modal, active) => ({ querySelector: s => (s === '.modal-overlay' && modal ? {} : null), activeElement: active })
  assert.equal(refreshBlocked(doc(true, null)), true)
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(refreshBlocked(doc(false, { tagName: tag })), true, tag)
  assert.equal(refreshBlocked(doc(false, { tagName: 'DIV', isContentEditable: true })), true)
  assert.equal(refreshBlocked(doc(false, { tagName: 'BUTTON' })), false)
  assert.equal(refreshBlocked(doc(false, null)), false)
})

// ── Laufzeit: simuliertes Dokument + Touch-Events ─────────────────────────────
function fakeDoc() {
  const listeners = []
  return {
    listeners,
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
    removeEventListener: (type, fn) => { const i = listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1) },
    fire(type, ev) { for (const l of listeners.filter(l => l.type === type)) l.fn(ev) },
  }
}
// Knoten: .content (scrollbar) mit Kindern; optionale Blocker-Selektoren und eigener Scrollbereich
function tree({ scrollTop = 0, blocker, ownScroller = false } = {}) {
  const content = { scrollTop, parentElement: null, scrollHeight: 2000, clientHeight: 800, closest: sel => (sel.split(',').map(x => x.trim()).includes('.content') ? content : null), _style: { overflowY: 'auto' } }
  const scroller = { parentElement: content, scrollHeight: ownScroller ? 900 : 300, clientHeight: 300, _style: { overflowY: ownScroller ? 'auto' : 'visible' } }
  const leaf = { parentElement: scroller, scrollHeight: 20, clientHeight: 20, _style: { overflowY: 'visible' },
    closest: sel => { const parts = sel.split(',').map(x => x.trim()); if (parts.includes('.content')) return content; return blocker && parts.includes(blocker) ? {} : null } }
  scroller.closest = leaf.closest
  return { content, leaf }
}
const ev = (target, x, y, extra = {}) => ({ target, touches: [{ clientX: x, clientY: y }], cancelable: true, prevented: false, preventDefault() { this.prevented = true }, ...extra })
function setup(opts) {
  const doc = fakeDoc(); let fired = 0; const states = []
  const detach = attachPullToRefresh(doc, { onChange: s => states.push(s.state), onFire: () => fired++, getStyle: n => n._style })
  const { leaf, content } = tree(opts)
  const pull = (dy, dx = 0, end = 'touchend') => {
    doc.fire('touchstart', ev(leaf, 100, 100))
    const moves = [0.25, 0.5, 1].map(f => { const e = ev(leaf, 100 + dx * f, 100 + dy * f); doc.fire('touchmove', e); return e })
    doc.fire(end, { target: leaf, touches: [] })
    return moves
  }
  return { doc, detach, pull, content, get fired() { return fired }, states }
}

test('Laufzeit: scrollTop 0 + über Schwelle + Loslassen = genau 1 Refresh, preventDefault nur bei eigener Geste', () => {
  const s = setup()
  const moves = s.pull(260)
  assert.equal(s.fired, 1)
  assert.ok(moves.some(m => m.prevented), 'eigene Geste verhindert Browser-Pull/Scroll')
  assert.ok(s.states.includes('ready') && s.states.at(-1) === 'idle', 'Anzeige zurückgesetzt')
})

test('Laufzeit: scrollTop > 0, unter Schwelle, horizontal, touchcancel → 0 Refreshes, Scrollen nie blockiert', () => {
  const down = setup({ scrollTop: 40 }); const m1 = down.pull(260); assert.equal(down.fired, 0); assert.ok(m1.every(m => !m.prevented))
  const small = setup(); small.pull(60); assert.equal(small.fired, 0)
  const horiz = setup(); const m2 = horiz.pull(40, 260); assert.equal(horiz.fired, 0); assert.ok(m2.every(m => !m.prevented))
  const up = setup(); const m3 = up.pull(-260); assert.equal(up.fired, 0); assert.ok(m3.every(m => !m.prevented))
  const cancel = setup(); cancel.pull(260, 0, 'touchcancel'); assert.equal(cancel.fired, 0); assert.equal(cancel.states.at(-1), 'idle')
})

test('Laufzeit: Formularfelder, Dialoge, Selects, eigener Scrollbereich → keine Geste', () => {
  for (const blocker of ['input', 'textarea', 'select', '.modal-overlay', '.modal', '[contenteditable="true"]']) {
    const s = setup({ blocker }); const m = s.pull(300); assert.equal(s.fired, 0, blocker); assert.ok(m.every(x => !x.prevented), blocker)
  }
  const own = setup({ ownScroller: true }); own.pull(300); assert.equal(own.fired, 0, 'scrollbare Tabelle/Liste')
})

test('Laufzeit: Zwei-Finger-Geste bricht ab; nicht abbrechbare Events werden nie zur Geste', () => {
  const s = setup(); const { leaf } = tree()
  s.doc.fire('touchstart', ev(leaf, 100, 100))
  s.doc.fire('touchmove', { target: leaf, touches: [{ clientX: 100, clientY: 300 }, { clientX: 200, clientY: 300 }], cancelable: true, preventDefault() { throw new Error('darf nicht') } })
  s.doc.fire('touchend', { target: leaf, touches: [] })
  assert.equal(s.fired, 0)
  const t = setup(); t.doc.fire('touchstart', ev(leaf, 100, 100))
  const e = ev(leaf, 100, 300, { cancelable: false, preventDefault() { throw new Error('nicht abbrechbar') } })
  t.doc.fire('touchmove', e); t.doc.fire('touchend', { target: leaf, touches: [] })
  assert.equal(t.fired, 0, 'nicht abbrechbar = Browser scrollt/pullt selbst → keine eigene Geste, kein Doppel-Refresh')
})

// ── Regression: Refresh beim Hochscrollen (Gesten-Berechtigung nur bei touchstart) ──
// Simuliert Finger + natives Scrollen: jede Bewegung setzt optional den scrollTop, den der Browser gerade hat.
function setupShared() {
  const doc = fakeDoc(); let fired = 0; const states = []
  attachPullToRefresh(doc, { onChange: x => states.push(x.state), onFire: () => fired++, getStyle: n => n._style })
  const { leaf, content } = tree()
  let y = 300, prevented = 0
  const d = {
    content, states, get fired() { return fired }, get prevented() { return prevented },
    down(top) { content.scrollTop = top; y = 300; doc.fire('touchstart', ev(leaf, 100, y)) },
    move(dy, top, extra) { y += dy; if (top !== undefined) content.scrollTop = top; const e = ev(leaf, 100, y, extra); doc.fire('touchmove', e); if (e.prevented) prevented++ },
    up() { doc.fire('touchend', { target: leaf, touches: [] }) },
    cancel() { doc.fire('touchcancel', { target: leaf, touches: [] }) },
    coast(tops) { for (const t of tops) content.scrollTop = t },
    pullFromTop() { d.down(0); for (let i = 0; i < 6; i++) d.move(50, 0); d.up() },
  }
  return d
}

test('Regression 1: touchstart bei scrollTop > 0, während der Geste 0 erreicht, weiter ziehen → KEIN Refresh', () => {
  const d = setupShared()
  d.down(240)
  for (const top of [180, 120, 60, 0]) d.move(60, top)        // Finger nach unten = Inhalt scrollt nach oben bis 0
  for (let i = 0; i < 6; i++) d.move(60, 0)                    // weiter nach unten ziehen, bereits ganz oben
  d.up()
  assert.equal(d.fired, 0)
  assert.equal(d.prevented, 0, 'natives Scrollen nie blockiert')
  assert.ok(!d.states.includes('pulling') && !d.states.includes('ready'), 'keine Anzeige')
})

test('Regression 2: Geste bei scrollTop > 0 → loslassen → neue Geste bei 0 → Pull über Schwelle = genau EIN Refresh', () => {
  const d = setupShared()
  d.down(240); for (const top of [160, 80, 0]) d.move(80, top); d.up()
  assert.equal(d.fired, 0)
  d.pullFromTop()
  assert.equal(d.fired, 1)
  d.up(); d.up()                                               // weitere touchend ohne neue Geste
  assert.equal(d.fired, 1, 'kein mehrfaches Refresh bei einer Geste')
})

test('Regression 3: normales Scrollen runter → wieder hoch → KEIN Refresh', () => {
  const d = setupShared()
  d.down(0); for (const top of [60, 160, 300, 500]) d.move(-80, top); d.up()   // runter (Finger nach oben)
  d.down(500); for (const top of [400, 250, 100, 0]) d.move(80, top); d.up()   // hoch bis ganz oben
  d.down(0); d.move(-40, 40); d.move(60, 0); d.move(80, 0); d.up()             // oben erst runter-, dann hochgescrollt
  assert.equal(d.fired, 0)
})

test('Regression 4: Momentum/Inertial-Scroll bis oben → KEIN Refresh', () => {
  const d = setupShared()
  d.down(900); d.move(90, 850); d.move(90, 780); d.up()        // Wischer nach oben, Finger weg
  d.coast([600, 300, 90, 0, -24, -38])                         // Schwung läuft ohne Finger bis oben, iOS federt über
  assert.equal(d.fired, 0)
  d.down(-38); for (let i = 0; i < 6; i++) d.move(50, -20); d.up()   // nächster Wischer, während der Inhalt noch federt
  assert.equal(d.fired, 0, 'iOS-Bounce (negativer scrollTop) ist nicht „ganz oben“')
  d.down(0); for (let i = 0; i < 6; i++) d.move(50, 0, { cancelable: false }); d.up()   // Android-Fling: Browser besitzt die Geste
  assert.equal(d.fired, 0, 'nicht abbrechbare touchmove → Browser scrollt selbst, kein (Doppel-)Refresh')
  assert.equal(d.prevented, 0)
})

test('Regression 5: echter Pull, der bereits oben (in Ruhe) beginnt → Refresh funktioniert', () => {
  const d = setupShared()
  d.pullFromTop()
  assert.equal(d.fired, 1)
  assert.ok(d.prevented > 0, 'eigene Geste verhindert Browser-Pull')
  assert.ok(d.states.includes('ready') && d.states.at(-1) === 'idle')
  d.coast([0.5]); d.down(0.5); for (let i = 0; i < 6; i++) d.move(50, 0.5); d.up()   // Subpixel-Rundung zählt als oben
  assert.equal(d.fired, 2)
})

test('Regression 6: viele normale Scrollbewegungen → nie ein unbeabsichtigter Refresh', () => {
  const d = setupShared()
  let top = 0
  for (let round = 0; round < 25; round++) {
    const goDown = round % 3 !== 2
    d.down(top)
    for (let i = 0; i < 4; i++) { top = Math.max(0, top + (goDown ? 70 : -140)); d.move(goDown ? -60 : 60, top) }
    for (let i = 0; i < 3; i++) d.move(goDown ? -40 : 60, top)  // am Rand weiterwischen
    d.up()
    if (!goDown) { d.coast([Math.max(0, top - 80), 0, -30]); top = -30 }   // Momentum + Bounce bis oben
    else top += 100
  }
  assert.equal(d.fired, 0)
  assert.equal(d.prevented, 0)
  // Handy-Szenario: oben angekommen und weiter nach oben wischen – jeder Wischer beginnt, während der
  // Inhalt vom vorherigen noch überfedert (iOS: negativer scrollTop), und zieht ihn erneut über den Rand
  d.down(400); for (const t of [300, 150, 40]) d.move(90, t); d.up(); d.coast([0, -35])
  for (let i = 0; i < 8; i++) { d.down(-35 + i); for (const t of [-50, -70, -85, -95]) d.move(60, t); d.up(); d.coast([-40, -35 + i + 1]) }
  assert.equal(d.fired, 0, 'weiter nach oben wischen löst nie aus')
  assert.equal(d.prevented, 0)
})

test('Gesten-State: touchmove ohne touchstart, touchcancel, Abbruch mitten im Pull, Bewegung vor Aktivierung', () => {
  const d = setupShared()
  for (let i = 0; i < 6; i++) d.move(60, 0); d.up()           // touchmove allein initialisiert nie
  assert.equal(d.fired, 0)
  d.down(0); for (let i = 0; i < 6; i++) d.move(50, 0); d.cancel()
  assert.equal(d.fired, 0); assert.equal(d.states.at(-1), 'idle')
  for (let i = 0; i < 3; i++) d.move(50, 0); d.up()           // nach touchcancel: Reste der Geste zählen nicht
  assert.equal(d.fired, 0)
  d.down(0); d.move(50, 0); d.move(50, 0); d.move(60, 30); d.move(60, 0); d.up()   // Inhalt bewegt sich im Pull → Abbruch
  assert.equal(d.fired, 0); assert.equal(d.states.at(-1), 'idle', 'Anzeige zurückgesetzt')
  d.down(0); d.move(3, 4); d.move(60, 0); d.move(60, 0); d.up()                   // vor Aktivierung gescrollt → nie mehr berechtigt
  assert.equal(d.fired, 0)
  d.pullFromTop(); assert.equal(d.fired, 1, 'danach normale neue Geste funktioniert')
  const t = createPullTracker()
  assert.equal(t.start(0, 0, { scrollTop: -5 }), false, 'negativ (Bounce) nicht berechtigt')
  assert.equal(t.start(0, 0, { scrollTop: 2 }), false)
  assert.equal(t.start(0, 0), false, 'ohne scrollTop nie berechtigt')
  assert.equal(t.start(0, 0, { scrollTop: 0 }), true)
})

test('Laufzeit: Listener nur Touch (keine Maus/Wheel/Pointer), Mount/Unmount ohne Duplikate', () => {
  const doc = fakeDoc()
  const opts = { onChange: () => {}, onFire: () => {}, getStyle: n => n._style }
  for (let i = 0; i < 5; i++) attachPullToRefresh(doc, opts)()                 // 5× an- und abmelden
  assert.equal(doc.listeners.length, 0, 'nichts bleibt hängen')
  const detach = attachPullToRefresh(doc, opts)
  assert.deepEqual(doc.listeners.map(l => l.type).sort(), ['touchcancel', 'touchend', 'touchmove', 'touchstart'])
  assert.equal(doc.listeners.find(l => l.type === 'touchmove').opts.passive, false)
  assert.equal(doc.listeners.find(l => l.type === 'touchstart').opts.passive, true)
  detach(); assert.equal(doc.listeners.length, 0)
  const comp = read('src/components/PullToRefresh.jsx')
  assert.match(comp, /return attachPullToRefresh\(document, \{/)              // Effekt gibt Abmeldung zurück
  assert.match(comp, /\}, \[hasHandler\]\)/)                                  // nicht bei jedem Rendern neu
  assert.doesNotMatch(comp + read('src/lib/pullToRefresh.js'), /mousedown|mousemove|pointerdown|pointermove|'wheel'/)
})

// ── Laufzeit: zentrale Refresh-Steuerung ──────────────────────────────────────
function controller({ handler = async () => {}, blocked = false, offline = false } = {}) {
  const log = { status: [], notes: [] }
  const c = createRefreshController({ getHandler: () => handler, isBlocked: () => blocked, isOffline: () => offline, setStatus: s => log.status.push(s), notify: k => log.notes.push(k) })
  return { c, log }
}

test('Steuerung: Erfolg, Fehler, Promise-Rejection → Status immer zurück, Fehler gemeldet, kein Reload', async () => {
  let loads = 0
  const ok = controller({ handler: async () => { loads++ } }); await ok.c.refresh()
  assert.equal(loads, 1); assert.deepEqual(ok.log.status, ['refreshing', 'idle']); assert.deepEqual(ok.log.notes, [])
  const bad = controller({ handler: async () => { throw new Error('Supabase 500') } }); await bad.c.refresh()
  assert.deepEqual(bad.log.status, ['refreshing', 'idle']); assert.deepEqual(bad.log.notes, ['failed']); assert.equal(bad.c.running, false)
  const rej = controller({ handler: () => Promise.reject(new Error('network')) }); await rej.c.refresh()
  assert.deepEqual(rej.log.notes, ['failed']); assert.equal(rej.c.running, false)
  for (const f of ['src/components/PullToRefresh.jsx', 'src/context/RefreshContext.jsx', 'src/lib/pullToRefresh.js']) assert.doesNotMatch(read(f), /location\.reload/)
})

test('Steuerung: langsamer Refresh + Geste + Button + weitere Geste → genau 1 Laden', async () => {
  let loads = 0, release
  const { c } = controller({ handler: () => { loads++; return new Promise(r => { release = r }) } })
  const a = c.refresh(), b = c.refresh(), d = c.refresh()
  await Promise.resolve(); await Promise.resolve()
  release(); await Promise.all([a, b, d])
  assert.equal(loads, 1)
  const next = c.refresh(); await Promise.resolve(); await Promise.resolve(); release(); await next
  assert.equal(loads, 2, 'danach wieder möglich')
})

test('Steuerung: offener Dialog/Eingabe → kein Laden, Hinweis; offline → kein Laden, alte Daten bleiben', async () => {
  let loads = 0
  const blocked = controller({ handler: async () => { loads++ }, blocked: true })
  assert.equal(await blocked.c.refresh(), 'blocked'); assert.deepEqual(blocked.log.notes, ['blocked']); assert.deepEqual(blocked.log.status, [])
  const offline = controller({ handler: async () => { loads++ }, offline: true })
  assert.equal(await offline.c.refresh(), 'offline'); assert.deepEqual(offline.log.notes, ['offline'])
  assert.equal(loads, 0, 'keine Ladefunktion → State (Daten, Formulare) unverändert')
})

test('Button und Geste nutzen dieselbe zentrale refreshData()', () => {
  const comp = read('src/components/PullToRefresh.jsx')
  assert.match(comp, /onFire: \(\) => refreshRef\.current\(\)/)
  assert.match(comp, /refreshRef\.current = refreshData/)
  assert.match(comp, /onClick=\{\(\) => refreshData\(\)\}/)
  assert.equal((comp.match(/useRefresh\(\)/g) || []).length, 2)
  const ctx = read('src/context/RefreshContext.jsx')
  assert.match(ctx, /const refreshData = useCallback\(\(\) => controller\.refresh\(\), \[controller\]\)/)
  assert.match(ctx, /isBlocked: \(\) => refreshBlocked\(\)/)
  assert.match(ctx, /isOffline: \(\) => typeof navigator !== 'undefined' && navigator\.onLine === false/)
  assert.match(ctx, /\}\), \[\]\)/, 'Steuerung stabil über Renderings')
  assert.match(read('src/index.css'), /\.content \{[^}]*overscroll-behavior-y: contain;/)   // kein Browser-Pull parallel
})

test('Alle Seiten mit Daten melden ihre bestehende Ladefunktion an', () => {
  const pages = ['Dashboard', 'ClockIn', 'Shifts', 'Vacation', 'MyHours', 'Timesheet', 'PayrollDocuments', 'Account', 'AbsenceCalendar', 'Employees', 'Payroll', 'TimeManagement', 'UserManagement', 'ActivityLog']
  for (const p of pages) assert.equal((read(`src/pages/${p}.jsx`).match(/useRefreshHandler\(/g) || []).length, 1, p)
  const app = read('src/App.jsx')
  assert.match(app, /<RefreshProvider>\s*\n\s*<div className="app-shell">\s*\n\s*<PullToRefresh \/>\s*\n\s*<RefreshButton \/>/)
  assert.match(read('src/pages/Timesheet.jsx'), /\}, \[ym, canManage, profile\?\.employee_id, reloadTick\]\)/)
})

test('DE/EN vollständig', async () => {
  const { de, en } = await import('../src/i18n/catalogs.js')
  for (const k of ['refresh.pull', 'refresh.release', 'refresh.refreshing', 'refresh.button', 'refresh.failed', 'refresh.blocked', 'refresh.offline']) {
    assert.ok(de[k] && en[k] && de[k] !== en[k], k)
  }
  assert.equal(de['refresh.pull'], 'Zum Aktualisieren ziehen'); assert.equal(de['refresh.release'], 'Loslassen zum Aktualisieren'); assert.equal(de['refresh.refreshing'], 'Wird aktualisiert…')
})
