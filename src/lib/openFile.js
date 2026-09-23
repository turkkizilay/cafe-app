/**
 * openSignedFile — öffnet eine private Datei (Attest, Lohnabrechnung, Vertrag)
 * in einem neuen Tab, ohne vom Pop-up-Blocker gestoppt zu werden.
 *
 * Problem vorher: Die App hat erst die signierte URL geladen (await) und DANACH
 * window.open() aufgerufen. Safari/iOS wertet das nicht mehr als Klick des Nutzers
 * und blockiert den Tab ("Pop-up-Fenster blockiert").
 *
 * Lösung:
 *  1. Tab wird SOFORT im Klick geöffnet (synchron, bevor irgendein await passiert).
 *  2. Danach wird die kurzlebige signierte URL geholt und in diesen Tab geladen.
 *  3. Blockiert der Browser trotzdem, erscheint in der App ein Link
 *     „Dokument öffnen" — ein echter Tipp darauf wird nie blockiert.
 *
 * WICHTIG für Aufrufer: openSignedFile() muss direkt im onClick aufgerufen werden,
 * ohne vorheriges await, sonst ist die Klick-Erlaubnis bereits verbraucht.
 *
 * Signierte URLs werden nirgends gespeichert (nur im Tab bzw. kurz im Fallback-Dialog).
 */

const _subs = new Set()
let _pending = null   // { url, label } für den Fallback-Dialog

function _notify() { _subs.forEach(fn => fn(_pending)) }

export function subscribeOpenFallback(fn) {
  _subs.add(fn)
  return () => _subs.delete(fn)
}

export function clearOpenFallback() {
  _pending = null
  _notify()
}

/**
 * @param {() => Promise<string>} getSignedUrl  liefert die signierte URL (wirft bei Fehler)
 * @param {string} [label]                      Text für den Fallback-Link
 */
export async function openSignedFile(getSignedUrl, label = 'Dokument öffnen') {
  // 1. Tab synchron öffnen — noch innerhalb der Klick-Aktion
  let tab = null
  try { tab = window.open('', '_blank') } catch { tab = null }
  if (tab) {
    try {
      tab.opener = null
      tab.document.title = 'Wird geladen…'
      tab.document.body.style.cssText = 'font-family:-apple-system,system-ui,sans-serif;padding:32px;color:#6B7280'
      tab.document.body.textContent = 'Dokument wird geladen…'
    } catch { /* manche Browser erlauben keinen Zugriff — egal */ }
  }

  // 2. Signierte URL holen
  let url
  try {
    url = await getSignedUrl()
  } catch (err) {
    try { tab?.close() } catch { /* ignore */ }
    throw err
  }

  // 3. In den offenen Tab laden — oder Fallback-Link anzeigen
  if (tab && !tab.closed) {
    try { tab.location.href = url; return true } catch { /* fällt durch zum Fallback */ }
  }
  _pending = { url, label }
  _notify()
  return false
}
