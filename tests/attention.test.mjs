// Handlungsbedarf (07.10.2026): freigegebener MVP – Regeln exakt wie abgestimmt, Rollen, Reihenfolge, Datenschutz,
// Verdrahtung im Dashboard (keine zusätzliche Anfrage außer der Admin-Zählung eingereichter Registrierungen).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { deriveAttentionItems, LONG_OPEN_HOURS, VACATION_SOON_DAYS } from '../src/lib/attention.js'
import { BREAK_WARNING_MINUTES } from '../src/lib/workHours.js'
import { BACKUP_REMIND_DAYS } from '../src/lib/backup.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const NOW = new Date('2026-10-07T12:00:00+02:00')
const ago = ms => new Date(NOW.getTime() - ms).toISOString()
const H = 3600e3, MIN = 60e3
const entry = (id, clockInAgo, extra = {}) => ({ id, employee_id: `emp-${id}`, clock_in: ago(clockInAgo), clock_out: null,
  employees: { first_name: `Vorname${id}`, last_name: `Nachname${id}` }, hourly_rate: 15, notes: 'privat', ...extra })
const base = { now: NOW, liveClockIns: [], liveBreaks: {}, forgottenCount: 0, pendingVacations: [], swapsAccepted: 0, onboardingSubmitted: 0, backupDays: 5, retentionDue: 0 }
const kinds = items => items.map(i => i.kind)

test('Schwellen sind die bestehenden Regeln (12 h aus Migration 07, 90 min, 30 Tage, 7 Tage)', () => {
  assert.equal(LONG_OPEN_HOURS, 12); assert.equal(BREAK_WARNING_MINUTES, 90); assert.equal(BACKUP_REMIND_DAYS, 30); assert.equal(VACATION_SOON_DAYS, 7)
  assert.match(readFileSync('supabase/migrations_onboarding/07_forgotten_clockout.sql', 'utf8'), /Schicht > 12 Std\. offen → hours_worked = 0/)
})

test('0 Hinweise: normaler Tag ohne offene Punkte → leere Liste (Admin und Manager)', () => {
  for (const role of ['admin', 'manager']) assert.deepEqual(deriveAttentionItems({ ...base, role, liveClockIns: [entry(1, 3 * H)] }), [])
})

test('Mitarbeiter (und unbekannte Rolle) bekommen nie Hinweise – auch bei vollen Daten', () => {
  const full = { ...base, liveClockIns: [entry(1, 13 * H)], forgottenCount: 3, pendingVacations: [{ start_date: '2026-10-08' }], swapsAccepted: 1, onboardingSubmitted: 1, backupDays: -1, retentionDue: [{ key: 'x', due: 1, title: 'x' }] }
  for (const role of ['employee', undefined, null, 'ADMIN']) assert.deepEqual(deriveAttentionItems({ ...full, role }), [])
})

test('1 · über 12 h eingestempelt: Grenze exakt (12 h = nein, > 12 h = ja); Admin → Zeitkorrektur, Manager → Live-Steuerung', () => {
  const at = ms => deriveAttentionItems({ ...base, role: 'admin', liveClockIns: [entry(1, ms)] })
  assert.deepEqual(at(12 * H), []); assert.deepEqual(at(11.9 * H), [])
  const a = at(12 * H + MIN)
  assert.equal(a.length, 1); assert.deepEqual([a[0].level, a[0].kind, a[0].to, a[0].live], ['critical', 'longOpen', '/zeitkorrekturen', undefined])
  assert.equal(a[0].params.name, 'Vorname1 Nachname1')
  const m = deriveAttentionItems({ ...base, role: 'manager', liveClockIns: [entry(1, 13 * H)] })
  assert.deepEqual([m[0].to, m[0].live], [undefined, { employeeId: 'emp-1', name: 'Vorname1 Nachname1' }])
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'admin', liveClockIns: [entry(1, 20 * H, { clock_out: ago(1 * H) })] }), [], 'ausgestempelt zählt nicht')
  const two = deriveAttentionItems({ ...base, role: 'admin', liveClockIns: [entry(1, 13 * H), entry(2, 15 * H)] })
  assert.deepEqual(two.map(i => i.params.name), ['Vorname2 Nachname2', 'Vorname1 Nachname1'], 'ältester zuerst')
})

test('2 · „Ausstempeln vergessen“: nur Admin, ab 1 Eintrag → Zeitkorrektur', () => {
  assert.deepEqual(kinds(deriveAttentionItems({ ...base, role: 'admin', forgottenCount: 0 })), [])
  const a = deriveAttentionItems({ ...base, role: 'admin', forgottenCount: 2 })
  assert.deepEqual([a[0].level, a[0].kind, a[0].params.count, a[0].to], ['action', 'forgotten', 2, '/zeitkorrekturen'])
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'manager', forgottenCount: 2 }), [])
})

test('3 · Urlaubsanträge: beide Rollen; „frühester Beginn“ nur bei ≤ 7 Tagen', () => {
  const v = (s) => ({ status: 'pending', start_date: s })
  for (const role of ['admin', 'manager']) {
    const a = deriveAttentionItems({ ...base, role, pendingVacations: [v('2026-11-20'), v('2026-10-30')] })
    assert.deepEqual([a[0].level, a[0].kind, a[0].params.count, a[0].params.soon, a[0].to], ['action', 'vacation', 2, null, '/urlaub?tab=urlaub'])
  }
  assert.equal(deriveAttentionItems({ ...base, role: 'manager', pendingVacations: [v('2026-11-20'), v('2026-10-14')] })[0].params.soon, '2026-10-14', 'genau 7 Tage')
  assert.equal(deriveAttentionItems({ ...base, role: 'manager', pendingVacations: [v('2026-10-15')] })[0].params.soon, null, '8 Tage')
})

test('4 · Schichttausch: nur „angenommen“ zählt (Dashboard filtert Status), beide Rollen → Schichtplan', () => {
  for (const role of ['admin', 'manager']) {
    assert.deepEqual(deriveAttentionItems({ ...base, role, swapsAccepted: 0 }), [])
    const a = deriveAttentionItems({ ...base, role, swapsAccepted: 1 })
    assert.deepEqual([a[0].level, a[0].kind, a[0].to], ['action', 'swaps', '/schichten'])
  }
})

test('5 · Registrierung eingereicht: nur Admin → Benutzerverwaltung', () => {
  const a = deriveAttentionItems({ ...base, role: 'admin', onboardingSubmitted: 1 })
  assert.deepEqual([a[0].level, a[0].kind, a[0].to], ['action', 'onboarding', '/benutzer'])
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'manager', onboardingSubmitted: 1 }), [])
})

test('6 · Datensicherung: nur Admin, bestehende Regel (≥ 30 Tage oder noch nie; unbekannt = kein Hinweis)', () => {
  const at = days => kinds(deriveAttentionItems({ ...base, role: 'admin', backupDays: days }))
  assert.deepEqual([at(29), at(30), at(-1), at(null), at(undefined)], [[], ['backup'], ['backup'], [], []])
  assert.equal(deriveAttentionItems({ ...base, role: 'admin', backupDays: 30 })[0].to, '/einstellungen#datensicherung')
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'manager', backupDays: -1 }), [])
})

test('7 · Pause über 90 min: beide Rollen, INFO, Grenze exakt, öffnet Live-Steuerung', () => {
  const e = entry(1, 5 * H)
  const at = (ms, role = 'admin', end = null) => deriveAttentionItems({ ...base, role, liveClockIns: [e], liveBreaks: { 1: [{ break_start: ago(ms), break_end: end }] } })
  assert.deepEqual(at(90 * MIN), []);
  for (const role of ['admin', 'manager']) {
    const a = at(91 * MIN, role)
    assert.deepEqual([a[0].level, a[0].kind, a[0].live, a[0].params.minutes], ['info', 'longBreak', { employeeId: 'emp-1', name: 'Vorname1 Nachname1' }, 90])
  }
  assert.deepEqual(at(3 * H, 'admin', ago(1 * H)), [], 'beendete Pause zählt nicht')
})

test('8 · Löschfristen: nur Admin, INFO, nur bei fälligen Kategorien', () => {
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'admin', retentionDue: 0 }), [])
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'admin', retentionDue: [] }), [])
  const a = deriveAttentionItems({ ...base, role: 'admin', retentionDue: [{ key: 'krank', due: 2, title: 'Krankmeldungen', extra: 'x' }] })
  assert.deepEqual([a[0].level, a[0].kind, a[0].to, a[0].params.categories], ['info', 'retention', '/einstellungen#aufbewahrung', [{ key: 'krank', due: 2, title: 'Krankmeldungen' }]])
  assert.deepEqual(deriveAttentionItems({ ...base, role: 'manager', retentionDue: [{ key: 'krank', due: 2, title: 'K' }] }), [])
})

test('Mehrere Hinweise: Reihenfolge CRITICAL → ACTION (freigegebene Reihenfolge) → INFO; Manager sieht nur Erlaubtes', () => {
  const all = { ...base, liveClockIns: [entry(1, 13 * H), entry(2, 4 * H)], liveBreaks: { 2: [{ break_start: ago(2 * H), break_end: null }] },
    forgottenCount: 1, pendingVacations: [{ status: 'pending', start_date: '2026-10-09' }], swapsAccepted: 2, onboardingSubmitted: 1, backupDays: -1,
    retentionDue: [{ key: 'verwaist', due: 1, title: 'Dateien' }] }
  assert.deepEqual(kinds(deriveAttentionItems({ ...all, role: 'admin' })), ['longOpen', 'forgotten', 'vacation', 'swaps', 'onboarding', 'backup', 'longBreak', 'retention'])
  assert.deepEqual(kinds(deriveAttentionItems({ ...all, role: 'manager' })), ['longOpen', 'vacation', 'swaps', 'longBreak'])
})

test('Datenschutz: Ergebnis enthält nur Name/Zeitpunkt/Anzahl – nie Lohn, Notizen, Krankheit, Kosten oder Rohdaten', () => {
  const all = { ...base, liveClockIns: [entry(1, 13 * H, { employees: { first_name: 'A', last_name: 'B', hourly_rate: 99, iban: 'DE00' } })],
    liveBreaks: {}, pendingVacations: [{ status: 'pending', start_date: '2026-10-09', reason: 'privat', days_count: 3, employees: { hourly_rate: 1 } }], forgottenCount: 1 }
  for (const role of ['admin', 'manager']) {
    const json = JSON.stringify(deriveAttentionItems({ ...all, role }))
    assert.doesNotMatch(json, /hourly|rate|iban|privat|notes|reason|salary|cost|sick|diagnos|days_count/i, role)
  }
  const src = readFileSync('src/lib/attention.js', 'utf8').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(src, /sick|krank|hourly|salary|payroll|labor|notes/i, 'Regeln lesen keine sensiblen Felder')
  assert.doesNotMatch(readFileSync('src/components/AttentionPanel.jsx', 'utf8'), /supabase|\.from\(|rpc\(/, 'Panel lädt nichts selbst')
})

test('Dashboard-Verdrahtung: Panel nur für Admin/Manager, ersetzt die drei Admin-Banner ohne Informationsverlust, keine Zusatzanfrage für Manager', () => {
  const s = readFileSync('src/pages/Dashboard.jsx', 'utf8')
  assert.match(s, /\{canManage && \(\n\s+<AttentionPanel role=\{isAdmin \? 'admin' : 'manager'\}/)
  assert.match(s, /forgottenCount: forgotten, pendingVacations: pendingReqs\.vac, swapsAccepted, onboardingSubmitted, backupDays, retentionDue/)
  assert.doesNotMatch(s, /dashboard\.forgotten|ui\.48fd6a9638f4|ui\.5ba2dba8d16d/, 'alte Banner entfernt – Inhalt steckt im Panel')
  const p = readFileSync('src/components/AttentionPanel.jsx', 'utf8')
  for (const k of ['ui.48fd6a9638f4', 'ui.15e9ef667d1b', 'ui.add2b4917aba', 'ui.c664e3a24d8b', 'ui.6043f353c565']) assert.match(p, new RegExp(k.replace('.', '\\.')), `Panel zeigt den bisherigen Text ${k}`)
  assert.match(s, /supabase\.from\('shift_swap_requests'\)\.select\('status'\)\.in\('status', \['open','accepted'\]\)/, 'gleiche Anfrage, Status statt Zählung')
  assert.match(s, /pendingSwaps: \(swapsPending\.data \|\| \[\]\)\.length \}\)\n\s+setSwapsAccepted\(\(swapsPending\.data \|\| \[\]\)\.filter\(s => s\.status === 'accepted'\)\.length\)/)
  assert.match(s, /supabase\.from\('employee_onboarding'\)\.select\('id', \{ count:'exact', head:true \}\)\.eq\('status', 'submitted'\)/)
  const adminBlock = s.slice(s.indexOf('if (isAdmin) {\n          const { count: fCount }'), s.indexOf('// Live-Personalkosten berechnen'))
  assert.match(adminBlock, /employee_onboarding/, 'Zusatzanfrage nur im Admin-Zweig')
  const before = execFileSync('git', ['show', '61336d8:src/pages/Dashboard.jsx'], { encoding: 'utf8' })   // letzter freigegebener Stand
  const calls = t => (t.match(/supabase\.(from|rpc)\(/g) || []).length
  assert.equal(calls(s), calls(before) + 1, 'genau eine Anfrage mehr (Admin: eingereichte Registrierungen)')
})

test('i18n DE/EN/BN vollständig, gleiche Platzhalter, BN in Bangla mit lateinischen Ziffern', () => {
  const keys = Object.keys(de).filter(k => k.startsWith('attention.'))
  assert.equal(keys.length, 20)
  const vals = v => typeof v === 'object' ? Object.values(v) : [v]
  const ph = s => (s.match(/\{\w+\}/g) || []).sort().join()
  for (const k of keys) {
    assert.ok(en[k] && bn[k], k)
    for (const [i, d] of vals(de[k]).entries()) {
      assert.equal(ph(vals(en[k])[i] ?? vals(en[k])[0]), ph(d), `${k} EN`); assert.equal(ph(vals(bn[k])[i] ?? vals(bn[k])[0]), ph(d), `${k} BN`)
    }
    for (const b of vals(bn[k])) { assert.match(b, /[ঀ-৿]/, k); assert.doesNotMatch(b, /[০-৯]/, k) }
  }
  assert.equal(de['attention.none'], 'Aktuell nichts zu erledigen.')
})
