// Account-Lifecycle (Migration 25): verwaiste Anmeldungen, Ablehnen ohne Waise, Konfliktprüfung auch bei bestehenden
// Mitarbeitern, unbestätigte aktive Konten, abgelaufene Einladungen, atomare Freischaltung mit Vergütung.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const um = read('src/pages/UserManagement.jsx')
const fn = (src, name) => { const i = src.indexOf(`async function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i)) }

test('Ablehnen alter Registrierungen löscht Auth-Konto + Profil serverseitig (keine neue Waise)', () => {
  const f = fn(um, 'confirmReject')
  assert.match(f, /supabase\.rpc\('admin_reject_pending_login', \{ p_profile_id: confirmDel\.id \}\)/)
  assert.match(f, /if \(error \|\| !data\?\.success\) toast\.error/, 'kein False-Success')
  assert.doesNotMatch(um, /from\('profiles'\)\.delete\(\)/, 'kein reines Profil-Löschen mehr')
})

test('Verwaiste Anmeldungen: nur Admin-RPC, Bestätigung, Doppelklick-Sperre, Erfolg nur nach Server-OK', () => {
  assert.match(um, /const \{ data: orph, error: orphErr \} = await supabase\.rpc\('admin_login_orphans'\)\s*\n\s*setOrphans\(orphErr \? \[\] : \(orph \|\| \[\]\)\)/)
  const f = fn(um, 'removeOrphanLogin')
  assert.match(f, /if \(!recoveryGuard\.begin\(\)\) return/)
  assert.match(f, /supabase\.rpc\('admin_remove_orphan_login', \{ p_user_id: o\.user_id \}\)/)
  assert.match(f, /if \(error \|\| !data\?\.success\) toast\.error[\s\S]*else \{ toast\.success/)
  assert.match(f, /finally \{\s*\n\s*recoveryGuard\.end\(\)/)
  // Löschen nur über den Bestätigungsdialog
  assert.match(um, /onClick=\{\(\) => setConfirmOrphan\(o\)\}/)
  assert.equal((um.match(/removeOrphanLogin\(/g) || []).length, 2, 'Definition + Dialog-Button')
  assert.match(um, /onClick=\{\(\) => removeOrphanLogin\(confirmOrphan\)\}/)
  assert.doesNotMatch(um, /service_role|auth\.admin|deleteUser|email_confirm\s*:/)
})

test('Einladung: Adressprüfung auch für bestehende Mitarbeiter; Auth-Konto → Konflikt statt toter Einladung', () => {
  const f = fn(um, 'createInvitation')
  const i = f.indexOf("rpc('check_email_registered'")
  assert.ok(i >= 0 && i < f.indexOf("from('invitations').insert("), 'Prüfung vor dem Einfügen')
  assert.doesNotMatch(f.slice(f.lastIndexOf('\n', i - 200), i), /if \(isNew\) \{\s*$/, 'nicht nur für neue Personen')
  assert.match(f, /if \(reg\?\.exists && \(reg\.reason === 'auth' \|\| isNew\)\) \{/)
  assert.match(f, /orphan: orphans\.find\(o => \(o\.email \|\| ''\)\.toLowerCase\(\) === email\)/)
  // Konfliktpanel bietet Waisen-Entfernung nur ohne Profil an
  assert.match(um, /\{!c\.profile && c\.orphan && <div[^>]*><button className="btn btn-sm" onClick=\{\(\) => setConfirmOrphan\(c\.orphan\)\}>/)
})

test('Aktive Benutzer: unbestätigte E-Mail sichtbar + erneut senden (nicht für das eigene Konto)', () => {
  const at = um.indexOf('{/* ── 4. Aktive Benutzer ── */}')
  assert.ok(at > 0)
  assert.match(um.slice(at), /\{!isMe && recoveryActions\(p\)\}/)
})

test('Abgelaufene Einladungen: getrennt von aktiven, erneuern/entfernen; aktive Liste unverändert', () => {
  assert.match(um, /\.is\('used_at', null\)\.is\('revoked_at', null\)\.lte\('expires_at', new Date\(\)\.toISOString\(\)\)/)
  assert.match(um, /setExpiredInvites\(exp \|\| \[\]\)/)
  assert.match(um, /onClick=\{\(\) => openInvite\(emp \|\| null, inv\.email\)\}/)
  assert.match(um, /\(!inv\.employee_id \|\| \(emp && emp\.is_active !== false\)\) && <button/, 'kein Neu-Einladen archivierter Mitarbeiter')
  assert.match(um, /function openInvite\(emp, email\) \{[\s\S]*?email: emp\?\.email \|\| email \|\| ''/)
})

test('Freischaltung + Vergütungsmodell atomar in einer RPC (kein zweiter Browser-Schritt)', () => {
  const onb = read('src/components/OnboardingReview.jsx')
  assert.match(onb, /supabase\.rpc\('approve_onboarding_with_pay', \{/)
  assert.doesNotMatch(onb, /setEmployeePay|rpc\('approve_onboarding',/)
  assert.match(onb, /if \(error \|\| !data\?\.success\) \{ setBusy\(false\)/)
})

test('Migration 25: additiv, Admin-Prüfung + REVOKE anon in jeder Funktion, kein Setzen der Bestätigung', () => {
  const m = read('supabase/migrations_onboarding/25_account_lifecycle_hardening.sql')
  const fns = [...m.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map(x => x[1])
  assert.deepEqual(fns, ['approve_onboarding_with_pay', 'admin_login_orphans', 'admin_remove_orphan_login', 'admin_reject_pending_login'])
  assert.equal((m.match(/IF NOT is_admin\(\) THEN RAISE EXCEPTION/g) || []).length, 4)
  assert.equal((m.match(/FROM PUBLIC, anon;/g) || []).length, 4)
  assert.doesNotMatch(m, /ALTER TABLE|DROP |email_confirmed_at\s*=|CREATE POLICY|GRANT .* TO anon/i)
  assert.match(m, /NOT EXISTS \(SELECT 1 FROM profiles p WHERE p\.id = u\.id\)\s*\n\s*RETURNING/, 'nur Konten ohne Profil')
})

test('i18n: Lifecycle-Texte DE/EN vollständig mit Platzhaltern', () => {
  const keys = Object.keys(de).filter(k => k.startsWith('lifecycle.'))
  assert.ok(keys.length >= 19)
  for (const k of keys) {
    assert.ok(en[k], k)
    assert.deepEqual(de[k].match(/\{\w+\}/g), en[k].match(/\{\w+\}/g), k)
  }
  for (const k of Object.keys(en).filter(k => k.startsWith('lifecycle.'))) assert.ok(de[k], k)
  for (const k of [...um.matchAll(/tr\('(lifecycle\.\w+)'/g), ...um.matchAll(/appMessage\('(lifecycle\.\w+)'/g)].map(x => x[1])) assert.ok(de[k] && en[k], k)
})
