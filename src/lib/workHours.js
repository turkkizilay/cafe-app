// Arbeitszeit = tatsächliche Ein-/Ausstempelzeit minus tatsächlich erfasster Pause.
// Es wird bewusst KEINE Pause automatisch angenommen (Café Buur: flexible Pausen).
export function calcWorkedHours(clockIn, clockOut, breakMinutes = 0) {
  if (!clockIn || !clockOut) return null
  const totalH = (new Date(clockOut) - new Date(clockIn)) / 3600000
  return Math.max(0, totalH - (Number(breakMinutes) || 0) / 60)
}

// ── Erfasste Pausen (time_entry_breaks: { break_start, break_end }) ──
export const BREAK_WARNING_MINUTES = 90   // Hinweis an den Mitarbeiter, keine automatische Aktion

// Laufende Pause (break_end leer) oder null
export function openBreak(breaks) {
  return (breaks || []).find(b => b && b.break_start && !b.break_end) || null
}

// Summe in ganzen Minuten – rundet wie der DB-Trigger (_close_and_sum_breaks):
// Sekunden aller Pausen addieren, dann auf Minuten runden. Eine offene Pause zählt bis `now`.
export function sumBreakMinutes(breaks, now = new Date()) {
  const nowMs = new Date(now).getTime()
  let ms = 0
  for (const b of breaks || []) {
    if (!b?.break_start) continue
    const end = b.break_end ? new Date(b.break_end).getTime() : nowMs
    ms += Math.max(0, end - new Date(b.break_start).getTime())
  }
  return Math.round(ms / 60000)
}

// Bisherige Dauer einer Pause in vollen Minuten (für die Live-Anzeige)
export function breakElapsedMinutes(brk, now = new Date()) {
  if (!brk?.break_start) return 0
  const end = brk.break_end ? new Date(brk.break_end) : new Date(now)
  return Math.max(0, Math.floor((end - new Date(brk.break_start)) / 60000))
}

// Pausen-Bedienung auf der Einclock-Seite. Unbekannter Status (lädt / Fehler) ist NIE „keine Pause“.
// → 'hidden' (Funktion nicht verfügbar) | 'loading' | 'error' | 'running' | 'idle'
export function breakUiState({ featureOn, loadState, breaks }) {
  if (!featureOn) return 'hidden'
  if (loadState === 'loading') return 'loading'
  if (loadState !== 'ok') return 'error'
  return openBreak(breaks) ? 'running' : 'idle'
}

// Warnung ab 90 Min. laufender Pause
export function isBreakTooLong(brk, now = new Date()) {
  return !!brk && !brk.break_end && breakElapsedMinutes(brk, now) >= BREAK_WARNING_MINUTES
}

// Admin-Korrektur: Pausen prüfen (gleiche Regeln wie der DB-Guard). Liefert { code, index } oder null.
// code: 'missing' | 'order' | 'outside' | 'overlap' | 'multipleOpen'
export function validateBreaks(breaks, clockIn, clockOut) {
  const ms = v => (v ? new Date(v).getTime() : null)
  const inMs = ms(clockIn), outMs = ms(clockOut)
  const rows = (breaks || []).map((b, index) => ({ index, s: ms(b.break_start), e: ms(b.break_end) }))
  for (const r of rows) {
    if (r.s == null || (outMs != null && r.e == null)) return { code: 'missing', index: r.index }
    if (r.e != null && r.e <= r.s) return { code: 'order', index: r.index }
    if ((inMs != null && r.s < inMs) || (outMs != null && r.e > outMs)) return { code: 'outside', index: r.index }
  }
  if (rows.filter(r => r.e == null).length > 1) return { code: 'multipleOpen', index: rows.findLastIndex(r => r.e == null) }
  const sorted = [...rows].sort((a, b) => a.s - b.s)
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].e ?? Infinity
    if (sorted[i].s < prevEnd) return { code: 'overlap', index: sorted[i].index }
  }
  return null
}

// Netto-Arbeitszeit einer (ggf. noch offenen) Schicht abzüglich erfasster Pausen
export function netWorkedHours(clockIn, clockOut, breaks, now = new Date()) {
  const end = clockOut || now
  return calcWorkedHours(clockIn, end, sumBreakMinutes(breaks, end))
}

// ── Lohnrelevante offene Punkte ──
// Ein Zeiteintrag ist für die Abrechnung „ungeklärt“, solange er noch offen ist (kein Ausstempeln) oder vom Server als
// „Ausstempeln vergessen“ markiert wurde (> 12 h, mit 0 Std. bewertet, erst nach Admin-Korrektur bezahlt).
// Beide zählen in der Monatsabrechnung als 0 Std. – der Admin muss das vor Abschluss/Export sehen.
export const FORGOT_CLOCKOUT_MARK = 'AUSSTEMPELN VERGESSEN'
export function isUnresolvedEntry(e) {
  return !!e && (!e.clock_out || String(e.notes || '').includes(FORGOT_CLOCKOUT_MARK))
}
// → [{ employee_id, count }] je Mitarbeiter mit ungeklärten Einträgen
export function unresolvedByEmployee(entries) {
  const m = new Map()
  for (const e of entries || []) if (isUnresolvedEntry(e)) m.set(e.employee_id, (m.get(e.employee_id) || 0) + 1)
  return [...m].map(([employee_id, count]) => ({ employee_id, count }))
}

// Admin-Auswahllisten (Zeitkorrektur, Lohndokumente): Ausgeschiedene der letzten 12 Monate bleiben auswählbar –
// letzte Schicht korrigieren / letzte Abrechnung hochladen, ohne zu reaktivieren (das würde den Login entsperren).
// → erster Tag des Monats vor 12 Monaten (YYYY-MM-DD, lokales Datum)
export function formerStaffCutoff(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth() - 12, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// ── Admin-Zeitkorrektur (Migration 27: admin_save_time_entry) ──
// Eingabe = Datum + Wanduhrzeiten (HH:MM). Regel (identisch zur DB): Uhrzeiten VOR der Einstempelzeit gehören zum
// Folgetag → Schichten über Mitternacht; jede Schicht ist kürzer als 24 h. Maßgeblich rechnet die DB (Zeitzone,
// Sommer-/Winterzeit); hier nur Vorschau und Vorab-Prüfung ohne Server-Rundreise.
const hhmm = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m }
export function shiftOffsetMin(inT, t) {
  if (!inT || !t) return null
  const d = hhmm(t) - hhmm(inT)
  return d < 0 ? d + 1440 : d
}
export function endsNextDay(inT, t) { return !!inT && !!t && hhmm(t) < hhmm(inT) }
// → { error: { code, index? } } | { outMin, breakMin, hours }
export function correctionPlan({ inT, outT, breaks = [] }) {
  if (!inT) return { error: { code: 'missingIn' } }
  if (outT && hhmm(outT) === hhmm(inT)) return { error: { code: 'sameInOut' } }
  const outMin = outT ? shiftOffsetMin(inT, outT) : null
  const rows = breaks.map(b => ({
    break_start: b.start ? shiftOffsetMin(inT, b.start) * 60000 : null,
    break_end:   b.end   ? shiftOffsetMin(inT, b.end) * 60000 : null,
  }))
  const invalid = rows.length ? validateBreaks(rows, 0, outMin == null ? null : outMin * 60000) : null
  if (invalid) return { error: invalid }
  const breakMin = rows.length ? Math.round(rows.reduce((s, r) => s + (r.break_end == null ? 0 : r.break_end - r.break_start), 0) / 60000) : null
  return { outMin, breakMin, hours: outMin == null ? null : Math.max(0, (outMin - (breakMin || 0)) / 60) }
}
// Stand eines Eintrags wie _time_entry_state() in der DB (Epoch-Sekunden) – für die Prüfung auf veraltete Ansicht
export function timeEntryState(entry, breaks = []) {
  const sec = v => (v ? Math.floor(new Date(v).getTime() / 1000) : null)
  return {
    clock_in: sec(entry.clock_in), clock_out: sec(entry.clock_out),
    breaks: [...breaks].sort((a, b) => new Date(a.break_start) - new Date(b.break_start)).map(b => [sec(b.break_start), sec(b.break_end)]),
  }
}
// Formularwert HH:MM immer als Wanduhrzeit Europe/Berlin (24 h) – unabhängig von Sprache und Zeitzone des Geräts
const BERLIN_HHMM = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Berlin' })
export function berlinTime(iso) { return iso ? BERLIN_HHMM.format(new Date(iso)) : '' }
