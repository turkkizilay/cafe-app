import { useEffect, useRef, useState } from 'react'
import { t as tr } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useRefresh } from '../context/RefreshContext.jsx'
import { attachPullToRefresh, PULL_THRESHOLD } from '../lib/pullToRefresh'

const IDLE = { state: 'idle', distance: 0 }

// Pull-to-Refresh für Touch-Geräte (iOS/Android, Browser & installierte App, Touchscreen-Laptops).
// Nur ganz oben im Seiteninhalt (.content), eindeutig nach unten, über Schwelle → genau ein refreshData().
// Der Browser-eigene Pull-Refresh wird per CSS (overscroll-behavior auf .content) und preventDefault verhindert.
export default function PullToRefresh() {
  useLocale()
  const { refreshData, status, hasHandler } = useRefresh()
  const [pull, setPull] = useState(IDLE)
  const refreshRef = useRef(refreshData)
  refreshRef.current = refreshData

  useEffect(() => {
    if (!hasHandler) return
    return attachPullToRefresh(document, {
      onChange: next => setPull(p => (p.state === next.state && p.distance === next.distance ? p : next)),
      onFire: () => refreshRef.current(),
      getStyle: el => getComputedStyle(el),
    })
  }, [hasHandler])

  const refreshing = status === 'refreshing'
  if (!hasHandler || (pull.state === 'idle' && !refreshing)) return null
  const distance = refreshing ? PULL_THRESHOLD * 0.7 : pull.distance
  const label = refreshing ? tr('refresh.refreshing') : pull.state === 'ready' ? tr('refresh.release') : tr('refresh.pull')
  return (
    <div className="ptr-indicator" role="status" aria-live="polite"
      style={{ transform: `translate(-50%, ${Math.round(distance)}px)`, opacity: refreshing ? 1 : Math.min(1, distance / 40) }}>
      <span className={`ptr-icon${refreshing ? ' ptr-spin' : ''}`} aria-hidden="true"
        style={refreshing ? undefined : { transform: `rotate(${Math.round(Math.min(1, pull.distance / PULL_THRESHOLD) * 180)}deg)` }}>↻</span>
      <span>{label}</span>
    </div>
  )
}

// Für alle Geräte (auch klassische Maus): dieselbe Aktion als dezenter Button
export function RefreshButton() {
  useLocale()
  const { refreshData, status, hasHandler } = useRefresh()
  if (!hasHandler) return null
  const busy = status === 'refreshing'
  return (
    <button type="button" className="refresh-dock" onClick={() => refreshData()} disabled={busy}
      aria-label={tr('refresh.button')} title={tr('refresh.button')}>
      <span className={`ptr-icon${busy ? ' ptr-spin' : ''}`} aria-hidden="true">↻</span>
    </button>
  )
}
