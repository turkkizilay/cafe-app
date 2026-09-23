import { useState, useEffect, useCallback } from 'react'
import { groupSickLeavesIntoCases, getSickCaseWarnings } from '../lib/sickLeaveLogic'
import { Link } from 'react-router-dom'
import { supabase, formatTime, formatDate } from '../lib/supabase'
import Avatar from '../components/UI/Avatar'
import { missingPersonalFields } from '../components/PersonalDataCard'
import { useProfile } from '../context/ProfileContext'

// ── Hilfsfunktionen ─────────────────────────────────────────
function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Guten Morgen'
  if (h < 17) return 'Guten Tag'
  return 'Guten Abend'
}

function formatShiftDay(dateStr) {
  const d    = new Date(dateStr + 'T00:00:00')
  const today = new Date(); today.setHours(0,0,0,0)
  const diff  = Math.round((d - today) / 86400000)
  if (diff === 0) return 'Heute'
  if (diff === 1) return 'Morgen'
  if (diff === 2) return 'Übermorgen'
  return d.toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long' })
}

function timeUntil(dateStr, startTime) {
  const target = new Date(`${dateStr}T${startTime}`)
  const diff   = target - Date.now()
  if (diff <= 0) return null
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h > 48) return null
  if (h === 0) return `in ${m} Minuten`
  if (m === 0) return `in ${h} Stunden`
  return `in ${h}h ${m}min`
}

function LiveClock() {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div style={{ fontSize:13, color:'var(--text-secondary)', fontVariantNumeric:'tabular-nums' }}>
      {time.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
    </div>
  )
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

export default function Dashboard() {
  const { isAdmin, isManager, profile, pendingCount } = useProfile() || {}
  const canManage = isAdmin || isManager

  const [myEmployee,  setMyEmployee]  = useState(null)
  const [nextShift,   setNextShift]   = useState(null)
  const [todayShifts, setTodayShifts] = useState([])  // Alle Schichten heute (Admin)
  const [liveClockIns,setLiveClockIns]= useState([])
  const [stats,       setStats]       = useState({ employees:0, pendingVac:0, pendingUsers:0, pendingSwaps:0 })
  const [birthdays,   setBirthdays]   = useState([])
  const [loading,     setLoading]     = useState(true)
  const [clockedIn,   setClockedIn]   = useState(false)
  const [laborCosts,  setLaborCosts]  = useState(null)
  const [pendingReqs,  setPendingReqs]  = useState({ vac:[], sick:[], sickReviews:[] })

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const todayISO = localDateStr()
      const queries = [
        // Nächste eigene Schichten
        profile?.employee_id
          ? supabase.from('shifts').select('*').eq('employee_id', profile.employee_id).gte('date', todayISO).order('date').order('start_time').limit(3)
          : Promise.resolve({ data: [] }),
        // Live Clock-ins
        supabase.from('time_entries').select('*, employees!employee_id(first_name, last_name, avatar_color, avatar_url)').is('clock_out', null).order('clock_in', { ascending:false }),
        // Mein Employee
        profile?.employee_id
          ? supabase.from('employees').select('id, first_name, last_name, vacation_days_per_year, hourly_rate, employment_type, birth_date, street, house_number, postal_code, city, phone, iban, account_holder, tax_id, social_security_number, health_insurance, other_employment, emergency_contact_name, emergency_contact_phone').eq('id', profile.employee_id).maybeSingle()
          : Promise.resolve({ data: null }),
        // Bin ich eingeclockt?
        profile?.employee_id
          ? supabase.from('time_entries').select('id').eq('employee_id', profile.employee_id).is('clock_out', null).maybeSingle()
          : Promise.resolve({ data: null }),
      ]

      const [shiftRes, liveRes, empRes, myClockRes] = await Promise.all(queries)

      const shifts = shiftRes.data || []
      setNextShift(shifts[0] || null)
      setMyEmployee(empRes.data || null)
      setLiveClockIns(liveRes.data || [])
      setClockedIn(!!myClockRes.data)

      if (canManage) {
        const [empCount, vacPending, usersPending, swapsPending, todayShiftRes, allEmps] = await Promise.all([
          supabase.from('employees').select('*', { count:'exact', head:true }).eq('is_active', true),
          supabase.from('vacation_requests').select('*', { count:'exact', head:true }).eq('status', 'pending'),
          supabase.from('profiles').select('*', { count:'exact', head:true }).eq('status', 'pending'),
          supabase.from('shift_swap_requests').select('*', { count:'exact', head:true }).in('status', ['open','accepted']),
          supabase.from('shifts').select('*, employees!employee_id(first_name, last_name, avatar_color, avatar_url)').eq('date', todayISO).order('start_time'),
          supabase.from('employees').select('id, first_name, last_name, birth_date, avatar_color').eq('is_active', true).not('birth_date', 'is', null),
        ])
        setStats({ employees: empCount.count||0, pendingVac: vacPending.count||0, pendingUsers: usersPending.count||0, pendingSwaps: swapsPending.count||0 })
        setTodayShifts(todayShiftRes.data || [])

        // Live-Personalkosten berechnen
        const nowMs = Date.now()
        const { data: empRates }  = await supabase.from('employees').select('id, hourly_rate, hours_per_week').eq('is_active', true)
        const { data: todayTE }   = await supabase.from('time_entries').select('employee_id, clock_in, clock_out, hours_worked').gte('date', todayISO).lte('date', todayISO)

        // Heute: bereits geleistete Stunden × Stundenlohn
        const empMap = Object.fromEntries((empRates||[]).map(e => [e.id, e]))
        let costToday = 0, hoursToday = 0
        ;(todayTE || []).forEach(te => {
          const emp = empMap[te.employee_id]
          if (!emp) return
          const h = te.hours_worked || (te.clock_out ? 0 : Math.max(0, (nowMs - new Date(te.clock_in)) / 3600000))
          hoursToday += h
          costToday  += h * emp.hourly_rate
        })

        // Geplant heute (Schichten × Stundenlohn)
        let plannedToday = 0
        ;(todayShiftRes.data || []).forEach(s => {
          const emp = empMap[s.employee_id]
          if (!emp || !s.start_time || !s.end_time) return
          const h = (new Date('2000-01-01T' + s.end_time) - new Date('2000-01-01T' + s.start_time)) / 3600000
          plannedToday += h * emp.hourly_rate
        })

        // Diese Woche
        const weekStart = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getDay()||7) + 1); return localDateStr(d) })()
        const { data: weekTE } = await supabase.from('time_entries').select('employee_id, hours_worked').gte('date', weekStart).lte('date', todayISO)
        let costWeek = 0
        ;(weekTE || []).forEach(te => {
          const emp = empMap[te.employee_id]
          if (emp && te.hours_worked) costWeek += te.hours_worked * emp.hourly_rate
        })

        setLaborCosts({ today: costToday, hoursToday, plannedToday, week: costWeek })

        // Offene Anträge laden (Admin/Manager)
        if (canManage) {
          const today = localDateStr()
          const [{ data: pendingVac }, { data: pendingSick },
                 { data: approvedVacs }, { data: sickNoAttest }] = await Promise.all([
            supabase.from('vacation_requests')
              .select('*, employees!employee_id(first_name, last_name)')
              .eq('status','pending').order('created_at'),
            supabase.from('sick_leave')
              .select('*, employees!employee_id(first_name, last_name)')
              .is('end_date', null)
              .eq('certificate_received', false)
              .order('created_at'),
            // §9 BUrlG: genehmigte Urlaube zum Überschneidungs-Check
            supabase.from('vacation_requests')
              .select('employee_id, start_date, end_date')
              .eq('status','approved'),
            // §9 BUrlG: Krankmeldungen während Urlaub ohne Attest
            supabase.from('sick_leave')
              .select('id, employee_id, start_date, end_date, certificate_received, certificate_file_path, employees!employee_id(first_name, last_name)')
              .eq('certificate_received', false)
              .is('certificate_file_path', null),
          ])

          // §9 BUrlG: Finde Krankmeldungen die genehmigten Urlaub überschneiden
          const sickReviews = (sickNoAttest || []).filter(sl => {
            const sickEnd = sl.end_date || today
            return (approvedVacs || []).some(vr =>
              vr.employee_id === sl.employee_id &&
              vr.start_date <= sickEnd &&
              vr.end_date >= sl.start_date
            )
          })
          setPendingReqs({ vac: pendingVac||[], sick: pendingSick||[], sickReviews })
        }

        // Geburtstage nächste 30 Tage
        const todayDate = new Date(); todayDate.setHours(0,0,0,0)
        const upcoming = (allEmps.data || []).filter(e => {
          const bd   = new Date(e.birth_date)
          const thisY = new Date(todayDate.getFullYear(), bd.getMonth(), bd.getDate())
          const diff  = (thisY - todayDate) / 86400000
          return diff >= 0 && diff <= 30
        }).sort((a,b) => {
          const da = new Date(todayDate.getFullYear(), new Date(a.birth_date).getMonth(), new Date(a.birth_date).getDate())
          const db = new Date(todayDate.getFullYear(), new Date(b.birth_date).getMonth(), new Date(b.birth_date).getDate())
          return da - db
        })
        setBirthdays(upcoming)
      }
    } catch (err) {
      console.error('Dashboard fetch error:', err)
    }
    setLoading(false)
  }, [profile?.employee_id, canManage])

  useEffect(() => { fetchAll() }, [fetchAll])

  const firstName = myEmployee?.first_name
    || profile?.first_name   // Name aus Registrierung
    || ''                    // Kein Fallback auf Email mehr
  const until     = nextShift ? timeUntil(nextShift.date, nextShift.start_time) : null
  const todayDate = localDateStr()
  const isToday   = nextShift?.date === todayDate
  const noEmpLinked = !profile?.employee_id && !myEmployee

  return (
    <div>
      <div className="topbar">
        <div className="topbar-title">Dashboard</div>
        <div className="topbar-right">
          <LiveClock />
          <div style={{ fontSize:12, color:'var(--text-secondary)' }}>
            {new Date().toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
          </div>
        </div>
      </div>

      <div className="content">
        {/* ── Profil vervollständigen (Bestands-Mitarbeiter ohne vollständige Personaldaten) ── */}
        {!loading && myEmployee && missingPersonalFields(myEmployee).length > 0 && (
          <div style={{ background:'var(--warn-bg)', border:'1px solid #FDE68A', borderRadius:10, padding:'12px 14px', marginBottom:16, display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
            <div style={{ flex:1, minWidth:200, fontSize:13.5, lineHeight:1.5 }}>
              <strong>📝 Profil vervollständigen</strong><br />
              <span style={{ color:'var(--text-secondary)' }}>Für die Lohnabrechnung fehlen noch Angaben von dir.</span>
            </div>
            <Link to="/konto" className="btn btn-primary btn-sm">Jetzt ergänzen</Link>
          </div>
        )}

        {/* ── Warnung wenn kein Mitarbeiter verknüpft ── */}
        {!loading && !profile?.employee_id && (
          <div className="alert alert-danger" style={{ marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span>⚠️ Dein Account ist noch keinem Mitarbeiter zugewiesen — Schichtanzeige & Einclocken funktionieren nicht!</span>
            <a href="/benutzer" style={{ color:'inherit', fontWeight:600, marginLeft:12, whiteSpace:'nowrap' }}>→ Jetzt verknüpfen</a>
          </div>
        )}

        {/* ── Begrüssung + Nächste Schicht ─── */}
        <div style={{
          background: 'linear-gradient(135deg, #C2793A 0%, #9A5E2D 100%)',
          borderRadius:14, padding:'24px 28px', marginBottom:20, color:'#fff',
          display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:16,
        }}>
          <div>
            <div style={{ fontSize:13, opacity:0.8, marginBottom:4 }}>
              {greeting()}{firstName ? `, ${firstName}` : ''}! ☕
            </div>
            {loading ? (
              <div style={{ fontSize:20, fontWeight:700 }}>Lädt…</div>
            ) : nextShift ? (
              <>
                <div style={{ fontSize:22, fontWeight:700, lineHeight:1.3 }}>
                  {isToday && clockedIn
                    ? `Du bist eingeclockt ✅`
                    : isToday
                    ? `Deine Schicht startet ${until || 'gleich'}!`
                    : `Nächste Schicht: ${formatShiftDay(nextShift.date)}`}
                </div>
                <div style={{ fontSize:14, opacity:0.9, marginTop:6, display:'flex', alignItems:'center', gap:12 }}>
                  <span>🕐 {nextShift.start_time?.slice(0,5)} – {nextShift.end_time?.slice(0,5)} Uhr</span>
                  {nextShift.position && <span>· {nextShift.position}</span>}
                  {until && !clockedIn && <span style={{ background:'rgba(255,255,255,0.2)', borderRadius:20, padding:'2px 10px', fontSize:12 }}>{until}</span>}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize:20, fontWeight:700 }}>Keine Schichten geplant</div>
                <div style={{ fontSize:13, opacity:0.8, marginTop:4 }}>Genieße deine freie Zeit — bis zum nächsten Einsatz! 🌴</div>
              </>
            )}
          </div>

          {/* Quick Actions */}
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            {!clockedIn && isToday && nextShift && (
              <Link to="/einclocken" style={{ background:'rgba(255,255,255,0.2)', backdropFilter:'blur(8px)', border:'1px solid rgba(255,255,255,0.3)', borderRadius:10, padding:'10px 18px', color:'#fff', textDecoration:'none', fontSize:13, fontWeight:600 }}>
                ⏱ Jetzt Einclocken
              </Link>
            )}
            {clockedIn && (
              <Link to="/einclocken" style={{ background:'rgba(255,255,255,0.2)', border:'1px solid rgba(255,255,255,0.3)', borderRadius:10, padding:'10px 18px', color:'#fff', textDecoration:'none', fontSize:13, fontWeight:600 }}>
                ⏹ Ausclocken
              </Link>
            )}
            <Link to="/schichten" style={{ background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.25)', borderRadius:10, padding:'10px 18px', color:'#fff', textDecoration:'none', fontSize:13 }}>
              📅 Schichtplan
            </Link>
          </div>
        </div>

        {/* ── Admin Stats ─────────────────────── */}
        {canManage && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:12, marginBottom:20 }}>
            {[
              { icon:'👥', label:'Mitarbeiter', value: stats.employees, color:'var(--accent)', to:'/mitarbeiter' },
              { icon:'⏱', label:'Eingeclockt',  value: liveClockIns.length, color: liveClockIns.length > 0 ? '#059669' : 'var(--text-secondary)', to:'/einclocken' },
              { icon:'🌴', label:'Urlaub offen', value: stats.pendingVac, color: stats.pendingVac > 0 ? '#D97706' : 'var(--text-secondary)', to:'/urlaub', badge: stats.pendingVac > 0 },
              { icon:'🔄', label:'Schichttausch', value: stats.pendingSwaps, color: stats.pendingSwaps > 0 ? '#D97706' : 'var(--text-secondary)', to:'/schichten', badge: stats.pendingSwaps > 0 },
              { icon:'🔑', label:'Neue Accounts', value: pendingCount || 0, color: pendingCount > 0 ? '#DC2626' : 'var(--text-secondary)', to:'/benutzer', badge: pendingCount > 0 },
            ].map(s => (
              <Link key={s.label} to={s.to} style={{ textDecoration:'none' }}>
                <div className="card" style={{ padding:'16px 18px', cursor:'pointer', transition:'transform 0.1s', position:'relative' }}
                  onMouseEnter={e => e.currentTarget.style.transform='translateY(-2px)'}
                  onMouseLeave={e => e.currentTarget.style.transform='translateY(0)'}
                >
                  {s.badge && s.value > 0 && (
                    <div style={{ position:'absolute', top:10, right:10, background:'#DC2626', color:'#fff', borderRadius:99, fontSize:10, fontWeight:700, padding:'1px 6px' }}>{s.value}</div>
                  )}
                  <div style={{ fontSize:22, marginBottom:6 }}>{s.icon}</div>
                  <div style={{ fontSize:26, fontWeight:700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{s.label}</div>
                </div>
              </Link>
            ))}
          </div>
        )}



        {/* ── Tagesübersicht ── */}
        <div style={{ display:'grid', gridTemplateColumns: canManage ? '1fr 1fr' : '1fr', gap:16, marginTop:8 }}>

          {/* ── Heute im Café (Admin) ─────────────── */}
          {canManage && (
            <div className="card" style={{ minHeight:0 }}>
              <div className="card-header" style={{ paddingBottom:8 }}>
                <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
                  <div className="card-title" style={{ marginBottom:0 }}>☕ Heute im Café</div>
                  <span style={{ fontSize:12, color:'var(--text-muted)' }}>
                    {new Date().toLocaleDateString('de-DE', { weekday:'short', day:'numeric', month:'short' })}
                  </span>
                </div>
                <Link to="/schichten" style={{ fontSize:12, color:'var(--accent)', textDecoration:'none', fontWeight:500, whiteSpace:'nowrap' }}>
                  Schichtplan →
                </Link>
              </div>
              {loading ? (
                <div style={{ padding:'12px 16px', color:'var(--text-secondary)', fontSize:13 }}>Lädt…</div>
              ) : todayShifts.length === 0 ? (
                <div style={{ padding:'14px 16px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontSize:13, color:'var(--text-muted)' }}>Keine Schichten heute</span>
                  <Link to="/schichten" className="btn btn-sm" style={{ textDecoration:'none' }}>+ Anlegen</Link>
                </div>
              ) : (
                <div style={{ padding:'0 4px' }}>
                  {todayShifts.map(s => {
                    const emp      = s.employees
                    const isClockedIn = liveClockIns.some(l => l.employee_id === s.employee_id)
                    return (
                      <div key={s.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderBottom:'1px solid var(--border)' }}>
                        <Avatar src={emp?.avatar_url} firstName={emp?.first_name} lastName={emp?.last_name} color={emp?.avatar_color} size={32} />
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:500, fontSize:13 }}>{emp?.first_name} {emp?.last_name}</div>
                          <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{s.start_time?.slice(0,5)} – {s.end_time?.slice(0,5)} Uhr {s.position ? `· ${s.position}` : ''}</div>
                        </div>
                        {isClockedIn
                          ? <span style={{ fontSize:10, fontWeight:600, color:'#059669', background:'#DCFCE7', borderRadius:99, padding:'2px 8px' }}>● Aktiv</span>
                          : new Date() > new Date(`${todayDate}T${s.start_time}`)
                            ? <span style={{ fontSize:10, color:'#D97706', background:'#FEF3C7', borderRadius:99, padding:'2px 8px' }}>Nicht da</span>
                            : <span style={{ fontSize:10, color:'var(--text-muted)', background:'var(--bg)', borderRadius:99, padding:'2px 8px' }}>Kommt</span>
                        }
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Eingeclockte Mitarbeiter / Meine nächsten Schichten ── */}
          <div className="card" style={{ minHeight:0 }}>
            <div className="card-header" style={{ paddingBottom:8 }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
                <div className="card-title" style={{ marginBottom:0 }}>
                  {canManage ? '⏱ Gerade eingeclockt' : '📅 Meine nächsten Schichten'}
                </div>
                {canManage && liveClockIns.length > 0 && (
                  <span style={{ fontSize:12, fontWeight:600, color:'#059669' }}>{liveClockIns.length} aktiv</span>
                )}
              </div>
            </div>
            {canManage ? (
              liveClockIns.length === 0 ? (
                <div style={{ padding:'14px 16px' }}>
                  <span style={{ fontSize:13, color:'var(--text-muted)' }}>Niemand eingeclockt</span>
                </div>
              ) : (
                <div style={{ padding:'0 4px' }}>
                  {liveClockIns.map(e => {
                    const since = Math.floor((Date.now() - new Date(e.clock_in)) / 3600000)
                    const mins  = Math.floor(((Date.now() - new Date(e.clock_in)) % 3600000) / 60000)
                    return (
                      <div key={e.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderBottom:'1px solid var(--border)' }}>
                        <Avatar src={e.employees?.avatar_url} firstName={e.employees?.first_name} lastName={e.employees?.last_name} color={e.employees?.avatar_color} size={32} />
                        <div style={{ flex:1 }}>
                          <div style={{ fontWeight:500, fontSize:13 }}>{e.employees?.first_name} {e.employees?.last_name}</div>
                          <div style={{ fontSize:12, color:'var(--text-secondary)' }}>
                            seit {formatTime(e.clock_in)}
                            {' · '}{since > 0 ? `${since}h ` : ''}{mins}min
                          </div>
                        </div>
                        <span style={{ fontSize:12, fontWeight:600, color:'#059669' }}>{since}h {mins}min</span>
                      </div>
                    )
                  })}
                </div>
              )
            ) : (
              loading ? (
                <div style={{ padding:'20px 16px', color:'var(--text-secondary)', fontSize:13 }}>Lädt…</div>
              ) : nextShift ? (
                <div style={{ padding:'0 4px' }}>
                  {/* Nächste 3 Schichten */}
                  <div style={{ padding:'12px 12px 0' }}>
                    {nextShift && (
                      <div style={{ padding:'12px', background:'var(--accent-light)', borderRadius:8, marginBottom:8, borderLeft:'3px solid var(--accent)' }}>
                        <div style={{ fontWeight:600, fontSize:13, color:'var(--accent-text)' }}>
                          {formatShiftDay(nextShift.date)}
                        </div>
                        <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:3 }}>
                          {nextShift.start_time?.slice(0,5)} – {nextShift.end_time?.slice(0,5)} Uhr
                          {nextShift.position && ` · ${nextShift.position}`}
                        </div>
                        {until && <div style={{ fontSize:11, color:'var(--accent)', marginTop:4, fontWeight:600 }}>{until}</div>}
                      </div>
                    )}
                  </div>
                  <Link to="/schichten" style={{ display:'block', textAlign:'center', padding:'10px', color:'var(--accent)', fontSize:12, borderTop:'1px solid var(--border)', textDecoration:'none' }}>
                    Vollständigen Schichtplan →
                  </Link>
                </div>
              ) : (
                <div className="empty-state" style={{ padding:'24px 16px' }}>
                  <div className="empty-state-icon">🌴</div>
                  <div className="empty-state-text">Keine Schichten geplant</div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:4 }}>Genieße deine freie Zeit!</div>
                </div>
              )
            )}
          </div>
        </div>

        {/* ── Geburtstage ─────────────────────── */}
        {canManage && birthdays.length > 0 && (
          <div className="card" style={{ marginTop:16 }}>
            <div className="card-header"><div className="card-title">🎂 Geburtstage (nächste 30 Tage)</div></div>
            <div style={{ padding:'12px 16px', display:'flex', flexWrap:'wrap', gap:10 }}>
              {birthdays.map(emp => {
                const bd    = new Date(emp.birth_date)
                const thisY = new Date(new Date().getFullYear(), bd.getMonth(), bd.getDate())
                const diff  = Math.round((thisY - new Date().setHours(0,0,0,0)) / 86400000)
                const age   = new Date().getFullYear() - bd.getFullYear()
                return (
                  <div key={emp.id} style={{ display:'flex', alignItems:'center', gap:10, background:'var(--bg)', borderRadius:10, padding:'10px 14px', border:'1px solid var(--border)' }}>
                    <span style={{ fontSize:24 }}>{diff === 0 ? '🎉' : '🎂'}</span>
                    <div>
                      <div style={{ fontWeight:600, fontSize:13 }}>{emp.first_name} {emp.last_name}</div>
                      <div style={{ fontSize:11, color: diff === 0 ? '#059669' : 'var(--text-secondary)', fontWeight: diff === 0 ? 600 : 400 }}>
                        {diff === 0 ? `Heute! Wird ${age}` : diff === 1 ? `Morgen · ${age} Jahre` : `In ${diff} Tagen · ${age} Jahre`}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {/* ── Live Personalkosten (Admin/Manager) ── */}
        {canManage && laborCosts && (
          <div className="card" style={{ marginBottom:16 }}>
            <div className="card-header">
              <div className="card-title">💰 Live-Personalkosten</div>
              <div style={{ fontSize:11, color:'var(--text-secondary)' }}>Automatisch aus Stunden × Stundenlöhnen berechnet</div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:0 }}>
              {[
                { label:'Heute geleistet',  value:`${laborCosts.today.toFixed(2)} €`,    sub:`${laborCosts.hoursToday.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})} h gearbeitet`,    color:'var(--text-primary)' },
                { label:'Heute geplant',    value:`${laborCosts.plannedToday.toFixed(2)} €`, sub:'basierend auf Schichtplan',               color:'var(--text-secondary)' },
                { label:'Diese Woche',      value:`${laborCosts.week.toFixed(2)} €`,     sub:'Mo–heute, alle Mitarbeiter',                color: laborCosts.week > 2000 ? 'var(--warn)' : 'var(--text-primary)' },
              ].map(item => (
                <div key={item.label} style={{ padding:'14px 20px', borderRight:'1px solid var(--border)' }}>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em' }}>{item.label}</div>
                  <div style={{ fontSize:22, fontWeight:700, color: item.color }}>{item.value}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{item.sub}</div>
                </div>
              ))}
              <div style={{ padding:'14px 20px', background:'var(--accent-light)' }}>
                <div style={{ fontSize:11, color:'var(--accent)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em', fontWeight:600 }}>Lohnquote</div>
                <div style={{ fontSize:18, fontWeight:700, color:'var(--accent)' }}>
                  {laborCosts.plannedToday > 0
                    ? `${((laborCosts.today / laborCosts.plannedToday) * 100).toFixed(0)}%`
                    : '–'
                  }
                </div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>geleistet vs. geplant</div>
              </div>
            </div>
            <div style={{ padding:'8px 16px', fontSize:11, color:'var(--text-muted)', borderTop:'1px solid var(--border)' }}>
              💡 Für Lohnkosten-Umsatz-Verhältnis (Lohnquote %) ist eine Lightspeed-Integration nötig — Vorbereitung bereits vorhanden.
            </div>
          </div>
        )}

        {/* ── Offene Anträge (Admin/Manager) ── */}
        {canManage && (pendingReqs.vac.length > 0 || pendingReqs.sick.length > 0 || pendingReqs.sickReviews.length > 0) && (
          <div className="card" style={{ marginBottom:16, borderLeft:'3px solid var(--warn)' }}>
            <div className="card-header" style={{ background:'var(--warn-bg)' }}>
              <div className="card-title" style={{ color:'var(--warn)' }}>
                ⚠️ Offene Anträge — {pendingReqs.vac.length + pendingReqs.sick.length + pendingReqs.sickReviews.length} ausstehend
              </div>
            </div>
            <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:8 }}>
              {pendingReqs.vac.map(v => (
                <div key={v.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 12px', background:'var(--bg)', borderRadius:8 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontSize:18 }}>🌴</span>
                    <div>
                      <div style={{ fontWeight:600, fontSize:13 }}>{v.employees?.first_name} {v.employees?.last_name}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        Urlaubsantrag · {formatDate(v.start_date)} – {formatDate(v.end_date)} · {v.days_count} Tage
                      </div>
                    </div>
                  </div>
                  <Link to="/urlaub?tab=urlaub" className="btn btn-sm btn-primary" style={{ textDecoration:'none' }}>Prüfen →</Link>
                </div>
              ))}
              {groupSickLeavesIntoCases(pendingReqs.sick).map(sc => {
                const warnings   = getSickCaseWarnings(sc)
                const hasUrgent  = warnings.some(w => w.level === 'error')
                return (
                  <div key={sc.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 12px', background:'var(--bg)', borderRadius:8 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span style={{ fontSize:18 }}>🤒</span>
                      <div>
                        <div style={{ fontWeight:600, fontSize:13 }}>{sc.employee?.first_name} {sc.employee?.last_name}</div>
                        <div style={{ fontSize:12, color:'var(--text-secondary)' }}>
                          AU-Fall seit {formatDate(sc.start_date)}
                          {sc.leaves.length > 1 && <span style={{ marginLeft:6, color:'#7C3AED' }}>· {sc.leaves.length} Meldungen</span>}
                          {' '}· Attest fehlt
                          {hasUrgent && <span style={{ marginLeft:6, color:'#DC2626', fontWeight:600 }}>· Krankengeld prüfen</span>}
                        </div>
                      </div>
                    </div>
                    <Link to="/urlaub?tab=krank" className="btn btn-sm" style={{ textDecoration:'none' }}>Ansehen →</Link>
                  </div>
                )
              })}

              {/* §9 BUrlG — Krankmeldung während Urlaub ohne Attest */}
              {pendingReqs.sickReviews.map(sl => {
                const emp = sl.employees
                return (
                  <div key={sl.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 12px', background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span style={{ fontSize:18 }}>⚠️</span>
                      <div>
                        <div style={{ fontWeight:600, fontSize:13 }}>{emp?.first_name} {emp?.last_name}</div>
                        <div style={{ fontSize:12, color:'#92400E' }}>
                          §9 BUrlG — krank während Urlaub ab {formatDate(sl.start_date)}
                          {sl.end_date ? ` bis ${formatDate(sl.end_date)}` : ' (offen)'}
                          {' '}· <strong>Attest fehlt — Prüfung erforderlich</strong>
                        </div>
                      </div>
                    </div>
                    <Link to="/urlaub?tab=urlaub" className="btn btn-sm" style={{ textDecoration:'none', background:'#FEF3C7', color:'#92400E', border:'1px solid #FDE68A' }}>Prüfen →</Link>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
