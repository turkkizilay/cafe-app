import { t as tr } from '../../../i18n/runtime.js'
/**
 * POS Connection Service
 *
 * Verwaltet Verbindungen in der pos_connections Tabelle.
 * Kein direkter Lightspeed-API-Call — alle Token-Operationen
 * laufen über Supabase Edge Functions.
 */

import { supabase }           from '../../../lib/supabase.js'
import { PosIntegrationError } from '../errors/PosIntegrationError.js'
import { LIGHTSPEED_K_SERIES_CONFIG } from '../adapters/LightspeedKSeriesAdapter.js'

export const connectionService = {

  /**
   * Startet den OAuth-Flow (Redirect zu Lightspeed)
   * OAuth State wird in sessionStorage für CSRF-Schutz gespeichert.
   * Client ID kommt aus Supabase Edge Function — NICHT aus Frontend.
   *
   * @param {string} organizationId
   * @returns {Promise<string>} Redirect URL
   */
  async startOAuthFlow(organizationId) {
    const state = `${organizationId}:${crypto.randomUUID()}`
    sessionStorage.setItem('pos_oauth_state', state)
    sessionStorage.setItem('pos_oauth_org', organizationId)

    // Client ID kommt von Edge Function (kein hardcoding im Frontend)
    const { data, error } = await supabase.functions.invoke('lightspeed-auth-start', {
      body: {
        provider:       'lightspeed_k_series',
        organizationId,
        state,
        redirectUri:    `${window.location.origin}/einstellungen/integrationen/lightspeed/callback`,
        scopes:         LIGHTSPEED_K_SERIES_CONFIG.oauth.requiredScopes,
      }
    })

    if (error || !data?.authorizationUrl)
      throw new PosIntegrationError('AUTHENTICATION_FAILED', 'OAuth-Start fehlgeschlagen', false)

    return data.authorizationUrl
  },

  /**
   * Verarbeitet OAuth-Callback nach Lightspeed-Redirect.
   * @param {string} code
   * @param {string} state
   * @param {string} organizationId
   */
  async handleOAuthCallback(code, state, organizationId) {
    // CSRF-State validieren
    const savedState = sessionStorage.getItem('pos_oauth_state')
    sessionStorage.removeItem('pos_oauth_state')
    sessionStorage.removeItem('pos_oauth_org')

    if (!savedState || savedState !== state)
      throw new PosIntegrationError('AUTHENTICATION_FAILED', 'Ungültiger OAuth-State (CSRF)', false)

    // Token-Exchange über Edge Function (Client Secret bleibt server-side)
    const { data, error } = await supabase.functions.invoke('lightspeed-auth-callback', {
      body: {
        code,
        state,
        organizationId,
        redirectUri: `${window.location.origin}/einstellungen/integrationen/lightspeed/callback`,
      }
    })

    if (error || !data?.connectionId)
      throw new PosIntegrationError('AUTHENTICATION_FAILED', 'Verbindung konnte nicht hergestellt werden: ' + (error?.message || 'Unbekannter Fehler'), false)

    return data
  },

  /**
   * Aktive Verbindung für eine Organisation laden.
   * @param {string} organizationId
   */
  async getActiveConnection(organizationId) {
    const { data, error } = await supabase
      .from('pos_connections')
      .select('id, provider, status, external_account_id, external_business_name, connected_at, last_health_check_at, last_health_check_status')
      .eq('organization_id', organizationId)
      .eq('provider', 'lightspeed_k_series')
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
    return data
  },

  /**
   * Verbindung testen (über Edge Function)
   * @param {string} connectionId
   */
  async testConnection(connectionId) {
    const { data, error } = await supabase.functions.invoke('lightspeed-health-check', {
      body: { connectionId }
    })

    // Health Check Ergebnis in DB speichern
    await supabase.from('pos_connections')
      .update({
        last_health_check_at:     new Date().toISOString(),
        last_health_check_status: error ? 'error' : 'ok',
      })
      .eq('id', connectionId)

    if (error) return { healthy: false, status: 'error', errorMessage: error.message, responseTimeMs: 0, checkedAt: new Date().toISOString() }
    return data
  },

  /**
   * Verbindung sicher trennen (revisionssicher)
   * @param {string} connectionId
   * @param {string} disconnectedByUserId
   */
  async disconnect(connectionId, disconnectedByUserId) {
    if (!window.confirm(
      tr("ui.ed3455d705f1") +
      tr("ui.9fe6c343fcb9") +
      tr("ui.288987c36243") +
      tr("ui.d524859b43dc")
    )) return false

    const { error } = await supabase.functions.invoke('lightspeed-disconnect', {
      body: { connectionId, disconnectedByUserId }
    })

    if (error) throw new PosIntegrationError('DATABASE_ERROR', 'Trennung fehlgeschlagen: ' + error.message, false)
    return true
  },

  /** Alle Standort-Zuordnungen für eine Verbindung */
  async getLocationMappings(connectionId) {
    const { data, error } = await supabase
      .from('pos_location_mappings')
      .select(`
        id,
        internal_location_name,
        external_location_id,
        external_location_name,
        is_active,
        pos_external_locations(name, timezone)
      `)
      .eq('connection_id', connectionId)

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
    return data || []
  },

  /** Standort-Zuordnung speichern */
  async saveLocationMapping(connectionId, internalName, externalLocationId, externalLocationName) {
    const { error } = await supabase.from('pos_location_mappings').upsert({
      connection_id:          connectionId,
      internal_location_name: internalName,
      external_location_id:   externalLocationId,
      external_location_name: externalLocationName,
      is_active:              true,
      updated_at:             new Date().toISOString(),
    }, { onConflict: 'connection_id,external_location_id' })

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
  },
}
