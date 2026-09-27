// Pull-to-Refresh: reine Logik (ohne DOM) – Gestenerkennung, Dämpfung, Single-Flight-Refresh.
// Die DOM-Anbindung liegt in components/PullToRefresh.jsx.

export const PULL_THRESHOLD = 70    // gedämpfter Weg in px, ab dem Loslassen aktualisiert
export const PULL_MAX = 110         // maximaler sichtbarer Zugweg
const START_SLOP = 8                // Mindestbewegung, bevor die Richtung entschieden wird

// Widerstand: anfangs fast 1:1, danach zunehmend zäh, nie über PULL_MAX
export function dampen(dy) {
  if (!(dy > 0)) return 0
  return PULL_MAX * (1 - Math.exp(-dy / (PULL_MAX * 1.2)))
}

// Zustandsautomat einer Zieh-Geste. Liefert bei move(): { state: 'idle'|'pulling'|'ready', distance, capture }
// capture = true → Geste gehört uns (preventDefault, damit weder Scrollen noch Browser-Pull greifen).
export function createPullTracker({ threshold = PULL_THRESHOLD } = {}) {
  let start = null, active = false, distance = 0
  const idle = { state: 'idle', distance: 0, capture: false }
  return {
    start(x, y, { scrollTop = 0, blocked = false } = {}) {
      active = false; distance = 0
      start = !blocked && scrollTop <= 0 ? { x, y } : null
      return !!start
    },
    move(x, y, { scrollTop = 0 } = {}) {
      if (!start) return idle
      const dx = x - start.x, dy = y - start.y
      if (!active) {
        if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return idle
        // nur eindeutig vertikal nach unten, ganz oben – sonst gehört die Geste dem normalen Scrollen
        if (dy <= 0 || Math.abs(dx) >= Math.abs(dy) || scrollTop > 0) { start = null; return idle }
        active = true
      }
      distance = dampen(dy)
      return { state: distance >= threshold ? 'ready' : 'pulling', distance, capture: true }
    },
    end() {
      const fire = active && distance >= threshold
      start = null; active = false; distance = 0
      return { fire }
    },
    cancel() { start = null; active = false; distance = 0 },
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
  let content = null
  const onStart = e => {
    if (!e.touches || e.touches.length !== 1) { t.cancel(); return }
    const el = e.target && typeof e.target.closest === 'function' ? e.target : null
    const c = el ? el.closest('.content') : null
    content = c
    const blocked = isIgnoredTarget(el) || !c || insideOwnScroller(el, c, getStyle)
    t.start(e.touches[0].clientX, e.touches[0].clientY, { scrollTop: c ? c.scrollTop : 1, blocked })
  }
  const onMove = e => {
    if (!e.touches || e.touches.length !== 1) { t.cancel(); onChange(IDLE); return }   // Zwei-Finger-Zoom
    const r = t.move(e.touches[0].clientX, e.touches[0].clientY, { scrollTop: content ? content.scrollTop : 1 })
    if (!r.capture) return                                   // normales Scrollen bleibt unangetastet
    if (e.cancelable) e.preventDefault()                     // nur unsere Geste: kein Scroll-/Browser-Pull parallel
    onChange({ state: r.state, distance: r.distance })
  }
  const onEnd = () => { const { fire } = t.end(); onChange(IDLE); if (fire) onFire() }
  const onCancel = () => { t.cancel(); onChange(IDLE) }
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
