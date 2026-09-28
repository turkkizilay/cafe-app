// Pull-to-Refresh: reine Logik (ohne DOM) – Gestenerkennung, Dämpfung, Single-Flight-Refresh.
// Die DOM-Anbindung liegt in components/PullToRefresh.jsx.

export const PULL_THRESHOLD = 70    // gedämpfter Weg in px, ab dem Loslassen aktualisiert
export const PULL_MAX = 110         // maximaler sichtbarer Zugweg
const START_SLOP = 8                // Mindestbewegung, bevor die Richtung entschieden wird
export const TOP_EPSILON = 1        // Toleranz für „ganz oben“ (Subpixel-Rundung)

// Widerstand: anfangs fast 1:1, danach zunehmend zäh, nie über PULL_MAX
export function dampen(dy) {
  if (!(dy > 0)) return 0
  return PULL_MAX * (1 - Math.exp(-dy / (PULL_MAX * 1.2)))
}

// Scrollbereich ruht ganz oben. Negativ = iOS-Überscroll/Bounce (Inhalt federt noch) → NICHT oben.
export function atRestTop(scrollTop) {
  return Number.isFinite(scrollTop) && scrollTop >= 0 && scrollTop <= TOP_EPSILON
}

// Zustandsautomat einer Zieh-Geste. Liefert bei move(): { state: 'idle'|'pulling'|'ready', distance, capture }
// capture = true → Geste gehört uns (preventDefault, damit weder Scrollen noch Browser-Pull greifen).
// Berechtigung wird GENAU EINMAL pro Geste bei touchstart festgelegt (eligibleAtTouchStart) und kann
// während der Geste nur verloren, nie nachträglich gewonnen werden. Nur ein neuer touchstart beginnt neu.
export function createPullTracker({ threshold = PULL_THRESHOLD } = {}) {
  let g = null   // aktuelle Geste: { x, y, top, eligible, active, distance }
  const idle = { state: 'idle', distance: 0, capture: false }
  const drop = () => { g.eligible = false; g.active = false; g.distance = 0; return idle }
  return {
    start(x, y, { scrollTop = NaN, blocked = false } = {}) {
      g = { x, y, top: scrollTop, eligible: !blocked && atRestTop(scrollTop), active: false, distance: 0 }
      return g.eligible
    },
    move(x, y, { scrollTop = NaN, cancelable = true } = {}) {
      if (!g || !g.eligible) return idle                     // kein touchstart / Geste nicht oben begonnen
      if (!atRestTop(scrollTop)) return drop()               // Inhalt hat sich bewegt → Geste gehört dem Scrollen
      const dx = x - g.x, dy = y - g.y
      if (!g.active) {
        if (Math.abs(scrollTop - g.top) > TOP_EPSILON) return drop()
        if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return idle
        // nur eindeutig vertikal nach unten – sonst gehört die Geste dem normalen Scrollen.
        // Nicht abbrechbares Event = Browser scrollt bereits selbst (z. B. Fling/Momentum) → nie unsere Geste.
        if (dy <= 0 || Math.abs(dx) >= Math.abs(dy) || !cancelable) return drop()
        g.active = true
      } else if (!cancelable) return drop()                  // Browser hat übernommen → kein Doppel-Refresh
      g.distance = dampen(dy)
      return { state: g.distance >= threshold ? 'ready' : 'pulling', distance: g.distance, capture: true }
    },
    end() {
      const fire = !!g && g.eligible && g.active && g.distance >= threshold
      g = null
      return { fire }
    },
    cancel() { g = null },
  }
}

// Genau ein Refresh gleichzeitig: weitere Aufrufe während eines Laufs bekommen dasselbe Promise.
export function createSingleFlight(run) {
  let current = null
  return {
    run() {
      if (current) return current
      current = Promise.resolve().then(run).finally(() => { current = null })
      return current
    },
    get running() { return current !== null },
  }
}

// Ziel einer Berührung, bei dem keine Zieh-Geste beginnen darf (Formulare, Dialoge, eigene Scrollbereiche).
// el: DOM-Element (oder kompatibles Objekt mit closest/tagName/isContentEditable)
export function isIgnoredTarget(el) {
  if (!el || typeof el.closest !== 'function') return true
  if (el.closest('input, textarea, select, [contenteditable="true"], .modal-overlay, .modal, .sidebar, .mobile-bar, [data-no-pull]')) return true
  return !el.closest('.content')
}

// Eigener vertikaler Scrollbereich zwischen Ziel und .content (Tabellen, Listen) → keine Zieh-Geste
export function insideOwnScroller(el, content, getStyle) {
  for (let n = el; n && n !== content; n = n.parentElement) {
    const oy = getStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true
  }
  return false
}

const IDLE = Object.freeze({ state: 'idle', distance: 0 })

// Touch-Listener am Dokument (nur Touch – bewusst keine Maus-/Wheel-/Pointer-Geste).
// Gibt eine Abmeldefunktion zurück, die exakt die angemeldeten Listener wieder entfernt.
export function attachPullToRefresh(doc, { onChange, onFire, getStyle, threshold } = {}) {
  const t = createPullTracker({ threshold })
  let content = null, shown = false
  const hide = () => { shown = false; onChange(IDLE) }
  const onStart = e => {
    if (shown) hide()
    if (!e.touches || e.touches.length !== 1) { t.cancel(); return }
    const el = e.target && typeof e.target.closest === 'function' ? e.target : null
    const c = el ? el.closest('.content') : null
    content = c
    const blocked = isIgnoredTarget(el) || !c || insideOwnScroller(el, c, getStyle)
    t.start(e.touches[0].clientX, e.touches[0].clientY, { scrollTop: c ? c.scrollTop : NaN, blocked })
  }
  const onMove = e => {
    if (!e.touches || e.touches.length !== 1) { t.cancel(); hide(); return }   // Zwei-Finger-Zoom
    const r = t.move(e.touches[0].clientX, e.touches[0].clientY, { scrollTop: content ? content.scrollTop : NaN, cancelable: e.cancelable !== false })
    if (!r.capture) { if (shown) hide(); return }            // normales Scrollen bleibt unangetastet
    e.preventDefault()                                       // nur unsere Geste: kein Scroll-/Browser-Pull parallel
    shown = true
    onChange({ state: r.state, distance: r.distance })
  }
  const onEnd = () => { const { fire } = t.end(); content = null; hide(); if (fire) onFire() }
  const onCancel = () => { t.cancel(); content = null; hide() }
  const listeners = [['touchstart', onStart, { passive: true }], ['touchmove', onMove, { passive: false }], ['touchend', onEnd, undefined], ['touchcancel', onCancel, undefined]]
  for (const [type, fn, opts] of listeners) doc.addEventListener(type, fn, opts)
  return () => { for (const [type, fn] of listeners) doc.removeEventListener(type, fn); t.cancel() }
}

// Zentrale Refresh-Steuerung (von RefreshProvider genutzt): genau ein Lauf, Eingaben/Offline geschützt,
// Status wird immer zurückgesetzt, Fehler werden gemeldet – nie ein Seiten-Reload als Rückfall.
export function createRefreshController({ getHandler, isBlocked = () => false, isOffline = () => false, setStatus = () => {}, notify = () => {} }) {
  const flight = createSingleFlight(async () => {
    const handler = getHandler()
    if (!handler) return
    setStatus('refreshing')
    try { await handler() }
    catch { notify('failed') }
    finally { setStatus('idle') }
  })
  return {
    refresh() {
      if (!getHandler()) return Promise.resolve('none')
      if (flight.running) return flight.run()                 // zweiter Auslöser → derselbe Lauf
      if (isOffline()) { notify('offline'); return Promise.resolve('offline') }   // alte Daten bleiben stehen
      if (isBlocked()) { notify('blocked'); return Promise.resolve('blocked') }   // Dialog/Eingabe schützen
      return flight.run()
    },
    get running() { return flight.running },
  }
}
