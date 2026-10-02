import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { BrandBadge } from '../components/UI/Brand'
import { supabase } from '../lib/supabase'
import { formatDate, formatDateTime } from '../i18n/format.js'
import { useToast } from '../components/UI/Toast'
import {
  validatePersonal, toPayload, formatIBAN, taxIdChecksumOk, cleanTaxId, PHONE_MAX,
  FIELD_LABELS, FIELD_MESSAGES,
} from '../lib/personalData'
import { translateSupabaseError } from '../lib/errorHelper'
import { boundedRequest } from '../lib/boundedRequest'
import {
  STEP_FIELDS, REVIEW_STEP, EDITABLE, ONB_TIMEOUT, rowToForm, resumeStep, canOpenStep, loadOnboarding, saveOnboarding, mergeUnsaved,
} from '../lib/onboardingFlow'
import DeleteAccountCard from '../components/DeleteAccountCard'
import { LEGAL_PATHS } from '../legal/legalContent.js'
import { acknowledgePrivacyNotice } from '../lib/privacyAck.js'

// ── Schritte des Formulars (Felder: src/lib/onboardingFlow.js) ─
const STEPS = [
  { key:'person',  get title() { return tr("ui.ef384102f749") },        icon:'👤', fields:STEP_FIELDS.person },
  { key:'contact', get title() { return tr("ui.3e05c8cee613") },   icon:'🏠', fields:STEP_FIELDS.contact },
  { key:'bank',    get title() { return tr("ui.551ef56c92ec") },      icon:'🏦', fields:STEP_FIELDS.bank },
  { key:'payroll', get title() { return tr("ui.9c7a0f9f2d3a") }, icon:'🧾', fields:STEP_FIELDS.payroll },
  { key:'emerg',   get title() { return tr('onb.emergencyOptional') }, icon:'🚑', fields:STEP_FIELDS.emerg },
  { key:'review',  get title() { return tr("ui.8b4f9d373e90") },   icon:'✅', fields:[] },
]

function signOut() {
  supabase.auth.signOut()
  sessionStorage.removeItem('cafe_session_active')
  localStorage.removeItem('cafe_no_remember')
}

function Shell({ children, wide }) {
  useLocale()
  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', padding:'calc(64px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom))' }}>   {/* oben Platz für den Sprachumschalter (sonst verdeckt er „Abmelden“) */}
      <div style={{ maxWidth: wide ? 620 : 460, margin:'0 auto' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <BrandBadge size={34} />
            <div>
              <div style={{ fontWeight:700, fontSize:16, color:'var(--text-primary)' }}>Café Buur</div>
              <div style={{ fontSize:12, color:'var(--text-muted)' }}>{tr("ui.9afbf8764261")}</div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={signOut}>{tr("ui.545f8be33bf0")}</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, required, error, hint, children }) {
  useLocale()
  return (
    <div className="form-group">
      <label>{label}{required && <span style={{ color:'var(--danger)' }}> *</span>}</label>
      {children}
      {error
        ? <div role="alert" style={{ fontSize:12, color:'var(--danger)', marginTop:4 }}>{localizeMessage(error)}</div>
        : hint && <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:4, lineHeight:1.5 }}>{hint}</div>}
    </div>
  )
}

function Row({ label, value }) {
  useLocale()
  return (
    <div style={{ display:'flex', justifyContent:'space-between', gap:12, padding:'6px 0', borderBottom:'1px solid var(--border)', fontSize:13 }}>
      <span style={{ color:'var(--text-muted)' }}>{label}</span>
      <span style={{ color:'var(--text-primary)', textAlign:'right', wordBreak:'break-word' }}>{value || '–'}</span>
    </div>
  )
}

// Der Server ist die Quelle der Wahrheit: Angaben, Status und Revision kommen aus employee_onboarding. Der Schritt
// wird daraus abgeleitet (erster unvollständiger) – Neu laden, Tab schließen, Login statt Link, anderes Gerät → gleicher Punkt.
export default function Onboarding({ session, fallback }) {
  useLocale()
  const toast = useToast()
  const [row,     setRow]     = useState(null)
  const [state,   setState]   = useState('loading')   // loading | none | form | error
  const [form,    setForm]    = useState(rowToForm(null))
  const [step,    setStep]    = useState(0)
  const [errors,  setErrors]  = useState({})
  const [saving,  setSaving]  = useState(false)
  const [privacy, setPrivacy] = useState(false)
  const [notice,  setNotice]  = useState(null)        // { kind: 'resumed', step } | { kind: 'conflict' }
  const topRef       = useRef(null)
  const busy         = useRef(false)       // Doppelklick-Sperre, greift sofort (nicht erst nach dem nächsten Render)
  const loadSeq      = useRef(0)           // nur die jüngste Ladeanfrage schreibt den Zustand
  const revision     = useRef(undefined)   // zuletzt vom Server bestätigte Revision (Migration 28)
  const savedPayload = useRef('')          // zuletzt gespeicherter Stand → „ungespeicherte Änderungen“
  const uid = session.user.id

  // Serverstand übernehmen: Angaben, Revision, Schritt
  function adopt(data) {
    const f = rowToForm(data)
    setRow(data)
    setForm(f)
    revision.current = Number.isInteger(data.revision) ? data.revision : undefined
    savedPayload.current = JSON.stringify(toPayload(f))
    setStep(resumeStep(f))
    return f
  }

  async function load(nextNotice = null) {
    const seq = ++loadSeq.current
    setState('loading')
    const r = await loadOnboarding(supabase, uid)
    if (seq !== loadSeq.current) return   // veraltete Antwort
    if (!r.ok) { setState('error'); return }
    if (!r.row) { setState('none'); return }
    const at = resumeStep(adopt(r.row))
    setErrors({})
    setNotice(nextNotice || (EDITABLE.includes(r.row.status) && at > 0 ? { kind:'resumed', step: at } : null))
    setState('form')
  }

  useEffect(() => { load() }, [uid])  // eslint-disable-line react-hooks/exhaustive-deps

  // Angezeigter Schritt nie hinter unvollständige Angaben (kein Überspringen, auch nicht per manipuliertem Zustand)
  const at = Math.min(step, resumeStep(form))
  const editable = state === 'form' && EDITABLE.includes(row?.status)
  const dirty = editable && JSON.stringify(toPayload(form)) !== savedPayload.current

  // Tab/App schließen mit ungespeicherten Eingaben → Browser fragt nach
  useEffect(() => {
    if (!dirty) return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function set(k, v) {
    setForm(f => ({ ...f, [k]: v }))
    if (errors[k]) setErrors(e => { const n = { ...e }; delete n[k]; return n })
  }

  function scrollTop() {
    try { topRef.current?.scrollIntoView({ behavior:'smooth', block:'start' }) } catch { /* ignore */ }
  }

  // Ergebnis einer Speicherung anwenden. true = gespeichert (weiter), false = stehen bleiben
  async function applyOutcome(o, payload) {
    const adoptRevision = () => { if (Number.isInteger(o.revision)) revision.current = o.revision }
    switch (o.kind) {
      case 'saved':
      case 'already':
        adoptRevision()
        savedPayload.current = JSON.stringify(payload)
        return true
      case 'conflict': {
        // Anderes Fenster/Gerät hat inzwischen gespeichert → nichts überschreiben, aktuellen Serverstand zeigen;
        // eigene Eingaben dieses Schritts bleiben, wo dort nichts geändert wurde (erneut „Weiter“ speichert sie)
        const mine = form, base = JSON.parse(savedPayload.current || '{}'), fields = STEPS[at].fields
        await load({ kind:'conflict' })
        setForm(server => mergeUnsaved(server, mine, base, fields))
        return false
      }
      case 'locked':
        await load()   // eingereicht/freigeschaltet/abgebrochen → passende Statusseite
        return false
      case 'invalid': {
        // Server hat den Entwurf gespeichert und die Einreichung begründet abgelehnt → Fehler am Feld
        adoptRevision()
        savedPayload.current = JSON.stringify(payload)
        const f = o.field
        setErrors({ [f]: o.message })
        const idx = STEPS.findIndex(s => s.fields.includes(f))
        if (idx >= 0) { setStep(idx); scrollTop() }
        toast.error(o.message || appMessage("ui.8d9c237fd495"))
        return false
      }
      case 'notSaved':
        adoptRevision()
        toast.error(appMessage('onb.noAnswer'), 9000)
        return false
      case 'unknown':
        toast.error(appMessage('onb.unknown'), 9000)
        return false
      default:
        toast.error(o.message || (o.error ? translateSupabaseError(o.error) : appMessage("ui.dfb7e42ffb81")))
        return false
    }
  }

  async function next() {
    if (busy.current) return
    const errs = validatePersonal(form, STEPS[at].fields)
    if (Object.keys(errs).length) { setErrors(errs); return }
    busy.current = true
    setSaving(true)
    try {
      const payload = toPayload(form)
      const o = await saveOnboarding(supabase, { uid, payload, revision: revision.current })
      if (await applyOutcome(o, payload)) {
        setNotice(null)
        setStep(Math.min(at + 1, REVIEW_STEP))
        scrollTop()
      }
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  // Zurück speichert ebenfalls (ohne Prüfung, als Entwurf) – Eingaben dieses Schritts überleben so auch einen Reload
  async function back() {
    if (busy.current) return
    const payload = toPayload(form)
    if (JSON.stringify(payload) !== savedPayload.current) {
      busy.current = true
      setSaving(true)
      try {
        const o = await saveOnboarding(supabase, { uid, payload, revision: revision.current })
        if (o.kind === 'conflict' || o.kind === 'locked') { await applyOutcome(o, payload); return }
        if (o.kind === 'saved' || o.kind === 'already') await applyOutcome(o, payload)
        else {
          if (o.kind === 'notSaved' && Number.isInteger(o.revision)) revision.current = o.revision
          toast.warn(appMessage('onb.backNotSaved'))
        }
      } finally {
        busy.current = false
        setSaving(false)
      }
    }
    setErrors({})
    setNotice(null)
    setStep(Math.max(at - 1, 0))
    scrollTop()
  }

  // Aus der Übersicht zu einem Abschnitt springen (nur zu bereits erreichbaren Schritten)
  function goTo(i) {
    if (busy.current || !canOpenStep(form, i)) return
    setErrors({})
    setNotice(null)
    setStep(i)
    scrollTop()
  }

  async function submit() {
    if (busy.current) return
    const allFields = STEPS.flatMap(s => s.fields)
    const errs = validatePersonal(form, allFields)
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0]
      const idx = STEPS.findIndex(s => s.fields.includes(first))
      setErrors(errs)
      if (idx >= 0) { setStep(idx); scrollTop() }
      toast.error(appMessage("ui.e3ae0cb41d9b", { p1: ((FIELD_MESSAGES[first] || first)) }))
      return
    }
    if (!privacy) { setErrors({ privacy_accepted: (appMessage("ui.47deeac03c22")) }); return }
    busy.current = true
    setSaving(true)
    try {
      // Versionierte Kenntnisnahme (gleiches System wie für bestehende Konten) – ohne Serverbestätigung kein Absenden
      const ack = await boundedRequest(() => acknowledgePrivacyNotice(supabase), { ms: ONB_TIMEOUT.write })
      if (!ack.ok) { toast.error(appMessage('privacyAck.error')); return }
      const payload = toPayload(form)
      const o = await saveOnboarding(supabase, { uid, payload: { ...payload, privacy_accepted: true }, submit: true, revision: revision.current })
      if (await applyOutcome(o, payload)) {
        // Auch „bereits eingereicht“ (z. B. erste Antwort verloren) ist ein Erfolg – kein Fehler
        toast.success(appMessage(o.kind === 'already' ? 'onb.alreadySubmitted' : "ui.6c8dd191bd56"))
        await load()
      }
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  // ── Zustände ohne Formular ──────────────────────────────
  if (state === 'loading') return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'#1C1917', color:'#fff', fontSize:16 }}>{tr("ui.97c798659981")}</div>
  )
  if (state === 'none') return fallback
  if (state === 'error') return (
    <Shell>
      <div className="card"><div className="card-body" style={{ textAlign:'center', padding:28 }}>
        <div style={{ fontSize:36, marginBottom:10 }}>⚠️</div>
        <div style={{ fontWeight:600, marginBottom:8 }}>{tr("ui.fd1f3fb400b8")}</div>
        <button className="btn btn-primary" onClick={() => load()}>{tr("ui.7df1d235ed7f")}</button>
      </div></div>
    </Shell>
  )

  if (row.status === 'submitted') return (
    <Shell>
      <div className="card"><div className="card-body" style={{ textAlign:'center', padding:'32px 24px' }}>
        <div style={{ fontSize:44, marginBottom:12 }}>⏳</div>
        <h2 style={{ fontSize:19, fontWeight:700, marginBottom:8 }}>{tr("ui.9b5022eb0657")}</h2>
        <p style={{ color:'var(--text-secondary)', fontSize:14, lineHeight:1.7, marginBottom:6 }}>{tr("ui.3b682c0bf447")}{row.first_name}{tr("ui.738fa42d4155")}</p>
        <p style={{ color:'var(--text-muted)', fontSize:12.5, marginBottom:20 }}>{tr("ui.45779c0c1592")}{formatDateTime(row.submitted_at)}{tr("ui.4e2866d1f2b9")}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>{tr("ui.018b1a8d7e42")}</button>
      </div></div>
      <div style={{ textAlign:'center', marginTop:12 }}>
        <DeleteAccountCard email={session.user.email} variant="onboarding" compact />
      </div>
    </Shell>
  )

  if (row.status === 'rejected') return (
    <Shell>
      <div className="card"><div className="card-body" style={{ textAlign:'center', padding:'32px 24px' }}>
        <div style={{ fontSize:44, marginBottom:12 }}>🔒</div>
        <h2 style={{ fontSize:19, fontWeight:700, marginBottom:8 }}>{tr("ui.2b5aa8d9d1ab")}</h2>
        <p style={{ color:'var(--text-secondary)', fontSize:14, lineHeight:1.7 }}>{tr("ui.0d4bbe34b2c7")}</p>
      </div></div>
    </Shell>
  )

  if (row.status === 'approved') return (
    <Shell>
      <div className="card"><div className="card-body" style={{ textAlign:'center', padding:'32px 24px' }}>
        <div style={{ fontSize:44, marginBottom:12 }}>🎉</div>
        <h2 style={{ fontSize:19, fontWeight:700, marginBottom:12 }}>{tr("ui.ad5b4d3f7f29")}</h2>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>{tr("ui.bd7dd49ad672")}</button>
      </div></div>
    </Shell>
  )

  // ── Formular (draft / changes_requested) ─────────────────
  const cur = STEPS[at]
  const e = errors
  const inputStyle = k => e[k] ? { borderColor:'var(--danger)' } : undefined
  const taxHint = form.tax_id && cleanTaxId(form.tax_id).length === 11 && !taxIdChecksumOk(form.tax_id)
    ? tr("ui.ac802d1592ea")
    : tr("ui.5840e4818403")

  return (
    <Shell wide>
      <div ref={topRef} />

      {at === 0 && (
        <div className="card" style={{ marginBottom:16 }}>
          <div className="card-body" style={{ fontSize:14, lineHeight:1.65, color:'var(--text-secondary)' }}>
            <div style={{ fontWeight:700, fontSize:17, color:'var(--text-primary)', marginBottom:6 }}>{tr("ui.1fd63804594b")}</div>{tr("ui.b599da32e834")}<div style={{ fontSize:12.5, color:'var(--text-muted)', marginTop:8 }}>{tr("ui.ea566f0677ac")}</div>
          </div>
        </div>
      )}

      {notice?.kind === 'resumed' && (
        <div role="status" style={{ background:'var(--accent-light)', borderRadius:10, padding:'12px 14px', marginBottom:16, fontSize:13.5, lineHeight:1.6, color:'var(--text-primary)' }}>
          {tr('onb.resumed', { step: notice.step + 1, total: STEPS.length })}
        </div>
      )}
      {notice?.kind === 'conflict' && (
        <div role="alert" style={{ background:'var(--warn-bg)', border:'1px solid #FDE68A', borderRadius:10, padding:'12px 14px', marginBottom:16, fontSize:13.5, lineHeight:1.6, color:'var(--text-primary)' }}>
          {tr('onb.conflict')}
        </div>
      )}

      {row.status === 'changes_requested' && (
        <div style={{ background:'var(--warn-bg)', border:'1px solid #FDE68A', borderRadius:10, padding:'12px 14px', marginBottom:16, fontSize:13.5, lineHeight:1.6, color:'var(--text-primary)' }}>
          <strong>{tr("ui.581a9a67822a")}</strong> {row.review_note}
        </div>
      )}

      {/* Fortschritt */}
      <div style={{ display:'flex', gap:4, marginBottom:8 }} aria-hidden="true">
        {STEPS.map((s, i) => (
          <div key={s.key} style={{ flex:1, height:4, borderRadius:2, background: i <= at ? 'var(--accent)' : 'var(--border)', transition:'background 0.25s' }} />
        ))}
      </div>
      <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>{tr("ui.c0f684317a91")}{at + 1}{tr("ui.24db69445a9d")}{STEPS.length}
      </div>

      <div className="card">
        <div className="card-header"><div className="card-title">{cur.icon} {cur.title}</div></div>
        <div className="card-body">

          {cur.key === 'person' && <>
            <div className="two-col">
              <Field label={tr("ui.d2d77b6ffa70")} required error={e.first_name}>
                <input value={form.first_name} onChange={ev => set('first_name', ev.target.value)} autoComplete="given-name" style={inputStyle('first_name')} />
              </Field>
              <Field label={tr("ui.b25358edd497")} required error={e.last_name}>
                <input value={form.last_name} onChange={ev => set('last_name', ev.target.value)} autoComplete="family-name" style={inputStyle('last_name')} />
              </Field>
            </div>
            <Field label={tr("ui.807b1204e06c")} error={e.birth_name} hint={tr('onb.hintBirthName')}>
              <input value={form.birth_name} onChange={ev => set('birth_name', ev.target.value)} />
            </Field>
            <div className="two-col">
              <Field label={tr("ui.6882904da71a")} required error={e.birth_date}>
                <input type="date" value={form.birth_date || ''} onChange={ev => set('birth_date', ev.target.value)} autoComplete="bday" style={inputStyle('birth_date')} />
              </Field>
              <Field label={tr("ui.590571d3da6b")} error={e.birth_place}>
                <input value={form.birth_place} onChange={ev => set('birth_place', ev.target.value)} />
              </Field>
            </div>
            <Field label={tr("ui.3e3a47041a87")} error={e.nationality}>
              <input value={form.nationality} onChange={ev => set('nationality', ev.target.value)} placeholder={tr("ui.a598d22993ae")} />
            </Field>
          </>}

          {cur.key === 'contact' && <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 110px', gap:12 }}>
              <Field label={tr("ui.58a3778c18c4")} required error={e.street}>
                <input value={form.street} onChange={ev => set('street', ev.target.value)} autoComplete="address-line1" style={inputStyle('street')} />
              </Field>
              <Field label={tr("ui.318ca5480cb8")} required error={e.house_number}>
                <input value={form.house_number} onChange={ev => set('house_number', ev.target.value)} style={inputStyle('house_number')} />
              </Field>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'110px 1fr', gap:12 }}>
              <Field label={tr("ui.c6127fd4465d")} required error={e.postal_code}>
                <input value={form.postal_code} inputMode="numeric" maxLength={5} autoComplete="postal-code"
                  onChange={ev => set('postal_code', ev.target.value.replace(/\D/g, ''))} style={inputStyle('postal_code')} />
              </Field>
              <Field label={tr("ui.30fb259129e5")} required error={e.city}>
                <input value={form.city} onChange={ev => set('city', ev.target.value)} autoComplete="address-level2" style={inputStyle('city')} />
              </Field>
            </div>
            <Field label={tr('onb.ownPhone')} required error={e.phone} hint={tr('onb.ownPhoneHint')}>
              <input type="tel" inputMode="tel" value={form.phone} onChange={ev => set('phone', ev.target.value)} autoComplete="tel" maxLength={PHONE_MAX} placeholder="+49 170 1234567" style={inputStyle('phone')} />
            </Field>
          </>}

          {cur.key === 'bank' && <>
            <Field label={tr("ui.7e345c3ba789")} required error={e.iban} hint={tr('onb.hintIban')}>
              <input value={form.iban} inputMode="text" autoCapitalize="characters" spellCheck={false}
                onChange={ev => set('iban', formatIBAN(ev.target.value.replace(/[^A-Za-z0-9]/g, '')))}
                onFocus={() => { if (!form.account_holder) set('account_holder', `${form.first_name} ${form.last_name}`.trim()) }}
                placeholder={tr("ui.7f377fd57c25")} style={{ fontFamily:'monospace', letterSpacing:'0.5px', ...inputStyle('iban') }} />
            </Field>
            <Field label={tr("ui.e2ddc853f6c8")} required error={e.account_holder}>
              <input value={form.account_holder} onChange={ev => set('account_holder', ev.target.value)} style={inputStyle('account_holder')} />
            </Field>
          </>}

          {cur.key === 'payroll' && <>
            <Field label={tr("ui.9832c668e273")} required error={e.tax_id} hint={taxHint}>
              <input value={form.tax_id} inputMode="numeric" maxLength={14}
                onChange={ev => set('tax_id', ev.target.value.replace(/[^0-9 ]/g, ''))} placeholder="12 345 678 901"
                style={{ fontFamily:'monospace', ...inputStyle('tax_id') }} />
            </Field>
            <Field label={tr("ui.5acdea3be6d5")} required error={e.social_security_number}
              hint={tr('onb.hintSv')}>
              <input value={form.social_security_number} autoCapitalize="characters" spellCheck={false} maxLength={16}
                onChange={ev => set('social_security_number', ev.target.value.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase())}
                placeholder={tr("ui.ac2e02feab3d")} style={{ fontFamily:'monospace', ...inputStyle('social_security_number') }} />
            </Field>
            <Field label={tr("ui.500348e73c9e")} required error={e.health_insurance} hint={tr('onb.hintHealth')}>
              <input value={form.health_insurance} onChange={ev => set('health_insurance', ev.target.value)} style={inputStyle('health_insurance')} />
            </Field>
            <Field label={tr("ui.3277c685d32a")} required error={e.other_employment}>
              <div style={{ display:'flex', gap:10 }}>
                {[[tr("ui.90ebc1bde6f3"), false], [tr("ui.cde9e58a9a4e"), true]].map(([l, v]) => (
                  <button key={l} type="button"
                    className={`btn ${form.other_employment === v ? 'btn-primary' : ''}`}
                    style={{ flex:1, justifyContent:'center' }}
                    aria-pressed={form.other_employment === v}
                    onClick={() => set('other_employment', v)}>{l}</button>
                ))}
              </div>
            </Field>
            {form.other_employment === true && (
              <Field label={tr("ui.e55bff7f9626")} required error={e.other_employment_note} hint={tr('onb.hintOtherEmployment')}>
                <textarea rows={2} value={form.other_employment_note} onChange={ev => set('other_employment_note', ev.target.value)} style={inputStyle('other_employment_note')} />
              </Field>
            )}
          </>}

          {cur.key === 'emerg' && <>
            <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:12, lineHeight:1.55 }}>{tr("ui.5686c0e747c3")} {tr('onb.emergencyOptionalHint')}</div>
            <Field label={tr("ui.f2fbb683da7e")} error={e.emergency_contact_name}>
              <input value={form.emergency_contact_name} onChange={ev => set('emergency_contact_name', ev.target.value)} placeholder={tr("ui.a0f7975ae8cc")} style={inputStyle('emergency_contact_name')} />
            </Field>
            <Field label={tr('onb.emergencyPhone')} error={e.emergency_contact_phone}>
              <input type="tel" inputMode="tel" maxLength={PHONE_MAX} value={form.emergency_contact_phone} onChange={ev => set('emergency_contact_phone', ev.target.value)} style={inputStyle('emergency_contact_phone')} />
            </Field>
          </>}

          {cur.key === 'review' && <>
            <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:10 }}>{tr("ui.731cdeae8463")}</div>
            <Row label={tr("ui.dcd1d5223f73")} value={`${form.first_name} ${form.last_name}`} />
            {form.birth_name && <Row label={tr("ui.807b1204e06c")} value={form.birth_name} />}
            <Row label={tr("ui.6882904da71a")} value={formatDate(form.birth_date)} />
            {form.birth_place && <Row label={tr("ui.590571d3da6b")} value={form.birth_place} />}
            {form.nationality && <Row label={tr("ui.3e3a47041a87")} value={form.nationality} />}
            <Row label={tr("ui.79e5cf20de0b")} value={`${form.street} ${form.house_number}, ${form.postal_code} ${form.city}`} />
            <Row label={tr('onb.ownPhone')} value={form.phone} />
            <Row label={tr("ui.7e345c3ba789")} value={formatIBAN(form.iban)} />
            <Row label={tr("ui.e2ddc853f6c8")} value={form.account_holder} />
            <Row label={tr("ui.45239f930c27")} value={cleanTaxId(form.tax_id)} />
            <Row label={tr("ui.019891f68f41")} value={form.social_security_number} />
            <Row label={tr("ui.500348e73c9e")} value={form.health_insurance} />
            <Row label={tr("ui.ec918980364d")} value={form.other_employment ? tr("ui.bedf0a2cefd6", { p1: (form.other_employment_note) }) : tr("ui.90ebc1bde6f3")} />
            <Row label={tr("ui.b285b3cd6355")} value={form.emergency_contact_name?.trim() ? `${form.emergency_contact_name}, ${form.emergency_contact_phone}` : tr('onb.emergencyNone')} />

            {/* Direkt zu einem Abschnitt, um etwas zu ändern (z. B. nach „Korrektur angefordert“) */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center', marginTop:12, fontSize:12.5, color:'var(--text-muted)' }}>
              <span>{tr('onb.editSection')}</span>
              {STEPS.slice(0, REVIEW_STEP).map((s, i) => (
                <button key={s.key} type="button" className="btn btn-sm" disabled={saving} onClick={() => goTo(i)}>{s.icon} {s.title}</button>
              ))}
            </div>

            <div style={{ marginTop:18, background:'var(--bg)', borderRadius:10, padding:'12px 14px' }}>
              {/* Kenntnisnahme der Datenschutzhinweise (keine Einwilligung); Link öffnet neuen Tab, Formular bleibt erhalten */}
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', cursor:'pointer', fontSize:13, color:'var(--text-primary)' }}>
                <input type="checkbox" checked={privacy} style={{ width:18, height:18, marginTop:1, flexShrink:0 }}
                  onChange={ev => { setPrivacy(ev.target.checked); setErrors(x => { const n = { ...x }; delete n.privacy_accepted; return n }) }} />
                <span>{tr('legal.ackBefore')}<a href={LEGAL_PATHS.privacy} target="_blank" rel="noopener noreferrer"
                  style={{ color:'var(--accent-text, var(--accent))', fontWeight:600 }}>{tr('legal.ackLink')}</a>{tr('legal.ackAfter')}</span>
              </label>
              {e.privacy_accepted && <div role="alert" style={{ fontSize:12, color:'var(--danger)', marginTop:6 }}>{localizeMessage(e.privacy_accepted)}</div>}
            </div>
          </>}

          <div style={{ display:'flex', gap:10, marginTop:20 }}>
            {at > 0 && <button className="btn" onClick={back} disabled={saving} style={{ flex:1, justifyContent:'center' }}>{tr("ui.10eefef364ea")}</button>}
            {cur.key !== 'review'
              ? <button className="btn btn-primary" onClick={next} disabled={saving} style={{ flex:2, justifyContent:'center' }}>
                  {saving ? tr("ui.7c22c9f556d9") : tr("ui.b3e3f54b2131")}
                </button>
              : <button className="btn btn-primary" onClick={submit} disabled={saving || !privacy} style={{ flex:2, justifyContent:'center' }}>
                  {saving ? tr("ui.de780a74a48e") : tr("ui.dd43609c4782")}
                </button>}
          </div>
        </div>
      </div>

      <div style={{ fontSize:11.5, color:'var(--text-muted)', textAlign:'center', marginTop:14, lineHeight:1.6 }}>{tr("ui.e13a9e096350")}</div>
      <div style={{ textAlign:'center', marginTop:8 }}>
        <DeleteAccountCard email={session.user.email} variant="onboarding" compact />
      </div>
    </Shell>
  )
}
