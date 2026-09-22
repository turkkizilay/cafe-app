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
  // state: 'ready' | 'missing' | 'pending' | 'notyet'
  const config = {
    ready:   { icon: '✓', color: 'var(--success)',    badge: 'Bereit',                   badgeBg: '#ECFDF5', badgeColor: '#059669' },
    missing: { icon: '○', color: 'var(--warn)',       badge: 'Fehlt noch',               badgeBg: '#FFFBEB', badgeColor: '#D97706' },
    pending: { icon: '○', color: 'var(--text-muted)', badge: 'Noch nicht verbunden',     badgeBg: '#F9FAFB', badgeColor: '#6B7280' },
    notyet:  { icon: '○', color: 'var(--text-muted)', badge: 'Später konfigurierbar',    badgeBg: '#F9FAFB', badgeColor: '#6B7280' },
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
      setCmdCopyMsg('✓ Kopiert')
      setTimeout(() => setCmdCopyMsg(''), 2000)
    } catch {
      setCmdCopyMsg('Manuell kopieren')
    }
  }

  async function copyRedirect() {
    if (!status?.redirectUri) return
    try {
      await navigator.clipboard.writeText(status.redirectUri)
      setCopyMsg('✓ Kopiert')
      setTimeout(() => setCopyMsg(''), 2000)
    } catch {
      setCopyMsg('Manuell kopieren')
    }
  }

  async function startConnect() {
    setConnecting(true)
    setConnectError('')
    try {
      const url = await connectionService.startOAuthFlow(organizationId)
      window.location.href = url
    } catch (err) {
      setConnectError('Verbindung konnte nicht gestartet werden: ' + err.message)
      setConnecting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ textAlign:'center', padding:'40px 0', color:'var(--text-muted)', fontSize:14 }}>
        ⏳ Konfiguration wird geprüft…
      </div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* Fehler wenn Function nicht erreichbar */}
      {error && (
        <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:10, padding:'12px 16px', fontSize:13, color:'#DC2626' }}>
          <strong>⚠️ {error}</strong>
          <button className="btn btn-sm" style={{ marginLeft:12 }} onClick={checkStatus}>
            🔄 Erneut prüfen
          </button>
        </div>
      )}

      {/* Systemprüfung (B1) */}
      {status && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Systemprüfung</div>
            <button className="btn btn-sm" onClick={checkStatus} disabled={checking}>
              {checking ? '⏳ Prüft…' : '🔄 Erneut prüfen'}
            </button>
          </div>
          <div style={{ padding:'4px 16px 16px' }}>
            <CheckRow
              state={status.databaseReady ? 'ready' : 'missing'}
              label="Datenbank-Migration ausgeführt"
              detail={status.databaseReady ? 'Alle pos_* Tabellen vorhanden' : 'Bitte migration_pos_tables.sql im Supabase SQL Editor ausführen.'} />
            <CheckRow
              state={status.functionsReady ? 'ready' : 'missing'}
              label="Edge Functions erreichbar"
              detail={status.functionsReady ? 'Serverseitige Functions antworten' : 'Bitte Functions deployen: supabase functions deploy'} />
            <CheckRow
              state={status.environmentConfigured ? 'ready' : 'missing'}
              label="Lightspeed-Umgebung gesetzt"
              detail={status.environmentConfigured
                ? `Umgebung: ${status.environment}`
                : 'Lightspeed-Umgebung fehlt. Bitte setze in Supabase das Secret LIGHTSPEED_ENV auf trial oder production.'} />
            <CheckRow
              state={status.clientIdConfigured ? 'ready' : 'missing'}
              label="Client-ID hinterlegt"
              detail={status.clientIdConfigured
                ? 'In Supabase Secrets vorhanden'
                : 'Client-ID fehlt. Bitte erstelle im Lightspeed Developer Portal einen API-Client und hinterlege die Client-ID als Supabase Secret LIGHTSPEED_CLIENT_ID.'} />
            <CheckRow
              state={status.clientSecretConfigured ? 'ready' : 'missing'}
              label="Client Secret hinterlegt"
              detail={status.clientSecretConfigured
                ? 'Sicher serverseitig gespeichert'
                : 'Client Secret fehlt. Bitte hinterlege das Client Secret ausschließlich als Supabase Secret LIGHTSPEED_CLIENT_SECRET. Es darf niemals im Frontend gespeichert werden.'} />
            <CheckRow
              state={status.redirectUriConfigured ? 'ready' : 'missing'}
              label="Redirect-URI verfügbar"
              detail={status.redirectUriConfigured ? 'Aus Projekt-URL abgeleitet' : 'Supabase-Projekt-URL nicht gefunden.'} />
            <CheckRow
              state={status.oauthConnected ? 'ready' : 'pending'}
              label="OAuth-Verbindung aktiv"
              detail={status.oauthConnected ? `Verbunden: ${status.connection?.businessName || 'Account'}` : 'Wird nach dem Setzen der Zugangsdaten möglich.'} />
            <CheckRow
              state={status.locationMapped ? 'ready' : 'notyet'}
              label="Standort zugeordnet"
              detail={status.locationMapped ? 'Standort-Mapping aktiv' : 'Nach erfolgreicher Verbindung konfigurierbar.'} />
          </div>
        </div>
      )}

      {/* Redirect-URI (B4) */}
      {status?.redirectUri && (
        <div className="card">
          <div className="card-header"><div className="card-title">Redirect-URI</div></div>
          <div style={{ padding:16 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>
              Diese URL muss <strong>exakt</strong> im Lightspeed Developer Portal als Redirect-URI eingetragen werden. Schon ein fehlender Buchstabe oder ein zusätzlicher Schrägstrich kann die OAuth-Verbindung verhindern.
            </p>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <code style={{ flex:1, background:'var(--bg-secondary)', padding:'10px 12px', borderRadius:8, fontSize:12, wordBreak:'break-all', border:'1px solid var(--border)' }}>
                {status.redirectUri}
              </code>
              <button className="btn btn-sm btn-primary" onClick={copyRedirect} style={{ whiteSpace:'nowrap' }}>
                {copyMsg || '📋 Kopieren'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scopes (B5) */}
      {status?.scopes && (
        <div className="card">
          <div className="card-header"><div className="card-title">Benötigte Berechtigungen (Scopes)</div></div>
          <div style={{ padding:16 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>
              Diese Scopes müssen im Developer Portal für den API-Client freigeschaltet sein:
            </p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
              {status.scopes.map(scope => (
                <span key={scope} style={{ background:'var(--accent-light)', color:'var(--accent-text)', padding:'4px 12px', borderRadius:20, fontSize:12, fontWeight:500 }}>
                  {scope}
                </span>
              ))}
            </div>
            <div style={{ marginTop:10, fontSize:11, color:'var(--text-muted)' }}>
              Quelle: offizielle K-Series Access-Scopes-Dokumentation (verifiziert)
            </div>
          </div>
        </div>
      )}

      {/* Anleitung Developer Portal (B17 — ehrlich, keine falschen Automatik-Versprechen) */}
      {status && !status.oauthConnected && (
        <div style={{ background:'#EFF6FF', border:'1px solid #BFDBFE', borderRadius:12, padding:16, fontSize:13 }}>
          <div style={{ fontWeight:700, marginBottom:8, color:'#1D4ED8' }}>📋 Einmalige Schritte im Lightspeed Developer Portal</div>
          <ol style={{ margin:0, paddingLeft:20, color:'var(--text-secondary)', lineHeight:1.9 }}>
            <li>Bei <a href="https://developer-portal.lsk-demo.app" target="_blank" rel="noopener noreferrer" style={{ color:'var(--accent)' }}>developer-portal.lsk-demo.app</a> anmelden</li>
            <li>API-Client erstellen (Trial oder Production)</li>
            <li>Redirect-URI von oben exakt eintragen</li>
            <li>Scopes freischalten: financial-api, orders-api, staff-api, offline_access</li>
            <li>Client-ID und Client Secret als Supabase Secrets hinterlegen</li>
          </ol>
          <div style={{ marginTop:8, fontSize:12, color:'var(--text-muted)' }}>
            Café Buur kann keinen Developer Account automatisch erstellen — das erlaubt Lightspeed nur über das Portal.
          </div>
        </div>
      )}

      {/* Beispielbefehle für Supabase CLI (nur Platzhalter, keine echten Secrets) */}
      {status && !status.syncReady && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Beispielbefehle für Supabase CLI</div>
            <button className="btn btn-sm" onClick={copyCommands}>
              {cmdCopyMsg || '📋 Befehle kopieren'}
            </button>
          </div>
          <div style={{ padding:16 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>
              Diese Befehle im Terminal ausführen und die Platzhalter durch deine echten Werte aus dem Lightspeed Developer Portal ersetzen:
            </p>
            <pre style={{ background:'var(--bg-secondary)', padding:'12px 14px', borderRadius:8, fontSize:12, overflow:'auto', border:'1px solid var(--border)', margin:0, lineHeight:1.7 }}>
{cliCommands}
            </pre>
            <div style={{ marginTop:10, fontSize:11, color:'var(--text-muted)' }}>
              Die Werte werden ausschließlich serverseitig gespeichert und niemals im Browser angezeigt.
            </div>
          </div>
        </div>
      )}

      {/* Nächster Schritt / Hauptaktion (B15) */}
      <div className="card">
        <div style={{ padding:20, textAlign:'center' }}>
          {isFullyConfigured ? (
            <div style={{ color:'var(--success)', fontSize:14, fontWeight:600 }}>
              ✅ Einrichtung abgeschlossen — Lightspeed ist einsatzbereit
            </div>
          ) : (
            <>
              <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:10 }}>Nächster Schritt:</div>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:16 }}>{nextStep.label}</div>
              {nextStep.key === 'connect' && (
                <button className="btn btn-primary" onClick={startConnect} disabled={connecting}>
                  {connecting ? '⏳ Wird vorbereitet…' : '🔗 Lightspeed verbinden'}
                </button>
              )}
              {nextStep.key === 'credentials' && (
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
                  Client-ID und Secret als Supabase Secrets hinterlegen, dann „Erneut prüfen".
                </div>
              )}
              {nextStep.key === 'migration' && (
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
                  <code>migration_pos_tables.sql</code> in Supabase SQL Editor ausführen.
                </div>
              )}
              {nextStep.key === 'environment' && (
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
                  <code>LIGHTSPEED_ENV=trial</code> als Supabase Secret setzen.
                </div>
              )}
            </>
          )}
        </div>
      </div>

    </div>
  )
}
