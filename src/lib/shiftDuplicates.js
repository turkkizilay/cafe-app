// Mögliche Schicht-Duplikate erkennen (Resilience Batch 2b-1). Rein – der Supabase-Client wird übergeben.
// Hintergrund: Schichten haben keine Eindeutigkeitsregel in der DB. Nach verlorener Antwort / Schreib-Timeout
// („möglicherweise gespeichert“), von einem zweiten Tab oder durch versehentliche Doppelplanung entstand sonst eine zweite,
// identische Schicht – samt zweiter Push-Nachricht an die Person (Trigger push_on_shift).
// Bewusst KEIN Block (keine neue Fachregel): Die Seite fragt nach („trotzdem anlegen?“). Kann nicht geprüft werden,
// wird nichts angelegt – nie blind schreiben, wenn der Stand unbekannt ist.

// → { ok: true, existing: { id, start_time, end_time } | null } | { ok: false }
export async function findSameStartShift(client, { employeeId, date, startTime }) {
  try {
    const { data, error } = await client.from('shifts')
      .select('id, start_time, end_time')
      .eq('employee_id', employeeId).eq('date', date).eq('start_time', startTime)
      .limit(1)
    if (error) return { ok: false }
    return { ok: true, existing: (data && data[0]) || null }
  } catch {
    return { ok: false }
  }
}

// Uhrzeit für Meldungen: DB liefert HH:MM:SS → HH:MM
export const hhmm = t => String(t || '').slice(0, 5)
