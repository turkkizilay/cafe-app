import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useToast }    from '../components/UI/Toast'
import { useProfile }  from '../context/ProfileContext'
import { supabase, formatDate, formatTime, formatCurrency } from '../lib/supabase'
import { getVacationBalance }  from '../lib/vacationLogic'
import {
  MINIJOB_LIMIT, WERKSTUDENT_MONTHLY_LIMIT,
  WERKSTUDENT_WEEKLY_LIMIT,
} from '../lib/constants'

// ── Wochenhelfer (ISO 8601: Montag = Start, Sonntag = Ende) ────────────────
function getStartOfWeekDE(date) {
  const d = new Date(date); d.setHours(0,0,0,0)
  const day = d.getDay() || 7          // 1=Mo … 7=So
  d.setDate(d.getDate() - day + 1)
  return d
}
function getEndOfWeekDE(monday) {
  const d = new Date(monday); d.setDate(monday.getDate() + 6); d.setHours(23,59,59,999)
  return d
}
function getISOWeekNumber(date) {
  // Standard ISO KW-Berechnung
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}
// UTC-String — NUR für ISO-KW-Berechnung (Date.UTC dort explizit)
// Lokales Datum als YYYY-MM-DD.
// toISOString() gibt UTC zurück → in DE (UTC+2) ist Montag 00:00 lokal = So 22:00 UTC
// → slice ergibt Sonntag. toLocalDateStr() gibt korrekt Montag zurück.
function toLocalDateStr(date) {
  return (
    date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0')
  )
}

// Echter lokaler Datumsvergleich — Jahr + Monat + Tag, kein UTC-Versatz
function isSameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  )
}

function isLocalToday(date) {
  return isSameLocalDate(date, new Date())
}
function parseWeekParam(param) {
  if (!param) return null
  const d = new Date(param + 'T00:00:00')
  return isNaN(d.getTime()) ? null : getStartOfWeekDE(d)
}
function formatWeekRange(monday, sunday) {
  const m = monday.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})
  const s = sunday.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})
  return `${m} – ${s}`
}

const DAY_NAMES = ['Mo','Di','Mi','Do','Fr','Sa','So']
const DAY_FULL  = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag']

export default function MyHours() {
  const { profile }  = useProfile()
  const toast        = useToast()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Ausgewählte Woche ─────────────────────────────────────────────────────
  const [selectedMonday, setSelectedMonday] = useState(() =>
    parseWeekParam(searchParams.get('week')) || getStartOfWeekDE(new Date())
  )
  const selectedSunday = getEndOfWeekDE(selectedMonday)
  const weekStart      = toLocalDateStr(selectedMonday)  // lokal — kein UTC-Versatz
  const weekEnd        = toLocalDateStr(selectedSunday)  // lokal — kein UTC-Versatz
  const weekNum        = getISOWeekNumber(selectedMonday)
  const todayMonday    = getStartOfWeekDE(new Date())
  const isCurrentWeek  = toLocalDateStr(todayMonday) === weekStart
  const isFutureWeek   = selectedMonday > todayMonday

  // ── Navigation ────────────────────────────────────────────────────────────
  function goBack() {
    const d = new Date(selectedMonday); d.setDate(d.getDate() - 7)
    setSelectedMonday(d); setSearchParams({ week: toLocalDateStr(d) })
  }
  function goForward() {
    const d = new Date(selectedMonday); d.setDate(d.getDate() + 7)
    setSelectedMonday(d); setSearchParams({ week: toLocalDateStr(d) })
  }
  function goToday() {
    setSelectedMonday(todayMonday); setSearchParams({})
  }

  // ── Monat der ausgewählten Woche (für Monats-Log) ─────────────────────────
  const year        = selectedMonday.getFullYear()
  const month       = selectedMonday.getMonth() + 1
  const monthStart  = `${year}-${String(month).padStart(2,'0')}-01`
  const monthEnd    = toLocalDateStr(new Date(year, month, 0))

  // ── State ─────────────────────────────────────────────────────────────────
  const [employee,     setEmployee]     = useState(null)
  const [weekEntries,  setWeekEntries]  = useState([])
  const [monthEntries, setMonthEntries] = useState([])
  const [vacBalance,   setVacBalance]   = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)

  // ── Datenladen ────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!profile?.employee_id) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const yr = new Date().getFullYear()
      const [empRes, wRes, mRes, vacRes, sickRes, holRes] = await Promise.all([
        supabase.from('employees').select('*').eq('id', profile.employee_id).maybeSingle(),
        supabase.from('time_entries').select('*')
          .eq('employee_id', profile.employee_id)
          .gte('date', weekStart).lte('date', weekEnd).order('date'),
        supabase.from('time_entries').select('*')
          .eq('employee_id', profile.employee_id)
          .gte('date', monthStart).lte('date', monthEnd).order('date'),
        supabase.from('vacation_requests').select('*').eq('employee_id', profile.employee_id),
        supabase.from('sick_leave').select('*').eq('employee_id', profile.employee_id),
        supabase.from('public_holidays').select('date')
          .eq('bundesland','Hessen').in('year',[yr-1,yr,yr+1]),
      ])
      if (empRes.error) throw empRes.error
      setEmployee(empRes.data)
      setWeekEntries(wRes.data || [])
      setMonthEntries(mRes.data || [])
      if (empRes.data) {
        setVacBalance(getVacationBalance(empRes.data, vacRes.data||[], sickRes.data||[], holRes.data||[]))
      }
    } catch (err) {
      console.error('MyHours fetchData:', err)
      setError('Stunden konnten nicht geladen werden. Bitte erneut versuchen.')
    } finally { setLoading(false) }
  }, [profile?.employee_id, weekStart, weekEnd, monthStart, monthEnd])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Berechnungen ──────────────────────────────────────────────────────────
  const weeklyHours  = weekEntries.reduce((s,e) => s + (e.hours_worked||0), 0)
  const monthlyHours = monthEntries.reduce((s,e) => s + (e.hours_worked||0), 0)
  const dailyHours   = employee ? employee.hours_per_week / 5 : 8
  const weekTarget   = employee?.hours_per_week || 40

  const workdaysInMonth = employee ? Array.from(
    { length: new Date(year, month, 0).getDate() }, (_,i) => {
      const d = new Date(year, month-1, i+1)
      return d.getDay()!==0 && d.getDay()!==6 ? 1 : 0
    }).reduce((a,b)=>a+b, 0) : 0
  const monthTarget = dailyHours * workdaysInMonth

  // Beschäftigungstyp-Limits
  let overtimeHours = 0, limitWarning = null, limitPercent = 0, limitColor = 'var(--success)'
  if (employee) {
    if (employee.employment_type === 'werkstudent') {
      overtimeHours = Math.max(0, monthlyHours - WERKSTUDENT_MONTHLY_LIMIT)
      limitPercent  = Math.min(100, (monthlyHours / WERKSTUDENT_MONTHLY_LIMIT) * 100)
      if (monthlyHours > WERKSTUDENT_MONTHLY_LIMIT) {
        limitWarning = `⚠️ Werkstudent-Limit überschritten! ${(overtimeHours).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h über ${WERKSTUDENT_MONTHLY_LIMIT}h/Monat`
        limitColor = 'var(--danger)'
      } else if (monthlyHours > WERKSTUDENT_MONTHLY_LIMIT * 0.8) {
        limitWarning = `⚠️ Bald am Limit: noch ${(WERKSTUDENT_MONTHLY_LIMIT - monthlyHours).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h verfügbar`
        limitColor = 'var(--warn)'
      }
      if (weeklyHours > WERKSTUDENT_WEEKLY_LIMIT) {
        limitWarning = `🚨 Wöchentliches Limit (${WERKSTUDENT_WEEKLY_LIMIT.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h) überschritten!`
        limitColor = 'var(--danger)'
      }
    } else if (employee.employment_type === 'minijob') {
      const earnings = monthlyHours * employee.hourly_rate
      limitPercent   = Math.min(100, (earnings / MINIJOB_LIMIT) * 100)
      if (earnings > MINIJOB_LIMIT) {
        limitWarning = `🚨 Minijob-Grenze überschritten! ${formatCurrency(earnings - MINIJOB_LIMIT)} zu viel`
        limitColor = 'var(--danger)'
      } else if (earnings > MINIJOB_LIMIT * 0.85) {
        limitWarning = `⚠️ Fast am Minijob-Limit: ${formatCurrency(MINIJOB_LIMIT - earnings)} verbleibend`
        limitColor = 'var(--warn)'
      }
    } else {
      overtimeHours = Math.max(0, monthlyHours - monthTarget)
      limitPercent  = Math.min(110, (monthlyHours / (monthTarget||1)) * 100)
      if (overtimeHours > 5) {
        limitWarning = `📊 ${(overtimeHours).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h Überstunden diesen Monat`
        limitColor = 'var(--warn)'
      }
    }
  }

  // 7 Tage der ausgewählten Woche
  const weekDays = Array.from({ length:7 }, (_,i) => {
    const d = new Date(selectedMonday); d.setDate(selectedMonday.getDate() + i)
    return d
  })
  const todayStr = toLocalDateStr(new Date())  // lokales Datum, kein UTC-Versatz

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Meine Stunden</div>
        {employee && (
          <div style={{ padding:'0 24px', display:'flex', alignItems:'center', gap:8 }}>
            <span className="badge badge-gray">{employee.first_name} {employee.last_name}</span>
            <Link to={`/stundennachweis?monat=${year}-${String(month).padStart(2,'0')}`} className="btn btn-sm">🖨️ Stundennachweis</Link>
          </div>
        )}
      </div>

      <div className="content">
        {/* ── Wochennavigation ────────────────────────────────────────────── */}
        <div style={{
          display:'flex', flexWrap:'wrap', alignItems:'center', justifyContent:'space-between',
          gap:12, marginBottom:20,
          background:'var(--card)', borderRadius:12, padding:'14px 18px',
          border:'1px solid var(--border)', boxShadow:'0 1px 4px rgba(0,0,0,0.06)',
        }}>
          <button
            className="btn btn-sm"
            onClick={goBack}
            style={{ minWidth:44, fontSize:18, padding:'6px 12px' }}
            title="Vorherige Woche"
          >←</button>

          <div style={{ textAlign:'center', flex:1, minWidth:160 }}>
            <div style={{ fontWeight:700, fontSize:15 }}>
              {isCurrentWeek
                ? '📅 Diese Woche'
                : isFutureWeek
                  ? `📆 KW ${weekNum} · ${selectedMonday.getFullYear()}`
                  : `KW ${weekNum} · ${selectedMonday.getFullYear()}`
              }
            </div>
            <div style={{ fontSize:13, color:'var(--text-secondary)', marginTop:2 }}>
              {formatWeekRange(selectedMonday, selectedSunday)}
            </div>
          </div>

          <button
            className="btn btn-sm"
            onClick={goForward}
            style={{ minWidth:44, fontSize:18, padding:'6px 12px' }}
            title="Nächste Woche"
          >→</button>

          {!isCurrentWeek && (
            <button
              className="btn btn-sm btn-primary"
              onClick={goToday}
              style={{ marginLeft:4, fontSize:12, padding:'6px 12px' }}
            >Diese Woche</button>
          )}
        </div>

        {/* ── Fehler ──────────────────────────────────────────────────────── */}
        {error && (
          <div className="alert alert-danger" style={{ marginBottom:16 }}>
            ❌ {error}
            <button className="btn btn-sm" style={{ marginLeft:12 }} onClick={fetchData}>
              🔄 Erneut versuchen
            </button>
          </div>
        )}

        {/* ── Kein Profil ─────────────────────────────────────────────────── */}
        {!loading && !profile?.employee_id && (
          <div className="alert alert-warn">⚠️ Kein Mitarbeiterprofil verknüpft.</div>
        )}

        {/* ── Loading ─────────────────────────────────────────────────────── */}
        {loading && (
          <div style={{ textAlign:'center', padding:'40px 0', color:'var(--text-muted)', fontSize:14 }}>
            ⏳ Stunden werden geladen…
          </div>
        )}

        {!loading && employee && (
          <>
            {/* ── Limit-Warnung ────────────────────────────────────────────── */}
            {limitWarning && (
              <div className="alert" style={{
                background: limitColor==='var(--danger)' ? 'var(--danger-bg)' : 'var(--warn-bg)',
                color: limitColor, marginBottom:16, borderRadius:10, fontWeight:500
              }}>{limitWarning}</div>
            )}

            {/* ── Wochen-Stats ─────────────────────────────────────────────── */}
            <div className="stats-grid mb-5">
              <div className="stat-card">
                <div className="stat-label">
                  {isCurrentWeek ? 'Diese Woche' : `KW ${weekNum}`}
                </div>
                <div className="stat-value">{weeklyHours.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h</div>
                <div className="stat-sub">
                  von {employee.employment_type==='werkstudent'
                    ? `${WERKSTUDENT_WEEKLY_LIMIT.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h Limit`
                    : `${weekTarget.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h Soll`}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">
                  {new Date(year, month-1).toLocaleDateString('de-DE',{month:'long'})} gesamt
                </div>
                <div className="stat-value">{monthlyHours.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h</div>
                <div className="stat-sub">von {monthTarget.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h Soll</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Überstunden (Monat)</div>
                <div className="stat-value" style={{ color: overtimeHours>0 ? 'var(--warn)' : 'var(--success)' }}>
                  {overtimeHours>0 ? `+${(overtimeHours).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h` : '0h'}
                </div>
              </div>
              {employee.employment_type==='minijob' ? (
                <div className="stat-card">
                  <div className="stat-label">Verdienst (Monat)</div>
                  <div className="stat-value" style={{ fontSize:20 }}>
                    {formatCurrency(monthlyHours * employee.hourly_rate)}
                  </div>
                  <div className="stat-sub">Limit: {formatCurrency(MINIJOB_LIMIT)}</div>
                </div>
              ) : (
                <div className="stat-card">
                  <div className="stat-label">Stundenlohn</div>
                  <div className="stat-value" style={{ fontSize:20 }}>{formatCurrency(employee.hourly_rate)}</div>
                </div>
              )}
            </div>

            {/* ── Limit-Balken ─────────────────────────────────────────────── */}
            <div className="card mb-5" style={{ marginBottom:16 }}>
              <div className="card-body">
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6, fontSize:13 }}>
                  <span style={{ fontWeight:500 }}>
                    {employee.employment_type==='werkstudent'
                      ? `Werkstudent-Limit (${WERKSTUDENT_MONTHLY_LIMIT}h/Monat)`
                      : employee.employment_type==='minijob'
                        ? `Minijob-Limit (${formatCurrency(MINIJOB_LIMIT)}/Monat)`
                        : `Soll-Stunden ${new Date(year,month-1).toLocaleDateString('de-DE',{month:'long'})}`}
                  </span>
                  <span style={{ color:'var(--text-secondary)', fontSize:12 }}>{limitPercent.toFixed(0)}%</span>
                </div>
                <div className="progress" style={{ height:10, borderRadius:6 }}>
                  <div className="progress-fill" style={{
                    width:`${limitPercent}%`, borderRadius:6, transition:'width 0.5s ease',
                    background: limitPercent>100 ? 'var(--danger)' : limitPercent>85 ? 'var(--warn)' : 'var(--success)',
                  }} />
                </div>
              </div>
            </div>

            {/* ── Wochentabelle ────────────────────────────────────────────── */}
            <div className="card mb-5">
              <div className="card-header">
                <div className="card-title">
                  {isCurrentWeek ? '📅 Diese Woche' : isFutureWeek ? '📆 Geplante Woche' : `📅 KW ${weekNum}`}
                  <span style={{ fontSize:12, fontWeight:400, color:'var(--text-muted)', marginLeft:8 }}>
                    {formatWeekRange(selectedMonday, selectedSunday)}
                  </span>
                </div>
              </div>

              {isFutureWeek && (
                <div className="alert alert-info" style={{ margin:'8px 16px', fontSize:12 }}>
                  ℹ️ Für zukünftige Wochen werden noch keine Ist-Stunden angezeigt.
                </div>
              )}

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Datum</th>
                      <th>Arbeitsbeginn</th>
                      <th>Arbeitsende</th>
                      <th>Pause</th>
                      <th>Stunden</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekDays.map((d, i) => {
                      const ds       = toLocalDateStr(d)    // für Supabase-Query-Match + isFuture
                      const entry    = weekEntries.find(e => e.date === ds && e.clock_out)
                      const isWe     = d.getDay()===0 || d.getDay()===6
                      const isToday  = isLocalToday(d)      // Jahr+Monat+Tag, kein UTC-Versatz
                      const isFuture = ds > todayStr
                      return (
                        <tr key={i} style={{
                          background: isToday ? 'var(--accent-light)' : isWe ? 'rgba(0,0,0,0.01)' : undefined,
                          opacity: isFuture ? 0.55 : 1,
                        }}>
                          <td style={{ fontWeight: isToday ? 700 : 400 }}>
                            <span style={{ display:'none' }}>{DAY_FULL[i]}</span>
                            {DAY_NAMES[i]}
                            {isToday && <span style={{ fontSize:10, marginLeft:6, color:'var(--accent)' }}>Heute</span>}
                          </td>
                          <td style={{ color:'var(--text-secondary)', fontSize:13 }}>
                            {d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})}
                          </td>
                          <td>{entry ? formatTime(entry.clock_in) : <span className="text-muted">–</span>}</td>
                          <td>{entry ? formatTime(entry.clock_out) : <span className="text-muted">–</span>}</td>
                          <td>{entry?.break_minutes ? `${entry.break_minutes}min` : '–'}</td>
                          <td>
                            {entry?.hours_worked
                              ? <strong style={{ color: entry.hours_worked > dailyHours*1.25 ? 'var(--warn)' : 'inherit' }}>
                                  {entry.hours_worked}h
                                </strong>
                              : isWe
                                ? <span className="badge badge-gray" style={{ fontSize:11 }}>Wochenende</span>
                                : isFuture
                                  ? <span className="text-muted" style={{ fontSize:11 }}>geplant</span>
                                  : <span className="text-muted">–</span>
                            }
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background:'var(--bg)' }}>
                      <td colSpan="5" style={{ padding:'10px 16px', fontWeight:600, fontSize:13 }}>
                        Gesamt KW {weekNum}
                      </td>
                      <td style={{
                        padding:'10px 16px', fontWeight:700,
                        color: weeklyHours > weekTarget ? 'var(--warn)' : weeklyHours > 0 ? 'var(--success)' : 'var(--text-muted)',
                      }}>
                        {weeklyHours > 0 ? `${(weeklyHours).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h` : '–'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {weekEntries.filter(e=>e.clock_out).length === 0 && !isFutureWeek && (
                <div className="empty-state" style={{ padding:'24px 16px' }}>
                  <div className="empty-state-text">
                    {isCurrentWeek
                      ? 'Diese Woche wurden noch keine Arbeitszeiten erfasst.'
                      : 'Für diese Woche wurden keine Arbeitszeiten erfasst.'}
                  </div>
                </div>
              )}
            </div>

            {/* ── Monats-Log ───────────────────────────────────────────────── */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">
                  📊 {new Date(year, month-1).toLocaleDateString('de-DE',{month:'long', year:'numeric'})} — Alle Einträge
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Datum</th><th>Arbeitsbeginn</th><th>Arbeitsende</th><th>Pause</th><th>Stunden</th><th>Kumulativ</th></tr>
                  </thead>
                  <tbody>
                    {monthEntries.filter(e=>e.clock_out).length === 0 ? (
                      <tr><td colSpan="6">
                        <div className="empty-state">
                          <div className="empty-state-text">Noch keine Zeiteinträge diesen Monat</div>
                        </div>
                      </td></tr>
                    ) : monthEntries.filter(e=>e.clock_out).map((e, i, arr) => {
                      const cumulative = arr.slice(0,i+1).reduce((s,x)=>s+(x.hours_worked||0),0)
                      return (
                        <tr key={e.id}>
                          <td>{formatDate(e.date)}</td>
                          <td>{formatTime(e.clock_in)}</td>
                          <td>{formatTime(e.clock_out)}</td>
                          <td>{e.break_minutes ? `${e.break_minutes}min` : '–'}</td>
                          <td>
                            <strong style={{ color: e.hours_worked>dailyHours+2 ? 'var(--warn)' : 'inherit' }}>
                              {e.hours_worked}h
                            </strong>
                          </td>
                          <td style={{ color:'var(--text-secondary)', fontSize:12 }}>{cumulative.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
