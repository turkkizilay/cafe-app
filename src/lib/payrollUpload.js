// Lohnabrechnung hochladen ohne stilles Überschreiben (Resilience Batch 2F). Rein bis auf den übergebenen Client, testbar.
// Hintergrund: Früher fester Pfad je Monat + upsert:true – ein Upload in einen belegten Monat überschrieb die vorhandene PDF
// sofort, noch vor dem Datenbankeintrag und ohne Rückfrage. Das App-Backup enthält nur die Dateiliste, nicht die Inhalte.
// Regeln:
//   • eigener Pfad je Upload (Mitarbeiterordner zuerst – darauf beruhen die Storage-Policies), nie überschreiben
//   • Belegung des Monats vorher prüfen; nicht prüfbar → nichts hochladen (nie „frei“ raten)
//   • eine ersetzte Datei erst entfernen, wenn der neue Eintrag bestätigt ist
// Kein .range/.select('*') und keine Liste hier: die Dokumentliste bleibt in lib/payrollDocuments.js.

export function payrollUploadPath(employeeId, year, monthPad, id = crypto.randomUUID()) {
  return `${employeeId}/${year}-${monthPad}-lohnabrechnung-${id}.pdf`
}

// { ok: true, doc: { id, file_path, file_name } | null } – ok:false = Belegung unbekannt (Netz, Zeitlimit, Rechte)
export async function findPayrollDoc(client, { employeeId, year, month }) {
  try {
    const { data, error } = await client.from('payroll_documents').select('id, file_path, file_name')
      .eq('employee_id', employeeId).eq('year', year).eq('month', month).maybeSingle()
    return error ? { ok: false } : { ok: true, doc: data || null }
  } catch {
    return { ok: false }
  }
}

// true = entfernt; false = nicht entfernt (bleibt als Datei ohne Zuordnung, erscheint unter „Aufbewahrung“)
export async function removePayrollFile(client, path) {
  try {
    const { error } = await client.storage.from('payroll-docs').remove([path])
    return !error
  } catch {
    return false
  }
}
