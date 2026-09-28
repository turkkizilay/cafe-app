// Versionierte Kenntnisnahme der Datenschutzhinweise (Migration 23). Maßgeblich ist immer der Serverstatus.
import { PRIVACY_NOTICE_VERSION } from '../legal/legalContent.js'

// 'ok' = aktuelle Version bestätigt · 'required' = noch nicht · 'error' = Status nicht ermittelbar
export async function loadPrivacyAck(supabase, uid, version = PRIVACY_NOTICE_VERSION) {
  try {
    const { data, error } = await supabase.from('privacy_notice_acknowledgements')
      .select('notice_version').eq('profile_id', uid).eq('notice_version', version).maybeSingle()
    if (error) return 'error'
    return data?.notice_version === version ? 'ok' : 'required'
  } catch { return 'error' }
}

// Speichert die Kenntnisnahme der aktuellen Version für das eigene Konto (idempotent).
// Erfolg nur, wenn der Server Version und Zeitpunkt bestätigt.
export async function acknowledgePrivacyNotice(supabase, version = PRIVACY_NOTICE_VERSION) {
  try {
    const { data, error } = await supabase.rpc('acknowledge_privacy_notice', { p_version: version })
    if (error) return { ok: false, error }
    if (data?.version !== version || !data?.acknowledged_at) return { ok: false, error: null }
    return { ok: true, acknowledgedAt: data.acknowledged_at }
  } catch (error) { return { ok: false, error } }
}

// Nach einem Ladevorgang: bestätigter Status bleibt bei einem vorübergehenden Fehler erhalten,
// sonst gilt ohne Serverbestätigung „required“ (kein Freigeben aus lokalem Zustand).
export function nextAckState(previous, uid, result) {
  if (result === 'ok') return { uid, state: 'ok' }
  if (result === 'error' && previous?.uid === uid && previous.state === 'ok') return previous
  return { uid, state: 'required' }
}
