/**
 * Lightspeed — Sync Logger
 *
 * Schreibt alle Synchronisationsvorgänge in lightspeed_sync_logs.
 * Macht Sync-Fehler nachvollziehbar für Admin.
 */

import { supabase } from '../../../lib/supabase.js'

export const SyncLogger = {
  /**
   * @param {string}      entityType  - 'employees' | 'sales_month' | 'products' | ...
   * @param {string|null} locationId
   * @param {'success'|'error'|'partial'} status
   * @param {number}      recordCount
   * @param {Object}      [meta]       - Zusätzliche Details
   */
  async log(entityType, locationId, status, recordCount, meta = {}) {
    const { error } = await supabase.from('lightspeed_sync_logs').insert({
      entity_type:  entityType,
      location_id:  locationId,
      status,
      record_count: recordCount,
      meta:         meta,
      synced_at:    new Date().toISOString(),
    })
    if (error) console.error('[SyncLogger]', error.message)
  },

  /** Letzte N Log-Einträge für Admin-UI */
  async getRecent(limit = 20) {
    const { data } = await supabase
      .from('lightspeed_sync_logs')
      .select('*')
      .order('synced_at', { ascending: false })
      .limit(limit)
    return data || []
  },

  /** Letzter erfolgreicher Sync einer Entity */
  async getLastSuccess(entityType) {
    const { data } = await supabase
      .from('lightspeed_sync_logs')
      .select('synced_at')
      .eq('entity_type', entityType)
      .eq('status', 'success')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data?.synced_at || null
  },
}
