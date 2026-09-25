import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate } from '../i18n/format.js'
import { useToast } from './UI/Toast'
import { validatePersonal, formatIBAN, cleanTaxId, taxIdChecksumOk, REQUIRED_FIELDS, FIELD_LABELS, FIELD_MESSAGES } from '../lib/personalData'

// Felder, die ein Mitarbeiter selbst pflegen darf (Name & Arbeitsdaten nur Management)
const EDIT_FIELDS = [
  'birth_name', 'birth_date', 'birth_place', 'nationality',
  'street', 'house_number', 'postal_code', 'city', 'phone',
  'iban', 'account_holder', 'tax_id', 'social_security_number', 'health_insurance',
  'other_employment', 'other_employment_note', 'emergency_contact_name', 'emergency_contact_phone',
]

/** Welche Pflichtangaben fehlen im Mitarbeiter-Datensatz? (für "Profil vervollständigen") */
export function missingPersonalFields(emp) {
  if (!emp) return []
  return REQUIRED_FIELDS.filter(f => {
    if (f === 'first_name' || f === 'last_name') return false
    const v = emp[f]
    return v === null || v === undefined || String(v).trim() === ''
  })
}

function mask(v, keepStart = 2, keepEnd = 2) {
  if (!v) return null
  const s = String(v)
  if (s.length <= keepStart + keepEnd) return '••••'
  return s.slice(0, keepStart) + '•'.repeat(Math.max(4, s.length - keepStart - keepEnd)) + s.slice(-keepEnd)
}

function Item({ label, value, full, secret, shown }) {
  useLocale()
  return (
    <div style={{ background:'var(--bg)', borderRadius:8, padding:'10px 12px', gridColumn: full ? '1/-1' : undefined, minWidth:0 }}>
      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:500, wordBreak:'break-word', fontFamily: secret ? 'monospace' : undefined }}>
        {value ? (secret && !shown ? secret : value) : <span style={{ color:'var(--text-muted)', fontWeight:400 }}>—</span>}
      </div>
    </div>
  )
}

function empToForm(emp) {
  const f = {}
  for (const k of EDIT_FIELDS) f[k] = emp?.[k] ?? (k === 'other_employment' ? null : '')
  if (f.iban) f.iban = formatIBAN(f.iban)
  return f
}

export default function PersonalDataCard({ employee, onSaved }) {
  useLocale()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [form,    setForm]    = useState(() => empToForm(employee))
  const [errors,  setErrors]  = useState({})
  const [saving,  setSaving]  = useState(false)
  const [shown,   setShown]   = useState(false)

  const missing = missingPersonalFields(employee)
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); if (errors[k]) setErrors(e => { const n = { ...e }; delete n[k]; return n }) }
  const inErr = k => errors[k] ? { borderColor:'var(--danger)' } : undefined
  const Err = ({ k }) => errors[k] ? <div role="alert" style={{ fontSize:12, color:'var(--danger)', marginTop:4 }}>{localizeMessage(errors[k])}</div> : null
  const req = k => REQUIRED_FIELDS.includes(k) ? <span style={{ color:'var(--danger)' }}> *</span> : null

  function startEdit() { setForm(empToForm(employee)); setErrors({  }); setEditing(true) }

  async function save() {
    if (saving) return
    // Pflichtfelder nur prüfen, wenn schon etwas drinsteht oder das Feld früher befüllt war —
    // so können Bestands-Mitarbeiter Schritt für Schritt vervollständigen.
    const toCheck = EDIT_FIELDS.filter(k => {
      const v = form[k]
      const had = employee?.[k] !== null && employee?.[k] !== undefined && String(employee[k]).trim() !== ''
      return had || (v !== null && v !== undefined && String(v).trim() !== '')
    })
    const errs = validatePersonal(form, toCheck.includes('other_employment') ? [...toCheck, 'other_employment_note'] : toCheck)
    if (Object.keys(errs).length) { setErrors(errs); toast.error(appMessage("ui.e3ae0cb41d9b", { p1: (FIELD_MESSAGES[Object.keys(errs)[0]]) })); return }

    const payload = {}
    for (const k of EDIT_FIELDS) {
      let v = form[k]
      if (k === 'other_employment') { payload[k] = v === true ? true : v === false ? false : null; continue }
      v = v == null ? '' : String(v).trim()
      if (k === 'iban' || k === 'social_security_number') v = v.replace(/\s/g, '').toUpperCase()
      if (k === 'tax_id') v = cleanTaxId(v)
      payload[k] = v
    }
    setSaving(true)
    const { data, error } = await supabase.rpc('update_own_personal_data', { p_data: payload })
    setSaving(false)
    if (error || !data?.success) {
      if (data?.field) setErrors({ [data.field]: (data.error) })
      toast.error((data?.error || appMessage("ui.e478b1785c61")))
      return
    }
    toast.success(appMessage("ui.1b52debec850"))
    setEditing(false)
    onSaved?.()
  }

  const e = employee || {}
  const addr = e.street ? `${e.street} ${e.house_number || ''}, ${e.postal_code || ''} ${e.city || ''}` : e.address

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">{tr("ui.00f621f89945")}</div>
        {!editing && <button className="btn btn-sm btn-primary" onClick={startEdit}>{tr("ui.10b85209d6db")}</button>}
      </div>
      <div style={{ padding:16 }}>
        {!editing && missing.length > 0 && (
          <div style={{ background:'var(--warn-bg)', border:'1px solid #FDE68A', borderRadius:10, padding:'10px 12px', marginBottom:14, fontSize:13, lineHeight:1.55 }}>
            <strong>{tr("ui.4c15978c2e5e")}</strong> {missing.map(f => FIELD_LABELS[f]).join(', ')}.
            <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{tr("ui.0f20d001f7bb")}</div>
          </div>
        )}

        {!editing ? (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Item label={tr("ui.63bbf72bd563")} value={e.phone} />
              <Item label={tr("ui.c84f9ec1cba0")} value={e.birth_date ? formatDate(e.birth_date) : null} />
              {(e.birth_name || e.birth_place) && <Item label={tr("ui.0b49710565de")} value={[e.birth_name, e.birth_place].filter(Boolean).join(' · ')} />}
              <Item label={tr("ui.3e3a47041a87")} value={e.nationality} />
              <Item label={tr("ui.7a9225c09b4f")} value={addr} full />
              <Item label={tr("ui.e89a7a52b1cb")} value={e.iban ? formatIBAN(e.iban) : null} secret={e.iban ? `${e.iban.slice(0,2)}•• •••• •••• •••• •••• ${e.iban.slice(-2)}` : null} shown={shown} full />
              <Item label={tr("ui.e2ddc853f6c8")} value={e.account_holder} />
              <Item label={tr("ui.500348e73c9e")} value={e.health_insurance} />
              <Item label={tr("ui.45239f930c27")} value={e.tax_id} secret={mask(e.tax_id, 2, 2)} shown={shown} />
              <Item label={tr("ui.019891f68f41")} value={e.social_security_number} secret={mask(e.social_security_number, 2, 2)} shown={shown} />
              <Item label={tr("ui.ec918980364d")} value={e.other_employment == null ? null : e.other_employment ? tr("ui.bedf0a2cefd6", { p1: (e.other_employment_note || '') }) : tr("ui.90ebc1bde6f3")} full />
              <Item label={tr("ui.22e4b3bf0d7a")} value={e.emergency_contact_name ? `${e.emergency_contact_name}${e.emergency_contact_phone ? ', ' + e.emergency_contact_phone : ''}` : null} full />
            </div>
            {(e.iban || e.tax_id || e.social_security_number) && (
              <button className="btn btn-sm" style={{ marginTop:10 }} onClick={() => setShown(s => !s)}>
                {shown ? tr("ui.a5f23d95fbb8") : tr("ui.af3020d26dd3")}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="alert alert-info" style={{ marginBottom:16, fontSize:12 }}>{tr("ui.c71925885ffa")}</div>

            <div className="two-col">
              <div className="form-group"><label>{tr("ui.63bbf72bd563")}{req('phone')}</label>
                <input type="tel" value={form.phone} onChange={ev => set('phone', ev.target.value)} style={inErr('phone')} /><Err k="phone" /></div>
              <div className="form-group"><label>{tr("ui.c84f9ec1cba0")}{req('birth_date')}</label>
                <input type="date" value={form.birth_date || ''} onChange={ev => set('birth_date', ev.target.value)} style={inErr('birth_date')} /><Err k="birth_date" /></div>
            </div>
            <div className="two-col">
              <div className="form-group"><label>{tr("ui.807b1204e06c")}</label>
                <input value={form.birth_name} onChange={ev => set('birth_name', ev.target.value)} /></div>
              <div className="form-group"><label>{tr("ui.590571d3da6b")}</label>
                <input value={form.birth_place} onChange={ev => set('birth_place', ev.target.value)} /></div>
            </div>
            <div className="form-group"><label>{tr("ui.3e3a47041a87")}</label>
              <input value={form.nationality} onChange={ev => set('nationality', ev.target.value)} /></div>

            {!e.street && e.address && (
              <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:8 }}>{tr("ui.0485c268a1ab")}{e.address}</div>
            )}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 100px', gap:12 }}>
              <div className="form-group"><label>{tr("ui.58a3778c18c4")}{req('street')}</label>
                <input value={form.street} onChange={ev => set('street', ev.target.value)} style={inErr('street')} /><Err k="street" /></div>
              <div className="form-group"><label>{tr("ui.318ca5480cb8")}{req('house_number')}</label>
                <input value={form.house_number} onChange={ev => set('house_number', ev.target.value)} style={inErr('house_number')} /><Err k="house_number" /></div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'100px 1fr', gap:12 }}>
              <div className="form-group"><label>{tr("ui.c6127fd4465d")}{req('postal_code')}</label>
                <input inputMode="numeric" maxLength={5} value={form.postal_code} onChange={ev => set('postal_code', ev.target.value.replace(/\D/g, ''))} style={inErr('postal_code')} /><Err k="postal_code" /></div>
              <div className="form-group"><label>{tr("ui.30fb259129e5")}{req('city')}</label>
                <input value={form.city} onChange={ev => set('city', ev.target.value)} style={inErr('city')} /><Err k="city" /></div>
            </div>

            <div className="form-group"><label>{tr("ui.e89a7a52b1cb")}{req('iban')}</label>
              <input value={form.iban} autoCapitalize="characters" spellCheck={false}
                onChange={ev => set('iban', formatIBAN(ev.target.value.replace(/[^A-Za-z0-9]/g, '')))}
                placeholder={tr("ui.7f377fd57c25")} style={{ fontFamily:'monospace', ...inErr('iban') }} /><Err k="iban" /></div>
            <div className="form-group"><label>{tr("ui.e2ddc853f6c8")}{req('account_holder')}</label>
              <input value={form.account_holder} onChange={ev => set('account_holder', ev.target.value)} style={inErr('account_holder')} /><Err k="account_holder" /></div>

            <div className="two-col">
              <div className="form-group"><label>{tr("ui.45239f930c27")}{req('tax_id')}</label>
                <input inputMode="numeric" maxLength={14} value={form.tax_id} onChange={ev => set('tax_id', ev.target.value.replace(/[^0-9 ]/g, ''))} style={{ fontFamily:'monospace', ...inErr('tax_id') }} />
                <Err k="tax_id" />
                {!errors.tax_id && form.tax_id && cleanTaxId(form.tax_id).length === 11 && !taxIdChecksumOk(form.tax_id) && (
                  <div style={{ fontSize:11.5, color:'var(--warn)', marginTop:4 }}>{tr("ui.d63584f8c4e2")}</div>
                )}
              </div>
              <div className="form-group"><label>{tr("ui.019891f68f41")}{req('social_security_number')}</label>
                <input maxLength={16} autoCapitalize="characters" value={form.social_security_number}
                  onChange={ev => set('social_security_number', ev.target.value.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase())}
                  placeholder={tr("ui.ac2e02feab3d")} style={{ fontFamily:'monospace', ...inErr('social_security_number') }} /><Err k="social_security_number" /></div>
            </div>
            <div className="form-group"><label>{tr("ui.500348e73c9e")}{req('health_insurance')}</label>
              <input value={form.health_insurance} onChange={ev => set('health_insurance', ev.target.value)} style={inErr('health_insurance')} /><Err k="health_insurance" /></div>

            <div className="form-group"><label>{tr("ui.00b8c8ee3c65")}{req('other_employment')}</label>
              <div style={{ display:'flex', gap:10 }}>
                {[[tr("ui.90ebc1bde6f3"), false], [tr("ui.cde9e58a9a4e"), true]].map(([l, v]) => (
                  <button key={l} type="button" className={`btn ${form.other_employment === v ? 'btn-primary' : ''}`}
                    style={{ flex:1, justifyContent:'center' }} aria-pressed={form.other_employment === v}
                    onClick={() => set('other_employment', v)}>{l}</button>
                ))}
              </div><Err k="other_employment" /></div>
            {form.other_employment === true && (
              <div className="form-group"><label>{tr("ui.e55bff7f9626")}</label>
                <textarea rows={2} value={form.other_employment_note} onChange={ev => set('other_employment_note', ev.target.value)} style={inErr('other_employment_note')} /><Err k="other_employment_note" /></div>
            )}

            <div className="two-col">
              <div className="form-group"><label>{tr("ui.22e4b3bf0d7a")}{req('emergency_contact_name')}</label>
                <input value={form.emergency_contact_name} onChange={ev => set('emergency_contact_name', ev.target.value)} placeholder={tr("ui.b477ea2eeac6")} style={inErr('emergency_contact_name')} /><Err k="emergency_contact_name" /></div>
              <div className="form-group"><label>{tr("ui.0d21914d5fd4")}{req('emergency_contact_phone')}</label>
                <input type="tel" value={form.emergency_contact_phone} onChange={ev => set('emergency_contact_phone', ev.target.value)} style={inErr('emergency_contact_phone')} /><Err k="emergency_contact_phone" /></div>
            </div>

            <div style={{ display:'flex', gap:10, marginTop:8 }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? tr("ui.d2c1c54d11df") : tr("ui.22158eab4b10")}</button>
              <button className="btn" onClick={() => { setEditing(false); setErrors({  }) }} disabled={saving}>{tr("ui.f7ff1178af20")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
