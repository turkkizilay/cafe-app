// Stempelseite: expliziter Anzeige-Zustand (Resilience F2). Rein – ohne React, testbar.
// Nur Anzeige: Ob gestempelt werden darf, entscheidet ausschließlich der Server (Unique-Index „ein offener Eintrag“,
// Trigger, start_break/end_break, clock_*_remote). Hier geht es darum, einen UNBEKANNTEN Stand nie als „ausgestempelt“
// zu zeigen – sonst glaubt jemand, nicht eingestempelt zu sein, und geht ohne Ausstempeln.
//
//   LOADING   – noch kein bestätigter Stand (erste Ladung)
//   WORKING   – offener Eintrag bestätigt, keine laufende Pause (Pausenstand ggf. separat unbekannt → breakUi 'error')
//   ON_BREAK  – offener Eintrag bestätigt, laufende Pause
//   OFF_CLOCK – Abfrage ERFOLGREICH und kein offener Eintrag
//   UNKNOWN   – entscheidende Abfrage fehlgeschlagen (offener Eintrag oder Mitarbeiterdatensatz)
export const CLOCK_STATUS = Object.freeze(['LOADING', 'WORKING', 'ON_BREAK', 'OFF_CLOCK', 'UNKNOWN'])

// Ergebnis einer Ladung: nur wenn BEIDE entscheidenden Abfragen geantwortet haben, ist der Stand bestätigt.
export function attendanceLoadState({ employeeError, openEntryError }) {
  return employeeError || openEntryError ? 'error' : 'ok'
}

// load: 'loading' | 'ok' | 'error' · openEntry: zuletzt bestätigter offener Eintrag · breakUi: breakUiState(...) aus workHours
export function deriveClockStatus({ load, openEntry, breakUi }) {
  if (load === 'error') return 'UNKNOWN'
  if (load !== 'ok') return 'LOADING'
  if (!openEntry) return 'OFF_CLOCK'
  return breakUi === 'running' ? 'ON_BREAK' : 'WORKING'
}
