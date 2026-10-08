// Zentraler Resume-/Online-Refresh (Resilience F4). Rein (Dokument, Fenster, Uhr und Timer werden übergeben) → testbar.
// Löst die BESTEHENDE zentrale Aktualisierung aus (RefreshProvider → refreshController, Single-Flight, Schutz offener
// Dialoge/Eingaben) – kein zweites Lade-System. Die Seiten laden mit ihrer registrierten Ladefunktion wie beim ↻-Button.
//
// Wann:
//  • Rückkehr in die App (visibilitychange → visible), nur wenn sie ≥ 60 s versteckt war (Kontrollzentrum, App-Umschalter,
//    kurzer Blick in eine andere App lösen nichts aus)
//  • Rückkehr aus dem Seiten-Cache (pageshow mit persisted – Desktop-Safari/Android-Chrome)
//  • wieder online nach „offline“
//  • Tageswechsel: beim Zurückkehren an einem anderen Kalendertag sofort; bleibt die App über Mitternacht sichtbar
//    (Café-Tablet), kurz nach Mitternacht
// Nicht: reiner Fensterfokus (Desktop-Fensterwechsel) – Fokus holt nur einen vorgemerkten Lauf nach.
//
// Schutz: Ereignis-Bündel (visible + pageshow + online kommen oft zusammen) → EIN Lauf; mindestens 30 s zwischen zwei
// automatischen Läufen (außer Tageswechsel); offline → vormerken bis online; Dialog/Eingabe offen → vormerken, wenige
// begrenzte Nachversuche, sonst beim nächsten Ereignis. dispose() entfernt alle Listener und Timer.
export const RESUME_MIN_HIDDEN_MS = 60000
export const AUTO_MIN_GAP_MS = 30000
export const BURST_MS = 400
export const BLOCKED_RETRY_MS = 15000
export const BLOCKED_RETRIES = 4
export const MIDNIGHT_DELAY_MS = 5000

export function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function msUntilNextLocalMidnight(ms) {
  const d = new Date(ms); const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0)
  return next.getTime() - ms
}

// onTrigger(reason) → Promise<'blocked' | 'offline' | 'none' | unknown> (Ergebnis von refreshController.refresh({ auto: true }))
export function createResumeTrigger({
  doc, win, onTrigger,
  now = () => Date.now(),
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id),
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  minHiddenMs = RESUME_MIN_HIDDEN_MS, minGapMs = AUTO_MIN_GAP_MS, burstMs = BURST_MS,
  blockedRetryMs = BLOCKED_RETRY_MS, blockedRetries = BLOCKED_RETRIES, midnightDelayMs = MIDNIGHT_DELAY_MS,
}) {
  const visible = () => doc.visibilityState === 'visible'
  let disposed = false
  let hiddenAt = visible() ? null : now()
  let dayAtHide = visible() ? null : localDay(now())
  let lastRun = -Infinity
  let pending = null          // vorgemerkter Grund ('resume' | 'online' | 'day' | 'pageshow')
  let wasOffline = !isOnline()
  let burst = null, retry = null, midnight = null, retries = 0, running = false
  const stats = { triggers: 0 }

  function want(reason) {
    if (disposed) return
    if (!pending || reason === 'day') pending = reason   // Tageswechsel hat Vorrang (umgeht den Mindestabstand)
    if (burst === null) burst = setTimer(flush, burstMs)
  }

  async function flush() {
    burst = null
    if (disposed || !pending || running) return
    if (!visible() || !isOnline()) return                       // vorgemerkt lassen: nächstes visible/online holt nach
    if (pending !== 'day' && now() - lastRun < minGapMs) { pending = null; return }   // gerade erst aktualisiert
    const reason = pending; pending = null
    running = true; stats.triggers++
    let result
    try { result = await onTrigger(reason) } catch { result = 'failed' } finally { running = false }
    if (disposed) return
    if (result === 'blocked' || result === 'offline') {
      pending = reason                                           // nichts geladen → vormerken
      if (result === 'blocked') scheduleRetry()
      return
    }
    lastRun = now(); retries = 0
    if (pending) want(pending)                                    // während des Laufs eingetroffen (z. B. Tageswechsel)
  }

  function scheduleRetry() {
    if (retry !== null || retries >= blockedRetries) return
    retry = setTimer(() => { retry = null; retries++; if (pending && visible()) want(pending) }, blockedRetryMs)
  }
  function clearRetry() { if (retry !== null) { clearTimer(retry); retry = null } }

  function scheduleMidnight() {
    if (midnight !== null || disposed) return
    midnight = setTimer(() => { midnight = null; if (disposed) return; if (visible()) { want('day'); scheduleMidnight() } },
      msUntilNextLocalMidnight(now()) + midnightDelayMs)
  }
  function clearMidnight() { if (midnight !== null) { clearTimer(midnight); midnight = null } }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') {
      if (hiddenAt === null) { hiddenAt = now(); dayAtHide = localDay(hiddenAt) }
      clearMidnight(); clearRetry()
      return
    }
    if (!visible()) return
    const hiddenFor = hiddenAt === null ? 0 : now() - hiddenAt
    const dayChanged = dayAtHide !== null && dayAtHide !== localDay(now())
    hiddenAt = null; dayAtHide = null; retries = 0
    scheduleMidnight()
    if (dayChanged) want('day')
    else if (hiddenFor >= minHiddenMs) want('resume')
    else if (pending) want(pending)
  }
  // Rückkehr aus dem Seiten-Cache: Seite war eingefroren, Dauer unbekannt → wie Rückkehr nach langer Zeit
  function onPageShow(e) {
    if (!e?.persisted) return
    const dayChanged = dayAtHide !== null && dayAtHide !== localDay(now())
    hiddenAt = null; dayAtHide = null
    scheduleMidnight()
    want(dayChanged ? 'day' : 'pageshow')
  }
  function onOnline() { if (wasOffline) { wasOffline = false; want('online') } else if (pending) want(pending) }
  function onOffline() { wasOffline = true }
  function onFocus() { if (pending) want(pending) }

  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('pageshow', onPageShow)
  win.addEventListener('online', onOnline)
  win.addEventListener('offline', onOffline)
  win.addEventListener('focus', onFocus)
  if (visible()) scheduleMidnight()

  return {
    dispose() {
      disposed = true
      doc.removeEventListener('visibilitychange', onVisibility)
      win.removeEventListener('pageshow', onPageShow)
      win.removeEventListener('online', onOnline)
      win.removeEventListener('offline', onOffline)
      win.removeEventListener('focus', onFocus)
      if (burst !== null) { clearTimer(burst); burst = null }
      clearRetry(); clearMidnight()
    },
    stats,
    get pending() { return pending },
  }
}
