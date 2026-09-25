import { t as tr, getIntlLocale, message as appMessage } from '../../../i18n/runtime.js'
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
    return appMessage("ui.05c68a92c52a")
  }
  const messages = {
    AUTHENTICATION_FAILED:    appMessage("ui.e6628f0c7e0a"),
    AUTHORIZATION_FAILED:     appMessage("ui.e6100cb6c74e"),
    TOKEN_REFRESH_FAILED:     appMessage("ui.4b426c6db322"),
    INVALID_SCOPE:            appMessage("ui.27892fab4cc8"),
    CONNECTION_NOT_FOUND:     appMessage("ui.2d1d6cd76471"),
    LOCATION_NOT_MAPPED:      appMessage("ui.824d1ffff867"),
    VALIDATION_FAILED:        appMessage("ui.bdbf13c08933"),
    RATE_LIMITED:             appMessage("ui.affe6e4b3f73"),
    PROVIDER_TIMEOUT:         appMessage("ui.fed1774817f3"),
    PROVIDER_UNAVAILABLE:     appMessage("ui.1cf85c8b2da1"),
    MAPPING_CONFLICT:         appMessage("ui.029eb98d4faf"),
    DATABASE_ERROR:           appMessage("ui.35525c825ea2"),
    SYNC_ALREADY_RUNNING:     appMessage("ui.55c9ae54d48b"),
    UNKNOWN_PROVIDER_ERROR:   appMessage("ui.ed88a8926fcf"),
  }
  return messages[err.code] || err.message
}
