// Arbeitszeit = tatsächliche Ein-/Ausstempelzeit minus tatsächlich erfasster Pause.
// Es wird bewusst KEINE Pause automatisch angenommen (Café Buur: flexible Pausen).
export function calcWorkedHours(clockIn, clockOut, breakMinutes = 0) {
  if (!clockIn || !clockOut) return null
  const totalH = (new Date(clockOut) - new Date(clockIn)) / 3600000
  return Math.max(0, totalH - (Number(breakMinutes) || 0) / 60)
}
