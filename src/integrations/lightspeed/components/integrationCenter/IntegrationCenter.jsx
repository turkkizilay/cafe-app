import { t as tr, getIntlLocale, localizeMessage } from '../../../../i18n/runtime.js'
import { useLocale } from '../../../../context/LocaleContext.jsx'
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
  connected:    { color:'#059669', bg:'#ECFDF5', get label() { return tr("ui.0338189c985e") },     icon:'●' },
  disconnected: { color:'#6B7280', bg:'#F9FAFB', get label() { return tr("ui.a0b9c89e98f8") }, icon:'○' },
  restricted:   { color:'#D97706', bg:'#FFFBEB', get label() { return tr("ui.55b60500c772") },  icon:'◐' },
  error:        { color:'#DC2626', bg:'#FEF2F2', get label() { return tr("ui.5a2aa2f909d7") },     icon:'●' },
  connecting:   { color:'#2563EB', bg:'#EFF6FF', get label() { return tr("ui.41ac5d384a06") },     icon:'◌' },
}

const SYNC_STATUS_CONFIG = {
  pending:   { color:'#6B7280', get label() { return tr("ui.0b5e85dd2508") } },
  running:   { color:'#2563EB', get label() { return tr("ui.f85fd2bc5619") } },
  success:   { color:'#059669', get label() { return tr("ui.21529bef17c8") } },
  partial:   { color:'#D97706', get label() { return tr("ui.296f1fe2c06d") } },
  failed:    { color:'#DC2626', get label() { return tr("ui.1c47a9734b27") } },
  cancelled: { color:'#6B7280', get label() { return tr("ui.b9731e79a805") } },
}

const MAPPING_STATUS_CONFIG = {
  matched:   { color:'#059669', get label() { return tr("ui.e4f19a2309ba") } },
  suggested: { color:'#2563EB', get label() { return tr("ui.9279b9456c0d") } },
  unmatched: { color:'#6B7280', get label() { return tr("ui.f135f264a410") } },
  conflict:  { color:'#DC2626', get label() { return tr("ui.a55bfc47cdfe") } },
  ignored:   { color:'#9CA3AF', get label() { return tr("ui.efe9e82d4a59") } },
}

const RESOURCE_LABELS = {
  get locations() { return tr("ui.6a478e2b52be") },
  get employees() { return tr("ui.f4cb6891b9e5") },
  get sales() { return tr("ui.34a5de0c185e") },
  get products() { return tr("ui.ff09a8b6df04") },
  get categories() { return tr("ui.055b8f9b9e50") },
  get registers() { return tr("ui.956d03f9dee8") },
}

function fmt(isoStr) {
  if (!isoStr) return '–'
  const d = new Date(isoStr)
  return d.toLocaleString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
}

export default function IntegrationCenter() {
  useLocale()
  const { profile } = useProfile()
  const isAdmin     = profile?.role === 'admin'

  // Zugriff verweigern — nicht Admin
  if (!isAdmin) {
    return (
      <div className="content" style={{ maxWidth:600, paddingTop:40 }}>
        <div className="alert alert-danger">{tr("ui.a57eacc061ab")}</div>
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
        <div className="topbar-title">{tr("ui.66dd7292074f")}</div>
        <div style={{ padding:'0 24px', fontSize:12, color:'var(--text-muted)' }}>{tr("ui.dde236bb577f")}</div>
      </div>

      <div className="content">
        {/* ── Fehler-Banner ── */}
        {ctx.error && (
          <div className="alert alert-danger" style={{ marginBottom:16, fontSize:13 }}>
            ⚠️ {localizeMessage(ctx.error)}
            <button className="btn btn-sm" style={{ marginLeft:12 }} onClick={ctx.reload}>{tr("ui.1d756ebf49e0")}</button>
          </div>
        )}

        {/* ── API-Verifikations-Hinweis ── */}
        <div style={{ background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:10, padding:'12px 16px', marginBottom:20, fontSize:13 }}>
          <strong>{tr("ui.3bdadc3e0bda")}</strong>{tr("ui.2f78f17a3ed1")}</div>

        {/* ── Status-Card ── */}
        <div className="card" style={{ marginBottom:20 }}>
          <div className="card-body" style={{ padding:20 }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ fontSize:36 }}>🏪</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:16 }}>Lightspeed K-Series</div>
                  <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>{tr("ui.55bda3cdd016")}</div>
                  {ctx.connection?.external_business_name && (
                    <div style={{ fontSize:13, marginTop:4, color:'var(--text-secondary)' }}>{tr("ui.6668c84cc43d")}<strong>{ctx.connection.external_business_name}</strong>
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
                <span>{tr("ui.fb6412e490ec")}<strong>{fmt(ctx.connection.connected_at)}</strong></span>
                <span>{tr("ui.eae413a93973")}<strong>{fmt(ctx.connection.last_health_check_at)}</strong></span>
                <span style={{ color: ctx.connection.last_health_check_status === 'ok' ? '#059669' : '#DC2626' }}>
                  {ctx.connection.last_health_check_status === 'ok' ? '✓ OK' : tr("ui.5431781607a6")}
                </span>
              </div>
            )}

            {ctx.isConnected && (
              <div style={{ display:'flex', gap:8, marginTop:16, flexWrap:'wrap' }}>
                <button className="btn" onClick={ctx.testConnection} disabled={ctx.testing}>
                  {ctx.testing ? tr("ui.f0b69359d2ce") : tr("ui.a5304b65f7f6")}
                </button>
                <button
                  className="btn"
                  style={{ color:'var(--danger)', border:'1px solid var(--danger)' }}
                  onClick={ctx.disconnect}
                >{tr("ui.ccb1d63fc5cb")}</button>
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
                ['connection', tr("ui.52c32727609a")],
                ['sync',       tr("ui.cc4ca771bb0d")],
                ['employees',  tr("ui.459f04f4a7c8")],
                ['errors',     tr("ui.51fe54f9a52f", { p1: (ctx.syncErrors.length ? ` (${ctx.syncErrors.length})` : '') })],
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
                <div className="card-header"><div className="card-title">{tr("ui.75958743a16d")}</div></div>
                <div style={{ padding:16 }}>
                  <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:16 }}>{tr("ui.c6f72c18dbe3")}</p>
                  {ctx.locationMaps.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-text">{tr("ui.9743b59f2504")}</div>
                      <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>{tr("ui.bcd5ba320a46")}</div>
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Café Buur</th><th>Lightspeed</th><th>{tr("ui.920e413c7d41")}</th></tr></thead>
                        <tbody>
                          {ctx.locationMaps.map(m => (
                            <tr key={m.id}>
                              <td><strong>{m.internal_location_name || tr("ui.16153d1d3bfc")}</strong></td>
                              <td>{m.external_location_name || m.external_location_id}</td>
                              <td>
                                <span className={`badge ${m.is_active ? 'badge-green' : 'badge-gray'}`}>
                                  {m.is_active ? tr("ui.8163454f378f") : tr("ui.bf7c9171cb49")}
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
                  <div className="card-header"><div className="card-title">{tr("ui.7bcc5489880a")}</div></div>
                  <div style={{ padding:16 }}>
                    {!ctx.hasLocationMapping && (
                      <div className="alert alert-warn" style={{ marginBottom:12 }}>{tr("ui.a29ebdc751eb")}</div>
                    )}
                    <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                      <button
                        className="btn btn-primary"
                        disabled={ctx.syncing || !ctx.hasLocationMapping || !!ctx.currentSyncJob}
                        onClick={() => ctx.triggerSync(ctx.supportedResources, 'manual')}
                      >
                        {ctx.syncing ? tr("ui.fab0f1bb729f") : tr("ui.54f7fbfa5dca")}
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
                      <div style={{ marginTop:12, padding:'10px 14px', background:'#EFF6FF', borderRadius:8, fontSize:13, color:'#1D4ED8' }}>{tr("ui.12dd8b2bb248")}{fmt(ctx.currentSyncJob.started_at)} — {ctx.currentSyncJob.resources?.join(', ')}
                      </div>
                    )}
                  </div>
                </div>

                {/* Sync-Protokoll */}
                <div className="card">
                  <div className="card-header"><div className="card-title">{tr("ui.c97331ea5cf0")}</div></div>
                  {ctx.syncJobs.length === 0 ? (
                    <div className="empty-state"><div className="empty-state-text">{tr("ui.2872a5d42095")}</div></div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr><th>{tr("ui.4cd1f51c4454")}</th><th>{tr("ui.45517c77e57e")}</th><th>{tr("ui.dcc7103e143d")}</th><th>{tr("ui.920e413c7d41")}</th><th>{tr("ui.b0f5ce1bc0f6")}</th><th>{tr("ui.668cbe316167")}</th></tr>
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
                  <div className="card-title">{tr("ui.8e32ed4a1909")}</div>
                </div>
                <div style={{ padding:'8px 16px', fontSize:12, color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{tr("ui.dd67891cc766")}</div>
                {ctx.employeeMaps.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-text">{tr("ui.b1aea9b7d007")}</div>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{tr("ui.0f5cc9dc6d37")}</th>
                          <th>{tr("ui.2482170bfcec")}</th>
                          <th>{tr("ui.920e413c7d41")}</th>
                          <th>{tr("ui.cb8d295f1603")}</th>
                          <th>{tr("ui.a4ad259e71cb")}</th>
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
                                  : <span style={{ color:'var(--text-muted)' }}>{tr("ui.f135f264a410")}</span>
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
                                {m.mapping_basis === 'email' ? tr("ui.2fae6fb30b0d") : m.mapping_basis === 'manual' ? tr("ui.961cacaa6e41") : '–'}
                              </td>
                              <td>
                                <div style={{ display:'flex', gap:4 }}>
                                  {(m.status === 'suggested' || m.status === 'unmatched' || m.status === 'conflict') && (
                                    <button
                                      className="btn btn-sm btn-primary"
                                      style={{ fontSize:11 }}
                                      onClick={() => {
                                        const id = prompt(tr("ui.36df6bed3a50"))
                                        if (id) ctx.confirmEmployeeMapping(m.id, id)
                                      }}
                                    >{tr("ui.24d2a7619446")}</button>
                                  )}
                                  {m.status === 'matched' && (
                                    <button
                                      className="btn btn-sm"
                                      style={{ fontSize:11 }}
                                      onClick={() => ctx.removeEmployeeMapping(m.id)}
                                    >{tr("ui.6d9c7731079d")}</button>
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
                <div className="card-header"><div className="card-title">{tr("ui.806d0b1f37de")}</div></div>
                {ctx.syncErrors.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-icon">✅</div>
                    <div className="empty-state-text">{tr("ui.4dc31affe8aa")}</div>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>{tr("ui.9135882d323c")}</th><th>{tr("ui.5b93c6897c0e")}</th><th>{tr("ui.f6cc01cb7edb")}</th><th>{tr("ui.1b5c331c689d")}</th></tr>
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
