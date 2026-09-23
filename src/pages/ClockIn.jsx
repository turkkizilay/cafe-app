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
  const [openEntry, setOpen]  = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [working,  setWorking]  = useState(false)
  const [restWarn, setRestWarn] = useState(null)  // Stunden seit letztem Clockout
  const [elapsed,  setElapsed]  = useState(0)     // Minuten seit Einclocken

  useEffect(() => {
    const t = setInterval(() => setTick(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => { fetchData() }, [profile?.employee_id])

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
      const [{ data: empData }, { data: todayEntries }] = await Promise.all([
        supabase.from('employees').select('*').eq('id', empId).maybeSingle(),
        supabase.from('time_entries').select('*').eq('employee_id', empId).eq('date', today).order('clock_in'),
      ])
      setEmp(empData || null)
      const entries = todayEntries || []
      setEntries(entries)
      const openEntry = entries.find(e => !e.clock_out) || null
      setOpen(openEntry)

      // 11h Ruhezeit prüfen (§5 ArbZG)
      if (!openEntry) {
        // Letzten Clock-out finden (auch gestern)
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1)
        const { data: recent } = await supabase.from('time_entries')
          .select('clock_out').eq('employee_id', empId)
          .not('clock_out', 'is', null)
          .gte('date', localDateStr(yesterday))
          .order('clock_out', { ascending: false }).limit(1)
        if (recent?.[0]?.clock_out) {
          const hoursSince = (Date.now() - new Date(recent[0].clock_out)) / 3600000
          if (hoursSince < 11) {
            setRestWarn(Math.round(hoursSince * 10) / 10)
          } else {
            setRestWarn(null)
          }
        }
      }
    }

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
      () => setGps({ status: 'denied' })
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
      gps_lat_in: gps.lat || null, gps_lng_in: gps.lng || null, gps_ok_in: gps.status === 'ok',
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
      gps_lat_out: gps.lat || null, gps_lng_out: gps.lng || null, gps_ok_out: gps.status === 'ok',
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

  // GPS Status Konfiguration
  const GPS_MAP = {
    checking:    { pill: null,          text: '📍 GPS wird geprüft…',                                          canClock: false, reason: 'GPS wird geprüft' },
    ok:          { pill: 'gps-ok',      text: `✅ Café Buur verifiziert (${gps.dist}m)`,                       canClock: true,  reason: null },
    'too-far':   { pill: 'gps-fail',    text: `Du bist ${gps.dist}m entfernt (max. ${cafe?.gps_radius_m||50}m)`, canClock: false, reason: `Zu weit vom Café (${gps.dist}m)` },
    denied:      { pill: 'gps-fail',    text: 'GPS-Zugriff verweigert',                                         canClock: false, reason: 'GPS-Zugriff verweigert' },
    unavailable: { pill: 'gps-fail',    text: 'GPS nicht verfügbar',                                            canClock: false, reason: 'GPS nicht verfügbar' },
    'no-config': { pill: null,          text: '⚠️ GPS noch nicht konfiguriert',                                 canClock: true,  reason: null },
  }
  const gi = GPS_MAP[gps.status] || GPS_MAP.checking

  const today = localDateStr()
  if (loading) return <div style={{ padding:24, color:'var(--text-secondary)' }}>Lädt…</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Zeiterfassung</div>
        {cafe?.gps_lat && <button className="btn btn-sm" onClick={() => doGpsCheck(cafe)}>🔄 GPS neu prüfen</button>}
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

            {/* GPS Status Pill */}
            {gi.pill
              ? <div className={`gps-pill ${gi.pill}`} style={{ display:'inline-block', marginBottom:20 }}>
                  {gi.text}
                </div>
              : <div style={{ marginBottom:20, fontSize:13, color:'var(--text-secondary)' }}>{gi.text}</div>
            }

            {employee && !openEntry && (
              <button
                className={`clock-btn ${gi.canClock ? 'btn-clock-in' : 'btn-clock-blocked'}`}
                onClick={gi.canClock ? clockIn : undefined}
                disabled={working}
                style={{ cursor: gi.canClock ? 'pointer' : 'not-allowed' }}
              >
                {working ? '…' : gi.canClock ? '⏱ Einclocken' : `🔒 Gesperrt — ${gi.reason}`}
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
                  className={`clock-btn ${gi.canClock ? 'btn-clock-out' : 'btn-clock-blocked'}`}
                  onClick={gi.canClock ? clockOut : undefined}
                  disabled={working}
                  style={{ cursor: gi.canClock ? 'pointer' : 'not-allowed' }}
                >
                  {working ? '…' : gi.canClock ? '⏹ Ausclocken' : `🔒 Gesperrt — ${gi.reason}`}
                </button>
              </div>
            )}
          </div>
        </div>

        {openEntry && elapsed > 0 && (
        <div style={{ textAlign:'center', padding:'10px', marginBottom:8, background:'var(--accent-light)', borderRadius:10, fontSize:13, color:'var(--accent)', fontWeight:600 }}>
          ⏱ Du arbeitest seit {elapsed >= 60 ? `${Math.floor(elapsed/60)}h ${elapsed%60}min` : `${elapsed} Minuten`}
        </div>
      )}
      <div className="card">
          <div className="card-header"><div className="card-title">Heutige Einträge — {new Date().toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</div></div>
          {entries.length === 0
            ? <div className="empty-state"><div className="empty-state-icon">⏰</div><div className="empty-state-text">Noch keine Zeiteinträge heute</div></div>
            : <div className="table-wrap">
                <table>
                  <thead><tr><th>Arbeitsbeginn</th><th>Arbeitsende</th><th>Pause</th><th>Netto-Stunden</th><th>GPS</th></tr></thead>
                  <tbody>
                    {entries.map(e => (
                      <tr key={e.id}>
                        <td>{formatTime(e.clock_in)}</td>
                        <td>{e.clock_out ? formatTime(e.clock_out) : <span className="badge badge-green">Aktiv</span>}</td>
                        <td>{e.break_minutes ? `${e.break_minutes} min` : '–'}</td>
                        <td>{e.hours_worked ? <strong>{e.hours_worked.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h</strong> : '–'}</td>
                        <td title={e.gps_ok_in ? 'GPS verifiziert' : 'Keine GPS-Prüfung'}>{e.gps_ok_in ? '✅' : '⚠️'}</td>
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
