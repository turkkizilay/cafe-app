// Schichtankündigung auf dem Dashboard (Bugfix 12.10.2026). Rein, testbar, ohne Anfragen.
// Hintergrund: Früher war die „nächste Schicht“ einfach die erste ab heute 00:00 – auch eine heute schon beendete.
// Für einen Beginn in der Vergangenheit lieferte timeUntil() null, und der Ersatztext machte daraus „startet gleich“
// (gemeldet: Sonntag 11.10.2026, 22:50 Uhr, Schicht 08:30–18:00).
// Regeln:
//   • gewählt wird die erste Schicht, deren Ende noch nicht erreicht ist (beendete werden übersprungen)
//   • Phasen: 'later' (> 60 min) · 'soon' (60–15 min) · 'imminent' (15–0 min) · 'running' (Beginn ≤ jetzt < Ende)
//   • 'none' = keine offene Schicht; 'unknown' = alle geladenen (limit) beendet → es kann eine spätere geben → neutral
//   • Zeitzone fest Europe/Berlin (Schichtzeiten sind Berliner Wandzeit), Sommer-/Winterzeit über Intl
//   • Nachtschicht: Ende ≤ Beginn → Ende am Folgetag
export const SHIFT_TZ = 'Europe/Berlin'
export const SOON_MIN = 60
export const IMMINENT_MIN = 15

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHIFT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

// Berliner Wandzeit eines Zeitpunkts → { date: 'YYYY-MM-DD', wall: Minuten (fortlaufend, mit Sekundenanteil – „in 2h 10min“
// rundet so wie früher ab; nur zum Vergleichen) }
export function berlinNow(now = new Date()) {
  const p = Object.fromEntries(parts.formatToParts(now).map(x => [x.type, x.value]))
  const date = `${p.year}-${p.month}-${p.day}`
  return { date, wall: wallMinutes(date, `${p.hour}:${p.minute}`) + (Number(p.second) + (now.getTime() % 1000) / 1000) / 60 }
}

// Datum + Uhrzeit (Wandzeit) → fortlaufende Minuten. Absichtlich ohne Zeitzonen-Umrechnung: verglichen wird Berliner
// Wandzeit mit Berliner Wandzeit. In der Nacht der Zeitumstellung kann ein Abstand über 02:00–03:00 um 60 min abweichen.
export function wallMinutes(date, time) {
  const [y, m, d] = String(date).split('-').map(Number)
  const [hh, mm] = String(time || '').slice(0, 5).split(':').map(Number)
  if (![y, m, d, hh, mm].every(Number.isFinite)) return NaN
  return Date.UTC(y, m - 1, d, hh, mm) / 60000
}

export function shiftWindow(shift) {
  const start = wallMinutes(shift?.date, shift?.start_time)
  let end = wallMinutes(shift?.date, shift?.end_time)
  if (Number.isFinite(start) && Number.isFinite(end) && end <= start) end += 24 * 60   // über Mitternacht
  return { start, end }
}

// shifts: eigene Schichten ab heute, sortiert (Datum, Beginn) – wie geladen. limit: Anzahl der geladenen Zeilen.
// → { shift, phase, startsIn (min, nur vor Beginn), today (Berliner Datum), isToday }
export function announceShift(shifts, now = new Date(), { limit = 3 } = {}) {
  const { date: today, wall } = berlinNow(now)
  const list = Array.isArray(shifts) ? shifts : []
  for (const shift of list) {
    const { start, end } = shiftWindow(shift)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= wall) continue   // ungültig oder beendet
    const startsIn = start - wall
    const phase = startsIn <= 0 ? 'running' : startsIn <= IMMINENT_MIN ? 'imminent' : startsIn <= SOON_MIN ? 'soon' : 'later'
    return { shift, phase, startsIn: startsIn > 0 ? startsIn : 0, today, isToday: shift.date === today }
  }
  return { shift: null, phase: list.length >= limit ? 'unknown' : 'none', startsIn: null, today, isToday: false }
}
