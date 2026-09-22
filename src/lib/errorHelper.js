/**
 * Café Buur — Supabase Fehlermeldungen auf Deutsch
 * Gibt klare, handlungsorientierte Fehlermeldungen zurück
 */
export function translateSupabaseError(error, context = '') {
  if (!error) return 'Unbekannter Fehler'
  
  const msg  = (error.message || '').toLowerCase()
  const code = error.code || ''
  const hint = error.hint || ''

  // ── Berechtigungsfehler ──────────────────────────────────
  if (msg.includes('row-level security') || msg.includes('rls') || code === '42501') {
    const table = msg.match(/table "(\w+)"/)?.[1] || 'unbekannt'
    const tableNames = {
      shifts:             'Schichten',
      employees:          'Mitarbeiter',
      time_entries:       'Zeiteinträge',
      vacation_requests:  'Urlaubsanträge',
      sick_leave:         'Krankmeldungen',
      payroll_months:     'Lohnabrechnung',
      payroll_documents:  'Dokumente',
      profiles:           'Benutzerprofile',
    }
    const tableDe = tableNames[table] || table
    return `🔒 Keine Berechtigung für ${tableDe}. Bitte "fix_rls_all.sql" in Supabase ausführen oder den Administrator kontaktieren.`
  }

  // ── Duplikat / Eindeutigkeitsverletzung ──────────────────
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    if (msg.includes('email'))        return '❌ Diese E-Mail-Adresse ist bereits vorhanden.'
    if (msg.includes('employee_id') && msg.includes('year') && msg.includes('month'))
      return '❌ Für diesen Mitarbeiter gibt es bereits eine Abrechnung in diesem Monat.'
    if (msg.includes('date'))         return '❌ Für diesen Mitarbeiter existiert an diesem Tag bereits ein Eintrag.'
    return '❌ Dieser Eintrag existiert bereits.'
  }

  // ── Fremdschlüsselfehler ──────────────────────────────────
  if (code === '23503' || msg.includes('foreign key')) {
    return '❌ Verknüpfter Datensatz nicht gefunden. Bitte Seite neu laden.'
  }

  // ── Pflichtfeld fehlt ─────────────────────────────────────
  if (code === '23502' || msg.includes('not-null') || msg.includes('null value')) {
    return '❌ Pflichtfeld fehlt. Bitte alle erforderlichen Felder ausfüllen.'
  }

  // ── Datumsfehler ──────────────────────────────────────────
  if (msg.includes('invalid input syntax for type date')) {
    return '❌ Ungültiges Datum. Bitte Datumsformat prüfen (TT.MM.JJJJ).'
  }

  // ── Netzwerk / Verbindungsfehler ──────────────────────────
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('connection')) {
    return '🌐 Verbindungsfehler. Bitte Internetverbindung prüfen und nochmal versuchen.'
  }

  // ── Auth-Fehler ───────────────────────────────────────────
  if (msg.includes('jwt') || msg.includes('token') || msg.includes('not authenticated')) {
    return '🔑 Sitzung abgelaufen. Bitte neu anmelden.'
  }

  // ── Timeout ───────────────────────────────────────────────
  if (msg.includes('timeout')) {
    return '⏳ Zeitüberschreitung. Bitte nochmal versuchen.'
  }

  // ── Supabase Storage ─────────────────────────────────────
  if (msg.includes('storage') || msg.includes('bucket')) {
    return '📁 Datei-Upload Fehler. Bitte Dateigröße und Format prüfen (max. 10MB, PDF/Bild).'
  }

  // ── Kontext-spezifische Meldungen ────────────────────────
  if (context) return `❌ Fehler bei "${context}": ${error.message}`

  return `❌ ${error.message}`
}
