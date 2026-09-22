/**
 * Sync Orchestrator — Zentrale Synchronisationsfunktion
 *
 * Implementiert die vollständige 24-Schritte-Sync-Logik.
 * Alle API-Calls laufen über Supabase Edge Function lightspeed-sync.
 * Diese Datei koordiniert den Ablauf auf Client-Seite.
 *
 * Für schwere Sync-Jobs (initial, große Datensätze):
 *   → lightspeed-sync Edge Function direkt verwenden (kein Client-Timeout)
 */

import { supabase }            from '../../../lib/supabase.js'
import { PosIntegrationError } from '../errors/PosIntegrationError.js'
import { SUPPORTED_RESOURCES } from '../adapters/LightspeedKSeriesAdapter.js'

/**
 * Startet eine Synchronisation über die Edge Function.
 *
 * @param {Object} options
 * @param {string}        options.organizationId
 * @param {string}        options.connectionId
 * @param {string}        options.locationId     - pos_location_mappings.id
 * @param {string[]}      options.resources       - SyncResource[]
 * @param {import('../types/pos.js').SyncMode} options.syncMode
 * @param {string}        options.triggeredBy     - User ID
 * @returns {Promise<{syncJobId: string, status: string}>}
 */
export async function syncLightspeedIntegration({
  organizationId,
  connectionId,
  locationId,
  resources,
  syncMode,
  triggeredBy,
}) {
  // ── Schritt 1–2: Eingaben validieren ─────────────────────────────────
  if (!organizationId || !connectionId || !locationId)
    throw new PosIntegrationError('VALIDATION_FAILED', 'organizationId, connectionId und locationId sind Pflichtfelder', false)

  if (!resources?.length)
    throw new PosIntegrationError('VALIDATION_FAILED', 'Mindestens eine Sync-Ressource muss angegeben werden', false)

  // Nur unterstützte Ressourcen
  const validResources = resources.filter(r => SUPPORTED_RESOURCES.includes(r))
  const unsupported    = resources.filter(r => !SUPPORTED_RESOURCES.includes(r))
  if (unsupported.length > 0)
    console.warn('[Sync] Nicht unterstützte Ressourcen übersprungen:', unsupported)

  if (!validResources.length)
    throw new PosIntegrationError('VALIDATION_FAILED', 'Keine gültigen Sync-Ressourcen angegeben', false)

  // ── Schritt 3–4: Verbindung prüfen ───────────────────────────────────
  const { data: connection, error: connErr } = await supabase
    .from('pos_connections')
    .select('id, status, is_active')
    .eq('id', connectionId)
    .eq('is_active', true)
    .maybeSingle()

  if (connErr || !connection)
    throw new PosIntegrationError('CONNECTION_NOT_FOUND', 'Verbindung nicht gefunden oder inaktiv', false)

  if (connection.status === 'error')
    throw new PosIntegrationError('AUTHENTICATION_FAILED', 'Verbindungsstatus fehlerhaft. Bitte neu verbinden.', false)

  // ── Schritt 8: Sync-Lock prüfen (Doppel-Sync verhindern) ─────────────
  const { data: runningJob } = await supabase
    .from('pos_sync_jobs')
    .select('id, started_at')
    .eq('connection_id', connectionId)
    .eq('status', 'running')
    .maybeSingle()

  if (runningJob)
    throw new PosIntegrationError(
      'SYNC_ALREADY_RUNNING',
      `Sync läuft bereits seit ${new Date(runningJob.started_at).toLocaleTimeString('de-DE')}`,
      false
    )

  // ── Sync-Job in DB anlegen ────────────────────────────────────────────
  const { data: syncJob, error: jobErr } = await supabase
    .from('pos_sync_jobs')
    .insert({
      connection_id:   connectionId,
      organization_id: organizationId,
      location_id:     locationId,
      sync_mode:       syncMode,
      resources:       validResources,
      triggered_by:    triggeredBy,
      status:          'pending',
      started_at:      new Date().toISOString(),
    })
    .select('id')
    .single()

  if (jobErr) throw new PosIntegrationError('DATABASE_ERROR', jobErr.message, false)

  // ── Sync über Edge Function starten ──────────────────────────────────
  // Die eigentliche Arbeit (Token-Prüfung, API-Calls, Mapping, Speichern)
  // läuft server-side in der Edge Function — kein Client-Timeout-Problem
  const { error: syncErr } = await supabase.functions.invoke('lightspeed-sync', {
    body: {
      syncJobId:       syncJob.id,
      organizationId,
      connectionId,
      locationId,
      resources:       validResources,
      syncMode,
      triggeredBy,
    }
  })

  if (syncErr) {
    // Job als fehlgeschlagen markieren
    await supabase.from('pos_sync_jobs').update({
      status:       'failed',
      error_code:   'UNKNOWN_PROVIDER_ERROR',
      error_message: syncErr.message,
      completed_at: new Date().toISOString(),
    }).eq('id', syncJob.id)

    throw new PosIntegrationError('UNKNOWN_PROVIDER_ERROR', syncErr.message, true)
  }

  return { syncJobId: syncJob.id, status: 'started' }
}

/**
 * Status eines laufenden oder abgeschlossenen Sync-Jobs laden.
 * @param {string} syncJobId
 */
export async function getSyncJobStatus(syncJobId) {
  const { data, error } = await supabase
    .from('pos_sync_jobs')
    .select(`
      id, status, sync_mode, resources, started_at, completed_at,
      records_total, records_created, records_updated,
      records_skipped, records_failed, error_code, error_message,
      pos_sync_job_items(resource, status, records_total, records_created, records_updated, records_failed, error_message)
    `)
    .eq('id', syncJobId)
    .single()

  if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
  return data
}

/**
 * Letzte Sync-Jobs für eine Verbindung (für Admin-UI)
 * @param {string} connectionId
 * @param {number} [limit]
 */
export async function getRecentSyncJobs(connectionId, limit = 10) {
  const { data } = await supabase
    .from('pos_sync_jobs')
    .select('id, status, sync_mode, resources, started_at, completed_at, records_total, error_code')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit)
  return data || []
}
