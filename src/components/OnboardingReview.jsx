import { useState, useEffect } from 'react'
import { supabase, formatDate, formatDateTime, toLocalDateStr } from '../lib/supabase'
import { useToast } from './UI/Toast'
import { formatIBAN, isValidIBAN, taxIdChecksumOk } from '../lib/personalData'
import { MINDESTLOHN } from '../lib/constants'

export const ONB_STATUS = {
  draft:             { label:'Füllt noch aus',   cls:'badge-gray'  },
  changes_requested: { label:'Korrektur angefragt', cls:'badge-amber' },
  submitted:         { label:'Wartet auf Prüfung', cls:'badge-blue'  },
  approved:          { label:'Freigeschaltet',   cls:'badge-green' },
  rejected:          { label:'Abgelehnt',        cls:'badge-red'   },
}

const HOURS_DEFAULT = { vollzeit: 40, teilzeit: 20, werkstudent: 20, minijob: 10 }

function Row({ label, value, warn }) {
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
    if (!rate || rate <= 0) { setErr('Bitte einen Stundenlohn angeben.'); return }
    if (!job.start_date)   { setErr('Bitte das Eintrittsdatum angeben.'); return }
    const hours = parseFloat(String(job.hours_per_week).replace(',', '.'))
    const vac   = parseInt(job.vacation_days, 10)
    if (!hours || hours <= 0 || hours > 60) { setErr('Bitte die Wochenstunden prüfen (1–60).'); return }
    if (isNaN(vac) || vac < 0 || vac > 60)  { setErr('Bitte den Urlaubsanspruch prüfen (0–60 Tage).'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('approve_onboarding', {
      p_id: row.id, p_role: job.role, p_position: job.position,
      p_employment_type: job.employment_type, p_hours_per_week: hours,
      p_hourly_rate: rate, p_start_date: job.start_date, p_vacation_days: vac,
    })
    setBusy(false)
    if (error || !data?.success) { setErr(data?.error || 'Freischalten fehlgeschlagen. Bitte erneut versuchen.'); return }
    toast.success(`✅ ${name} ist freigeschaltet und als Mitarbeiter angelegt.`)
    onDone()
  }

  async function sendBack() {
    if (busy) return
    setErr('')
    if (!note.trim()) { setErr('Bitte schreibe kurz, was korrigiert werden soll.'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('request_onboarding_changes', { p_id: row.id, p_note: note.trim() })
    setBusy(false)
    if (error || !data?.success) { setErr(data?.error || 'Das hat nicht geklappt. Bitte erneut versuchen.'); return }
    toast.info(`${name} wurde um Korrektur gebeten.`)
    onDone()
  }

  async function reject() {
    if (busy) return
    setErr('')
    setBusy(true)
    const { data, error } = await supabase.rpc('reject_onboarding', { p_id: row.id, p_note: note.trim() || null })
    setBusy(false)
    if (error || !data?.success) { setErr(data?.error || 'Das hat nicht geklappt. Bitte erneut versuchen.'); return }
    toast.info(`Registrierung von ${name} abgelehnt. Der Account ist gesperrt.`)
    onDone()
  }

  const st = ONB_STATUS[row.status] || { label: row.status, cls:'badge-gray' }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:560, width:'100%' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">🧾 {name}</div>
          <button className="btn btn-sm" onClick={onClose} aria-label="Schließen">✕</button>
        </div>
        <div className="modal-body" style={{ maxHeight:'70vh', overflowY:'auto' }}>
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:14, flexWrap:'wrap' }}>
            <span className={`badge ${st.cls}`}>{st.label}</span>
            {row.submitted_at && <span style={{ fontSize:12, color:'var(--text-muted)' }}>eingereicht {formatDateTime(row.submitted_at)} Uhr</span>}
          </div>
          {row.review_note && row.status !== 'approved' && (
            <div className="alert alert-info" style={{ fontSize:12.5, marginBottom:14 }}>Letzte Notiz: {row.review_note}</div>
          )}

          <Section title="Person">
            <Row label="Name" value={name} />
            {row.birth_name && <Row label="Geburtsname" value={row.birth_name} />}
            <Row label="Geburtsdatum" value={row.birth_date ? formatDate(row.birth_date) : ''} />
            <Row label="Geburtsort" value={row.birth_place} />
            <Row label="Staatsangehörigkeit" value={row.nationality} />
          </Section>
          <Section title="Kontakt">
            <Row label="E-Mail (Login)" value={row.email} />
            <Row label="Telefon" value={row.phone} />
            <Row label="Adresse" value={row.street ? `${row.street} ${row.house_number}, ${row.postal_code} ${row.city}` : ''} />
          </Section>
          <Section title="Bank">
            <Row label="IBAN" value={row.iban ? formatIBAN(row.iban) : ''} warn={row.iban && !isValidIBAN(row.iban) ? 'Prüfsumme falsch' : null} />
            <Row label="Kontoinhaber" value={row.account_holder}
              warn={row.account_holder && row.last_name && !row.account_holder.toLowerCase().includes(row.last_name.toLowerCase()) ? 'weicht vom Namen ab' : null} />
          </Section>
          <Section title="Steuer & Sozialversicherung">
            <Row label="Steuer-ID" value={row.tax_id} warn={row.tax_id && !taxIdChecksumOk(row.tax_id) ? 'Prüfziffer passt nicht' : null} />
            <Row label="SV-Nummer" value={row.social_security_number} />
            <Row label="Krankenkasse" value={row.health_insurance} />
            <Row label="Weitere Beschäftigung" value={row.other_employment == null ? '' : row.other_employment ? `Ja – ${row.other_employment_note || ''}` : 'Nein'} />
          </Section>
          <Section title="Notfallkontakt">
            <Row label="Name" value={row.emergency_contact_name} />
            <Row label="Telefon" value={row.emergency_contact_phone} />
          </Section>

          {canAct && mode === 'view' && (
            <div style={{ background:'var(--bg)', borderRadius:10, padding:'14px 14px 2px', marginTop:6 }}>
              <div style={{ fontWeight:600, fontSize:13.5, marginBottom:10 }}>
                Arbeitsvertrag (legst nur du fest)
                {prefilled && <span style={{ fontWeight:400, fontSize:12, color:'var(--text-muted)', marginLeft:8 }}>— aus der Einladung übernommen, bitte prüfen</span>}
              </div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:-6, marginBottom:10 }}>
                Alles lässt sich später jederzeit unter <strong>Mitarbeiter → Bearbeiten</strong> ändern.
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>Rolle</label>
                  <select value={job.role} onChange={e => setJ('role', e.target.value)}>
                    <option value="employee">👤 Mitarbeiter</option>
                    <option value="manager">🔧 Manager</option>
                    <option value="admin">👑 Admin</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Position</label>
                  <input value={job.position} onChange={e => setJ('position', e.target.value)} placeholder="Barista, Service, Küche…" />
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>Beschäftigung</label>
                  <select value={job.employment_type} onChange={e => { setJ('employment_type', e.target.value); setJ('hours_per_week', HOURS_DEFAULT[e.target.value]) }}>
                    <option value="vollzeit">Vollzeit</option>
                    <option value="teilzeit">Teilzeit</option>
                    <option value="werkstudent">Werkstudent</option>
                    <option value="minijob">Minijob</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Stunden/Woche *</label>
                  <input type="number" min="1" max="60" step="0.5" value={job.hours_per_week} onChange={e => setJ('hours_per_week', e.target.value)} />
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>Stundenlohn (€) *</label>
                  <input inputMode="decimal" value={job.hourly_rate} onChange={e => setJ('hourly_rate', e.target.value.replace(/[^0-9.,]/g, ''))} placeholder={String(MINDESTLOHN).replace('.', ',')} />
                  {rate > 0 && rate < MINDESTLOHN && (
                    <div style={{ fontSize:11.5, color:'var(--danger)', marginTop:4 }}>⚠️ Unter Mindestlohn ({String(MINDESTLOHN).replace('.', ',')} €)</div>
                  )}
                </div>
                <div className="form-group">
                  <label>Eintrittsdatum *</label>
                  <input type="date" value={job.start_date} onChange={e => setJ('start_date', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>Urlaubsanspruch (Tage/Jahr)</label>
                <input type="number" min="0" max="60" value={job.vacation_days} onChange={e => setJ('vacation_days', e.target.value)} />
              </div>
            </div>
          )}

          {canAct && mode !== 'view' && (
            <div className="form-group" style={{ marginTop:8 }}>
              <label>{mode === 'changes' ? 'Was soll korrigiert werden? *' : 'Grund (optional, nur intern)'}</label>
              <textarea rows={3} value={note} onChange={e => setNote(e.target.value)}
                placeholder={mode === 'changes' ? 'z. B. Die IBAN stimmt nicht, bitte noch einmal prüfen.' : ''} />
              {mode === 'changes' && <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:4 }}>Diese Notiz sieht der Mitarbeiter.</div>}
              {mode === 'reject' && <div className="alert alert-danger" style={{ fontSize:12.5, marginTop:8 }}>Der Account wird gesperrt und die eingegebenen Personaldaten werden gelöscht. Das lässt sich nicht rückgängig machen.</div>}
            </div>
          )}

          {canCancel && mode === 'reject' && (
            <div className="form-group" style={{ marginTop:8 }}>
              <label>Grund (optional, nur intern)</label>
              <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} />
              <div className="alert alert-danger" style={{ fontSize:12.5, marginTop:8 }}>
                Die Registrierung wird abgebrochen und der Zugang gesperrt. Bereits eingegebene Personaldaten (Bank, Steuer, Adresse …) werden dabei gelöscht.
              </div>
            </div>
          )}

          {!isAdmin && (
            <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>🔒 Nur Admins können freischalten.</div>
          )}
          {err && <div role="alert" className="alert alert-danger" style={{ fontSize:13, marginTop:10 }}>{err}</div>}
        </div>

        {canCancel && (
          <div className="modal-footer" style={{ flexWrap:'wrap' }}>
            {mode !== 'reject'
              ? <button className="btn btn-danger" onClick={() => { setMode('reject'); setErr('') }}>Registrierung abbrechen</button>
              : <>
                  <button className="btn" onClick={() => { setMode('view'); setErr('') }} disabled={busy}>Zurück</button>
                  <button className="btn btn-danger" onClick={reject} disabled={busy}>{busy ? '…' : 'Endgültig abbrechen'}</button>
                </>}
          </div>
        )}

        {canAct && (
          <div className="modal-footer" style={{ flexWrap:'wrap' }}>
            {mode === 'view' ? <>
              <button className="btn btn-danger" onClick={() => { setMode('reject'); setErr('') }} disabled={busy}>Ablehnen</button>
              <button className="btn" onClick={() => { setMode('changes'); setErr('') }} disabled={busy}>✏️ Korrektur anfragen</button>
              <button className="btn btn-success" onClick={approve} disabled={busy}>{busy ? 'Wird freigeschaltet…' : '✓ Freischalten'}</button>
            </> : <>
              <button className="btn" onClick={() => { setMode('view'); setErr('') }} disabled={busy}>Zurück</button>
              {mode === 'changes'
                ? <button className="btn btn-primary" onClick={sendBack} disabled={busy}>{busy ? 'Sendet…' : 'Zur Korrektur zurückschicken'}</button>
                : <button className="btn btn-danger" onClick={reject} disabled={busy}>{busy ? '…' : 'Endgültig ablehnen'}</button>}
            </>}
          </div>
        )}
      </div>
    </div>
  )
}
