import { t as tr, getIntlLocale, message as appMessage, errorMessage } from '../../../i18n/runtime.js'
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
  if (!status)                          return { key: 'check',      label: tr("ui.22d18db99187") }
  if (!status.databaseReady)            return { key: 'migration',  label: tr("ui.78fc90686750") }
  if (!status.functionsReady)           return { key: 'functions',  label: tr("ui.dbddcbfbe4cd") }
  if (!status.environmentConfigured)    return { key: 'environment',label: tr("ui.8639e5251aca") }
  if (!status.clientIdConfigured)       return { key: 'clientId',   label: tr("ui.6ccaa4c2369f") }
  if (!status.clientSecretConfigured)   return { key: 'clientSecret',label: tr("ui.08b8b58e9126") }
  if (!status.redirectUriConfigured)    return { key: 'redirect',   label: tr("ui.712e25654196") }
  if (!status.oauthConnected)           return { key: 'connect',    label: tr("ui.5ad863758478") }
  if (!status.locationMapped)           return { key: 'location',   label: tr("ui.b45481ed038a") }
  if (!status.syncReady)                return { key: 'sync',        label: tr("ui.a5c851fe606f") }
  return { key: 'manage', label: tr("ui.9fdb369552ab") }
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
        err.message?.includes('Failed to fetch') || err.message?.includes('not found') ? (appMessage("ui.a519a2697d1a")) : ((errorMessage(err) || appMessage("ui.3321889ff318")))
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
