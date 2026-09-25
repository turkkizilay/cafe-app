import { t as tr, getIntlLocale, localizeMessage, message as appMessage, messageError, errorMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDateTime } from '../i18n/format.js'
import { useToast } from './UI/Toast'

/**
 * Admin: Café-WLAN fürs Einclocken.
 * Browser können den WLAN-Namen nicht lesen – gespeichert wird die öffentliche
 * Internet-Adresse des Café-Routers. Die Prüfung passiert serverseitig
 * (siehe Migration 09_clockin_gps_or_network).
 */
const STALE_DAYS = 14

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('unavailable')); return }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  })
}

export default function CafeNetworkCard({ gpsConfigured, requireNetwork = false, onRequireNetworkChange, onNetworksChanged }) {
  useLocale()
  const toast = useToast()
  const [info, setInfo]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [modal, setModal]     = useState(false)
  const [label, setLabel]     = useState('Café-WLAN')
  const [check1, setCheck1]   = useState(false)
  const [check2, setCheck2]   = useState(false)
  const [busy, setBusy]       = useState(false)
  const [modalErr, setModalErr] = useState('')
  const [removeItem, setRemoveItem] = useState(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const { data, error } = await supabase.rpc('cafe_network_info')
      if (error || !data?.success) throw messageError((data?.error || appMessage("ui.a7293b48321a")))
      setInfo(data)
    } catch (e) {
      setError((errorMessage(e) || appMessage("ui.a7293b48321a")))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function openModal() {
    setLabel(info?.networks?.length ? `Café-WLAN ${info.networks.length + 1}` : 'Café-WLAN')
    setCheck1(false); setCheck2(false); setModalErr(''); setModal(true)
  }

  async function save() {
    if (busy || !check1 || !check2) return
    setBusy(true); setModalErr('')
    try {
      // Android/Chrome verrät, ob mobile Daten genutzt werden – dann niemals speichern
      const conn = navigator.connection
      if (conn && conn.type === 'cellular') {
        setModalErr(appMessage("ui.44b0e143f81e"))
        return
      }
      let pos = { lat: null, lng: null }
      if (gpsConfigured) {
        try { pos = await getPosition() }
        catch { setModalErr(appMessage("ui.80bbd1e5f3d9")); return }
      }
      const { data, error } = await supabase.rpc('cafe_network_add', { p_label: label, p_lat: pos.lat, p_lng: pos.lng })
      if (error || !data?.success) { setModalErr((data?.error || appMessage("ui.e478b1785c61"))); return }
      toast.success(data.already ? (appMessage("ui.f06721a445d2")) : (appMessage("ui.c1b2a8f04c22")))
      setModal(false)
      await load()
    } catch {
      setModalErr(appMessage("ui.2853bd7844a9"))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy || !removeItem) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('cafe_network_remove', { p_id: removeItem.id })
      if (error || !data?.success) { toast.error((data?.error || appMessage("ui.8987f1047a06"))); return }
      toast.success(appMessage("ui.987b0368c0ba"))
      setRemoveItem(null)
      await load()
      onNetworksChanged?.()
    } catch {
      toast.error(appMessage("ui.2853bd7844a9"))
    } finally {
      setBusy(false)
    }
  }

  const nets = info?.networks || []
  const now = Date.now()

  return (
    <div className="card" style={{ marginTop:16 }}>
      <div className="card-header"><div className="card-title">{tr("ui.5ab319f2879c")}</div></div>
      <div className="card-body">
        <div className="alert alert-info" style={{ fontSize:12.5, lineHeight:1.6, marginBottom:14 }}>{tr("ui.cdb61ff74389")}<strong>{tr("ui.469bc689e9f1")}</strong>{tr("ui.6245e0326da7")}<strong>{tr("ui.b81d9593a3f6")}</strong>{tr("ui.f234afad3b20")}<strong>{tr("ui.22b79678e777")}</strong>{tr("ui.35905aa01d67")}</div>

        {loading && <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.ebbb1d1f265f")}</div>}
        {!loading && error && (
          <div className="alert alert-danger" style={{ fontSize:13 }}>
            {localizeMessage(error)} <button className="btn btn-sm" style={{ marginLeft:8 }} onClick={load}>{tr("ui.948643cb59e8")}</button>
          </div>
        )}

        {!loading && info && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', padding:'10px 12px', background:'var(--bg)', borderRadius:10, marginBottom:14 }}>
              <div style={{ flex:1, minWidth:200, fontSize:13 }}>
                <div style={{ fontWeight:600 }}>{tr("ui.3bdb1f88519a")}</div>
                <div style={{ color:'var(--text-secondary)', marginTop:2 }}>
                  {info.matched ? tr("ui.cbf47bdb7616") : tr("ui.3eeb9fa4b777")}
                  {info.current_ip && <span style={{ color:'var(--text-muted)' }}> · {info.is_ipv6 ? 'IPv6' : 'IPv4'} {info.current_ip}</span>}
                </div>
              </div>
              {!info.matched && (
                <button className="btn btn-primary" onClick={openModal} disabled={!info.current_ip}>{tr("ui.9611736aef1b")}</button>
              )}
              <button className="btn btn-sm" onClick={load}>🔄</button>
            </div>

            {nets.length === 0
              ? <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.5037e62ccda1")}</div>
              : <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {nets.map(n => {
                    const last = n.last_seen_at ? new Date(n.last_seen_at).getTime() : null
                    const stale = !last || (now - last) > STALE_DAYS * 86400000
                    return (
                      <div key={n.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--border)', borderRadius:10, flexWrap:'wrap' }}>
                        <div style={{ flex:1, minWidth:180 }}>
                          <div style={{ fontWeight:600, fontSize:13.5 }}>{n.label}</div>
                          <div style={{ fontSize:12, color:'var(--text-muted)' }}>
                            {n.cidr.includes(':') ? 'IPv6' : 'IPv4'}{tr("ui.b65031ca01c5")}{last ? tr("ui.385d719a70fb", { p1: (formatDateTime(n.last_seen_at)) }) : tr("ui.2f3ec7cf77c6")}
                          </div>
                          {stale && (
                            <div style={{ fontSize:12, color:'var(--warn)', marginTop:2 }}>{tr("ui.ebe04ff7a755")}{STALE_DAYS}{tr("ui.70c187e756b5")}</div>
                          )}
                        </div>
                        <button className="btn btn-sm" onClick={() => setRemoveItem(n)}>{tr("ui.3828375a2d45")}</button>
                      </div>
                    )
                  })}
                </div>
            }

            {nets.length > 0 && onRequireNetworkChange && (
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', marginTop:14, fontSize:13.5, cursor:'pointer', padding:'10px 12px', border:'1px solid var(--border)', borderRadius:10 }}>
                <input type="checkbox" checked={requireNetwork} onChange={e => onRequireNetworkChange(e.target.checked)} style={{ marginTop:3 }} />
                <span>
                  <strong>{tr("ui.8f84cf86e0fa")}</strong>{tr("ui.3b0a307196d1")}<div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{tr("ui.65e776b20ccb")}</div>
                </span>
              </label>
            )}

            <details style={{ marginTop:14, fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6 }}>
              <summary style={{ cursor:'pointer', fontWeight:600 }}>{tr("ui.bf80815c3081")}</summary>
              <ul style={{ margin:'8px 0 0 18px', padding:0 }}>
                <li>{tr("ui.388574d13979")}</li>
                <li>{tr("ui.7c63524be70a")}</li>
                <li>{tr("ui.af3271e26ea4")}</li>
                <li>{tr("ui.011f50741243")}</li>
              </ul>
            </details>
          </>
        )}
      </div>

      {modal && (
        <div className="modal-overlay" onClick={() => !busy && setModal(false)}>
          <div className="modal" style={{ maxWidth:440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">{tr("ui.27b1de1cdc7e")}</div><button className="btn btn-sm" onClick={() => setModal(false)} disabled={busy}>✕</button></div>
            <div className="modal-body">
              <div className="form-group">
                <label>{tr("ui.97d1e68526b8")}</label>
                <input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} placeholder={tr("ui.415e8f8d56e9")} />
              </div>
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13.5, marginBottom:10, cursor:'pointer' }}>
                <input type="checkbox" checked={check1} onChange={e => setCheck1(e.target.checked)} style={{ marginTop:3 }} />
                <span>{tr("ui.45d087756143")}<strong>{tr("ui.adc4fe9bceb1")}</strong>.</span>
              </label>
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13.5, cursor:'pointer' }}>
                <input type="checkbox" checked={check2} onChange={e => setCheck2(e.target.checked)} style={{ marginTop:3 }} />
                <span>{tr("ui.447c57857b3a")}<strong>{tr("ui.415e8f8d56e9")}</strong>{tr("ui.860b23bac129")}</span>
              </label>
              {gpsConfigured && <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:10 }}>{tr("ui.6129df4797fa")}</div>}
              {modalErr && <div role="alert" className="alert alert-danger" style={{ fontSize:13, marginTop:12 }}>{localizeMessage(modalErr)}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(false)} disabled={busy}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-primary" onClick={save} disabled={busy || !check1 || !check2}>{busy ? tr("ui.49023282641c") : tr("ui.f6b2ff39f540")}</button>
            </div>
          </div>
        </div>
      )}

      {removeItem && (
        <div className="modal-overlay" onClick={() => !busy && setRemoveItem(null)}>
          <div className="modal" style={{ maxWidth:400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">{tr("ui.706a152ebfca")}</div><button className="btn btn-sm" onClick={() => setRemoveItem(null)} disabled={busy}>✕</button></div>
            <div className="modal-body" style={{ fontSize:13.5 }}>
              „{removeItem.label}{tr("ui.05b0b5265561")}</div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setRemoveItem(null)} disabled={busy}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? '…' : tr("ui.3828375a2d45")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
