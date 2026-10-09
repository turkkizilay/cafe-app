import { useEffect, useState } from 'react'
import { t as tr } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { autoRefreshBlocked } from '../context/RefreshContext.jsx'
import { subscribeUpdate, getUpdateState, dismissUpdate } from '../lib/versionCheck'

// Hinweis „Neue Version verfügbar“ (Resilience F8). Nie automatisch neu laden – nur auf Klick. Sind ungespeicherte
// Eingaben auf der Seite (gefülltes Textfeld oder offener Dialog), wird vorher ausdrücklich gefragt.
// Liegt unter Dialogen (z-index 950 < .modal-overlay 1000), damit nie ein Dialog-Button verdeckt wird.
export function reloadForUpdate({ doc = document, win = window } = {}) {
  if (autoRefreshBlocked(doc) && !win.confirm(tr('update.unsavedConfirm'))) return false
  win.location.reload()
  return true
}

export default function UpdateBanner() {
  useLocale()
  const [state, setState] = useState(getUpdateState)
  useEffect(() => subscribeUpdate(setState), [])
  if (!state.available) return null
  return (
    <div role="status" aria-live="polite" data-testid="update-banner"
      style={{ position:'fixed', zIndex:950, left:'50%', transform:'translateX(-50%)',
        bottom:'calc(16px + env(safe-area-inset-bottom))', width:'min(560px, calc(100vw - 32px))', boxSizing:'border-box',
        display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', padding:'12px 14px', borderRadius:12,
        background:'#1C1917', color:'#fff', boxShadow:'0 8px 24px rgba(0,0,0,.3)', fontSize:14 }}>
      <span style={{ flex:'1 1 200px' }}>{tr(state.reason === 'chunk' ? 'update.chunk' : 'update.available')}</span>
      <button type="button" className="btn btn-sm btn-primary" style={{ minHeight:44 }} onClick={() => reloadForUpdate()}>{tr('update.reload')}</button>
      <button type="button" className="btn btn-sm" style={{ minHeight:44 }} onClick={dismissUpdate}>{tr('update.later')}</button>
    </div>
  )
}
