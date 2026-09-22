/**
 * useIntegrationCenter — Haupt-Hook für das Lightspeed Integration Center
 *
 * Verwaltet den gesamten State der Integrationsseite:
 * - Verbindungsstatus
 * - Sync-Jobs
 * - Mitarbeiterzuordnungen
 * - Fehlerprotokoll
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase }                   from '../../../lib/supabase.js'
import { connectionService }          from '../services/connectionService.js'
import { employeeMappingService }     from '../services/employeeMappingService.js'
import { syncLightspeedIntegration, getRecentSyncJobs } from '../sync/syncOrchestrator.js'
import { toPosUserMessage }           from '../errors/PosIntegrationError.js'
import { SUPPORTED_RESOURCES }        from '../adapters/LightspeedKSeriesAdapter.js'
import { logActivity }                from '../../../lib/activityLog.js'

// Polling-Intervall für laufende Sync-Jobs
const SYNC_POLL_INTERVAL_MS = 3000

export function useIntegrationCenter(organizationId, currentUserId) {
  const [connection,     setConnection]     = useState(null)
  const [locationMaps,   setLocationMaps]   = useState([])
  const [syncJobs,       setSyncJobs]       = useState([])
  const [employeeMaps,   setEmployeeMaps]   = useState([])
  const [syncErrors,     setSyncErrors]     = useState([])
  const [loading,        setLoading]        = useState(true)
  const [syncing,        setSyncing]        = useState(false)
  const [testing,        setTesting]        = useState(false)
  const [error,          setError]          = useState(null)
  const [activeTab,      setActiveTab]      = useState('connection')
  const pollRef = useRef(null)

  // ── Daten laden ────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!organizationId) return
    setLoading(true)
    setError(null)
    try {
      const conn = await connectionService.getActiveConnection(organizationId)
      setConnection(conn)

      if (conn) {
        const [maps, jobs, empMaps, errors] = await Promise.all([
          connectionService.getLocationMappings(conn.id),
          getRecentSyncJobs(conn.id),
          employeeMappingService.getMappings(conn.id),
          loadSyncErrors(conn.id),
        ])
        setLocationMaps(maps)
        setSyncJobs(jobs)
        setEmployeeMaps(empMaps)
        setSyncErrors(errors)
      }
    } catch (err) {
      setError(toPosUserMessage(err))
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Sync-Job Polling ───────────────────────────────────────────────────
  useEffect(() => {
    const hasRunning = syncJobs.some(j => j.status === 'running' || j.status === 'pending')
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        if (!connection) return
        const jobs = await getRecentSyncJobs(connection.id)
        setSyncJobs(jobs)
        if (!jobs.some(j => j.status === 'running' || j.status === 'pending')) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, SYNC_POLL_INTERVAL_MS)
    }
    return () => {
      if (pollRef.current && !hasRunning) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [syncJobs, connection])

  // ── OAuth Flow starten ────────────────────────────────────────────────
  const startConnect = useCallback(async () => {
    setError(null)
    try {
      const authUrl = await connectionService.startOAuthFlow(organizationId)
      window.location.href = authUrl
    } catch (err) {
      setError(toPosUserMessage(err))
    }
  }, [organizationId])

  // ── Verbindung testen ─────────────────────────────────────────────────
  const testConnection = useCallback(async () => {
    if (!connection || testing) return
    setTesting(true)
    setError(null)
    try {
      const result = await connectionService.testConnection(connection.id)
      await loadAll()
      return result
    } catch (err) {
      setError(toPosUserMessage(err))
    } finally {
      setTesting(false)
    }
  }, [connection, testing, loadAll])

  // ── Verbindung trennen ────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (!connection) return
    setError(null)
    try {
      const success = await connectionService.disconnect(connection.id, currentUserId)
      if (success) {
        logActivity({
          action: 'integration.disconnected', category: 'integration',
          summary: 'hat die Lightspeed-Verbindung getrennt.',
          targetType: 'pos_connection', targetId: connection.id,
        })
        await loadAll()
      }
    } catch (err) {
      setError(toPosUserMessage(err))
    }
  }, [connection, currentUserId, loadAll])

  // ── Sync starten ──────────────────────────────────────────────────────
  const triggerSync = useCallback(async (resources = SUPPORTED_RESOURCES, syncMode = 'manual') => {
    if (!connection || syncing) return
    const primaryMapping = locationMaps.find(m => m.is_active)
    if (!primaryMapping) {
      setError('Kein aktiver Standort zugeordnet. Bitte erst Standort-Zuordnung konfigurieren.')
      return
    }
    setSyncing(true)
    setError(null)
    try {
      await syncLightspeedIntegration({
        organizationId,
        connectionId:  connection.id,
        locationId:    primaryMapping.id,
        resources,
        syncMode,
        triggeredBy:   currentUserId,
      })
      logActivity({
        action: 'integration.sync_started', category: 'integration',
        summary: `hat eine Lightspeed-Synchronisation gestartet.`,
        targetType: 'pos_connection', targetId: connection.id,
        metadata: { resources, syncMode },
      })
      await loadAll()
    } catch (err) {
      setError(toPosUserMessage(err))
    } finally {
      setSyncing(false)
    }
  }, [connection, syncing, locationMaps, organizationId, currentUserId, loadAll])

  // ── Mitarbeiterzuordnung bestätigen ───────────────────────────────────
  const confirmEmployeeMapping = useCallback(async (mappingId, internalEmployeeId) => {
    try {
      await employeeMappingService.confirmMapping(mappingId, internalEmployeeId, currentUserId)
      await loadAll()
    } catch (err) {
      setError(toPosUserMessage(err))
    }
  }, [currentUserId, loadAll])

  const removeEmployeeMapping = useCallback(async (mappingId) => {
    try {
      await employeeMappingService.removeMapping(mappingId)
      await loadAll()
    } catch (err) {
      setError(toPosUserMessage(err))
    }
  }, [loadAll])

  return {
    // State
    connection, locationMaps, syncJobs, employeeMaps, syncErrors,
    loading, syncing, testing, error, activeTab,
    // Aktionen
    setActiveTab, startConnect, testConnection, disconnect,
    triggerSync, confirmEmployeeMapping, removeEmployeeMapping,
    reload: loadAll,
    // Meta
    supportedResources: SUPPORTED_RESOURCES,
    isConnected: !!connection && connection.status !== 'error',
    hasLocationMapping: locationMaps.some(m => m.is_active),
    currentSyncJob: syncJobs.find(j => j.status === 'running' || j.status === 'pending') || null,
  }
}

async function loadSyncErrors(connectionId) {
  const { data } = await supabase
    .from('pos_sync_errors')
    .select('id, resource, error_code, error_message, created_at, resolved_at, sync_job_id')
    .eq('connection_id', connectionId)
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(50)
  return data || []
}
