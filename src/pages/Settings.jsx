import { t as tr, getIntlLocale, localizeMessage, message as appMessage, errorMessage, messageParts } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, Suspense, lazy } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase }      from '../lib/supabase'
import { logActivity }   from '../lib/activityLog'
import { useToast }      from '../components/UI/Toast'
import { useProfile }    from '../context/ProfileContext'
import CafeNetworkCard from '../components/CafeNetworkCard'
import BackupCard from '../components/BackupCard'
import RetentionCard from '../components/RetentionCard'

// Integration Center nur laden wenn Tab aktiv — kein unnötiger Bundle-Overhead
const IntegrationCenter = lazy(() =>
  import('../integrations/lightspeed/components/integrationCenter/IntegrationCenter.jsx')
)

export default function Settings() {
  useLocale()
  const { profile } = useProfile()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const [activeTab,  setActiveTab]  = useState(
    searchParams.get('tab') === 'integrationen' ? 'integrationen' : 'allgemein'
  )
  const [cfg,        setCfg]        = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [gpsLoading, setGpsLoading] = useState(false)
  const [msg,        setMsg]        = useState('')

  // Sprung zu einem Abschnitt, z. B. /einstellungen#datensicherung
  useEffect(() => {
    if (loading || !window.location.hash) return
    const t = setTimeout(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior:'smooth', block:'start' }), 300)
    return () => clearTimeout(t)
  }, [loading])

  useEffect(() => {
    supabase.from('cafe_settings').select('*').eq('id', 1).maybeSingle()
      .then(({ data }) => { setCfg(data || {}); setLoading(false) })
      .catch(err => { toast.error(messageParts([appMessage("ui.f1abd7e4336c"), errorMessage(err)])); setLoading(false) })
  }, [])

  function validateCoords(lat, lng) {
    const la = parseFloat(lat), lo = parseFloat(lng)
    if (isNaN(la) || la < -90 || la > 90)   return appMessage("ui.b34006b6c105")
    if (isNaN(lo) || lo < -180 || lo > 180) return appMessage("ui.7b5ff40b7d91")
    if (la < 47 || la > 55 || lo < 6 || lo > 15)
      return appMessage("ui.2785953976b3")
    return null
  }

  async function save() {
    setSaving(true); setMsg('')
    if (cfg.gps_lat && cfg.gps_lng) {
      const coordErr = validateCoords(cfg.gps_lat, cfg.gps_lng)
      if (coordErr) { setMsg(messageParts(['❌ ', coordErr])); setSaving(false); return }
    }
    const { error } = await supabase.from('cafe_settings').update({
      cafe_name:    cfg.cafe_name,
      address:      cfg.address,
      gps_lat:      cfg.gps_lat  ? parseFloat(cfg.gps_lat)  : null,
      gps_lng:      cfg.gps_lng  ? parseFloat(cfg.gps_lng)  : null,
      gps_radius_m: parseInt(cfg.gps_radius_m) || 50,
      updated_at:   new Date().toISOString(),
    }).eq('id', 1)
    setSaving(false)
    setMsg(error ? (messageParts([appMessage("ui.11f0fb59178c"), errorMessage(error)])) : (appMessage("ui.79c1106ef13d")))
    if (!error) {
      logActivity({
        action: 'settings.changed', category: 'settings',
        summary: 'hat die Café-Einstellungen geändert.',
        targetType: 'cafe_settings',
      })
    }
    setTimeout(() => setMsg(''), 4000)
  }

  // „Nur über Café-WLAN einclocken“ – wird sofort gespeichert
  async function setRequireNetwork(on) {
    const prev = !!cfg.clock_require_network
    setCfg(c => ({ ...c, clock_require_network: on }))
    const { error } = await supabase.from('cafe_settings').update({ clock_require_network: on, updated_at: new Date().toISOString() }).eq('id', 1)
    if (error) { setCfg(c => ({ ...c, clock_require_network: prev })); toast.error(appMessage("ui.e478b1785c61")); return }
    toast.success(on ? (appMessage("ui.6b04dedc762f")) : (appMessage("ui.0b01ce430bb7")))
    logActivity({ action: 'settings.changed', category: 'settings',
      summary: on ? 'hat „Nur über Café-WLAN einclocken“ eingeschaltet.' : 'hat „Nur über Café-WLAN einclocken“ ausgeschaltet.', targetType: 'cafe_settings' })
  }

  function useCurrentGPS() {
    if (!navigator.geolocation) { setMsg(appMessage("ui.289f357d6021")); return }
    setGpsLoading(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCfg(c => ({ ...c, gps_lat: pos.coords.latitude.toFixed(7), gps_lng: pos.coords.longitude.toFixed(7) }))
        setGpsLoading(false)
        setMsg(appMessage("ui.d43b5368edf4"))
        setTimeout(() => setMsg(''), 4000)
      },
      () => { setMsg(appMessage("ui.47cfc7fd5699")); setGpsLoading(false) }
    )
  }

  function f(k, v) { setCfg(c => ({ ...c, [k]: v })) }

  if (loading || !cfg) return <div style={{ padding:24 }}>{tr("ui.ebbb1d1f265f")}</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.f5750a5d7231")}</div>
        {activeTab === 'allgemein' && (
          <div className="topbar-right">
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? tr("ui.4f696a99f9c9") : tr("ui.22158eab4b10")}
            </button>
          </div>
        )}
      </div>

      <div className="content">
        {/* ── Tab-Leiste ── */}
        <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'1px solid var(--border)', paddingBottom:0 }}>
          {[
            ['allgemein',    tr("ui.11045a5a31dc")],
            ['integrationen',tr("ui.1cfb2712f61a")],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`btn btn-sm${activeTab === key ? ' btn-primary' : ''}`}
              style={{ borderRadius:'6px 6px 0 0', borderBottom:'none', marginBottom:-1 }}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Tab: Allgemein ── */}
        {activeTab === 'allgemein' && (
          <>
            {msg && (
              <div className={`alert ${localizeMessage(msg).startsWith('✅') || localizeMessage(msg).startsWith('📍') ? 'alert-success' : 'alert-danger'}`}>
                {localizeMessage(msg)}
              </div>
            )}

            <div className="two-col">
              {/* Café Info */}
              <div className="card">
                <div className="card-header"><div className="card-title">{tr("ui.7f77543c1e2e")}</div></div>
                <div className="card-body">
                  <div className="form-group">
                    <label>{tr("ui.b65ac7a41e09")}</label>
                    <input value={cfg.cafe_name || ''} onChange={e => f('cafe_name', e.target.value)} placeholder={tr("ui.3e8ae3d66b5d")} />
                  </div>
                  <div className="form-group">
                    <label>{tr("ui.79e5cf20de0b")}</label>
                    <textarea rows="3" value={cfg.address || ''} onChange={e => f('address', e.target.value)} placeholder={tr("ui.288fd718439f")} />
                  </div>
                </div>
              </div>

              {/* GPS */}
              <div className="card">
                <div className="card-header"><div className="card-title">{tr("ui.cb4431516a08")}</div></div>
                <div className="card-body">
                  <div className="alert alert-info" style={{ marginBottom:14, fontSize:12 }}>{tr("ui.3b741072d2b2")}</div>
                  <button className="btn" style={{ width:'100%', justifyContent:'center', marginBottom:12 }}
                    onClick={useCurrentGPS} disabled={gpsLoading}>
                    {gpsLoading ? tr("ui.c1db3cad529b") : tr("ui.40a2eee08820")}
                  </button>
                  <div className="two-col">
                    <div className="form-group">
                      <label>{tr("ui.08280023e451")}</label>
                      <input type="number" step="0.0000001" value={cfg.gps_lat || ''} onChange={e => f('gps_lat', e.target.value)} placeholder="50.1109221" />
                    </div>
                    <div className="form-group">
                      <label>{tr("ui.9479267b0a7c")}</label>
                      <input type="number" step="0.0000001" value={cfg.gps_lng || ''} onChange={e => f('gps_lng', e.target.value)} placeholder="8.6821267" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>{tr("ui.f430da80cd59")}<strong>{cfg.gps_radius_m || 50}{tr("ui.62c66a7a5dd7")}</strong></label>
                    <input type="range" min="10" max="300" step="5" value={cfg.gps_radius_m || 50} onChange={e => f('gps_radius_m', e.target.value)} />
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--text-muted)' }}>
                      <span>{tr("ui.6ef04fc2d275")}</span><span>{tr("ui.4c3e48ed2d09")}</span>
                    </div>
                  </div>
                  {cfg.gps_lat && cfg.gps_lng && (
                    <a href={`https://www.google.com/maps?q=${cfg.gps_lat},${cfg.gps_lng}`} target="_blank" rel="noreferrer"
                      className="btn btn-sm" style={{ width:'100%', justifyContent:'center', marginTop:4 }}>{tr("ui.b2c5069c6cbf")}</a>
                  )}
                </div>
              </div>
            </div>

            <CafeNetworkCard gpsConfigured={Boolean(cfg.gps_lat && cfg.gps_lng)} requireNetwork={!!cfg.clock_require_network} onRequireNetworkChange={setRequireNetwork}
              onNetworksChanged={() => supabase.from('cafe_settings').select('clock_require_network').eq('id', 1).maybeSingle().then(({ data }) => data && setCfg(c => ({ ...c, clock_require_network: data.clock_require_network })))} />
            <BackupCard />
            <RetentionCard />

            {/* Gesetzliche Hinweise */}
            <div className="card" style={{ marginTop:16 }}>
              <div className="card-header"><div className="card-title">{tr("ui.c3358749628a")}</div></div>
              <div className="card-body">
                <div className="three-col" style={{ gap:12 }}>
                  <div style={{ background:'var(--bg)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>{tr("ui.a6f3db0a0bdf")}</div>
                    <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>{tr("ui.9714ff08f88a")}<br />{tr("ui.25279b9b0b89")}<br />
                      <em>{tr("ui.a49eae3ee258")}</em>
                    </div>
                  </div>
                  <div style={{ background:'var(--bg)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>{tr("ui.df011e80bc5e")}</div>
                    <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>{tr("ui.683218dbe7c0")}<br />{tr("ui.b82461a076db")}</div>
                  </div>
                  <div style={{ background:'var(--bg)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>{tr("ui.f8b7a5830a9a")}</div>
                    <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>{tr("ui.3ec451a59878")}<br />{tr("ui.038e8dc90110")}</div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Tab: Integrationen ── */}
        {activeTab === 'integrationen' && (
          <Suspense fallback={
            <div style={{ textAlign:'center', padding:'40px 0', color:'var(--text-muted)', fontSize:14 }}>{tr("ui.1c51a6353365")}</div>
          }>
            <IntegrationCenter />
          </Suspense>
        )}
      </div>
    </>
  )
}
