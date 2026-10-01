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

// Stundenlohn: leer → null; sonst Zahl > 0 (Komma oder Punkt). Ungültig → NaN (≠ leer, damit es gemeldet wird).
export function parseHourlyRate(value) {
  const raw = String(value ?? '').replace(/\s/g, '')
  if (raw === '') return null
  const n = parseFloat(raw.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? round2(n) : NaN
}

// Stundenlohn nach Vergütungsmodell (Quelle der Wahrheit: pay_type; gleiche Regel wie Migration 30):
// Stundenlohn → Pflicht; Fixgehalt → optional (wird für Lohn/DATEV nicht verwendet), wenn angegeben > 0.
export function validateHourlyRate({ pay_type, hourly_rate }) {
  const rate = parseHourlyRate(hourly_rate)
  if (Number.isNaN(rate)) return 'rateInvalid'
  if (rate === null && payTypeOf({ pay_type }) !== PAY_FIXED) return 'rateMissing'
  return null
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

// DATEV-Personalnummer (Migration 27: employees.personnel_number) – feste Nummer je Person, nie die Zeilennummer.
// Zeilen ohne Nummer → Export blockieren (lieber anhalten als Werte der falschen Person zuordnen).
export function missingPersonnelNumbers(rows) {
  return (rows || []).filter(r => !/^[0-9]{1,10}$/.test(String(r.personnel_number ?? '')))
}

// Jahresauswahl der Lohnabrechnung: ab dem ersten Abrechnungsjahr bis Folgejahr, mitwachsend (keine feste Liste).
// Ein gewähltes Jahr außerhalb des Bereichs bleibt auswählbar (sonst zeigte das Feld einen falschen Wert).
export const FIRST_PAYROLL_YEAR = 2024
export function payrollYearOptions(currentYear, selectedYear) {
  const last = Math.max(currentYear + 1, FIRST_PAYROLL_YEAR)
  const years = Array.from({ length: last - FIRST_PAYROLL_YEAR + 1 }, (_, i) => FIRST_PAYROLL_YEAR + i)
  if (selectedYear != null && !years.includes(selectedYear)) years.push(selectedYear)
  return years.sort((a, b) => a - b)
}
