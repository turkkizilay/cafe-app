/**
 * Lightspeed Integration Center — Admin-Seite
 *
 * Route: /einstellungen/integrationen/lightspeed
 * Zugang: Nur Admin
 *
 * Tabs: Verbindung | Synchronisation | Mitarbeiterzuordnung | Fehlerprotokoll
 */

import { useIntegrationCenter }  from '../../hooks/useIntegrationCenter.js'
import { useProfile }            from '../../../../context/ProfileContext.jsx'
import { formatDate, formatTime } from '../../../../lib/supabase.js'
import { SetupWizard }           from './SetupWizard.jsx'

const STATUS_CONFIG = {
  connected:    { color:'#059669', bg:'#ECFDF5', label:'Verbunden',     icon:'●' },
  disconnected: { color:'#6B7280', bg:'#F9FAFB', label:'Nicht verbunden', icon:'○' },
  restricted:   { color:'#D97706', bg:'#FFFBEB', label:'Eingeschränkt',  icon:'◐' },
  error:        { color:'#DC2626', bg:'#FEF2F2', label:'Fehlerhaft',     icon:'●' },
  connecting:   { color:'#2563EB', bg:'#EFF6FF', label:'Verbindet…',     icon:'◌' },
}

const SYNC_STATUS_CONFIG = {
  pending:   { color:'#6B7280', label:'Ausstehend' },
  running:   { color:'#2563EB', label:'Läuft' },
  success:   { color:'#059669', label:'Erfolgreich' },
  partial:   { color:'#D97706', label:'Teilweise' },
  failed:    { color:'#DC2626', label:'Fehlgeschlagen' },
  cancelled: { color:'#6B7280', label:'Abgebrochen' },
}

const MAPPING_STATUS_CONFIG = {
  matched:   { color:'#059669', label:'Zugeordnet' },
  suggested: { color:'#2563EB', label:'Vorschlag' },
  unmatched: { color:'#6B7280', label:'Nicht zugeordnet' },
  conflict:  { color:'#DC2626', label:'Konflikt' },
  ignored:   { color:'#9CA3AF', label:'Ignoriert' },
}

const RESOURCE_LABELS = {
  locations:  'Standorte',
  employees:  'Mitarbeiter',
  sales:      'Umsätze',
  products:   'Produkte',
  categories: 'Kategorien',
  registers:  'Kassen',
}

function fmt(isoStr) {
  if (!isoStr) return '–'
  const d = new Date(isoStr)
  return d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
}

export default function IntegrationCenter() {
  const { profile } = useProfile()
  const isAdmin     = profile?.role === 'admin'

  // Zugriff verweigern — nicht Admin
  if (!isAdmin) {
    return (
      <div className="content" style={{ maxWidth:600, paddingTop:40 }}>
        <div className="alert alert-danger">
          ⛔ Nur Administratoren können die Lightspeed-Integration verwalten.
        </div>
      </div>
    )
  }

  const ctx = useIntegrationCenter(
    'cafe-buur',       // organizationId — aus Einstellungen oder Konstante
    profile?.id,
  )

  const connectionStatus = ctx.connection?.status || 'disconnected'
  const statusCfg        = STATUS_CONFIG[connectionStatus] || STATUS_CONFIG.disconnected

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Lightspeed Integration Center</div>
        <div style={{ padding:'0 24px', fontSize:12, color:'var(--text-muted)' }}>
          K-Series Restaurant · Nur Admin
        </div>
      </div>

      <div className="content">
        {/* ── Fehler-Banner ── */}
        {ctx.error && (
          <div className="alert alert-danger" style={{ marginBottom:16, fontSize:13 }}>
            ⚠️ {ctx.error}
            <button className="btn btn-sm" style={{ marginLeft:12 }} onClick={ctx.reload}>
              🔄 Erneut laden
            </button>
          </div>
        )}

        {/* ── API-Verifikations-Hinweis ── */}
        <div style={{ background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:10, padding:'12px 16px', marginBottom:20, fontSize:13 }}>
          <strong>ℹ️ Hinweis:</strong> Die genauen K-Series API-Endpunkte für die Synchronisation werden nach der OAuth-Verbindung anhand der offiziellen Dokumentation aktiviert.
        </div>

        {/* ── Status-Card ── */}
        <div className="card" style={{ marginBottom:20 }}>
          <div className="card-body" style={{ padding:20 }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ fontSize:36 }}>🏪</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:16 }}>Lightspeed K-Series</div>
                  <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Restaurant POS Integration</div>
                  {ctx.connection?.external_business_name && (
                    <div style={{ fontSize:13, marginTop:4, color:'var(--text-secondary)' }}>
                      Account: <strong>{ctx.connection.external_business_name}</strong>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ padding:'5px 14px', borderRadius:20, fontSize:12, fontWeight:600, background:statusCfg.bg, color:statusCfg.color }}>
                  {statusCfg.icon} {statusCfg.label}
                </div>
              </div>
            </div>

            {ctx.connection && (
              <div style={{ marginTop:16, display:'flex', gap:24, fontSize:12, color:'var(--text-muted)', flexWrap:'wrap' }}>
                <span>Verbunden seit: <strong>{fmt(ctx.connection.connected_at)}</strong></span>
                <span>Letzter Health-Check: <strong>{fmt(ctx.connection.last_health_check_at)}</strong></span>
                <span style={{ color: ctx.connection.last_health_check_status === 'ok' ? '#059669' : '#DC2626' }}>
                  {ctx.connection.last_health_check_status === 'ok' ? '✓ OK' : '✗ Fehlerhaft'}
                </span>
              </div>
            )}

            {ctx.isConnected && (
              <div style={{ display:'flex', gap:8, marginTop:16, flexWrap:'wrap' }}>
                <button className="btn" onClick={ctx.testConnection} disabled={ctx.testing}>
                  {ctx.testing ? '⏳ Teste…' : '🔌 Verbindung testen'}
                </button>
                <button
                  className="btn"
                  style={{ color:'var(--danger)', border:'1px solid var(--danger)' }}
                  onClick={ctx.disconnect}
                >
                  🔌 Verbindung trennen
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Einrichtungsassistent wenn noch nicht verbunden ── */}
        {!ctx.isConnected && (
          <SetupWizard organizationId="cafe-buur" />
        )}

        {/* ── Tabs (nur wenn verbunden) ── */}
        {ctx.isConnected && (
          <>
            <div style={{ display:'flex', gap:4, marginBottom:16, borderBottom:'1px solid var(--border)', paddingBottom:0 }}>
              {[
                ['connection', '⚙️ Verbindung'],
                ['sync',       '🔄 Synchronisation'],
                ['employees',  '👥 Mitarbeiterzuordnung'],
                ['errors',     `❌ Fehler${ctx.syncErrors.length ? ` (${ctx.syncErrors.length})` : ''}`],
              ].map(([key, label]) => (
                <button key={key}
                  className={`btn btn-sm${ctx.activeTab === key ? ' btn-primary' : ''}`}
                  style={{ borderRadius:'6px 6px 0 0', borderBottom:'none', marginBottom:-1 }}
                  onClick={() => ctx.setActiveTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── Tab: Verbindung / Standorte ── */}
            {ctx.activeTab === 'connection' && (
              <div className="card">
                <div className="card-header"><div className="card-title">Standort-Zuordnung</div></div>
                <div style={{ padding:16 }}>
                  <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:16 }}>
                    Ordne einen Lightspeed-Standort dem Café Buur zu. Nur zugeordnete Standorte werden synchronisiert.
                  </p>
                  {ctx.locationMaps.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-text">Noch keine Standort-Zuordnung konfiguriert.</div>
                      <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>
                        Nach der ersten Synchronisation (Ressource: Standorte) können Standorte hier zugeordnet werden.
                      </div>
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Café Buur</th><th>Lightspeed</th><th>Status</th></tr></thead>
                        <tbody>
                          {ctx.locationMaps.map(m => (
                            <tr key={m.id}>
                              <td><strong>{m.internal_location_name || 'Café Buur Frankfurt'}</strong></td>
                              <td>{m.external_location_name || m.external_location_id}</td>
                              <td>
                                <span className={`badge ${m.is_active ? 'badge-green' : 'badge-gray'}`}>
                                  {m.is_active ? 'Aktiv' : 'Inaktiv'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Synchronisation ── */}
            {ctx.activeTab === 'sync' && (
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                {/* Sync starten */}
                <div className="card">
                  <div className="card-header"><div className="card-title">Manuelle Synchronisation</div></div>
                  <div style={{ padding:16 }}>
                    {!ctx.hasLocationMapping && (
                      <div className="alert alert-warn" style={{ marginBottom:12 }}>
                        ⚠️ Bitte zuerst einen Standort zuordnen (Tab: Verbindung).
                      </div>
                    )}
                    <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                      <button
                        className="btn btn-primary"
                        disabled={ctx.syncing || !ctx.hasLocationMapping || !!ctx.currentSyncJob}
                        onClick={() => ctx.triggerSync(ctx.supportedResources, 'manual')}
                      >
                        {ctx.syncing ? '⏳ Sync läuft…' : '🔄 Alle Ressourcen synchronisieren'}
                      </button>
                      {ctx.supportedResources.map(resource => (
                        <button
                          key={resource}
                          className="btn btn-sm"
                          disabled={ctx.syncing || !ctx.hasLocationMapping || !!ctx.currentSyncJob}
                          onClick={() => ctx.triggerSync([resource], 'manual')}
                        >
                          {RESOURCE_LABELS[resource] || resource}
                        </button>
                      ))}
                    </div>
                    {ctx.currentSyncJob && (
                      <div style={{ marginTop:12, padding:'10px 14px', background:'#EFF6FF', borderRadius:8, fontSize:13, color:'#1D4ED8' }}>
                        🔄 Sync läuft seit {fmt(ctx.currentSyncJob.started_at)} — {ctx.currentSyncJob.resources?.join(', ')}
                      </div>
                    )}
                  </div>
                </div>

                {/* Sync-Protokoll */}
                <div className="card">
                  <div className="card-header"><div className="card-title">Sync-Verlauf</div></div>
                  {ctx.syncJobs.length === 0 ? (
                    <div className="empty-state"><div className="empty-state-text">Noch keine Synchronisation durchgeführt.</div></div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr><th>Gestartet</th><th>Modus</th><th>Ressourcen</th><th>Status</th><th>Datensätze</th><th>Dauer</th></tr>
                        </thead>
                        <tbody>
                          {ctx.syncJobs.map(job => {
                            const sc = SYNC_STATUS_CONFIG[job.status] || {}
                            const dur = job.completed_at
                              ? Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000)
                              : null
                            return (
                              <tr key={job.id}>
                                <td style={{ fontSize:12 }}>{fmt(job.started_at)}</td>
                                <td style={{ fontSize:12 }}>{job.sync_mode}</td>
                                <td style={{ fontSize:12 }}>{(job.resources || []).map(r => RESOURCE_LABELS[r] || r).join(', ')}</td>
                                <td>
                                  <span style={{ color:sc.color, fontSize:12, fontWeight:600 }}>
                                    {job.status === 'running' ? '⏳ ' : ''}{sc.label}
                                  </span>
                                </td>
                                <td style={{ fontSize:12 }}>{job.records_total ?? '–'}</td>
                                <td style={{ fontSize:12 }}>{dur != null ? `${dur}s` : '–'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Mitarbeiterzuordnung ── */}
            {ctx.activeTab === 'employees' && (
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Mitarbeiterzuordnung</div>
                </div>
                <div style={{ padding:'8px 16px', fontSize:12, color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>
                  Automatische Zuordnung erfolgt nur über E-Mail. Bei Konflikten ist manuelle Zuordnung erforderlich.
                  Lightspeed-Daten überschreiben niemals HR-Daten in der Café-Buur-App.
                </div>
                {ctx.employeeMaps.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-text">
                      Keine Mitarbeiter-Daten. Bitte zuerst Mitarbeiter synchronisieren.
                    </div>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Café Buur Mitarbeiter</th>
                          <th>Lightspeed Mitarbeiter</th>
                          <th>Status</th>
                          <th>Basis</th>
                          <th>Aktion</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ctx.employeeMaps.map(m => {
                          const sc = MAPPING_STATUS_CONFIG[m.status] || {}
                          return (
                            <tr key={m.id}>
                              <td>
                                {m.employees
                                  ? `${m.employees.first_name} ${m.employees.last_name}`
                                  : <span style={{ color:'var(--text-muted)' }}>Nicht zugeordnet</span>
                                }
                              </td>
                              <td>
                                <div style={{ fontSize:13 }}>{m.external_employee_name || '–'}</div>
                                {m.external_employee_email && (
                                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{m.external_employee_email}</div>
                                )}
                              </td>
                              <td>
                                <span style={{ color:sc.color, fontSize:12, fontWeight:600 }}>{sc.label}</span>
                              </td>
                              <td style={{ fontSize:12, color:'var(--text-muted)' }}>
                                {m.mapping_basis === 'email' ? 'E-Mail' : m.mapping_basis === 'manual' ? 'Manuell' : '–'}
                              </td>
                              <td>
                                <div style={{ display:'flex', gap:4 }}>
                                  {(m.status === 'suggested' || m.status === 'unmatched' || m.status === 'conflict') && (
                                    <button
                                      className="btn btn-sm btn-primary"
                                      style={{ fontSize:11 }}
                                      onClick={() => {
                                        const id = prompt('Interne Mitarbeiter-ID (aus Mitarbeiterverwaltung):')
                                        if (id) ctx.confirmEmployeeMapping(m.id, id)
                                      }}
                                    >
                                      Zuordnen
                                    </button>
                                  )}
                                  {m.status === 'matched' && (
                                    <button
                                      className="btn btn-sm"
                                      style={{ fontSize:11 }}
                                      onClick={() => ctx.removeEmployeeMapping(m.id)}
                                    >
                                      Aufheben
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── Tab: Fehlerprotokoll ── */}
            {ctx.activeTab === 'errors' && (
              <div className="card">
                <div className="card-header"><div className="card-title">Fehlerprotokoll</div></div>
                {ctx.syncErrors.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-icon">✅</div>
                    <div className="empty-state-text">Keine offenen Synchronisationsfehler.</div>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Datum</th><th>Ressource</th><th>Fehler</th><th>Meldung</th></tr>
                      </thead>
                      <tbody>
                        {ctx.syncErrors.map(err => (
                          <tr key={err.id}>
                            <td style={{ fontSize:12 }}>{fmt(err.created_at)}</td>
                            <td style={{ fontSize:12 }}>{RESOURCE_LABELS[err.resource] || err.resource}</td>
                            <td>
                              <span style={{ fontSize:11, background:'#FEF2F2', color:'#DC2626', padding:'2px 6px', borderRadius:4 }}>
                                {err.error_code}
                              </span>
                            </td>
                            <td style={{ fontSize:12, color:'var(--text-secondary)' }}>{err.error_message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
