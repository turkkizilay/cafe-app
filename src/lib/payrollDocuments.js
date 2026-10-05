// Lohnabrechnungs-Liste: echte serverseitige Pagination (05.10.2026). Früher wurde die ganze Tabelle geladen – ab
// 1000 Zeilen schneidet die Supabase-API („Max rows“) still ab, die ältesten Dokumente wären unsichtbar geworden.
// Jetzt: je Seite genau PAGE_SIZE Zeilen per range(), Gesamtzahl exakt vom Server (count, nach RLS gezählt), Filter
// als eq() auf dem Server. Sicherheitsgrenze bleibt allein RLS (doc_read: nur eigene; doc_manage: Admin) – die Filter
// hier können nur einschränken, nie erweitern. Mitarbeiter erhalten keine Namen/IDs anderer Personen (kein Embed).
export const PAGE_SIZE = 25
export const DOC_COLUMNS = 'id, employee_id, year, month, file_name, file_path, file_size, notes, created_at'
const ADMIN_COLUMNS = `${DOC_COLUMNS}, employees!employee_id(first_name, last_name)`

export const pageCount = total => Math.max(1, Math.ceil((Number(total) || 0) / PAGE_SIZE))
export const clampPage = (page, total) => Math.min(Math.max(1, Math.floor(Number(page) || 1)), pageCount(total))
export const pageRange = page => [(page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1]
export const hasFilters = f => !!(f?.employeeId || f?.year || f?.month)

// Eine Seite abfragen. Sortierung deterministisch: neueste Abrechnung zuerst, bei Gleichstand zuletzt hochgeladen,
// zuletzt id als eindeutiger Tie-Breaker – sonst könnten Zeilen beim Blättern doppelt erscheinen oder fehlen.
export function documentsQuery(supabase, { isAdmin, ownEmployeeId, filters = {}, page = 1 }) {
  let q = supabase.from('payroll_documents').select(isAdmin ? ADMIN_COLUMNS : DOC_COLUMNS, { count: 'exact' })
  if (!isAdmin) q = q.eq('employee_id', ownEmployeeId)
  else {
    if (filters.employeeId) q = q.eq('employee_id', filters.employeeId)
    if (filters.year) q = q.eq('year', Number(filters.year))
    if (filters.month) q = q.eq('month', Number(filters.month))
  }
  const [from, to] = pageRange(page)
  return q.order('year', { ascending: false }).order('month', { ascending: false })
    .order('created_at', { ascending: false }).order('id', { ascending: true })
    .range(from, to)
}

// Seite laden → { rows, total, page } oder { error }. Liegt die gewünschte Seite hinter dem Ende (letztes Dokument
// der letzten Seite gelöscht, anderer Admin hat gelöscht, Filter liefert weniger), wird die letzte gültige Seite
// geladen. PostgREST antwortet auf einen Bereich hinter dem Ende mit 416 (PGRST103) oder mit 0 Zeilen.
export async function loadDocumentsPage(supabase, opts) {
  if (!opts.isAdmin && !opts.ownEmployeeId) return { rows: [], total: 0, page: 1 }
  const page = Math.max(1, Math.floor(Number(opts.page) || 1))
  const res = await documentsQuery(supabase, { ...opts, page })
  const overflow = page > 1 && (res.error?.code === 'PGRST103' || (!res.error && !res.data?.length))
  if (!overflow) return res.error ? { error: res.error } : { rows: res.data || [], total: res.count ?? 0, page }
  let total = res.error ? null : res.count
  if (total == null) {
    const first = await documentsQuery(supabase, { ...opts, page: 1 })
    if (first.error) return { error: first.error }
    total = first.count ?? 0
    if (pageCount(total) === 1) return { rows: first.data || [], total, page: 1 }
  }
  const last = pageCount(total)
  const again = await documentsQuery(supabase, { ...opts, page: last })
  return again.error ? { error: again.error } : { rows: again.data || [], total: again.count ?? total, page: last }
}
