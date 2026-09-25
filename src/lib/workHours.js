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
