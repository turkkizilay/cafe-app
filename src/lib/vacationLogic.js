/**
 * Urlaubslogik — Café Buur
 * ════════════════════════════════════════════════════════════
 * §9 BUrlG : Erkrankt ein Arbeitnehmer während des Urlaubs, so werden
 *            die durch ärztliches Zeugnis nachgewiesenen Tage der
 *            Arbeitsunfähigkeit auf den Jahresurlaub NICHT angerechnet.
 *
 * Feiertage: Gesetzliche Feiertage während Urlaub werden NICHT als
 *            Urlaubstage gezählt (BAG-Rechtsprechung).
 * ════════════════════════════════════════════════════════════
 */

// ── Hilfsfunktionen ──────────────────────────────────────────

/**
 * Lokales Datum als YYYY-MM-DD.
 * KEIN toISOString() — das gibt UTC zurück und verschiebt in DE (UTC+2)
 * lokale Mitternacht auf den Vortag → falsche Datumsvergleiche.
 *
 * Beispiel: new Date('2026-06-28T00:00:00') lokal (UTC+2)
 *   → toISOString() = '2026-06-27T22:00:00Z' → slice = '2026-06-27' ← FALSCH
 *   → toLocalDateStr() = '2026-06-28' ← KORREKT
 */
function toLocalDateStr(d) {
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

/** Lokales heutiges Datum als YYYY-MM-DD */
function todayLocalStr() {
  return toLocalDateStr(new Date())
}

/** Prüft ob zwei Zeiträume sich überschneiden */
function periodsOverlap(start1, end1, start2, end2) {
  return start1 <= end2 && end1 >= start2
}

/**
 * Zählt Arbeitstage zwischen zwei Daten (inklusiv).
 * Exklusive: Wochenenden + optionale Feiertage.
 */
export function countWorkdays(startStr, endStr, holidaySet = new Set()) {
  if (!startStr || !endStr || startStr > endStr) return 0
  let count = 0
  const d   = new Date(startStr + 'T12:00:00')   // Mittag → kein UTC-Randproblem
  const end = new Date(endStr   + 'T12:00:00')
  while (d <= end) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6 && !holidaySet.has(toLocalDateStr(d))) count++
    d.setDate(d.getDate() + 1)
  }
  return count
}

// ── Kernfunktion: Vollständige Urlaubsbilanz ─────────────────

/**
 * Berechnet die exakte Urlaubsbilanz eines Mitarbeiters.
 *
 * Berücksichtigt:
 *  - §9 BUrlG: Krankheitstage während Urlaub → zurückgegeben
 *  - Feiertage: Gesetzliche Feiertage im Urlaub → nicht abgezogen
 *  - Laufende Krankmeldungen (kein end_date) → bis heute
 *  - Nur genehmigte Urlaube (status === 'approved')
 *  - Nur eigener Mitarbeiter (caller muss vorfiltern)
 *  - Tage werden nie doppelt zurückgegeben
 *
 * WICHTIG: sickLeaves muss bereits auf employee_id gefiltert sein!
 *
 * @param {Object} employee      - Mitarbeiterobjekt
 * @param {Array}  vacations     - Urlaubsanträge des Mitarbeiters
 * @param {Array}  sickLeaves    - Krankmeldungen des Mitarbeiters
 * @param {Array}  holidays      - Gesetzliche Feiertage [{date: 'YYYY-MM-DD'}]
 * @param {number} year          - Jahr (default: aktuelles Jahr)
 */
export function getVacationBalance(employee, vacations, sickLeaves, holidays, year = new Date().getFullYear()) {
  const holidaySet = new Set((holidays || []).map(h => h.date))
  const today      = todayLocalStr()

  // Nur genehmigte Urlaube die (teilweise) ins Zieljahr fallen
  const approved = (vacations || []).filter(v =>
    v.status === 'approved' && (
      new Date(v.start_date + 'T12:00:00').getFullYear() === year ||
      new Date(v.end_date   + 'T12:00:00').getFullYear() === year
    )
  )

  // Pending-Tage: nur zur Info, werden nicht vom Konto abgezogen
  const pendingDays = (vacations || [])
    .filter(v => v.status === 'pending')
    .reduce((s, v) => s + (v.days_count || 0), 0)

  let totalUsed            = 0
  let totalReturnedSick    = 0
  let totalSickReview      = 0
  let totalReturnedHoliday = 0
  const breakdown = []

  // Jeden Kalender-Arbeitstag nur EINMAL zählen, auch bei überlappenden Urlauben
  const countedDays = new Set()

  for (const vac of approved) {
    // Zeitraum auf das Zieljahr begrenzen (Jahreswechsel-Urlaube)
    const rawStart = new Date(vac.start_date + 'T12:00:00')
    const rawEnd   = new Date(vac.end_date   + 'T12:00:00')
    const yearStart = new Date(year, 0, 1, 12, 0, 0)
    const yearEnd   = new Date(year, 11, 31, 12, 0, 0)

    const vacStart = rawStart < yearStart ? yearStart : rawStart
    const vacEnd   = rawEnd   > yearEnd   ? yearEnd   : rawEnd

    if (vacStart > vacEnd) continue

    let usedDays    = 0
    let sickDays    = 0   // mit Attest
    let reviewDays  = 0   // ohne Attest
    let holidayDays = 0

    const d = new Date(vacStart)
    while (d <= vacEnd) {
      const dow = d.getDay()
      const ds  = toLocalDateStr(d)

      if (dow !== 0 && dow !== 6) {
        if (countedDays.has(ds)) {
          // Dieser Arbeitstag wurde bereits durch einen anderen Urlaub gezählt → überspringen
          d.setDate(d.getDate() + 1); continue
        }
        countedDays.add(ds)
        if (holidaySet.has(ds)) {
          holidayDays++
        } else {
          // §9 BUrlG: Krank an diesem Tag?
          const matchingSick = (sickLeaves || []).filter(s => {
            const sickEnd = s.end_date || today
            return ds >= s.start_date && ds <= sickEnd
          })

          if (matchingSick.length === 0) {
            usedDays++
          } else {
            // Hat mindestens eine deckende Krankmeldung ein Attest?
            const hasAttest = matchingSick.some(s =>
              s.certificate_received === true || !!s.certificate_file_path
            )
            if (hasAttest) {
              sickDays++    // Attest vorhanden → Urlaubstag wird zurückgegeben
            } else {
              reviewDays++  // Kein Attest → vorläufig als genutzt, Prüfung nötig
              usedDays++    // Zählt vorerst als verbraucht
            }
          }
        }
      }
      d.setDate(d.getDate() + 1)
    }

    totalUsed            += usedDays
    totalReturnedSick    += sickDays
    totalSickReview      += reviewDays
    totalReturnedHoliday += holidayDays

    if (sickDays > 0 || reviewDays > 0 || holidayDays > 0) {
      breakdown.push({
        id:            vac.id,
        start:         vac.start_date,
        end:           vac.end_date,
        originalDays:  usedDays + sickDays + holidayDays,
        effectiveDays: usedDays,
        sickDays,
        reviewDays,
        holidayDays,
      })
    }
  }

  const entitlement = employee?.vacation_days_per_year || 20
  const remaining   = entitlement - totalUsed

  return {
    entitlement,
    used:              totalUsed,             // Tatsächlich verbrauchte Urlaubstage
    returned_sick:     totalReturnedSick,     // §9 BUrlG + Attest → zurückgegeben
    sick_review:       totalSickReview,       // §9 BUrlG erkannt, kein Attest → Prüfung erforderlich
    returned_holiday:  totalReturnedHoliday,  // Feiertage → nicht abgezogen
    pending:           pendingDays,
    remaining,
    can_request: (days) => remaining >= days,
    breakdown,
    approved_total: totalUsed + totalReturnedSick + totalReturnedHoliday,
    // Hinweis: totalSickReview ist bereits in totalUsed enthalten (vorläufig als genutzt)
    // Daher KEIN + totalSickReview in approved_total
  }
}

// ── Konflikt-Erkennung ────────────────────────────────────────

export function checkVacationDuringSick(startDate, endDate, sickLeaves, holidays = []) {
  const holidaySet = new Set((holidays || []).map(h => h.date))
  const today      = todayLocalStr()

  const overlapping = (sickLeaves || []).filter(s => {
    const sickEnd = s.end_date || today
    return periodsOverlap(startDate, endDate, s.start_date, sickEnd)
  })

  if (overlapping.length === 0) return { overlaps: false, sickDays: 0, message: null }

  let sickDays = 0
  const d   = new Date(startDate + 'T12:00:00')
  const end = new Date(endDate   + 'T12:00:00')

  while (d <= end) {
    const dow = d.getDay()
    const ds  = toLocalDateStr(d)
    if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) {
      const isSick = overlapping.some(s => {
        const sickEnd = s.end_date || today
        return ds >= s.start_date && ds <= sickEnd
      })
      if (isSick) sickDays++
    }
    d.setDate(d.getDate() + 1)
  }

  return {
    overlaps: sickDays > 0,
    sickDays,
    message: sickDays > 0
      ? `ℹ️ §9 BUrlG: ${sickDays} der beantragten Tage überschneiden sich mit einer Krankmeldung — diese Tage werden nicht als Urlaub gezählt.`
      : null,
  }
}

export function checkSickDuringVacation(sickStart, sickEnd, approvedVacations, holidays = []) {
  const holidaySet      = new Set((holidays || []).map(h => h.date))
  const effectiveSickEnd = sickEnd || todayLocalStr()

  const affected = (approvedVacations || []).filter(v =>
    v.status === 'approved' &&
    periodsOverlap(sickStart, effectiveSickEnd, v.start_date, v.end_date)
  )

  if (affected.length === 0) return { overlaps: false, returnedDays: 0, affectedVacations: [], message: null }

  let returnedDays = 0

  for (const vac of affected) {
    const overlapStart = sickStart > vac.start_date ? sickStart : vac.start_date
    const overlapEnd   = effectiveSickEnd < vac.end_date ? effectiveSickEnd : vac.end_date

    const d   = new Date(overlapStart + 'T12:00:00')
    const end = new Date(overlapEnd   + 'T12:00:00')

    while (d <= end) {
      const dow = d.getDay()
      const ds  = toLocalDateStr(d)
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) returnedDays++
      d.setDate(d.getDate() + 1)
    }
  }

  return {
    overlaps: returnedDays > 0,
    returnedDays,
    affectedVacations: affected,
    message: returnedDays > 0
      ? `✅ §9 BUrlG: ${returnedDays} Urlaubstag${returnedDays > 1 ? 'e werden' : ' wird'} zurückgegeben, da die Krankmeldung in den genehmigten Urlaub fällt.`
      : null,
  }
}

export function calculateRequestedDays(startDate, endDate, holidays = []) {
  const holidaySet = new Set((holidays || []).map(h => h.date))
  return countWorkdays(startDate, endDate, holidaySet)
}

export function canRequestVacation(requestedDays, balance) {
  if (requestedDays <= 0)               return { ok: false, reason: 'Keine gültigen Arbeitstage im Zeitraum.' }
  if (requestedDays > balance.remaining) return { ok: false, reason: `Nicht genug Resturlaub. Verfügbar: ${balance.remaining} Tage, beantragt: ${requestedDays} Tage.` }
  return { ok: true, reason: null }
}
