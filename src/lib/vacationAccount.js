// Vacation System 2.0 – Phase 1: reiner Rechenkern für jahresbezogene Urlaubskonten (Migration 40).
// NOCH NICHT IN DER APP EINGEBUNDEN. Quelle für alles Angezeigte/Geprüfte bleibt src/lib/vacationLogic.js.
// Enthält bewusst KEINE Regeln für Verfall, Jahreswechsel, Eintritt/Austritt, Rundung, gesetzlich/vertraglich oder
// Krankheit im Urlaub (offene Business-/Legal-Entscheidungen). Er rechnet nur, was gebucht bzw. zugeordnet ist.

const round2 = n => Math.round(n * 100) / 100   // nur Gleitkomma-Hygiene (2 Nachkommastellen), keine fachliche Rundung

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Verbrauch genehmigter Anträge je Antrag und Kalenderjahr – gleiche Zählweise wie heute (vacationLogic.getVacationBalance):
 * Mo–Fr, ohne Feiertage, jeder Kalendertag höchstens einmal (überlappende Anträge in der gegebenen Reihenfolge).
 * Krankheit im Urlaub wird hier NICHT berücksichtigt (heutige Logik bleibt maßgeblich; Entscheidung L8 offen).
 * @returns {Map<string, Record<number, number>>} requestId → { Jahr: Tage }
 */
export function allocateApprovedVacations(vacations, holidays = []) {
  const holidaySet = new Set((holidays || []).map(h => h.date))
  const counted = new Set(), out = new Map()
  for (const v of vacations || []) {
    if (v?.status !== 'approved' || !v.start_date || !v.end_date || v.start_date > v.end_date) continue
    const perYear = {}
    const d = new Date(v.start_date + 'T12:00:00'), end = new Date(v.end_date + 'T12:00:00')
    for (; d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay(), ds = ymd(d)
      if (dow === 0 || dow === 6 || holidaySet.has(ds) || counted.has(ds)) continue
      counted.add(ds)
      perYear[d.getFullYear()] = (perYear[d.getFullYear()] || 0) + 1
    }
    out.set(v.id, perYear)
  }
  return out
}

/**
 * Kontostand eines Kalenderjahres aus Buchungen (vacation_ledger) und aktuellen Zuordnungen (vacation_request_allocations).
 * Gegenbuchungen heben die aufgehobene Buchung in deren Kategorie auf; abgelöste Zuordnungen zählen nicht.
 * Trennt: A) Anspruch, B) Übertrag mit Herkunftsjahr, Eröffnungssaldo, Korrekturen, C) Verbrauch, D) verfügbar.
 */
export function summarizeVacationAccount({ year, ledger = [], allocations = [] }) {
  const rows = (ledger || []).filter(r => r.account_year === year)
  const byId = new Map(rows.map(r => [r.id, r]))
  const sums = { entitlement: 0, opening: 0, carryIn: 0, carryOut: 0, adjustments: 0 }
  const origin = new Map()
  const add = (kind, days, related) => {
    if (kind === 'entitlement' || kind === 'entitlement_adjustment') sums.entitlement += days
    else if (kind === 'opening_balance') sums.opening += days
    else if (kind === 'carry_in') { sums.carryIn += days; origin.set(related, (origin.get(related) || 0) + days) }
    else if (kind === 'carry_out') sums.carryOut += days
    else if (kind === 'manual_adjustment') sums.adjustments += days
    else throw new Error(`Unbekannte Buchungsart: ${kind}`)
  }
  for (const r of rows) {
    const days = Number(r.days)
    if (r.kind === 'reversal') {
      const o = byId.get(r.reverses_id)
      if (!o) throw new Error('Gegenbuchung ohne aufgehobene Buchung im selben Konto')
      add(o.kind, days, o.related_year)
    } else add(r.kind, days, r.related_year)
  }
  const superseded = new Set((allocations || []).map(a => a.supersedes_id).filter(Boolean))
  const used = (allocations || []).filter(a => a.account_year === year && !superseded.has(a.id)).reduce((s, a) => s + Number(a.days), 0)
  const carryInByOrigin = [...origin.entries()].filter(([, d]) => round2(d) !== 0).sort((a, b) => a[0] - b[0]).map(([y, d]) => ({ year: y, days: round2(d) }))
  const available = sums.entitlement + sums.opening + sums.carryIn + sums.carryOut + sums.adjustments - used
  return {
    year,
    entitlement: round2(sums.entitlement),      // A
    carryIn: round2(sums.carryIn),              // B (mit Herkunft)
    carryInByOrigin,
    openingBalance: round2(sums.opening),
    adjustments: round2(sums.adjustments),
    carryOut: round2(sums.carryOut),            // in Folgejahr übertragen (≤ 0)
    used: round2(used),                         // C
    available: round2(available),               // D
  }
}
