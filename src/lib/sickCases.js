// Krankheitsfälle Phase A (Migration 33) – reine Vorschlagslogik, ohne Datenbank, ohne Lohnwirkung.
// Ebene 1 „zeitlich zusammenhängend“ wird hier nur BERECHNET und als Vorschlag angezeigt; gespeichert wird erst,
// was ein Admin bewusst bestätigt (Ebene 2: Fall, Ebene 3: Beziehung). Der Vorschlag sagt nichts über die Krankheit
// aus. Das eAU-Merkmal (Erst-/Folgemeldung) fließt bewusst NICHT ein.
//
// Arbeitsfreie Tage: Schichtplan zuerst (Café arbeitet auch am Wochenende – Sa/So sind nie pauschal frei).
// Nur wenn für die Person im Umfeld der Lücke gar kein Schichtplan gepflegt ist, gilt der Kalender als Rückfall –
// und der kennt nur gesetzliche Feiertage als sicher arbeitsfrei. Urlaub in der Lücke = „prüfen“.

export const GAP = Object.freeze({
  OVERLAP: 'overlap',              // überschneidet sich / vorherige Meldung noch offen
  CONTIGUOUS: 'contiguous',        // beginnt am Tag nach dem Ende
  NON_WORKING: 'non_working_gap',  // nur arbeitsfreie Tage dazwischen
  WORKED: 'worked_gap',            // dazwischen nachweislich gearbeitet → getrennt
  UNCLEAR: 'unclear_gap',          // Arbeitstag ohne Buchung, Urlaub oder unbekannt → Admin prüft
})
export const SAME_CASE_GAPS = Object.freeze([GAP.OVERLAP, GAP.CONTIGUOUS, GAP.NON_WORKING])
export const RELATIONS = Object.freeze(['unknown', 'new_illness', 'same_illness'])
export const RELATION_BASES = Object.freeze(['kk_auskunft', 'lohnbuero', 'arbeitnehmer', 'sonstiges'])
export const EAU_KINDS = Object.freeze(['erst', 'folge'])
export const REASON_MIN = 5, REASON_MAX = 200
export const SCHEDULE_WINDOW_DAYS = 28   // Schichtplan gilt als gepflegt, wenn die Person in diesem Umfeld Schichten hat

const day = s => new Date(`${s}T12:00:00Z`)
export const addDays = (s, n) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out }

/**
 * Zusammenhang zweier Krankmeldungen derselben Person (a beginnt nicht nach b).
 * ctx: { shiftDates:Set, workedDates:Set, vacationDates:Set, holidays:Set } – Datumswerte 'YYYY-MM-DD' dieser Person
 * Rückgabe: { gap, basis: 'schedule'|'calendar'|null, days: [...] }
 */
export function classifyGap(a, b, ctx) {
  const aEnd = a.end_date || null
  if (!aEnd || b.start_date <= aEnd) return { gap: GAP.OVERLAP, basis: null, days: [] }
  const from = addDays(aEnd, 1), to = addDays(b.start_date, -1)
  if (from > to) return { gap: GAP.CONTIGUOUS, basis: null, days: [] }
  const days = range(from, to)
  if (days.some(d => ctx.workedDates?.has(d))) return { gap: GAP.WORKED, basis: null, days }
  const winFrom = addDays(a.start_date, -SCHEDULE_WINDOW_DAYS), winTo = addDays(b.start_date, SCHEDULE_WINDOW_DAYS)
  const scheduleUsable = [...(ctx.shiftDates || [])].some(d => d >= winFrom && d <= winTo)
  const nonWorking = d => !ctx.vacationDates?.has(d) && (scheduleUsable ? !ctx.shiftDates.has(d) : !!ctx.holidays?.has(d))
  return { gap: days.every(nonWorking) ? GAP.NON_WORKING : GAP.UNCLEAR, basis: scheduleUsable ? 'schedule' : 'calendar', days }
}

/**
 * Vorschläge für NICHT zugeordnete Krankmeldungen einer Person: Ketten aus zusammenhängenden Meldungen.
 * Bereits bestätigten Fällen zugeordnete Meldungen (case_id) werden nicht angefasst.
 * Rückgabe: [{ records:[...], links:[{ from, to, gap, basis }], review:[{ from, to, gap, basis }] }]
 */
export function suggestGroups(records, ctx) {
  const open = (records || []).filter(r => !r.case_id).slice().sort((x, y) => x.start_date.localeCompare(y.start_date) || String(x.id).localeCompare(String(y.id)))
  const groups = []
  for (const r of open) {
    const g = groups[groups.length - 1]
    let review = []
    if (g) {
      // gegen das bisher späteste Ende der Gruppe vergleichen (offene Meldung = läuft noch)
      const reach = g.records.some(x => !x.end_date) ? { start_date: g.records[0].start_date, end_date: null }
        : { start_date: g.records[0].start_date, end_date: g.records.map(x => x.end_date).sort().pop() }
      const c = classifyGap(reach, r, ctx)
      const link = { from: g.records[g.records.length - 1].id, to: r.id, gap: c.gap, basis: c.basis }
      if (SAME_CASE_GAPS.includes(c.gap)) { g.records.push(r); g.links.push(link); continue }
      if (c.gap === GAP.UNCLEAR) review = [link]   // Prüfhinweis an der späteren Meldung (deren Zuordnung offen ist)
    }
    groups.push({ records: [r], links: [], review })
  }
  return groups
}

// Kontext einer Person aus geladenen Daten (Schichten, Arbeitszeiten, genehmigter Urlaub, Feiertage)
export function buildContext(employeeId, { shifts = [], timeEntries = [], vacations = [], holidays = [] }) {
  const vacationDates = new Set()
  for (const v of vacations) if (v.employee_id === employeeId && v.status === 'approved') for (const d of range(v.start_date, v.end_date)) vacationDates.add(d)
  return {
    shiftDates: new Set(shifts.filter(s => s.employee_id === employeeId).map(s => s.date)),
    workedDates: new Set(timeEntries.filter(t => t.employee_id === employeeId).map(t => t.date)),
    vacationDates,
    holidays: new Set(holidays.map(h => h.date)),
  }
}

// Begründung der Fortsetzungs-/Neu-Entscheidung: kurz, Pflicht – medizinische Details gehören nicht hinein
export function reasonProblem(reason) {
  const r = String(reason ?? '').trim()
  return r.length < REASON_MIN || r.length > REASON_MAX ? 'sickCase.reasonLength' : null
}
