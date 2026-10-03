// Stellvertretende Live-Buchung (Manager/Admin, Migration 36). Rein (Client wird übergeben → testbar). Nur JETZT mit Serverzeit – keine Uhrzeit-Eingabe;
// vergangene Zeiten gehören in die Zeitkorrektur. Der Server prüft Rolle, Person, Zustand und bucht atomar.

export const LIVE_STATES = Object.freeze(['OFF_CLOCK', 'WORKING', 'ON_BREAK'])
export const ACTIONS_BY_STATE = Object.freeze({
  OFF_CLOCK: ['clock_in'],
  WORKING:   ['break_start', 'clock_out'],
  ON_BREAK:  ['break_end', 'clock_out'],
})

// Zustand einer Person aus den geladenen offenen Einträgen und Pausen (wie der Server ihn ableitet)
export function liveStateOf(employeeId, openEntries = [], breaksByEntry = {}) {
  const entry = (openEntries || []).find(e => e.employee_id === employeeId && !e.clock_out)
  if (!entry) return 'OFF_CLOCK'
  return (breaksByEntry?.[entry.id] || []).some(b => b && b.break_start && !b.break_end) ? 'ON_BREAK' : 'WORKING'
}

// Fehlerart aus der Serverantwort (Meldung bleibt sprachneutral; Text wählt die Oberfläche)
export function liveErrorKind(error) {
  const hint = error?.hint || ''
  if (hint === 'live_not_allowed') return 'notAllowed'
  if (hint === 'live_self') return 'self'
  if (hint === 'live_employee_inactive') return 'inactive'
  if (!error?.code && !hint && /fetch|network|timeout|abort/i.test(String(error?.message || ''))) return 'network'
  return 'failed'
}

// → { ok:true, state, serverTime } | { ok:false, kind:'stale'|'invalid'|'notAllowed'|'self'|'inactive'|'network'|'failed', state? }
export async function runLiveAction({ employeeId, action, expected }, client) {
  let res
  try {
    res = await client.rpc('staff_live_action', { p_employee_id: employeeId, p_action: action, p_expected_state: expected, p_confirmed: true })
  } catch (error) {
    return { ok: false, kind: liveErrorKind(error) === 'failed' ? 'network' : liveErrorKind(error) }
  }
  if (res?.error) return { ok: false, kind: liveErrorKind(res.error) }
  const d = res?.data
  if (!d) return { ok: false, kind: 'failed' }
  if (d.success) return { ok: true, state: d.state, serverTime: d.server_time }
  return { ok: false, kind: d.code === 'stale' ? 'stale' : 'invalid', state: d.state }
}
