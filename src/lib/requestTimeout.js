// Zentraler Request-Timeout für die Daten-API (Resilience F3). fetch/supabase-js haben keinen eigenen Timeout: Hängt eine
// Verbindung (im Betrieb beobachtet: 27,5 s; auf dem Handy nach WLAN → Mobilfunk auch minutenlang), bliebe ein Button
// oder eine Ladeanzeige sonst ohne Ende. Rein (fetch und Timer werden übergeben) → testbar.
//
// Regeln:
//  • Nur PostgREST (/rest/v1/…). Auth (/auth/v1 – ein abgebrochener Token-Refresh, den der Server schon ausgeführt hat,
//    kann die Wiederverwendungs-Erkennung auslösen und die Sitzung beenden), Storage (große Uploads) und Edge Functions
//    (Zugang zurücksetzen) bleiben UNVERÄNDERT ohne Timeout.
//  • Lesen (GET/HEAD) und Schreiben (alles andere, auch rpc/* – ob eine Funktion schreibt, ist hier unbekannt) getrennt.
//    Die Grenzen liegen bewusst ÜBER den Grenzen von boundedRequest (Einladung 20/30 s, Onboarding 20/25 s, Remote 15 s):
//    dort greift weiterhin zuerst die eigene, fachlich gewählte Grenze.
//  • Abbruch als „AbortError“: postgrest-js wiederholt dann NICHT automatisch (auch Lesen nicht) – nie blinde Wiederholung.
//    Ergebnis beim Aufrufer wie bei Verbindungsabbruch: { data: null, error, status: 0 }.
//  • Schreib-Timeout heißt „Ergebnis unbekannt“, nicht „fehlgeschlagen“ – die Meldung dazu kommt aus errorHelper.js.
export const REQUEST_TIMEOUT_MS = Object.freeze({ read: 25000, write: 45000 })
export const TIMEOUT_READ = 'request-timeout-read'
export const TIMEOUT_WRITE = 'request-timeout-write'

// 'read' | 'write' | null (null = dieser Request bekommt keinen Timeout)
export function timeoutPolicy(input, init) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input ?? ''))
  let path = ''
  try { path = new URL(url, 'http://local.invalid').pathname } catch { return null }
  if (!path.startsWith('/rest/v1/')) return null
  const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write'
}

function abortedError() {
  try { return new DOMException('aborted', 'AbortError') } catch { const e = new Error('aborted'); e.name = 'AbortError'; return e }
}

function timeoutError(kind) {
  const msg = kind === 'read' ? TIMEOUT_READ : TIMEOUT_WRITE
  try { return new DOMException(msg, 'AbortError') } catch { const e = new Error(msg); e.name = 'AbortError'; return e }
}

// Welche Art Timeout steckt in einem Fehler (Supabase-Fehlerobjekt oder Exception)? 'read' | 'write' | null
export function timeoutKind(error) {
  const m = `${error?.message ?? ''} ${error?.details ?? ''}`
  return m.includes(TIMEOUT_WRITE) ? 'write' : m.includes(TIMEOUT_READ) ? 'read' : null
}

export function withRequestTimeout(fetchFn, { ms = REQUEST_TIMEOUT_MS, setTimer = (f, t) => setTimeout(f, t), clearTimer = id => clearTimeout(id) } = {}) {
  return function timedFetch(input, init) {
    const kind = timeoutPolicy(input, init)
    if (!kind) return fetchFn(input, init)
    const ctrl = new AbortController()
    let reason   // eigener Abbruchgrund: ältere Safari-Versionen übernehmen abort(reason) nicht in signal.reason
    const abort = r => { reason = r; ctrl.abort(r) }
    // Jeder Abbruch (Zeitüberschreitung ODER Aufrufer) beendet das Rennen sofort – auch wenn fetch das Signal ignoriert
    const limit = new Promise((_, reject) => ctrl.signal.addEventListener('abort',
      () => reject(reason ?? ctrl.signal.reason ?? timeoutError(kind)), { once: true }))
    limit.catch(() => {})   // nur für das Rennen unten; nie „unbehandelt“
    const outer = init?.signal
    // Abbruch durch den Aufrufer (boundedRequest, Dialog zu) unverändert durchreichen – nie als Zeitüberschreitung ausgeben
    const outerReason = () => outer.reason ?? abortedError()
    const onOuter = () => abort(outerReason())
    if (outer?.aborted) abort(outerReason())
    else outer?.addEventListener?.('abort', onOuter, { once: true })
    let timer = ctrl.signal.aborted ? null : setTimer(() => abort(timeoutError(kind)), ms[kind])
    const done = () => { if (timer !== null) { clearTimer(timer); timer = null } outer?.removeEventListener?.('abort', onOuter) }
    // Garantiertes Ende auch dann, wenn die darunterliegende fetch-Funktion das Signal nicht beachtet
    return Promise.race([Promise.resolve().then(() => fetchFn(input, { ...(init || {}), signal: ctrl.signal })), limit])
      .then(res => { done(); return res }, err => { done(); throw err })
  }
}
