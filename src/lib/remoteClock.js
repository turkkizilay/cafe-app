import { supabase } from './supabase'
import { boundedRequest } from './boundedRequest'
import { REMOTE_TIMEOUT_MS } from './remoteClockLogic'

// Stempeln außerhalb des Cafés (Migration 29) – nur Manager/Admin, nur nach ausdrücklicher Bestätigung.
// Die Berechtigung prüft ausschließlich der Server (clock_in_remote / clock_out_remote: Rolle live aus profiles,
// nur die eigene Person, Standort muss bestimmt sein, confirmed = true). Aufgerufen wird nur aus dem
// Bestätigungsdialog; jede Anfrage endet garantiert (boundedRequest), `status: 0` = Stand neu laden.
export { REMOTE_TIMEOUT_MS, remoteClockState, remoteErrorKind } from './remoteClockLogic'

const call = (fn, { lat, lng }) => boundedRequest(
  signal => supabase.rpc(fn, { p_lat: lat ?? null, p_lng: lng ?? null, p_confirmed: true }).abortSignal(signal),
  { ms: REMOTE_TIMEOUT_MS })

/** Bestätigtes Einstempeln (nur die angemeldete Person). Ergebnis: { data: {success, id, clock_in, remote}, error, status } */
export const clockInRemote = pos => call('clock_in_remote', pos || {})
/** Bestätigtes Ausstempeln des eigenen offenen Eintrags. */
export const clockOutRemote = pos => call('clock_out_remote', pos || {})
