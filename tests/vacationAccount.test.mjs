// Vacation System 2.0 – Phase 1: Rechenkern (src/lib/vacationAccount.js) und Schutz des Bestands.
// Belegt: (1) für heutige Fälle exakt dieselben Zahlen wie die bestehende Berechnung (vacationLogic.getVacationBalance),
// (2) Trennung Anspruch / Übertrag mit Herkunft / Verbrauch / verfügbar, Gegenbuchung, Ablösung, (3) der Kern ist nirgends
// eingebunden, (4) Migration 40 fasst nichts Bestehendes an, (5) bestehende Urlaubslogik und -seiten byte-gleich.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getVacationBalance } from '../src/lib/vacationLogic.js'
import { allocateApprovedVacations, summarizeVacationAccount } from '../src/lib/vacationAccount.js'
import { pinView } from './pinView.mjs'   // freigegebene, wörtliche Ausnahmen (z. B. Dashboard-Panel „Handlungsbedarf“)

const read = f => readFileSync(f, 'utf8')
const BEFORE = '071a946'   // letzter freigegebener Stand vor Phase 1
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const SYS = '00000000-0000-0000-0000-000000000000'

// Konto eines Jahres so aufbauen, wie Phase 2 es aus Bestandsdaten täte: Anspruch = heutiger Wert, Verbrauch = Zuordnung
function accountLikeToday(entitlement, vacations, holidays, year) {
  const alloc = allocateApprovedVacations(vacations, holidays)
  const allocations = [...alloc.entries()].flatMap(([request_id, per]) => Object.entries(per).map(([y, days]) => ({ id: `${request_id}:${y}`, request_id, account_year: Number(y), days })))
  return summarizeVacationAccount({ year, ledger: [{ id: 'e', account_year: year, kind: 'entitlement', days: entitlement }], allocations })
}
const V = (id, s, e, status = 'approved') => ({ id, status, start_date: s, end_date: e })

test('Gleichheit mit heute: Verbrauch und Rest je Jahr identisch zu getVacationBalance (ohne Krankheit)', () => {
  const hol = [{ date: '2026-12-25' }, { date: '2026-12-26' }, { date: '2027-01-01' }, { date: '2026-04-03' }, { date: '2026-04-06' }]
  const scenarios = {
    'einfach 22 Tage': [V('a', '2026-03-02', '2026-03-13'), V('b', '2026-08-03', '2026-08-14'), V('c', '2026-10-01', '2026-10-02')],
    'Jahreswechsel mit Feiertagen': [V('x', '2026-12-21', '2027-01-08')],
    'Ostern (Feiertage im Urlaub)': [V('o', '2026-03-30', '2026-04-10')],
    'überlappende Anträge': [V('p', '2026-05-04', '2026-05-08'), V('q', '2026-05-06', '2026-05-12')],
    'offen/abgelehnt zählen nicht': [V('r', '2026-06-01', '2026-06-05', 'pending'), V('s', '2026-06-08', '2026-06-12', 'rejected'), V('t', '2026-06-15', '2026-06-16')],
    'nur Wochenende': [V('w', '2026-06-06', '2026-06-07')],
    'mehr genommen als Anspruch': [V('m', '2026-01-05', '2026-03-27')],
  }
  for (const [name, vacs] of Object.entries(scenarios)) for (const year of [2026, 2027]) {
    const old = getVacationBalance({ vacation_days_per_year: 30 }, vacs, [], hol, year)
    const neu = accountLikeToday(30, vacs, hol, year)
    assert.deepEqual([neu.entitlement, neu.used, neu.available], [old.entitlement, old.used, old.remaining], `${name} ${year}`)
  }
})

test('Jahreswechsel 28.12.2026–05.01.2027: Aufteilung 4 + 2 (Neujahr Feiertag), Summe = gespeichertes days_count 6', () => {
  const a = allocateApprovedVacations([V('x', '2026-12-28', '2027-01-05')], [{ date: '2027-01-01' }]).get('x')
  assert.deepEqual(a, { 2026: 4, 2027: 2 })
})

test('Konto: Anspruch, Übertrag mit Herkunft (mehrere Jahre), Eröffnungssaldo, Korrektur, Gegenbuchung, Ablösung, negativ erlaubt', () => {
  const ledger = [
    { id: 'e', account_year: 2027, kind: 'entitlement', days: 30 },
    { id: 'c1', account_year: 2027, kind: 'carry_in', days: 8, related_year: 2026 },
    { id: 'c2', account_year: 2027, kind: 'carry_in', days: 3, related_year: 2025 },
    { id: 'c3', account_year: 2027, kind: 'carry_in', days: 2, related_year: 2024 },
    { id: 'r3', account_year: 2027, kind: 'reversal', days: -2, reverses_id: 'c3' },        // Fehlbuchung aufgehoben
    { id: 'ob', account_year: 2027, kind: 'opening_balance', days: 1.5, related_year: 2024 },
    { id: 'm', account_year: 2027, kind: 'manual_adjustment', days: -1 },
    { id: 'ea', account_year: 2027, kind: 'entitlement_adjustment', days: 2 },
    { id: 'co', account_year: 2027, kind: 'carry_out', days: -4, related_year: 2028 },
    { id: 'other', account_year: 2026, kind: 'entitlement', days: 99 },                     // anderes Jahr zählt nicht
  ]
  const allocations = [
    { id: 'a1', account_year: 2027, days: 5 },
    { id: 'a2', account_year: 2027, days: 7, supersedes_id: null },
    { id: 'a3', account_year: 2027, days: 6, supersedes_id: 'a2' },   // Neuberechnung ersetzt a2
    { id: 'a4', account_year: 2026, days: 50 },
  ]
  const s = summarizeVacationAccount({ year: 2027, ledger, allocations })
  assert.deepEqual(s, { year: 2027, entitlement: 32, carryIn: 11, carryInByOrigin: [{ year: 2025, days: 3 }, { year: 2026, days: 8 }],
    openingBalance: 1.5, adjustments: -1, carryOut: -4, used: 11, available: 28.5 })
  const neg = summarizeVacationAccount({ year: 2027, ledger: [{ id: 'e', account_year: 2027, kind: 'entitlement', days: 2 }], allocations: [{ id: 'x', account_year: 2027, days: 5 }] })
  assert.equal(neg.available, -3, 'negativer Saldo wird nur gezeigt, nie automatisch korrigiert')
  assert.throws(() => summarizeVacationAccount({ year: 2027, ledger: [{ id: 'z', account_year: 2027, kind: 'expiry', days: -1 }] }), /Unbekannte Buchungsart/, 'kein Verfall in Phase 1')
})

test('Admin-Ansicht laut Entwurf: 30 + 8 aus 2026 − 5 = 33', () => {
  const s = summarizeVacationAccount({ year: 2027, ledger: [{ id: 'e', account_year: 2027, kind: 'entitlement', days: 30 }, { id: 'c', account_year: 2027, kind: 'carry_in', days: 8, related_year: 2026 }], allocations: [{ id: 'a', account_year: 2027, days: 5 }] })
  assert.deepEqual([s.entitlement, s.carryIn, s.carryInByOrigin, s.used, s.available], [30, 8, [{ year: 2026, days: 8 }], 5, 33])
})

test('Phase 1 unsichtbar: der neue Rechenkern ist in keiner App-Datei eingebunden', () => {
  const walk = d => readdirSync(d).flatMap(n => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f] })
  const users = walk('src').filter(f => /\.(jsx?|mjs)$/.test(f) && !f.endsWith('vacationAccount.js') && /vacationAccount/.test(read(f)))
  assert.deepEqual(users, [])
  for (const t of ['vacation_accounts', 'vacation_ledger', 'vacation_request_allocations', 'vacation_entitlement_terms'])
    assert.deepEqual(walk('src').filter(f => !f.endsWith('vacationAccount.js') && read(f).includes(t)), [], `${t} wird von der App nicht verwendet`)
  assert.doesNotMatch(read('src/lib/vacationAccount.js'), /supabase|from\(|rpc\(|import /, 'Kern ohne Datenbankzugriff und ohne Abhängigkeiten')
})

test('Migration 40: nur neue Objekte – kein ALTER/UPDATE/DELETE/INSERT/DROP auf bestehende Tabellen, kein Cron, kein Verfall', () => {
  const sql = read('supabase/migrations_onboarding/40_vacation_accounts_foundation.sql').replace(/--.*$/gm, '')
  const NEW = /vacation_(accounts|entitlement_terms|ledger|request_allocations)\b/
  for (const m of sql.matchAll(/\b(ALTER TABLE|UPDATE|DELETE FROM|INSERT INTO|DROP TABLE|TRUNCATE|CREATE TRIGGER \w+ \w+ [\w ,]+ ON)\s+(public\.)?(\w+)/gi)) {
    if (/^UPDATE$/i.test(m[1]) && /^(OR|ON)$/i.test(m[3])) continue   // „BEFORE UPDATE OR DELETE ON …“
    assert.match(m[3], NEW, `betrifft nur neue Tabellen: ${m[0]}`)
  }
  for (const m of sql.matchAll(/\bON (public\.)?(\w+) FOR EACH/gi)) assert.match(m[2], NEW, m[0])
  assert.doesNotMatch(sql, /cron\.schedule|expiry|verfall/i)
  assert.match(sql, /REVOKE ALL ON public\.vacation_accounts, public\.vacation_entitlement_terms, public\.vacation_ledger, public\.vacation_request_allocations\s+FROM PUBLIC, anon, authenticated, service_role;/)
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)/i, 'keine Schreibrechte für Browser-Rollen')
  assert.doesNotMatch(sql, /REFERENCES public\.vacation_requests/, 'Löschfristen der Anträge bleiben unberührt')
  assert.doesNotMatch(sql, /diagnos|icd|attest|certificate/i, 'keine Gesundheitsdaten')
})

test('Bestand unverändert: Urlaubslogik, alle Urlaubs-/Lohn-Seiten und Migrationen 1–39 byte-gleich zum freigegebenen Stand', () => {
  for (const f of ['src/lib/vacationLogic.js', 'src/pages/Vacation.jsx', 'src/pages/Account.jsx', 'src/pages/MyHours.jsx', 'src/pages/Employees.jsx',
    'src/pages/Dashboard.jsx', 'src/pages/AbsenceCalendar.jsx', 'src/pages/Payroll.jsx', 'src/pages/Timesheet.jsx', 'src/lib/compensation.js',
    ...readdirSync('supabase/migrations_onboarding').filter(f => f < '40').map(f => `supabase/migrations_onboarding/${f}`)])
    assert.equal(pinView(f, read(f)), pinView(f, atBefore(f)), f)
})
