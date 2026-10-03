// Krankheitsfälle Phase A (Migration 33): Lesen der Fälle/Beziehungen + Kontext für Vorschläge, Schreiben nur über
// die Admin-RPCs. Keine Lohnwirkung. Fehler/Antworten werden ausgewertet (kein stiller Erfolg).
import { supabase } from './supabase.js'
import { addDays, SCHEDULE_WINDOW_DAYS } from './sickCases.js'

// Fälle (Manager + Admin per RLS), Beziehungen (nur Admin per RLS) und der Kontext rund um die Krankmeldungen
export async function loadSickCaseData(records) {
  const starts = records.map(r => r.start_date).sort()
  const ends = records.map(r => r.end_date || new Date().toISOString().slice(0, 10)).sort()
  if (!starts.length) return { ok: true, cases: [], relations: [], shifts: [], timeEntries: [], holidays: [] }
  const from = addDays(starts[0], -SCHEDULE_WINDOW_DAYS), to = addDays(ends[ends.length - 1], SCHEDULE_WINDOW_DAYS)
  const years = []; for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(y)
  const [cases, relations, shifts, timeEntries, holidays] = await Promise.all([
    supabase.from('sick_cases').select('id, employee_id, confirmed_at, revision'),
    supabase.from('sick_case_relations').select('case_id, relation, prior_case_id, basis, reason, decided_at'),
    supabase.from('shifts').select('employee_id, date').gte('date', from).lte('date', to),
    supabase.from('time_entries').select('employee_id, date').gte('date', from).lte('date', to),
    supabase.from('public_holidays').select('date').eq('bundesland', 'Hessen').in('year', years),
  ])
  const error = cases.error || relations.error || shifts.error || timeEntries.error || holidays.error
  if (error) return { ok: false, error }
  return { ok: true, cases: cases.data || [], relations: relations.data || [], shifts: shifts.data || [], timeEntries: timeEntries.data || [], holidays: holidays.data || [] }
}

async function call(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return { ok: false, code: /worked_gap/.test(error.hint || '') ? 'worked_gap' : /sick_case_admin_only/.test(error.hint || '') ? 'admin_only' : null, error }
  if (!data?.success) return { ok: false, code: data?.code || null, conflict: !!data?.conflict, message: data?.error }
  return { ok: true, data }
}

export const confirmSickCase = (recordIds, caseId = null, revision = null) =>
  call('admin_confirm_sick_case', { p_record_ids: recordIds, p_case_id: caseId, p_expected_revision: revision })
export const removeFromSickCase = (recordIds, revision = null) =>
  call('admin_remove_from_sick_case', { p_record_ids: recordIds, p_expected_revision: revision })
export const setSickCaseRelation = ({ caseId, relation, priorCaseId = null, basis = null, reason = null, revision = null }) =>
  call('admin_set_sick_case_relation', { p_case_id: caseId, p_relation: relation, p_prior_case_id: priorCaseId, p_basis: basis, p_reason: reason, p_expected_revision: revision })
export const setSickEauKind = (recordId, kind) =>
  call('admin_set_sick_eau_kind', { p_record_id: recordId, p_kind: kind })
