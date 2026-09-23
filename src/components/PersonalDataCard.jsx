import { useState } from 'react'
import { supabase, formatDate } from '../lib/supabase'
import { useToast } from './UI/Toast'
import { validatePersonal, formatIBAN, cleanTaxId, taxIdChecksumOk, REQUIRED_FIELDS, FIELD_LABELS } from '../lib/personalData'

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
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [form,    setForm]    = useState(() => empToForm(employee))
  const [errors,  setErrors]  = useState({})
  const [saving,  setSaving]  = useState(false)
  const [shown,   setShown]   = useState(false)

  const missing = missingPersonalFields(employee)
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); if (errors[k]) setErrors(e => { const n = { ...e }; delete n[k]; return n }) }
  const inErr = k => errors[k] ? { borderColor:'var(--danger)' } : undefined
  const Err = ({ k }) => errors[k] ? <div role="alert" style={{ fontSize:12, color:'var(--danger)', marginTop:4 }}>{errors[k]}</div> : null
  const req = k => REQUIRED_FIELDS.includes(k) ? <span style={{ color:'var(--danger)' }}> *</span> : null

  function startEdit() { setForm(empToForm(employee)); setErrors({}); setEditing(true) }

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
    if (Object.keys(errs).length) { setErrors(errs); toast.error(`Bitte prüfe: ${FIELD_LABELS[Object.keys(errs)[0]]}`); return }

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
      if (data?.field) setErrors({ [data.field]: data.error })
      toast.error(data?.error || 'Speichern fehlgeschlagen. Bitte erneut versuchen.')
      return
    }
    toast.success('✅ Deine Daten wurden gespeichert.')
    setEditing(false)
    onSaved?.()
  }

  const e = employee || {}
  const addr = e.street ? `${e.street} ${e.house_number || ''}, ${e.postal_code || ''} ${e.city || ''}` : e.address

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">✏️ Persönliche Daten</div>
        {!editing && <button className="btn btn-sm btn-primary" onClick={startEdit}>✏️ Bearbeiten</button>}
      </div>
      <div style={{ padding:16 }}>
        {!editing && missing.length > 0 && (
          <div style={{ background:'var(--warn-bg)', border:'1px solid #FDE68A', borderRadius:10, padding:'10px 12px', marginBottom:14, fontSize:13, lineHeight:1.55 }}>
            <strong>Bitte vervollständigen:</strong> {missing.map(f => FIELD_LABELS[f]).join(', ')}.
            <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>Diese Angaben brauchen wir für die Lohnabrechnung.</div>
          </div>
        )}

        {!editing ? (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Item label="📞 Telefon" value={e.phone} />
              <Item label="🎂 Geburtsdatum" value={e.birth_date ? formatDate(e.birth_date) : null} />
              {(e.birth_name || e.birth_place) && <Item label="Geburtsname / -ort" value={[e.birth_name, e.birth_place].filter(Boolean).join(' · ')} />}
              <Item label="Staatsangehörigkeit" value={e.nationality} />
              <Item label="🏠 Adresse" value={addr} full />
              <Item label="🏦 IBAN" value={e.iban ? formatIBAN(e.iban) : null} secret={e.iban ? `${e.iban.slice(0,2)}•• •••• •••• •••• •••• ${e.iban.slice(-2)}` : null} shown={shown} full />
              <Item label="Kontoinhaber" value={e.account_holder} />
              <Item label="Krankenkasse" value={e.health_insurance} />
              <Item label="Steuer-ID" value={e.tax_id} secret={mask(e.tax_id, 2, 2)} shown={shown} />
              <Item label="SV-Nummer" value={e.social_security_number} secret={mask(e.social_security_number, 2, 2)} shown={shown} />
              <Item label="Weitere Beschäftigung" value={e.other_employment == null ? null : e.other_employment ? `Ja – ${e.other_employment_note || ''}` : 'Nein'} full />
              <Item label="🚑 Notfallkontakt" value={e.emergency_contact_name ? `${e.emergency_contact_name}${e.emergency_contact_phone ? ', ' + e.emergency_contact_phone : ''}` : null} full />
            </div>
            {(e.iban || e.tax_id || e.social_security_number) && (
              <button className="btn btn-sm" style={{ marginTop:10 }} onClick={() => setShown(s => !s)}>
                {shown ? '🙈 Sensible Daten verbergen' : '👁️ Sensible Daten anzeigen'}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="alert alert-info" style={{ marginBottom:16, fontSize:12 }}>
              🔒 Name und Arbeitsdaten (Stundenlohn, Urlaub, Position …) ändert nur das Management.
              Änderungen an Bank-, Steuer- und SV-Daten werden protokolliert.
            </div>

            <div className="two-col">
              <div className="form-group"><label>📞 Telefon{req('phone')}</label>
                <input type="tel" value={form.phone} onChange={ev => set('phone', ev.target.value)} style={inErr('phone')} /><Err k="phone" /></div>
              <div className="form-group"><label>🎂 Geburtsdatum{req('birth_date')}</label>
                <input type="date" value={form.birth_date || ''} onChange={ev => set('birth_date', ev.target.value)} style={inErr('birth_date')} /><Err k="birth_date" /></div>
            </div>
            <div className="two-col">
              <div className="form-group"><label>Geburtsname</label>
                <input value={form.birth_name} onChange={ev => set('birth_name', ev.target.value)} /></div>
              <div className="form-group"><label>Geburtsort</label>
                <input value={form.birth_place} onChange={ev => set('birth_place', ev.target.value)} /></div>
            </div>
            <div className="form-group"><label>Staatsangehörigkeit</label>
              <input value={form.nationality} onChange={ev => set('nationality', ev.target.value)} /></div>

            {!e.street && e.address && (
              <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:8 }}>Bisher hinterlegt: {e.address}</div>
            )}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 100px', gap:12 }}>
              <div className="form-group"><label>Straße{req('street')}</label>
                <input value={form.street} onChange={ev => set('street', ev.target.value)} style={inErr('street')} /><Err k="street" /></div>
              <div className="form-group"><label>Nr.{req('house_number')}</label>
                <input value={form.house_number} onChange={ev => set('house_number', ev.target.value)} style={inErr('house_number')} /><Err k="house_number" /></div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'100px 1fr', gap:12 }}>
              <div className="form-group"><label>PLZ{req('postal_code')}</label>
                <input inputMode="numeric" maxLength={5} value={form.postal_code} onChange={ev => set('postal_code', ev.target.value.replace(/\D/g, ''))} style={inErr('postal_code')} /><Err k="postal_code" /></div>
              <div className="form-group"><label>Ort{req('city')}</label>
                <input value={form.city} onChange={ev => set('city', ev.target.value)} style={inErr('city')} /><Err k="city" /></div>
            </div>

            <div className="form-group"><label>🏦 IBAN{req('iban')}</label>
              <input value={form.iban} autoCapitalize="characters" spellCheck={false}
                onChange={ev => set('iban', formatIBAN(ev.target.value.replace(/[^A-Za-z0-9]/g, '')))}
                placeholder="DE89 3704 0044 0532 0130 00" style={{ fontFamily:'monospace', ...inErr('iban') }} /><Err k="iban" /></div>
            <div className="form-group"><label>Kontoinhaber{req('account_holder')}</label>
              <input value={form.account_holder} onChange={ev => set('account_holder', ev.target.value)} style={inErr('account_holder')} /><Err k="account_holder" /></div>

            <div className="two-col">
              <div className="form-group"><label>Steuer-ID{req('tax_id')}</label>
                <input inputMode="numeric" maxLength={14} value={form.tax_id} onChange={ev => set('tax_id', ev.target.value.replace(/[^0-9 ]/g, ''))} style={{ fontFamily:'monospace', ...inErr('tax_id') }} />
                <Err k="tax_id" />
                {!errors.tax_id && form.tax_id && cleanTaxId(form.tax_id).length === 11 && !taxIdChecksumOk(form.tax_id) && (
                  <div style={{ fontSize:11.5, color:'var(--warn)', marginTop:4 }}>⚠️ Prüfziffer passt nicht — bitte noch einmal vergleichen.</div>
                )}
              </div>
              <div className="form-group"><label>SV-Nummer{req('social_security_number')}</label>
                <input maxLength={16} autoCapitalize="characters" value={form.social_security_number}
                  onChange={ev => set('social_security_number', ev.target.value.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase())}
                  placeholder="12 345678 A 123" style={{ fontFamily:'monospace', ...inErr('social_security_number') }} /><Err k="social_security_number" /></div>
            </div>
            <div className="form-group"><label>Krankenkasse{req('health_insurance')}</label>
              <input value={form.health_insurance} onChange={ev => set('health_insurance', ev.target.value)} style={inErr('health_insurance')} /><Err k="health_insurance" /></div>

            <div className="form-group"><label>Weitere Beschäftigung?{req('other_employment')}</label>
              <div style={{ display:'flex', gap:10 }}>
                {[['Nein', false], ['Ja', true]].map(([l, v]) => (
                  <button key={l} type="button" className={`btn ${form.other_employment === v ? 'btn-primary' : ''}`}
                    style={{ flex:1, justifyContent:'center' }} aria-pressed={form.other_employment === v}
                    onClick={() => set('other_employment', v)}>{l}</button>
                ))}
              </div><Err k="other_employment" /></div>
            {form.other_employment === true && (
              <div className="form-group"><label>Welche?</label>
                <textarea rows={2} value={form.other_employment_note} onChange={ev => set('other_employment_note', ev.target.value)} style={inErr('other_employment_note')} /><Err k="other_employment_note" /></div>
            )}

            <div className="two-col">
              <div className="form-group"><label>🚑 Notfallkontakt{req('emergency_contact_name')}</label>
                <input value={form.emergency_contact_name} onChange={ev => set('emergency_contact_name', ev.target.value)} placeholder="Name (Beziehung)" style={inErr('emergency_contact_name')} /><Err k="emergency_contact_name" /></div>
              <div className="form-group"><label>Telefon Notfallkontakt{req('emergency_contact_phone')}</label>
                <input type="tel" value={form.emergency_contact_phone} onChange={ev => set('emergency_contact_phone', ev.target.value)} style={inErr('emergency_contact_phone')} /><Err k="emergency_contact_phone" /></div>
            </div>

            <div style={{ display:'flex', gap:10, marginTop:8 }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '⏳ Speichern…' : '💾 Speichern'}</button>
              <button className="btn" onClick={() => { setEditing(false); setErrors({}) }} disabled={saving}>Abbrechen</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
