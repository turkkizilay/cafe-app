/**
 * Lightspeed — In-Memory Cache mit TTL
 *
 * Verhindert unnötige API-Aufrufe bei mehrfachen Abfragen.
 * Kein localStorage. Wird bei Page-Reload geleert.
 * Für persistenten Cache: Supabase-Tabelle nutzen.
 */

class TTLCache {
  constructor() {
    this._store = new Map()
  }

  /** @param {string} key @param {any} value @param {number} ttlMs */
  set(key, value, ttlMs) {
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  /** @param {string} key @returns {any|null} */
  get(key) {
    const entry = this._store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) { this._store.delete(key); return null }
    return entry.value
  }

  /** @param {string} key */
  delete(key) { this._store.delete(key) }

  /** Alle Einträge mit Präfix löschen (z.B. nach Sync) */
  invalidate(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key)
    }
  }

  clear() { this._store.clear() }

  get size() { return this._store.size }
}

export const cache = new TTLCache()
