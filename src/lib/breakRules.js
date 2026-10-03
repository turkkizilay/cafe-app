// Pausenregeln der Admin-Zeitkorrektur und Pausenzeiten im Stundennachweis (Migration 34).
// Bewusst eigenes Modul: workHours.js (von der Lohnabrechnung importiert) bleibt unverändert.
// Maßgeblich prüft und rechnet die DB (admin_save_time_entry); hier nur Vorschau und Vorab-Prüfung.
import { correctionPlan, shiftOffsetMin } from './workHours.js'

// Altbestand: pauschale Pausenminuten ohne Pausenzeilen (vor Migration 17). Nur diese dürfen in einer Korrektur
// unverändert bleiben (oder entfernt werden); neue Pausen immer mit Beginn + Ende.
export function legacyBreakMinutes(entry, breaks = []) {
  const m = Number(entry?.break_minutes) || 0
  return !(breaks || []).length && m > 0 ? m : 0
}

// Wie correctionPlan, aber „außerhalb der Arbeitszeit“ vor „Ende vor Beginn“ – wie die DB: eine vor Arbeitsbeginn
// getippte Pause gehört nach der Folgetag-Regel hinter das Schichtende und ist damit außerhalb, nicht „verdreht“.
export function correctionCheck({ inT, outT, breaks = [] }) {
  const plan = correctionPlan({ inT, outT, breaks })
  if (!plan.error || plan.error.code !== 'order' || !outT) return plan
  const outMin = shiftOffsetMin(inT, outT)
  const index = breaks.findIndex(b => b.start && b.end &&
    (shiftOffsetMin(inT, b.start) >= outMin || shiftOffsetMin(inT, b.end) > outMin))
  return index >= 0 && index <= plan.error.index ? { error: { code: 'outside', index } } : plan
}

// Pausenzeiten für Stundennachweis/PDF: „12:00–12:30, 15:00–15:10“ (laufende Pause: „12:00–…“)
export function breakTimesLabel(breaks, fmt) {
  return [...(breaks || [])].sort((a, b) => new Date(a.break_start) - new Date(b.break_start))
    .map(b => `${fmt(b.break_start)}–${b.break_end ? fmt(b.break_end) : '…'}`).join(', ')
}
