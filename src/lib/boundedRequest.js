// Supabase-Anfrage mit garantiertem Ende. fetch hat keinen eigenen Timeout: Hängt die Verbindung (im Betrieb
// beobachtet: 27,5 s für eine sonst 0,1-s-RPC), wartet ein Button sonst unbegrenzt. Liefert IMMER ein Ergebnis
// im Supabase-Format; `status: 0` heißt „keine Serverantwort“ (Netzwerk, Zeitüberschreitung, Abbruch).
// Achtung bei Schreibaktionen: `status: 0` heißt NICHT „nicht ausgeführt“ – der Server kann trotzdem gespeichert haben.
//
// build(signal) baut die Abfrage mit `.abortSignal(signal)`; cancel = optionales Signal zum Abbrechen (z. B. Dialog zu).
export async function boundedRequest(build, { ms, cancel } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const onCancel = () => ctrl.abort()
  cancel?.addEventListener('abort', onCancel, { once: true })
  if (cancel?.aborted) ctrl.abort()
  const noAnswer = e => ({ data: null, error: { message: String(e?.message || e || 'AbortError'), code: '' }, status: 0, cancelled: !!cancel?.aborted, timedOut: !cancel?.aborted && ctrl.signal.aborted })
  try {
    return await new Promise(resolve => {
      // Auch wenn die Abfrage vor dem eigentlichen fetch hängt (z. B. Warten auf die Sitzung), endet es hier.
      if (ctrl.signal.aborted) return resolve(noAnswer())
      ctrl.signal.addEventListener('abort', () => resolve(noAnswer()), { once: true })
      Promise.resolve().then(() => build(ctrl.signal)).then(r => resolve(r?.status === 0 ? { ...r, ...noAnswer(r.error?.message), error: r.error } : r), e => resolve(noAnswer(e)))
    })
  } finally {
    clearTimeout(timer)
    cancel?.removeEventListener('abort', onCancel)
  }
}
