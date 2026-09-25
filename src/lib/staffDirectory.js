import { supabase } from './supabase'
export { mergeStaffRows, fillEmbeddedEmployees } from './staffMerge'

// Operative Mitarbeiterdaten für Manager/Admin – ohne Vergütung, Bank-, Steuer- und SV-Daten.
// null = nicht verfügbar (Mitarbeiter-Rolle oder Migration 19 noch nicht eingespielt).
export async function fetchStaffOperational() {
  try {
    const { data, error } = await supabase.rpc('get_staff_operational')
    return error ? null : (data || [])
  } catch {
    return null
  }
}
