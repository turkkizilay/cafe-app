import { t as tr, getIntlLocale, message as appMessage, localizeMessage } from '../i18n/runtime.js'
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
  if (!iso) return appMessage("ui.05fd7f5ca1a8")
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d)) return appMessage("ui.35161719bf60")
  const now = new Date()
  const min = new Date(now.getFullYear() - 100, now.getMonth(), now.getDate())
  const max = new Date(now.getFullYear() - 14, now.getMonth(), now.getDate())
  if (d < min || d > max) return appMessage("ui.92714978d366")
  return null
}

export const FIELD_MESSAGES = Object.freeze({
  first_name: appMessage("ui.d2d77b6ffa70"), last_name: appMessage("ui.b25358edd497"), birth_name: appMessage("ui.807b1204e06c"),
  birth_date: appMessage("ui.6882904da71a"), birth_place: appMessage("ui.590571d3da6b"), nationality: appMessage("ui.3e3a47041a87"),
  street: appMessage("ui.58a3778c18c4"), house_number: appMessage("ui.f5cff23f21bc"), postal_code: appMessage("ui.c6127fd4465d"), city: appMessage("ui.30fb259129e5"), phone: appMessage("ui.fa6906d76ee9"),
  iban: 'IBAN', account_holder: appMessage("ui.e2ddc853f6c8"), tax_id: appMessage("ui.45239f930c27"),
  social_security_number: appMessage("ui.5acdea3be6d5"), health_insurance: appMessage("ui.500348e73c9e"),
  other_employment: appMessage("ui.ec918980364d"), other_employment_note: appMessage("ui.79b6935488aa"),
  emergency_contact_name: appMessage("field.emergency_contact_name"), emergency_contact_phone: appMessage("ui.c8026f02cec3"),
  privacy_accepted: appMessage("ui.f9d49ce8555b"),
})

// Immediate labels and retained parameters share the same field keys.
export const FIELD_LABELS = Object.defineProperties({}, Object.fromEntries(
  Object.entries(FIELD_MESSAGES).map(([field, value]) => [field, { enumerable: true, get: () => localizeMessage(value) }])
))

// Pflichtfelder (identisch mit dem Server)
export const REQUIRED_FIELDS = [
  'first_name', 'last_name', 'birth_date', 'street', 'house_number', 'postal_code', 'city', 'phone',
  'iban', 'account_holder', 'tax_id', 'social_security_number', 'health_insurance',
  'other_employment', 'emergency_contact_name', 'emergency_contact_phone',
]

/** Prüft die angegebenen Felder; liefert { feld: Nachrichtendeskriptor } */
export function validatePersonal(form, fields) {
  const err = {}
  const empty = v => v === null || v === undefined || String(v).trim() === ''
  for (const f of fields) {
    const v = form[f]
    if (REQUIRED_FIELDS.includes(f) && empty(v)) { err[f] = appMessage("ui.f5fd476de96f"); continue }
    if (empty(v)) continue
    if (f === 'birth_date') { const p = birthDateProblem(v); if (p) err[f] = p }
    if (f === 'postal_code' && !isValidPLZ(v)) err[f] = appMessage("ui.b81a5a4789c4")
    if (f === 'iban' && !isValidIBAN(v)) err[f] = appMessage("ui.60dfef793833")
    if (f === 'tax_id' && !isValidTaxIdFormat(v)) err[f] = appMessage("ui.b626330306ae")
    if (f === 'social_security_number' && !isValidSV(v)) err[f] = appMessage("ui.671552d6a9b8")
    if ((f === 'phone' || f === 'emergency_contact_phone') && !/^[+0-9 ()/-]{6,}$/.test(String(v).trim())) err[f] = appMessage("ui.f64f6ea3e495")
  }
  if (fields.includes('other_employment_note') && form.other_employment === true && empty(form.other_employment_note)) {
    err.other_employment_note = appMessage("ui.6d3ee19a7bc7")
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
