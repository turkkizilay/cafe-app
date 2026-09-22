/**
 * useLightspeedSetup — Einrichtungsassistent-State (B1, B14, B15)
 *
 * Lädt den Konfigurationsstatus von der Edge Function und bestimmt
 * daraus den nächsten Einrichtungsschritt.
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../lib/supabase.js'

/**
 * @typedef {Object} ConfigStatus
 * @property {boolean} databaseReady
 * @property {boolean} functionsReady
 * @property {boolean} clientIdConfigured
 * @property {boolean} clientSecretConfigured
 * @property {boolean} redirectUriConfigured
 * @property {boolean} environmentConfigured
 * @property {boolean} scopesConfigured
 * @property {boolean} oauthConnected
 * @property {boolean} locationMapped
 * @property {boolean} syncReady
 * @property {string[]} blockers
 */

// Bestimmt den nächsten Schritt aus dem Status (B15)
function determineNextStep(status) {
  if (!status)                          return { key: 'check',      label: 'System prüfen' }
  if (!status.databaseReady)            return { key: 'migration',  label: 'Datenbank-Migration ausführen' }
  if (!status.functionsReady)           return { key: 'functions',  label: 'Edge Functions deployen' }
  if (!status.environmentConfigured)    return { key: 'environment',label: 'Lightspeed-Umgebung als Supabase Secret setzen' }
  if (!status.clientIdConfigured)       return { key: 'clientId',   label: 'Client-ID im Lightspeed Developer Portal erstellen und als Secret hinterlegen' }
  if (!status.clientSecretConfigured)   return { key: 'clientSecret',label: 'Client Secret sicher als Supabase Secret hinterlegen' }
  if (!status.redirectUriConfigured)    return { key: 'redirect',   label: 'Redirect-URI konfigurieren' }
  if (!status.oauthConnected)           return { key: 'connect',    label: 'Lightspeed verbinden' }
  if (!status.locationMapped)           return { key: 'location',   label: 'Standort auswählen' }
  if (!status.syncReady)                return { key: 'sync',        label: 'Synchronisation einrichten' }
  return { key: 'manage', label: 'Verbindung verwalten' }
}

export function useLightspeedSetup() {
  const [status,   setStatus]   = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [checking, setChecking] = useState(false)

  const checkStatus = useCallback(async () => {
    setChecking(true)
    setError(null)
    try {
      const { data, error } = await supabase.functions.invoke('lightspeed-config-status')
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setStatus(data)
    } catch (err) {
      // Function nicht erreichbar → als Blocker anzeigen, nicht crashen
      setError(
        err.message?.includes('Failed to fetch') || err.message?.includes('not found')
          ? 'Edge Function nicht erreichbar. Bitte Functions deployen: supabase functions deploy'
          : (err.message || 'Statusprüfung fehlgeschlagen')
      )
      setStatus(null)
    } finally {
      setLoading(false)
      setChecking(false)
    }
  }, [])

  useEffect(() => { checkStatus() }, [checkStatus])

  const nextStep = determineNextStep(status)

  return {
    status,
    loading,
    checking,
    error,
    nextStep,
    checkStatus,
    // Abgeleitete Flags für UI
    isFullyConfigured: status?.syncReady === true,
    hasBlockers:       (status?.blockers?.length || 0) > 0,
  }
}
