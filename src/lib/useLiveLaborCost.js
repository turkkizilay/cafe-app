import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { createLaborSync, bindLaborRevalidation, liveFigures, msUntilDayEnd, TICK_MS, SAFETY_REFRESH_MS } from './laborCost'

// Live-Personalkosten (nur Admin): Serverbasis aus labor_cost_today() (Migration 35), dazwischen lokales
// Fortschreiben. Kein Ergebnis bei Fehler wird je als 0 € angezeigt – letzter Stand bleibt sichtbar, markiert.
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function useLiveLaborCost(enabled) {
  const [snap, setSnap] = useState(null)        // { base, receivedAt }
  const [problem, setProblem] = useState(null)  // { kind: 'offline' | 'error' } – letzter Abgleich gescheitert
  const [, setTick] = useState(0)
  const syncRef = useRef(null)

  useEffect(() => {
    if (!enabled) return
    const sync = createLaborSync({
      load: () => supabase.rpc('labor_cost_today'),
      now: clock,
      isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
      onData: (base, receivedAt) => { setSnap({ base, receivedAt }); setProblem(null) },
      onError: p => setProblem(p),
    })
    syncRef.current = sync
    sync.revalidate('mount')
    const unbind = bindLaborRevalidation({ win: window, doc: document, trigger: r => sync.revalidate(r) })
    const safety = setInterval(() => { if (document.visibilityState === 'visible') sync.revalidate('interval') }, SAFETY_REFRESH_MS)
    return () => { unbind(); clearInterval(safety); sync.dispose(); syncRef.current = null }
  }, [enabled])

  // Anzeige fortschreiben, solange jemand arbeitet (rein lokal)
  const running = Number(snap?.base?.today?.running) || 0
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setTick(x => x + 1), TICK_MS)
    return () => clearInterval(t)
  }, [running, snap])

  // Tageswechsel (Europe/Berlin laut Server): neue Basis holen
  useEffect(() => {
    if (!snap) return
    const t = setTimeout(() => syncRef.current?.revalidate('midnight'), msUntilDayEnd(snap.base, clock() - snap.receivedAt) + 1000)
    return () => clearTimeout(t)
  }, [snap])

  const revalidate = useCallback((reason = 'manual') => syncRef.current?.revalidate(reason), [])
  if (!enabled || !snap) return { figures: null, base: null, problem, revalidate }
  return { figures: liveFigures(snap.base, clock() - snap.receivedAt), base: snap.base, problem, revalidate }
}
