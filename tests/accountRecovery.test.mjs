// Recovery festhängender Registrierungen: Zustandserkennung, Bestätigungs-E-Mail erneut anfordern (ohne
// False-Success, Rate-Limit), Konflikt beim erneuten Einladen, Verdrahtung in der Benutzerverwaltung.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { accountStage, requestConfirmationResend, inviteConflict } from '../src/lib/accountRecovery.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const P = (over = {}) => ({ id: 'p1', email: 'neu@example.test', status: 'pending', employee_id: null, ...over })
function fakeSupabase({ rpc = () => ({ data: { email: 'neu@example.test' }, error: null }), resend = () => ({ error: null }) } = {}) {
  const calls = []
  return {
    calls,
    async rpc(name, args) { calls.push(['rpc', name, args]); return rpc(name, args) },
    auth: { async resend(args) { calls.push(['resend', args]); return resend(args) } },
  }
}

test('1/5: Zustand – unbestätigte E-Mail erkannt; bestätigte Konten bekommen keine Resend-Aktion', () => {
  const awaiting = accountStage({ profile: P(), state: { email_confirmed: false, confirmation_sent_at: '2026-09-28T13:37:48Z' }, onboarding: { status: 'draft' } })
  assert.deepEqual([awaiting.stage, awaiting.canResend, awaiting.canReopen], ['awaiting_email', true, false])
  assert.equal(awaiting.lastSent, '2026-09-28T13:37:48Z')
  for (const [profile, onboarding, stage] of [[P({ status: 'approved', employee_id: 'e1' }), undefined, 'active'], [P(), { status: 'draft' }, 'onboarding'], [P(), { status: 'submitted' }, 'submitted'], [P({ status: 'disabled', employee_id: 'e1' }), undefined, 'locked']]) {
    const a = accountStage({ profile, state: { email_confirmed: true }, onboarding })
    assert.equal(a.stage, stage); assert.equal(a.canResend, false, stage)
  }
  assert.equal(accountStage({ profile: P(), state: undefined, onboarding: { status: 'draft' } }).canResend, false, 'Status unbekannt → keine Aktion behaupten')
})

test('Zustand: abgebrochene Registrierung ohne Mitarbeiter → wieder öffnen (+ Resend, falls unbestätigt); mit Mitarbeiter nicht', () => {
  const c = accountStage({ profile: P({ status: 'disabled' }), state: { email_confirmed: false }, onboarding: { status: 'rejected' } })
  assert.deepEqual([c.stage, c.canReopen, c.canResend], ['cancelled', true, true])
  assert.equal(accountStage({ profile: P({ status: 'disabled', employee_id: 'e1' }), state: { email_confirmed: true }, onboarding: { status: 'rejected' } }).canReopen, false)
  assert.equal(accountStage({ profile: P({ status: 'disabled' }), state: { email_confirmed: true }, onboarding: { status: 'draft' } }).canReopen, false)
})

test('2: Resend – erst serverseitige Prüfung, dann Supabase auth.resend (type signup) nur an die geprüfte Adresse', async () => {
  const sb = fakeSupabase()
  const r = await requestConfirmationResend(sb, 'p1', 'https://app.example')
  assert.deepEqual(r, { ok: true, email: 'neu@example.test' })
  assert.deepEqual(sb.calls[0], ['rpc', 'admin_prepare_confirmation_resend', { p_profile_id: 'p1' }])
  assert.deepEqual(sb.calls[1], ['resend', { type: 'signup', email: 'neu@example.test', options: { emailRedirectTo: 'https://app.example' } }])
})

test('8: Fehler erzeugen keinen False-Success; Rate-Limits werden erkannt', async () => {
  const deny = await requestConfirmationResend(fakeSupabase({ rpc: () => ({ data: null, error: { message: 'Nicht autorisiert.' } }) }), 'p1', 'x')
  assert.equal(deny.ok, false); assert.equal(deny.reason, 'server')
  const noResendAfterDeny = fakeSupabase({ rpc: () => ({ data: null, error: { message: 'Die E-Mail-Adresse ist bereits bestätigt.' } }) })
  await requestConfirmationResend(noResendAfterDeny, 'p1', 'x')
  assert.equal(noResendAfterDeny.calls.filter(c => c[0] === 'resend').length, 0, 'ohne Serverfreigabe kein Versand')
  for (const e of [{ status: 429, message: 'email rate limit exceeded' }, { code: 'over_email_send_rate_limit' }, { message: 'For security purposes, you can only request this after 42 seconds.' }])
    assert.equal((await requestConfirmationResend(fakeSupabase({ resend: () => ({ error: e }) }), 'p1', 'x')).reason, 'rate_limit')
  const fail = await requestConfirmationResend(fakeSupabase({ resend: () => ({ error: { status: 500, message: 'Error sending confirmation email' } }) }), 'p1', 'x')
  assert.deepEqual([fail.ok, fail.reason], [false, 'send_failed'])
  assert.equal((await requestConfirmationResend(fakeSupabase({ resend: () => { throw new Error('offline') } }), 'p1', 'x')).reason, 'network')
})

test('6: Einladen einer bereits registrierten Adresse → vorhandenes Konto + passende Recovery, keine neue Einladung', () => {
  const profiles = [P({ id: 'p9', email: 'Neu@Example.test ' })]
  const c = inviteConflict(' neu@example.TEST', profiles, { p9: { email_confirmed: false } }, [{ profile_id: 'p9', status: 'draft' }])
  assert.equal(c.profile.id, 'p9'); assert.equal(c.stage, 'awaiting_email'); assert.equal(c.canResend, true)
  assert.equal(inviteConflict('fremd@example.test', profiles).profile, null)
  const um = read('src/pages/UserManagement.jsx')
  const block = um.slice(um.indexOf("if (reg?.exists && (reg.reason === 'auth' || isNew)) {"), um.indexOf("const { data: inv, error } = await supabase.from('invitations').insert("))
  assert.match(block, /if \(reg\.reason === 'auth'\) setInviteConflictInfo\(\{ email, \.\.\.inviteConflict\(email, allProfiles, accountStates, onboardings\), orphan: /)
  assert.match(block, /\n\s*return\n/, 'kein Einfügen einer zweiten Einladung')
})

test('UI: Aktionen nur passend zum Zustand, Doppelklick gesperrt, Erfolg nur nach Serverbestätigung', () => {
  const um = read('src/pages/UserManagement.jsx')
  assert.match(um, /if \(!acc \|\| \(!acc\.canResend && !acc\.canReopen && !resetMode\)\) return null/)
  assert.match(um, /\{acc\.canResend && <button className="btn btn-sm" disabled=\{busy\} onClick=\{\(\) => resendConfirmation\(p\)\}>/)
  assert.match(um, /\{acc\.canReopen && <button className="btn btn-sm" disabled=\{busy\} onClick=\{\(\) => reopenRegistration\(p\)\}>/)
  assert.match(um, /if \(res\.ok\) toast\.success\(appMessage\('recovery\.resendOk'/)
  assert.match(um, /if \(error \|\| !data\?\.success\) toast\.error\(messageParts\(\[appMessage\('recovery\.reopenFailed'\)/)
  assert.match(um, /async function resendConfirmation\(p\) \{\s*\n\s*if \(!recoveryGuard\.begin\(\)\) return/)
  assert.match(um, /setAccountStates\(stErr \? \{\} : /, 'Status nicht ermittelbar → keine Aktion')
  assert.doesNotMatch(um + read('src/lib/accountRecovery.js'), /service_role|SERVICE_ROLE|auth\.admin|updateUserById|email_confirm\s*:/, 'keine Admin-Auth-API/Service-Key im Browser')
})

test('i18n: Recovery-Texte DE/EN vollständig', () => {
  const keys = Object.keys(de).filter(k => k.startsWith('recovery.'))
  assert.ok(keys.length >= 16)
  for (const k of keys) { assert.ok(en[k], k); assert.notEqual(de[k], en[k], k) }
  assert.match(de['recovery.lastSent'], /\{date\}/); assert.match(en['recovery.lastSent'], /\{date\}/)
  assert.match(de['recovery.resendOk'], /\{email\}/); assert.match(en['recovery.resendOk'], /\{email\}/)
})
