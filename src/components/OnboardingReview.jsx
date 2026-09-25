import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect } from 'react'
import { supabase, toLocalDateStr } from '../lib/supabase'
import { formatDate, formatDateTime } from '../i18n/format.js'
import { useToast } from './UI/Toast'
import { formatIBAN, isValidIBAN, taxIdChecksumOk } from '../lib/personalData'
import { MINDESTLOHN } from '../lib/constants'

export const ONB_STATUS = {
  draft:             { get label() { return tr("ui.658154755bb4") },   cls:'badge-gray'  },
  changes_requested: { get label() { return tr("ui.e80133ed6201") }, cls:'badge-amber' },
  submitted:         { get label() { return tr("ui.b4ef36fa2195") }, cls:'badge-blue'  },
  approved:          { get label() { return tr("ui.0c40b32205a7") },   cls:'badge-green' },
  rejected:          { get label() { return tr("ui.a9148e8654e8") },        cls:'badge-red'   },
}

const HOURS_DEFAULT = { vollzeit: 40, teilzeit: 20, werkstudent: 20, minijob: 10 }

function Row({ label, value, warn }) {
  useLocale()
  return (
    <div style={{ display:'flex', justifyContent:'space-between', gap:12, padding:'6px 0', borderBottom:'1px solid var(--border)', fontSize:13 }}>
      <span style={{ color:'var(--text-muted)', flexShrink:0 }}>{label}</span>
      <span style={{ color: warn ? 'var(--warn)' : 'var(--text-primary)', textAlign:'right', wordBreak:'break-word' }}>
        {value || '–'}{warn ? ` ⚠️ ${warn}` : ''}
      </span>
    </div>
  )
}

function Section({ title, children }) {
  useLocale()
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.04em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:4 }}>{title}</div>
      {children}
    </div>
  )
}

/**
 * Prüf-Dialog für eine Onboarding-Einreichung.
 * Aktionen (Freischalten / Korrektur / Ablehnen) nur für Admins —
 * zusätzlich prüft die Datenbank selbst (is_admin() in jeder RPC).
 */
export default function OnboardingReview({ row, isAdmin, onClose, onDone }) {
  useLocale()
  const toast = useToast()
  const [mode, setMode]     = useState('view')   // view | changes | reject
  const [note, setNote]     = useState('')
  const [busy, setBusy]     = useState(false)
  const [err,  setErr]      = useState('')
  const [job,  setJob]      = useState({
    role:'employee', position:'', employment_type:'minijob', hours_per_week:10,
    hourly_rate:'', start_date: toLocalDateStr(), vacation_days:28,
  })
  const setJ = (k, v) => setJob(j => ({ ...j, [k]: v }))
  const [prefilled, setPrefilled] = useState(false)

  // Wurde der Arbeitsvertrag schon beim Einladen festgelegt? → vorausfüllen
  useEffect(() => {
    if (!isAdmin || !row.invitation_id || row.status !== 'submitted') return
    supabase.from('invitations').select('job').eq('id', row.invitation_id).maybeSingle().then(({ data }) => {
      const j = data?.job
      if (!j) return
      setJob(cur => ({
        ...cur,
        role: ['employee','manager'].includes(j.role) ? j.role : cur.role,
        position: j.position || cur.position,
        employment_type: j.employment_type || cur.employment_type,
        hours_per_week: j.hours_per_week ?? cur.hours_per_week,
        hourly_rate: j.hourly_rate != null ? String(j.hourly_rate).replace('.', ',') : cur.hourly_rate,
        start_date: j.start_date || cur.start_date,
        vacation_days: j.vacation_days ?? cur.vacation_days,
      }))
      setPrefilled(true)
    })
  }, [row.invitation_id, row.status, isAdmin])

  const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email
  const canAct    = isAdmin && row.status === 'submitted'
  // Auch unfertige Registrierungen (Entwurf / Korrektur) kann der Admin abbrechen
  const canCancel = isAdmin && ['draft', 'changes_requested'].includes(row.status)
  const rate = parseFloat(String(job.hourly_rate).replace(',', '.'))

  async function approve() {
    if (busy) return
    setErr('')
    if (!rate || rate <= 0) { setErr(appMessage("ui.fb10bc721e8c")); return }
    if (!job.start_date)   { setErr(appMessage("ui.de86f9505e91")); return }
    const hours = parseFloat(String(job.hours_per_week).replace(',', '.'))
    const vac   = parseInt(job.vacation_days, 10)
    if (!hours || hours <= 0 || hours > 60) { setErr(appMessage("ui.d69fa185470a")); return }
    if (isNaN(vac) || vac < 0 || vac > 60)  { setErr(appMessage("ui.c72b67933b74")); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('approve_onboarding', {
      p_id: row.id, p_role: job.role, p_position: job.position,
      p_employment_type: job.employment_type, p_hours_per_week: hours,
      p_hourly_rate: rate, p_start_date: job.start_date, p_vacation_days: vac,
    })
    setBusy(false)
    if (error || !data?.success) { setErr((data?.error || appMessage("ui.3924123f78e8"))); return }
    toast.success(appMessage("ui.a0242bf495f6", { p1: (name) }))
    onDone()
  }

  async function sendBack() {
    if (busy) return
    setErr('')
    if (!note.trim()) { setErr(appMessage("ui.ef590370a9c8")); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('request_onboarding_changes', { p_id: row.id, p_note: note.trim() })
    setBusy(false)
    if (error || !data?.success) { setErr((data?.error || appMessage("ui.6632d80bc657"))); return }
    toast.info(appMessage("ui.0d6ea2986afb", { p1: (name) }))
    onDone()
  }

  async function reject() {
    if (busy) return
    setErr('')
    setBusy(true)
    const { data, error } = await supabase.rpc('reject_onboarding', { p_id: row.id, p_note: note.trim() || null })
    setBusy(false)
    if (error || !data?.success) { setErr((data?.error || appMessage("ui.6632d80bc657"))); return }
    toast.info(appMessage("ui.457ea53de602", { p1: (name) }))
    onDone()
  }

  const st = ONB_STATUS[row.status] || { label: row.status, cls:'badge-gray' }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:560, width:'100%' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">🧾 {name}</div>
          <button className="btn btn-sm" onClick={onClose} aria-label={tr("ui.b808f6e97075")}>✕</button>
        </div>
        <div className="modal-body" style={{ maxHeight:'70vh', overflowY:'auto' }}>
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:14, flexWrap:'wrap' }}>
            <span className={`badge ${st.cls}`}>{st.label}</span>
            {row.submitted_at && <span style={{ fontSize:12, color:'var(--text-muted)' }}>{tr("ui.f71ee0d245dc")}{formatDateTime(row.submitted_at)}{tr("ui.4e2866d1f2b9")}</span>}
          </div>
          {row.review_note && row.status !== 'approved' && (
            <div className="alert alert-info" style={{ fontSize:12.5, marginBottom:14 }}>{tr("ui.569c6b91312a")}{row.review_note}</div>
          )}

          <Section title={tr("ui.6007db63e18e")}>
            <Row label={tr("ui.dcd1d5223f73")} value={name} />
            {row.birth_name && <Row label={tr("ui.807b1204e06c")} value={row.birth_name} />}
            <Row label={tr("ui.6882904da71a")} value={row.birth_date ? formatDate(row.birth_date) : ''} />
            <Row label={tr("ui.590571d3da6b")} value={row.birth_place} />
            <Row label={tr("ui.3e3a47041a87")} value={row.nationality} />
          </Section>
          <Section title={tr("ui.325eecf9d301")}>
            <Row label={tr("ui.24faf1311807")} value={row.email} />
            <Row label={tr("ui.fa6906d76ee9")} value={row.phone} />
            <Row label={tr("ui.79e5cf20de0b")} value={row.street ? `${row.street} ${row.house_number}, ${row.postal_code} ${row.city}` : ''} />
          </Section>
          <Section title={tr("ui.676c471bc8dc")}>
            <Row label={tr("ui.7e345c3ba789")} value={row.iban ? formatIBAN(row.iban) : ''} warn={row.iban && !isValidIBAN(row.iban) ? tr("ui.a0e2f8b24336") : null} />
            <Row label={tr("ui.e2ddc853f6c8")} value={row.account_holder}
              warn={row.account_holder && row.last_name && !row.account_holder.toLowerCase().includes(row.last_name.toLowerCase()) ? tr("ui.e488aad2e1ba") : null} />
          </Section>
          <Section title={tr("ui.9c7a0f9f2d3a")}>
            <Row label={tr("ui.45239f930c27")} value={row.tax_id} warn={row.tax_id && !taxIdChecksumOk(row.tax_id) ? tr("ui.465450e877b8") : null} />
            <Row label={tr("ui.019891f68f41")} value={row.social_security_number} />
            <Row label={tr("ui.500348e73c9e")} value={row.health_insurance} />
            <Row label={tr("ui.ec918980364d")} value={row.other_employment == null ? '' : row.other_employment ? tr("ui.bedf0a2cefd6", { p1: (row.other_employment_note || '') }) : tr("ui.90ebc1bde6f3")} />
          </Section>
          <Section title={tr("ui.b285b3cd6355")}>
            <Row label={tr("ui.dcd1d5223f73")} value={row.emergency_contact_name} />
            <Row label={tr("ui.fa6906d76ee9")} value={row.emergency_contact_phone} />
          </Section>

          {canAct && mode === 'view' && (
            <div style={{ background:'var(--bg)', borderRadius:10, padding:'14px 14px 2px', marginTop:6 }}>
              <div style={{ fontWeight:600, fontSize:13.5, marginBottom:10 }}>{tr("ui.186d17359ad3")}{prefilled && <span style={{ fontWeight:400, fontSize:12, color:'var(--text-muted)', marginLeft:8 }}>{tr("ui.8c7e82695cd8")}</span>}
              </div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:-6, marginBottom:10 }}>{tr("ui.8c7c8730850a")}<strong>{tr("ui.78816bcb0d2d")}</strong>{tr("ui.8d50e3c91b8c")}</div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.0038a9cf8661")}</label>
                  <select value={job.role} onChange={e => setJ('role', e.target.value)}>
                    <option value="employee">{tr("ui.d422e9b832d6")}</option>
                    <option value="manager">{tr("ui.0e60bc79039b")}</option>
                    <option value="admin">{tr("ui.25201cafd7b9")}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>{tr("ui.6d031af10da7")}</label>
                  <input value={job.position} onChange={e => setJ('position', e.target.value)} placeholder={tr("ui.fccc61c8a5e6")} />
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.50614a65c54c")}</label>
                  <select value={job.employment_type} onChange={e => { setJ('employment_type', e.target.value); setJ('hours_per_week', HOURS_DEFAULT[e.target.value]) }}>
                    <option value="vollzeit">{tr("ui.49dbe1b0b4b3")}</option>
                    <option value="teilzeit">{tr("ui.df763b1cc689")}</option>
                    <option value="werkstudent">{tr("ui.fa23b3bc413a")}</option>
                    <option value="minijob">{tr("ui.b3fc8da9deb1")}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>{tr("ui.b8139666f8ca")}</label>
                  <input type="number" min="1" max="60" step="0.5" value={job.hours_per_week} onChange={e => setJ('hours_per_week', e.target.value)} />
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.04d8b7c7a102")}</label>
                  <input inputMode="decimal" value={job.hourly_rate} onChange={e => setJ('hourly_rate', e.target.value.replace(/[^0-9.,]/g, ''))} placeholder={MINDESTLOHN.toLocaleString(getIntlLocale())} />
                  {rate > 0 && rate < MINDESTLOHN && (
                    <div style={{ fontSize:11.5, color:'var(--danger)', marginTop:4 }}>{tr("ui.beb41500da12")}{MINDESTLOHN.toLocaleString(getIntlLocale())} €)</div>
                  )}
                </div>
                <div className="form-group">
                  <label>{tr("ui.5de567a16489")}</label>
                  <input type="date" value={job.start_date} onChange={e => setJ('start_date', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>{tr("ui.bb22292b06ce")}</label>
                <input type="number" min="0" max="60" value={job.vacation_days} onChange={e => setJ('vacation_days', e.target.value)} />
              </div>
            </div>
          )}

          {canAct && mode !== 'view' && (
            <div className="form-group" style={{ marginTop:8 }}>
              <label>{mode === 'changes' ? tr("ui.9168953ae48b") : tr("ui.5266c9f03122")}</label>
              <textarea rows={3} value={note} onChange={e => setNote(e.target.value)}
                placeholder={mode === 'changes' ? tr("ui.8823952b7de2") : ''} />
              {mode === 'changes' && <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:4 }}>{tr("ui.70f9dba83d3f")}</div>}
              {mode === 'reject' && <div className="alert alert-danger" style={{ fontSize:12.5, marginTop:8 }}>{tr("ui.ca64fbf43b0c")}</div>}
            </div>
          )}

          {canCancel && mode === 'reject' && (
            <div className="form-group" style={{ marginTop:8 }}>
              <label>{tr("ui.5266c9f03122")}</label>
              <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} />
              <div className="alert alert-danger" style={{ fontSize:12.5, marginTop:8 }}>{tr("ui.0c4dff0d3d25")}</div>
            </div>
          )}

          {!isAdmin && (
            <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>{tr("ui.b930ee64e6f4")}</div>
          )}
          {err && <div role="alert" className="alert alert-danger" style={{ fontSize:13, marginTop:10 }}>{localizeMessage(err)}</div>}
        </div>

        {canCancel && (
          <div className="modal-footer" style={{ flexWrap:'wrap' }}>
            {mode !== 'reject'
              ? <button className="btn btn-danger" onClick={() => { setMode('reject'); setErr('') }}>{tr("ui.22abf76a7164")}</button>
              : <>
                  <button className="btn" onClick={() => { setMode('view'); setErr('') }} disabled={busy}>{tr("ui.548611ce58f7")}</button>
                  <button className="btn btn-danger" onClick={reject} disabled={busy}>{busy ? '…' : tr("ui.bbce5eec5fff")}</button>
                </>}
          </div>
        )}

        {canAct && (
          <div className="modal-footer" style={{ flexWrap:'wrap' }}>
            {mode === 'view' ? <>
              <button className="btn btn-danger" onClick={() => { setMode('reject'); setErr('') }} disabled={busy}>{tr("ui.7be75ced7162")}</button>
              <button className="btn" onClick={() => { setMode('changes'); setErr('') }} disabled={busy}>{tr("ui.1172d80d6460")}</button>
              <button className="btn btn-success" onClick={approve} disabled={busy}>{busy ? tr("ui.9bd38e7b7d46") : tr("ui.d8ee0df1b99c")}</button>
            </> : <>
              <button className="btn" onClick={() => { setMode('view'); setErr('') }} disabled={busy}>{tr("ui.548611ce58f7")}</button>
              {mode === 'changes'
                ? <button className="btn btn-primary" onClick={sendBack} disabled={busy}>{busy ? tr("ui.906e705158b9") : tr("ui.6480815e73aa")}</button>
                : <button className="btn btn-danger" onClick={reject} disabled={busy}>{busy ? '…' : tr("ui.2eb669d3e012")}</button>}
            </>}
          </div>
        )}
      </div>
    </div>
  )
}
