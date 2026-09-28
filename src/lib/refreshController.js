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
