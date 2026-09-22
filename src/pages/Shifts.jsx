import { useState, useEffect } from 'react'
import { supabase, formatDate, getInitials } from '../lib/supabase'
import Avatar from '../components/UI/Avatar'
import { translateSupabaseError } from '../lib/errorHelper'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { useDarkMode } from '../context/DarkModeContext'

const DAY_NAMES  = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const DAY_FULL   = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag']
const PILL_COLORS = [
  { bg:'#DBEAFE', text:'#1D4ED8' }, { bg:'#CCFBF1', text:'#0F766E' },
  { bg:'#FFE4E6', text:'#BE123C' }, { bg:'#EDE9FE', text:'#7C3AED' },
  { bg:'#FEF3C7', text:'#B45309' }, { bg:'#DCFCE7', text:'#16A34A' },
  { bg:'#FCE7F3', text:'#9D174D' }, { bg:'#E0F2FE', text:'#0369A1' },
]
const DARK_COLORS = [
  { bg:'#1E3A5F', text:'#93C5FD' }, { bg:'#0D3030', text:'#5EEAD4' },
  { bg:'#3D1515', text:'#FDA4AF' }, { bg:'#2E1B5C', text:'#C4B5FD' },
  { bg:'#3D2A06', text:'#FCD34D' }, { bg:'#0D2E1A', text:'#86EFAC' },
  { bg:'#3D1B2D', text:'#F9A8D4' }, { bg:'#0D2535', text:'#7DD3FC' },
]

const SWAP_STATUS_LABEL = {
  open:      '⏳ Offen',
  accepted:  '✅ Angenommen — wartet auf Freigabe',
  declined:  '❌ Abgelehnt',
  approved:  '✅ Genehmigt',
  rejected:  '❌ Von Chef abgelehnt',
  cancelled: '↩️ Zurückgezogen',
}

function getWeekDays(offset = 0) {
  const d = new Date(); const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1 + offset * 7)
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x })
}
// Lokales Datum als YYYY-MM-DD — KEIN toISOString() (das verschiebt in DE um 1 Tag durch UTC)
function toLocalDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
}
function getKW(d) {
  const date = new Date(d); date.setHours(0,0,0,0)
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7)
  const w1 = new Date(date.getFullYear(), 0, 4)
  return 1 + Math.round(((date - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7)
}
function isToday(d) {
  const t = new Date()
  return d.getDate()===t.getDate() && d.getMonth()===t.getMonth() && d.getFullYear()===t.getFullYear()
}

export default function Shifts() {
  const { isAdmin, isManager, profile } = useProfile()
  const toast   = useToast()
  const addGuard    = useSavingGuard()
  const updateGuard = useSavingGuard()
  const { dark: darkMode } = useDarkMode()
  const canEdit = isAdmin || isManager
  const myEmpId = profile?.employee_id
  const today   = toLocalDateStr(new Date())

  const [offset,    setOffset]    = useState(0)
  const [shifts,    setShifts]    = useState([])
  const [employees, setEmployees] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(false)
  const [form,      setForm]      = useState({})
  const [saving,    setSaving]    = useState(false)
  const [editModal,  setEditModal]  = useState(null)  // shift being edited
  const [delConfirm,  setDelConfirm]  = useState(false)
  const [arbzgWarnings, setArbzgWarnings] = useState([])

  // ── Schichttausch ────────────────────────────────────────
  const [swaps,       setSwaps]       = useState([])
  const [swapModal,   setSwapModal]   = useState(null)  // Schicht, die abgegeben werden soll
  const [swapForm,    setSwapForm]    = useState({ target_id:'', target_shift_id:'', message:'' })
  const [swapSaving,  setSwapSaving]  = useState(false)

  const days  = getWeekDays(offset)
  const start = toLocalDateStr(days[0])
  const end   = toLocalDateStr(days[6])

  useEffect(() => { fetchData() }, [offset])
  useEffect(() => { fetchSwaps() }, [])

    async function fetchData() {
    setLoading(true)
    const [{ data: s }, { data: e }] = await Promise.all([
      supabase.from('shifts')
        .select('*, employees!employee_id(id, first_name, last_name, avatar_color, avatar_url, position)')
        .gte('date', start).lte('date', end).order('start_time'),
      supabase.rpc('get_employees_directory'),
    ])
    const active = (e || [])
      .filter(emp => emp.is_active)
      .sort((a, b) => (a.last_name || '').localeCompare(b.last_name || '', 'de'))
    setShifts(s || [])
    setEmployees(active)
    setLoading(false)
  }

  async function fetchSwaps() {
    const { data, error } = await supabase.from('shift_swap_requests')
      .select(`*,
        requester:employees!requester_id(first_name, last_name, avatar_color, avatar_url),
        target:employees!target_id(first_name, last_name, avatar_color, avatar_url),
        requester_shift:shifts!requester_shift_id(date, start_time, end_time),
        target_shift:shifts!target_shift_id(date, start_time, end_time)`)
      .order('created_at', { ascending:false })
    if (error) { console.error('Tauschanfragen laden fehlgeschlagen:', error); return }
    setSwaps(data || [])
  }

  async function addShift() {
    if (!addGuard.begin()) return
    if (!form.employee_id || !form.date || !form.start_time || !form.end_time) {
      toast.warn('Bitte alle Pflichtfelder ausfüllen.'); return
    }
    // Nachtschicht-Erkennung: Start >= 20:00 und Ende <= 10:00 = gültige Nachtschicht
    const isNightShift = form.start_time >= '20:00' && form.end_time <= '10:00'
    if (!isNightShift && form.end_time <= form.start_time) {
      toast.warn('Endzeit muss nach der Startzeit liegen (außer bei Nachtschichten 20:00–10:00).'); return
    }
    setSaving(true)
    const hrs = Math.max(0, (() => {
              const s2 = new Date(`2000-01-01T${form.start_time}`).getTime()
              let   e2 = new Date(`2000-01-01T${form.end_time}`).getTime()
              if (e2 <= s2) e2 += 86400000
              return (e2 - s2) / 3600000
            })())
    const { error } = await supabase.from('shifts').insert([{ ...form, planned_hours: hrs }])
    if (error) { toast.error(translateSupabaseError(error, 'Schicht speichern')); setSaving(false); addGuard.end(); return }
    toast.success('Schicht gespeichert ✅')
    setModal(false); setSaving(false); addGuard.end(); fetchData()
  }

  async function openEditModal(shift) {
    setEditModal(shift)
    setDelConfirm(false)
    setForm({
      employee_id: shift.employee_id,
      date:        shift.date,
      start_time:  shift.start_time?.slice(0,5) || '',
      end_time:    shift.end_time?.slice(0,5) || '',
      position:    shift.position || '',
      notes:       shift.notes || '',
    })
  }

  async function updateShift() {
    if (!updateGuard.begin()) return
    if (!form.start_time || !form.end_time) { toast.warn('Zeiten eingeben'); updateGuard.end(); return }
    const isNight = form.start_time >= '20:00' && form.end_time <= '10:00'
    if (!isNight && form.end_time <= form.start_time) { toast.warn('Endzeit nach Startzeit'); return }
    setSaving(true)
    const s2 = new Date(`2000-01-01T${form.start_time}`).getTime()
    let e2   = new Date(`2000-01-01T${form.end_time}`).getTime()
    if (e2 <= s2) e2 += 86400000
    const hrs = Math.max(0, (e2 - s2) / 3600000)
    await supabase.from('shifts').update({ ...form, planned_hours: hrs }).eq('id', editModal.id)
    toast.success('Schicht aktualisiert ✅')
    setEditModal(null); setSaving(false); updateGuard.end(); fetchData()
  }

  async function deleteShift(id) {
    if (saving) return
    setSaving(true)
    await supabase.from('shifts').delete().eq('id', id)
    toast.success('Schicht gelöscht')
    setEditModal(null); setDelConfirm(false); fetchData()
  }

  // ── Schichttausch: Anfrage stellen ──────────────────────
  function openSwapModal(shift) {
    setSwapModal(shift)
    setSwapForm({ target_id:'', target_shift_id:'', message:'' })
  }

  async function submitSwap() {
    if (!swapForm.target_id) { toast.warn('Bitte Kolleg*in auswählen.'); return }
    setSwapSaving(true)
    const { error } = await supabase.from('shift_swap_requests').insert([{
      requester_id:       myEmpId,
      requester_shift_id: swapModal.id,
      target_id:          swapForm.target_id,
      target_shift_id:    swapForm.target_shift_id || null,
      message:             swapForm.message?.trim() || null,
    }])
    setSwapSaving(false)
    if (error) { toast.error(translateSupabaseError(error, 'Tauschanfrage')); return }
    toast.success('Tauschanfrage gesendet ✅')
    setSwapModal(null)
    fetchSwaps()
  }

  async function respondSwap(id, accept) {
    const { error } = await supabase.from('shift_swap_requests')
      .update({ status: accept ? 'accepted' : 'declined' }).eq('id', id)
    if (error) { toast.error(translateSupabaseError(error, 'Antwort')); return }
    toast.success(accept ? 'Angenommen — wartet auf Freigabe durch den Chef ✅' : 'Abgelehnt')
    fetchSwaps()
  }

  async function cancelSwap(id) {
    const { error } = await supabase.from('shift_swap_requests')
      .update({ status:'cancelled' }).eq('id', id)
    if (error) { toast.error(translateSupabaseError(error, 'Zurückziehen')); return }
    toast.success('Tauschanfrage zurückgezogen')
    fetchSwaps()
  }

  // ── Schichttausch: Admin-Freigabe (führt Schichten tatsächlich zusammen) ──
  async function approveSwap(swap) {
    setSwapSaving(true)
    try {
      if (swap.target_shift_id) {
        // Beide Schichten tauschen die Mitarbeiter
        const r1 = await supabase.from('shifts').update({ employee_id: swap.target_id }).eq('id', swap.requester_shift_id)
        if (r1.error) throw r1.error
        const r2 = await supabase.from('shifts').update({ employee_id: swap.requester_id }).eq('id', swap.target_shift_id)
        if (r2.error) throw r2.error
      } else {
        // Schicht wird nur übernommen
        const r1 = await supabase.from('shifts').update({ employee_id: swap.target_id }).eq('id', swap.requester_shift_id)
        if (r1.error) throw r1.error
      }
      const r3 = await supabase.from('shift_swap_requests').update({
        status: 'approved', approved_by: profile.id, approved_at: new Date().toISOString(),
      }).eq('id', swap.id)
      if (r3.error) throw r3.error
      toast.success('Tausch genehmigt & Schichtplan aktualisiert ✅')
      fetchSwaps(); fetchData()
    } catch (err) {
      toast.error('Fehler bei der Genehmigung: ' + (err.message || err))
    }
    setSwapSaving(false)
  }

  async function rejectSwap(id) {
    const { error } = await supabase.from('shift_swap_requests').update({ status:'rejected' }).eq('id', id)
    if (error) { toast.error(translateSupabaseError(error, 'Ablehnen')); return }
    toast.success('Tauschanfrage abgelehnt')
    fetchSwaps()
  }

  // ── §3 & §5 ArbZG Compliance Check ──────────────────────
  function checkArbZG(empId, date, startTime, endTime) {
    const warnings = []

    // §3 ArbZG: Max 10h/Tag
    const s = new Date(`2000-01-01T${startTime}`).getTime()
    let e   = new Date(`2000-01-01T${endTime}`).getTime()
    if (e <= s) e += 86400000 // Nachtschicht
    const hrs = (e - s) / 3600000
    if (hrs > 10) warnings.push(`⚠️ §3 ArbZG: ${hrs.toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1})} h überschreitet die gesetzliche Tageshöchstarbeitszeit von 10 Stunden`)

    // §5 ArbZG: Min 11h Ruhezeit
    const [year, month, day] = date.split('-').map(Number)
    const prevDate = toLocalDateStr(new Date(year, month-1, day-1))
    const nextDate = toLocalDateStr(new Date(year, month-1, day+1))

    const prevShifts = shifts.filter(sh => sh.employee_id === empId && sh.date === prevDate)
    const nextShifts = shifts.filter(sh => sh.employee_id === empId && sh.date === nextDate)

    for (const prev of prevShifts) {
      const prevEnd   = new Date(`${prevDate}T${prev.end_time || '23:59'}:00`)
      const thisStart = new Date(`${date}T${startTime}:00`)
      const rest = (thisStart - prevEnd) / 3600000
      if (rest < 11 && rest > 0)
        warnings.push(`⚠️ §5 ArbZG: Nur ${rest.toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1})} h Ruhezeit seit letzter Schicht — gesetzlich erforderlich: 11h`)
    }
    for (const next of nextShifts) {
      const thisEnd   = new Date(`${date}T${endTime}:00`)
      const nextStart = new Date(`${nextDate}T${next.start_time || '00:00'}:00`)
      const rest = (nextStart - thisEnd) / 3600000
      if (rest < 11 && rest > 0)
        warnings.push(`⚠️ §5 ArbZG: Nur ${rest.toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1})} h Ruhezeit bis zur nächsten Schicht — gesetzlich erforderlich: 11h`)
    }

    // §9 ArbZG: Sonntagsarbeit markieren
    const dow = new Date(date).getDay()
    if (dow === 0) warnings.push(`ℹ️ §9 ArbZG: Sonntagsarbeit — besonderer gesetzlicher Schutz`)

    return warnings
  }

  function f(k, v) {
    const newForm = { ...form, [k]: v }
    setForm(newForm)
    // Live ArbZG check beim Tippen
    if (newForm.employee_id && newForm.date && newForm.start_time && newForm.end_time) {
      setArbzgWarnings(checkArbZG(newForm.employee_id, newForm.date, newForm.start_time, newForm.end_time))
    }
  }

  const empColorMap = {}
  employees.forEach((e, i) => { empColorMap[e.id] = i % PILL_COLORS.length })

  const weekHours = {}
  shifts.forEach(s => { weekHours[s.employee_id] = (weekHours[s.employee_id] || 0) + (s.planned_hours || 0) })

  const totalWeekHours = Object.values(weekHours).reduce((a,b) => a+b, 0)

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">
          Schichtplan — KW {getKW(days[0])} · {formatDate(start)} – {formatDate(end)}
        </div>
        <div className="topbar-right">
          <button className="btn btn-sm" onClick={() => setOffset(o => o-1)}>← Zurück</button>
          <button className="btn btn-sm" onClick={() => setOffset(0)} style={{ fontWeight: offset===0 ? 600 : 400 }}>Heute</button>
          <button className="btn btn-sm" onClick={() => setOffset(o => o+1)}>Vor →</button>
          {canEdit && (
            <button className="btn btn-primary btn-sm" onClick={() => {
              setForm({ employee_id: employees[0]?.id||'', date: today, start_time:'08:00', end_time:'16:00', position:'', notes:'' })
              setModal(true)
            }}>+ Schicht</button>
          )}
        </div>
      </div>

      <div className="content">
        {/* Summary Stats for Admin */}
        {canEdit && (
          <div className="stats-grid mb-5" style={{ gridTemplateColumns:'repeat(4, 1fr)' }}>
            <div className="stat-card">
              <div className="stat-label">Mitarbeiter</div>
              <div className="stat-value">{employees.length}</div>
              <div className="stat-sub">aktiv</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Schichten diese Woche</div>
              <div className="stat-value">{shifts.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Gesamt Stunden</div>
              <div className="stat-value">{totalWeekHours.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Ø pro Mitarbeiter</div>
              <div className="stat-value">
                {employees.length ? (totalWeekHours / employees.length).toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1}) : '0'} h
              </div>
            </div>
          </div>
        )}

        {/* Meine nächste Schicht - für Mitarbeiter */}
        {!canEdit && myEmpId && (() => {
          const upcoming = shifts
            .filter(s => s.employee_id === myEmpId && s.date >= today)
            .sort((a,b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time))
          const next = upcoming[0]
          if (!next) return null
          const d = new Date(next.date)
          return (
            <div className="alert alert-info mb-5" style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <span style={{ fontSize:20 }}>📅</span>
              <div>
                <div style={{ fontWeight:600 }}>Deine nächste Schicht</div>
                <div style={{ fontSize:13, marginTop:2 }}>
                  {d.toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long' })} · {next.start_time?.slice(0,5)} – {next.end_time?.slice(0,5)} Uhr
                  {next.position && <span style={{ marginLeft:8, opacity:0.7 }}>({next.position})</span>}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Shift Grid */}
        <div className="card">
          <div style={{ overflowX:'auto' }}>
            {loading ? <div style={{ padding:24 }}>Lädt…</div> : (
              <table style={{ minWidth: 720, borderCollapse:'collapse', width:'100%' }}>
                <thead>
                  <tr style={{ background:'var(--bg)' }}>
                    <th style={{ padding:'10px 16px', textAlign:'left', fontSize:11, fontWeight:600, letterSpacing:'.04em', textTransform:'uppercase', color:'var(--text-secondary)', width:160, borderBottom:'1px solid var(--border)' }}>
                      Mitarbeiter
                    </th>
                    {days.map((d, i) => {
                      const isWe = d.getDay()===0 || d.getDay()===6
                      const isTd = isToday(d)
                      return (
                        <th key={i} style={{
                          padding:'8px 4px', textAlign:'center', fontSize:11, fontWeight:600,
                          letterSpacing:'.04em', textTransform:'uppercase',
                          color: isTd ? 'var(--accent-text)' : 'var(--text-secondary)',
                          background: isTd ? 'var(--accent-light)' : isWe ? 'rgba(0,0,0,0.02)' : undefined,
                          minWidth:92, borderBottom:`1px solid var(--border)`,
                          borderLeft: isTd ? '2px solid var(--accent)' : undefined,
                        }}>
                          <div style={{ fontWeight: isTd ? 700 : 600 }}>{DAY_NAMES[i]}</div>
                          <div style={{ fontWeight:400, fontSize:12 }}>{d.getDate()}.{d.getMonth()+1}.</div>
                        </th>
                      )
                    })}
                    <th style={{ padding:'8px 12px', textAlign:'center', fontSize:11, fontWeight:600, letterSpacing:'.04em', textTransform:'uppercase', color:'var(--text-secondary)', width:60, borderBottom:'1px solid var(--border)' }}>
                      Summe
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employees.length === 0 ? (
                    <tr><td colSpan="9"><div className="empty-state"><div className="empty-state-text">Noch keine Mitarbeiter</div></div></td></tr>
                  ) : employees.map(emp => {
                    const colorIdx = empColorMap[emp.id] ?? 0
                    const colors = darkMode ? DARK_COLORS[colorIdx] : PILL_COLORS[colorIdx]
                    const isMe = emp.id === myEmpId
                    const hrs = weekHours[emp.id] || 0
                    return (
                      <tr key={emp.id} style={{ background: isMe && !canEdit ? 'rgba(194,121,58,0.04)' : undefined }}>
                        <td style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', verticalAlign:'middle' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <Avatar src={emp.avatar_url} firstName={emp.first_name}
                              lastName={emp.last_name} color={emp.avatar_color} size={28} />
                            <div>
                              <div style={{ fontSize:13, fontWeight: isMe ? 600 : 500 }}>
                                {emp.first_name} {emp.last_name}
                                {isMe && <span style={{ fontSize:10, marginLeft:6, color:'var(--accent)' }}>Ich</span>}
                              </div>
                              {emp.position && <div style={{ fontSize:11, color:'var(--text-muted)' }}>{emp.position}</div>}
                            </div>
                          </div>
                        </td>
                        {days.map((d, i) => {
                          const ds       = toLocalDateStr(d)
                          const isWe     = d.getDay()===0 || d.getDay()===6
                          const isTd     = isToday(d)
                          const dayShifts = shifts.filter(s => s.employee_id === emp.id && s.date === ds)
                          return (
                            <td key={i} className={`shift-cell${isTd?' today':isWe?' weekend':''}`} style={{
                              borderBottom:'1px solid var(--border)',
                              borderLeft: isTd ? '2px solid var(--accent)' : '1px solid var(--border)',
                            }}>
                              {dayShifts.length === 0
                                ? <span
                                    style={{ fontSize:11, color:'var(--text-muted)', display:'block', cursor: canEdit ? 'pointer' : 'default', padding:'8px 4px' }}
                                    title={canEdit ? 'Klicken um Schicht anzulegen' : ''}
                                    onClick={canEdit ? () => {
                                      setForm({ employee_id: emp.id, date: ds, start_time:'08:00', end_time:'16:00', position:'', notes:'' })
                                      setModal(true)
                                    } : undefined}
                                  >–</span>
                                : dayShifts.map(s => {
                                    const mine      = s.employee_id === myEmpId
                                    const clickable = canEdit || (mine && s.date >= today)
                                    return (
                                      <div key={s.id}
                                        className={`shift-pill${mine?' mine':''}`}
                                        style={{ ...colors, margin:'2px 0', display:'block', cursor: clickable ? 'pointer' : 'default' }}
                                        title={canEdit ? 'Klicken zum Bearbeiten' : mine && s.date >= today ? 'Klicken um Tausch anzufragen' : `${DAY_FULL[i]} · ${s.start_time?.slice(0,5)}–${s.end_time?.slice(0,5)}`}
                                        onClick={canEdit ? () => openEditModal(s) : (mine && s.date >= today ? () => openSwapModal(s) : undefined)}
                                      >
                                        {s.start_time?.slice(0,5)}–{s.end_time?.slice(0,5)}
                                      </div>
                                    )
                                  })
                              }
                            </td>
                          )
                        })}
                        <td style={{ padding:'8px', textAlign:'center', borderBottom:'1px solid var(--border)' }}>
                          {(() => {
                            // Datenschutz: Normale Mitarbeiter sehen nur eigene Wochenstunden
                            if (!canEdit && !isMe) return <span style={{ color:'var(--text-muted)', fontSize:12 }}>–</span>
                            const target = emp.hours_per_week ? emp.hours_per_week / 5 * 5 : null
                            const color = hrs === 0 ? 'var(--text-muted)'
                              : target && hrs < target * 0.8 ? '#DC2626'
                              : target && hrs >= target * 0.95 ? '#16A34A'
                              : 'var(--warn)'
                            return (
                              <div>
                                <div style={{ fontWeight:700, fontSize:13, color }}>{hrs > 0 ? `${hrs.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h` : '–'}</div>
                                {target && hrs > 0 && (
                                  <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:1 }}>/ {target.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h</div>
                                )}
                              </div>
                            )
                          })()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {canEdit && employees.length > 0 && (
                  <tfoot>
                    <tr style={{ background:'var(--bg)' }}>
                      <td style={{ padding:'10px 16px', fontWeight:600, fontSize:12, color:'var(--text-secondary)' }}>Gesamt</td>
                      {days.map((d, i) => {
                        const ds = toLocalDateStr(d)
                        const dayTotal = shifts.filter(s => s.date === ds).reduce((a, s) => a + (s.planned_hours || 0), 0)
                        return (
                          <td key={i} style={{ textAlign:'center', padding:'10px 4px', fontSize:12, fontWeight:600, color: dayTotal > 0 ? 'var(--accent-text)' : 'var(--text-muted)' }}>
                            {dayTotal > 0 ? `${dayTotal.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h` : '–'}
                          </td>
                        )
                      })}
                      <td style={{ textAlign:'center', padding:'10px 8px', fontWeight:700, color:'var(--accent-text)' }}>
                        {totalWeekHours.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:0})} h
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>
          {canEdit && (
            <div style={{ padding:'10px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
              💡 Schicht klicken = bearbeiten · Leere Zelle klicken = neue Schicht für diesen Mitarbeiter & Tag
            </div>
          )}
          {!canEdit && (
            <div style={{ padding:'10px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
              💡 Eigene, zukünftige Schicht klicken = Tausch/Abgabe anfragen
            </div>
          )}
        </div>

        {/* ── Tauschanfragen ── */}
        <div className="card" style={{ marginTop:16 }}>
          <div className="card-header">
            <div className="card-title">🔄 Tauschanfragen</div>
            {canEdit && swaps.filter(s => s.status==='accepted').length > 0 && (
              <span style={{ fontSize:12, fontWeight:600, color:'#DC2626' }}>
                {swaps.filter(s => s.status==='accepted').length} warten auf Freigabe
              </span>
            )}
          </div>
          {swaps.length === 0 ? (
            <div style={{ padding:'14px 16px', fontSize:13, color:'var(--text-muted)' }}>Keine Tauschanfragen</div>
          ) : (
            <div style={{ padding:'4px 0' }}>
              {swaps.map(sw => {
                const isToMe   = sw.target_id === myEmpId
                const isFromMe = sw.requester_id === myEmpId
                return (
                  <div key={sw.id} style={{ padding:'10px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                    <div style={{ fontSize:13, maxWidth:520 }}>
                      <strong>{sw.requester?.first_name} {sw.requester?.last_name}</strong> möchte Schicht am{' '}
                      {sw.requester_shift ? formatDate(sw.requester_shift.date) : '–'}
                      {' '}({sw.requester_shift?.start_time?.slice(0,5)}–{sw.requester_shift?.end_time?.slice(0,5)}) abgeben an{' '}
                      <strong>{sw.target?.first_name} {sw.target?.last_name}</strong>
                      {sw.target_shift && (
                        <> · Tausch gegen {formatDate(sw.target_shift.date)} ({sw.target_shift.start_time?.slice(0,5)}–{sw.target_shift.end_time?.slice(0,5)})</>
                      )}
                      {sw.message && <div style={{ color:'var(--text-secondary)', marginTop:2 }}>„{sw.message}"</div>}
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{SWAP_STATUS_LABEL[sw.status] || sw.status}</div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                      {isToMe && sw.status==='open' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => respondSwap(sw.id, true)}>Annehmen</button>
                          <button className="btn btn-sm" onClick={() => respondSwap(sw.id, false)}>Ablehnen</button>
                        </>
                      )}
                      {isFromMe && sw.status==='open' && (
                        <button className="btn btn-sm" onClick={() => cancelSwap(sw.id)}>Zurückziehen</button>
                      )}
                      {canEdit && sw.status==='accepted' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => approveSwap(sw)} disabled={swapSaving}>✓ Genehmigen</button>
                          <button className="btn btn-sm" onClick={() => rejectSwap(sw.id)}>Ablehnen</button>
                        </>
                      )}
                      {canEdit && sw.status==='open' && (
                        <button className="btn btn-sm" onClick={() => rejectSwap(sw.id)}>Ablehnen</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Edit/Delete Shift Modal ── */}
      {editModal && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setEditModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">✏️ Schicht bearbeiten</div>
              <button className="btn btn-sm" onClick={() => setEditModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background:'var(--bg)', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:12, color:'var(--text-secondary)' }}>
                📅 {formatDate(editModal.date)} · {employees.find(e => e.id === editModal.employee_id)?.first_name || ''} {employees.find(e => e.id === editModal.employee_id)?.last_name || ''}
              </div>
              <div className="two-col">
                <div className="form-group"><label>Beginn</label><input type="time" value={form.start_time} onChange={e => f('start_time', e.target.value)} /></div>
                <div className="form-group"><label>Ende</label><input type="time" value={form.end_time} onChange={e => f('end_time', e.target.value)} /></div>
              </div>
              {form.start_time && form.end_time && (
                <div className="alert alert-info" style={{ marginBottom:12 }}>
                  ⏱ {(() => {
                    const s2 = new Date(`2000-01-01T${form.start_time}`).getTime()
                    let e2   = new Date(`2000-01-01T${form.end_time}`).getTime()
                    if (e2 <= s2) e2 += 86400000
                    return Math.max(0,(e2-s2)/3600000).toFixed(1)
                  })()}h geplant
                </div>
              )}
              <div className="form-group"><label>Position (optional)</label><input value={form.position||''} onChange={e => f('position', e.target.value)} placeholder="Barista, Service…" /></div>
              <div className="form-group"><label>Notiz (optional)</label><input value={form.notes||''} onChange={e => f('notes', e.target.value)} /></div>

              {/* Delete section */}
              {!delConfirm ? (
                <button onClick={() => setDelConfirm(true)} className="btn btn-sm" style={{ border:'1px solid var(--danger)', color:'var(--danger)', background:'none', marginTop:8 }}>
                  🗑 Schicht löschen
                </button>
              ) : (
                <div style={{ background:'#FEF2F2', borderRadius:8, padding:'12px', marginTop:8 }}>
                  <div style={{ fontSize:13, marginBottom:10, color:'var(--danger)' }}>Schicht wirklich löschen?</div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button className="btn btn-danger" onClick={() => deleteShift(editModal.id)}>Ja, löschen</button>
                    <button className="btn" onClick={() => setDelConfirm(false)}>Abbrechen</button>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setEditModal(null)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={updateShift} disabled={saving}>{saving ? '…' : '💾 Speichern'}</button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(false)}>
          <div className="modal">
            <div className="modal-header"><div className="modal-title">📅 Schicht anlegen</div><button className="btn btn-sm" onClick={() => setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form-group">
                <label>Mitarbeiter</label>
                <select value={form.employee_id} onChange={e => f('employee_id', e.target.value)}>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                </select>
              </div>
              <div className="form-group"><label>Datum</label><input type="date" value={form.date} onChange={e => f('date', e.target.value)} /></div>
              <div className="two-col">
                <div className="form-group"><label>Beginn</label><input type="time" value={form.start_time} onChange={e => f('start_time', e.target.value)} /></div>
                <div className="form-group"><label>Ende</label><input type="time" value={form.end_time} onChange={e => f('end_time', e.target.value)} /></div>
              </div>
              {form.start_time && form.end_time && (
                <div className="alert alert-info">
                  ⏱ {(() => {
                  const s = new Date(`2000-01-01T${form.start_time}`).getTime()
                  let e = new Date(`2000-01-01T${form.end_time}`).getTime()
                  if (e <= s) e += 86400000
                  return Math.max(0,(e-s)/3600000).toFixed(1)
                })()}h geplant{form.start_time >= '20:00' && form.end_time <= '10:00' ? ' (Nachtschicht)' : ''}
                </div>
              )}
              <div className="form-group"><label>Position (optional)</label><input value={form.position||''} onChange={e => f('position', e.target.value)} placeholder="Barista, Service…" /></div>
              <div className="form-group"><label>Notiz (optional)</label><input value={form.notes||''} onChange={e => f('notes', e.target.value)} /></div>
            </div>
            {arbzgWarnings.length > 0 && (
              <div style={{ margin:'0 0 12px', display:'flex', flexDirection:'column', gap:6 }}>
                {arbzgWarnings.map((w,i) => (
                  <div key={i} style={{ background: w.startsWith('⚠️') ? '#FEF3C7' : '#EFF6FF', borderRadius:8, padding:'8px 12px', fontSize:12, color: w.startsWith('⚠️') ? '#92400E' : '#1D4ED8' }}>
                    {w}
                  </div>
                ))}
              </div>
            )}
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={addShift} disabled={saving}>{saving?'…':'💾 Schicht speichern'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tausch anfragen Modal ── */}
      {swapModal && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setSwapModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">🔄 Schicht abgeben / tauschen</div>
              <button className="btn btn-sm" onClick={() => setSwapModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background:'var(--bg)', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:12, color:'var(--text-secondary)' }}>
                📅 {formatDate(swapModal.date)} · {swapModal.start_time?.slice(0,5)}–{swapModal.end_time?.slice(0,5)} Uhr
              </div>
              <div className="form-group">
                <label>An wen? *</label>
                <select value={swapForm.target_id} onChange={e => setSwapForm({ ...swapForm, target_id:e.target.value, target_shift_id:'' })}>
                  <option value="">– Kolleg*in wählen –</option>
                  {employees.filter(e => e.id !== myEmpId).map(e => (
                    <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                  ))}
                </select>
              </div>
              {swapForm.target_id && (
                <div className="form-group">
                  <label>Gegen Schicht tauschen (optional)</label>
                  <select value={swapForm.target_shift_id} onChange={e => setSwapForm({ ...swapForm, target_shift_id:e.target.value })}>
                    <option value="">– Nur abgeben, kein Tausch –</option>
                    {shifts.filter(s => s.employee_id === swapForm.target_id).map(s => (
                      <option key={s.id} value={s.id}>{formatDate(s.date)} · {s.start_time?.slice(0,5)}–{s.end_time?.slice(0,5)}</option>
                    ))}
                  </select>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Nur Schichten der aktuell angezeigten Woche wählbar.</div>
                </div>
              )}
              <div className="form-group">
                <label>Nachricht (optional)</label>
                <input value={swapForm.message} onChange={e => setSwapForm({ ...swapForm, message:e.target.value })} placeholder="z. B. Grund für den Tausch" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setSwapModal(null)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={submitSwap} disabled={swapSaving}>{swapSaving ? '…' : '🔄 Anfrage senden'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
