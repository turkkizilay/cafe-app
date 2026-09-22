/**
 * Lightspeed Integration — Public API (Barrel-Export)
 *
 * Alles was die App aus dieser Integration braucht, wird über diesen
 * Barrel-Export importiert. Interne Module bleiben gekapselt.
 *
 * SICHERHEIT: Kein Modul hier spricht direkt mit der Lightspeed API.
 * Die gesamte Kommunikation läuft über Supabase Edge Functions.
 * Kein Frontend-Modul liest oder verarbeitet Lightspeed-Tokens.
 *
 * Verwendung:
 *   import { toPosUserMessage, PosIntegrationError } from '../integrations/lightspeed'
 */

// Fehlerbehandlung (provider-neutral)
export { PosIntegrationError, toPosUserMessage, isRetryableError } from './errors/PosIntegrationError.js'

// Services (nur Supabase-Kommunikation, keine direkten API-Calls)
export { connectionService }       from './services/connectionService.js'
export { employeeMappingService }  from './services/employeeMappingService.js'

// Sync-Orchestrierung (ruft Edge Functions auf)
export { syncLightspeedIntegration, getSyncJobStatus, getRecentSyncJobs } from './sync/syncOrchestrator.js'

// Hooks
export { useIntegrationCenter } from './hooks/useIntegrationCenter.js'
export { useLightspeedSetup }   from './hooks/useLightspeedSetup.js'
