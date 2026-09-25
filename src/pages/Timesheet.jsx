import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase, toLocalDateStr } from '../lib/supabase'
import { useProfile } from '../context/ProfileContext'
import { BrandBadge } from '../components/UI/Brand'

/**
 * Arbeitszeitnachweis pro Mitarbeiter und Monat (§ 17 MiLoG, § 16 Abs. 2 ArbZG).
 * Druckfertig für A4 – „Drucken“ → „Als PDF sichern“ erzeugt die PDF.
 * Mitarbeiter sehen nur sich selbst (zusätzlich serverseitig per RLS abgesichert).
 */
const TZ = 'Europe/Berlin'
const WD = () => [tr("ui.fb1df1a24e3f"),tr("ui.d23e867e38e8"),tr("ui.16ab72874809"),tr("ui.d8f33a13ae6e"),tr("ui.30094e0bec00"),tr("ui.eed8f901692d"),tr("ui.a951efc79deb")]
const EMPLOYMENT = { get vollzeit() { return tr("ui.49dbe1b0b4b3") }, get teilzeit() { return tr("ui.df763b1cc689") }, get minijob() { return tr("ui.b3fc8da9deb1") }, get werkstudent() { return tr("ui.fa23b3bc413a") }, get aushilfe() { return tr("ui.a3b603fc40b9") }, get azubi() { return tr('employment.apprentice') } }

const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString(getIntlLocale(), { hour:'2-digit', minute:'2-digit', timeZone: TZ }) : ''
const fmtH = h => `${Number(h || 0).toLocaleString(getIntlLocale(), { minimumFractionDigits:2, maximumFractionDigits:2 })} h`
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric' })

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number)
  const first = new Date(y, m - 1, 1), last = new Date(y, m, 0)
  return { y, m, first: toLocalDateStr(first), last: toLocalDateStr(last), days: last.getDate() }
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const validYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '')

export default function Timesheet() {
  useLocale()
  const { profile, isAdmin, isManager } = useProfile() || {}
  const canManage = isAdmin || isManager
  const [params, setParams] = useSearchParams()
  const nowYm = toLocalDateStr().slice(0, 7)
  const ym = validYm(params.get('monat')) ? params.get('monat') : nowYm
  const empParam = params.get('ma') || ''
  const selected = canManage ? (empParam || 'all') : (profile?.employee_id || '')

  const [cafe, setCafe]       = useState(null)
  const [emps, setEmps]       = useState([])
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [showFormer, setShowFormer] = useState(false)

  const b = useMemo(() => monthBounds(ym), [ym])

  function setParam(k, v) {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v); else n.delete(k)
    setParams(n, { replace: true })
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError('')
      try {
        const empQuery = supabase.from('employees')
          .select('id, first_name, last_name, employment_type, position, is_active, start_date, end_date')
          .order('last_name')
        const onlyMe = !canManage
        if (onlyMe && !profile?.employee_id) { setEmps([]); setData(null); return }
        const [cafeRes, empRes, teRes, vacRes, sickRes, holRes] = await Promise.all([
          supabase.from('cafe_settings').select('cafe_name, address, bundesland').eq('id', 1).maybeSingle(),
          onlyMe ? empQuery.eq('id', profile.employee_id) : empQuery,
          (onlyMe ? supabase.from('time_entries').select('*').eq('employee_id', profile.employee_id) : supabase.from('time_entries').select('*'))
            .gte('date', b.first).lte('date', b.last).order('clock_in'),
          (onlyMe ? supabase.from('vacation_requests').select('employee_id, start_date, end_date, status').eq('employee_id', profile.employee_id) : supabase.from('vacation_requests').select('employee_id, start_date, end_date, status'))
            .eq('status', 'approved').lte('start_date', b.last).gte('end_date', b.first),
          (onlyMe ? supabase.from('sick_leave').select('employee_id, start_date, end_date').eq('employee_id', profile.employee_id) : supabase.from('sick_leave').select('employee_id, start_date, end_date'))
            .lte('start_date', b.last),
          supabase.from('public_holidays').select('date, name, bundesland').gte('date', b.first).lte('date', b.last),
        ])
        const firstErr = [empRes, teRes, vacRes, sickRes].find(r => r.error)
        if (firstErr) throw firstErr.error
        if (cancelled) return
        setCafe(cafeRes.data || null)
        setEmps(empRes.data || [])
        setData({
          te: teRes.data || [],
          vac: vacRes.data || [],
          sick: (sickRes.data || []).filter(s => !s.end_date || s.end_date >= b.first),
          hol: Object.fromEntries((holRes.data || []).filter(h => !h.bundesland || h.bundesland === (cafeRes.data?.bundesland || 'Hessen')).map(h => [h.date, h.name])),
        })
      } catch {
        if (!cancelled) setError(appMessage("ui.0230be9ae660"))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [ym, canManage, profile?.employee_id])

  // Welche Mitarbeiter erscheinen? „Alle“ = aktiv im Monat oder mit Einträgen im Monat
  const sheetEmps = useMemo(() => {
    if (!data) return []
    const withEntries = new Set(data.te.map(t => t.employee_id))
    const employedInMonth = e => (!e.start_date || e.start_date <= b.last) && (!e.end_date || e.end_date >= b.first)
    if (selected === 'all') return emps.filter(e => withEntries.has(e.id) || (e.is_active && employedInMonth(e)))
    return emps.filter(e => e.id === selected)
  }, [data, emps, selected, b])

  const monthLabel = new Date(b.y, b.m - 1, 1).toLocaleDateString(getIntlLocale(), { month:'long', year:'numeric' })
  const pickerEmps = emps.filter(e => showFormer || e.is_active || e.id === selected)

  return (
    <>
      <div className="topbar no-print">
        <div className="topbar-title">{tr("ui.7e62fb83eeda")}</div>
      </div>
      <div className="content ts-page">
        <div className="card no-print" style={{ marginBottom:16 }}>
          <div className="card-body" style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'flex-end' }}>
            <div className="form-group" style={{ margin:0 }}>
              <label>{tr("ui.2933070469a2")}</label>
              <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                <button className="btn btn-sm" onClick={() => setParam('monat', shiftMonth(ym, -1))} aria-label={tr("ui.907bc90e2035")}>‹</button>
                <input type="month" value={ym} max={nowYm} onChange={e => validYm(e.target.value) && setParam('monat', e.target.value)} style={{ width:170 }} />
                <button className="btn btn-sm" onClick={() => setParam('monat', shiftMonth(ym, 1))} disabled={ym >= nowYm} aria-label={tr("ui.4e9ac155ff93")}>›</button>
              </div>
            </div>
            {canManage && (
              <div className="form-group" style={{ margin:0, minWidth:220 }}>
                <label>{tr("ui.f4cb6891b9e5")}</label>
                <select value={selected} onChange={e => setParam('ma', e.target.value === 'all' ? '' : e.target.value)}>
                  <option value="all">{tr("ui.6e45dcdf9899")}{monthLabel})</option>
                  {pickerEmps.map(e => <option key={e.id} value={e.id}>{e.last_name}, {e.first_name}{!e.is_active ? tr("ui.ea2d394a7ea4") : ''}</option>)}
                </select>
                <label style={{ display:'flex', gap:6, alignItems:'center', fontSize:12, marginTop:4, fontWeight:400 }}>
                  <input type="checkbox" checked={showFormer} onChange={e => setShowFormer(e.target.checked)} />{tr("ui.017240ff0119")}</label>
              </div>
            )}
            <div style={{ flex:1 }} />
            <button className="btn btn-primary" onClick={() => window.print()} disabled={loading || !sheetEmps.length}>{tr("ui.197d7ae2d1bd")}</button>
          </div>
          <div style={{ padding:'0 16px 12px', fontSize:12, color:'var(--text-muted)' }}>{tr("ui.73b61df128e0")}</div>
        </div>

        {loading && <div className="no-print" style={{ padding:24, color:'var(--text-secondary)' }}>{tr("ui.ebbb1d1f265f")}</div>}
        {!loading && error && <div className="alert alert-danger no-print">{localizeMessage(error)}</div>}
        {!loading && !error && !canManage && !profile?.employee_id && (
          <div className="alert alert-warn">{tr("ui.fa13cdbb912b")}</div>
        )}
        {!loading && !error && data && sheetEmps.length === 0 && (canManage || profile?.employee_id) && (
          <div className="alert alert-info no-print">{tr("ui.ce37b04c32ab")}{monthLabel}{tr("ui.70f17d06d37c")}</div>
        )}

        {!loading && !error && data && (
          <div className="ts-sheets">
            {sheetEmps.map(emp => <Sheet key={emp.id} emp={emp} cafe={cafe} data={data} b={b} monthLabel={monthLabel} />)}
          </div>
        )}

        {!canManage && (
          <div className="no-print" style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:8 }}>{tr("ui.0cb538cef1aa")}<Link to="/stunden">{tr("ui.118b014699ee")}</Link>
          </div>
        )}
      </div>
    </>
  )
}

function Sheet({ emp, cafe, data, b, monthLabel }) {
  useLocale()
  const entries = data.te.filter(t => t.employee_id === emp.id)
  const byDay = {}
  entries.forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t) })
  const today = toLocalDateStr()
  const inRange = (d, s, e) => d >= s && (!e || d <= e)
  // Offene Krankmeldung (ohne Ende) nur bis heute zählen
  const inSick = (d, s, e) => d >= s && d <= (e || today)
  const vac  = data.vac.filter(v => v.employee_id === emp.id)
  const sick = data.sick.filter(s => s.employee_id === emp.id)

  const rows = []
  let sumH = 0, workDays = 0, vacDays = 0, sickDays = 0, openCount = 0, forgotCount = 0
  for (let day = 1; day <= b.days; day++) {
    const d = `${b.y}-${String(b.m).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    const wd = new Date(d + 'T00:00:00').getDay()
    const weekend = wd === 0 || wd === 6
    const hol = data.hol[d]
    const isVac = vac.some(v => inRange(d, v.start_date, v.end_date))
    const isSick = sick.some(s => inSick(d, s.start_date, s.end_date))
    const absence = isSick ? tr("ui.be1600b499c6") : isVac ? tr("ui.35d3a889824d") : hol ? tr("ui.7da052b999c6", { p1: (hol) }) : ''
    if (isSick) sickDays++
    else if (isVac && !weekend && !hol) vacDays++
    const list = byDay[d] || []
    if (list.length) workDays++
    if (!list.length) {
      rows.push({ key: d, d, wd, weekend, first: true, note: absence })
    } else {
      list.forEach((t, i) => {
        const forgotten = (t.notes || '').includes('AUSSTEMPELN VERGESSEN')
        const corrected = (t.notes || '').includes('ADMIN-KORREKTUR')
        if (!t.clock_out) openCount++
        if (forgotten) forgotCount++
        if (t.clock_out && !forgotten) sumH += Number(t.hours_worked || 0)
        const notes = [absence && i === 0 ? absence : '', !t.clock_out ? tr("ui.53ae2084444b") : '',
          forgotten ? tr("ui.bfcdfe902d8c") : '', corrected ? tr("ui.f685c14a2d0d") : ''].filter(Boolean)
        rows.push({ key: t.id, d, wd, weekend, first: i === 0, t, forgotten, note: notes.join(' · ') })
      })
    }
  }

  const created = new Date().toLocaleString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone: TZ })

  return (
    <div className="ts-sheet">
      <div className="ts-head">
        <div style={{ display:'flex', gap:12, alignItems:'center' }}>
          <BrandBadge size={46} />
          <div>
            <div style={{ fontWeight:700, fontSize:15 }}>{cafe?.cafe_name || 'Café Buur'}</div>
            <div style={{ fontSize:11, whiteSpace:'pre-line', color:'#444' }}>{cafe?.address || ''}</div>
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontWeight:700, fontSize:16 }}>{tr("ui.2ee8d088f45d")}</div>
          <div style={{ fontSize:13 }}>{monthLabel}</div>
          <div style={{ fontSize:10, color:'#555' }}>{tr("ui.059b12e727e2")}</div>
        </div>
      </div>

      <div className="ts-emp">
        <div><span>{tr("ui.13418d2280b5")}</span><strong>{emp.first_name} {emp.last_name}</strong></div>
        <div><span>{tr("ui.50614a65c54c")}</span><strong>{EMPLOYMENT[emp.employment_type] || emp.employment_type || '–'}{emp.position ? ` · ${emp.position}` : ''}</strong></div>
        <div><span>{tr("ui.ab0f2fd5b250")}</span><strong>{fmtDate(b.first)} – {fmtDate(b.last)}</strong></div>
      </div>

      <table className="ts-table">
        <thead>
          <tr><th>{tr("ui.9135882d323c")}</th><th>{tr("ui.1503916a2ab2")}</th><th>{tr("ui.0d95fd6a769f")}</th><th>{tr("ui.2ddcd606c872")}</th><th>{tr("ui.858e4ba7a29f")}</th><th className="num">{tr("ui.b574d367e922")}</th><th>{tr("ui.f97b7aa0e9d3")}</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className={r.weekend ? 'ts-we' : ''}>
              <td>{r.first ? fmtDate(r.d).slice(0, 6) : ''}</td>
              <td>{r.first ? WD()[r.wd] : ''}</td>
              <td>{r.t ? fmtTime(r.t.clock_in) : ''}</td>
              <td>{r.t ? (r.t.clock_out ? fmtTime(r.t.clock_out) : '—') : ''}</td>
              <td>{r.t?.clock_out ? tr("ui.f6c1459ae2f9", { p1: (r.t.break_minutes || 0) }) : ''}</td>
              <td className="num">{r.t?.clock_out ? (r.forgotten ? '—' : fmtH(r.t.hours_worked)) : ''}</td>
              <td className="note">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="ts-sum">
        <div><span>{tr("ui.7daa78462728")}</span><strong>{fmtH(sumH)}</strong></div>
        <div><span>{tr("ui.8a6685681a4f")}</span><strong>{workDays}</strong></div>
        <div><span>{tr("ui.be197acfa59b")}</span><strong>{vacDays}</strong></div>
        <div><span>{tr("ui.4e6abc6e6549")}</span><strong>{sickDays}</strong></div>
      </div>
      {(openCount > 0 || forgotCount > 0) && (
        <div className="ts-warn">
          ⚠️ {openCount > 0 ? tr("timesheet.openEntries", { count: openCount }) : ''}{forgotCount > 0 ? tr("timesheet.forgotten", { count: forgotCount }) : ''}
        </div>
      )}
      <div style={{ fontSize:10, color:'#555', marginTop:6 }}>{tr("ui.9f9667bee298")}</div>

      <div className="ts-sign">
        <div><div className="line" />{tr("ui.79f7d82e6d91")}</div>
        <div><div className="line" />{tr("ui.0b32b6970c58")}</div>
      </div>
      <div className="ts-foot">{tr("ui.6f11644c3b29")}{created}{tr("ui.4e2866d1f2b9")}</div>
    </div>
  )
}
