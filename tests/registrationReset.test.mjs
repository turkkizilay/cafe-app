// Registrierung zurücksetzen (Migration 26) – Client-Seite: Vorfilter ohne irreführende Aktionen, Erfolg nur nach
// Serverbestätigung, Doppelklick-Sperre, keine Service-Rolle im Browser, nur Admin-Route, DE/EN vollständig.
// Die eigentlichen Garantien (Klassifizierung, Rechte, Datenerhalt, Parallelität) prüft tests/db/registration_reset.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resetCandidate, resetBlockers, performRegistrationReset } from '../src/lib/accountRecovery.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const um = read('src/pages/UserManagement.jsx')
const fn = (src, name) => { const i = src.indexOf(`async function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i)) }
const unconfirmed = { email_confirmed: false, ever_signed_in: false }
const used = { email_confirmed: true, ever_signed_in: true }

test('Vorfilter: kaputte Registrierung → vollständig; unbenutzte Anmeldung eines Mitarbeiters → nur Login; sonst keine Aktion', () => {
  const pending = { id: 'p', status: 'pending', role: 'employee', employee_id: null }
  assert.equal(resetCandidate({ profile: pending, state: unconfirmed, onboarding: { status: 'draft' }, meId: 'me' }), 'full')
  assert.equal(resetCandidate({ profile: pending, state: used, onboarding: null, meId: 'me' }), 'full')
  assert.equal(resetCandidate({ profile: { ...pending, status: 'disabled' }, state: used, onboarding: { status: 'rejected' } }), 'full')
  // Kein Reset-Button, wo der Server ohnehin blockiert
  for (const onboarding of [{ status: 'submitted' }, { status: 'changes_requested' }, { status: 'approved' }, { status: 'rejected', privacy_accepted_at: '2026-09-01' }, { status: 'draft', employee_id: 'e' }]) {
    assert.equal(resetCandidate({ profile: pending, state: unconfirmed, onboarding }), null, JSON.stringify(onboarding))
  }
  const linked = { id: 'x', status: 'approved', role: 'employee', employee_id: 'e1' }
  assert.equal(resetCandidate({ profile: linked, state: unconfirmed }), 'login_only')
  assert.equal(resetCandidate({ profile: linked, state: used }), null, 'aktiver Mitarbeiter: keine „alles löschen“-Aktion')
  assert.equal(resetCandidate({ profile: linked, state: unconfirmed, onboarding: { status: 'approved' } }), null)
  assert.equal(resetCandidate({ profile: { ...pending, status: 'approved' }, state: unconfirmed }), null)
  assert.equal(resetCandidate({ profile: pending, state: unconfirmed, meId: 'p' }), null, 'eigenes Konto')
  assert.equal(resetCandidate({ profile: { ...pending, is_owner: true }, state: unconfirmed }), null)
  assert.equal(resetCandidate({ profile: { ...linked, role: 'admin' }, state: unconfirmed }), null)
  assert.equal(resetCandidate({ profile: pending, state: undefined }), null, 'Zustand unbekannt → keine Aktion')
})

test('Gründe: jeder Server-Code sichtbar (auch unbekannte), Details zu Referenzen', () => {
  const b = resetBlockers({ blockers: [{ code: 'privacy_proof' }, { code: 'references', refs: { 'activity_log.actor_id': 2 } }, { code: 'neu_xyz' }, { code: 'storage_objects', count: 3 }] })
  assert.deepEqual(b.map(x => x.key), ['reset.blocker.privacy_proof', 'reset.blocker.references', 'reset.blocker.unknown', 'reset.blocker.storage_objects'])
  assert.equal(b[1].detail, 'activity_log.actor_id: 2')
  assert.equal(b[3].detail, '3')
  assert.deepEqual(resetBlockers(null), [])
})

test('Ausführen: Erfolg nur nach Server-OK; Fehler/Netzwerk/0 Wirkung → kein Erfolg; blockiert → kein Aufruf', async () => {
  const calls = []
  const sb = result => ({ rpc: async (name, args) => { calls.push([name, args]); if (result instanceof Error) throw result; return result } })
  const check = { mode: 'full', email: 'a@example.test' }
  assert.deepEqual(await performRegistrationReset(sb({ data: { success: true, already: false, mode: 'full', email: 'a@example.test' }, error: null }), check, 'u1'),
    { ok: true, already: false, emailRegisteredAgain: false, email: 'a@example.test', mode: 'full' })
  assert.deepEqual(calls[0], ['admin_reset_registration', { p_user_id: 'u1', p_expected_email: 'a@example.test', p_expected_mode: 'full' }], 'erwarteter Zustand wird mitgeschickt')
  assert.equal((await performRegistrationReset(sb({ data: null, error: { message: 'Zurücksetzen nicht möglich: privacy_proof' } }), check, 'u1')).ok, false)
  assert.equal((await performRegistrationReset(sb({ data: { success: false }, error: null }), check, 'u1')).ok, false)
  assert.equal((await performRegistrationReset(sb({ data: null, error: null }), check, 'u1')).ok, false)
  assert.equal((await performRegistrationReset(sb(new Error('offline')), check, 'u1')).reason, 'network')
  const already = await performRegistrationReset(sb({ data: { success: true, already: true, email_registered_again: true }, error: null }), check, 'u1')
  assert.deepEqual([already.ok, already.already, already.emailRegisteredAgain], [true, true, true])
  const n = calls.length
  for (const c of [{ mode: 'blocked', email: 'a@example.test' }, { mode: 'gone' }, null, { mode: 'full' }]) {
    assert.equal((await performRegistrationReset(sb({ data: { success: true } }), c, 'u1')).reason, 'not_allowed')
  }
  assert.equal(calls.length, n, 'kein Serveraufruf ohne erlaubte Prüfung')
})

test('UI: erst Server-Prüfung, dann Bestätigungsdialog; Doppelklick gesperrt; Erfolg nur nach Serverbestätigung; nur Admin-Route', () => {
  const open = fn(um, 'openRegistrationReset')
  assert.match(open, /supabase\.rpc\('admin_registration_reset_check', \{ p_user_id: p\.id \}\)/)
  assert.match(open, /check: error \? null : data/, 'Prüffehler → keine Ausführung möglich')
  const run = fn(um, 'runRegistrationReset')
  assert.match(run, /if \(!d\?\.check \|\| !resetGuard\.begin\(\)\) return/)
  assert.match(run, /performRegistrationReset\(supabase, d\.check, d\.profile\.id\)/)
  assert.match(run, /if \(!res\.ok\) toast\.error[\s\S]*else if \(res\.already\) toast\.info[\s\S]*else \{ toast\.success/)
  assert.match(run, /finally \{\s*\n\s*resetGuard\.end\(\); setResetDialog\(null\); fetchAll\(\)/, 'Sperre immer frei, Ansicht immer aktuell')
  // Ausführen-Button nur bei erlaubter Server-Klassifizierung, gesperrt während der Ausführung
  assert.match(um, /const allowed = c && \(c\.mode === 'full' \|\| c\.mode === 'login_only'\)/)
  assert.match(um, /\{allowed && <button className="btn btn-danger" disabled=\{busy\} onClick=\{runRegistrationReset\}>/)
  assert.equal((um.match(/runRegistrationReset/g) || []).length, 2, 'Definition + Dialog-Button')
  assert.equal((um.match(/openRegistrationReset\(/g) || []).length, 2, 'Definition + Button in recoveryActions')
  // Dialog nennt: betroffene Adresse, was gelöscht wird, was bleibt, was danach möglich ist
  for (const k of ['reset.affected', 'reset.deletesTitle', 'reset.keepsTitle', 'reset.keepsHistory', 'reset.danger']) assert.ok(um.includes(`tr('${k}'`), k)
  assert.match(um, /tr\(c\.mode === 'login_only' \? 'reset\.afterLogin' : 'reset\.afterFull'\)/)
  // Eigenes Konto nie; Route nur für Admins (Manager/Mitarbeiter sehen die Seite nicht – Server prüft zusätzlich)
  assert.match(um, /resetCandidate\(\{ profile: p, state: accountStates\[p\.id\], onboarding: onb, meId: profile\?\.id \}\)/)
  assert.match(read('src/App.jsx'), /path="\/benutzer"\s+element=\{isAdmin\s+\? <UserManagement \/> : <AccessDenied \/>\}/)
  assert.doesNotMatch(um + read('src/lib/accountRecovery.js'), /service_role|SERVICE_ROLE|auth\.admin|deleteUser|from\('profiles'\)\.delete\(\)/)
})

test('i18n: Reset-Texte DE/EN vollständig, Platzhalter identisch, jeder Server-Code übersetzt', () => {
  const keys = Object.keys(de).filter(k => k.startsWith('reset.'))
  assert.ok(keys.length >= 45)
  for (const k of keys) {
    assert.ok(en[k], k)
    assert.deepEqual((en[k].match(/\{\w+\}/g) || []).sort(), (de[k].match(/\{\w+\}/g) || []).sort(), k)
  }
  const migration = read('supabase/migrations_onboarding/26_registration_reset.sql')
  const codes = new Set([...migration.matchAll(/'code', '([a-z_]+)'/g)].map(m => m[1]).filter(c => !c.endsWith('_')))
  for (const s of ['submitted', 'changes_requested', 'approved']) codes.add('onboarding_' + s)
  for (const c of codes) assert.ok(de[`reset.blocker.${c}`], c)
})
