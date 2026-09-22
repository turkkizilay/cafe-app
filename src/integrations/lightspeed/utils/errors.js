/**
 * Lightspeed — Fehlerklassen
 *
 * Alle Lightspeed-spezifischen Fehler erben von LightspeedError.
 * So kann die App gezielt auf Lightspeed-Fehler reagieren ohne
 * interne App-Fehler zu verwechseln.
 */

export class LightspeedError extends Error {
  /**
   * @param {string}  code       - Maschinenlesbarer Code
   * @param {string}  message    - Deutsche UI-Nachricht
   * @param {number}  statusCode - HTTP Status
   * @param {boolean} retryable  - Kann automatisch wiederholt werden?
   */
  constructor(code, message, statusCode = 0, retryable = false) {
    super(message)
    this.name       = 'LightspeedError'
    this.code       = code
    this.statusCode = statusCode
    this.retryable  = retryable
  }
}

export class RateLimitError extends LightspeedError {
  /** @param {number} retryAfterSeconds */
  constructor(retryAfterSeconds = 60) {
    super('RATE_LIMIT', `API-Limit erreicht. Bitte ${retryAfterSeconds}s warten.`, 429, true)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class TokenExpiredError extends LightspeedError {
  constructor() {
    super('TOKEN_EXPIRED', 'Lightspeed-Session abgelaufen. Bitte neu verbinden.', 401, false)
  }
}

export class ConnectionError extends LightspeedError {
  constructor() {
    super('CONNECTION', 'Keine Verbindung zu Lightspeed. Netzwerk prüfen.', 0, true)
  }
}

export class SyncConflictError extends LightspeedError {
  /** @param {string} resourceId */
  constructor(resourceId) {
    super('SYNC_CONFLICT', `Synchronisationskonflikt für Datensatz ${resourceId}`, 409, false)
    this.resourceId = resourceId
  }
}

/**
 * Gibt eine benutzerfreundliche deutsche Fehlermeldung zurück.
 * @param {Error} err
 * @returns {string}
 */
export function toLightspeedUserMessage(err) {
  if (err instanceof RateLimitError)
    return `Lightspeed API-Limit erreicht. Bitte ${err.retryAfterSeconds} Sekunden warten.`
  if (err instanceof TokenExpiredError)
    return 'Lightspeed-Verbindung abgelaufen. Bitte unter Einstellungen neu verbinden.'
  if (err instanceof ConnectionError)
    return 'Lightspeed nicht erreichbar. Internetverbindung und Kassensystem prüfen.'
  if (err instanceof LightspeedError)
    return err.message
  return 'Unbekannter Lightspeed-Fehler. Support kontaktieren.'
}
