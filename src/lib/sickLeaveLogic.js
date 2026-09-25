import { t as tr, getIntlLocale, message as appMessage, formatParam } from '../i18n/runtime.js'
/**
 * Café Buur — Krankmeldungslogik (Pilotversion)
 *
 * RECHTLICHER HINWEIS:
 * Diese Logik ist ein Managementunterstützungs-Tool, keine rechtsverbindliche Entscheidung.
 * Die App kennt keine Diagnosen. Steuerberaterin / Krankenkasse bei Unklarheiten konsultieren.
 *
 * Rechtsgrundlage: §3 EFZG — Lohnfortzahlung bis 42 Kalendertage pro Krankheitsfall
 * §9 BUrlG — Erkrankung im Urlaub: nachgewiesene Krankheitstage werden nicht auf
 *             Jahresurlaub angerechnet. Die App markiert solche Fälle zur manuellen Prüfung.
 */

export const LOHNFORTZAHLUNG_TAGE = 42  // §3 EFZG

const FOLGEERKRANKUNG_FENSTER = 28  // Tage — Hinweis auf mögliche Folgeerkrankung

// ── Hilfsfunktionen ────────────────────────────────────────────────────────
function toDate(s) {
  if (!s) return null
  return new Date(s + 'T00:00:00')
}
function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000)
}
export function addDays(d, n) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

// ── Hauptfunktion: Krankmeldungen → AU-Fälle ───────────────────────────────
/**
 * Gruppiert Krankmeldungen ZUERST nach Mitarbeiter, dann nach Zeitraum-Nähe.
 *
 * Regeln innerhalb eines Mitarbeiters:
 * 1. Eine Meldung beginnt während eine andere noch offen ist → gleicher AU-Fall
 * 2. Neue Meldung beginnt ≤ 1 Tag nach Ende der vorigen → gleicher Fall (Folgebescheinigung)
 * 3. Abstand 2–28 Tage → separate Fälle, Hinweis "Folgeerkrankung prüfen"
 * 4. Abstand > 28 Tage → klar getrennter neuer Fall
 *
 * WICHTIG: Keine automatische Entscheidung. Nur Hinweise für das Management.
 */
export function groupSickLeavesIntoCases(sickLeaves) {
  if (!sickLeaves || sickLeaves.length === 0) return []

  // SCHRITT 1: Nach Mitarbeiter trennen — kritisch, sonst Datenvermischung
  const byEmployee = {}
  for (const leave of sickLeaves) {
    const eid = leave.employee_id
    if (!byEmployee[eid]) byEmployee[eid] = []
    byEmployee[eid].push(leave)
  }

  const allCases = []

  for (const empLeaves of Object.values(byEmployee)) {
    const sorted = [...empLeaves].sort(
      (a, b) => toDate(a.start_date) - toDate(b.start_date)
    )

    const cases = []

    for (const leave of sorted) {
      const leaveStart = toDate(leave.start_date)

      let matched = null

      for (const sc of cases) {
        const caseEnd  = sc.end_date ? toDate(sc.end_date) : null
        const isOpen   = !caseEnd
        const gapDays  = caseEnd ? daysBetween(caseEnd, leaveStart) : -1

        if (isOpen || gapDays <= 1) {
          matched = sc
          break
        }
      }

      if (matched) {
        matched.leaves.push(leave)

        // Overlap-Typ präzisieren
        const matchedEnd = matched.end_date ? toDate(matched.end_date) : null
        if (!matchedEnd) {
          // Case noch offen → Folgebescheinigung oder Duplikat
          const isSameDay = toDate(matched.start_date).getTime() === leaveStart.getTime()
          matched.overlapType = isSameDay ? 'duplicate' : 'continuation'
        } else {
          const dayAfter = new Date(matchedEnd.getTime() + 86400000)
          matched.overlapType = leaveStart.getTime() === dayAfter.getTime()
            ? 'continuation'
            : 'overlap'
        }
        matched.hasOverlap = true

        if (!leave.end_date) {
          matched.end_date = null
        } else if (matched.end_date && toDate(leave.end_date) > toDate(matched.end_date)) {
          matched.end_date = leave.end_date
        }
      } else {
        const lastCase = cases[cases.length - 1]
        let followUpHint = false
        if (lastCase?.end_date) {
          const gap = daysBetween(toDate(lastCase.end_date), leaveStart)
          if (gap >= 2 && gap <= FOLGEERKRANKUNG_FENSTER) followUpHint = true
        }

        cases.push({
          id:           `case-${leave.id}`,
          employee_id:  leave.employee_id,
          employee:     leave.employees,
          start_date:   leave.start_date,
          end_date:     leave.end_date,
          leaves:       [leave],
          hasOverlap:   false,
          overlapType:  null,
          followUpHint,
        })
      }
    }

    allCases.push(...cases)
  }

  return allCases
}

// ── Status-Berechnung mit Prioritätslogik ──────────────────────────────────
/**
 * Berechnet den Status eines AU-Falls nach Priorität.
 *
 * Prioritäten (höchste gewinnt):
 * P1  health_insurance_review  — Tag 43+ (Krankenkasse)
 * P2  continued_pay_ending_soon — Tag 35–42 (Lohnfortzahlung endet bald)
 * P3  attest_missing           — Attest fehlt (mindestens eine Meldung)
 * P4  overlap_review           — Duplicate/unlogische Überschneidung
 * P5  followup_review          — Fortsetzung ohne alle Atteste
 * P6  documented               — Alles dokumentiert, kein Handlungsbedarf
 * P7  closed                   — Fall beendet
 */
export function calculateContinuedPayStatus(sickCase) {
  const start   = toDate(sickCase.start_date)
  const today   = new Date(); today.setHours(0,0,0,0)
  const isOpen  = !sickCase.end_date
  const caseEnd = sickCase.end_date ? toDate(sickCase.end_date) : null
  const refDate = isOpen ? today : caseEnd
  const days    = daysBetween(start, refDate)

  // Beendet + negativ → closed
  if (!isOpen && days < 0) return 'closed'

  // P1: Tag 43+ → Krankenkasse
  if (days > LOHNFORTZAHLUNG_TAGE) return 'health_insurance_review'

  // P2: Tag 35–42, Fall noch offen → Warnung
  if (isOpen && days >= 34) return 'continued_pay_ending_soon'

  // Attest-Status: mindestens eine laufende/offene Meldung ohne Attest?
  const anyMissingAttest = sickCase.leaves.some(l => !l.certificate_received)
  const allAttested      = !anyMissingAttest

  // P3: Attest fehlt
  if (anyMissingAttest) return 'attest_missing'

  // Beendet und attestiert → closed
  if (!isOpen && allAttested) return 'closed'

  // P4: Duplicate/unlogische Überschneidung → Prüfung nötig
  if (sickCase.hasOverlap && sickCase.overlapType === 'duplicate') return 'overlap_review'
  if (sickCase.hasOverlap && sickCase.overlapType === 'overlap')   return 'overlap_review'

  // P5+P6: Fortsetzung
  if (sickCase.hasOverlap && sickCase.overlapType === 'continuation') {
    // Alle attestiert → dokumentiert, kein Handlungsbedarf
    return allAttested ? 'documented' : 'followup_review'
  }

  // P6: Normaler laufender Fall, alles dokumentiert
  return allAttested ? 'documented' : 'employer_continued_pay'
}

// ── Warnungen pro AU-Fall ───────────────────────────────────────────────────
export function getSickCaseWarnings(sickCase) {
  const warnings = []
  const start    = toDate(sickCase.start_date)
  const today    = new Date(); today.setHours(0,0,0,0)
  const isOpen   = !sickCase.end_date
  const payEnd   = addDays(start, LOHNFORTZAHLUNG_TAGE)
  const daysInto = daysBetween(start, today)
  const n        = sickCase.leaves.length
  const allAttested = sickCase.leaves.every(l => l.certificate_received)

  // Duplicate overlap — echtes Problem
  if (sickCase.hasOverlap && sickCase.overlapType === 'duplicate') {
    warnings.push({ level:'warn',
      text: appMessage("ui.906ad4c85942", { p1: (n) }) })
  }

  // Überschneidung (kein Duplikat) — unlogischer Zeitraum
  if (sickCase.hasOverlap && sickCase.overlapType === 'overlap') {
    warnings.push({ level:'warn',
      text: appMessage("ui.6751f52ec91e", { p1: (n) }) })
  }

  // Fortsetzung — neutral informieren, kein Alarm wenn attestiert
  if (sickCase.hasOverlap && sickCase.overlapType === 'continuation') {
    if (allAttested) {
      warnings.push({ level:'info',
        text: appMessage("ui.5230d8be42ea", { p1: (n) }) })
    } else {
      warnings.push({ level:'warn',
        text: appMessage("ui.36bb374ace39", { p1: (n) }) })
    }
  }

  // Folgeerkrankungshinweis
  if (sickCase.followUpHint) {
    warnings.push({ level:'info',
      text: appMessage("ui.9c49163cf769") })
  }

  // Lohnfortzahlung endet bald (Tag 35–42)
  if (isOpen && daysInto >= 34 && daysInto <= LOHNFORTZAHLUNG_TAGE) {
    const daysLeft = LOHNFORTZAHLUNG_TAGE - daysInto
    warnings.push({ level:'warn',
      text: appMessage("sick.payEnding", { count: (daysLeft), date: (formatParam("date", payEnd, {day:'2-digit',month:'2-digit',year:'numeric'})) }) })
  }

  // Ab Tag 43
  if (isOpen && daysInto > LOHNFORTZAHLUNG_TAGE) {
    warnings.push({ level:'error',
      text: appMessage("ui.4a4ce5ad3fd8", { p1: (formatParam("date", payEnd, {day:'2-digit',month:'2-digit',year:'numeric'})) }) })
  }

  return warnings
}

// ── Lohnfortzahlungs-Enddatum ───────────────────────────────────────────────
export function getContinuedPayEnd(sickCase) {
  return addDays(toDate(sickCase.start_date), LOHNFORTZAHLUNG_TAGE)
}

// ── Status-Beschriftungen ───────────────────────────────────────────────────
export const SICK_STATUS_LABELS = {
  employer_continued_pay:    { get text() { return tr("ui.deb6784a5e15") },    color: '#2563EB', bg: '#EFF6FF' },
  continued_pay_ending_soon: { get text() { return tr("ui.e44799a673a8") },     color: '#D97706', bg: '#FFFBEB' },
  health_insurance_review:   { get text() { return tr("ui.0ba815b3593f") },            color: '#DC2626', bg: '#FEF2F2' },
  attest_missing:            { get text() { return tr("ui.24e80f20f406") },                   color: '#DC2626', bg: '#FEF2F2' },
  overlap_review:            { get text() { return tr("ui.b163a8841aee") },          color: '#7C3AED', bg: '#F5F3FF' },
  followup_review:           { get text() { return tr("ui.4b0d1135546d") },      color: '#D97706', bg: '#FFFBEB' },
  documented:                { get text() { return tr("ui.26e83d19da95") },           color: '#059669', bg: '#ECFDF5' },
  closed:                    { get text() { return tr("ui.38ee859a969e") },                  color: '#6B7280', bg: '#F9FAFB' },
}

// ── Handlungsbedarf? (für Dashboard-Zählung) ───────────────────────────────
/**
 * Gibt true zurück wenn der AU-Fall echten Management-Handlungsbedarf hat.
 * 'documented' und 'closed' zählen NICHT als offener Handlungsbedarf.
 */
export function caseRequiresAction(sickCase) {
  const status = calculateContinuedPayStatus(sickCase)
  return !['documented', 'closed', 'employer_continued_pay'].includes(status)
}

// ── Zentraler Input-Validator ──────────────────────────────────────────────
/**
 * Validiert eine neue Krankmeldung vor dem Speichern.
 * Unterscheidet zwischen Mitarbeiter- und Admin/Manager-Rechten.
 *
 * PILOT-HINWEIS: Rückwirkende Grenze = 3 Tage für Mitarbeiter.
 * Zukunft: max. morgen für Mitarbeiter, beliebig für Admin.
 * Vor Vollbetrieb: Grenzwerte mit Management und Steuerberaterin abstimmen.
 *
 * @returns { valid: bool, severity: 'error'|'warn'|'info', message: string, reasonCode: string }
 */
export function validateSickLeaveInput({ startDate, endDate, role, today }) {
  if (!startDate) {
    return { valid: false, severity: 'error', reasonCode: 'no_start',
      message: appMessage("ui.9369039d0d2f") }
  }

  const todayDate = new Date(today + 'T00:00:00')
  const start     = new Date(startDate + 'T00:00:00')
  const daysAgo   = Math.floor((todayDate - start) / 86400000) // positiv = Vergangenheit
  const isAdmin   = role === 'admin' || role === 'manager'

  // ── Zukunft ───────────────────────────────────────────────────────────────
  if (daysAgo < 0) {
    const daysAhead = -daysAgo
    if (isAdmin) {
      // Admin darf Zukunft eingeben (geplante OP, Folge-AU)
      return { valid: true, severity: 'info', reasonCode: 'future_admin',
        message: appMessage("ui.339302098174") }
    }
    if (daysAhead === 1) {
      // Morgen: erlaubt mit Hinweis
      return { valid: true, severity: 'info', reasonCode: 'future_tomorrow',
        message: appMessage("ui.fb5a413b1fdf") }
    }
    // Übermorgen oder später: für Mitarbeiter blockiert
    return { valid: false, severity: 'error', reasonCode: 'future_too_far',
      message: appMessage("ui.97c73373e89b") }
  }

  // ── Vergangenheit ─────────────────────────────────────────────────────────
  if (daysAgo > 90) {
    return { valid: false, severity: 'error', reasonCode: 'past_unrealistic',
      message: appMessage("ui.003fb52c87f0", { p1: (daysAgo) }) }
  }

  if (!isAdmin && daysAgo > 3) {
    return { valid: false, severity: 'error', reasonCode: 'past_too_far',
      message: appMessage("ui.800e6189521d", { p1: (daysAgo) }) }
  }

  if (!isAdmin && daysAgo > 1) {
    return { valid: true, severity: 'warn', reasonCode: 'past_warn',
      message: appMessage("ui.fe6c4e6742b2", { p1: (daysAgo) }) }
  }

  // ── Enddatum ──────────────────────────────────────────────────────────────
  if (endDate) {
    const end = new Date(endDate + 'T00:00:00')
    if (end < start) {
      return { valid: false, severity: 'error', reasonCode: 'end_before_start',
        message: appMessage("ui.810480dc268b") }
    }
    const durationDays = Math.floor((end - start) / 86400000)
    if (!isAdmin && durationDays > 42) {
      return { valid: true, severity: 'warn', reasonCode: 'long_duration',
        message: appMessage("ui.f6907f216ac9", { p1: (durationDays) }) }
    }
  }

  return { valid: true, severity: 'info', reasonCode: 'ok', message: '' }
}
