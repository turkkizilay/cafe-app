// Datenminimierung für Manager (Migration 19): Manager lesen fremde Mitarbeiter nicht mehr direkt aus
// `employees`, sondern nur die operativen Felder aus get_staff_operational(). Diese reinen Helfer führen
// die per RLS lesbaren Zeilen (eigene bzw. als Admin alle) mit den operativen Zeilen zusammen.
// staff === null → Funktion nicht verfügbar (Mitarbeiter oder Migration 19 fehlt) → Daten unverändert.

export function mergeStaffRows(rows, staff, keep = () => true) {
  if (!staff) return rows || []
  const own = new Map((rows || []).map(r => [r.id, r]))
  return staff.filter(keep).map(s => (own.has(s.id) ? { ...s, ...own.get(s.id) } : s))
}

// Eingebettete Mitarbeiter (z. B. employees!employee_id(...)) ergänzen, wenn RLS sie ausblendet
export function fillEmbeddedEmployees(items, staff, key = 'employees') {
  if (!staff) return items || []
  const byId = new Map(staff.map(s => [s.id, s]))
  return (items || []).map(it => (it[key] || !byId.has(it.employee_id) ? it : { ...it, [key]: byId.get(it.employee_id) }))
}
