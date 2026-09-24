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
      .catch(err => { toast.error('Fehler beim Laden: ' + err.message); setLoading(false) })
  }, [])

  function validateCoords(lat, lng) {
    const la = parseFloat(lat), lo = parseFloat(lng)
    if (isNaN(la) || la < -90 || la > 90)   return 'Breitengrad muss zwischen -90 und 90 liegen.'
    if (isNaN(lo) || lo < -180 || lo > 180) return 'Längengrad muss zwischen -180 und 180 liegen.'
    if (la < 47 || la > 55 || lo < 6 || lo > 15)
      return '⚠️ Koordinaten liegen außerhalb Deutschlands. Bitte prüfen.'
    return null
  }

  async function save() {
    setSaving(true); setMsg('')
    if (cfg.gps_lat && cfg.gps_lng) {
      const coordErr = validateCoords(cfg.gps_lat, cfg.gps_lng)
      if (coordErr) { setMsg('❌ ' + coordErr); setSaving(false); return }
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
    setMsg(error ? '❌ Fehler: ' + error.message : '✅ Einstellungen gespeichert!')
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
    if (error) { setCfg(c => ({ ...c, clock_require_network: prev })); toast.error('Speichern fehlgeschlagen. Bitte erneut versuchen.'); return }
    toast.success(on ? 'Einclocken jetzt nur noch über das Café-WLAN.' : 'Einclocken wieder per GPS oder Café-WLAN.')
    logActivity({ action: 'settings.changed', category: 'settings',
      summary: on ? 'hat „Nur über Café-WLAN einclocken“ eingeschaltet.' : 'hat „Nur über Café-WLAN einclocken“ ausgeschaltet.', targetType: 'cafe_settings' })
  }

  function useCurrentGPS() {
    if (!navigator.geolocation) { setMsg('❌ GPS nicht verfügbar auf diesem Gerät'); return }
    setGpsLoading(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCfg(c => ({ ...c, gps_lat: pos.coords.latitude.toFixed(7), gps_lng: pos.coords.longitude.toFixed(7) }))
        setGpsLoading(false)
        setMsg('📍 Aktueller Standort übernommen — bitte noch speichern!')
        setTimeout(() => setMsg(''), 4000)
      },
      () => { setMsg('❌ GPS-Zugriff verweigert. Bitte in Safari-Einstellungen → Standort erlauben.'); setGpsLoading(false) }
    )
  }

  function f(k, v) { setCfg(c => ({ ...c, [k]: v })) }

  if (loading || !cfg) return <div style={{ padding:24 }}>Lädt…</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Einstellungen</div>
        {activeTab === 'allgemein' && (
          <div className="topbar-right">
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Speichern…' : '💾 Speichern'}
            </button>
          </div>
        )}
      </div>

      <div className="content">
        {/* ── Tab-Leiste ── */}
        <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'1px solid var(--border)', paddingBottom:0 }}>
          {[
            ['allgemein',    '⚙️ Allgemein'],
            ['integrationen','🔌 Integrationen'],
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
              <div className={`alert ${msg.startsWith('✅') || msg.startsWith('📍') ? 'alert-success' : 'alert-danger'}`}>
                {msg}
              </div>
            )}

            <div className="two-col">
              {/* Café Info */}
              <div className="card">
                <div className="card-header"><div className="card-title">☕ Café Informationen</div></div>
                <div className="card-body">
                  <div className="form-group">
                    <label>Café Name</label>
                    <input value={cfg.cafe_name || ''} onChange={e => f('cafe_name', e.target.value)} placeholder="Café Buur" />
                  </div>
                  <div className="form-group">
                    <label>Adresse</label>
                    <textarea rows="3" value={cfg.address || ''} onChange={e => f('address', e.target.value)} placeholder={"Musterstraße 1\n60000 Frankfurt am Main"} />
                  </div>
                </div>
              </div>

              {/* GPS */}
              <div className="card">
                <div className="card-header"><div className="card-title">📍 GPS Einclocken</div></div>
                <div className="card-body">
                  <div className="alert alert-info" style={{ marginBottom:14, fontSize:12 }}>
                    Speichere hier die GPS-Koordinaten des Cafés. Mitarbeiter können einclocken, wenn sie im erlaubten Radius sind – oder mit dem Café-WLAN verbunden (siehe unten).
                  </div>
                  <button className="btn" style={{ width:'100%', justifyContent:'center', marginBottom:12 }}
                    onClick={useCurrentGPS} disabled={gpsLoading}>
                    {gpsLoading ? '📍 Suche Standort…' : '📍 Aktuellen Standort vom Browser übernehmen'}
                  </button>
                  <div className="two-col">
                    <div className="form-group">
                      <label>Breitengrad (Lat)</label>
                      <input type="number" step="0.0000001" value={cfg.gps_lat || ''} onChange={e => f('gps_lat', e.target.value)} placeholder="50.1109221" />
                    </div>
                    <div className="form-group">
                      <label>Längengrad (Lng)</label>
                      <input type="number" step="0.0000001" value={cfg.gps_lng || ''} onChange={e => f('gps_lng', e.target.value)} placeholder="8.6821267" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Erlaubter Radius: <strong>{cfg.gps_radius_m || 50}m</strong></label>
                    <input type="range" min="10" max="300" step="5" value={cfg.gps_radius_m || 50} onChange={e => f('gps_radius_m', e.target.value)} />
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--text-muted)' }}>
                      <span>10m</span><span>300m</span>
                    </div>
                  </div>
                  {cfg.gps_lat && cfg.gps_lng && (
                    <a href={`https://www.google.com/maps?q=${cfg.gps_lat},${cfg.gps_lng}`} target="_blank" rel="noreferrer"
                      className="btn btn-sm" style={{ width:'100%', justifyContent:'center', marginTop:4 }}>
                      🗺 Standort in Google Maps prüfen
                    </a>
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
              <div className="card-header"><div className="card-title">📋 Gesetzliche Automatismen</div></div>
              <div className="card-body">
                <div className="three-col" style={{ gap:12 }}>
                  <div style={{ background:'var(--bg)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>⏸ Pausenregelung (§4 ArbZG)</div>
                    <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>
                      Ab 6h Arbeit → 30 min Pause<br />Ab 9h Arbeit → 45 min Pause<br />
                      <em>Wird automatisch beim Ausclocken abgezogen</em>
                    </div>
                  </div>
                  <div style={{ background:'var(--bg)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>🤒 Lohnfortzahlung (§3 EFZG)</div>
                    <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>
                      6 Wochen = 42 Tage<br />Wird automatisch beim Erfassen der Krankmeldung berechnet
                    </div>
                  </div>
                  <div style={{ background:'var(--bg)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>💶 Mindestlohn</div>
                    <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>
                      Aktuell 13,90 €/Std (2026)<br />Beim Anlegen von Mitarbeitern wird gewarnt, falls der Stundenlohn darunter liegt
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Tab: Integrationen ── */}
        {activeTab === 'integrationen' && (
          <Suspense fallback={
            <div style={{ textAlign:'center', padding:'40px 0', color:'var(--text-muted)', fontSize:14 }}>
              ⏳ Integration Center wird geladen…
            </div>
          }>
            <IntegrationCenter />
          </Suspense>
        )}
      </div>
    </>
  )
}
