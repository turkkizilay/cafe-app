// Vergütungsmodell Café Buur – getrennt von der Beschäftigungsart (Migration 18).
//   'hourly' = Stundenlohn: Brutto = bezahlte Stunden (Ist + Urlaub + Krankheit) × Stundenlohn (unverändert)
//   'fixed'  = Fixgehalt:   Brutto = hinterlegtes Brutto-Monatsgehalt, NIE aus Stunden berechnet.
// Überstunden bleiben reine Arbeitszeit-Information: keine automatische Zusatzvergütung, keine Kürzung.
// Teilmonate werden nicht anteilig gekürzt – nur als Hinweis markiert.

export const PAY_HOURLY = 'hourly'
export const PAY_FIXED  = 'fixed'
export const FIXED_PAY_EMPLOYMENT_TYPES = ['vollzeit', 'teilzeit']   // Werkstudent & Minijob: nur Stundenlohn

const round2 = n => Math.round(n * 100) / 100

// Fehlende Angabe (Altbestand / Migration noch nicht eingespielt) = Stundenlohn
export function payTypeOf(employee) {
  return employee?.pay_type === PAY_FIXED ? PAY_FIXED : PAY_HOURLY
}

export function canHaveFixedPay(employmentType) {
  return FIXED_PAY_EMPLOYMENT_TYPES.includes(employmentType)
}

export function parseMonthlySalary(value) {
  const n = parseFloat(String(value ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? round2(n) : null
}

// Formularprüfung (gleiche Regeln wie die DB-Constraints). Liefert Fehlercode oder null.
export function validatePayModel({ employment_type, pay_type, monthly_salary }) {
  if (pay_type !== PAY_FIXED) return null
  if (!canHaveFixedPay(employment_type)) return 'fixedNotAllowed'
  if (parseMonthlySalary(monthly_salary) === null) return 'salaryMissing'
  return null
}

// Monats-Brutto. paidHours = Ist + bezahlter Urlaub + Krankheit (nur für Stundenlohn relevant).
export function monthlyGross(employee, paidHours) {
  if (payTypeOf(employee) === PAY_FIXED) return round2(Number(employee.monthly_salary) || 0)
  return Math.round(paidHours * employee.hourly_rate * 100) / 100
}

// Lohnfortzahlung als eigener Betrag: bei Fixgehalt im Monatsgehalt enthalten → 0
export function sickPayAmount(employee, sickHours) {
  if (payTypeOf(employee) === PAY_FIXED) return 0
  return Math.round((sickHours || 0) * employee.hourly_rate * 100) / 100
}

// Beschäftigt nur einen Teil des Monats? (Ein-/Austritt im Monat) – nur Hinweis, keine Kürzung
export function isPartialMonth(employee, monthStart, monthEnd) {
  return !!((employee?.start_date && employee.start_date > monthStart) || (employee?.end_date && employee.end_date < monthEnd))
}

// DATEV-Zellen (Format/Spalten unverändert)
export function datevRateCell(row) {
  return payTypeOf(row) === PAY_FIXED ? '' : row.hourly_rate.toFixed(2).replace('.', ',')
}
export function datevHintCell(row) {
  const fixed = payTypeOf(row) === PAY_FIXED
  return [
    fixed && 'FIXGEHALT',
    fixed && row.partialMonth && 'TEILMONAT PRÜFEN',
    row.isAlert && (row.employment_type === 'minijob' ? 'MINIJOB-GRENZE PRÜFEN' : 'ÜBERSTUNDEN'),
  ].filter(Boolean).join(' / ')
}
