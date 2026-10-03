// Stellvertretende Live-Buchung (Migration 36) im Frontend: Zustand, gültige Aktionen, Antwort-Auswertung, Dashboard-
// Ablauf (Bestätigung, Doppeltipp, Revalidierung der Live-Kosten) – und alles Übrige unverändert.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { liveStateOf, ACTIONS_BY_STATE, runLiveAction, liveErrorKind } from '../src/lib/liveTimeControl.js'

const read = f => readFileSync(f, 'utf8')
const BEFORE = '2a620d7'   // Stand vor der Live-Steuerung (Live-Personalkosten live)
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const grab = (src, name) => { const s = src.indexOf(`async function ${name}(`); let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1; while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- } return src.slice(s, i) }

test('REGRESSION: Lohn, DATEV, Timesheet, Pausen-/Krankheitslogik, Live-Kosten, Selbst-/Remote-Stempeln byte-gleich', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workHours.js', 'src/lib/workTimeModels.js', 'src/lib/breakRules.js',
                   'src/pages/Timesheet.jsx', 'src/lib/timesheetPdf.js', 'src/pages/MyHours.jsx', 'src/lib/sickLeaveLogic.js', 'src/lib/sickCases.js',
                   'src/lib/vacationLogic.js', 'src/lib/laborCost.js', 'src/lib/useLiveLaborCost.js', 'src/components/LiveLaborCostCard.jsx',
                   'src/pages/ClockIn.jsx', 'src/lib/remoteClock.js', 'src/lib/breaks.js', 'src/pages/Shifts.jsx', 'src/pages/Vacation.jsx',
                   'supabase/migrations_onboarding/34_break_hardening.sql', 'supabase/migrations_onboarding/35_labor_cost_today.sql',
                   'supabase/migrations_onboarding/29_remote_clock.sql'])
    assert.equal(read(f), atBefore(f), f)
})

test('Zustand je Person wie auf dem Server; nur gültige Aktionen je Zustand', () => {
  const open = [{ id: 'e1', employee_id: 'A', clock_out: null }, { id: 'e2', employee_id: 'B', clock_out: null }]
  const brk = { e2: [{ break_start: 'x', break_end: 'y' }, { break_start: 'z', break_end: null }] }
  assert.deepEqual(['A', 'B', 'C'].map(id => liveStateOf(id, open, brk)), ['WORKING', 'ON_BREAK', 'OFF_CLOCK'])
  assert.equal(liveStateOf('A', open, { e1: [{ break_start: 'x', break_end: 'y' }] }), 'WORKING', 'beendete Pause = arbeitet')
  assert.deepEqual(ACTIONS_BY_STATE, { OFF_CLOCK: ['clock_in'], WORKING: ['break_start', 'clock_out'], ON_BREAK: ['break_end', 'clock_out'] })
})

test('Serverantwort: Erfolg, veraltet, ungültig, Rolle/selbst/inaktiv, Netzwerk – nie still als Erfolg', async () => {
  const calls = []
  const rpc = res => ({ rpc: async (fn, args) => { calls.push([fn, args]); if (res instanceof Error) throw res; return res } })
  const ok = await runLiveAction({ employeeId: 'A', action: 'clock_in', expected: 'OFF_CLOCK' }, rpc({ data: { success: true, state: 'WORKING', server_time: '2026-10-03T10:00:00Z' } }))
  assert.deepEqual(ok, { ok: true, state: 'WORKING', serverTime: '2026-10-03T10:00:00Z' })
  assert.deepEqual(calls[0], ['staff_live_action', { p_employee_id: 'A', p_action: 'clock_in', p_expected_state: 'OFF_CLOCK', p_confirmed: true }], 'keine Uhrzeit, keine Akteur-ID vom Client')
  assert.deepEqual(await runLiveAction({}, rpc({ data: { success: false, code: 'stale', state: 'WORKING' } })), { ok: false, kind: 'stale', state: 'WORKING' })
  assert.deepEqual(await runLiveAction({}, rpc({ data: { success: false, code: 'invalid_transition', state: 'OFF_CLOCK' } })), { ok: false, kind: 'invalid', state: 'OFF_CLOCK' })
  for (const [hint, kind] of [['live_not_allowed', 'notAllowed'], ['live_self', 'self'], ['live_employee_inactive', 'inactive'], ['other', 'failed']])
    assert.equal((await runLiveAction({}, rpc({ error: { code: 'P0001', hint, message: 'x' } }))).kind, kind)
  assert.equal((await runLiveAction({}, rpc(new TypeError('Failed to fetch')))).kind, 'network')
  assert.equal((await runLiveAction({}, rpc({ data: null, error: null }))).kind, 'failed')
  assert.equal(liveErrorKind({ message: 'NetworkError when attempting to fetch resource.' }), 'network')
})

test('Dashboard-Ablauf: Erfolg → Meldung + Live-Kosten-Signal + Neuladen; veraltet/Fehler → Hinweis, Neuladen, kein Signal', async () => {
  const src = read('src/pages/Dashboard.jsx')
  const run = async result => {
    const h = { toasts: [], notified: 0, fetched: 0, closed: 0 }
    const deps = {
      runLiveAction: async () => result, supabase: {}, showToast: (m, t) => h.toasts.push([m.key ?? m, t]), appMessage: (key, p) => ({ key, p }),
      formatParam: (_f, v) => String(v), notifyTimeDataChanged: () => h.notified++, fetchAll: async () => h.fetched++,
      setLiveTarget: () => h.closed++, setLivePicker: () => {},
      LIVE_DONE_KEY: { clock_in: 'live.doneClockIn' }, LIVE_ERROR_KEY: { stale: 'live.stale', invalid: 'live.stale', network: 'live.network', failed: 'live.failed' },
    }
    await new Function(...Object.keys(deps), `return (${grab(src, 'runLive')})`)(...Object.values(deps))({ employeeId: 'A', name: 'Alex', action: 'clock_in', expected: 'OFF_CLOCK' })
    return h
  }
  let h = await run({ ok: true, state: 'WORKING', serverTime: '2026-10-03T10:00:00Z' })
  assert.deepEqual([h.toasts, h.notified, h.fetched, h.closed], [[['live.doneClockIn', 'success']], 1, 1, 1])
  h = await run({ ok: false, kind: 'stale', state: 'WORKING' })
  assert.deepEqual([h.toasts, h.notified, h.fetched, h.closed], [[['live.stale', 'warn']], 0, 1, 1], 'veraltete Ansicht: Dialog zu, Stand neu')
  h = await run({ ok: false, kind: 'network' })
  assert.deepEqual([h.toasts, h.notified, h.fetched, h.closed], [[['live.network', 'error']], 0, 1, 0], 'Netzwerkfehler: Dialog bleibt, Stand neu')
})

test('UI: nur Manager/Admin, Bestätigung Pflicht, keine Uhrzeit-Eingabe, Doppeltipp-Sperre, Hinweis Serverzeit/Korrektur', () => {
  const d = read('src/pages/Dashboard.jsx'), c = read('src/components/LiveTimeControl.jsx')
  assert.match(d, /\{canManage && liveTarget && \(/); assert.match(d, /\{canManage && livePicker && \(/)
  assert.match(d, /const rowButton = \(employeeId, emp\) => canManage \? \{/)
  assert.match(d, /isSelf=\{liveTarget\.employeeId === profile\?\.employee_id\}/)
  assert.match(d, /e\.is_active && e\.id !== profile\?\.employee_id && liveStateOf\(e\.id, liveClockIns, liveBreaks\) === 'OFF_CLOCK'/, 'Auswahl: nur aktive, nicht selbst, nicht eingestempelt')
  assert.doesNotMatch(c, /TimeInput24|type="time"|datetime-local|placeholder="HH:MM"|new Date\(/, 'keine Zeiteingabe, keine Client-Uhrzeit')
  assert.match(c, /if \(busyRef\.current \|\| !person \|\| !action\) return/)
  assert.match(c, /ACTIONS_BY_STATE\[personState\]\.map/)
  assert.match(c, /tr\('live\.confirmBody'\)/); assert.match(c, /tr\('live\.serverTimeNote'\)/); assert.match(c, /tr\('live\.correctionHint'\)/)
  assert.match(c, /minHeight: 48/, 'große Touch-Ziele')
  assert.match(read('src/pages/TimeManagement.jsx'), /tr\("clock\.liveBadge"\)/)
})

test('Migration 36: additiv, Funktionen mit search_path, kein Zeit-Parameter, Audit nur über die Funktion', () => {
  const sql = read('supabase/migrations_onboarding/36_staff_live_action.sql')
  const outside = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--.*$/gm, '')
  assert.doesNotMatch(outside, /^\s*(UPDATE\s+\S+\s+SET|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/im, 'keine Datenänderung')
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$function\$/g)) assert.match(m[0], /SECURITY DEFINER SET search_path TO 'public'/)
  assert.match(sql, /FUNCTION public\.staff_live_action\(p_employee_id uuid, p_action text, p_expected_state text, p_confirmed boolean\)/)
  assert.match(sql, /REVOKE ALL ON public\.time_live_actions FROM PUBLIC, anon, authenticated;\nGRANT SELECT ON public\.time_live_actions TO authenticated;/)
  assert.match(sql, /AND NEW\.employee_id IS DISTINCT FROM my_employee_id\(\)/, 'Standort-Ausnahme nie für sich selbst')
  assert.match(sql, /AND OLD\.employee_id IS DISTINCT FROM my_employee_id\(\)/)
})
