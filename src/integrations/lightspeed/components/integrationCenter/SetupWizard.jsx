import { t as tr, getIntlLocale, localizeMessage, message as appMessage, errorMessage, messageParts } from '../../../../i18n/runtime.js'
import { useLocale } from '../../../../context/LocaleContext.jsx'
/**
 * SetupWizard — Lightspeed Einrichtungsassistent (B1–B6, B15, B17)
 *
 * Zeigt Systemprüfung, nächsten Schritt, Redirect-URI, Scopes.
 * Der Assistent führt den Admin durch die Einrichtung.
 *
 * Ehrlich: Zeigt transparente Anleitung was im Lightspeed Developer
 * Portal manuell erledigt werden muss (B17).
 */

import { useLightspeedSetup } from '../../hooks/useLightspeedSetup.js'
import { connectionService }  from '../../services/connectionService.js'
import { useState } from 'react'

function CheckRow({ state, label, detail }) {
  useLocale()
  // state: 'ready' | 'missing' | 'pending' | 'notyet'
  const config = {
    ready:   { icon: '✓', color: 'var(--success)',    badge: tr("ui.8d4d4830b4da"),                   badgeBg: '#ECFDF5', badgeColor: '#059669' },
    missing: { icon: '○', color: 'var(--warn)',       badge: tr("ui.94adf462c539"),               badgeBg: '#FFFBEB', badgeColor: '#D97706' },
    pending: { icon: '○', color: 'var(--text-muted)', badge: tr("ui.4c8b7e8ff4e7"),     badgeBg: '#F9FAFB', badgeColor: '#6B7280' },
    notyet:  { icon: '○', color: 'var(--text-muted)', badge: tr("ui.d51b3551352d"),    badgeBg: '#F9FAFB', badgeColor: '#6B7280' },
  }[state] || {}

  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'10px 0', borderBottom:'1px solid var(--border)' }}>
      <span style={{ color: config.color, fontWeight:700, fontSize:15, minWidth:16, marginTop:1 }}>{config.icon}</span>
      <div style={{ flex:1 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, fontWeight:500 }}>{label}</span>
          <span style={{ fontSize:11, fontWeight:600, padding:'1px 8px', borderRadius:12, background: config.badgeBg, color: config.badgeColor }}>
            {config.badge}
          </span>
        </div>
        {detail && <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:3, lineHeight:1.5 }}>{detail}</div>}
      </div>
    </div>
  )
}

export function SetupWizard({ organizationId }) {
  useLocale()
  const { status, loading, checking, error, nextStep, checkStatus, isFullyConfigured } = useLightspeedSetup()
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const [cmdCopyMsg, setCmdCopyMsg] = useState('')

  const cliCommands = `supabase secrets set LIGHTSPEED_ENV=trial
supabase secrets set LIGHTSPEED_CLIENT_ID=deine_client_id
supabase secrets set LIGHTSPEED_CLIENT_SECRET=dein_client_secret`

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(cliCommands)
      setCmdCopyMsg(appMessage("ui.02d2f77f5936"))
      setTimeout(() => setCmdCopyMsg(''), 2000)
    } catch {
      setCmdCopyMsg(appMessage("ui.8221d544f01b"))
    }
  }

  async function copyRedirect() {
    if (!status?.redirectUri) return
    try {
      await navigator.clipboard.writeText(status.redirectUri)
      setCopyMsg(appMessage("ui.02d2f77f5936"))
      setTimeout(() => setCopyMsg(''), 2000)
    } catch {
      setCopyMsg(appMessage("ui.8221d544f01b"))
    }
  }

  async function startConnect() {
    setConnecting(true)
    setConnectError('')
    try {
      const url = await connectionService.startOAuthFlow(organizationId)
      window.location.href = url
    } catch (err) {
      setConnectError(messageParts([appMessage("ui.00feff079192"), errorMessage(err)]))
      setConnecting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ textAlign:'center', padding:'40px 0', color:'var(--text-muted)', fontSize:14 }}>{tr("ui.a1a6d095d8ba")}</div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* Fehler wenn Function nicht erreichbar */}
      {error && (
        <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:10, padding:'12px 16px', fontSize:13, color:'#DC2626' }}>
          <strong>⚠️ {localizeMessage(error)}</strong>
          <button className="btn btn-sm" style={{ marginLeft:12 }} onClick={checkStatus}>{tr("ui.7e446c35a634")}</button>
        </div>
      )}

      {/* Systemprüfung (B1) */}
      {status && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">{tr("ui.dc839361758f")}</div>
            <button className="btn btn-sm" onClick={checkStatus} disabled={checking}>
              {checking ? tr("ui.88774c7a943b") : tr("ui.7e446c35a634")}
            </button>
          </div>
          <div style={{ padding:'4px 16px 16px' }}>
            <CheckRow
              state={status.databaseReady ? 'ready' : 'missing'}
              label={tr("ui.9fc1eef69ca7")}
              detail={status.databaseReady ? tr("ui.001dde4a6497") : tr("ui.8bed897b0421")} />
            <CheckRow
              state={status.functionsReady ? 'ready' : 'missing'}
              label={tr("ui.db5e1d6bd5cf")}
              detail={status.functionsReady ? tr("ui.589f2f904643") : tr("ui.3d6eddc040a4")} />
            <CheckRow
              state={status.environmentConfigured ? 'ready' : 'missing'}
              label={tr("ui.680355da0942")}
              detail={status.environmentConfigured
                ? tr("ui.7036c5bf7cc6", { p1: (status.environment) })
                : tr("ui.d788d259c950")} />
            <CheckRow
              state={status.clientIdConfigured ? 'ready' : 'missing'}
              label={tr("ui.61b501ca2af8")}
              detail={status.clientIdConfigured
                ? tr("ui.37ddfaadfbf3")
                : tr("ui.bfaaef52495d")} />
            <CheckRow
              state={status.clientSecretConfigured ? 'ready' : 'missing'}
              label={tr("ui.04716ce66cfc")}
              detail={status.clientSecretConfigured
                ? tr("ui.d766fefd521a")
                : tr("ui.d35003bb6337")} />
            <CheckRow
              state={status.redirectUriConfigured ? 'ready' : 'missing'}
              label={tr("ui.dd6350d1b6ea")}
              detail={status.redirectUriConfigured ? tr("ui.4ab659a99916") : tr("ui.e52ad46a8b2a")} />
            <CheckRow
              state={status.oauthConnected ? 'ready' : 'pending'}
              label={tr("ui.e8be1482a656")}
              detail={status.oauthConnected ? tr("ui.e295b9a9aae4", { p1: (status.connection?.businessName || tr("ui.7e1b0d5641f2")) }) : tr("ui.b4492a0e798b")} />
            <CheckRow
              state={status.locationMapped ? 'ready' : 'notyet'}
              label={tr("ui.b3b734dce09e")}
              detail={status.locationMapped ? tr("ui.15734b6674eb") : tr("ui.0d1fc43e5645")} />
          </div>
        </div>
      )}

      {/* Redirect-URI (B4) */}
      {status?.redirectUri && (
        <div className="card">
          <div className="card-header"><div className="card-title">{tr("ui.c6ed699e394d")}</div></div>
          <div style={{ padding:16 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>{tr("ui.a86b8e57aa3a")}<strong>{tr("ui.09a4f0e923d3")}</strong>{tr("ui.c645b65970cc")}</p>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <code style={{ flex:1, background:'var(--bg-secondary)', padding:'10px 12px', borderRadius:8, fontSize:12, wordBreak:'break-all', border:'1px solid var(--border)' }}>
                {status.redirectUri}
              </code>
              <button className="btn btn-sm btn-primary" onClick={copyRedirect} style={{ whiteSpace:'nowrap' }}>
                {localizeMessage(copyMsg) || tr("ui.c68c00fc706c")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scopes (B5) */}
      {status?.scopes && (
        <div className="card">
          <div className="card-header"><div className="card-title">{tr("ui.f4118f4d1180")}</div></div>
          <div style={{ padding:16 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>{tr("ui.22a1e0e0f0ca")}</p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
              {status.scopes.map(scope => (
                <span key={scope} style={{ background:'var(--accent-light)', color:'var(--accent-text)', padding:'4px 12px', borderRadius:20, fontSize:12, fontWeight:500 }}>
                  {scope}
                </span>
              ))}
            </div>
            <div style={{ marginTop:10, fontSize:11, color:'var(--text-muted)' }}>{tr("ui.abb6d0bb5a6a")}</div>
          </div>
        </div>
      )}

      {/* Anleitung Developer Portal (B17 — ehrlich, keine falschen Automatik-Versprechen) */}
      {status && !status.oauthConnected && (
        <div style={{ background:'#EFF6FF', border:'1px solid #BFDBFE', borderRadius:12, padding:16, fontSize:13 }}>
          <div style={{ fontWeight:700, marginBottom:8, color:'#1D4ED8' }}>{tr("ui.9b32f4c70b4b")}</div>
          <ol style={{ margin:0, paddingLeft:20, color:'var(--text-secondary)', lineHeight:1.9 }}>
            <li>{tr("ui.7d2fc598bec8")}<a href="https://developer-portal.lsk-demo.app" target="_blank" rel="noopener noreferrer" style={{ color:'var(--accent)' }}>{tr("ui.2bcc3412b6f0")}</a>{tr("ui.811758d0a068")}</li>
            <li>{tr("ui.3fd4f093e513")}</li>
            <li>{tr("ui.36183aff69e9")}</li>
            <li>{tr("ui.e548e631c9dc")}</li>
            <li>{tr("ui.42dc16b9fd5e")}</li>
          </ol>
          <div style={{ marginTop:8, fontSize:12, color:'var(--text-muted)' }}>{tr("ui.7006cae9974e")}</div>
        </div>
      )}

      {/* Beispielbefehle für Supabase CLI (nur Platzhalter, keine echten Secrets) */}
      {status && !status.syncReady && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">{tr("ui.2bf4e9eae73e")}</div>
            <button className="btn btn-sm" onClick={copyCommands}>
              {localizeMessage(cmdCopyMsg) || tr("ui.7180770f81cf")}
            </button>
          </div>
          <div style={{ padding:16 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>{tr("ui.da8c6000ae30")}</p>
            <pre style={{ background:'var(--bg-secondary)', padding:'12px 14px', borderRadius:8, fontSize:12, overflow:'auto', border:'1px solid var(--border)', margin:0, lineHeight:1.7 }}>
{cliCommands}
            </pre>
            <div style={{ marginTop:10, fontSize:11, color:'var(--text-muted)' }}>{tr("ui.979fbc230756")}</div>
          </div>
        </div>
      )}

      {/* Nächster Schritt / Hauptaktion (B15) */}
      <div className="card">
        <div style={{ padding:20, textAlign:'center' }}>
          {isFullyConfigured ? (
            <div style={{ color:'var(--success)', fontSize:14, fontWeight:600 }}>{tr("ui.c034b2bef983")}</div>
          ) : (
            <>
              <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:10 }}>{tr("ui.6a224b133d01")}</div>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:16 }}>{nextStep.label}</div>
              {nextStep.key === 'connect' && (
                <button className="btn btn-primary" onClick={startConnect} disabled={connecting}>
                  {connecting ? tr("ui.6e931273af6a") : tr("ui.6ccc65eb61d7")}
                </button>
              )}
              {nextStep.key === 'credentials' && (
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.f8a998bce86d")}</div>
              )}
              {nextStep.key === 'migration' && (
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
                  <code>{tr("ui.03dabae8c214")}</code>{tr("ui.22f541c77463")}</div>
              )}
              {nextStep.key === 'environment' && (
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
                  <code>{tr("ui.4c23e51ecea1")}</code>{tr("ui.7dff38986084")}</div>
              )}
            </>
          )}
        </div>
      </div>

    </div>
  )
}
