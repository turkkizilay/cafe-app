/**
 * POS Integration — Gemeinsame Typen (provider-neutral)
 *
 * WICHTIGER HINWEIS zur Lightspeed K-Series:
 * Lightspeed Restaurant K-Series nutzt eine eigene Cloud-API:
 *   https://developer.lightspeedhq.com/restaurant-k-series-api/
 *
 * Die genauen Endpunkte, Scopes und Payload-Strukturen müssen mit dem
 * offiziellen Lightspeed K-Series API-Handbuch abgeglichen werden.
 * Vor Live-Betrieb: API-Zugang beim Lightspeed Developer Portal beantragen.
 *
 * Noch nicht öffentlich verfügbar / zu verifizieren:
 * - Genaue Endpoint-Pfade für K-Series Cloud API
 * - Verfügbare OAuth Scopes
 * - Webhook Event-Namen für K-Series
 * - Rate-Limit-Werte
 *
 * @see https://developer.lightspeedhq.com/
 */

// ── Provider ──────────────────────────────────────────────────────────────

/**
 * @typedef {'lightspeed_k_series' | 'orderbird' | 'sumup' | 'unknown'} PosProvider
 */

// ── Verbindungsstatus ─────────────────────────────────────────────────────

/**
 * @typedef {'disconnected'|'connecting'|'connected'|'restricted'|'error'} ConnectionStatus
 */

// ── Sync-Typen ────────────────────────────────────────────────────────────

/**
 * @typedef {'initial'|'incremental'|'manual'|'scheduled'|'webhook'} SyncMode
 *
 * @typedef {'locations'|'employees'|'sales'|'orders'|'payments'|'products'|'categories'|'registers'|'shifts'} SyncResource
 *
 * @typedef {'pending'|'running'|'success'|'partial'|'failed'|'cancelled'} SyncStatus
 */

// ── Mitarbeiterzuordnung ─────────────────────────────────────────────────

/**
 * @typedef {'matched'|'suggested'|'unmatched'|'conflict'|'ignored'} MappingStatus
 *
 * @typedef {'lightspeed_id'|'email'|'employee_number'|'manual'} MappingBasis
 */

// ── Fehler-Codes ─────────────────────────────────────────────────────────

/**
 * @typedef {
 *   'AUTHENTICATION_FAILED' |
 *   'AUTHORIZATION_FAILED'  |
 *   'TOKEN_REFRESH_FAILED'  |
 *   'INVALID_SCOPE'         |
 *   'CONNECTION_NOT_FOUND'  |
 *   'LOCATION_NOT_MAPPED'   |
 *   'VALIDATION_FAILED'     |
 *   'RATE_LIMITED'          |
 *   'PROVIDER_TIMEOUT'      |
 *   'PROVIDER_UNAVAILABLE'  |
 *   'MAPPING_CONFLICT'      |
 *   'DATABASE_ERROR'        |
 *   'SYNC_ALREADY_RUNNING'  |
 *   'UNKNOWN_PROVIDER_ERROR'
 * } PosErrorCode
 */

// ── Adapter-Input/Output-Typen ────────────────────────────────────────────

/**
 * @typedef {Object} ConnectInput
 * @property {string} organizationId
 * @property {string} authorizationCode  - OAuth Code nach Callback
 * @property {string} state              - CSRF-State
 * @property {string} redirectUri
 */

/**
 * @typedef {Object} ConnectionResult
 * @property {string}           connectionId
 * @property {PosProvider}      provider
 * @property {ConnectionStatus} status
 * @property {string}           externalAccountId  - Lightspeed Account/Business ID
 * @property {string}           connectedAt
 */

/**
 * @typedef {Object} HealthCheckResult
 * @property {boolean}          healthy
 * @property {ConnectionStatus} status
 * @property {string|null}      errorCode
 * @property {string|null}      errorMessage
 * @property {number}           responseTimeMs
 * @property {string}           checkedAt
 */

/**
 * @typedef {Object} LocationQuery
 * @property {string} connectionId
 * @property {string} organizationId
 */

/**
 * @typedef {Object} SyncQuery
 * @property {string}       connectionId
 * @property {string}       organizationId
 * @property {string}       externalLocationId
 * @property {string|null}  since           - ISO 8601, für Delta-Sync
 * @property {number}       [page]
 * @property {number}       [perPage]
 */

// ── Externe Entities (provider-neutral) ──────────────────────────────────

/**
 * @typedef {Object} ExternalLocation
 * @property {string}      externalId
 * @property {string}      name
 * @property {string|null} address
 * @property {string|null} timezone
 * @property {boolean}     active
 */

/**
 * @typedef {Object} ExternalEmployee
 * @property {string}      externalId
 * @property {string}      firstName
 * @property {string}      lastName
 * @property {string|null} email
 * @property {string|null} externalRole
 * @property {boolean}     active
 */

/**
 * @typedef {Object} ExternalSale
 * @property {string}           externalId
 * @property {string|null}      externalOrderId
 * @property {string|null}      externalEmployeeId
 * @property {string|null}      externalRegisterId
 * @property {string}           completedAt         - ISO 8601
 * @property {number}           totalNet            - in Cent
 * @property {number}           totalGross
 * @property {number}           totalTax
 * @property {number}           totalTip
 * @property {string}           paymentMethod
 * @property {string}           status
 * @property {ExternalSaleItem[]} items
 */

/**
 * @typedef {Object} ExternalSaleItem
 * @property {string}      externalId
 * @property {string|null} externalProductId
 * @property {string}      name
 * @property {number}      quantity
 * @property {number}      unitPriceNet
 * @property {number}      totalNet
 * @property {number}      totalTax
 */

/**
 * @typedef {Object} ExternalProduct
 * @property {string}      externalId
 * @property {string}      name
 * @property {string|null} externalCategoryId
 * @property {number}      priceNet
 * @property {number}      taxRate
 * @property {boolean}     available
 */

/**
 * @typedef {Object} ExternalCategory
 * @property {string}      externalId
 * @property {string}      name
 * @property {string|null} parentExternalId
 */

/**
 * @typedef {Object} ExternalRegister
 * @property {string}      externalId
 * @property {string}      name
 * @property {string}      externalLocationId
 * @property {boolean}     active
 */

/**
 * @typedef {Object} ExternalPayment
 * @property {string} externalId
 * @property {string} externalSaleId
 * @property {string} method
 * @property {number} amount
 * @property {string} processedAt
 */

/**
 * @typedef {Object} ExternalOrder
 * @property {string}      externalId
 * @property {string|null} externalTableId
 * @property {string|null} externalEmployeeId
 * @property {string}      status
 * @property {string}      createdAt
 * @property {string|null} closedAt
 * @property {number}      totalNet
 */

// ── Sync-Ergebnis ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} SyncJobResult
 * @property {string}           syncJobId
 * @property {SyncStatus}       status
 * @property {SyncResource}     resource
 * @property {number}           recordsTotal
 * @property {number}           recordsCreated
 * @property {number}           recordsUpdated
 * @property {number}           recordsSkipped
 * @property {number}           recordsFailed
 * @property {string}           startedAt
 * @property {string|null}      completedAt
 * @property {PosErrorCode|null} errorCode
 * @property {string|null}      errorMessage
 */

export {}
