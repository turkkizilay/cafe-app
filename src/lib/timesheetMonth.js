// Stundennachweis: welcher Monat wird angezeigt?
// Ohne ausdrückliche Auswahl (URL-Parameter „monat“) immer der aktuelle LOKALE Kalendermonat des Geräts –
// gebildet aus lokalem Jahr/Monat, nie über toISOString() (UTC würde z. B. am 01.10. 00:30 in Berlin noch
// September liefern). Eine bewusste Auswahl in der laufenden Ansicht steht im URL-Parameter und bleibt erhalten;
// Links auf die Seite (Menü, „Meine Stunden“) tragen keinen Monat → neuer Aufruf = aktueller Monat.
export const isValidYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '')

export function currentLocalYm(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function resolveTimesheetMonth(monthParam, now = new Date()) {
  return isValidYm(monthParam) ? monthParam : currentLocalYm(now)
}
