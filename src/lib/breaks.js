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

export async function startBreak() {
  return supabase.rpc('start_break')
}

export async function endBreak() {
  return supabase.rpc('end_break')
}
