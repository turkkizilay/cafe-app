import { t as tr, getIntlLocale, localizeMessage, message as appMessage, messageError, errorMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { BrandBadge } from '../components/UI/Brand'
import { supabase } from '../lib/supabase'
import { formatDate, formatDateTime } from '../i18n/format.js'
import { useToast } from '../components/UI/Toast'
import {
  validatePersonal, toPayload, formatIBAN, taxIdChecksumOk, cleanTaxId,
  FIELD_LABELS, FIELD_MESSAGES, PERSONAL_FIELDS,
} from '../lib/personalData'
import PrivacyNotice from '../components/UI/PrivacyNotice.jsx'
import DeleteAccountCard from '../components/DeleteAccountCard'

// ── Schritte des Formulars ──────────────────────────────────
const STEPS = [
  { key:'person',  get title() { return tr("ui.ef384102f749") },        icon:'👤', fields:['first_name','last_name','birth_name','birth_date','birth_place','nationality'] },
  { key:'contact', get title() { return tr("ui.3e05c8cee613") },   icon:'🏠', fields:['street','house_number','postal_code','city','phone'] },
  { key:'bank',    get title() { return tr("ui.551ef56c92ec") },      icon:'🏦', fields:['iban','account_holder'] },
  { key:'payroll', get title() { return tr("ui.9c7a0f9f2d3a") }, icon:'🧾', fields:['tax_id','social_security_number','health_insurance','other_employment','other_employment_note'] },
  { key:'emerg',   get title() { return tr("ui.b285b3cd6355") },      icon:'🚑', fields:['emergency_contact_name','emergency_contact_phone'] },
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
    <div style={{ minHeight:'100vh', background:'var(--bg)', padding:'calc(24px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom))' }}>
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

function rowToForm(row) {
  const f = {}
  for (const k of PERSONAL_FIELDS) f[k] = row?.[k] ?? (k === 'other_employment' ? null : '')
  if (f.iban) f.iban = formatIBAN(f.iban)
  return f
}

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
  const [showPrivacy, setShowPrivacy] = useState(false)
  const topRef = useRef(null)

  async function load() {
    setState('loading')
    const { data, error } = await supabase
      .from('employee_onboarding').select('*')
      .eq('profile_id', session.user.id).maybeSingle()
    if (error) { setState('error'); return }
    if (!data) { setState('none'); return }
    setRow(data)
    setForm(rowToForm(data))
    setState('form')
  }

  useEffect(() => { load() }, [session.user.id])  // eslint-disable-line react-hooks/exhaustive-deps

  function set(k, v) {
    setForm(f => ({ ...f, [k]: v }))
    if (errors[k]) setErrors(e => { const n = { ...e }; delete n[k]; return n })
  }

  function scrollTop() {
    try { topRef.current?.scrollIntoView({ behavior:'smooth', block:'start' }) } catch { /* ignore */ }
  }

  async function saveDraft() {
    const { data, error } = await supabase.rpc('save_onboarding', { p_data: toPayload(form), p_submit: false })
    if (error || !data?.success) throw messageError((data?.error || appMessage("ui.dfb7e42ffb81")))
  }

  async function next() {
    if (saving) return
    const errs = validatePersonal(form, STEPS[step].fields)
    if (Object.keys(errs).length) { setErrors(errs); return }
    setSaving(true)
    try {
      await saveDraft()
      setStep(s => Math.min(s + 1, STEPS.length - 1))
      scrollTop()
    } catch (e) {
      toast.error(e.message === 'Failed to fetch' ? (appMessage("ui.2853bd7844a9")) : (errorMessage(e)))
    }
    setSaving(false)
  }

  function back() {
    setErrors({  })
    setStep(s => Math.max(s - 1, 0))
    scrollTop()
  }

  async function submit() {
    if (saving) return
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
    setSaving(true)
    const { data, error } = await supabase.rpc('save_onboarding', {
      p_data: { ...toPayload(form), privacy_accepted: true }, p_submit: true,
    })
    setSaving(false)
    if (error || !data?.success) {
      const f = data?.field
      if (f) {
        setErrors({ f: (data.error) })
        const idx = STEPS.findIndex(s => s.fields.includes(f))
        if (idx >= 0) { setStep(idx); scrollTop() }
      }
      toast.error((data?.error || appMessage("ui.8d9c237fd495")))
      return
    }
    toast.success(appMessage("ui.6c8dd191bd56"))
    load()
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
        <button className="btn btn-primary" onClick={load}>{tr("ui.7df1d235ed7f")}</button>
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
  const cur = STEPS[step]
  const e = errors
  const inputStyle = k => e[k] ? { borderColor:'var(--danger)' } : undefined
  const taxHint = form.tax_id && cleanTaxId(form.tax_id).length === 11 && !taxIdChecksumOk(form.tax_id)
    ? tr("ui.ac802d1592ea")
    : tr("ui.5840e4818403")

  return (
    <Shell wide>
      <div ref={topRef} />

      {step === 0 && (
        <div className="card" style={{ marginBottom:16 }}>
          <div className="card-body" style={{ fontSize:14, lineHeight:1.65, color:'var(--text-secondary)' }}>
            <div style={{ fontWeight:700, fontSize:17, color:'var(--text-primary)', marginBottom:6 }}>{tr("ui.1fd63804594b")}</div>{tr("ui.b599da32e834")}<div style={{ fontSize:12.5, color:'var(--text-muted)', marginTop:8 }}>{tr("ui.ea566f0677ac")}</div>
          </div>
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
          <div key={s.key} style={{ flex:1, height:4, borderRadius:2, background: i <= step ? 'var(--accent)' : 'var(--border)', transition:'background 0.25s' }} />
        ))}
      </div>
      <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>{tr("ui.c0f684317a91")}{step + 1}{tr("ui.24db69445a9d")}{STEPS.length}
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
            <Field label={tr("ui.807b1204e06c")} error={e.birth_name} hint="Nur falls abweichend vom Nachnamen.">
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
            <Field label={tr("ui.c7a04759d645")} required error={e.phone}>
              <input type="tel" value={form.phone} onChange={ev => set('phone', ev.target.value)} autoComplete="tel" placeholder="+49 170 1234567" style={inputStyle('phone')} />
            </Field>
          </>}

          {cur.key === 'bank' && <>
            <Field label={tr("ui.7e345c3ba789")} required error={e.iban} hint="Konto, auf das dein Lohn überwiesen wird.">
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
              hint="Steht auf deinem Sozialversicherungsausweis. Format: 12 345678 A 123">
              <input value={form.social_security_number} autoCapitalize="characters" spellCheck={false} maxLength={16}
                onChange={ev => set('social_security_number', ev.target.value.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase())}
                placeholder={tr("ui.ac2e02feab3d")} style={{ fontFamily:'monospace', ...inputStyle('social_security_number') }} />
            </Field>
            <Field label={tr("ui.500348e73c9e")} required error={e.health_insurance} hint="z. B. TK, AOK Hessen, Barmer, DAK">
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
              <Field label={tr("ui.e55bff7f9626")} required error={e.other_employment_note} hint="Arbeitgeber, Art (Minijob/Teilzeit) und ungefährer Monatsverdienst.">
                <textarea rows={2} value={form.other_employment_note} onChange={ev => set('other_employment_note', ev.target.value)} style={inputStyle('other_employment_note')} />
              </Field>
            )}
          </>}

          {cur.key === 'emerg' && <>
            <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:12, lineHeight:1.55 }}>{tr("ui.5686c0e747c3")}</div>
            <Field label={tr("ui.f2fbb683da7e")} required error={e.emergency_contact_name}>
              <input value={form.emergency_contact_name} onChange={ev => set('emergency_contact_name', ev.target.value)} placeholder={tr("ui.a0f7975ae8cc")} style={inputStyle('emergency_contact_name')} />
            </Field>
            <Field label={tr("ui.fa6906d76ee9")} required error={e.emergency_contact_phone}>
              <input type="tel" value={form.emergency_contact_phone} onChange={ev => set('emergency_contact_phone', ev.target.value)} style={inputStyle('emergency_contact_phone')} />
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
            <Row label={tr("ui.fa6906d76ee9")} value={form.phone} />
            <Row label={tr("ui.7e345c3ba789")} value={formatIBAN(form.iban)} />
            <Row label={tr("ui.e2ddc853f6c8")} value={form.account_holder} />
            <Row label={tr("ui.45239f930c27")} value={cleanTaxId(form.tax_id)} />
            <Row label={tr("ui.019891f68f41")} value={form.social_security_number} />
            <Row label={tr("ui.500348e73c9e")} value={form.health_insurance} />
            <Row label={tr("ui.ec918980364d")} value={form.other_employment ? tr("ui.bedf0a2cefd6", { p1: (form.other_employment_note) }) : tr("ui.90ebc1bde6f3")} />
            <Row label={tr("ui.b285b3cd6355")} value={`${form.emergency_contact_name}, ${form.emergency_contact_phone}`} />

            <div style={{ marginTop:18, background:'var(--bg)', borderRadius:10, padding:'12px 14px' }}>
              <button type="button" onClick={() => setShowPrivacy(v => !v)} aria-expanded={showPrivacy}
                style={{ background:'none', border:'none', padding:0, cursor:'pointer', fontWeight:600, fontSize:13.5, color:'var(--accent-text, var(--accent))' }}>{tr("ui.845d5ad63023")}{showPrivacy ? 'ausblenden ▲' : 'lesen ▼'}
              </button>
              {showPrivacy && (
                <div style={{ marginTop:10, fontSize:12.5, lineHeight:1.6, color:'var(--text-secondary)' }}>
                  <PrivacyNotice />
                </div>
              )}
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', marginTop:12, cursor:'pointer', fontSize:13, color:'var(--text-primary)' }}>
                <input type="checkbox" checked={privacy} style={{ width:18, height:18, marginTop:1, flexShrink:0 }}
                  onChange={ev => { setPrivacy(ev.target.checked); setErrors(x => { const n = { ...x }; delete n.privacy_accepted; return n }) }} />
                <span>{tr("ui.4839bfa3b16c")}</span>
              </label>
              {e.privacy_accepted && <div role="alert" style={{ fontSize:12, color:'var(--danger)', marginTop:6 }}>{e.privacy_accepted}</div>}
            </div>
          </>}

          <div style={{ display:'flex', gap:10, marginTop:20 }}>
            {step > 0 && <button className="btn" onClick={back} disabled={saving} style={{ flex:1, justifyContent:'center' }}>{tr("ui.10eefef364ea")}</button>}
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
