// Stempeln außerhalb des Cafés (Migration 29) – reine Entscheidungslogik ohne Supabase-Abhängigkeit (testbar).
// Die Berechtigung prüft ausschließlich der Server; hier wird nur entschieden, ob die App den Bestätigungsdialog
// ANBIETET, und wie Server-Antworten zu verstehen sind (am HINT, nie am Fehlertext).

export const REMOTE_TIMEOUT_MS = 15000

/**
 * Ob die App Stempeln außerhalb anbietet.
 * 'none'     – nicht nötig (im Café erkannt, keine Prüfung eingerichtet) oder keine Manager-/Admin-Rolle
 * 'checking' – Standortprüfung läuft noch
 * 'outside'  – Standort BESTIMMT und außerhalb → Bestätigungsdialog anbieten
 * 'unknown'  – Standort nicht bestimmbar (GPS verweigert/nicht verfügbar, WLAN-Prüfung fehlgeschlagen)
 *              → NICHT wie „außerhalb“ behandeln, kein Remote-Angebot, Hinweis zeigen
 */
export function remoteClockState({ canManage, located, anyConfigured, stillChecking, netOnly, gpsConfigured, gpsStatus, netStatus }) {
  if (!canManage || located || !anyConfigured) return 'none'
  if (stillChecking) return 'checking'
  if (netOnly) return netStatus === 'no' ? 'outside' : 'unknown'
  if (gpsConfigured) return gpsStatus === 'too-far' ? 'outside' : 'unknown'
  // Nur WLAN eingerichtet (ohne GPS-Punkt): der Server bestimmt den Standort über die Verbindung
  return netStatus === 'no' ? 'outside' : 'unknown'
}

const HINTS = ['remote_not_allowed', 'inactive', 'location_unknown', 'confirmation_required', 'already_clocked_in', 'not_clocked_in']

/** Server-Antwort → Fehlerart. 'no_response' = unbekannt, ob gespeichert wurde → Serverstand neu laden. */
export function remoteErrorKind(result) {
  const error = result?.error
  if (!error) return null
  if (result.status === 0) return 'no_response'
  if (HINTS.includes(error.hint)) return error.hint
  if (error.code === '23505') return 'already_clocked_in'            // Unique-Index „ein offener Eintrag“
  if (['PGRST202', '42883'].includes(error.code)) return 'unavailable' // Migration 29 fehlt
  return 'error'
}
