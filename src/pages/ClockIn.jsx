import { t as tr, getIntlLocale, message as appMessage, formatParam } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { supabase, getDistanceMeters } from '../lib/supabase'
import { formatTime } from '../i18n/format.js'
import { translateSupabaseError } from '../lib/errorHelper'
import { calcWorkedHours, openBreak, sumBreakMinutes, isBreakTooLong, netWorkedHours, breakElapsedMinutes, breakUiState, BREAK_WARNING_MINUTES } from '../lib/workHours'
import { fetchBreaks, startBreak, endBreak, isBreakFeatureMissing } from '../lib/breaks'
import { notifyTimeDataChanged } from '../lib/laborCost'
import { remoteClockState, remoteErrorKind, clockInRemote, clockOutRemote } from '../lib/remoteClock'
import { createClockRevalidator, bindClockRevalidationEvents, locationSatisfied, withTimeout } from '../lib/clockRevalidation'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useRefreshHandler } from '../context/RefreshContext.jsx'

export default function ClockIn({ session }) {
  useLocale()
  const { profile, isManager } = useProfile()   // isManager = Manager ODER Admin (nur fürs Anbieten; Server prüft selbst)
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
  const [breakLoad, setBreakLoad] = useState('ok') // 'loading' | 'ok' | 'error' – unbekannt ist nie „keine Pause“
  const [remoteAsk, setRemoteAsk] = useState(null) // 'in' | 'out' – Bestätigungsdialog „außerhalb des Cafés“
  const remoteBusy = useRef(false)                 // synchroner Schutz gegen Doppeltipp (State ist asynchron)
  // Live-Nachprüfung der Standortvoraussetzungen (WLAN/GPS), solange die Seite offen ist – siehe lib/clockRevalidation
  const cafeRef = useRef(null), gpsRef = useRef(gps), netRef = useRef(net), revalidator = useRef(null)
  gpsRef.current = gps; netRef.current = net

  useEffect(() => {
    const t = setInterval(() => setTick(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // Nach WLAN-Wechsel, Rückkehr in die App, online/offline, Fokus: automatisch neu prüfen (ohne Neuladen/Schließen).
  // Höchstens eine Prüfung gleichzeitig, ältere Antworten überschreiben nie neuere, nach Verlassen der Seite nichts mehr.
  useEffect(() => {
    const rv = createClockRevalidator({
      checkNetwork,
      onNetwork: r => setNet(r),
      checkGps,
      onGps: r => setGps(r),
      onChecking: kind => kind === 'network' ? setNet(n => ({ ...n, status: 'checking' })) : setGps({ status: 'checking' }),
      isSatisfied: () => locationSatisfied(gpsRef.current, netRef.current),
      isVisible: () => document.visibilityState === 'visible',
    })
    revalidator.current = rv
    const unbind = bindClockRevalidationEvents(rv)
    return () => { unbind(); rv.dispose(); revalidator.current = null }
  }, [])

  useEffect(() => { fetchData() }, [profile?.employee_id])
  useRefreshHandler(() => fetchData())   // Aktualisieren-Button

  // Café-WLAN: der Server vergleicht die Client-IP mit den Café-Netzen. Offline/keine Antwort ist nie „erfüllt“.
  async function checkNetwork() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { status: 'offline' }
    try {
      const { data, error } = await withTimeout(supabase.rpc('clock_network_status'), 10000)
      if (error || !data) return { status: 'error' }
      return { status: !data.configured ? 'unconfigured' : data.net_ok ? 'ok' : 'no', netOnly: !!data.net_only }
    } catch {
      return { status: 'error' }
    }
  }

  // GPS im Browser: verweigert / nicht verfügbar / Zeitüberschreitung getrennt; nie „erfüllt“ ohne Position im Radius
  function checkGps() {
    const c = cafeRef.current
    if (!c?.gps_lat || !c?.gps_lng) return Promise.resolve({ status: 'no-config' })
    if (!navigator.geolocation) return Promise.resolve({ status: 'unavailable' })
    return withTimeout(new Promise(resolve => navigator.geolocation.getCurrentPosition(
      pos => {
        const dist = getDistanceMeters(pos.coords.latitude, pos.coords.longitude, c.gps_lat, c.gps_lng)
        resolve({ status: dist <= c.gps_radius_m ? 'ok' : 'too-far', dist: Math.round(dist), lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      err => resolve({ status: err?.code === 1 ? 'denied' : err?.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    )), 20000, { status: 'timeout' })
  }

  // Pausen der offenen Schicht laden – auch als „Erneut laden“ nach einem Fehler
  async function loadBreaks(entryId) {
    setBreakLoad('loading')
    try {
      const { breaks: rows, error } = await fetchBreaks(entryId)
      if (isBreakFeatureMissing(error)) { setBreaksOn(false); setBreaks([]); setBreakLoad('ok'); return }
      setBreaksOn(true)
      if (error) { setBreaks([]); setBreakLoad('error'); return }
      setBreaks(rows); setBreakLoad('ok')
    } catch {
      setBreaks([]); setBreakLoad('error')
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
      if (openEntry) await loadBreaks(openEntry.id)
      else { setBreaks([]); setBreakLoad('ok') }

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

    cafeRef.current = cafeData || null
    revalidator.current?.trigger('initial')   // WLAN + GPS (auch nach „Aktualisieren“)
    setLoading(false)
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
    // Z. B. Antwort verloren und erneut getippt („bereits eingeclockt“): echten Zustand vom Server zeigen
    if (error) { toast.error(translateSupabaseError(error, appMessage("ui.d31430ba7ba3"))); await fetchData(); setWorking(false); return }
    toast.success(appMessage("ui.28f97c874d34", { p1: (formatParam("time", now, { hour:'2-digit', minute:'2-digit' })) }))
    notifyTimeDataChanged()   // Live-Personalkosten (anderer Tab/Dashboard) neu abgleichen
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
    notifyTimeDataChanged()   // Live-Personalkosten (anderer Tab/Dashboard) neu abgleichen
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
    notifyTimeDataChanged()   // Live-Personalkosten (anderer Tab/Dashboard) neu abgleichen
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
    }).eq('id', openEntry.id).is('clock_out', null).select('hours_worked, notes').maybeSingle()
    if (error) { toast.error(translateSupabaseError(error, appMessage("ui.d31430ba7ba3"))); setWorking(false); return }
    // Schon ausgestempelt (z. B. auf einem anderen Gerät): nichts überschreiben, keine Erfolgsmeldung
    if (!saved) { toast.warn(appMessage("ui.8a3492aa4c28")); await fetchData(); setWorking(false); return }
    // Server markiert Schichten > 12 Std. als „Ausstempeln vergessen“ (werden erst nach Korrektur bezahlt)
    if (saved?.notes?.includes('AUSSTEMPELN VERGESSEN')) {
      toast.warn(appMessage("ui.ce394dbf8d29"), 12000)
      await fetchData(); setWorking(false); return
    }
    // Netto immer vom Server (Serverzeit, erfasste Pausen – Migration 34: für alle Rollen derselbe Weg)
    const known = breakLoad === 'ok' || !breaksOn
    const announce = (netH, breakMin) => toast.success(appMessage("ui.974c5412d6ec", { p1: (formatParam("number", netH, {minimumFractionDigits:2,maximumFractionDigits:2})), p2: (breakMin ? (appMessage("ui.b90bda0a43ef", { p1: (breakMin) })) : ('')) }))
    announce(Number(saved?.hours_worked ?? netH), known ? breakMin : 0)
    notifyTimeDataChanged()   // Live-Personalkosten (anderer Tab/Dashboard) neu abgleichen
    await fetchData()
    setWorking(false)
  }

  // ── Bestätigtes Stempeln außerhalb des Cafés (nur Manager/Admin; Server prüft Rolle, Person, Standort) ──
  async function confirmRemote() {
    const kind = remoteAsk
    if (!kind || remoteBusy.current || working) return
    remoteBusy.current = true
    setWorking(true)
    try {
      const res = await (kind === 'in' ? clockInRemote : clockOutRemote)({ lat: gps.lat, lng: gps.lng })
      setRemoteAsk(null)
      const errKind = remoteErrorKind(res)
      if (errKind || !res.data?.success) {
        const msg = {
          remote_not_allowed:    'clock.remote.errNotAllowed',
          inactive:              'ui.9470891f33ea',
          location_unknown:      'clock.remote.errUnknown',
          confirmation_required: 'clock.remote.errConfirm',
          already_clocked_in:    'clock.remote.errAlreadyIn',
          not_clocked_in:        'clock.remote.errNotIn',
          no_response:           'clock.remote.errNoResponse',
          unavailable:           'clock.remote.errUnavailable',
        }[errKind]
        if (msg) toast.error(appMessage(msg), 9000)
        else toast.error(translateSupabaseError(res.error, appMessage("ui.d31430ba7ba3")))
        return   // Kein Erfolg ohne bestätigte Serverwirkung – Stand wird unten neu geladen
      }
      const d = res.data
      if (kind === 'in') {
        const time = formatParam("time", new Date(d.clock_in), { hour:'2-digit', minute:'2-digit' })
        toast.success(appMessage(d.remote ? "clock.remote.successIn" : "clock.remote.successInCafe", { time }))
      } else if (String(d.notes || '').includes('AUSSTEMPELN VERGESSEN')) {
        toast.warn(appMessage("ui.ce394dbf8d29"), 12000)
      } else {
        const hours = formatParam("number", Number(d.hours_worked) || 0, { minimumFractionDigits:2, maximumFractionDigits:2 })
        toast.success(appMessage(d.remote ? "clock.remote.successOut" : "clock.remote.successOutCafe", { hours }))
      }
    } finally {
      await fetchData()   // Serverzustand ist maßgeblich – auch nach Fehler/Zeitüberschreitung
      notifyTimeDataChanged()   // Live-Personalkosten (anderer Tab/Dashboard) neu abgleichen
      setWorking(false)
      remoteBusy.current = false
    }
  }

  // ── Standort-Status: GPS ODER Café-WLAN genügt (Server prüft dasselbe noch einmal) ──
  const GPS_TEXT = {
    checking:    tr("ui.8f885759e8d1"),
    ok:          tr("ui.fbb8b88b2a33", { p1: (gps.dist) }),
    'too-far':   tr("clock.distance", { distance: gps.dist, max: cafe?.gps_radius_m || 50 }),
    denied:      tr("ui.f1767e169c69"),
    unavailable: tr("ui.604e820cb914"),
    timeout:     tr("clock.gpsTimeout"),
  }
  const NET_TEXT = {
    checking: tr("ui.801490cdd516"),
    ok:       tr("ui.b382e57ffe1e"),
    no:       tr("ui.bf798ef87ca0"),
    error:    tr("ui.0bf594519ebf"),
    offline:  tr("clock.netOffline"),
  }
  const netOnly = !!net.netOnly   // Admin hat „nur Café-WLAN“ eingestellt
  const gpsConfigured = gps.status !== 'no-config' && !netOnly
  const netConfigured = net.status !== 'unconfigured'
  const anyConfigured = gpsConfigured || (netConfigured && net.status !== 'checking')
  const located = net.status === 'ok' || (!netOnly && gps.status === 'ok')
  const stillChecking = (gpsConfigured && gps.status === 'checking') || (netConfigured && net.status === 'checking')
  // Bei Prüf-Fehler ohne GPS entscheidet der Server (er prüft ohnehin selbst)
  const offline = net.status === 'offline'   // ohne Verbindung kann der Server nicht stempeln → nie freigeben
  const canClock = !offline && (located || (!netOnly && !gpsConfigured && (net.status === 'unconfigured' || net.status === 'error')))
  const blockReason = offline ? tr("clock.offlineBlocked") : stillChecking ? tr("ui.75c87c02a7f2") : tr("ui.f2ecba2c057d")
  // Manager/Admin: außerhalb nur nach Bestätigung; Standort unbekannt ≠ außerhalb (kein Angebot)
  const remote = canClock ? 'none' : remoteClockState({ canManage: !!isManager, located, anyConfigured, stillChecking, netOnly, gpsConfigured, gpsStatus: gps.status, netStatus: net.status })
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '')
  const elapsedMin = openEntry ? Math.max(0, Math.floor((tick - new Date(openEntry.clock_in)) / 60000)) : 0
  const breakUi      = breakUiState({ featureOn: breaksOn, loadState: breakLoad, breaks })
  const runningBreak = breakUi === 'running' ? openBreak(breaks) : null
  const breakMinNow  = sumBreakMinutes(breaks, tick)
  const netHNow      = openEntry ? netWorkedHours(openEntry.clock_in, null, breaks, tick) : 0
  const breakSec     = runningBreak ? Math.max(0, Math.floor((tick - new Date(runningBreak.break_start)) / 1000)) : 0
  const breakTimer   = `${Math.floor(breakSec / 3600)}:${String(Math.floor(breakSec / 60) % 60).padStart(2, '0')}:${String(breakSec % 60).padStart(2, '0')}`
  const METHOD_LABEL = { gps: '📍 GPS', wlan: tr('clock.methodWifi'), 'gps+wlan': '📍📶', 'ohne Prüfung': '–', remote: tr("clock.remote.method") }

  const today = localDateStr()
  if (loading) return <div style={{ padding:24, color:'var(--text-secondary)' }}>{tr("ui.ebbb1d1f265f")}</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.d31430ba7ba3")}</div>
        {anyConfigured && <button className="btn btn-sm" onClick={() => revalidator.current?.trigger('manual')}>{tr("ui.d557ceae7443")}</button>}
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
                {remote === 'unknown' && <div style={{ marginTop:6 }}>{tr("clock.remote.unknownHint")}</div>}
                {remote === 'outside' && <div style={{ marginTop:6 }}>{tr("clock.remote.outsideHint")}</div>}
              </div>
            )}

            {employee && !openEntry && (
              remote === 'outside' ? (
                <button className="clock-btn btn-clock-remote" onClick={() => setRemoteAsk('in')} disabled={working || offline}>
                  {working ? '…' : tr("clock.remote.button")}
                </button>
              ) : (
              <button
                className={`clock-btn ${canClock ? 'btn-clock-in' : 'btn-clock-blocked'}`}
                onClick={canClock ? clockIn : undefined}
                disabled={working}
                style={{ cursor: canClock ? 'pointer' : 'not-allowed' }}
              >
                {working ? '…' : canClock ? tr("ui.5a69fe8540cc") : `🔒 ${blockReason}`}
              </button>
              )
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

                {breakUi === 'error' && (
                  <div className="break-panel" role="alert">
                    <div className="break-panel-warn" style={{ marginTop:0 }}>{tr("clock.breakStatusUnknown")}</div>
                    <button type="button" className="btn btn-sm" style={{ marginTop:8 }} onClick={() => loadBreaks(openEntry.id)}>{tr("clock.breakStatusRetry")}</button>
                  </div>
                )}

                <div className="clock-actions">
                  {(breakUi === 'idle' || breakUi === 'running') && (
                    <button className="clock-btn btn-clock-break" onClick={runningBreak ? onEndBreak : onStartBreak} disabled={working}>
                      {working ? '…' : runningBreak ? tr("clock.endBreak") : tr("clock.startBreak")}
                    </button>
                  )}
                  {breakUi === 'loading' && (
                    <button className="clock-btn btn-clock-break" disabled aria-busy="true">…</button>
                  )}
                  {remote === 'outside' ? (
                    <button className="clock-btn btn-clock-remote" onClick={() => setRemoteAsk('out')} disabled={working || offline}>
                      {working ? '…' : tr("clock.remote.buttonOut")}
                    </button>
                  ) : (
                  <button
                    className={`clock-btn ${canClock ? 'btn-clock-out' : 'btn-clock-blocked'}`}
                    onClick={canClock ? clockOut : undefined}
                    disabled={working}
                    style={{ cursor: canClock ? 'pointer' : 'not-allowed' }}
                  >
                    {working ? '…' : canClock ? tr("ui.161d46983281") : `🔒 ${blockReason}`}
                  </button>
                  )}
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
                        <td>{brkMin ? tr("ui.f6c1459ae2f9", { p1: brkMin }) : '–'}</td>
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
      {remoteAsk && (
        <RemoteClockDialog kind={remoteAsk} busy={working}
          onCancel={() => { if (!remoteBusy.current) setRemoteAsk(null) }}
          onConfirm={confirmRemote} />
      )}
    </>
  )
}

// Bestätigung „außerhalb des Cafés“: Abbrechen ist die sichere Vorauswahl (Fokus, Escape, Tipp daneben)
function RemoteClockDialog({ kind, busy, onCancel, onConfirm }) {
  useLocale()
  const cancelRef = useRef(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = e => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const out = kind === 'out'
  return (
    <div className="modal-overlay" onClick={() => !busy && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="remote-clock-title" aria-describedby="remote-clock-body"
           style={{ maxWidth:440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header"><div className="modal-title" id="remote-clock-title">{tr(out ? "clock.remote.titleOut" : "clock.remote.title")}</div></div>
        <div className="modal-body" id="remote-clock-body" style={{ fontSize:14, lineHeight:1.6 }}>
          <p style={{ margin:'0 0 10px', fontWeight:600 }}>{tr("clock.remote.body1")}</p>
          <p style={{ margin:'0 0 10px' }}>{tr(out ? "clock.remote.body2Out" : "clock.remote.body2")}</p>
          <p style={{ margin:'0 0 10px' }}>{tr(out ? "clock.remote.questionOut" : "clock.remote.question")}</p>
          <p style={{ margin:0, fontSize:12.5, color:'var(--text-secondary)' }}>{tr("clock.remote.note")}</p>
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>{tr("clock.remote.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? '…' : tr(out ? "clock.remote.confirmOut" : "clock.remote.confirm")}
          </button>
        </div>
      </div>
    </div>
  )
}
