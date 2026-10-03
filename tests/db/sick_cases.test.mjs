// Migration 33 · Krankheitsfälle Phase A: Zuordnung nur bewusst durch Admins, Beziehungen (Fortsetzung/neue
// Erkrankung) nur Admin mit Quelle + Begründung, keine Diagnose, kein Backfill, keine Lohnwirkung.
// Vorher/Nachher: Lohn-/DATEV-Ergebnis (echte Funktionen aus Payroll.jsx) und payroll_months bleiben identisch.
// Nur synthetische Personen, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startDb, addPeople, migration, MIGRATIONS, one, rows, err, EMP, U } from './harness.mjs'
import * as comp from '../../src/lib/compensation.js'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const ymd = d => (typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)

// Lohn-/DATEV-Ergebnis wie Payroll.jsx (echte Funktionen) – identisch zum Feiertags-Test
const PAYROLL_SRC = readFileSync(new URL('../../src/pages/Payroll.jsx', import.meta.url), 'utf8')
const grab = name => { const s = PAYROLL_SRC.indexOf(`function ${name}(`); let i = PAYROLL_SRC.indexOf('{', PAYROLL_SRC.indexOf(')', s)) + 1, d = 1; while (d) { const ch = PAYROLL_SRC[i++]; if (ch === '{') d++; else if (ch === '}') d-- } return PAYROLL_SRC.slice(s, i) }
const toLocal = `function toLocalDateStr(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') }`
const paidAbsence = new Function(`${toLocal}; return (${grab('getPaidAbsenceDays')})`)()
let exportedCsv
const exportDATEV = new Function('saveFile', 'datevRateCell', 'datevHintCell', `return (${grab('exportDATEV')})`)(b => { exportedCsv = b }, comp.datevRateCell, comp.datevHintCell)
async function payrollAndDatev(c, year, month) {
  const pad = String(month).padStart(2, '0'), start = `${year}-${pad}-01`, end = `${year}-${pad}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  const emps = await rows(c, `SELECT * FROM employees ORDER BY last_name`)
  const te = await rows(c, `SELECT employee_id, hours_worked::float h, date FROM time_entries WHERE date BETWEEN $1 AND $2`, [start, end])
  // exakt die Spalten, die Payroll.jsx lädt (case_id/eau_kind gehören NICHT dazu)
  const sickSelect = PAYROLL_SRC.match(/from\('sick_leave'\)\.select\('([^']+)'\)/)[1]
  const sick = (await rows(c, `SELECT ${sickSelect} FROM sick_leave WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)`, [start, end]))
    .map(s => ({ ...s, start_date: ymd(s.start_date), end_date: s.end_date && ymd(s.end_date), continued_pay_end: s.continued_pay_end && ymd(s.continued_pay_end) }))
  const out = emps.map(emp => {
    const mine = te.filter(t => t.employee_id === emp.id)
    const actual = Math.round(mine.reduce((s, t) => s + (t.h || 0), 0) * 100) / 100
    const worked = new Set(mine.filter(t => t.h > 0).map(t => ymd(t.date)))
    const { vacationDays, sickDays } = paidAbsence([], sick.filter(s => s.employee_id === emp.id), worked, start, end)
    const dailyH = emp.hours_per_week ? Number(emp.hours_per_week) / 5 : 0
    const e = { ...emp, hourly_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate), monthly_salary: emp.monthly_salary == null ? null : Number(emp.monthly_salary) }
    const vacH = Math.round(vacationDays * dailyH * 100) / 100, sickH = Math.round(sickDays * dailyH * 100) / 100
    const gross = comp.monthlyGross(e, Math.round((actual + vacH + sickH) * 100) / 100)
    return { ...e, personnel_number: e.personnel_number || '1', monthTarget: 160, actualHours: actual, vacationHours: vacH, sickHours: sickH, overtime: 0, total: gross, isAlert: false }
  })
  exportDATEV(out, `${month}/${year}`)
  return JSON.stringify(out.map(r => [r.last_name, r.actualHours, r.vacationHours, r.sickHours, r.total])) + '\n' + await exportedCsv.text()
}
const snapshot = async () => [await payrollAndDatev(db.sys, 2026, 8), await payrollAndDatev(db.sys, 2026, 9), await payrollAndDatev(db.sys, 2026, 10),
  JSON.stringify(await rows(db.sys, `SELECT * FROM payroll_months ORDER BY id`)),
  JSON.stringify(await rows(db.sys, `SELECT id, employee_id, start_date, end_date, continued_pay_end, certificate_received, certificate_file_path, notes FROM sick_leave ORDER BY id`))].join('\n')

let before33, R = {}
before(async () => {
  db = await startDb({ migrations: MIGRATIONS.filter(m => m !== '33_sick_cases.sql') })   // Stand VOR Migration 33
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }]])
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2500 WHERE id = $1`, [EMP(E2)])
  const ins = (emp, a, b, cert = false) => one(db.sys, `INSERT INTO sick_leave (employee_id, start_date, end_date, certificate_received) VALUES ($1, $2, $3, $4) RETURNING id`, [EMP(emp), a, b, cert]).then(r => r.id)
  R.a1 = await ins(E1, '2026-08-03', '2026-09-11', true)        // Erst-AU
  R.a2 = await ins(E1, '2026-09-14', '2026-09-30')              // Folge über Wochenende (ohne Datei)
  R.a3 = await ins(E1, '2026-10-12', '2026-10-16')              // nach gearbeitetem Tag
  R.b1 = await ins(E2, '2026-09-01', '2026-09-04', true)
  await db.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, '2026-10-05', '2026-10-05T07:00:00Z', '2026-10-05T15:00:00Z', 8)`, [EMP(E1)])
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month, sick_hours, is_finalized) VALUES ($1, 2026, 8, 40, true)`, [EMP(E1)])
  before33 = await snapshot()
  await db.sys.query(migration('33_sick_cases.sql'))
})
after(async () => { await db?.stop() })

const rpc = async (who, fn, args) => (await one(await db.session(who), `SELECT ${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')}) v`, Object.values(args))).v

test('Migration: additiv, kein Backfill – bestehende Krankmeldungen ohne Fall, Daten unverändert; wiederholt ausführbar', async () => {
  const cols = await rows(db.sys, `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'sick_leave' AND column_name IN ('case_id','eau_kind') ORDER BY 1`)
  assert.deepEqual(cols, [{ column_name: 'case_id', is_nullable: 'YES', column_default: null }, { column_name: 'eau_kind', is_nullable: 'YES', column_default: null }])
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_leave WHERE case_id IS NOT NULL OR eau_kind IS NOT NULL`)).n, 0)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_cases`)).n, 0)
  assert.equal(await snapshot(), before33, 'direkt nach der Migration identisch')
  await db.sys.query(migration('33_sick_cases.sql'))
  assert.equal(await snapshot(), before33)
})

test('Zugriff: Mitarbeiter sehen keine Fälle; Manager Fälle aber keine Beziehungen; keine direkten Schreibzugriffe', async () => {
  const c = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.b1] })
  await rpc(ADMIN, 'admin_set_sick_case_relation', { p_case_id: c.case_id, p_relation: 'new_illness', p_basis: 'lohnbuero', p_reason: 'laut Lohnbüro neue Erkrankung' })
  const e = await db.session(E2), m = await db.session(MANAGER), a = await db.session(ADMIN)
  assert.equal((await e.query(`SELECT 1 FROM sick_cases`)).rowCount, 0)
  assert.equal((await e.query(`SELECT 1 FROM sick_case_relations`)).rowCount, 0)
  assert.equal((await m.query(`SELECT 1 FROM sick_cases`)).rowCount, 1, 'Manager: Gruppierung sichtbar')
  assert.equal((await m.query(`SELECT 1 FROM sick_case_relations`)).rowCount, 0, 'Manager: keine Beziehung (Gesundheitsinformation)')
  assert.equal((await a.query(`SELECT 1 FROM sick_case_relations`)).rowCount, 1)
  for (const who of [ADMIN, MANAGER, E2]) {
    const s = await db.session(who)
    assert.match(await err(() => s.query(`INSERT INTO sick_cases (employee_id) VALUES ($1)`, [EMP(E2)])), /permission denied/, `${who} insert`)
    assert.match(await err(() => s.query(`UPDATE sick_case_relations SET relation = 'same_illness'`)), /permission denied/, `${who} update`)
  }
  // case_id/eau_kind über die normalen sick_leave-Policies: gesperrt (auch für Admin außerhalb der RPC)
  for (const who of [ADMIN, MANAGER]) {
    assert.match(await err(() => db.session(who).then(s => s.query(`UPDATE sick_leave SET case_id = NULL WHERE id = $1`, [R.b1]))), /nur von Admins über die Fallverwaltung/, String(who))
    assert.match(await err(() => db.session(who).then(s => s.query(`UPDATE sick_leave SET eau_kind = 'folge' WHERE id = $1`, [R.a2]))), /nur von Admins über die Fallverwaltung/, String(who))
  }
  assert.match(await err(() => e.query(`UPDATE sick_leave SET case_id = NULL WHERE id = $1`, [R.b1])), /nur von Admins über die Fallverwaltung/)
  assert.match(await err(() => e.query(`INSERT INTO sick_leave (employee_id, start_date, eau_kind) VALUES ($1, CURRENT_DATE, 'erst')`, [EMP(E2)])), /nur von Admins/)
  for (const who of [MANAGER, E1]) assert.match(await err(() => rpc(who, 'admin_confirm_sick_case', { p_record_ids: [R.a3] })), /nur Admins/, String(who))
  await rpc(ADMIN, 'admin_remove_from_sick_case', { p_record_ids: [R.b1] })
})

test('Fall bestätigen: nur dieselbe Person, keine Lücke mit Arbeit, nicht in zwei Fällen, Revisionskonflikt', async () => {
  const mixed = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.a1, R.b1] })
  assert.equal(mixed.code, 'mixed_employees')
  assert.match(await err(() => rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.a2, R.a3] })), /gearbeitet \(05\.10\.2026\)/, 'gearbeiteter Tag dazwischen')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_cases`)).n, 0, 'Fehler rollt alles zurück')
  const c = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.a1, R.a2] })   // Wochenende dazwischen: Admin bestätigt bewusst
  assert.equal(c.success, true)
  assert.equal((await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.a2] })).code, 'other_case', 'schon in einem anderen Fall')
  const stale = await rpc(ADMIN, 'admin_set_sick_case_relation', { p_case_id: c.case_id, p_relation: 'unknown', p_expected_revision: c.revision - 1 })
  assert.equal(stale.conflict, true)
  R.caseA = c
})

test('Beziehungen: Fortsetzung nur mit früherem Fall derselben Person, Quelle + Begründung Pflicht; unknown löscht', async () => {
  const later = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.a3] })
  const base = { p_case_id: later.case_id, p_relation: 'same_illness', p_prior_case_id: R.caseA.case_id, p_basis: 'kk_auskunft', p_reason: 'Vorerkrankung laut KK-Auskunft' }
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_basis: null })).code, 'basis')
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_basis: 'diagnose' })).code, 'basis')
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_reason: '  ok ' })).code, 'reason')
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_reason: 'x'.repeat(201) })).code, 'reason')
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_prior_case_id: null })).code, 'prior')
  // früherer Fall muss vorher beginnen und derselben Person gehören
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_case_id: R.caseA.case_id, p_prior_case_id: later.case_id })).code, 'prior')
  const other = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.b1] })
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { ...base, p_prior_case_id: other.case_id })).code, 'prior')
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', base)).success, true)
  const rel = await one(db.sys, `SELECT relation, basis, reason, decided_by FROM sick_case_relations WHERE case_id = $1`, [later.case_id])
  assert.deepEqual(rel, { relation: 'same_illness', basis: 'kk_auskunft', reason: 'Vorerkrankung laut KK-Auskunft', decided_by: U(ADMIN) })
  // Protokoll ohne Begründungstext
  const log = await rows(db.sys, `SELECT summary FROM activity_log WHERE action LIKE 'sick_case.%' ORDER BY created_at`)
  assert.ok(log.length >= 4); assert.ok(log.every(l => !/Vorerkrankung laut/.test(l.summary)))
  assert.equal((await rpc(ADMIN, 'admin_set_sick_case_relation', { p_case_id: later.case_id, p_relation: 'unknown' })).success, true)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_case_relations WHERE case_id = $1`, [later.case_id])).n, 0)
  R.later = later
})

test('eAU-Merkmal: nur Admin, optional, entscheidet nichts (keine Zuordnung, kein Fall)', async () => {
  assert.equal((await rpc(ADMIN, 'admin_set_sick_eau_kind', { p_record_id: R.a3, p_kind: 'folge' })).success, true)
  assert.equal((await rpc(ADMIN, 'admin_set_sick_eau_kind', { p_record_id: R.a3, p_kind: 'zweit' })).code, 'kind')
  const s = await one(db.sys, `SELECT eau_kind, case_id FROM sick_leave WHERE id = $1`, [R.a3])
  assert.equal(s.eau_kind, 'folge'); assert.equal(s.case_id, R.later.case_id, 'Zuordnung unverändert durch das Merkmal')
  assert.match(await err(() => rpc(MANAGER, 'admin_set_sick_eau_kind', { p_record_id: R.a3, p_kind: 'erst' })), /nur Admins/)
})

test('Aufräumen: Fall ohne Krankmeldungen verschwindet (Lösen, Löschen durch Mitarbeiter/Admin); Beziehungen darauf ebenso', async () => {
  const fresh = await one(db.sys, `INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, CURRENT_DATE, CURRENT_DATE) RETURNING id`, [EMP(E2)])
  const c = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [fresh.id] })
  const del = await (await db.session(E2)).query(`DELETE FROM sick_leave WHERE id = $1`, [fresh.id])   // eigene Meldung < 24 h
  assert.equal(del.rowCount, 1)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_cases WHERE id = $1`, [c.case_id])).n, 0)
  await rpc(ADMIN, 'admin_set_sick_case_relation', { p_case_id: R.later.case_id, p_relation: 'same_illness', p_prior_case_id: R.caseA.case_id, p_basis: 'lohnbuero', p_reason: 'Lohnbüro bestätigt Fortsetzung' })
  const r = await rpc(ADMIN, 'admin_remove_from_sick_case', { p_record_ids: [R.a1, R.a2] })
  assert.equal(r.case_deleted, true)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_case_relations WHERE case_id = $1`, [R.later.case_id])).n, 0, 'Beziehung auf gelöschten Fall entfällt')
  // wieder herstellen für den Lohn-Vergleich
  R.caseA = await rpc(ADMIN, 'admin_confirm_sick_case', { p_record_ids: [R.a1, R.a2] })
  await rpc(ADMIN, 'admin_set_sick_case_relation', { p_case_id: R.later.case_id, p_relation: 'same_illness', p_prior_case_id: R.caseA.case_id, p_basis: 'kk_auskunft', p_reason: 'KK-Auskunft Vorerkrankung' })
})

test('KERN: Lohn- und DATEV-Ergebnis, payroll_months und Krankmeldungen vorher = nachher (mit Fällen, Fortsetzung, eAU-Merkmal)', async () => {
  assert.ok((await one(db.sys, `SELECT count(*)::int n FROM sick_leave WHERE case_id IS NOT NULL`)).n >= 3, 'Fälle sind wirklich gesetzt')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM sick_case_relations WHERE relation = 'same_illness'`)).n, 1)
  assert.equal(await snapshot(), before33)
  assert.doesNotMatch(PAYROLL_SRC, /case_id|sick_case|eau_kind/, 'Payroll liest Phase-A-Daten nicht')
})
