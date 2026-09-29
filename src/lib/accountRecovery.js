// Recovery für festhängende Registrierungen (Migration 24). Rein – ohne React, testbar mit simulierter Supabase.

// Einordnung eines Kontos für die Benutzerverwaltung.
// state = Zeile aus admin_account_states() (oder undefined, wenn nicht ermittelbar → keine Recovery-Aktion anbieten)
export function accountStage({ profile, state, onboarding }) {
  if (!profile) return null
  const unconfirmed = state?.email_confirmed === false
  const cancelled = profile.status === 'disabled' && !profile.employee_id && onboarding?.status === 'rejected'
  const stage = cancelled ? 'cancelled'
    : unconfirmed ? 'awaiting_email'
    : profile.status === 'approved' ? 'active'
    : profile.status === 'disabled' ? 'locked'
    : onboarding?.status === 'submitted' ? 'submitted'
    : onboarding ? 'onboarding'
    : 'pending'
  return { stage, canResend: unconfirmed, canReopen: cancelled, lastSent: state?.confirmation_sent_at || null }
}

const RATE_LIMIT = /rate limit|security purposes|only request this after|too many/i

// Bestätigungs-E-Mail erneut anfordern: erst serverseitige Prüfung (Admin, Konto unbestätigt), dann der
// Supabase-Endpunkt auth.resend (schickt nur an diese Adresse). Erfolg nur, wenn beide Schritte ohne Fehler sind.
export async function requestConfirmationResend(supabase, profileId, redirectTo) {
  try {
    const { data, error } = await supabase.rpc('admin_prepare_confirmation_resend', { p_profile_id: profileId })
    if (error || !data?.email) return { ok: false, reason: 'server', error: error || null }
    const { error: sendErr } = await supabase.auth.resend({ type: 'signup', email: data.email, options: { emailRedirectTo: redirectTo } })
    if (sendErr) {
      const rate = sendErr.status === 429 || sendErr.code === 'over_email_send_rate_limit' || RATE_LIMIT.test(sendErr.message || '')
      return { ok: false, reason: rate ? 'rate_limit' : 'send_failed', error: sendErr, email: data.email }
    }
    return { ok: true, email: data.email }
  } catch (error) {
    return { ok: false, reason: 'network', error }
  }
}

// Einladung für eine Adresse, die schon ein Auth-Konto hat: passendes Konto samt Recovery-Möglichkeiten finden
export function inviteConflict(email, profiles = [], states = {}, onboardings = []) {
  const e = String(email || '').trim().toLowerCase()
  const profile = profiles.find(p => String(p.email || '').trim().toLowerCase() === e)
  if (!profile) return { profile: null, stage: null }
  const onboarding = onboardings.find(o => o.profile_id === profile.id)
  return { profile, ...accountStage({ profile, state: states[profile.id], onboarding }) }
}

// ── Registrierung zurücksetzen (Migration 26) ──
// Nur ein Vorfilter, damit keine irreführende Aktion erscheint. Maßgeblich ist immer die serverseitige Prüfung
// admin_registration_reset_check – sie klassifiziert neu und nennt die Gründe, falls blockiert.
// 'full' = Registrierung ohne Personalakte · 'login_only' = nie benutzte Anmeldung eines bestehenden Mitarbeiters
export function resetCandidate({ profile, state, onboarding, meId }) {
  if (!profile || !state || profile.id === meId || profile.is_owner || profile.role === 'admin') return null
  if (profile.employee_id) return state.ever_signed_in === false && !onboarding ? 'login_only' : null
  if (!['pending', 'disabled'].includes(profile.status)) return null
  if (onboarding && (!['draft', 'rejected'].includes(onboarding.status) || onboarding.privacy_accepted_at || onboarding.employee_id)) return null
  return 'full'
}

// Gründe der Server-Prüfung → Übersetzungsschlüssel (unbekannte Codes bleiben sichtbar, nie verschluckt)
const BLOCKER_KEYS = ['self', 'owner', 'privileged_role', 'active_account', 'onboarding_submitted', 'onboarding_changes_requested',
  'onboarding_approved', 'onboarding_employee_linked', 'privacy_proof', 'login_used', 'onboarding_history', 'references',
  'storage_objects', 'orphan_login']
export function resetBlockers(check) {
  return (check?.blockers || []).map(b => ({
    key: BLOCKER_KEYS.includes(b.code) ? `reset.blocker.${b.code}` : 'reset.blocker.unknown',
    code: b.code,
    detail: b.refs ? Object.entries(b.refs).map(([k, n]) => `${k}: ${n}`).join(', ') : (b.count != null ? String(b.count) : ''),
  }))
}

// Ausführen: Erfolg nur bei bestätigter Serverwirkung. already = war schon entfernt (Doppelklick/zweiter Admin).
export async function performRegistrationReset(supabase, check, userId) {
  if (!check || !['full', 'login_only'].includes(check.mode) || !check.email) return { ok: false, reason: 'not_allowed' }
  try {
    const { data, error } = await supabase.rpc('admin_reset_registration', { p_user_id: userId, p_expected_email: check.email, p_expected_mode: check.mode })
    if (error || !data?.success) return { ok: false, reason: 'server', error: error || null }
    return { ok: true, already: !!data.already, emailRegisteredAgain: !!data.email_registered_again, email: data.email || check.email, mode: data.mode || check.mode }
  } catch (error) {
    return { ok: false, reason: 'network', error }
  }
}
