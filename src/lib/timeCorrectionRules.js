// Zeitkorrektur-Regeln im Browser (Migration 37) – reine Vorprüfung, maßgeblich prüft die DB (admin_save_time_entry).

// Wanduhrzeit Europe/Berlin (Datum + HH:MM) → Epoch-ms, unabhängig von der Zeitzone des Geräts (Sommer-/Winterzeit
// korrekt; eine in der Umstellung nicht existierende Uhrzeit wird wie in Postgres nach vorn verschoben).
const BERLIN_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const berlinOffsetMs = ms => {
  const p = Object.fromEntries(BERLIN_PARTS.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}
export function wallTimeToMs(dateStr, hhmm, addDays = 0) {
  const [y, m, d] = String(dateStr).split('-').map(Number), [h, mi] = String(hhmm).split(':').map(Number)
  const local = Date.UTC(y, m - 1, d + addDays, h, mi)
  const first = local - berlinOffsetMs(local)
  return local - berlinOffsetMs(first)
}

// Zeitkorrektur = Vergangenheit (Migration 37): Beginn/Ende höchstens 1 Minute in der Zukunft (wie die DB).
// Ende vor Beginn = Folgetag. → 'future' | null (die DB prüft maßgeblich, auch Überschneidungen)
export function correctionFutureProblem({ date, inT, outT, nowMs = Date.now(), toleranceMs = 60000 }) {
  if (!date || !inT) return null
  const inMs = wallTimeToMs(date, inT)
  const outMs = outT ? wallTimeToMs(date, outT, outT < inT ? 1 : 0) : null
  return inMs > nowMs + toleranceMs || (outMs != null && outMs > nowMs + toleranceMs) ? 'future' : null
}
