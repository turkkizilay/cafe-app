import { useEffect, useState } from 'react'
import { supabase, formatDateTime } from '../lib/supabase'
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
      if (error || !data?.success) throw new Error(data?.error || 'Konnte nicht geladen werden.')
      setInfo(data)
    } catch (e) {
      setError(e.message || 'Konnte nicht geladen werden.')
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
        setModalErr('Dein Gerät nutzt gerade mobile Daten. Bitte zuerst mit dem Café-WLAN verbinden.')
        return
      }
      let pos = { lat: null, lng: null }
      if (gpsConfigured) {
        try { pos = await getPosition() }
        catch { setModalErr('Bitte erlaube den Standortzugriff – so wird geprüft, dass du wirklich im Café bist.'); return }
      }
      const { data, error } = await supabase.rpc('cafe_network_add', { p_label: label, p_lat: pos.lat, p_lng: pos.lng })
      if (error || !data?.success) { setModalErr(data?.error || 'Speichern fehlgeschlagen. Bitte erneut versuchen.'); return }
      toast.success(data.already ? 'Diese Verbindung war schon gespeichert.' : '✅ Café-WLAN gespeichert')
      setModal(false)
      await load()
    } catch {
      setModalErr('Keine Verbindung. Bitte erneut versuchen.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy || !removeItem) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('cafe_network_remove', { p_id: removeItem.id })
      if (error || !data?.success) { toast.error(data?.error || 'Entfernen fehlgeschlagen.'); return }
      toast.success('Eintrag entfernt')
      setRemoveItem(null)
      await load()
      onNetworksChanged?.()
    } catch {
      toast.error('Keine Verbindung. Bitte erneut versuchen.')
    } finally {
      setBusy(false)
    }
  }

  const nets = info?.networks || []
  const now = Date.now()

  return (
    <div className="card" style={{ marginTop:16 }}>
      <div className="card-header"><div className="card-title">📶 Einclocken per Café-WLAN</div></div>
      <div className="card-body">
        <div className="alert alert-info" style={{ fontSize:12.5, lineHeight:1.6, marginBottom:14 }}>
          Mitarbeiter können einclocken, wenn sie <strong>im GPS-Radius</strong> sind <strong>oder</strong> mit dem
          <strong> Café-WLAN</strong> verbunden sind. Dafür einmal im Café mit dem WLAN verbinden und unten auf
          „Diese Verbindung speichern“ tippen.
        </div>

        {loading && <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Lädt…</div>}
        {!loading && error && (
          <div className="alert alert-danger" style={{ fontSize:13 }}>
            {error} <button className="btn btn-sm" style={{ marginLeft:8 }} onClick={load}>Erneut versuchen</button>
          </div>
        )}

        {!loading && info && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', padding:'10px 12px', background:'var(--bg)', borderRadius:10, marginBottom:14 }}>
              <div style={{ flex:1, minWidth:200, fontSize:13 }}>
                <div style={{ fontWeight:600 }}>Deine aktuelle Verbindung</div>
                <div style={{ color:'var(--text-secondary)', marginTop:2 }}>
                  {info.matched ? '✅ Ist als Café-WLAN gespeichert' : '⚪ Nicht als Café-WLAN gespeichert'}
                  {info.current_ip && <span style={{ color:'var(--text-muted)' }}> · {info.is_ipv6 ? 'IPv6' : 'IPv4'} {info.current_ip}</span>}
                </div>
              </div>
              {!info.matched && (
                <button className="btn btn-primary" onClick={openModal} disabled={!info.current_ip}>📶 Diese Verbindung speichern</button>
              )}
              <button className="btn btn-sm" onClick={load}>🔄</button>
            </div>

            {nets.length === 0
              ? <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Noch kein Café-WLAN gespeichert — Einclocken geht aktuell nur per GPS.</div>
              : <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {nets.map(n => {
                    const last = n.last_seen_at ? new Date(n.last_seen_at).getTime() : null
                    const stale = !last || (now - last) > STALE_DAYS * 86400000
                    return (
                      <div key={n.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--border)', borderRadius:10, flexWrap:'wrap' }}>
                        <div style={{ flex:1, minWidth:180 }}>
                          <div style={{ fontWeight:600, fontSize:13.5 }}>{n.label}</div>
                          <div style={{ fontSize:12, color:'var(--text-muted)' }}>
                            {n.cidr.includes(':') ? 'IPv6' : 'IPv4'} · zuletzt genutzt: {last ? `${formatDateTime(n.last_seen_at)} Uhr` : 'noch nie'}
                          </div>
                          {stale && (
                            <div style={{ fontSize:12, color:'var(--warn)', marginTop:2 }}>
                              ⚠️ Seit über {STALE_DAYS} Tagen nicht genutzt — evtl. hat der Router eine neue Adresse. Im Café einfach neu speichern.
                            </div>
                          )}
                        </div>
                        <button className="btn btn-sm" onClick={() => setRemoveItem(n)}>Entfernen</button>
                      </div>
                    )
                  })}
                </div>
            }

            {nets.length > 0 && onRequireNetworkChange && (
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', marginTop:14, fontSize:13.5, cursor:'pointer', padding:'10px 12px', border:'1px solid var(--border)', borderRadius:10 }}>
                <input type="checkbox" checked={requireNetwork} onChange={e => onRequireNetworkChange(e.target.checked)} style={{ marginTop:3 }} />
                <span>
                  <strong>Nur über Café-WLAN einclocken</strong> (GPS nicht mehr akzeptieren)
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>
                    Sicherer: Den GPS-Standort sendet das Handy selbst – technisch versierte Personen können ihn fälschen. Die WLAN-Prüfung macht der Server.
                    Nur einschalten, wenn das WLAN bei allen zuverlässig erkannt wird.
                  </div>
                </span>
              </label>
            )}

            <details style={{ marginTop:14, fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6 }}>
              <summary style={{ cursor:'pointer', fontWeight:600 }}>Gut zu wissen</summary>
              <ul style={{ margin:'8px 0 0 18px', padding:0 }}>
                <li>Gespeichert wird die Internet-Adresse des Café-Routers, nicht der WLAN-Name (den kann kein Browser lesen).</li>
                <li>Startet der Router neu, kann sich die Adresse ändern. Dann klappt Einclocken weiter per GPS — hier einfach neu speichern.</li>
                <li>Wird ein iPhone im Café-WLAN nicht erkannt: Einstellungen → WLAN → (i) beim Café-WLAN → „iCloud Privat-Relay“ ausschalten. Auch ein aktives VPN verhindert die Erkennung.</li>
                <li>Die Internet-Adressen der Mitarbeiter werden nicht gespeichert — nur ob per GPS oder WLAN eingeclockt wurde.</li>
              </ul>
            </details>
          </>
        )}
      </div>

      {modal && (
        <div className="modal-overlay" onClick={() => !busy && setModal(false)}>
          <div className="modal" style={{ maxWidth:440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">📶 Café-WLAN speichern</div><button className="btn btn-sm" onClick={() => setModal(false)} disabled={busy}>✕</button></div>
            <div className="modal-body">
              <div className="form-group">
                <label>Bezeichnung</label>
                <input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} placeholder="Café-WLAN" />
              </div>
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13.5, marginBottom:10, cursor:'pointer' }}>
                <input type="checkbox" checked={check1} onChange={e => setCheck1(e.target.checked)} style={{ marginTop:3 }} />
                <span>Ich bin gerade <strong>im Café</strong>.</span>
              </label>
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13.5, cursor:'pointer' }}>
                <input type="checkbox" checked={check2} onChange={e => setCheck2(e.target.checked)} style={{ marginTop:3 }} />
                <span>Mein Gerät ist mit dem <strong>Café-WLAN</strong> verbunden – nicht mobile Daten, kein VPN, iCloud Privat-Relay aus (sonst würde eine fremde Adresse gespeichert).</span>
              </label>
              {gpsConfigured && <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:10 }}>Zur Sicherheit wird dein Standort einmal geprüft.</div>}
              {modalErr && <div role="alert" className="alert alert-danger" style={{ fontSize:13, marginTop:12 }}>{modalErr}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(false)} disabled={busy}>Abbrechen</button>
              <button className="btn btn-primary" onClick={save} disabled={busy || !check1 || !check2}>{busy ? 'Wird geprüft …' : 'Speichern'}</button>
            </div>
          </div>
        </div>
      )}

      {removeItem && (
        <div className="modal-overlay" onClick={() => !busy && setRemoveItem(null)}>
          <div className="modal" style={{ maxWidth:400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">Eintrag entfernen</div><button className="btn btn-sm" onClick={() => setRemoveItem(null)} disabled={busy}>✕</button></div>
            <div className="modal-body" style={{ fontSize:13.5 }}>
              „{removeItem.label}“ entfernen? Über diese Verbindung kann dann nicht mehr per WLAN eingeclockt werden (GPS geht weiterhin).
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setRemoveItem(null)} disabled={busy}>Abbrechen</button>
              <button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? '…' : 'Entfernen'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
