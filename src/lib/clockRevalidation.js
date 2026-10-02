// Einstempeln: Standortvoraussetzungen (Café-WLAN serverseitig über die Client-IP, GPS im Browser) live nachprüfen,
// solange die Seite offen ist – ohne Neuladen. Nur Anzeige: der Server prüft beim Stempeln immer selbst.
//
// Warum mehr als ein Check pro Ereignis: Nach dem Wechsel ins Café-WLAN (Kontrollzentrum/Einstellungen) meldet iOS die
// Rückkehr in die App oft, BEVOR das WLAN fertig verbunden ist; zudem kann die bestehende HTTP-Verbindung noch eine
// Weile über Mobilfunk laufen (Server sieht die alte IP). Deshalb: ereignisgesteuert prüfen, bei „nicht erfüllt“ wenige
// Nachprüfungen in kurzen Abständen (settle) und – nur solange sichtbar – ein sparsamer Netzwerk-Check (poll), weil
// Browser keinen WLAN-Wechsel melden und das Kontrollzentrum keine Lebenszyklus-Ereignisse auslöst.
//
// Garantien: höchstens EINE Prüfung gleichzeitig (+ höchstens eine nachgereichte), Ereignis-Bursts werden gebündelt,
// eine ältere Antwort überschreibt nie einen neueren Zustand (Sequenznummern), nach dispose() wird nichts mehr gesetzt.

export const SETTLE_DELAYS_MS = [2000, 5000, 10000]   // Nachprüfungen nach einem Ereignis, solange nicht erfüllt
export const POLL_MS = 45000                          // nur Netzwerk (kein GPS), nur sichtbar, nur auf dieser Seite
export const BURST_MS = 250                           // focus + visibilitychange + pageshow kommen oft zusammen

export function createClockRevalidator({
  checkNetwork, onNetwork,          // () => Promise<result>, (result) => void
  checkGps, onGps,                  // () => Promise<result> | null (null = GPS nicht eingerichtet), (result) => void
  onChecking = () => {},            // ('network' | 'gps') sichtbare Prüfung startet
  isSatisfied = () => false,        // aktueller Anzeigezustand erfüllt?
  isVisible = () => true,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  settleDelays = SETTLE_DELAYS_MS, pollMs = POLL_MS, burstMs = BURST_MS,
}) {
  let disposed = false, running = false, queued = null, burstTimer = null, pollTimer = null
  let settleTimers = [], netSeq = 0, gpsSeq = 0
  const stats = { runs: 0, networkChecks: 0, gpsChecks: 0 }

  const clearSettle = () => { settleTimers.forEach(clearTimer); settleTimers = [] }

  async function run({ gps, quiet }) {
    if (disposed) return
    if (running) {                                    // nie parallel: genau eine Nachprüfung vormerken (zusammengeführt)
      queued = { gps: !!(queued?.gps || gps), quiet: !!(queued ? queued.quiet && quiet : quiet) }
      return
    }
    running = true; stats.runs++
    const myNet = ++netSeq, myGps = gps ? ++gpsSeq : gpsSeq
    try {
      if (!quiet) { onChecking('network'); if (gps) onChecking('gps') }
      const tasks = [Promise.resolve().then(checkNetwork).then(
        r => { stats.networkChecks++; if (!disposed && myNet === netSeq) onNetwork(r) },
        () => { if (!disposed && myNet === netSeq) onNetwork({ status: 'error' }) })]
      if (gps) {
        const p = checkGps()
        if (p) tasks.push(Promise.resolve(p).then(
          r => { stats.gpsChecks++; if (!disposed && myGps === gpsSeq) onGps(r) },
          () => { if (!disposed && myGps === gpsSeq) onGps({ status: 'unavailable' }) }))
      }
      await Promise.all(tasks)
    } finally {
      running = false
    }
    if (disposed) return
    if (queued) { const q = queued; queued = null; return run(q) }
  }

  // Ereignis (Öffnen, Rückkehr in die App, online, Fokus, manuell): bündeln, prüfen, ggf. kurz nachprüfen
  function trigger(reason = 'event', { gps = true } = {}) {
    if (disposed) return
    clearSettle()
    if (burstTimer) clearTimer(burstTimer)
    const go = async () => {
      burstTimer = null
      await run({ gps, quiet: false })
      if (disposed) return
      // nicht erfüllt → WLAN/Verbindung braucht evtl. noch Sekunden: wenige, begrenzte Nachprüfungen (nur Netzwerk)
      if (!isSatisfied()) for (const ms of settleDelays) settleTimers.push(setTimer(() => {
        if (!disposed && isVisible() && !isSatisfied()) run({ gps: false, quiet: true })
      }, ms))
    }
    if (reason === 'initial' || reason === 'manual') go()
    else burstTimer = setTimer(go, burstMs)
  }

  // Verbindung weg: sofort „nicht verbunden“ anzeigen; eine noch laufende (ältere) Antwort darf das nicht überschreiben
  function markOffline() {
    if (disposed) return
    netSeq++
    clearSettle()
    onNetwork({ status: 'offline' })
  }

  function schedulePoll() {
    if (disposed) return
    pollTimer = setTimer(() => {
      pollTimer = null
      if (!disposed && isVisible()) run({ gps: false, quiet: true })
      schedulePoll()
    }, pollMs)
  }
  schedulePoll()

  function dispose() {
    disposed = true
    clearSettle()
    if (burstTimer) clearTimer(burstTimer)
    if (pollTimer) clearTimer(pollTimer)
  }

  return { trigger, markOffline, dispose, stats, get running() { return running } }
}

// Browser-/PWA-Ereignisse an den Revalidator binden; liefert eine Abmeldefunktion.
export function bindClockRevalidationEvents(rv, { win = window, doc = document, nav = typeof navigator !== 'undefined' ? navigator : null } = {}) {
  const onVisible = () => { if (doc.visibilityState === 'visible') rv.trigger('visible') }
  const onFocus   = () => rv.trigger('focus')
  const onShow    = () => rv.trigger('pageshow')
  const onOnline  = () => rv.trigger('online')
  const onOffline = () => rv.markOffline()
  const onConn    = () => rv.trigger('connection')           // Network Information API (Chrome/Android; iOS: nicht vorhanden)
  doc.addEventListener('visibilitychange', onVisible)
  win.addEventListener('focus', onFocus)
  win.addEventListener('pageshow', onShow)
  win.addEventListener('online', onOnline)
  win.addEventListener('offline', onOffline)
  const conn = nav?.connection
  conn?.addEventListener?.('change', onConn)
  return () => {
    doc.removeEventListener('visibilitychange', onVisible)
    win.removeEventListener('focus', onFocus)
    win.removeEventListener('pageshow', onShow)
    win.removeEventListener('online', onOnline)
    win.removeEventListener('offline', onOffline)
    conn?.removeEventListener?.('change', onConn)
  }
}

// Sind die Standortvoraussetzungen laut Anzeige erfüllt? (steuert nur die Nachprüfungen; offline/unbekannt = nein)
export function locationSatisfied(gps, net) {
  if (net?.status === 'offline') return false
  if (net?.status === 'ok') return true
  if (net?.netOnly) return false
  if (gps?.status === 'ok') return true
  return gps?.status === 'no-config' && net?.status === 'unconfigured'   // keine Prüfung eingerichtet
}

// Antwort mit garantiertem Ende: hängt eine Prüfung, blockiert sie nicht alle folgenden (sonst bliebe die Anzeige stehen)
export function withTimeout(promise, ms, fallback) {
  let timer
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => (fallback !== undefined ? resolve(fallback) : reject(new Error('timeout'))), ms)
  })
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer))
}
