import { t as tr } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useRefresh } from '../context/RefreshContext.jsx'

// Aktualisieren-Button für alle Geräte (Maus, Touch, Tastatur) → zentrale refreshData().
// Bewusst keine eigene Pull-Geste: Normales Scrollen bleibt vollständig dem Browser überlassen.
export default function RefreshButton() {
  useLocale()
  const { refreshData, status, hasHandler } = useRefresh()
  if (!hasHandler) return null
  const busy = status === 'refreshing'
  const label = busy ? tr('refresh.refreshing') : tr('refresh.button')
  return (
    <button type="button" className="refresh-dock" onClick={() => refreshData()} disabled={busy}
      aria-label={label} title={label} aria-busy={busy}>
      <span className={`refresh-icon${busy ? ' refresh-spin' : ''}`} aria-hidden="true">↻</span>
    </button>
  )
}
