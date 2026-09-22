/**
 * Lightspeed POS — Typdefinitionen (JSDoc)
 *
 * Kein ausführbarer Code. Nur Typen für IDE-Support und Dokumentation.
 * Bei Migration zu TypeScript: 1:1 als Interfaces übernehmen.
 */

/**
 * @typedef {'idle'|'syncing'|'success'|'error'} SyncStatus
 * @typedef {'cash'|'card'|'voucher'|'mixed'} PaymentMethod
 * @typedef {'completed'|'voided'|'refunded'} SaleStatus
 * @typedef {'cashier'|'manager'|'owner'} LightspeedRole
 */

/**
 * @typedef {Object} LightspeedCredentials
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt       - Unix Timestamp
 * @property {string} accountId
 */

/**
 * @typedef {Object} LightspeedLocation
 * @property {string}  id
 * @property {string}  name
 * @property {string}  address
 * @property {string}  timezone
 * @property {boolean} active
 */

/**
 * @typedef {Object} LightspeedRegister
 * @property {string}      id
 * @property {string}      locationId
 * @property {string}      name
 * @property {boolean}     active
 * @property {string|null} lastOpenedAt
 * @property {string|null} lastClosedAt
 */

/**
 * @typedef {Object} LightspeedEmployee
 * @property {string}       id
 * @property {string}       firstName
 * @property {string}       lastName
 * @property {string}       email
 * @property {LightspeedRole} role
 * @property {boolean}      active
 * @property {string|null}  cafeEmpId   - employees.id in unserer DB
 */

/**
 * @typedef {Object} LightspeedLineItem
 * @property {string}      id
 * @property {string}      productId
 * @property {string}      productName
 * @property {string|null} categoryId
 * @property {number}      quantity
 * @property {number}      unitPriceNet  - in Cent
 * @property {number}      totalNet
 * @property {number}      totalTax
 */

/**
 * @typedef {Object} LightspeedSale
 * @property {string}           id
 * @property {string}           locationId
 * @property {string}           registerId
 * @property {string|null}      employeeId
 * @property {string}           completedAt       - ISO 8601
 * @property {number}           totalNet           - in Cent
 * @property {number}           totalGross
 * @property {number}           totalTax
 * @property {number}           totalTip
 * @property {PaymentMethod}    paymentMethod
 * @property {SaleStatus}       status
 * @property {LightspeedLineItem[]} lineItems
 */

/**
 * @typedef {Object} LightspeedProduct
 * @property {string}      id
 * @property {string}      name
 * @property {string|null} categoryId
 * @property {number}      priceNet      - in Cent
 * @property {number}      taxRate       - z.B. 7 oder 19
 * @property {boolean}     available
 * @property {string|null} happyHourStart
 * @property {string|null} happyHourEnd
 * @property {string[]}    modifierIds
 */

/**
 * @typedef {Object} LightspeedCategory
 * @property {string}      id
 * @property {string}      name
 * @property {string|null} parentId
 * @property {number}      sortOrder
 */

/**
 * @typedef {Object} LightspeedShift
 * @property {string}      id
 * @property {string}      employeeId
 * @property {string}      registerId
 * @property {string}      locationId
 * @property {string}      openedAt
 * @property {string|null} closedAt
 * @property {number}      openingFloat   - in Cent
 * @property {number|null} closingFloat
 * @property {number|null} variance
 */

/**
 * @typedef {Object} LightspeedHourlyStat
 * @property {number} hour
 * @property {number} revenue       - Netto in Cent
 * @property {number} transactions
 */

/**
 * @typedef {Object} LightspeedEmployeeStat
 * @property {string} employeeId
 * @property {string} name
 * @property {number} revenue
 * @property {number} transactions
 */

/**
 * @typedef {Object} LightspeedDashboardMetrics
 * @property {number} revenueToday
 * @property {number} revenueYesterday
 * @property {number} revenueWeek
 * @property {number} revenueMonth
 * @property {number} transactionsToday
 * @property {number} averageOrderValue
 * @property {number} peakHour
 * @property {LightspeedHourlyStat[]}   hourlyRevenue
 * @property {LightspeedEmployeeStat[]} revenueByEmployee
 */

/**
 * @typedef {Object} SyncResult
 * @property {SyncStatus} status
 * @property {string|null} error
 * @property {string}  syncedAt        - ISO 8601
 * @property {number}  recordsTotal
 * @property {number}  recordsUpdated
 * @property {number}  recordsCreated
 * @property {number}  recordsFailed
 */

/**
 * @typedef {Object} LightspeedApiError
 * @property {number}  statusCode
 * @property {string}  code
 * @property {string}  message
 * @property {boolean} retryable
 */

export {}
