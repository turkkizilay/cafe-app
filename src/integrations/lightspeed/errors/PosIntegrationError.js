/**
 * POS Integration — Fehlerklassen
 */

export class PosIntegrationError extends Error {
  /**
   * @param {import('../types/pos.js').PosErrorCode} code
   * @param {string}  message         - Klare Deutsche Fehlermeldung
   * @param {boolean} retryable       - Automatisch wiederholbar?
   * @param {number}  [retryAfterMs]  - Bei RATE_LIMITED: wann retry?
   */
  constructor(code, message, retryable = false, retryAfterMs = null) {
    super(message)
    this.name         = 'PosIntegrationError'
    this.code         = code
    this.retryable    = retryable
    this.retryAfterMs = retryAfterMs
  }
}

/** Bestimmt ob ein Fehler automatisch wiederholt werden soll */
export function isRetryableError(err) {
  if (err instanceof PosIntegrationError) return err.retryable
  // Netzwerk-Fehler
  if (err.name === 'AbortError')   return true
  if (err.name === 'NetworkError') return true
  return false
}

/** Gibt benutzerfreundliche deutsche Meldung zurück */
export function toPosUserMessage(err) {
  if (!(err instanceof PosIntegrationError)) {
    return 'Ein unbekannter Fehler ist aufgetreten. Bitte erneut versuchen.'
  }
  const messages = {
    AUTHENTICATION_FAILED:    'Lightspeed-Authentifizierung fehlgeschlagen. Bitte neu verbinden.',
    AUTHORIZATION_FAILED:     'Keine Berechtigung für diese Lightspeed-Ressource.',
    TOKEN_REFRESH_FAILED:     'Session-Erneuerung fehlgeschlagen. Bitte neu anmelden.',
    INVALID_SCOPE:            'Unzureichende API-Berechtigungen. Bitte Lightspeed-Zugriff prüfen.',
    CONNECTION_NOT_FOUND:     'Keine aktive Lightspeed-Verbindung gefunden.',
    LOCATION_NOT_MAPPED:      'Kein Lightspeed-Standort zugeordnet. Bitte in Einstellungen konfigurieren.',
    VALIDATION_FAILED:        'Ungültige Daten von Lightspeed empfangen.',
    RATE_LIMITED:             `API-Limit erreicht. Bitte warten und erneut versuchen.`,
    PROVIDER_TIMEOUT:         'Lightspeed antwortet nicht. Bitte später erneut versuchen.',
    PROVIDER_UNAVAILABLE:     'Lightspeed ist derzeit nicht erreichbar.',
    MAPPING_CONFLICT:         'Zuordnungskonflikt erkannt. Bitte manuell prüfen.',
    DATABASE_ERROR:           'Datenbankfehler beim Speichern der Synchronisation.',
    SYNC_ALREADY_RUNNING:     'Eine Synchronisation läuft bereits. Bitte warten.',
    UNKNOWN_PROVIDER_ERROR:   'Unbekannter Lightspeed-Fehler. Bitte Support kontaktieren.',
  }
  return messages[err.code] || err.message
}
