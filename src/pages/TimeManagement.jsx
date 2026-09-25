import { t as tr, getIntlLocale, message as appMessage, errorMessage, messageParts } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect } from 'react'
import { supabase, toLocalDateStr } from '../lib/supabase'
import { formatDate } from '../i18n/format.js'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { logActivity } from '../lib/activityLog'
import Avatar from '../components/UI/Avatar'

const EMPTY_FORM = {
  employee_id: '', date: toLocalDateStr(new Date()),
  clock_in_time: '08:00', clock_out_time: '16:00',
  break_minutes: 30, notes: '', reason: '',
}

function toISO(date, time) { return new Date(`${date}T${time}:00`).toISOString() }
function toTime(iso) {
  if (!iso) return '–'
  return new Date(iso).toLocaleTimeString(getIntlLocale(), { hour:'2-digit', minute:'2-digit' })
}
function calcHours(clockIn, clockOut, breakMin) {
  if (!clockIn || !clockOut) return null
  return Math.max(0, (new Date(clockOut) - new Date(clockIn)) / 3600000 - (breakMin||0) / 60)
}

const MONTHS = () => [tr("ui.5c5db120cb11"),tr("ui.caf71b3f582d"),tr("ui.adbbd95def15"),tr("ui.617531b4fec3"),tr("ui.d77b6bd0886e"),tr("ui.b27fd46ed1b6"),tr("ui.c43f56b9807e"),tr("ui.41e1d82aa990"),tr("ui.451e2b719061"),tr("ui.56ccd5de9e3a"),tr("ui.3e630d2964a0"),tr("ui.d8325218c0dc")]

export default function TimeManagement() {
  useLocale()
  const { profile } = useProfile()
  const toast      = useToast()
  const saveGuard   = useSavingGuard()
  const deleteGuard = useSavingGuard()

  const now = new Date()
  const [employees,    setEmployees]    = useState([])
  const [entries,      setEntries]      = useState([])
  const [filterEmp,    setFilterEmp]    = useState('')
  const [filterMode,   setFilterMode]   = useState('month')
  const [filterYear,   setFilterYear]   = useState(now.getFullYear())
  const [filterMonth,  setFilterMonth]  = useState(now.getMonth() + 1)
  const [filterDate,   setFilterDate]   = useState(toLocalDateStr(now))
  const [loading,      setLoading]      = useState(false)
  const [modal,        setModal]        = useState(null)
  const [form,         setForm]         = useState(EMPTY_FORM)
  const [saving,       setSaving]       = useState(false)
  const [deleteModal,  setDeleteModal]  = useState(null)
  const [deleteReason, setDeleteReason] = useState('')

  useEffect(() => {
    supabase.from('employees')
      .select('id, first_name, last_name, avatar_url, avatar_color')
      .eq('is_active', true).order('last_name')
      .then(({ data }) => {
        setEmployees(data || [])
        if (data?.length) setFilterEmp(data[0].id)
      })
  }, [])

  useEffect(() => { if (filterEmp) fetchEntries() }, [filterEmp, filterMode, filterYear, filterMonth, filterDate])

  function getDateRange() {
    const pad = n => String(n).padStart(2,'0')
    if (filterMode === 'day')   return { start: filterDate, end: filterDate }
    if (filterMode === 'month') {
      const last = new Date(filterYear, filterMonth, 0).getDate()
      return { start: `${filterYear}-${pad(filterMonth)}-01`, end: `${filterYear}-${pad(filterMonth)}-${last}` }
    }
    if (filterMode === 'week') {
      const d = new Date(filterDate), day = d.getDay() || 7
      const mon = new Date(d); mon.setDate(d.getDate() - day + 1)
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
      return { start: toLocalDateStr(mon), end: toLocalDateStr(sun) }
    }
  }

  async function fetchEntries() {
    setLoading(true)
    const { start, end } = getDateRange()
    const { data, error } = await supabase
      .from('time_entries').select('*')
      .eq('employee_id', filterEmp)
      .gte('date', start).lte('date', end)
      .order('date').order('clock_in')
    if (error) toast.error(messageParts([appMessage("ui.60efe70adb51"), errorMessage(error)]))
    setEntries(data || [])
    setLoading(false)
  }

  function openAdd() {
    const date = filterMode === 'month'
      ? `${filterYear}-${String(filterMonth).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`
      : filterDate
    setForm({ ...EMPTY_FORM, employee_id: filterEmp, date })
    setModal('add')
  }

  function openEdit(entry) {
    setForm({
      id:             entry.id,
      employee_id:    entry.employee_id,
      date:           entry.date,
      clock_in_time:  toTime(entry.clock_in),
      clock_out_time: entry.clock_out ? toTime(entry.clock_out) : '',
      break_minutes:  entry.break_minutes || 0,
      notes:          entry.notes?.replace('[ADMIN-KORREKTUR]','').replace(/⚠️ AUSSTEMPELN VERGESSEN[^)]*\)/, '').trim() || '',
      reason:         '',
    })
    setModal('edit')
  }

  // Guard wird immer freigegeben — vorher blieb „Speichern“ nach einem Fehler tot
  async function handleSave() {
    if (!saveGuard.begin()) return
    try { await doSave() } finally { saveGuard.end(); setSaving(false) }
  }

  async function doSave() {
    if (!form.reason.trim()) { toast.warn(appMessage("ui.9631f4375e40")); return }
    if (!form.clock_in_time)  { toast.warn(appMessage("ui.3d4194b88e7c")); return }
    if (form.clock_out_time && form.clock_out_time <= form.clock_in_time) {
      toast.warn(appMessage("ui.ae51b9542766")); return
    }
    setSaving(true)
    const clockIn  = toISO(form.date, form.clock_in_time)
    const clockOut = form.clock_out_time ? toISO(form.date, form.clock_out_time) : null
    const hoursNet = clockOut ? calcHours(clockIn, clockOut, form.break_minutes) : null
    const payload  = {
      employee_id:   form.employee_id, date: form.date, clock_in: clockIn, clock_out: clockOut,
      break_minutes: parseInt(form.break_minutes)||0,
      hours_worked:  hoursNet ? parseFloat(hoursNet.toFixed(2)) : null,
      notes:         `[ADMIN-KORREKTUR] ${form.notes}`.trim(), approved: true,
    }
    let entryId = form.id, oldValue = null
    if (modal === 'add') {
      const { data, error } = await supabase.from('time_entries').insert([payload]).select().maybeSingle()
      if (error) { toast.error(errorMessage(error)); setSaving(false); return }
      entryId = data.id
    } else {
      const orig = entries.find(e => e.id === form.id)
      oldValue = `${toTime(orig?.clock_in)} – ${toTime(orig?.clock_out)}`
      const { error } = await supabase.from('time_entries').update(payload).eq('id', form.id)
      if (error) { toast.error(errorMessage(error)); setSaving(false); return }
    }
    await supabase.from('time_corrections').insert([{
      time_entry_id: entryId, employee_id: form.employee_id, corrected_by: profile.id,
      field_changed: modal === 'add' ? 'new_entry' : 'manual_edit',
      old_value: oldValue, new_value: `${form.clock_in_time} – ${form.clock_out_time}`,
      reason: form.reason,
    }])
    toast.success(appMessage("ui.29f204c81646", { p1: (modal === 'add' ? (appMessage("ui.d5601d043f1d")) : (appMessage("time.corrected"))) }))

    // Protokoll
    const tEmp = employees.find(e => e.id === form.employee_id)
    const tEmpName = tEmp ? `${tEmp.first_name} ${tEmp.last_name}` : 'einem Mitarbeiter'
    logActivity({
      action:   modal === 'add' ? 'time.created' : 'time.corrected',
      category: 'time',
      summary:  modal === 'add'
        ? `hat einen Zeiteintrag für ${tEmpName} erstellt.`
        : `hat einen Zeiteintrag von ${tEmpName} korrigiert.`,
      targetType: 'time_entry', targetId: entryId, targetName: tEmpName,
    })

    setModal(null); fetchEntries()
  }

  async function confirmDelete() {
    if (!deleteGuard.begin()) return
    if (!deleteReason.trim()) { toast.warn(appMessage("ui.f45548749dce")); deleteGuard.end(); return }
    const entry = deleteModal
    await supabase.from('time_corrections').insert([{
      time_entry_id: entry.id, employee_id: entry.employee_id, corrected_by: profile.id,
      field_changed: 'deleted', old_value: `${toTime(entry.clock_in)} – ${toTime(entry.clock_out)}`,
      reason: deleteReason,
    }])
    const { error } = await supabase.from('time_entries').delete().eq('id', entry.id)
    if (error) { toast.error(errorMessage(error)); return }
    setDeleteModal(null); setDeleteReason('')
    toast.success(appMessage("ui.0473ea60b74c"))

    // Protokoll
    const dEmp = employees.find(e => e.id === entry.employee_id)
    const dEmpName = dEmp ? `${dEmp.first_name} ${dEmp.last_name}` : 'einem Mitarbeiter'
    logActivity({
      action: 'time.deleted', category: 'time',
      summary: `hat einen Zeiteintrag von ${dEmpName} gelöscht.`,
      targetType: 'time_entry', targetId: entry.id, targetName: dEmpName,
    })

    deleteGuard.end(); fetchEntries()
  }

  function f(k, v) { setForm(x => ({ ...x, [k]: v })) }

  const emp          = employees.find(e => e.id === filterEmp)
  const totalHours   = entries.reduce((s, e) => s + (e.hours_worked || 0), 0)
  const corrections  = entries.filter(e => e.notes?.includes('ADMIN-KORREKTUR')).length
  const openEntries  = entries.filter(e => !e.clock_out).length

  return (
    <>
      {/* ── Topbar ── */}
      <div className="topbar">
        <div className="topbar-title">{tr("ui.1ba6ae4c4865")}</div>
        <span style={{
          background:'var(--warn-bg)', color:'var(--warn)',
          fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:20
        }}>{tr("ui.f1b8a23093f9")}</span>
      </div>

      <div className="content">

        {/* ── Filter & Controls ── */}
        <div className="card" style={{ marginBottom:16 }}>
          <div style={{ padding:'14px 16px' }}>
            <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end' }}>

              {/* Mitarbeiter */}
              <div className="form-group" style={{ flex:2, minWidth:200, marginBottom:0 }}>
                <label style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4, display:'block' }}>{tr("ui.11e2057afa0a")}</label>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  {emp && <Avatar src={emp.avatar_url} firstName={emp.first_name} lastName={emp.last_name} color={emp.avatar_color} size={28} />}
                  <select value={filterEmp} onChange={e => setFilterEmp(e.target.value)} style={{ flex:1 }}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                  </select>
                </div>
              </div>

              {/* Zeitraum */}
              <div style={{ marginBottom:0 }}>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{tr("ui.3594b0cda44a")}</div>
                <div style={{ display:'flex', gap:4 }}>
                  {[['day',tr("ui.1503916a2ab2")],['week',tr("ui.8a2727c044bc")],['month',tr("ui.2933070469a2")]].map(([v,l]) => (
                    <button key={v}
                      className={`btn btn-sm${filterMode===v?' btn-primary':''}`}
                      onClick={() => setFilterMode(v)}>{l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Monat/Jahr oder Datum */}
              {filterMode === 'month' && (<>
                <div style={{ marginBottom:0 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{tr("ui.6777913d1812")}</div>
                  <select value={filterMonth} onChange={e => setFilterMonth(+e.target.value)}>
                    {MONTHS().map((m,i) => <option key={i} value={i+1}>{m}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom:0 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{tr("ui.5e01a9cc2f7d")}</div>
                  <select value={filterYear} onChange={e => setFilterYear(+e.target.value)}>
                    {[now.getFullYear()-1, now.getFullYear()].map(y => <option key={y}>{y}</option>)}
                  </select>
                </div>
              </>)}
              {(filterMode === 'day' || filterMode === 'week') && (
                <div style={{ marginBottom:0 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{tr("ui.c9ca6e51f4b7")}</div>
                  <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} />
                </div>
              )}

              <button className="btn btn-primary" style={{ marginLeft:'auto' }} onClick={openAdd}>{tr("ui.76c7dfd50b13")}</button>
            </div>
          </div>
        </div>

        {/* ── Stats Row ── */}
        {entries.length > 0 && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:12, marginBottom:16 }}>
            {[
              { label:tr("ui.b46a6b65c674"),    value: entries.length,           color:'var(--text-primary)', icon:'📋' },
              { label:tr("ui.30cb3e5a9be1"),value:`${totalHours.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})} h`, color:'var(--accent)',       icon:'⏱' },
              { label:tr("ui.694c97010e14"), value: corrections,              color: corrections > 0 ? 'var(--warn)' : 'var(--text-muted)', icon:'✏️' },
              { label:tr("ui.c7b5414e0129"),  value: openEntries,              color: openEntries > 0 ? 'var(--danger)' : 'var(--text-muted)', icon:'🟡' },
            ].map((s, labelIndex) => (
              <div key={labelIndex} className="card" style={{ padding:'12px 14px', textAlign:'center' }}>
                <div style={{ fontSize:18, marginBottom:4 }}>{s.icon}</div>
                <div style={{ fontSize:20, fontWeight:700, color:s.color }}>{s.value}</div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Einträge Tabelle ── */}
        <div className="card">
          <div className="card-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              {emp && <Avatar src={emp.avatar_url} firstName={emp.first_name} lastName={emp.last_name} color={emp.avatar_color} size={28} />}
              <div>
                <div className="card-title" style={{ marginBottom:0 }}>
                  {emp ? `${emp.first_name} ${emp.last_name}` : ''}
                </div>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>
                  {filterMode === 'month' && `${MONTHS()[filterMonth-1]} ${filterYear}`}
                  {filterMode === 'day'   && formatDate(filterDate)}
                  {filterMode === 'week'  && tr("ui.00717ca30e4e", { p1: (formatDate(filterDate)) })}
                </div>
              </div>
            </div>
            {entries.length > 0 && (
              <div style={{ fontSize:13, fontWeight:700, color:'var(--accent)' }}>
                {totalHours.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.9324e90d9a81")}</div>
            )}
          </div>

          {loading ? (
            <div style={{ padding:32, textAlign:'center', color:'var(--text-muted)' }}>{tr("ui.ebbb1d1f265f")}</div>
          ) : entries.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">⏰</div>
              <div className="empty-state-text">{tr("ui.416e30fd13e8")}</div>
              <button className="btn btn-primary" style={{ marginTop:12 }} onClick={openAdd}>{tr("ui.b64da933b65c")}</button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{tr("ui.9135882d323c")}</th>
                    <th>{tr("ui.7527c410788b")}</th>
                    <th>{tr("ui.2d604d899b88")}</th>
                    <th>{tr("ui.858e4ba7a29f")}</th>
                    <th>{tr("ui.c821d25643d9")}</th>
                    <th>{tr("ui.920e413c7d41")}</th>
                    <th style={{ width:100, textAlign:'center' }}>{tr("ui.5656f92db78d")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => {
                    const isKorr  = e.notes?.includes('ADMIN-KORREKTUR')
                    const isOffen = !e.clock_out
                    return (
                      <tr key={e.id} style={{ background: isKorr ? 'var(--warn-bg)' : undefined }}>
                        <td style={{ fontWeight:500 }}>{formatDate(e.date)}</td>
                        <td>{toTime(e.clock_in)}</td>
                        <td>
                          {isOffen
                            ? <span style={{ background:'#DCFCE7', color:'#16A34A', fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20 }}>{tr("ui.8163454f378f")}</span>
                            : toTime(e.clock_out)
                          }
                        </td>
                        <td style={{ color:'var(--text-secondary)' }}>
                          {e.break_minutes ? `${e.break_minutes} min` : '–'}
                        </td>
                        <td>
                          <strong style={{ color: e.hours_worked > 10 ? 'var(--danger)' : e.hours_worked > 8 ? 'var(--warn)' : 'var(--text-primary)' }}>
                            {e.hours_worked ? `${e.hours_worked}h` : '–'}
                          </strong>
                          {e.hours_worked > 10 && <div style={{ fontSize:10, color:'var(--danger)' }}>{tr("ui.532521fee4ac")}</div>}
                        </td>
                        <td>
                          {isKorr && (
                            <span style={{ background:'#FEF3C7', color:'#92400E', fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20 }}>{tr("ui.838dd5024bca")}</span>
                          )}
                          {!isKorr && (e.gps_ok_in || e.clock_in_method === 'wlan') && (
                            <span style={{ background:'#DCFCE7', color:'#16A34A', fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20 }}>
                              {e.clock_in_method === 'wlan' ? '📶 WLAN' : e.clock_in_method === 'gps+wlan' ? '📍📶 GPS+WLAN' : '📍 GPS'}
                            </span>
                          )}
                          {!isKorr && !isOffen && !e.gps_ok_in && e.clock_in_method !== 'wlan' && (
                            <span style={{ color:'var(--text-muted)', fontSize:12 }}>{tr("ui.a7248eeb45eb")}</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display:'flex', gap:6, justifyContent:'center' }}>
                            <button
                              onClick={() => openEdit(e)}
                              style={{ padding:'5px 10px', fontSize:12, fontWeight:500, border:'1px solid var(--border)', borderRadius:6, background:'var(--card)', cursor:'pointer', color:'var(--text-primary)' }}
                            >{tr("ui.84e45ee73411")}</button>
                            <button
                              onClick={() => { setDeleteModal(e); setDeleteReason('') }}
                              style={{ padding:'5px 10px', fontSize:12, fontWeight:500, border:'1px solid var(--danger)', borderRadius:6, background:'none', cursor:'pointer', color:'var(--danger)' }}
                            >{tr("ui.6c2d352161df")}</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background:'var(--bg)', fontWeight:600 }}>
                    <td colSpan={4} style={{ padding:'10px 12px', fontSize:13 }}>
                      {entries.length} {entries.length === 1 ? tr("ui.99b9259f15b1") : tr("ui.b46a6b65c674")}{tr("ui.c3f435d37b8f")}</td>
                    <td style={{ padding:'10px 12px', color:'var(--accent)', fontSize:14 }}>
                      {totalHours.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Korrektur Modal ── */}
      {modal && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">
                {modal === 'add' ? tr("ui.2d8939a4920c") : tr("ui.bb0fc617733f")}
              </div>
              <button className="btn btn-sm" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background:'var(--warn-bg)', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:12, color:'var(--warn)' }}>{tr("ui.cf92b4aac09b")}</div>
              <div className="form-group">
                <label>{tr("ui.f4cb6891b9e5")}</label>
                <select value={form.employee_id} onChange={e => f('employee_id', e.target.value)}>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>{tr("ui.9135882d323c")}</label>
                <input type="date" value={form.date} onChange={e => f('date', e.target.value)} />
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.7527c410788b")}</label>
                  <input type="time" value={form.clock_in_time} onChange={e => f('clock_in_time', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>{tr("ui.574b19674395")}<span style={{ fontSize:10, fontWeight:400, color:'var(--text-muted)' }}>{tr("ui.e8ec76d20c43")}</span></label>
                  <input type="time" value={form.clock_out_time} onChange={e => f('clock_out_time', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>{tr("ui.858e4ba7a29f")}</label>
                <select value={form.break_minutes} onChange={e => f('break_minutes', e.target.value)}>
                  {[0,15,30,45,60].map(m => <option key={m} value={m}>{m ? `${m} min` : tr("ui.fbf22ce00e55")}</option>)}
                </select>
              </div>
              {form.clock_in_time && form.clock_out_time && (
                <div style={{ background:'var(--accent-light)', borderRadius:8, padding:'10px 12px', marginBottom:12, fontSize:13 }}>{tr("ui.e82f7c50fd79")}<strong>
                    {Math.max(0, (new Date(`2000-01-01T${form.clock_out_time}`) - new Date(`2000-01-01T${form.clock_in_time}`)) / 3600000 - form.break_minutes/60).toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</strong>
                </div>
              )}
              <div className="form-group">
                <label>{tr("ui.df7efab02cb2")}<span style={{ fontSize:10, fontWeight:400, color:'var(--text-muted)' }}>{tr("ui.0059798b7f70")}</span></label>
                <input value={form.notes} onChange={e => f('notes', e.target.value)} placeholder={tr("ui.918824a84e2f")} />
              </div>
              <div className="form-group">
                <label>{tr("ui.d12d9e3308c9")}<span style={{ color:'var(--danger)' }}>*</span></label>
                <textarea rows="2" value={form.reason} onChange={e => f('reason', e.target.value)}
                  placeholder={tr("ui.fda440ff39d6")}
                  style={{ borderColor: !form.reason ? 'var(--danger)' : undefined }} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving || !form.reason.trim()}>
                {saving ? tr("ui.d2c1c54d11df") : tr("ui.ad9633c5cf21")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lösch-Bestätigung ── */}
      {deleteModal && (
        <div className="modal-overlay" onClick={() => setDeleteModal(null)}>
          <div className="modal" style={{ maxWidth:400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{tr("ui.afd2099fb2c5")}</div>
              <button className="btn btn-sm" onClick={() => setDeleteModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background:'#FEF2F2', borderRadius:8, padding:'12px', marginBottom:14, fontSize:13 }}>
                <strong>{formatDate(deleteModal.date)}</strong>
                {' — '}{toTime(deleteModal.clock_in)}{tr("ui.cffcbd9e175f")}{toTime(deleteModal.clock_out)}
                <br/>
                <span style={{ fontSize:11, color:'var(--text-secondary)', marginTop:4, display:'block' }}>{tr("ui.ae0378f3d657")}</span>
              </div>
              <div className="form-group">
                <label>{tr("ui.cc7074ca86ce")}<span style={{ color:'var(--danger)' }}>*</span></label>
                <textarea rows="2" value={deleteReason} onChange={e => setDeleteReason(e.target.value)}
                  placeholder={tr("ui.ce69cde66a25")}
                  style={{ borderColor: !deleteReason ? 'var(--danger)' : undefined }} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setDeleteModal(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-danger" onClick={confirmDelete} disabled={!deleteReason.trim()}>{tr("ui.bf575592ae35")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
