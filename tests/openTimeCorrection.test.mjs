// Zeitkorrektur mit leerem Arbeitsende (Production-Fall 04.10.2026): „Arbeitsende (leer = noch aktiv)“ muss als
// OFFENER Eintrag gespeichert werden (p_out = null, kein Ersatzwert); Beginn bleibt Pflicht; unvollständige/ungültige
// Uhrzeiten und Zukunft blockieren weiter. Ursache war TimeInput24 (Rückkehr von „unvollständig“ zu „leer“ beim
// Löschen des vorbelegten „16:00“ nicht gemeldet) – dort per Browser-Test abgesichert (tests/timeInput24.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { correctionCheck } from '../src/lib/breakRules.js'
import { correctionFutureProblem } from '../src/lib/timeCorrectionRules.js'
import { pinView } from './pinView.mjs'   // Pin-Ausnahme Production-Polish (nur a11y + Schichttausch-Fix; Lohn/Stundennachweis ohne Ausnahme)

const read = f => readFileSync(f, 'utf8')
function extractFn(file, name) {
  const src = read(file); const start = src.indexOf(`async function ${name}(`); assert.ok(start >= 0, name)
  let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return src.slice(start, i)
}
const berlin = ms => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return { d: `${p.year}-${p.month}-${p.day}`, t: `${p.hour}:${p.minute}` }
}

async function runSave({ inT, outT, date, badTimes = {} }) {
  const rpc = [], toast = { calls: [], warn: (...a) => toast.calls.push(['warn', a[0]]), error: (...a) => toast.calls.push(['error', a[0]]), success: (...a) => toast.calls.push(['success', a[0]]) }
  const deps = {
    form: { employee_id: 'e1', date, clock_in_time: inT, clock_out_time: outT, breaks: [], break_minutes: 0, notes: '', reason: 'Mitarbeiter konnte nicht einstempeln' },
    badTimes, toast, appMessage: k => k, messageParts: x => x, errorMessage: e => e,
    correctionCheck, correctionFutureProblem, BREAK_ERROR_KEY: { missingIn: 'missingIn', sameInOut: 'sameInOut', missing: 'missing', order: 'order', outside: 'outside', overlap: 'overlap' },
    setSaving: () => {}, modal: 'add', entries: [], breaksByEntry: {}, timeEntryState: () => null, employees: [],
    supabase: { rpc: async (name, args) => { rpc.push([name, args]); return { data: { success: true, id: 'new' }, error: null } } },
    logActivity: () => {}, setModal: () => {}, fetchEntries: () => {}, notifyTimeDataChanged: () => {},
  }
  await new Function(...Object.keys(deps), `return (${extractFn('src/pages/TimeManagement.jsx', 'doSave')})`)(...Object.values(deps))()
  return { rpc, toasts: toast.calls }
}

test('A: Beginn 08:00, Ende leer → offener Eintrag: p_out = null (kein Ersatzwert wie 23:59/00:00/jetzt)', async () => {
  const y = berlin(Date.now() - 24 * 3600e3).d
  const { rpc, toasts } = await runSave({ inT: '08:00', outT: '', date: y, badTimes: { in: false, out: false } })
  assert.equal(rpc.length, 1)
  assert.equal(rpc[0][0], 'admin_save_time_entry')
  assert.deepEqual([rpc[0][1].p_in, rpc[0][1].p_out, rpc[0][1].p_date], ['08:00', null, y])
  assert.deepEqual(toasts.map(t => t[0]), ['success'])
  // heute, Beginn vor 2 Stunden (Berliner Zeit) → ebenfalls erlaubt
  const s = berlin(Date.now() - 2 * 3600e3)
  const today = await runSave({ inT: s.t, outT: '', date: s.d })
  assert.equal(today.rpc[0]?.[1].p_out, null, JSON.stringify(today.toasts))
})

test('B: Beginn + Ende → abgeschlossener Eintrag unverändert', async () => {
  const y = berlin(Date.now() - 24 * 3600e3).d
  const { rpc } = await runSave({ inT: '08:00', outT: '16:30', date: y })
  assert.deepEqual([rpc[0][1].p_in, rpc[0][1].p_out], ['08:00', '16:30'])
})

test('C: Beginn leer → abgelehnt; D: Ende unvollständig/ungültig → abgelehnt; E: Beginn in der Zukunft → abgelehnt – jeweils ohne Serveraufruf', async () => {
  const y = berlin(Date.now() - 24 * 3600e3).d
  const c = await runSave({ inT: '', outT: '', date: y })
  assert.deepEqual([c.rpc.length, c.toasts], [0, [['warn', 'missingIn']]])
  for (const bad of [{ out: true }, { in: true }]) {
    const d = await runSave({ inT: '08:00', outT: '', date: y, badTimes: bad })
    assert.deepEqual([d.rpc.length, d.toasts], [0, [['warn', 'time.invalid24']]], JSON.stringify(bad))
  }
  const f = berlin(Date.now() + 2 * 3600e3)
  const e = await runSave({ inT: f.t, outT: '', date: f.d })
  assert.deepEqual([e.rpc.length, e.toasts], [0, [['warn', 'time.futureNotAllowed']]])
})

test('Server bleibt maßgeblich: Zukunft/Überschneidung/zweiter offener Eintrag/Lohnmonat werden dort geprüft (DB-Test)', () => {
  const t = read('tests/db/open_time_correction.test.mjs')
  for (const re of [/Zukunft/, /überschneiden sich/, /Lohnmonat .* abgeschlossen/, /parallel/, /start_break\(\)/, /staff_live_action/, /_labor_cost_at/])
    assert.match(t, re)
})

test('REGRESSION: nur TimeInput24 geändert – Zeitkorrektur, Schichtplan, Stempeln, Pausen, Live-Steuerung, Lohn/DATEV, Account-Reset, Migrationen byte-gleich', () => {
  const BEFORE = '51628b7'
  for (const f of ['src/pages/TimeManagement.jsx', 'src/pages/Shifts.jsx', 'src/lib/time24.js', 'src/lib/breakRules.js', 'src/lib/timeCorrectionRules.js',
    'src/pages/ClockIn.jsx', 'src/components/LiveTimeControl.jsx', 'src/lib/liveTimeControl.js', 'src/pages/Dashboard.jsx', 'src/lib/laborCost.js',
    'src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workHours.js', 'src/pages/Timesheet.jsx', 'src/lib/sickLeaveLogic.js', 'src/lib/vacationLogic.js',
    'src/lib/accessReset.js', 'src/components/AccessResetDialog.jsx', 'src/pages/SetNewPassword.jsx', 'src/App.jsx', 'src/components/Auth/Login.jsx',
    'supabase/functions/_shared/access-reset.js', 'supabase/migrations_onboarding/37_time_correction_past_only.sql', 'supabase/migrations_onboarding/38_admin_access_reset.sql'])
    assert.equal(pinView(f, read(f)), pinView(f, execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })), f)
})
