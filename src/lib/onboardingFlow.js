// Onboarding-Ablauf (Migration 28): Der Server ist die Quelle der Wahrheit. Der Schritt wird aus den gespeicherten
// Angaben abgeleitet (nicht aus Client-Zustand), jede Speicherung trägt die zuletzt gesehene Revision, und eine
// ausbleibende Antwort wird am Serverstand entschieden – nie geraten.
import { boundedRequest } from './boundedRequest.js'
import { validatePersonal, PERSONAL_FIELDS, formatIBAN, toPayload } from './personalData.js'

// Schritte und ihre Felder (Reihenfolge = Formular)
export const STEP_KEYS = ['person', 'contact', 'bank', 'payroll', 'emerg', 'review']
export const STEP_FIELDS = Object.freeze({
  person:  ['first_name', 'last_name', 'birth_name', 'birth_date', 'birth_place', 'nationality'],
  contact: ['street', 'house_number', 'postal_code', 'city', 'phone'],
  bank:    ['iban', 'account_holder'],
  payroll: ['tax_id', 'social_security_number', 'health_insurance', 'other_employment', 'other_employment_note'],
  emerg:   ['emergency_contact_name', 'emergency_contact_phone'],
  review:  [],
})
export const REVIEW_STEP = STEP_KEYS.length - 1
export const EDITABLE = ['draft', 'changes_requested']

// Obergrenzen je Anfrage (normal < 0,5 s); danach klare Meldung statt endlosem „Speichert…“
export const ONB_TIMEOUT = { read: 20000, write: 25000 }

export function rowToForm(row) {
  const f = {}
  for (const k of PERSONAL_FIELDS) f[k] = row?.[k] ?? (k === 'other_employment' ? null : '')
  if (f.iban) f.iban = formatIBAN(f.iban)
  return f
}

// Erster Schritt, dessen Angaben noch nicht vollständig/gültig sind; alles vollständig → Übersicht.
// Hängt nur an den gespeicherten Daten: Neu laden, anderes Gerät, Login statt Link → gleicher Punkt.
export function resumeStep(form) {
  const i = STEP_KEYS.findIndex(k => STEP_FIELDS[k].length && Object.keys(validatePersonal(form, STEP_FIELDS[k])).length)
  return i < 0 ? REVIEW_STEP : i
}

// Ein Schritt gilt als erreichbar, wenn alle Schritte davor vollständig sind (kein Überspringen per Zustand)
export const canOpenStep = (form, i) => i <= resumeStep(form)

// Wie der Server normalisiert (save_onboarding): für den Vergleich „steht genau das gespeichert?“
function norm(f, v) {
  if (f === 'other_employment') return v === true ? true : v === false ? false : null
  if (v == null) return null
  let s = String(v).trim()
  if (f === 'iban' || f === 'social_security_number') s = s.replace(/\s/g, '').toUpperCase()
  if (f === 'tax_id') s = s.replace(/\s/g, '')
  return s === '' ? null : s
}
export function matchesPayload(row, payload) {
  const note = payload.other_employment === true ? payload.other_employment_note : ''
  return PERSONAL_FIELDS.every(f => norm(f, row?.[f]) === norm(f, f === 'other_employment_note' ? note : payload[f]))
}

// Nach einem Konflikt: eigene, noch nicht gespeicherte Eingaben des aktuellen Schritts behalten – aber nur in Feldern,
// die das andere Fenster/Gerät NICHT geändert hat (Drei-Wege-Vergleich gegen den zuletzt bekannten Serverstand `base`).
// Beide geändert → Serverstand gewinnt (sichtbar, nichts wird still überschrieben).
export function mergeUnsaved(serverForm, myForm, base, fields) {
  const server = toPayload(serverForm), mine = toPayload(myForm)
  const out = { ...serverForm }
  for (const f of fields) {
    if (server[f] === base?.[f] && mine[f] !== base?.[f]) out[f] = myForm[f]
  }
  return out
}

// Keine Antwort erhalten: am aktuellen Serverstand entscheiden, was passiert ist
export function classifyAfterNoAnswer(row, payload, sentRevision, submit) {
  if (!row) return { kind: 'unknown' }
  if (submit && row.status === 'submitted') return { kind: 'saved', status: 'submitted', revision: row.revision, recovered: true }
  if (!EDITABLE.includes(row.status)) return { kind: 'locked', status: row.status }
  const same = matchesPayload(row, payload)
  const hasRev = Number.isInteger(sentRevision) && Number.isInteger(row.revision)
  if (same) {
    // Server hält genau diese Angaben → Revision übernehmen ist sicher. Beim Einreichen: gespeichert, aber nicht eingereicht.
    return submit ? { kind: 'notSaved', revision: row.revision } : { kind: 'saved', status: row.status, revision: row.revision, recovered: true }
  }
  if (hasRev && row.revision !== sentRevision) return { kind: 'conflict', revision: row.revision }
  return { kind: 'notSaved', revision: sentRevision }
}

export async function loadOnboarding(supabase, uid, ms = ONB_TIMEOUT.read) {
  const r = await boundedRequest(s => supabase.from('employee_onboarding').select('*').eq('profile_id', uid).maybeSingle().abortSignal(s), { ms })
  if (r.status === 0) return { ok: false, noAnswer: true }
  if (r.error) return { ok: false, error: r.error }
  return { ok: true, row: r.data || null }
}

// Speichern/Einreichen. Ergebnis `kind`: saved | already | conflict | invalid | locked | notSaved | unknown | error
export async function saveOnboarding(supabase, { uid, payload, submit = false, revision, ms = ONB_TIMEOUT.write, readMs = ONB_TIMEOUT.read }) {
  const args = { p_data: payload, p_submit: submit }
  // Revision nur, wenn der Server sie kennt (Migration 28) – sonst bliebe der Aufruf rückwärtskompatibel
  if (Number.isInteger(revision)) args.p_expected_revision = revision
  const r = await boundedRequest(s => supabase.rpc('save_onboarding', args).abortSignal(s), { ms })
  if (r.status === 0) {
    const l = await loadOnboarding(supabase, uid, readMs)
    if (!l.ok) return { kind: 'unknown' }
    return { ...classifyAfterNoAnswer(l.row, payload, revision, submit), row: l.row }
  }
  if (r.error) return { kind: 'error', error: r.error }
  const d = r.data || {}
  if (d.success) return { kind: d.already ? 'already' : 'saved', status: d.status, revision: d.revision }
  if (d.conflict) return { kind: 'conflict', revision: d.revision }
  if (d.field) return { kind: 'invalid', field: d.field, message: d.error, revision: d.revision }
  if (d.status && !EDITABLE.includes(d.status)) return { kind: 'locked', status: d.status, message: d.error }
  return { kind: 'error', message: d.error }
}

// Registrierung über den Einladungslink einordnen (Ergebnis von supabase.auth.signUp, ggf. über boundedRequest)
export function classifySignup(res) {
  if (!res || res.status === 0 || res.timedOut) return 'noAnswer'
  const e = res.error
  if (e) {
    const m = String(e.message || '').toLowerCase()
    if (m.includes('already registered')) return 'exists'
    if (m.includes('rate') || m.includes('security purposes')) return 'rate'
    if (m.includes('database error')) return 'rejected'   // Migration 28: Einladung beim Anlegen nicht (mehr) gültig
    if (e.name === 'AuthRetryableFetchError' || e.status === 0 || /fetch|network/.test(m)) return 'noAnswer'
    if (m.includes('password')) return 'password'
    return 'error'
  }
  const user = res.data?.user
  if (user && Array.isArray(user.identities) && user.identities.length === 0) return 'exists'
  return res.data?.session ? 'session' : 'confirm'
}
