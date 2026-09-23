// Gemeinsame Prüf- und Formatierungsregeln für Personaldaten.
// Spiegelt die serverseitigen Prüfungen in save_onboarding / update_own_personal_data.
// Der Server prüft immer selbst — das hier ist nur für schnelles, verständliches Feedback.

export const cleanIBAN = v => (v || '').replace(/\s/g, '').toUpperCase()
export const cleanTaxId = v => (v || '').replace(/\s/g, '')
export const cleanSV = v => (v || '').replace(/\s/g, '').toUpperCase()

// IBAN inkl. Prüfsumme (ISO 13616, mod 97)
export function isValidIBAN(v) {
  const iban = cleanIBAN(v)
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  if (iban.startsWith('DE') && iban.length !== 22) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of n) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1
}

export function formatIBAN(v) {
  return cleanIBAN(v).replace(/(.{4})/g, '$1 ').trim()
}

export const isValidTaxIdFormat = v => /^[0-9]{11}$/.test(cleanTaxId(v))

// Prüfziffer der Steuer-ID (ISO 7064 MOD 11,10) — nur als Hinweis, nicht blockierend
export function taxIdChecksumOk(v) {
  const id = cleanTaxId(v)
  if (!/^[1-9][0-9]{10}$/.test(id)) return false
  let product = 10
  for (let i = 0; i < 10; i++) {
    let sum = (Number(id[i]) + product) % 10
    if (sum === 0) sum = 10
    product = (sum * 2) % 11
  }
  let check = 11 - product
  if (check === 10) check = 0
  return check === Number(id[10])
}

export const isValidSV = v => /^[0-9]{8}[A-Z][0-9]{3}$/.test(cleanSV(v))
export const isValidPLZ = v => /^[0-9]{5}$/.test((v || '').trim())

export function birthDateProblem(iso) {
  if (!iso) return 'Bitte gib dein Geburtsdatum an.'
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d)) return 'Das Geburtsdatum ist ungültig.'
  const now = new Date()
  const min = new Date(now.getFullYear() - 100, now.getMonth(), now.getDate())
  const max = new Date(now.getFullYear() - 14, now.getMonth(), now.getDate())
  if (d < min || d > max) return 'Bitte prüfe dein Geburtsdatum.'
  return null
}

export const FIELD_LABELS = {
  first_name: 'Vorname', last_name: 'Nachname', birth_name: 'Geburtsname',
  birth_date: 'Geburtsdatum', birth_place: 'Geburtsort', nationality: 'Staatsangehörigkeit',
  street: 'Straße', house_number: 'Hausnummer', postal_code: 'PLZ', city: 'Ort', phone: 'Telefon',
  iban: 'IBAN', account_holder: 'Kontoinhaber', tax_id: 'Steuer-ID',
  social_security_number: 'Sozialversicherungsnummer', health_insurance: 'Krankenkasse',
  other_employment: 'Weitere Beschäftigung', other_employment_note: 'Angaben zur weiteren Beschäftigung',
  emergency_contact_name: 'Notfallkontakt (Name)', emergency_contact_phone: 'Notfallkontakt (Telefon)',
  privacy_accepted: 'Datenschutzhinweis',
}

// Pflichtfelder (identisch mit dem Server)
export const REQUIRED_FIELDS = [
  'first_name', 'last_name', 'birth_date', 'street', 'house_number', 'postal_code', 'city', 'phone',
  'iban', 'account_holder', 'tax_id', 'social_security_number', 'health_insurance',
  'other_employment', 'emergency_contact_name', 'emergency_contact_phone',
]

/** Prüft die angegebenen Felder; liefert { feld: 'Fehlertext' } */
export function validatePersonal(form, fields) {
  const err = {}
  const empty = v => v === null || v === undefined || String(v).trim() === ''
  for (const f of fields) {
    const v = form[f]
    if (REQUIRED_FIELDS.includes(f) && empty(v)) { err[f] = 'Pflichtfeld'; continue }
    if (empty(v)) continue
    if (f === 'birth_date') { const p = birthDateProblem(v); if (p) err[f] = p }
    if (f === 'postal_code' && !isValidPLZ(v)) err[f] = 'Die PLZ muss 5 Ziffern haben.'
    if (f === 'iban' && !isValidIBAN(v)) err[f] = 'Diese IBAN ist ungültig. Bitte genau prüfen.'
    if (f === 'tax_id' && !isValidTaxIdFormat(v)) err[f] = 'Die Steuer-ID besteht aus 11 Ziffern.'
    if (f === 'social_security_number' && !isValidSV(v)) err[f] = 'Format: 12 345678 A 123 (8 Ziffern, 1 Buchstabe, 3 Ziffern).'
    if ((f === 'phone' || f === 'emergency_contact_phone') && !/^[+0-9 ()/-]{6,}$/.test(String(v).trim())) err[f] = 'Bitte eine gültige Telefonnummer angeben.'
  }
  if (fields.includes('other_employment_note') && form.other_employment === true && empty(form.other_employment_note)) {
    err.other_employment_note = 'Bitte kurz angeben (z. B. Minijob bei …, ca. 400 € / Monat).'
  }
  return err
}

// Daten, die an die RPCs gehen (Whitelist)
export const PERSONAL_FIELDS = [
  'first_name', 'last_name', 'birth_name', 'birth_date', 'birth_place', 'nationality',
  'street', 'house_number', 'postal_code', 'city', 'phone',
  'iban', 'account_holder', 'tax_id', 'social_security_number', 'health_insurance',
  'other_employment', 'other_employment_note', 'emergency_contact_name', 'emergency_contact_phone',
]

export function toPayload(form) {
  const out = {}
  for (const f of PERSONAL_FIELDS) {
    let v = form[f]
    if (f === 'other_employment') { out[f] = v === true ? true : v === false ? false : null; continue }
    v = v == null ? '' : String(v).trim()
    if (f === 'iban') v = cleanIBAN(v)
    if (f === 'tax_id') v = cleanTaxId(v)
    if (f === 'social_security_number') v = cleanSV(v)
    out[f] = v
  }
  if (out.other_employment !== true) out.other_employment_note = ''
  return out
}
