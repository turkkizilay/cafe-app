/**
 * POS Provider Adapter — Interface-Definition
 *
 * Alle POS-Integrationen (Lightspeed, Orderbird, SumUp etc.) implementieren
 * dieses Interface. Die App selbst nutzt ausschließlich dieses Interface —
 * niemals provider-spezifische Details.
 */

/**
 * @interface PosProviderAdapter
 *
 * connect(input)                   → ConnectionResult
 * disconnect(connectionId)         → void
 * refreshAuthentication(id)        → void
 * testConnection(connectionId)     → HealthCheckResult
 * getLocations(query)              → ExternalLocation[]
 * getEmployees(query)              → ExternalEmployee[]
 * getSales(query)                  → ExternalSale[]
 * getOrders(query)                 → ExternalOrder[]
 * getPayments(query)               → ExternalPayment[]
 * getProducts(query)               → ExternalProduct[]
 * getCategories(query)             → ExternalCategory[]
 * getRegisters(query)              → ExternalRegister[]
 *
 * Alle Methoden lösen PosIntegrationError bei Fehlern aus.
 * Alle Methoden sind idempotent oder explizit dokumentiert wenn nicht.
 */

export class PosAdapterNotImplementedError extends Error {
  constructor(method) {
    super(`Adapter-Methode nicht implementiert: ${method}`)
    this.name = 'PosAdapterNotImplementedError'
  }
}

/**
 * Abstrakte Basisklasse — nie direkt instanziieren.
 * Neue Adapter erben von dieser Klasse und überschreiben alle Methoden.
 */
export class BasePosAdapter {
  get providerName()  { throw new PosAdapterNotImplementedError('providerName') }
  get apiVersion()    { throw new PosAdapterNotImplementedError('apiVersion') }

  async connect(input)                    { throw new PosAdapterNotImplementedError('connect') }
  async disconnect(connectionId)          { throw new PosAdapterNotImplementedError('disconnect') }
  async refreshAuthentication(id)         { throw new PosAdapterNotImplementedError('refreshAuthentication') }
  async testConnection(connectionId)      { throw new PosAdapterNotImplementedError('testConnection') }
  async getLocations(query)               { throw new PosAdapterNotImplementedError('getLocations') }
  async getEmployees(query)               { throw new PosAdapterNotImplementedError('getEmployees') }
  async getSales(query)                   { throw new PosAdapterNotImplementedError('getSales') }
  async getOrders(query)                  { throw new PosAdapterNotImplementedError('getOrders') }
  async getPayments(query)                { throw new PosAdapterNotImplementedError('getPayments') }
  async getProducts(query)                { throw new PosAdapterNotImplementedError('getProducts') }
  async getCategories(query)              { throw new PosAdapterNotImplementedError('getCategories') }
  async getRegisters(query)               { throw new PosAdapterNotImplementedError('getRegisters') }

  /** @returns {string[]} Unterstützte SyncResource-Werte dieses Adapters */
  getSupportedResources()                 { throw new PosAdapterNotImplementedError('getSupportedResources') }

  /** @returns {string[]} Benötigte OAuth-Scopes */
  getRequiredScopes()                     { throw new PosAdapterNotImplementedError('getRequiredScopes') }
}
