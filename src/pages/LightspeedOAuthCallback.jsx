import { t as tr, getIntlLocale, localizeMessage, message as appMessage, messageParts } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
/**
 * Lightspeed OAuth Callback-Seite
 *
 * Route: /einstellungen/integrationen/lightspeed/callback
 *
 * Lightspeed redirectet nach OAuth-Autorisierung auf diese URL.
 * Liest ?code= und ?state= aus der URL, ruft connectionService.handleOAuthCallback() auf,
 * und leitet danach zu /einstellungen weiter (Tab: Integrationen).
 *
 * Diese Seite hat keine eigene UI-Logik — sie ist nur ein Zwischenschritt.
 */

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { connectionService } from '../integrations/lightspeed/services/connectionService.js'
import { toPosUserMessage }  from '../integrations/lightspeed/errors/PosIntegrationError.js'
import { logActivity }       from '../lib/activityLog.js'

export default function LightspeedOAuthCallback() {
  useLocale()
  const [searchParams] = useSearchParams()
  const navigate        = useNavigate()
  const [status,  setStatus]  = useState('processing')  // 'processing' | 'success' | 'error'
  const [message, setMessage] = useState(appMessage("ui.14ce29bbe181"))

  useEffect(() => {
    const code         = searchParams.get('code')
    const state        = searchParams.get('state')
    const errorParam   = searchParams.get('error')
    const errorDesc    = searchParams.get('error_description')

    // Lightspeed hat den OAuth-Flow abgebrochen / Fehler gemeldet
    if (errorParam) {
      setStatus('error')
      setMessage(appMessage("ui.487b68b4a073", { p1: ((errorDesc || errorParam)) }))
      setTimeout(() => navigate('/einstellungen?tab=integrationen'), 4000)
      return
    }

    if (!code || !state) {
      setStatus('error')
      setMessage(appMessage("ui.ae1f23b77f45"))
      setTimeout(() => navigate('/einstellungen?tab=integrationen'), 4000)
      return
    }

    // organizationId aus State extrahieren (Format: "orgId:uuid")
    const organizationId = state.split(':')[0] || 'cafe-buur'

    async function handleCallback() {
      try {
        await connectionService.handleOAuthCallback(code, state, organizationId)
        setStatus('success')
        setMessage(appMessage("ui.4b7187b155ac"))
        logActivity({
          action: 'integration.connected', category: 'integration',
          summary: 'hat Lightspeed verbunden.',
          targetType: 'pos_connection',
        })
        setTimeout(() => navigate('/einstellungen?tab=integrationen'), 2000)
      } catch (err) {
        setStatus('error')
        setMessage(messageParts(['❌ ', toPosUserMessage(err)]))
        setTimeout(() => navigate('/einstellungen?tab=integrationen'), 5000)
      }
    }

    handleCallback()
  }, [])  // Einmal beim Mount — searchParams bewusst nicht in deps

  const isError   = status === 'error'
  const isSuccess = status === 'success'

  return (
    <div style={{
      minHeight: '100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg)', padding:24,
    }}>
      <div style={{
        background:'var(--card)', borderRadius:16, padding:'40px 32px',
        maxWidth:440, width:'100%', textAlign:'center',
        boxShadow:'0 8px 32px rgba(0,0,0,0.12)', border:'1px solid var(--border)',
      }}>
        <div style={{ fontSize:48, marginBottom:16 }}>
          {isError ? '⚠️' : isSuccess ? '✅' : '🔗'}
        </div>
        <h2 style={{ fontSize:18, fontWeight:700, marginBottom:12, color:'var(--text-primary)' }}>
          {isError ? tr("ui.9f5c81a587e0") : isSuccess ? tr("ui.ea9c1b9aa6b8") : tr("ui.5ad863758478")}
        </h2>
        <p style={{ fontSize:14, color:'var(--text-secondary)', lineHeight:1.7, marginBottom:24 }}>
          {localizeMessage(message)}
        </p>
        {status === 'processing' && (
          <div style={{
            width:32, height:32, border:'3px solid var(--border)', borderTopColor:'var(--accent)',
            borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto',
          }} />
        )}
        {(isError || isSuccess) && (
          <p style={{ fontSize:12, color:'var(--text-muted)' }}>{tr("ui.b56c92de3de2")}</p>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
