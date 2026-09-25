import { t as tr, getIntlLocale, message as appMessage, errorMessage, messageParts, formatParam } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect } from 'react'
import Avatar from '../components/UI/Avatar'
import { supabase } from '../lib/supabase'
import { formatCurrency } from '../i18n/format.js'
import { logActivity } from '../lib/activityLog'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'

const MINIJOB_LIMIT      = 603    // € / Monat 2026 (§ 8 Abs. 1 Nr. 1 SGB IV)
const WERKSTUDENT_LIMIT  = 80     // Stunden / Monat (interne Regel Café Buur)

// Lokales Datum als YYYY-MM-DD — KEIN toISOString() (verschiebt in DE um 1 Tag durch UTC)
function toLocalDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
}

/**
 * §11 BUrlG (Urlaubsentgelt) & §3 EFZG (Lohnfortzahlung im Krankheitsfall):
 * Zählt bezahlte Abwesenheitstage (Werktage) im Zeitraum, die NICHT bereits
 * durch eine erfasste Arbeitszeit an diesem Tag abgedeckt sind.
 *
 * Vereinfachung (siehe Audit-Bericht C5): bewertet wird mit den vertraglichen
 * Ø-Tagesstunden (hours_per_week / 5), NICHT mit dem exakten 13-Wochen-
 * Durchschnittsverdienst nach §11 BUrlG. Für Mitarbeiter mit stark
 * schwankenden Stunden bitte mit der Steuerberaterin abstimmen.
 *
 * Krankheit zählt nur innerhalb des Lohnfortzahlungszeitraums (§3 EFZG,
 * max. 6 Wochen, siehe sick_leave.continued_pay_end). Danach zahlt die
 * Krankenkasse Krankengeld — nicht der Arbeitgeber, daher hier nicht erfasst.
 * Urlaub hat dagegen kein Zeitlimit.
 * Überschneiden sich Urlaub und Krankheit an einem Tag, hat Krankheit Vorrang
 * (konsistent mit §9 BUrlG-Logik in vacationLogic.js).
 *
 * Attest-Pflicht (konsistent mit §9 BUrlG-Logik in vacationLogic.js): eine
 * Krankmeldung zählt hier nur dann als bezahlter Lohnfortzahlungstag, wenn
 * ein Attest vorliegt (certificate_received === true ODER certificate_file_path
 * gesetzt). Es gibt serverseitig KEINE Datumsbereichs-Prüfung für sick_leave-
 * INSERTs (nur clientseitig in validateSickLeaveInput()) — ohne dieses Gate
 * würde eine unbestätigte, selbst gemeldete Krankmeldung sofort und in voller
 * Höhe ins Bruttogehalt einfließen.
 */
function getPaidAbsenceDays(empVacations, empSickLeaves, workedDatesSet, rangeStart, rangeEnd) {
  let vacationDays = 0, sickDays = 0
  const d     = new Date(rangeStart + 'T12:00:00')
  const end   = new Date(rangeEnd   + 'T12:00:00')
  const today = toLocalDateStr(new Date())
  while (d <= end) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) {
      const ds = toLocalDateStr(d)
      if (!workedDatesSet.has(ds)) {
        const sick = (empSickLeaves || []).find(s => {
          if (!s.continued_pay_end) return false   // ohne Trigger-Wert kein Lohnfortzahlungs-Tag (defensiv)
          const hasAttest = s.certificate_received === true || !!s.certificate_file_path
          if (!hasAttest) return false   // ohne Attest kein bezahlter Lohnfortzahlungstag (siehe vacationLogic.js-Konvention)
          const sickEnd = s.end_date || today
          return ds >= s.start_date && ds <= sickEnd && ds <= s.continued_pay_end
        })
        if (sick) {
          sickDays++
        } else {
          const vac = (empVacations || []).find(v => ds >= v.start_date && ds <= v.end_date)
          if (vac) vacationDays++
        }
      }
    }
    d.setDate(d.getDate() + 1)
  }
  return { vacationDays, sickDays }
}

const EMP_TYPE_LABEL = { get vollzeit() { return tr("ui.49dbe1b0b4b3") }, get teilzeit() { return tr("ui.df763b1cc689") }, get werkstudent() { return tr("ui.fa23b3bc413a") }, get minijob() { return tr("ui.b3fc8da9deb1") } }

function calcOvertime(emp, actualHours, monthTarget) {
  switch (emp.employment_type) {
    case 'werkstudent': return { overtime: Math.max(0, actualHours - WERKSTUDENT_LIMIT), limit: WERKSTUDENT_LIMIT, type:'stunden' }
    case 'minijob':     return { overtime: Math.max(0, actualHours - MINIJOB_LIMIT/emp.hourly_rate), limit: MINIJOB_LIMIT/emp.hourly_rate, type:'stunden' }
    default:            return { overtime: Math.max(0, actualHours - monthTarget), limit: monthTarget, type:'stunden' }
  }
}

function OvertimeBadge({ emp, overtime, actualHours, limit, earnings }) {
  useLocale()
  if (emp.employment_type === 'minijob') {
    // Minijob-Grenze zählt das TATSÄCHLICH ausgezahlte Brutto — inkl. bezahltem
    // Urlaub & Lohnfortzahlung bei Krankheit, nicht nur die gearbeiteten Stunden.
    const pct       = Math.min(100, (earnings / MINIJOB_LIMIT) * 100)
    const remaining = MINIJOB_LIMIT - earnings
    const color     = pct > 95 ? '#DC2626' : pct > 80 ? '#D97706' : '#16A34A'
    return (
      <div>
        <div style={{ marginBottom:4 }}>
          {earnings > MINIJOB_LIMIT
            ? <span className="badge badge-red">🚨 {formatCurrency(earnings - MINIJOB_LIMIT)}{tr("ui.5a195fba17e0")}</span>
            : earnings > MINIJOB_LIMIT * 0.85
            ? <span className="badge badge-amber">{tr("ui.493476141032")}{formatCurrency(remaining)}</span>
            : <span className="badge badge-green">{tr("ui.239432c12bae")}{formatCurrency(remaining)}</span>
          }
        </div>
        <div style={{ background:'var(--border)', borderRadius:3, height:4, width:80 }}>
          <div style={{ background:color, borderRadius:3, height:4, width:`${pct}%` }} />
        </div>
      </div>
    )
  }
  if (overtime > 0) return <span className="badge badge-amber">+{overtime.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</span>
  if (actualHours === 0) return <span className="badge badge-gray">{tr("ui.9481cea66957")}</span>
  return <span className="badge badge-green">–</span>
}


// DATEV-kompatibler CSV-Export für Steuerberaterin Frau Todt
function exportDATEV(rows, monthLabel) {
  const EMP_TYPE_DATEV = { vollzeit:'Vollzeit', teilzeit:'Teilzeit', werkstudent:'Werkstudent', minijob:'Geringfügig' }
  const headers = ['Personalnummer','Nachname','Vorname','Beschäftigungsart','Stunden Soll','Stunden Ist','Urlaubsstunden (§11 BUrlG)','Krankheitsstunden (Lohnfortzahlung §3 EFZG)','Überstunden','Stundenlohn EUR','Bruttolohn EUR','Hinweise']
  const rows_csv = rows.map((r, i) => [
    String(i+1).padStart(4,'0'),
    r.last_name, r.first_name,
    EMP_TYPE_DATEV[r.employment_type] || r.employment_type,
    r.monthTarget.toFixed(2).replace('.',','),
    r.actualHours.toFixed(2).replace('.',','),
    (r.vacationHours || 0).toFixed(2).replace('.',','),
    (r.sickHours || 0).toFixed(2).replace('.',','),
    r.overtime > 0 ? r.overtime.toFixed(2).replace('.',',') : '0,00',
    r.hourly_rate.toFixed(2).replace('.',','),
    r.total.toFixed(2).replace('.',','),
    r.isAlert ? (r.employment_type==='minijob' ? 'MINIJOB-GRENZE PRÜFEN' : 'ÜBERSTUNDEN') : ''
  ])
  const csv = [headers, ...rows_csv].map(row => row.map(v => `"${v}"`).join(';')).join('\n')
  const BOM = '﻿'  // UTF-8 BOM für Excel/DATEV
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `Cafe-Buur-Lohn-${monthLabel}.csv`; a.click()
  URL.revokeObjectURL(url)
}

export default function Payroll() {
  useLocale()
  const { isAdmin } = useProfile()
  const toast = useToast()
  const now = new Date()
  const [year,        setYear]        = useState(now.getFullYear())
  const [month,       setMonth]       = useState(now.getMonth() + 1)
  const [rows,        setRows]        = useState([])
  const [loading,     setLoading]     = useState(true)
  const [filter,      setFilter]      = useState('all') // all | overtime | alert
  const [isFinalized, setIsFinalized] = useState(false)
  const [finalizing,  setFinalizing]  = useState(false)

  function handleDatevExport(filtered, monthLabel) {
    exportDATEV(filtered, monthLabel)
    logActivity({
      action: 'payroll.datev_export', category: 'payroll',
      summary: `hat einen DATEV-Export für ${monthLabel} erstellt.`,
      targetType: 'payroll_export',
      metadata: { monthLabel },
    })
  }

  useEffect(() => { fetchPayroll() }, [year, month])

  async function fetchPayroll() {
    setLoading(true)
    try {
    const pad   = String(month).padStart(2,'0')
    const start = `${year}-${pad}-01`
    const end   = `${year}-${pad}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`

    const [{ data: employees }, { data: entries }, { data: finalized }, { data: vacations }, { data: sickLeaves }] = await Promise.all([
      supabase.from('employees').select('*').eq('is_active', true).order('last_name'),
      supabase.from('time_entries').select('employee_id, hours_worked, date').gte('date', start).lte('date', end),
      // Bereits abgeschlossene (eingefrorene) Lohnwerte für diesen Monat, falls vorhanden.
      supabase.from('payroll_months').select('*').eq('year', year).eq('month', month),
      // §11 BUrlG Urlaubsentgelt: genehmigte Urlaube, die (teilweise) in den Monat fallen.
      supabase.from('vacation_requests').select('employee_id, start_date, end_date, status').eq('status', 'approved').lte('start_date', end).gte('end_date', start),
      // §3 EFZG Lohnfortzahlung: Krankmeldungen, die (teilweise) in den Monat fallen (end_date=null → andauernd).
      // certificate_received/certificate_file_path: Attest-Pflicht, siehe getPaidAbsenceDays().
      supabase.from('sick_leave').select('employee_id, start_date, end_date, continued_pay_end, certificate_received, certificate_file_path').lte('start_date', end).or(`end_date.is.null,end_date.gte.${start}`),
    ])

    const daysInMonth     = new Date(year, month, 0).getDate()
    const workdaysInMonth = Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(year, month-1, i+1)
      return d.getDay() !== 0 && d.getDay() !== 6 ? 1 : 0
    }).reduce((a,b) => a+b, 0)

    const finalizedByEmp = Object.fromEntries(
      (finalized || []).filter(f => f.is_finalized).map(f => [f.employee_id, f])
    )
    const vacationsByEmp = {}
    ;(vacations || []).forEach(v => {
      if (!vacationsByEmp[v.employee_id]) vacationsByEmp[v.employee_id] = []
      vacationsByEmp[v.employee_id].push(v)
    })
    const sickByEmp = {}
    ;(sickLeaves || []).forEach(s => {
      if (!sickByEmp[s.employee_id]) sickByEmp[s.employee_id] = []
      sickByEmp[s.employee_id].push(s)
    })

    const result = (employees || []).map(emp => {
      const frozen = finalizedByEmp[emp.id]

      // Abgeschlossener Monat: eingefrorene Werte anzeigen, NICHT mit dem aktuellen
      // Stundenlohn neu berechnen — sonst würde eine spätere Lohnänderung rückwirkend
      // vergangene, bereits an die Steuerberaterin gemeldete Monate verändern.
      if (frozen) {
        const payrollHours  = frozen.actual_hours   || 0
        const vacationHours = frozen.vacation_hours || 0
        const sickHours     = frozen.sick_hours     || 0
        const paidHours     = payrollHours + vacationHours + sickHours
        const monthTarget   = frozen.planned_hours  || 0
        const overtime      = frozen.overtime_hours || 0
        const hourlyRate    = frozen.hourly_rate ?? emp.hourly_rate
        const grossSalary   = frozen.gross_salary ?? Math.round(paidHours * hourlyRate * 100) / 100
        const isAlert       = emp.employment_type === 'minijob'
                               ? grossSalary > MINIJOB_LIMIT
                               : emp.employment_type === 'werkstudent'
                                 ? payrollHours > WERKSTUDENT_LIMIT
                                 : overtime > 0
        return {
          ...emp,
          payrollHours, actualHours: payrollHours, vacationHours, sickHours, paidHours, monthTarget, overtime,
          limit: emp.employment_type === 'werkstudent' ? WERKSTUDENT_LIMIT
               : emp.employment_type === 'minijob'      ? MINIJOB_LIMIT / hourlyRate
               : monthTarget,
          hourly_rate: hourlyRate,
          grossSalary, total: grossSalary, isAlert,
          frozen: true,
        }
      }

      const empEntries  = (entries || []).filter(e => e.employee_id === emp.id)
      const rawHours    = empEntries.reduce((s, e) => s + (e.hours_worked || 0), 0)
      // payrollHours = eine einzige, auf 2 Nachkommastellen gerundete Stundenbasis.
      // Anzeige, Brutto UND DATEV nutzen ausschließlich diesen Wert, damit
      // Stunden × Stundenlohn immer exakt = Brutto ergibt.
      const payrollHours = Math.round(rawHours * 100) / 100
      const actualHours  = payrollHours
      const dailyH       = emp.hours_per_week ? emp.hours_per_week / 5 : 0
      const monthTarget  = Math.round(dailyH * workdaysInMonth * 100) / 100

      // §11 BUrlG / §3 EFZG: bezahlte Urlaubs- & Krankheitstage (ohne bereits erfasste
      // Arbeitszeit an diesem Tag) fließen ins Bruttogehalt ein — siehe getPaidAbsenceDays().
      const workedDates = new Set(empEntries.filter(e => (e.hours_worked || 0) > 0).map(e => e.date))
      const { vacationDays, sickDays } = getPaidAbsenceDays(
        vacationsByEmp[emp.id], sickByEmp[emp.id], workedDates, start, end
      )
      const vacationHours = Math.round(vacationDays * dailyH * 100) / 100
      const sickHours     = Math.round(sickDays * dailyH * 100) / 100
      const paidHours     = Math.round((payrollHours + vacationHours + sickHours) * 100) / 100

      // Überstunden bleiben ausschließlich an TATSÄCHLICH gearbeiteten Stunden bemessen
      // (bezahlter Urlaub/Krankheit zählt nicht als Überstunden-Basis).
      const { overtime, limit } = calcOvertime(emp, payrollHours, monthTarget)
      // Brutto = gearbeitete + bezahlte Urlaubs-/Krankheitsstunden × Stundenlohn.
      const grossSalary  = Math.round(paidHours * emp.hourly_rate * 100) / 100
      const isAlert      = emp.employment_type === 'minijob'
                             ? grossSalary > MINIJOB_LIMIT   // zählt volles Brutto, nicht nur gearbeitete Stunden
                             : emp.employment_type === 'werkstudent'
                               ? payrollHours > WERKSTUDENT_LIMIT
                               : overtime > 0

      // Überstunden auf gleiche Basis runden
      const overtimeRounded = Math.round(overtime * 100) / 100
      // Volle Präzision behalten — Anzeige rundet über toLocaleString.
      // Kein toFixed(1) im gespeicherten Wert, sonst wirkt Brutto (aus vollen Stunden) widersprüchlich.
      return { ...emp, payrollHours, actualHours, vacationHours, sickHours, paidHours, monthTarget, overtime: overtimeRounded, limit, grossSalary, total: grossSalary, isAlert, frozen: false }
    })

    setRows(result)
    setIsFinalized(result.length > 0 && result.every(r => r.frozen))
    } catch (err) {
      toast.error(messageParts([appMessage("ui.bca4918dcbef"), errorMessage(err)]))
    }
    setLoading(false)
  }

  // Ein Monat kann erst abgeschlossen werden, wenn er tatsächlich vorbei ist —
  // sonst würden unvollständige, noch laufende Daten eingefroren.
  const monthHasEnded = new Date(year, month, 1) <= new Date()

  async function finalizeMonth() {
    if (finalizing || rows.length === 0) return
    setFinalizing(true)
    const payload = rows.map(r => ({
      employee_id:    r.id,
      year, month,
      planned_hours:  r.monthTarget,
      actual_hours:   r.actualHours,
      overtime_hours: r.overtime,
      vacation_hours: r.vacationHours || 0,
      sick_hours:     r.sickHours || 0,
      sick_pay:       Math.round((r.sickHours || 0) * r.hourly_rate * 100) / 100,
      hourly_rate:    r.hourly_rate,
      gross_salary:   r.total,
      total_payout:   r.total,
      is_finalized:   true,
    }))
    const { error } = await supabase.from('payroll_months').upsert(payload, { onConflict: 'employee_id,year,month' })
    setFinalizing(false)
    if (error) { toast.error(messageParts([appMessage("ui.0ed0b07a3a3f"), errorMessage(error)])); return }
    toast.success(appMessage("ui.644f27781f6a", { p1: (formatParam('date', new Date(year, month-1), {month:'long', year:'numeric'})) }))
    logActivity({
      action: 'payroll.month_finalized', category: 'payroll',
      summary: `hat die Lohnabrechnung für ${exportMonthLabel} abgeschlossen.`,
      targetType: 'payroll_month', metadata: { year, month },
    })
    fetchPayroll()
  }

  async function reopenMonth() {
    if (finalizing) return
    if (!window.confirm(tr("ui.0c5a4d942c6a", { p1: (formatParam('date', new Date(year, month-1), {month:'long', year:'numeric'})) }))) return
    setFinalizing(true)
    const { error } = await supabase.from('payroll_months').update({ is_finalized: false }).eq('year', year).eq('month', month)
    setFinalizing(false)
    if (error) { toast.error(messageParts([appMessage("ui.e89d524aea7a"), errorMessage(error)])); return }
    toast.info(appMessage("ui.b803c5bc04d3", { p1: (formatParam('date', new Date(year, month-1), {month:'long', year:'numeric'})) }))
    logActivity({
      action: 'payroll.month_reopened', category: 'payroll',
      summary: `hat die Lohnabrechnung für ${exportMonthLabel} wieder geöffnet.`,
      targetType: 'payroll_month', metadata: { year, month },
    })
    fetchPayroll()
  }

  const filtered = rows.filter(r => {
    if (filter === 'overtime') return r.overtime > 0
    if (filter === 'alert')    return r.isAlert
    return true
  })

  const totalPayout    = rows.reduce((s, r) => s + r.total, 0)
  const totalHours     = rows.reduce((s, r) => s + r.actualHours, 0)
  const totalOvertime  = rows.reduce((s, r) => s + r.overtime, 0)
  const alertCount     = rows.filter(r => r.isAlert).length
  const exportMonthLabel = new Date(year, month-1).toLocaleDateString('de-DE',{month:'long', year:'numeric'})
  const monthLabel     = new Date(year, month-1).toLocaleDateString(getIntlLocale(),{month:'long', year:'numeric'})
  const MONTHS         = Array.from({length:12}, (_, i) => ({ v:i+1, l:new Date(year,i).toLocaleDateString(getIntlLocale(),{month:'long'}) }))

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.d3075b3fc4af")}</div>
        <div className="topbar-right">
          <select value={month} onChange={e => setMonth(+e.target.value)} style={{ width:'auto' }}>
            {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
          {isAdmin && (
            isFinalized ? (
              <button className="btn btn-sm" onClick={reopenMonth} disabled={finalizing}>{tr("ui.eaafb643b7eb")}</button>
            ) : (
              <button className="btn btn-sm" onClick={finalizeMonth} disabled={finalizing || loading || rows.length === 0 || !monthHasEnded}
                title={!monthHasEnded ? tr("ui.fb55d952c370") : tr("ui.9563eaee5234")}>{tr("ui.f6ba644f3057")}</button>
            )
          )}
          <button className="btn" onClick={() => handleDatevExport(filtered, exportMonthLabel)} disabled={loading || rows.length === 0}>{tr("ui.6d2bd07b0514")}</button>
          <select value={year} onChange={e => setYear(+e.target.value)} style={{ width:90 }}>
            {[2024,2025,2026,2027].map(y => <option key={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="content">
        {/* Stats */}
        <div className="stats-grid mb-5">
          <div className="stat-card">
            <div className="stat-label">{tr("ui.2933070469a2")}</div>
            <div className="stat-value" style={{ fontSize:17 }}>
              {monthLabel}
              {isFinalized && <span className="badge badge-green" style={{ marginLeft:8, fontSize:10, verticalAlign:'middle' }}>{tr("ui.7acc8d7967cb")}</span>}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{tr("ui.3eac55004b5d")}</div>
            <div className="stat-value">{totalHours.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{tr("ui.66a7f3693804")}</div>
            <div className="stat-value" style={{ color: totalOvertime > 0 ? 'var(--warn)' : 'inherit' }}>
              {totalOvertime > 0 ? `+${totalOvertime.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})} h` : '–'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{tr("ui.56fac2a56469")}</div>
            <div className="stat-value" style={{ fontSize:20 }}>{formatCurrency(totalPayout)}</div>
          </div>
        </div>

        {!isFinalized && !loading && rows.length > 0 && (
          <div className="alert" style={{ marginBottom:16, fontSize:12, color:'var(--text-secondary)' }}>{tr("ui.f9c6246d89ff")}</div>
        )}

        {/* Alert Banner */}
        {alertCount > 0 && (
          <div className="alert alert-danger" style={{ marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span>{tr("payroll.alerts", { count: alertCount })}</span>
            <button className="btn btn-sm btn-danger" onClick={() => setFilter('alert')}>{tr("ui.ccb27f03f03e")}</button>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="flex gap-2 mb-5" style={{ marginBottom:16 }}>
          <button className={`btn btn-sm${filter==='all'?' btn-primary':''}`} onClick={() => setFilter('all')}>{tr("ui.6e45dcdf9899")}{rows.length})</button>
          <button className={`btn btn-sm${filter==='overtime'?' btn-primary':''}`} onClick={() => setFilter('overtime')}>{tr("ui.9aab736276d9")}{rows.filter(r=>r.overtime>0).length})
          </button>
          <button className={`btn btn-sm${filter==='alert'?' btn-primary':''}`} style={{ color: alertCount > 0 ? 'var(--danger)' : undefined }} onClick={() => setFilter('alert')}>{tr("ui.5e48108df13b")}{alertCount})
          </button>
        </div>

        {loading ? <div style={{ padding:40, textAlign:'center', color:'var(--text-muted)' }}>{tr("ui.ebbb1d1f265f")}</div> : filtered.length === 0 ? (
          <div className="empty-state" style={{ padding:40 }}>
            <div className="empty-state-icon">💰</div>
            <div className="empty-state-text">{tr("ui.a62b2e73c8ad")}</div>
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{tr("ui.f4cb6891b9e5")}</th>
                    <th>{tr("ui.1b024183cb33")}</th>
                    <th>{tr("ui.e9cafcdab284")}</th>
                    <th>{tr("ui.4672a46e5211")}</th>
                    <th>{tr("ui.fa5864d46af0")}</th>
                    <th>{tr("ui.68c8ec0f16c7")}</th>
                    <th>{tr("ui.6cd01d543ed9")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id} style={{ background: r.isAlert ? 'var(--danger-bg)' : undefined }}>
                      <td>
                        <div className="name-cell">
                          <Avatar src={r.avatar_url} firstName={r.first_name} lastName={r.last_name} color={r.avatar_color} size={30} />
                          <div>
                            <div style={{ fontWeight:500 }}>{r.first_name} {r.last_name}</div>
                            {r.employment_type === 'werkstudent' && (
                              <div style={{ fontSize:11, color:'var(--text-muted)' }}>Max {WERKSTUDENT_LIMIT}{tr("ui.f0dd38020b95")}{r.hours_per_week}{tr("ui.0be41103d552")}</div>
                            )}
                            {r.employment_type === 'minijob' && (
                              <div style={{ fontSize:11, color:'var(--text-muted)' }}>{tr("ui.cded0737a8be")}{formatCurrency(MINIJOB_LIMIT)}{tr("ui.d81b0e9e1ccd")}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td><span className="badge badge-gray" style={{ fontSize:11 }}>{EMP_TYPE_LABEL[r.employment_type]||r.employment_type}</span></td>
                      <td className="text-muted">
                        {r.employment_type === 'werkstudent'
                          ? `${WERKSTUDENT_LIMIT.toLocaleString(getIntlLocale(), {minimumFractionDigits:2, maximumFractionDigits:2})} h`
                          : r.employment_type === 'minijob'
                            ? `max ${(MINIJOB_LIMIT/r.hourly_rate).toFixed(0)} h`
                            : `${r.monthTarget.toLocaleString(getIntlLocale(), {minimumFractionDigits:2, maximumFractionDigits:2})} h`}
                      </td>
                      <td>
                        <strong>{r.actualHours.toLocaleString(getIntlLocale(), {minimumFractionDigits:2, maximumFractionDigits:2})}{tr("ui.2155eeffb339")}</strong>
                        {(r.vacationHours > 0 || r.sickHours > 0) && (
                          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                            {r.vacationHours > 0 && <>+{r.vacationHours.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.4c4e75df57b1")}</>}
                            {r.sickHours > 0 && <>+{r.sickHours.toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:2})}{tr("ui.939a86d4945f")}</>}
                          </div>
                        )}
                      </td>
                      <td><OvertimeBadge emp={r} overtime={r.overtime} actualHours={r.actualHours} limit={r.limit} earnings={r.total} /></td>
                      <td>{formatCurrency(r.hourly_rate)}{tr("ui.141582aa3785")}</td>
                      <td>
                        <strong style={{ color: r.isAlert ? 'var(--danger)' : 'inherit' }}>
                          {formatCurrency(r.total)}
                        </strong>
                        {r.employment_type === 'minijob' && r.actualHours * r.hourly_rate > MINIJOB_LIMIT && (
                          <div style={{ fontSize:11, color:'var(--danger)' }}>{tr("ui.592317f52ea6")}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background:'var(--bg)', fontWeight:700 }}>
                    <td colSpan="6" style={{ padding:'12px 16px' }}>{tr("ui.a36bce47fdac")}</td>
                    <td style={{ padding:'12px 16px', fontSize:15 }}>{formatCurrency(totalPayout)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div style={{ padding:'10px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)', lineHeight:1.8 }}>{tr("ui.b5018301f9c1")}{formatCurrency(MINIJOB_LIMIT)}{tr("ui.3e9de5bc8f30")}{WERKSTUDENT_LIMIT}{tr("ui.5f3a6f6bfd78")}<br/>{tr("ui.8e0145022aa7")}</div>
          </div>
        )}
      </div>
    </>
  )
}
