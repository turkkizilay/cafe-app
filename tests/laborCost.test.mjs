// Live-Personalkosten (Migration 35 + Dashboard): Fortschreiben, Planverbrauch, Abgleich gegen veraltete Antworten,
// Auslöser (sichtbar/Fokus/pageshow/online/Zeitdaten), Fixgehalt-Kennzeichnung, Rollen – und Lohn/DATEV unverändert.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { liveFigures, planUsage, cappedElapsedMs, msUntilDayEnd, createLaborSync, bindLaborRevalidation, notifyTimeDataChanged,
         TIME_DATA_EVENT, SAFETY_REFRESH_MS, TICK_MS } from '../src/lib/laborCost.js'
import { translate } from '../src/i18n/core.js'

const read = f => readFileSync(f, 'utf8')
const BEFORE = '3401105'   // letzter Stand vor dem Live-Personalkosten-Fix
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const BASE = {
  server_now: '2026-10-03T12:00:00.000Z', day: '2026-10-03', day_start: '2026-10-02T22:00:00.000Z', day_end: '2026-10-03T22:00:00.000Z',
  today: { net_seconds: 36000, net_seconds_hourly: 28800, cost: 120, running: 3, running_hourly: 2, running_rate: 30, on_break: 1, fixed_working: 1 },
  week: { cost: 900 }, planned: { cost: 400, seconds: 108000, fixed_shifts: 1 },
}

test('LOHN/DATEV/TIMESHEET/PAUSEN/KRANKHEIT unverändert (byte-gleich zum Stand vor dem Fix)', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workTimeModels.js', 'src/lib/workHours.js', 'src/lib/breakRules.js',
                   'src/pages/Timesheet.jsx', 'src/lib/timesheetPdf.js', 'src/pages/MyHours.jsx', 'src/lib/sickLeaveLogic.js', 'src/lib/sickCases.js',
                   'src/lib/vacationLogic.js', 'supabase/migrations_onboarding/34_break_hardening.sql', 'supabase/migrations_onboarding/33_sick_cases.sql'])
    assert.equal(read(f), atBefore(f), f)
})

test('Fortschreiben: Kosten += Summe der Sätze × Zeit, Stunden += Anzahl Arbeitender × Zeit; Woche läuft mit', () => {
  const f0 = liveFigures(BASE, 0), f = liveFigures(BASE, 30 * 60 * 1000)   // 30 Min. später
  assert.deepEqual([f0.cost, f0.hours, f0.week], [120, 10, 900])
  assert.equal(f.cost, 120 + 30 * 0.5, 'nur Arbeitende ohne Pause, nur Stundenlohn (Summe 30 €/h)')
  assert.equal(f.hours, 10 + 3 * 0.5, 'Heute geleistet: alle Arbeitenden (inkl. Fixgehalt), Pause zählt nicht')
  assert.equal(f.hoursHourly, 8 + 2 * 0.5)
  assert.equal(f.week, 900 + 15)
  assert.equal(f.planned, 400, 'Plan bleibt fest')
  assert.deepEqual([f.running, f.runningHourly, f.onBreak, f.fixedWorking, f.fixedShifts], [3, 2, 1, 1, 1])
  const idle = liveFigures({ ...BASE, today: { ...BASE.today, running: 0, running_hourly: 0, running_rate: 0 } }, 3600e3)
  assert.deepEqual([idle.cost, idle.hours], [120, 10], 'alle ausgestempelt/in Pause: steht')
})

test('Tagesende Europe/Berlin (vom Server): nie über 24:00 hinaus fortschreiben; Abgleich zum Tageswechsel', () => {
  assert.equal(cappedElapsedMs(BASE, 20 * 3600e3), 10 * 3600e3, 'max. bis day_end')
  assert.equal(liveFigures(BASE, 20 * 3600e3).cost, 120 + 30 * 10)
  assert.equal(msUntilDayEnd(BASE, 9 * 3600e3), 3600e3)
  assert.equal(msUntilDayEnd(BASE, 11 * 3600e3), 0)
  assert.equal(cappedElapsedMs(BASE, -5), 0, 'Uhr rückwärts → nie negativ')
})

test('Planverbrauch: Live ÷ geplant × 100; Plan 0 → null („–“); > 100 % erlaubt', () => {
  assert.equal(planUsage(77.34, 615.5).toFixed(2), '12.57')
  assert.equal(planUsage(0, 0), null)
  assert.equal(planUsage(50, 0), null)
  assert.equal(planUsage(500, 400), 125)
  assert.equal(liveFigures({ ...BASE, planned: { cost: 0 } }, 0).usage, null)
})

test('Abgleich: veraltete/überholte Antworten verworfen, Auslöser zusammengefasst, echte Änderungen nie verworfen', async () => {
  let t = 0
  const pending = []
  const load = () => new Promise(r => pending.push(r))
  const got = [], errs = []
  const sync = createLaborSync({ load, now: () => t, onData: d => got.push(d.server_now), onError: e => errs.push(e.kind) })
  sync.revalidate('mount'); t += 100
  sync.revalidate('focus'); sync.revalidate('visible')                       // < 400 ms → zusammengefasst
  assert.equal(pending.length, 1)
  sync.revalidate('time-data')                                               // echte Änderung während laufender Abfrage → Folgeabfrage
  pending[0]({ data: { server_now: '2026-10-03T12:00:00Z' } }); await new Promise(r => setTimeout(r))
  assert.equal(pending.length, 2, 'genau eine Folgeabfrage')
  pending[1]({ data: { server_now: '2026-10-03T11:59:00Z' } }); await new Promise(r => setTimeout(r))   // ältere Serverzeit
  assert.deepEqual(got, ['2026-10-03T12:00:00Z'], 'ältere Antwort verworfen')
  t += 1000; sync.revalidate('manual')
  pending[2]({ data: null, error: { message: 'netz' } }); await new Promise(r => setTimeout(r))
  assert.deepEqual(errs, ['error'], 'Fehler → Meldung, keine 0-€-Daten')
  assert.equal(got.length, 1)
  const off = createLaborSync({ load: () => { throw new Error('darf nicht') }, isOffline: () => true, onData: () => {}, onError: e => errs.push(e.kind) })
  await off.revalidate('online'); assert.equal(errs.at(-1), 'offline', 'offline: keine Abfrage')
  sync.dispose(); t += 1000; sync.revalidate('manual'); assert.equal(pending.length, 3, 'nach dispose keine Abfrage')
})

test('Auslöser: sichtbar, Fokus, pageshow, online, Zeitdaten (gleicher Tab + andere Tabs); versteckt nicht', () => {
  const listeners = {}, docL = {}
  const win = { addEventListener: (k, f) => (listeners[k] = f), removeEventListener: k => delete listeners[k], dispatchEvent: e => listeners[e.type]?.(e) }
  const doc = { visibilityState: 'visible', addEventListener: (k, f) => (docL[k] = f), removeEventListener: k => delete docL[k] }
  class Ch { constructor() { Ch.last = this } postMessage() {} close() { this.closed = true } }
  const fired = []
  const unbind = bindLaborRevalidation({ win, doc, trigger: r => fired.push(r), Channel: Ch })
  docL.visibilitychange(); doc.visibilityState = 'hidden'; docL.visibilitychange()
  listeners.focus(); listeners.pageshow(); listeners.online(); listeners[TIME_DATA_EVENT](); Ch.last.onmessage()
  assert.deepEqual(fired, ['visible', 'focus', 'pageshow', 'online', 'time-data', 'time-data'])
  unbind()
  assert.equal(Object.keys(listeners).length + Object.keys(docL).length, 0); assert.ok(Ch.last.closed)
  const sent = []
  class Ch2 { postMessage(m) { sent.push(m) } close() {} }
  notifyTimeDataChanged({ dispatchEvent: e => sent.push(e.type) }, Ch2)
  assert.deepEqual(sent, [TIME_DATA_EVENT, 'changed'])
  assert.ok(SAFETY_REFRESH_MS >= 60000 && TICK_MS <= 1000, 'Sicherheitsabgleich höchstens minütlich, Anzeige sekündlich (lokal)')
})

test('Dashboard: Rechnung nur serverseitig (keine Löhne im Client), nur Admin, alle Zeitänderungen melden sich', () => {
  const d = read('src/pages/Dashboard.jsx')
  assert.doesNotMatch(d, /select\('id, hourly_rate|select\('employee_id, (clock_in, clock_out, )?hours_worked'\)/, 'keine Lohnsätze/Stunden anderer mehr im Dashboard (nur noch eigene Personaldaten)')
  assert.doesNotMatch(d, /netWorkedHours|plannedToday|toFixed\(0\)\}%/)
  assert.match(d, /const laborCosts = useLiveLaborCost\(!!isAdmin\)/)
  assert.match(d, /\{isAdmin && laborCosts && \(\s*<LiveLaborCostCard labor=\{laborCosts\} \/>/)
  assert.match(read('src/lib/useLiveLaborCost.js'), /supabase\.rpc\('labor_cost_today'\)/)
  for (const [f, n] of [['src/pages/ClockIn.jsx', 5], ['src/pages/TimeManagement.jsx', 2], ['src/pages/Shifts.jsx', 4]])
    assert.equal((read(f).match(/notifyTimeDataChanged\(\)/g) || []).length, n, f)
  const card = read('src/components/LiveLaborCostCard.jsx')
  assert.match(card, /tr\("labor\.basis"\)/, 'Kennzeichnung „Fixgehälter nicht enthalten“ immer sichtbar')
  assert.match(card, /f\.usage == null \? '–'/)
  assert.doesNotMatch(card, /ui\.6a949d20384a|Lohnquote/)
})

test('Texte DE/EN/BN: Planverbrauch statt Lohnquote, Fixgehalt-Kennzeichnung, Hinweis ohne Umsatz-Behauptung', () => {
  assert.equal(translate('de', 'labor.basis'), 'Live-Kosten auf Stundenlohnbasis · Fixgehälter nicht enthalten')
  assert.equal(translate('en', 'labor.basis'), 'Live costs based on hourly wages · fixed salaries not included')
  assert.match(translate('bn', 'labor.basis'), /[ঀ-৿]/)
  assert.deepEqual(['de', 'en'].map(l => translate(l, 'labor.planUsage')), ['Planverbrauch', 'Plan usage'])
  assert.match(translate('bn', 'labor.planUsage'), /[ঀ-৿]/)
  assert.match(translate('de', 'labor.planUsageHint'), /Anteil der bisher angefallenen Live-Personalkosten an den für heute geplanten Personalkosten/)
  for (const l of ['de', 'en', 'bn']) assert.doesNotMatch(translate(l, 'labor.planUsageHint'), /Lohnquote ist|is the labor cost ratio/)
  for (const c of ['src/i18n/catalogs.js', 'src/i18n/catalogBn.js']) assert.doesNotMatch(read(c), /"ui\.6a949d20384a"/, 'Kennzahl „Lohnquote“ entfernt')
})

test('Migration 35: additiv, nur Admin, nur Summen, keine Datenänderung, search_path gesetzt', () => {
  const sql = read('supabase/migrations_onboarding/35_labor_cost_today.sql')
  const outside = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--.*$/gm, '')
  assert.doesNotMatch(outside, /^\s*(UPDATE\s+\S+\s+SET|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+(TABLE|POLICY)|TRUNCATE)\b/im)
  assert.doesNotMatch(sql, /payroll_months|exportDATEV/i, 'Lohnabschluss/DATEV nicht berührt')
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$/g)) assert.match(m[0], /SECURITY DEFINER SET search_path TO 'public'/)
  assert.match(sql, /IF auth\.uid\(\) IS NULL OR NOT is_admin\(\) THEN/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\._labor_cost_at\(timestamptz\) FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /e\.pay_type = 'hourly'/, 'Kosten nur Stundenlohn')
})
