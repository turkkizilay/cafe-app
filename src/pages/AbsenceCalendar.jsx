import { useState, useEffect } from 'react'
import { supabase, formatMonthYear } from '../lib/supabase'
import Avatar from '../components/UI/Avatar'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'

export default function AbsenceCalendar() {
  const { isAdmin, isManager } = useProfile()
  const toast = useToast()
  const now = new Date()
  const [year,      setYear]      = useState(now.getFullYear())
  const [month,     setMonth]     = useState(now.getMonth())
  const [vacations, setVacations] = useState([])
  const [sick,      setSick]      = useState([])
  const [employees, setEmployees] = useState([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => { fetchData() }, [year, month])

  async function fetchData() {
    setLoading(true)
    try {
      const pad2 = n => String(n).padStart(2,'0')
      const start = `${year}-${pad2(month+1)}-01`
      const end   = `${year}-${pad2(month+1)}-${pad2(new Date(year, month+1, 0).getDate())}`

      const [{ data: emps, error: e1 }, { data: vacs, error: e2 }, { data: sicks, error: e3 }] = await Promise.all([
        supabase.from('employees').select('id, first_name, last_name, avatar_color, avatar_url').eq('is_active', true).order('last_name'),
        supabase.from('vacation_requests').select('employee_id, start_date, end_date, status').in('status', ['approved', 'pending']).lte('start_date', end).gte('end_date', start),
        supabase.from('sick_leave').select('employee_id, start_date, end_date')
          .lte('start_date', end)
          .or(`end_date.gte.${start},end_date.is.null`),
      ])
      if (e1) toast.error('Fehler beim Laden der Mitarbeiter')
      if (e2) toast.error('Fehler beim Laden der Urlaube')
      if (e3) toast.error('Fehler beim Laden der Krankmeldungen')
      setEmployees(emps || [])
      setVacations(vacs || [])
      setSick(sicks || [])
    } catch(err) { toast.error('Fehler: ' + err.message) }
    setLoading(false)
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const days        = Array.from({ length: daysInMonth }, (_, i) => i + 1)
  const monthLabel  = formatMonthYear(year, month)
  const todayDay    = now.getFullYear() === year && now.getMonth() === month ? now.getDate() : null

  function getAbsenceType(empId, day) {
    const date = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    const vac  = vacations.find(v => v.employee_id === empId && date >= v.start_date && date <= v.end_date)
    if (vac) return vac.status === 'approved' ? 'vacation' : 'vacation-pending'
    const sickLeave = sick.find(s => s.employee_id === empId && date >= s.start_date && (!s.end_date || date <= s.end_date))
    if (sickLeave) return 'sick'
    return null
  }

  const ABSENCE_STYLE = {
    'vacation':         { background:'#059669', title:'Urlaub (genehmigt)' },
    'vacation-pending': { background:'#D97706', title:'Urlaub (ausstehend)' },
    'sick':             { background:'#DC2626', title:'Krank' },
  }

  // Summary — FIX: use .getTime() for Math.max/min (old bug: Math.max(date) = invalid)
  const absenceSummary = employees.map(emp => {
    const monthStart = new Date(year, month, 1).getTime()
    const monthEnd   = new Date(year, month + 1, 0).getTime()

    const vacDays = vacations
      .filter(v => v.employee_id === emp.id && v.status === 'approved')
      .reduce((s, v) => {
        let count = 0
        let d = new Date(Math.max(new Date(v.start_date + 'T00:00:00').getTime(), monthStart))
        const e = new Date(Math.min(new Date(v.end_date   + 'T00:00:00').getTime(), monthEnd))
        while (d <= e) { if (d.getDay()!==0 && d.getDay()!==6) count++; d.setDate(d.getDate()+1) }
        return s + count
      }, 0)

    const sickDays = sick
      .filter(s => s.employee_id === emp.id)
      .reduce((sum, s) => {
        let count = 0
        let d    = new Date(Math.max(new Date(s.start_date + 'T00:00:00').getTime(), monthStart))
        const endD = s.end_date
          ? new Date(Math.min(new Date(s.end_date + 'T00:00:00').getTime(), monthEnd))
          : new Date(monthEnd)
        while (d <= endD) { if (d.getDay()!==0 && d.getDay()!==6) count++; d.setDate(d.getDate()+1) }
        return sum + count
      }, 0)

    return { ...emp, vacDays, sickDays }
  }).filter(e => e.vacDays > 0 || e.sickDays > 0)

  function navMonth(delta) {
    const d = new Date(year, month + delta)
    setYear(d.getFullYear())
    setMonth(d.getMonth())
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Abwesenheitskalender</div>
        <div className="topbar-right">
          <button className="btn btn-sm" onClick={() => navMonth(-1)}>←</button>
          <span style={{ padding:'0 12px', fontSize:14, fontWeight:500 }}>{monthLabel}</span>
          <button className="btn btn-sm" onClick={() => navMonth(1)}>→</button>
          <button className="btn btn-sm" onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()) }}>Heute</button>
        </div>
      </div>

      <div className="content">
        {/* Legende */}
        <div style={{ display:'flex', gap:16, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
          {Object.entries(ABSENCE_STYLE).map(([key, val]) => (
            <div key={key} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12 }}>
              <div style={{ width:14, height:14, borderRadius:3, background:val.background }} />
              {val.title}
            </div>
          ))}
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12 }}>
            <div style={{ width:14, height:14, borderRadius:3, background:'var(--border)' }} />
            Wochenende
          </div>
        </div>

        {/* Zusammenfassung */}
        {absenceSummary.length > 0 && (
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:16 }}>
            {absenceSummary.map(emp => (
              <div key={emp.id} style={{ background:'var(--card)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 12px', fontSize:13, display:'flex', alignItems:'center', gap:8 }}>
                <Avatar src={emp.avatar_url} firstName={emp.first_name} lastName={emp.last_name} color={emp.avatar_color} size={24} />
                <span style={{ fontWeight:500 }}>{emp.first_name} {emp.last_name}</span>
                {emp.vacDays  > 0 && <span style={{ color:'#059669', fontSize:12 }}>🌴 {emp.vacDays}T</span>}
                {emp.sickDays > 0 && <span style={{ color:'#DC2626', fontSize:12 }}>🤒 {emp.sickDays}T</span>}
              </div>
            ))}
          </div>
        )}

        {/* Kalender */}
        {loading ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--text-muted)' }}>Lädt…</div>
        ) : employees.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon">📆</div><div className="empty-state-text">Keine aktiven Mitarbeiter</div></div>
        ) : (
          <div className="card" style={{ overflowX:'auto' }}>
            <table style={{ borderCollapse:'collapse', width:'100%', minWidth: Math.max(700, daysInMonth * 28 + 200) }}>
              <thead>
                <tr style={{ background:'var(--bg)' }}>
                  <th style={{ padding:'10px 14px', textAlign:'left', fontSize:11, fontWeight:600, textTransform:'uppercase', color:'var(--text-secondary)', minWidth:160, position:'sticky', left:0, background:'var(--bg)', zIndex:2, borderBottom:'1px solid var(--border)' }}>
                    Mitarbeiter
                  </th>
                  {days.map(d => {
                    const date = new Date(year, month, d)
                    const isWe = date.getDay()===0 || date.getDay()===6
                    const isTd = d === todayDay
                    return (
                      <th key={d} style={{
                        width:28, minWidth:28, padding:'6px 2px', textAlign:'center', fontSize:10,
                        fontWeight: isTd ? 700 : 500,
                        color: isTd ? 'var(--accent)' : isWe ? 'var(--text-muted)' : 'var(--text-secondary)',
                        background: isTd ? 'var(--accent-light)' : isWe ? 'rgba(0,0,0,0.02)' : 'var(--bg)',
                        borderBottom:'1px solid var(--border)', lineHeight:1.3,
                      }}>
                        <div>{d}</div>
                        <div style={{ fontSize:9, opacity:0.7 }}>
                          {['So','Mo','Di','Mi','Do','Fr','Sa'][date.getDay()]}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => (
                  <tr key={emp.id}>
                    <td style={{ padding:'6px 14px', borderBottom:'1px solid var(--border)', position:'sticky', left:0, background:'var(--card)', zIndex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <Avatar src={emp.avatar_url} firstName={emp.first_name} lastName={emp.last_name} color={emp.avatar_color} size={22} />
                        <span style={{ fontSize:12, fontWeight:500, whiteSpace:'nowrap' }}>{emp.first_name} {emp.last_name}</span>
                      </div>
                    </td>
                    {days.map(d => {
                      const date    = new Date(year, month, d)
                      const isWe    = date.getDay()===0 || date.getDay()===6
                      const isTd    = d === todayDay
                      const absence = getAbsenceType(emp.id, d)
                      const style   = absence ? ABSENCE_STYLE[absence] : null
                      return (
                        <td key={d} title={style ? `${emp.first_name}: ${style.title}` : undefined} style={{
                          width:28, minWidth:28, padding:2, borderBottom:'1px solid var(--border)', cursor: style ? 'pointer' : undefined,
                          background: style ? style.background : isTd ? 'var(--accent-light)' : isWe ? 'rgba(0,0,0,0.03)' : undefined,
                        }}>
                          {style && <div style={{ width:'100%', height:20, borderRadius:2 }} />}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
