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

// Admin-Korrektur: Pausen eines Eintrags auf `rows` bringen ({ id?, break_start, break_end }).
// Reihenfolge: löschen → ändern → neu anlegen (vermeidet Überschneidungen mit alten Zeilen).
export async function syncBreaks(timeEntryId, rows, original) {
  const keep = new Set(rows.filter(r => r.id).map(r => r.id))
  const removed = (original || []).filter(o => !keep.has(o.id)).map(o => o.id)
  if (removed.length) {
    const { error } = await supabase.from('time_entry_breaks').delete().in('id', removed)
    if (error) return { error }
  }
  const same = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null)
  for (const r of rows.filter(r => r.id)) {
    const o = original.find(x => x.id === r.id)
    if (o && same(o.break_start, r.break_start) && same(o.break_end, r.break_end)) continue
    const { error } = await supabase.from('time_entry_breaks')
      .update({ break_start: r.break_start, break_end: r.break_end, closed_by: r.break_end ? 'admin' : null })
      .eq('id', r.id)
    if (error) return { error }
  }
  const added = rows.filter(r => !r.id)
  if (added.length) {
    const { error } = await supabase.from('time_entry_breaks').insert(added.map(r => ({
      time_entry_id: timeEntryId, employee_id: r.employee_id,
      break_start: r.break_start, break_end: r.break_end, closed_by: r.break_end ? 'admin' : null,
    })))
    if (error) return { error }
  }
  return { error: null }
}

// Nachvollziehbarkeit: Pausen-Korrektur als eigener Eintrag in time_corrections
export async function logBreakCorrection({ timeEntryId, employeeId, correctedBy, oldValue, newValue, reason }) {
  return supabase.from('time_corrections').insert([{
    time_entry_id: timeEntryId, employee_id: employeeId, corrected_by: correctedBy,
    field_changed: 'breaks', old_value: oldValue, new_value: newValue, reason,
  }])
}

export async function startBreak() {
  return supabase.rpc('start_break')
}

export async function endBreak() {
  return supabase.rpc('end_break')
}
