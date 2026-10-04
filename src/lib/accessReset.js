// Zugang zurücksetzen / neues Passwort nach Reset (Migration 38). Rein – ohne React, testbar mit simulierter Supabase.
// Der Browser ruft nur Edge Functions mit dem eigenen JWT und zwei RPCs auf; der Service-Schlüssel ist nie hier.
// Das temporäre Passwort lebt ausschließlich im React-State des Ergebnisdialogs (kein Storage, kein Log).

// Antwort einer Edge Function lesen – auch bei 4xx/5xx (supabase-js liefert dann FunctionsHttpError mit context = Response)
export async function invokeAccessFn(supabase, name, body) {
  try {
    const { data, error } = await supabase.functions.invoke(name, { body })
    if (!error) return data && typeof data === 'object' ? data : { ok: false, reason: 'server_error' }
    let parsed = null
    try { parsed = await error.context?.json?.() } catch { parsed = null }
    if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string') return { ...parsed, ok: false }
    return { ok: false, reason: error.name === 'FunctionsFetchError' ? 'network' : 'server_error' }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

// Vor dem Bestätigen: darf zurückgesetzt werden + aktuelle Generation (Server entscheidet)
export async function loadAccessResetState(supabase, employeeId) {
  try {
    const { data, error } = await supabase.rpc('admin_access_reset_state', { p_employee_id: employeeId })
    if (error || !data) return { ok: false, reason: 'server_error' }
    return { ok: true, ...data }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

export const requestAccessReset = (supabase, employeeId, expectedGeneration) =>
  invokeAccessFn(supabase, 'admin-reset-access', { employee_id: employeeId, expected_generation: expectedGeneration })

export const completePasswordChange = (supabase, password) =>
  invokeAccessFn(supabase, 'complete-password-change', { password })

// Eigener Status beim App-Start. Fehler (z. B. Migration noch nicht eingespielt) blockieren die App NICHT –
// gesperrt wird ohnehin serverseitig; die Seite „Neues Passwort festlegen“ ist nur die passende Oberfläche dazu.
export async function loadMyAccessState(supabase) {
  try {
    const { data, error } = await supabase.rpc('my_access_state')
    if (error) return { mustChange: false, revoked: error.hint === 'session_revoked' }
    return { mustChange: data?.must_change_password === true, revoked: false }
  } catch {
    return { mustChange: false, revoked: false }
  }
}

// Server-Gründe → Übersetzungsschlüssel (unbekannte Codes: allgemeiner Fehler, nie verschluckt)
const RESET_REASONS = ['forbidden', 'self', 'owner', 'privileged_role', 'not_active', 'inactive_employee', 'no_login', 'stale',
  'in_progress', 'superseded', 'password_update_failed', 'unauthenticated', 'network']
export const resetReasonKey = reason => `accessReset.reason.${RESET_REASONS.includes(reason) ? reason : 'server_error'}`

const CHANGE_REASONS = ['too_short', 'too_long', 'too_weak', 'weak_password', 'same_password', 'reauthentication_needed',
  'not_required', 'retry', 'superseded', 'unauthenticated', 'network']
export const changeReasonKey = reason => `pwChange.reason.${CHANGE_REASONS.includes(reason) ? reason : 'server_error'}`

// Gleiche Regel wie der Server (supabase/functions/_shared/access-reset.js → passwordPolicyProblem)
export function passwordPolicyProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'too_short'
  if (new TextEncoder().encode(pw).length > 72) return 'too_long'
  if ([/[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length < 2) return 'too_weak'
  return null
}

export const maskPassword = pw => String(pw || '').replace(/[^-]/g, '•')
