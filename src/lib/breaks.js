import { supabase } from './supabase'

// Pausen einer Schicht (time_entry_breaks, Migration 17). Mitarbeiter schreiben nur über
// die RPCs start_break()/end_break() – Serverzeit, keine Standortprüfung.

// Migration 17 noch nicht eingespielt → Pausen-Funktion ausblenden statt Fehler zeigen
export function isBreakFeatureMissing(error) {
  return ['PGRST202', 'PGRST205', '42P01', '42883'].includes(error?.code)
}

export async function fetchBreaks(timeEntryId) {
  const { data, error } = await supabase.from('time_entry_breaks')
    .select('id, break_start, break_end, closed_by')
    .eq('time_entry_id', timeEntryId)
    .order('break_start')
  return { breaks: data || [], error }
}

// Admin-Liste: Pausen mehrerer Zeiteinträge → { [time_entry_id]: [...] }
export async function fetchBreaksForEntries(timeEntryIds) {
  if (!timeEntryIds?.length) return { byEntry: {}, error: null }
  const { data, error } = await supabase.from('time_entry_breaks')
    .select('id, time_entry_id, break_start, break_end, closed_by')
    .in('time_entry_id', timeEntryIds)
    .order('break_start')
  const byEntry = {}
  for (const b of data || []) (byEntry[b.time_entry_id] ||= []).push(b)
  return { byEntry, error }
}

// Pausen eines Zeitraums (Stundennachweis: Pausenzeiten neben den Minuten) → { [time_entry_id]: [...] }.
// Nur lesend; geschrieben wird ausschließlich über start_break/end_break und admin_save_time_entry (Migration 34).
export async function fetchBreaksInRange(fromIso, toIso, employeeId = null) {
  let q = supabase.from('time_entry_breaks')
    .select('time_entry_id, break_start, break_end')
    .gte('break_start', fromIso).lt('break_start', toIso)
    .order('break_start')
  if (employeeId) q = q.eq('employee_id', employeeId)
  const { data, error } = await q
  const byEntry = {}
  for (const b of data || []) (byEntry[b.time_entry_id] ||= []).push(b)
  return { byEntry, error }
}

export async function startBreak() {
  return supabase.rpc('start_break')
}

export async function endBreak() {
  return supabase.rpc('end_break')
}
