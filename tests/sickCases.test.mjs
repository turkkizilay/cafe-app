// Krankheitsfälle Phase A (Migration 33): Vorschläge sind nur Vorschläge, Schichtplan vor Kalender (Sa/So nie pauschal
// frei), eAU-Merkmal entscheidet nichts, keine Lohnwirkung (Payroll/DATEV byte-gleich zum Stand vor Phase A).
// DB-Seite (Rechte, RPCs, Lohn vorher = nachher mit echten Daten): tests/db/sick_cases.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { classifyGap, suggestGroups, buildContext, reasonProblem, GAP, RELATIONS, RELATION_BASES, EAU_KINDS } from '../src/lib/sickCases.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const read = f => readFileSync(f, 'utf8')
const BEFORE_PHASE_A = 'ecae13b'   // letzter Stand vor Phase A
const atBefore = f => execFileSync('git', ['show', `${BEFORE_PHASE_A}:${f}`], { encoding: 'utf8' })
const ctx = (o = {}) => ({ shiftDates: new Set(o.shifts || []), workedDates: new Set(o.worked || []), vacationDates: new Set(o.vac || []), holidays: new Set(o.hol || []) })
const R = (id, s, e, extra = {}) => ({ id, employee_id: 'e1', start_date: s, end_date: e, ...extra })
// Schichtplan „gepflegt“: Schichten in den Wochen vor dem Fall
const PLAN = ['2026-08-25', '2026-08-26', '2026-08-27']

test('Direkt anschließend, Überschneidung, offene Meldung', () => {
  assert.equal(classifyGap(R(1, '2026-09-01', '2026-09-11'), R(2, '2026-09-12', '2026-09-20'), ctx()).gap, GAP.CONTIGUOUS)
  assert.equal(classifyGap(R(1, '2026-09-01', '2026-09-11'), R(2, '2026-09-10', '2026-09-20'), ctx()).gap, GAP.OVERLAP)
  assert.equal(classifyGap(R(1, '2026-09-01', null), R(2, '2026-09-20', null), ctx()).gap, GAP.OVERLAP, 'offene Meldung')
})

test('Wochenende: Schichtplan entscheidet; ohne Schichtplan sind Sa/So NIE pauschal arbeitsfrei', () => {
  const a = R(1, '2026-09-01', '2026-09-11'), b = R(2, '2026-09-14', '2026-09-30')   // Fr → Mo
  const free = classifyGap(a, b, ctx({ shifts: PLAN }))
  assert.deepEqual([free.gap, free.basis], [GAP.NON_WORKING, 'schedule'], 'gepflegter Plan, Sa/So ohne Schicht')
  assert.equal(classifyGap(a, b, ctx({ shifts: [...PLAN, '2026-09-12'] })).gap, GAP.UNCLEAR, 'Samstagsschicht geplant, nicht gearbeitet')
  const noPlan = classifyGap(a, b, ctx())
  assert.deepEqual([noPlan.gap, noPlan.basis], [GAP.UNCLEAR, 'calendar'], 'kein Plan → Kalender kennt Sa/So nicht als frei')
  assert.equal(classifyGap(a, b, ctx({ worked: ['2026-09-12'] })).gap, GAP.WORKED, 'am Samstag gearbeitet → getrennt')
  // Schichtplan außerhalb des Umfelds zählt nicht als „gepflegt“
  assert.equal(classifyGap(a, b, ctx({ shifts: ['2026-05-01'] })).basis, 'calendar')
})

test('Feiertage: im Kalender-Rückfall arbeitsfrei; mit Schichtplan zählt der Plan (Schicht am Feiertag = prüfen)', () => {
  const a = R(1, '2026-09-28', '2026-10-02'), b = R(2, '2026-10-04', '2026-10-09')     // 03.10. dazwischen
  assert.deepEqual([classifyGap(a, b, ctx({ hol: ['2026-10-03'] })).gap, classifyGap(a, b, ctx({ hol: ['2026-10-03'] })).basis], [GAP.NON_WORKING, 'calendar'])
  assert.equal(classifyGap(a, b, ctx({ hol: ['2026-10-03'], shifts: ['2026-09-20', '2026-10-03'] })).gap, GAP.UNCLEAR)
  assert.equal(classifyGap(a, b, ctx({ hol: ['2026-10-03'], shifts: ['2026-09-20'] })).gap, GAP.NON_WORKING)
  // Weihnachten über den Jahreswechsel ohne Plan: 25./26.12. frei, 27.–31.12. nicht → prüfen
  assert.equal(classifyGap(R(1, '2026-12-20', '2026-12-24'), R(2, '2026-12-27', '2027-01-05'), ctx({ hol: ['2026-12-25', '2026-12-26'] })).gap, GAP.NON_WORKING)
  assert.equal(classifyGap(R(1, '2026-12-20', '2026-12-24'), R(2, '2027-01-04', '2027-01-08'), ctx({ hol: ['2026-12-25', '2026-12-26', '2027-01-01'] })).gap, GAP.UNCLEAR)
})

test('Echte Lücke mit Arbeitstag; Urlaub dazwischen = prüfen; Monats- und Jahreswechsel', () => {
  assert.equal(classifyGap(R(1, '2026-09-01', '2026-09-11'), R(2, '2026-09-22', '2026-09-30'), ctx({ shifts: PLAN, worked: ['2026-09-15'] })).gap, GAP.WORKED)
  assert.equal(classifyGap(R(1, '2026-09-01', '2026-09-11'), R(2, '2026-09-14', '2026-09-30'), ctx({ shifts: PLAN, vac: ['2026-09-12'] })).gap, GAP.UNCLEAR)
  assert.equal(classifyGap(R(1, '2026-09-21', '2026-09-30'), R(2, '2026-10-01', '2026-10-09'), ctx()).gap, GAP.CONTIGUOUS, 'Monatswechsel')
  assert.equal(classifyGap(R(1, '2026-12-28', '2026-12-31'), R(2, '2027-01-01', '2027-01-08'), ctx()).gap, GAP.CONTIGUOUS, 'Jahreswechsel')
})

test('Vorschläge: bestätigte Meldungen (case_id) werden nie angefasst; gearbeitete Lücke trennt ohne Prüfhinweis', () => {
  const recs = [R('a', '2026-09-01', '2026-09-11'), R('b', '2026-09-12', '2026-09-20'), R('c', '2026-09-23', '2026-09-25'), R('d', '2026-09-26', '2026-09-27', { case_id: 'X' })]
  const g = suggestGroups(recs, ctx({ shifts: PLAN, worked: ['2026-09-22'] }))
  assert.deepEqual(g.map(x => x.records.map(r => r.id)), [['a', 'b'], ['c']], 'd ist bestätigt → kein Vorschlag')
  assert.deepEqual(g.map(x => x.review.length), [0, 0], 'gearbeitet = eindeutig getrennt')
})

test('Vorschläge: Mo/Di ohne Schicht (Plan gepflegt) verbinden; mit Schicht nicht; neue Erkrankung direkt danach = trotzdem nur Vorschlag', () => {
  const recs = [R('a', '2026-09-01', '2026-09-11'), R('b', '2026-09-12', '2026-09-20'), R('c', '2026-09-23', '2026-09-25')]
  const plan = [...PLAN, '2026-09-21']   // Montag geplant, nicht gearbeitet
  const g = suggestGroups(recs, ctx({ shifts: plan }))
  assert.deepEqual(g.map(x => x.records.map(r => r.id)), [['a', 'b'], ['c']])
  assert.equal(g[1].review.length, 1, 'Lücke mit geplantem Arbeitstag → Prüfhinweis, kein Zusammenfassen')
  const free = suggestGroups(recs, ctx({ shifts: PLAN }))
  assert.deepEqual(free.map(x => x.records.map(r => r.id)), [['a', 'b', 'c']])
  // offene Meldung: alles danach überschneidet sich
  assert.deepEqual(suggestGroups([R('o', '2026-09-01', null), R('p', '2026-09-30', '2026-10-02')], ctx()).map(x => x.records.length), [2])
})

test('Ohne Schichtplan: Mo/Di zwischen zwei Meldungen bleiben unklar → getrennt mit Prüfhinweis', () => {
  const g = suggestGroups([R('a', '2026-09-01', '2026-09-11'), R('b', '2026-09-12', '2026-09-20'), R('c', '2026-09-23', '2026-09-25')], ctx())
  assert.deepEqual(g.map(x => x.records.map(r => r.id)), [['a', 'b'], ['c']], 'ohne Schichtplan: Mo/Di unklar')
})

test('eAU-Merkmal entscheidet NIE über die Zuordnung (beliebige Merkmale → gleiche Vorschläge)', () => {
  const base = [R('a', '2026-09-01', '2026-09-11'), R('b', '2026-09-14', '2026-09-20'), R('c', '2026-10-01', '2026-10-02'), R('d', '2026-10-03', '2026-10-04')]
  const c0 = ctx({ shifts: PLAN, worked: ['2026-09-25'] })
  const ref = JSON.stringify(suggestGroups(base, c0).map(g => g.records.map(r => r.id)))
  for (const kinds of [['folge', 'folge', 'folge', 'folge'], ['erst', 'erst', 'erst', 'erst'], ['erst', 'folge', 'erst', 'folge'], [null, 'folge', 'erst', null]])
    assert.equal(JSON.stringify(suggestGroups(base.map((r, i) => ({ ...r, eau_kind: kinds[i] })), c0).map(g => g.records.map(r => r.id))), ref, kinds.join())
  assert.doesNotMatch(read('src/lib/sickCases.js').replace(/\/\/.*$/gm, ''), /eau_kind/)
})

test('Kontext: nur Daten der Person, nur genehmigter Urlaub', () => {
  const c = buildContext('e1', { shifts: [{ employee_id: 'e1', date: '2026-09-12' }, { employee_id: 'e2', date: '2026-09-13' }], timeEntries: [{ employee_id: 'e2', date: '2026-09-12' }],
    vacations: [{ employee_id: 'e1', status: 'pending', start_date: '2026-09-14', end_date: '2026-09-15' }, { employee_id: 'e1', status: 'approved', start_date: '2026-09-16', end_date: '2026-09-17' }], holidays: [{ date: '2026-10-03' }] })
  assert.deepEqual([...c.shiftDates], ['2026-09-12']); assert.deepEqual([...c.workedDates], [])
  assert.deepEqual([...c.vacationDates], ['2026-09-16', '2026-09-17']); assert.ok(c.holidays.has('2026-10-03'))
})

test('Begründung: Pflicht 5–200 Zeichen', () => {
  assert.equal(reasonProblem(''), 'sickCase.reasonLength'); assert.equal(reasonProblem('  ab  '), 'sickCase.reasonLength')
  assert.equal(reasonProblem('x'.repeat(201)), 'sickCase.reasonLength'); assert.equal(reasonProblem('laut Lohnbüro'), null)
})

test('PHASE-A-SICHERHEIT: Payroll und DATEV byte-gleich zum Stand vor Phase A; lesen keine Fall-Daten', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workHours.js', 'src/lib/sickLeaveLogic.js'])
    assert.equal(read(f), atBefore(f), `${f} unverändert`)
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workHours.js'])
    assert.doesNotMatch(read(f), /case_id|sick_case|eau_kind|sickCases/, f)
  // Migration ändert keine bestehenden Werte und rechnet nichts nach
  const sql = read('supabase/migrations_onboarding/33_sick_cases.sql').replace(/--.*$/gm, '')
  assert.doesNotMatch(sql, /UPDATE\s+public\.sick_leave|UPDATE\s+sick_leave\s+SET\s+(?!case_id|eau_kind)|payroll_months|continued_pay_end|calc_continued_pay_end/i)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES public\.sick_cases\(id\) ON DELETE SET NULL;/)
})

test('UI: Vorschläge klar als Vorschlag, Aktionen nur für Admin, Beziehung nur für Admin, Diagnose-Hinweise', () => {
  const p = read('src/components/SickCasesPanel.jsx')
  assert.match(p, /tr\(s\.records\.length > 1 \? 'sickCase\.suggestion' : 'sickCase\.single'\)/)
  for (const action of ['confirmSickCase', 'removeFromSickCase', 'setSickEauKind', "setDialog\\(\\{ caseId"]) {
    const i = p.search(new RegExp(action.includes('setDialog') ? action : `\\(\\) => ${action}|run\\(\\(\\) => ${action}`))
    assert.ok(i > 0, action)
    assert.match(p.slice(Math.max(0, i - 400), i), /isAdmin &&/, `${action} nur für Admin`)
  }
  assert.match(p, /\{isAdmin && <span[^>]*>\s*\{tr\('sickCase\.relation'\)\}/, 'Beziehung nur für Admin sichtbar')
  assert.doesNotMatch(p, /useEffect\([^)]*confirmSickCase/, 'keine automatische Bestätigung')
  assert.match(p, /\{tr\('sickCase\.noDiagnosis'\)\}/)
  assert.match(read('src/pages/Vacation.jsx'), /placeholder=\{tr\("ui\.63bb086386d4"\)\} \/>\n\s+<div[^>]*>\{tr\('sickCase\.noDiagnosis'\)\}<\/div>/)
  assert.match(read('src/pages/Vacation.jsx'), /\{canManage && <SickCasesPanel sick=\{sick\} vacations=\{vacations\} isAdmin=\{isAdmin\} onChanged=\{fetchAll\} \/>\}/)
  assert.equal(de['sickCase.noDiagnosis'], 'Bitte keine Diagnose oder medizinischen Details eintragen.')
  assert.equal(en['sickCase.noDiagnosis'], 'Please do not enter any diagnosis or medical details.')
  assert.match(bn['sickCase.noDiagnosis'], /রোগনির্ণয়/)
})

test('Alle dynamischen Fall-Texte existieren in DE/EN/BN', () => {
  const keys = [...Object.values(GAP).filter(g => g !== GAP.WORKED).flatMap(g => g === GAP.NON_WORKING ? [`${g}.schedule`, `${g}.calendar`] : [g]).map(g => `sickCase.gap.${g}`),
    ...RELATIONS.map(r => `sickCase.rel.${r}`), ...RELATION_BASES.map(b => `sickCase.basis.${b}`), ...EAU_KINDS.map(k => `sickCase.eau.${k}`),
    ...['empty', 'missing', 'mixed_employees', 'case_missing', 'conflict', 'other_case', 'not_one_case', 'basis', 'reason', 'prior', 'relation', 'kind', 'worked_gap', 'admin_only'].map(c => `sickCase.err.${c}`)]
  for (const k of keys) for (const [n, cat] of [['de', de], ['en', en], ['bn', bn]]) assert.ok(cat[k], `${n}:${k}`)
  // jeder Fehlercode der RPCs hat einen Text
  const codes = [...read('supabase/migrations_onboarding/33_sick_cases.sql').matchAll(/'code', '([a-z_]+)'/g)].map(m => m[1])
  for (const c of new Set(codes)) assert.ok(de[`sickCase.err.${c}`], c)
})
