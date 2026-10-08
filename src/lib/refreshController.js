// Zentraler Daten-Refresh: reine Logik (ohne DOM) – Single-Flight + Steuerung.
// Ausgelöst ausschließlich über den Aktualisieren-Button (components/RefreshButton.jsx).
// Eine eigene Pull-to-Refresh-Geste gibt es bewusst NICHT mehr: Sie ließ sich im verschachtelten
// Scrollbereich (.content) auf Touch-Geräten nicht zuverlässig vom normalen Scrollen trennen
// (iOS-Überfedern, Momentum, nicht abbrechbare touchmove). Normales Scrollen hat Vorrang.

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

// Zentrale Refresh-Steuerung (von RefreshProvider genutzt): genau ein Lauf, Eingaben/Offline geschützt,
// Status wird immer zurückgesetzt, Fehler werden gemeldet – nie ein Seiten-Reload als Rückfall.
// { auto: true } = automatischer Auslöser (Rückkehr in die App, wieder online – lib/resumeRefresh.js): gleicher Lauf,
// gleiche Schutzregeln, aber ohne Hinweis-Toasts (die Seiten zeigen Ladefehler selbst); ein ↻-Klick während eines
// automatischen Laufs bekommt dessen Fehler wieder gemeldet. Automatisch gilt die strengere Sperre isAutoBlocked
// (ungespeicherte Eingaben auch ohne Fokus, siehe RefreshContext.autoRefreshBlocked).
export function createRefreshController({ getHandler, isBlocked = () => false, isAutoBlocked = isBlocked, isOffline = () => false, setStatus = () => {}, notify = () => {} }) {
  let quiet = false
  const flight = createSingleFlight(async () => {
    const handler = getHandler()
    if (!handler) return
    setStatus('refreshing')
    try { await handler() }
    catch { if (!quiet) notify('failed') }
    finally { setStatus('idle') }
  })
  return {
    refresh({ auto = false } = {}) {
      if (!getHandler()) return Promise.resolve('none')
      if (flight.running) { if (!auto) quiet = false; return flight.run() }   // zweiter Auslöser → derselbe Lauf
      if (isOffline()) { if (!auto) notify('offline'); return Promise.resolve('offline') }   // alte Daten bleiben stehen
      if (auto ? isAutoBlocked() : isBlocked()) { if (!auto) notify('blocked'); return Promise.resolve('blocked') }   // Dialog/Eingabe schützen
      quiet = auto
      return flight.run()
    },
    get running() { return flight.running },
  }
}
