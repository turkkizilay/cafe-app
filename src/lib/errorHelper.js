import { t as tr, localizeMessage, message as appMessage, errorMessage, messageParts } from '../i18n/runtime.js'
/**
 * Café Buur — Supabase Fehlermeldungen auf Deutsch
 * Gibt klare, handlungsorientierte Fehlermeldungen zurück
 */
export function translateSupabaseError(error, context = '') {
  if (!error) return appMessage("ui.617580f0f7ef")
  
  const msg  = (error.message || '').toLowerCase()
  const code = error.code || ''
  const hint = error.hint || ''

  // ── Berechtigungsfehler ──────────────────────────────────
  if (msg.includes('row-level security') || msg.includes('rls') || code === '42501') {
    const table = msg.match(/table "(\w+)"/)?.[1] || appMessage("ui.a418e69e9fbe")
    const tableNames = {
      shifts:             appMessage("ui.97697a0ac0ee"),
      employees:          appMessage("ui.f4cb6891b9e5"),
      time_entries:       appMessage("ui.26baab0a4ab6"),
      vacation_requests:  appMessage("ui.46e604ec9516"),
      sick_leave:         appMessage("ui.25456ffae37d"),
      payroll_months:     appMessage("ui.ac0c96f1028e"),
      payroll_documents:  appMessage("ui.36f250abd259"),
      profiles:           appMessage("ui.d147861f0815"),
    }
    const tableDe = tableNames[table] || table
    return appMessage("ui.cc827c4f5474", { p1: (tableDe) })
  }

  // ── Eigene Prüfungen der Datenbank (RAISE EXCEPTION) — Texte sind bereits deutsch ──
  if (code === 'P0001' && error.message) return messageParts(['❌ ', error.message])

  // ── Duplikat / Eindeutigkeitsverletzung ──────────────────
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    if (msg.includes('email'))        return appMessage("ui.db50ab4d1fb2")
    if (msg.includes('employee_id') && msg.includes('year') && msg.includes('month'))
      return appMessage("ui.1f7404a0bdfd")
    if (msg.includes('date'))         return appMessage("ui.519959a8e52b")
    return appMessage("ui.da10092c1f65")
  }

  // ── Fremdschlüsselfehler ──────────────────────────────────
  if (code === '23503' || msg.includes('foreign key')) {
    return appMessage("ui.9c37b52d582d")
  }

  // ── Pflichtfeld fehlt ─────────────────────────────────────
  if (code === '23502' || msg.includes('not-null') || msg.includes('null value')) {
    return appMessage("ui.bc1d876ad2f4")
  }

  // ── Datumsfehler ──────────────────────────────────────────
  if (msg.includes('invalid input syntax for type date')) {
    return appMessage("ui.d2837565b5f3")
  }

  // ── Netzwerk / Verbindungsfehler ──────────────────────────
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('connection')) {
    return appMessage("ui.7502a327c0db")
  }

  // ── Auth-Fehler ───────────────────────────────────────────
  if (msg.includes('jwt') || msg.includes('token') || msg.includes('not authenticated')) {
    return appMessage("ui.1241e631593f")
  }

  // ── Timeout ───────────────────────────────────────────────
  if (msg.includes('timeout')) {
    return appMessage("ui.7998e62c41e8")
  }

  // ── Supabase Storage ─────────────────────────────────────
  if (msg.includes('storage') || msg.includes('bucket')) {
    return appMessage("ui.e103d41b51cb")
  }

  // ── Kontext-spezifische Meldungen ────────────────────────
  if (context) return appMessage("ui.af0e9bbf0113", { p1: (context), p2: (errorMessage(error)) })

  return messageParts(['❌ ', errorMessage(error) || appMessage('ui.617580f0f7ef')])
}
