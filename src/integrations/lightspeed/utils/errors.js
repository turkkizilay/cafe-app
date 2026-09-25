import { message as appMessage, localizeMessage, errorMessage } from '../../../i18n/runtime.js'
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
    super(localizeMessage(message))
    this.displayMessage = message
    this.name       = 'LightspeedError'
    this.code       = code
    this.statusCode = statusCode
    this.retryable  = retryable
  }
}

export class RateLimitError extends LightspeedError {
  /** @param {number} retryAfterSeconds */
  constructor(retryAfterSeconds = 60) {
    super('RATE_LIMIT', appMessage("ui.b47120833029", { p1: (retryAfterSeconds) }), 429, true)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class TokenExpiredError extends LightspeedError {
  constructor() {
    super('TOKEN_EXPIRED', appMessage("ui.0c481a4f4538"), 401, false)
  }
}

export class ConnectionError extends LightspeedError {
  constructor() {
    super('CONNECTION', appMessage("ui.c81e0614902e"), 0, true)
  }
}

export class SyncConflictError extends LightspeedError {
  /** @param {string} resourceId */
  constructor(resourceId) {
    super('SYNC_CONFLICT', appMessage("ui.dbf8631425e1", { p1: (resourceId) }), 409, false)
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
    return appMessage("ui.e211fd758eb5", { p1: (err.retryAfterSeconds) })
  if (err instanceof TokenExpiredError)
    return appMessage("ui.addc36689a46")
  if (err instanceof ConnectionError)
    return appMessage("ui.76ebc16b73ab")
  if (err instanceof LightspeedError)
    return errorMessage(err)
  return appMessage("ui.9de80b5858ca")
}
