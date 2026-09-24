import { useState, useEffect } from 'react'
import { supabase, formatTime, getDistanceMeters } from '../lib/supabase'
import { translateSupabaseError } from '../lib/errorHelper'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'

export default function ClockIn({ session }) {
  const { profile }           = useProfile()
  const toast                 = useToast()
  const [tick, setTick]       = useState(new Date())
  const [employee, setEmp]    = useState(null)
  const [cafe, setCafe]       = useState(null)
  const [gps, setGps]         = useState({ status: 'checking' })
  const [net, setNet]         = useState({ status: 'checking' })   // Café-WLAN (serverseitig geprüft)
  const [openEntry, setOpen]  = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [working,  setWorking]  = useState(false)
  const [restWarn, setRestWarn] = useState(null)  // Stunden seit letztem Clockout

  useEffect(() => {
    const t = setInterval(() => setTick(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => { fetchData() }, [profile?.employee_id])

  // Nach WLAN-Wechsel / Rückkehr in die App automatisch neu prüfen
  useEffect(() => {
    function recheck() { if (document.visibilityState === 'visible') checkNetwork() }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('online', recheck)
    return () => { document.removeEventListener('visibilitychange', recheck); window.removeEventListener('online', recheck) }
  }, [])

  async function checkNetwork() {
    setNet(n => ({ ...n, status: 'checking' }))
    try {
      const { data, error } = await supabase.rpc('clock_network_status')
      if (error || !data) { setNet({ status: 'error' }); return }
      setNet({ status: !data.configured ? 'unconfigured' : data.net_ok ? 'ok' : 'no', netOnly: !!data.net_only })
    } catch {
      setNet({ status: 'error' })
    }
  }

  // Lokales Datum als YYYY-MM-DD (kein UTC-Versatz)
  function localDateStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }

  async function fetchData() {
    setLoading(true)
    const today = localDateStr()
    const { data: cafeData } = await supabase.from('cafe_settings').select('*').eq('id', 1).maybeSingle()
    setCafe(cafeData)

    const empId = profile?.employee_id
    if (empId) {
      const [{ data: empData }, { data: todayEntries }, { data: openRows }] = await Promise.all([
        supabase.from('employees').select('*').eq('id', empId).maybeSingle(),
        supabase.from('time_entries').select('*').eq('employee_id', empId).eq('date', today).order('clock_in'),
        // Offener Eintrag kann auch von gestern sein (Nachtschicht / vergessen auszuclocken)
        supabase.from('time_entries').select('*').eq('employee_id', empId).is('clock_out', null).order('clock_in', { ascending: false }).limit(1),
      ])
      setEmp(empData || null)
      const openEntry = openRows?.[0] || null
      const list = todayEntries || []
      setEntries(openEntry && !list.some(e => e.id === openEntry.id) ? [openEntry, ...list] : list)
      setOpen(openEntry)

      // 11 Std. Ruhezeit zwischen zwei Arbeitstagen (§ 5 ArbZG) — Unterbrechungen am selben Tag zählen nicht
      setRestWarn(null)
      if (!openEntry && list.length === 0) {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1)
        const { data: recent } = await supabase.from('time_entries')
          .select('clock_out').eq('employee_id', empId)
          .not('clock_out', 'is', null)
          .gte('date', localDateStr(yesterday)).lt('date', today)
          .order('clock_out', { ascending: false }).limit(1)
        if (recent?.[0]?.clock_out) {
          const hoursSince = (Date.now() - new Date(recent[0].clock_out)) / 3600000
          if (hoursSince < 11) setRestWarn(Math.round(hoursSince * 10) / 10)
        }
      }
    }

    checkNetwork()
    if (cafeData?.gps_lat && cafeData?.gps_lng) doGpsCheck(cafeData)
    else setGps({ status: 'no-config' })
    setLoading(false)
  }

  function doGpsCheck(cafeData) {
    setGps({ status: 'checking' })
    if (!navigator.geolocation) { setGps({ status: 'unavailable' }); return }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const dist = getDistanceMeters(pos.coords.latitude, pos.coords.longitude, cafeData.gps_lat, cafeData.gps_lng)
        setGps({ status: dist <= cafeData.gps_radius_m ? 'ok' : 'too-far', dist: Math.round(dist), lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      err => setGps({ status: err?.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    )
  }

  async function clockIn() {
    if (working) return
    if (openEntry) { toast.warn('Du bist bereits eingeclockt!'); return }
    if (!employee) return
    if (!employee.is_active) {
      toast.error('Dein Account ist deaktiviert. Bitte das Management kontaktieren.')
      setWorking(false)
      return
    }
    setWorking(true)
    const now = new Date()
    const { error } = await supabase.from('time_entries').insert([{
      employee_id: employee.id, date: localDateStr(now),
      clock_in: now.toISOString(),
      gps_lat_in: gps.lat ?? null, gps_lng_in: gps.lng ?? null,
    }])
    if (error) { toast.error(translateSupabaseError(error, 'Zeiterfassung')); setWorking(false); return }
    toast.success(`✅ Eingeclockt um ${now.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })} Uhr`)
    await fetchData()
    setWorking(false)
  }

  async function clockOut() {
    if (working) return
    if (!openEntry) { toast.warn('Du bist nicht eingeclockt.'); return }
    setWorking(true)
    const now = new Date()
    const totalH = (now - new Date(openEntry.clock_in)) / 3600000
    const breakMin = totalH > 9 ? 45 : totalH > 6 ? 30 : 0
    const netH = Math.max(0, totalH - breakMin / 60)
    const { data: saved, error } = await supabase.from('time_entries').update({
      clock_out: now.toISOString(),
      gps_lat_out: gps.lat ?? null, gps_lng_out: gps.lng ?? null,
      break_minutes: breakMin, hours_worked: parseFloat(netH.toFixed(2)),
    }).eq('id', openEntry.id).select('hours_worked, notes').maybeSingle()
    if (error) { toast.error(translateSupabaseError(error, 'Zeiterfassung')); setWorking(false); return }
    // Server markiert Schichten > 12 Std. als „Ausstempeln vergessen“ (werden erst nach Korrektur bezahlt)
    if (saved?.notes?.includes('AUSSTEMPELN VERGESSEN')) {
      toast.warn('Du warst über 12 Stunden eingestempelt — vermutlich vergessen auszustempeln. Bitte sag der Schichtleitung Bescheid, sie trägt die richtige Zeit ein.', 12000)
      await fetchData(); setWorking(false); return
    }
    toast.success(`✅ Ausgeclockt — ${netH.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h gearbeitet${breakMin ? ` (${breakMin}min Pause abgezogen)` : ''}`)
    await fetchData()
    setWorking(false)
  }

  // ── Standort-Status: GPS ODER Café-WLAN genügt (Server prüft dasselbe noch einmal) ──
  const GPS_TEXT = {
    checking:    '📍 GPS wird geprüft…',
    ok:          `📍 GPS: im Café (${gps.dist} m)`,
    'too-far':   `📍 GPS: ${gps.dist} m entfernt (max. ${cafe?.gps_radius_m || 50} m)`,
    denied:      '📍 GPS: Zugriff nicht erlaubt',
    unavailable: '📍 GPS: nicht verfügbar',
  }
  const NET_TEXT = {
    checking: '📶 WLAN wird geprüft…',
    ok:       '📶 Café-WLAN verbunden',
    no:       '📶 Nicht im Café-WLAN',
    error:    '📶 WLAN-Prüfung fehlgeschlagen',
  }
  const netOnly = !!net.netOnly   // Admin hat „nur Café-WLAN“ eingestellt
  const gpsConfigured = gps.status !== 'no-config' && !netOnly
  const netConfigured = net.status !== 'unconfigured'
  const anyConfigured = gpsConfigured || (netConfigured && net.status !== 'checking')
  const located = net.status === 'ok' || (!netOnly && gps.status === 'ok')
  const stillChecking = (gpsConfigured && gps.status === 'checking') || (netConfigured && net.status === 'checking')
  // Bei Prüf-Fehler ohne GPS entscheidet der Server (er prüft ohnehin selbst)
  const canClock = located || (!netOnly && !gpsConfigured && (net.status === 'unconfigured' || net.status === 'error'))
  const blockReason = stillChecking ? 'Standort wird geprüft' : 'Nicht im Café erkannt'
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '')
  const elapsedMin = openEntry ? Math.max(0, Math.floor((tick - new Date(openEntry.clock_in)) / 60000)) : 0
  const METHOD_LABEL = { gps: '📍 GPS', wlan: '📶 WLAN', 'gps+wlan': '📍📶', 'ohne Prüfung': '–' }

  const today = localDateStr()
  if (loading) return <div style={{ padding:24, color:'var(--text-secondary)' }}>Lädt…</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Zeiterfassung</div>
        {anyConfigured && <button className="btn btn-sm" onClick={() => { checkNetwork(); if (cafe?.gps_lat && cafe?.gps_lng) doGpsCheck(cafe) }}>🔄 Standort neu prüfen</button>}
      </div>

      <div className="content">
        {!employee && !profile?.employee_id && (
          <div className="alert alert-warn">⚠️ Kein Mitarbeiterprofil verknüpft. Bitte die Geschäftsführung kontaktieren.</div>
        )}

        <div className="card mb-5">
          <div className="clock-widget">
            <div className="clock-time" style={{ fontVariantNumeric:'tabular-nums' }}>
              {tick.toLocaleTimeString('de-DE')}
            </div>
            <div className="clock-date">
              {tick.toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
            </div>

            {employee && (
              <div style={{ fontSize:14, color:'var(--text-secondary)', marginBottom:14 }}>
                {employee.first_name} {employee.last_name} · {employee.position || 'Café Buur'}
              </div>
            )}

            {/* Standort-Status */}
            {anyConfigured ? (
              <div style={{ display:'flex', gap:8, justifyContent:'center', flexWrap:'wrap', marginBottom:20 }}>
                {gpsConfigured && (
                  <div className={`gps-pill ${gps.status === 'ok' ? 'gps-ok' : gps.status === 'checking' ? '' : 'gps-fail'}`} style={{ display:'inline-block', margin:0 }}>
                    {GPS_TEXT[gps.status] || GPS_TEXT.checking}
                  </div>
                )}
                {netConfigured && (
                  <div className={`gps-pill ${net.status === 'ok' ? 'gps-ok' : net.status === 'checking' ? '' : 'gps-fail'}`} style={{ display:'inline-block', margin:0 }}>
                    {NET_TEXT[net.status] || NET_TEXT.checking}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ marginBottom:20, fontSize:13, color:'var(--text-secondary)' }}>⚠️ Standortprüfung noch nicht eingerichtet</div>
            )}

            {!stillChecking && !canClock && employee && (
              <div style={{ fontSize:12.5, color:'var(--text-secondary)', maxWidth:380, margin:'-8px auto 16px', lineHeight:1.55 }}>
                {netOnly ? 'Verbinde dich mit dem Café-WLAN' : <>Erlaube den Standortzugriff{netConfigured ? ' oder verbinde dich mit dem Café-WLAN' : ''}</>} und tippe dann auf „Standort neu prüfen“.
                {netConfigured && isIOS && net.status === 'no' && (
                  <> Im Café-WLAN, aber nicht erkannt? Einstellungen → WLAN → (i) → „iCloud Privat-Relay“ ausschalten.</>
                )}
              </div>
            )}

            {employee && !openEntry && (
              <button
                className={`clock-btn ${canClock ? 'btn-clock-in' : 'btn-clock-blocked'}`}
                onClick={canClock ? clockIn : undefined}
                disabled={working}
                style={{ cursor: canClock ? 'pointer' : 'not-allowed' }}
              >
                {working ? '…' : canClock ? '⏱ Einclocken' : `🔒 ${blockReason}`}
              </button>
            )}

            {employee && openEntry && (
              <div>
                <div style={{ marginBottom:12, fontSize:13.5, color:'var(--text-secondary)' }}>
                  Eingeclockt seit {formatTime(openEntry.clock_in)} Uhr ·{' '}
                  <strong style={{ color:'var(--text-primary)' }}>
                    {((Date.now() - new Date(openEntry.clock_in)) / 3600000).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h
                  </strong>
                </div>
                <button
                  className={`clock-btn ${canClock ? 'btn-clock-out' : 'btn-clock-blocked'}`}
                  onClick={canClock ? clockOut : undefined}
                  disabled={working}
                  style={{ cursor: canClock ? 'pointer' : 'not-allowed' }}
                >
                  {working ? '…' : canClock ? '⏹ Ausclocken' : `🔒 ${blockReason}`}
                </button>
              </div>
            )}
          </div>
        </div>

        {openEntry && elapsedMin > 0 && (
        <div style={{ textAlign:'center', padding:'10px', marginBottom:8, background:'var(--accent-light)', borderRadius:10, fontSize:13, color:'var(--accent)', fontWeight:600 }}>
          ⏱ Du arbeitest seit {elapsedMin >= 60 ? `${Math.floor(elapsedMin/60)} Std. ${elapsedMin%60} Min.` : `${elapsedMin} Minuten`}
        </div>
      )}
      {!openEntry && restWarn !== null && (
        <div className="alert alert-warn" style={{ fontSize:13, marginBottom:12 }}>
          ⚠️ Dein letztes Ausclocken ist erst {restWarn.toLocaleString('de-DE')} Std. her. Zwischen zwei Schichten sind gesetzlich in der Regel 11 Std. Ruhezeit vorgesehen (§ 5 ArbZG). Bitte kurz mit der Schichtleitung absprechen.
        </div>
      )}
      <div className="card">
          <div className="card-header"><div className="card-title">Heutige Einträge — {new Date().toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</div></div>
          {entries.length === 0
            ? <div className="empty-state"><div className="empty-state-icon">⏰</div><div className="empty-state-text">Noch keine Zeiteinträge heute</div></div>
            : <div className="table-wrap">
                <table>
                  <thead><tr><th>Arbeitsbeginn</th><th>Arbeitsende</th><th>Pause</th><th>Netto-Stunden</th><th>Ort</th></tr></thead>
                  <tbody>
                    {entries.map(e => (
                      <tr key={e.id}>
                        <td>{e.date !== today && <span style={{ fontSize:11.5, color:'var(--text-muted)' }}>{new Date(e.date + 'T00:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})} · </span>}{formatTime(e.clock_in)}</td>
                        <td>{e.clock_out ? formatTime(e.clock_out) : <span className="badge badge-green">Aktiv</span>}</td>
                        <td>{e.break_minutes ? `${e.break_minutes} min` : '–'}</td>
                        <td>{e.hours_worked ? <strong>{e.hours_worked.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h</strong> : '–'}</td>
                        <td>{e.clock_in_method ? (METHOD_LABEL[e.clock_in_method] || '–') : (e.gps_ok_in ? '📍 GPS' : '–')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
          }
        </div>
      </div>
    </>
  )
}
