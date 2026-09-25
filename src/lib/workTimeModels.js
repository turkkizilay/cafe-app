// Arbeitszeitmodelle Café Buur: Monats-Soll, Überstunden und Warnstufen – zentral an EINER Stelle.
// Grundlage sind immer die Netto-Stunden (Anwesenheit minus tatsächlich erfasste Pausen, hours_worked).
// Ist-Stunden werden hier NIE gekürzt, gedeckelt oder ausgeblendet – nur eingeordnet.
import { WERKSTUDENT_MONTHLY_LIMIT } from './constants.js'

export const FULLTIME_MONTHLY_TARGET_H = 172   // Vollzeit: festes Monats-Soll
export const FULLTIME_MONTHLY_CAP_H    = 220   // Vollzeit: Auszahlungs-/Warnschwelle (nur Warnung, keine Kürzung)
export const WEEKS_PER_MONTH           = 4.3   // Teilzeit & Co.: Wochenstunden × 4,3 = Monats-Soll
export const STUDENT_MONTHLY_LIMIT_H   = WERKSTUDENT_MONTHLY_LIMIT   // Werkstudent: betriebliche Monatsgrenze (80 h)
export const STUDENT_NEAR_RATIO        = 0.9   // Werkstudent: Hinweis ab 90 % der Grenze

const round2 = n => Math.round(n * 100) / 100

// Monats-Soll in Stunden: Vollzeit fest 172 h, sonst Wochenstunden × 4,3
export function monthlyTargetHours(employee) {
  if (!employee) return 0
  if (employee.employment_type === 'vollzeit') return FULLTIME_MONTHLY_TARGET_H
  return round2((Number(employee.hours_per_week) || 0) * WEEKS_PER_MONTH)
}

// Einordnung eines Monats. status:
//   Vollzeit/Teilzeit: 'ok' | 'overtime' | 'over_cap' (nur Vollzeit, > 220 h)
//   Werkstudent:       'ok' | 'near' (ab 90 %) | 'reached' (= 80 h) | 'over' (> 80 h)
//   Minijob:           'ok' – die Minijob-Prüfung läuft unverändert über den Verdienst
export function monthlyModel(employee, actualHours) {
  const type   = employee?.employment_type
  const actual = Number(actualHours) || 0
  const target = monthlyTargetHours(employee)
  if (type === 'werkstudent') {
    const limit  = STUDENT_MONTHLY_LIMIT_H
    const status = actual > limit + 0.005 ? 'over'
                 : actual >= limit - 0.005 ? 'reached'
                 : actual >= limit * STUDENT_NEAR_RATIO ? 'near' : 'ok'
    return { type, actual, target, limit, overtime: round2(Math.max(0, actual - limit)), status }
  }
  if (type === 'minijob') return { type, actual, target, limit: null, overtime: 0, status: 'ok' }
  const overtime = round2(Math.max(0, actual - target))
  const cap      = type === 'vollzeit' ? FULLTIME_MONTHLY_CAP_H : null
  const status   = cap != null && actual > cap ? 'over_cap' : overtime > 0 ? 'overtime' : 'ok'
  return { type, actual, target, limit: cap, overtime, status }
}
