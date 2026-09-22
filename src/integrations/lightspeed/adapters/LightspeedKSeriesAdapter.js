/**
 * Lightspeed Restaurant K-Series Adapter
 *
 * ════════════════════════════════════════════════════════════════════════
 * WICHTIG — API-VERIFIKATION AUSSTEHEND
 * ════════════════════════════════════════════════════════════════════════
 *
 * Lightspeed Restaurant K-Series verwendet eine eigene Cloud-API.
 * Vor der Live-Implementierung müssen folgende Punkte mit der offiziellen
 * Lightspeed K-Series API-Dokumentation abgeglichen werden:
 *
 * 1. OAuth-Endpunkte
 *    - Authorization URL: [MIT OFFIZ. DOCS VERIFIZIEREN]
 *    - Token URL:         [MIT OFFIZ. DOCS VERIFIZIEREN]
 *    - Verfügbare Scopes: [MIT OFFIZ. DOCS VERIFIZIEREN]
 *
 * 2. API-Basis-URL
 *    - Bekannt: api.lsretail.com oder api.lightspeedapp.com
 *    - Genaue Base URL für K-Series: [VERIFIZIEREN]
 *
 * 3. Endpunkte (alle als TO_VERIFY markiert)
 *    - GET /v2/businesses/{id}/locations
 *    - GET /v2/businesses/{id}/employees
 *    - GET /v2/businesses/{id}/sales
 *    - Genaue Pfade und Versionen: [MIT DOCS VERIFIZIEREN]
 *
 * 4. Webhooks
 *    - Verfügbare Events für K-Series: [VERIFIZIEREN]
 *    - Signaturmethode: [VERIFIZIEREN]
 *
 * 5. Rate Limits: [AUS API-ANTWORT-HEADERS LESEN]
 *
 * Zugang für Entwickler:
 *   https://developer.lightspeedhq.com/
 *   developer@lightspeedhq.com
 *
 * Bis zur Verifikation: Alle API-Calls laufen über Supabase Edge Functions.
 * Kein direkter Browser-Zugriff auf Lightspeed API.
 * ════════════════════════════════════════════════════════════════════════
 */

import { BasePosAdapter }    from './PosProviderAdapter.js'
import { PosIntegrationError } from '../errors/PosIntegrationError.js'

// ── Konfiguration (aus Supabase Edge Function — NICHT im Frontend) ─────────
// Diese Konstanten werden serverseitig in Edge Functions genutzt.
// Im Frontend sind sie nur als Referenz dokumentiert.

/**
 * Lightspeed K-Series API Konfiguration — verifiziert gegen offizielle Dokumentation
 * Quelle: https://api-portal.lsk.lightspeed.app/
 * Stand: 2026-07-12
 */
export const LIGHTSPEED_K_SERIES_CONFIG = {
  provider:   'lightspeed_k_series',

  // ── OAuth (VERIFIZIERT) ─────────────────────────────────────────────
  // Quelle: https://api-portal.lsk.lightspeed.app/quick-start/authentication/authorization-overview
  oauth: {
    authorizationUrl: {
      production: 'https://api.lsk.lightspeed.app/oauth/authorize',
      trial:      'https://api.trial.lsk.lightspeed.app/oauth/authorize',
    },
    tokenUrl: {
      production: 'https://api.lsk.lightspeed.app/oauth/token',
      trial:      'https://api.trial.lsk.lightspeed.app/oauth/token',
    },
    // WICHTIG: client_id + client_secret als Basic Auth Header (base64(id:secret))
    // NICHT als Form-Body-Parameter
    // Quelle: Authentication Tutorial — "base64 encoded and passed as the authorization header"
    tokenAuthMethod: 'BASIC_AUTH',

    // Scopes (VERIFIZIERT)
    // Quelle: https://api-portal.lsk.lightspeed.app/quick-start/authentication/access-scopes
    scopes: {
      financial:    'financial-api',    // Finanzdaten lesen
      orders:       'orders-api',       // Bestellungen + Zahlungen lesen/schreiben
      staff:        'staff-api',        // Mitarbeiter + Schichten lesen
      items:        'items',            // Produkte/Artikel lesen+schreiben
      offlineAccess:'offline_access',   // Längere Refresh Token Laufzeit
    },
    // Minimale Scopes für Café Buur Integration:
    requiredScopes: ['financial-api', 'orders-api', 'staff-api', 'offline_access'],
  },

  // ── API Basis-URLs (VERIFIZIERT) ────────────────────────────────────
  // Quelle: API docs + Authentication Tutorial
  apiBase: {
    production: 'https://api.lsk.lightspeed.app',
    trial:      'https://api.trial.lsk.lightspeed.app',
  },

  // ── Token Details (VERIFIZIERT) ─────────────────────────────────────
  // Quelle: Authentication Tutorial + Access Tokens Seite
  token: {
    expiresIn:           3599,      // Sekunden (~1h)
    refreshValidDays:    14,        // Refresh Token läuft nach 14 Tagen ab
    // Mit offline_access: Refresh Token läuft länger (genaue Dauer: laut Docs "longer life")
    refreshBufferMs:     5 * 60 * 1000,  // 5 Min vor Ablauf refreshen
  },

  // ── Pagination (VERIFIZIERT) ─────────────────────────────────────────
  // Quelle: Financial API Docs — HATEOAS _links mit nextPage URL
  pagination: {
    type:            'HATEOAS',      // nextPage URL in _links, KEIN page/offset Parameter
    maxPageSize:     1000,           // Financial API: pageSize max 1000
    defaultPageSize: 100,
  },

  // ── Endpunkte (NOCH AUSSTEHEND — brauchen API-Client-Zugang) ────────
  // Die genauen Pfade für financial, orders, staff APIs müssen nach
  // API-Client-Registrierung aus der Referenz-Doku bestätigt werden.
  // Quelle: https://api-docs.lsk.lightspeed.app/
  endpoints: {
    // BLOCKER: Endpunkte ohne API-Client-Zugang nicht vollständig verifizierbar
    // Vorläufig aus Financial API Doku:
    // financial: '/financial/...'
    // orders:    '/order-and-pay/...'
    // staff:     '/staff/...'
  },

  // ── Developer Portal (VERIFIZIERT) ─────────────────────────────────
  developerPortal: {
    trial:      'https://developer-portal.lsk-demo.app',
    apiDocs:    'https://api-docs.lsk.lightspeed.app/',
    apiPortal:  'https://api-portal.lsk.lightspeed.app/',
  },

  // ── Retry ───────────────────────────────────────────────────────────
  maxRetries:   3,
  retryDelayMs: 1000,
}

export const SUPPORTED_RESOURCES = [
  'locations',
  'employees',
  'sales',
  'products',
  'categories',
  'registers',
  // 'orders'  — TO_VERIFY ob K-Series Orders als eigene Resource hat
  // 'shifts'  — TO_VERIFY ob K-Series Shift-Daten per API verfügbar
  // 'payments'— TO_VERIFY ob separate Payment-API existiert
]

/**
 * Lightspeed K-Series Adapter
 *
 * ALLE echten API-Calls laufen über Supabase Edge Functions.
 * Dieser Adapter koordiniert die Aufrufe und verarbeitet die Antworten.
 */
export class LightspeedKSeriesAdapter extends BasePosAdapter {

  get providerName() { return 'lightspeed_k_series' }
  get apiVersion()   { return LIGHTSPEED_K_SERIES_CONFIG.apiVersion }

  getSupportedResources() { return SUPPORTED_RESOURCES }

  getRequiredScopes() { return LIGHTSPEED_K_SERIES_CONFIG.oauth.scopes }

  /**
   * Verbindung herstellen (nach OAuth-Callback)
   * Läuft ausschließlich über Edge Function lightspeed-auth-callback.
   *
   * @param {import('../types/pos.js').ConnectInput} input
   * @returns {Promise<import('../types/pos.js').ConnectionResult>}
   */
  async connect(input) {
    // Im Frontend: Aufruf der Edge Function
    // Edge Function: Token-Exchange, Speicherung in pos_connections
    // Kein direkter API-Call aus dem Browser
    throw new PosIntegrationError(
      'CONNECTION_NOT_FOUND',
      'connect() muss über die Supabase Edge Function lightspeed-auth-callback aufgerufen werden.',
      false
    )
  }

  /**
   * Verbindung testen
   * Läuft über Edge Function lightspeed-health-check.
   */
  async testConnection(connectionId) {
    // Wird über useLightspeedConnection Hook aufgerufen
    // der die Edge Function aufruft
    throw new PosIntegrationError(
      'CONNECTION_NOT_FOUND',
      'testConnection() muss über die Edge Function lightspeed-health-check aufgerufen werden.',
      false
    )
  }

  /**
   * Standorte abrufen — gibt normalisierte ExternalLocation[] zurück.
   * Rohdaten kommen von Edge Function, werden hier gemappt.
   *
   * @param {Object[]} rawLocations - Rohdaten von K-Series API (TO_VERIFY Struktur)
   * @returns {import('../types/pos.js').ExternalLocation[]}
   */
  mapLocations(rawLocations) {
    return (rawLocations || []).map(raw => ({
      externalId: raw.id || raw.locationId,              // TO_VERIFY Feldname
      name:       raw.name || raw.locationName || '',    // TO_VERIFY
      address:    raw.address?.street || null,           // TO_VERIFY Struktur
      timezone:   raw.timezone || 'Europe/Berlin',
      active:     raw.active !== false,
    }))
  }

  /**
   * Mitarbeiter mappen
   * @param {Object[]} rawEmployees
   * @returns {import('../types/pos.js').ExternalEmployee[]}
   */
  mapEmployees(rawEmployees) {
    return (rawEmployees || []).map(raw => ({
      externalId:   raw.id || raw.employeeId,           // TO_VERIFY
      firstName:    raw.firstName || raw.first_name || '',
      lastName:     raw.lastName  || raw.last_name  || '',
      email:        raw.email || null,
      externalRole: raw.role || raw.roleId || null,     // TO_VERIFY
      active:       raw.active !== false && !raw.deleted,
    }))
  }

  /**
   * Verkäufe mappen
   * @param {Object[]} rawSales
   * @returns {import('../types/pos.js').ExternalSale[]}
   */
  mapSales(rawSales) {
    return (rawSales || []).map(raw => ({
      externalId:         raw.id || raw.saleId,         // TO_VERIFY
      externalOrderId:    raw.orderId     || null,
      externalEmployeeId: raw.employeeId  || null,
      externalRegisterId: raw.registerId  || null,
      completedAt:        raw.completedAt || raw.closedAt || raw.updatedAt,
      totalNet:           this._toCents(raw.totalNet   || raw.total_net  || 0),
      totalGross:         this._toCents(raw.totalGross || raw.total      || 0),
      totalTax:           this._toCents(raw.totalTax   || raw.tax        || 0),
      totalTip:           this._toCents(raw.tip        || 0),
      paymentMethod:      this._mapPaymentMethod(raw),
      status:             this._mapSaleStatus(raw.status),
      items:              this.mapSaleItems(raw.lineItems || raw.lines || []),
    }))
  }

  mapSaleItems(rawItems) {
    return (rawItems || []).map(raw => ({
      externalId:       raw.id,
      externalProductId: raw.productId || null,
      name:             raw.name || raw.productName || '',
      quantity:         parseFloat(raw.quantity || raw.qty || 1),
      unitPriceNet:     this._toCents(raw.unitPrice || raw.price || 0),
      totalNet:         this._toCents(raw.total     || raw.lineTotal || 0),
      totalTax:         this._toCents(raw.tax       || 0),
    }))
  }

  mapProducts(rawProducts) {
    return (rawProducts || []).map(raw => ({
      externalId:         raw.id,
      name:               raw.name || '',
      externalCategoryId: raw.categoryId || null,
      priceNet:           this._toCents(raw.price || raw.priceNet || 0),
      taxRate:            parseFloat(raw.taxRate || raw.tax_rate || 7),
      available:          raw.available !== false && !raw.deleted,
    }))
  }

  mapCategories(rawCategories) {
    return (rawCategories || []).map(raw => ({
      externalId:      raw.id,
      name:            raw.name || '',
      parentExternalId: raw.parentId || null,
    }))
  }

  mapRegisters(rawRegisters) {
    return (rawRegisters || []).map(raw => ({
      externalId:         raw.id,
      name:               raw.name || '',
      externalLocationId: raw.locationId || '',
      active:             raw.active !== false,
    }))
  }

  // ── Private Helpers ───────────────────────────────────────────────────
  _toCents(value) {
    return Math.round(parseFloat(value || 0) * 100)
  }

  _mapPaymentMethod(raw) {
    // TO_VERIFY: K-Series Zahlungsmethoden-Felder
    const method = raw.paymentType || raw.paymentMethod || ''
    if (typeof method === 'string') {
      const m = method.toLowerCase()
      if (m.includes('cash') || m.includes('bar')) return 'cash'
      if (m.includes('card') || m.includes('karte')) return 'card'
      if (m.includes('voucher') || m.includes('gutschein')) return 'voucher'
    }
    return 'unknown'
  }

  _mapSaleStatus(status) {
    // TO_VERIFY: K-Series Sale Status-Werte
    const s = String(status || '').toLowerCase()
    if (s === 'voided'   || s === 'cancelled') return 'voided'
    if (s === 'refunded' || s === 'refund')    return 'refunded'
    return 'completed'
  }
}

export const lightspeedKSeriesAdapter = new LightspeedKSeriesAdapter()
