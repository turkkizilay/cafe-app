import { t as tr, getIntlLocale, message as appMessage, formatParam } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect } from 'react'
import { supabase, getDistanceMeters } from '../lib/supabase'
import { formatTime } from '../i18n/format.js'
import { translateSupabaseError } from '../lib/errorHelper'
import { calcWorkedHours, openBreak, sumBreakMinutes, isBreakTooLong, netWorkedHours, breakElapsedMinutes, BREAK_WARNING_MINUTES } from '../lib/workHours'
import { fetchBreaks, startBreak, endBreak, isBreakFeatureMissing } from '../lib/breaks'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'

export default function ClockIn({ session }) {
  useLocale()
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
  const [breaks, setBreaks]     = useState([])    // erfasste Pausen der offenen Schicht
  const [breaksOn, setBreaksOn] = useState(true)  // false, solange Migration 17 fehlt

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
      if (openEntry) {
        const { breaks: rows, error: bErr } = await fetchBreaks(openEntry.id)
        setBreaksOn(!isBreakFeatureMissing(bErr))
        setBreaks(bErr ? [] : rows)
      } else setBreaks([])

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
    if (openEntry) { toast.warn(appMessage("ui.55993cbfd15e")); return }
    if (!employee) return
    if (!employee.is_active) {
      toast.error(appMessage("ui.9470891f33ea"))
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
    if (error) { toast.error(translateSupabaseError(error, appMessage("ui.d31430ba7ba3"))); setWorking(false); return }
    toast.success(appMessage("ui.28f97c874d34", { p1: (formatParam("time", now, { hour:'2-digit', minute:'2-digit' })) }))
    await fetchData()
    setWorking(false)
  }

  // Bekannte Server-Meldungen der Pausen-RPCs zweisprachig; sonst generische Fehlerbehandlung
  function breakError(error) {
    const m = error?.message || ''
    if (m.includes('läuft bereits'))     return appMessage("clock.breakAlreadyRunning")
    if (m.includes('keine Pause'))       return appMessage("clock.noBreakRunning")
    if (m.includes('nicht eingeclockt')) return appMessage("ui.8a3492aa4c28")
    if (m.includes('nicht aktiv'))       return appMessage("ui.9470891f33ea")
    return translateSupabaseError(error, appMessage("ui.858e4ba7a29f"))
  }

  async function onStartBreak() {
    if (working || !openEntry) return
    setWorking(true)
    const { error } = await startBreak()
    if (error) { toast.error(breakError(error)); await fetchData(); setWorking(false); return }
    toast.success(appMessage("clock.breakStarted", { time: formatParam("time", new Date(), { hour:'2-digit', minute:'2-digit' }) }))
    await fetchData()
    setWorking(false)
  }

  async function onEndBreak() {
    if (working) return
    setWorking(true)
    const { data, error } = await endBreak()
    if (error) { toast.error(breakError(error)); await fetchData(); setWorking(false); return }
    const ended = Array.isArray(data) ? data[0] : data
    toast.success(appMessage("clock.breakEnded", { minutes: breakElapsedMinutes(ended) }))
    await fetchData()
    setWorking(false)
  }

  async function clockOut() {
    if (working) return
    if (!openEntry) { toast.warn(appMessage("ui.8a3492aa4c28")); return }
    if (openBreak(breaks) && !window.confirm(tr("clock.confirmClockOutOnBreak"))) return
    setWorking(true)
    const now = new Date()
    // Keine automatische Pause – nur tatsächlich erfasste Pausen werden abgezogen
    // (eine laufende Pause endet mit dem Ausclocken; der Server rechnet identisch)
    const breakMin = breaks.length ? sumBreakMinutes(breaks, now) : (Number(openEntry.break_minutes) || 0)
    const netH = calcWorkedHours(openEntry.clock_in, now, breakMin)
    const { data: saved, error } = await supabase.from('time_entries').update({
      clock_out: now.toISOString(),
      gps_lat_out: gps.lat ?? null, gps_lng_out: gps.lng ?? null,
      break_minutes: breakMin, hours_worked: parseFloat(netH.toFixed(2)),
    }).eq('id', openEntry.id).select('hours_worked, notes').maybeSingle()
    if (error) { toast.error(translateSupabaseError(error, appMessage("ui.d31430ba7ba3"))); setWorking(false); return }
    // Server markiert Schichten > 12 Std. als „Ausstempeln vergessen“ (werden erst nach Korrektur bezahlt)
    if (saved?.notes?.includes('AUSSTEMPELN VERGESSEN')) {
      toast.warn(appMessage("ui.ce394dbf8d29"), 12000)
      await fetchData(); setWorking(false); return
    }
    toast.success(appMessage("ui.974c5412d6ec", { p1: (formatParam("number", netH, {minimumFractionDigits:2,maximumFractionDigits:2})), p2: (breakMin ? (appMessage("ui.b90bda0a43ef", { p1: (breakMin) })) : ('')) }))
    await fetchData()
    setWorking(false)
  }

  // ── Standort-Status: GPS ODER Café-WLAN genügt (Server prüft dasselbe noch einmal) ──
  const GPS_TEXT = {
    checking:    tr("ui.8f885759e8d1"),
    ok:          tr("ui.fbb8b88b2a33", { p1: (gps.dist) }),
    'too-far':   tr("clock.distance", { distance: gps.dist, max: cafe?.gps_radius_m || 50 }),
    denied:      tr("ui.f1767e169c69"),
    unavailable: tr("ui.604e820cb914"),
  }
  const NET_TEXT = {
    checking: tr("ui.801490cdd516"),
    ok:       tr("ui.b382e57ffe1e"),
    no:       tr("ui.bf798ef87ca0"),
    error:    tr("ui.0bf594519ebf"),
  }
  const netOnly = !!net.netOnly   // Admin hat „nur Café-WLAN“ eingestellt
  const gpsConfigured = gps.status !== 'no-config' && !netOnly
  const netConfigured = net.status !== 'unconfigured'
  const anyConfigured = gpsConfigured || (netConfigured && net.status !== 'checking')
  const located = net.status === 'ok' || (!netOnly && gps.status === 'ok')
  const stillChecking = (gpsConfigured && gps.status === 'checking') || (netConfigured && net.status === 'checking')
  // Bei Prüf-Fehler ohne GPS entscheidet der Server (er prüft ohnehin selbst)
  const canClock = located || (!netOnly && !gpsConfigured && (net.status === 'unconfigured' || net.status === 'error'))
  const blockReason = stillChecking ? tr("ui.75c87c02a7f2") : tr("ui.f2ecba2c057d")
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '')
  const elapsedMin = openEntry ? Math.max(0, Math.floor((tick - new Date(openEntry.clock_in)) / 60000)) : 0
  const runningBreak = breaksOn ? openBreak(breaks) : null
  const breakMinNow  = sumBreakMinutes(breaks, tick)
  const netHNow      = openEntry ? netWorkedHours(openEntry.clock_in, null, breaks, tick) : 0
  const breakSec     = runningBreak ? Math.max(0, Math.floor((tick - new Date(runningBreak.break_start)) / 1000)) : 0
  const breakTimer   = `${Math.floor(breakSec / 3600)}:${String(Math.floor(breakSec / 60) % 60).padStart(2, '0')}:${String(breakSec % 60).padStart(2, '0')}`
  const METHOD_LABEL = { gps: '📍 GPS', wlan: '📶 WLAN', 'gps+wlan': '📍📶', 'ohne Prüfung': '–' }

  const today = localDateStr()
  if (loading) return <div style={{ padding:24, color:'var(--text-secondary)' }}>{tr("ui.ebbb1d1f265f")}</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.d31430ba7ba3")}</div>
        {anyConfigured && <button className="btn btn-sm" onClick={() => { checkNetwork(); if (cafe?.gps_lat && cafe?.gps_lng) doGpsCheck(cafe) }}>{tr("ui.d557ceae7443")}</button>}
      </div>

      <div className="content">
        {!employee && !profile?.employee_id && (
          <div className="alert alert-warn">{tr("ui.e8ce490ed1fc")}</div>
        )}

        <div className="card mb-5">
          <div className="clock-widget">
            <div className="clock-time" style={{ fontVariantNumeric:'tabular-nums' }}>
              {tick.toLocaleTimeString(getIntlLocale())}
            </div>
            <div className="clock-date">
              {tick.toLocaleDateString(getIntlLocale(), { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
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
              <div style={{ marginBottom:20, fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.3c0cbeade7bc")}</div>
            )}

            {!stillChecking && !canClock && employee && (
              <div style={{ fontSize:12.5, color:'var(--text-secondary)', maxWidth:380, margin:'-8px auto 16px', lineHeight:1.55 }}>
                {netOnly ? tr("ui.77204e32623a") : <>{tr("ui.b21f0d33bf79")}{netConfigured ? tr("ui.874a844c2e3f") : ''}</>}{tr("ui.7f441ac056bd")}{netConfigured && isIOS && net.status === 'no' && (
                  <>{tr("ui.a4fbabf31591")}</>
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
                {working ? '…' : canClock ? tr("ui.5a69fe8540cc") : `🔒 ${blockReason}`}
              </button>
            )}

            {employee && openEntry && (
              <div>
                <div style={{ marginBottom:12, fontSize:13.5, color:'var(--text-secondary)' }}>{tr("ui.0f953d7be19e")}{formatTime(openEntry.clock_in)}{tr("ui.82b45aa08404")}{' '}
                  <strong style={{ color:'var(--text-primary)' }}>
                    {netHNow.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</strong>
                  {breakMinNow > 0 && <>{' · '}{tr("clock.breaksTotal", { minutes: breakMinNow })}</>}
                </div>

                {runningBreak && (
                  <div className="break-panel" role="status">
                    <div className="break-panel-title">{tr("clock.onBreakSince", { time: formatTime(runningBreak.break_start) })}</div>
                    <div className="break-panel-timer">{breakTimer}</div>
                    {isBreakTooLong(runningBreak, tick) && (
                      <div className="break-panel-warn">{tr("clock.breakTooLong", { minutes: BREAK_WARNING_MINUTES })}</div>
                    )}
                  </div>
                )}

                <div className="clock-actions">
                  {breaksOn && (
                    <button className="clock-btn btn-clock-break" onClick={runningBreak ? onEndBreak : onStartBreak} disabled={working}>
                      {working ? '…' : runningBreak ? tr("clock.endBreak") : tr("clock.startBreak")}
                    </button>
                  )}
                  <button
                    className={`clock-btn ${canClock ? 'btn-clock-out' : 'btn-clock-blocked'}`}
                    onClick={canClock ? clockOut : undefined}
                    disabled={working}
                    style={{ cursor: canClock ? 'pointer' : 'not-allowed' }}
                  >
                    {working ? '…' : canClock ? tr("ui.161d46983281") : `🔒 ${blockReason}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {openEntry && elapsedMin > 0 && !runningBreak && (
        <div style={{ textAlign:'center', padding:'10px', marginBottom:8, background:'var(--accent-light)', borderRadius:10, fontSize:13, color:'var(--accent)', fontWeight:600 }}>{tr("ui.5ebc04ce3734")}{elapsedMin >= 60 ? tr("ui.bab653ba27e2", { p1: (Math.floor(elapsedMin/60)), p2: (elapsedMin%60) }) : tr("count.minutes", { count: elapsedMin })}
        </div>
      )}
      {!openEntry && restWarn !== null && (
        <div className="alert alert-warn" style={{ fontSize:13, marginBottom:12 }}>{tr("ui.c2c19df3a031")}{restWarn.toLocaleString(getIntlLocale())}{tr("ui.1c9f634a2384")}</div>
      )}
      <div className="card">
          <div className="card-header"><div className="card-title">{tr("ui.9a8751dcebaa")}{new Date().toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'})}</div></div>
          {entries.length === 0
            ? <div className="empty-state"><div className="empty-state-icon">⏰</div><div className="empty-state-text">{tr("ui.f66a010e6610")}</div></div>
            : <div className="table-wrap">
                <table>
                  <thead><tr><th>{tr("ui.7527c410788b")}</th><th>{tr("ui.2d604d899b88")}</th><th>{tr("ui.858e4ba7a29f")}</th><th>{tr("ui.30cb3e5a9be1")}</th><th>{tr("ui.30fb259129e5")}</th></tr></thead>
                  <tbody>
                    {entries.map(e => {
                      const brkMin = e.id === openEntry?.id ? breakMinNow : e.break_minutes   // offene Schicht: live
                      return (
                      <tr key={e.id}>
                        <td>{e.date !== today && <span style={{ fontSize:11.5, color:'var(--text-muted)' }}>{new Date(e.date + 'T00:00:00').toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit'})} · </span>}{formatTime(e.clock_in)}</td>
                        <td>{e.clock_out ? formatTime(e.clock_out) : <span className="badge badge-green">{tr("ui.8163454f378f")}</span>}</td>
                        <td>{brkMin ? `${brkMin} min` : '–'}</td>
                        <td>{e.hours_worked ? <strong>{e.hours_worked.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</strong> : '–'}</td>
                        <td>{e.clock_in_method ? (METHOD_LABEL[e.clock_in_method] || '–') : (e.gps_ok_in ? '📍 GPS' : '–')}</td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
          }
        </div>
      </div>
    </>
  )
}
