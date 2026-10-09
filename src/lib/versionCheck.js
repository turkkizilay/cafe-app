// App-Version erkennen (Resilience F8). Eine offene PWA lädt nie von selbst neu – ohne Hinweis liefe eine alte Version
// tagelang gegen neue Datenbank-Stände (die Deploy-Reihenfolge rechnet mit kurzlebigen alten Clients).
//
// Regeln:
//  • Build-ID steckt im Bundle (__APP_BUILD_ID__, vite.config.js) und in /version.json (gleicher Build, no-store).
//  • Prüfen nur bei bestehenden Ereignissen (Rückkehr in die App, wieder online, Tageswechsel – lib/resumeRefresh.js über
//    RefreshProvider), höchstens alle 60 s, nie parallel, mit Zeitgrenze. Kein eigenes Polling, keine neuen Listener.
//  • NIE automatisch neu laden: nur ein Hinweis; Neu laden ist eine Entscheidung der Person (components/UpdateBanner.jsx).
//  • Fehlgeschlagene Chunk-Ladung (alter Chunk nach Deploy weg) → derselbe Hinweis.
//  • Ohne gültige Build-ID (lokale Entwicklung) ist die Prüfung aus. Fehler beim Abruf (offline) bleiben still.
export const VERSION_URL = '/version.json'
export const CHECK_MIN_GAP_MS = 60000
export const CHECK_TIMEOUT_MS = 8000

const CHUNK_ERRORS = [/Failed to fetch dynamically imported module/i, /Importing a module script failed/i,
  /error loading dynamically imported module/i, /Loading (CSS )?chunk [\w-]+ failed/i, /ChunkLoadError/i, /Unable to preload CSS/i]
export function isChunkLoadError(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''}`
  return CHUNK_ERRORS.some(re => re.test(text))
}

export const isBuildId = id => typeof id === 'string' && /^[0-9a-f]{7,40}$/i.test(id)

export function createVersionChecker({
  currentId,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  minGapMs = CHECK_MIN_GAP_MS, timeoutMs = CHECK_TIMEOUT_MS,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id),
} = {}) {
  const enabled = isBuildId(currentId)
  const subs = new Set()
  let state = { available: false, reason: null }
  let latestId = null, dismissedId = undefined, inFlight = null, lastCheck = -Infinity

  const emit = () => { for (const fn of [...subs]) { try { fn(state) } catch { /* Anzeige darf Prüfung nie stören */ } } }
  function mark(reason, id = null) {
    if (reason === 'version' && id !== null && id === dismissedId) return   // diese Version wurde schon weggeklickt
    if (id !== null) latestId = id
    if (state.available && state.reason === reason) return
    state = { available: true, reason }
    emit()
  }

  function check() {
    if (!enabled) return Promise.resolve('disabled')
    if (inFlight) return inFlight
    if (now() - lastCheck < minGapMs) return Promise.resolve('throttled')
    lastCheck = now()
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = setTimer(() => ctrl?.abort(), timeoutMs)
    inFlight = Promise.resolve()
      .then(() => fetchImpl(`${VERSION_URL}?t=${lastCheck}`, { cache: 'no-store', signal: ctrl?.signal, headers: { accept: 'application/json' } }))
      .then(res => (res && res.ok ? res.json() : null))
      .then(body => {
        const id = body?.build
        if (!isBuildId(id)) return 'unknown'
        if (id === currentId) return 'current'
        mark('version', id)
        return 'new'
      })
      .catch(() => 'error')
      .finally(() => { clearTimer(timer); inFlight = null })
    return inFlight
  }

  return {
    check,
    reportChunkFailure() { mark('chunk') },
    // Später: bis eine ANDERE neue Version erkannt wird (oder ein Chunk fehlt) nicht erneut zeigen
    dismiss() { dismissedId = latestId; state = { available: false, reason: null }; emit() },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    getState: () => state,
    get enabled() { return enabled },
  }
}

// App-weite Instanz (Build-ID aus dem Bundle; außerhalb des Vite-Builds nicht definiert → Prüfung aus)
/* global __APP_BUILD_ID__ */
const appChecker = createVersionChecker({ currentId: typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : null })
export const checkForNewVersion = () => appChecker.check()
export const reportChunkFailure = () => appChecker.reportChunkFailure()
export const dismissUpdate = () => appChecker.dismiss()
export const subscribeUpdate = fn => appChecker.subscribe(fn)
export const getUpdateState = () => appChecker.getState()
