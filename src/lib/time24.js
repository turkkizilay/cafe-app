// 24-Stunden-Uhrzeit (HH:MM) für Eingabefelder – unabhängig von Browser-/OS-Locale.
// Hintergrund: <input type="time"> zeigt je nach Browser/System 12 h mit AM/PM (Chrome folgt der Browsersprache,
// Safari der Systemeinstellung – <html lang="de"> hilft nicht). Löscht man dort ein Segment (z. B. AM/PM), wird der
// Wert leer und das kontrollierte Feld hängt in einem halben Zustand. Deshalb: Freitext + eindeutige Normalisierung.

const pad = n => String(n).padStart(2, '0')

// Akzeptiert „08:30“, „8:30“, „8.30“, „8,30“, „0830“, „830“, „8“, „18“ → „08:30“ / „08:00“ / „18:00“.
// Liefert null für alles Unvollständige/Ungültige (z. B. „8:3“, „24:00“, „12:60“, „ab“). Nie 12-h-Deutung.
export function parseTime24(text) {
  const t = String(text ?? '').trim().replace(/[.,hH]/g, ':')
  let m
  let h, min
  if ((m = t.match(/^(\d{1,2}):(\d{2})$/))) { h = +m[1]; min = +m[2] }
  else if ((m = t.match(/^(\d{1,2})(\d{2})$/))) { h = +m[1]; min = +m[2] }
  else if ((m = t.match(/^(\d{1,2})$/))) { h = +m[1]; min = 0 }
  else return null
  if (h > 23 || min > 59) return null
  return `${pad(h)}:${pad(min)}`
}

// Nur Zeichen zulassen, die in einer Uhrzeit vorkommen (Ziffern und Trenner), max. 5 Zeichen.
export function sanitizeTimeDraft(text) {
  return String(text ?? '').replace(/[^0-9:.,]/g, '').slice(0, 5)
}

// Während des Tippens: nur eine VOLLSTÄNDIGE Uhrzeit gilt (Minuten zweistellig angegeben): „18:00“, „8:30“, „8.30“,
// „0830“ – auch ganz ohne Trenner, weil die Ziffern-Tastatur auf dem Handy (inputMode numeric, iPhone) keinen „:“ hat.
// Dreistellig nur, wenn die erste Ziffer 3–9 ist („915“ → 09:15, „830“ → 08:30): Daraus kann durch Weitertippen keine
// andere gültige Uhrzeit mehr werden (Stunde 91/83 gibt es nicht). „123“, „183“, „18“, „8“ bleiben unvollständig –
// der Nutzer tippt evtl. weiter („18“ → „1830“) –, so erreicht nie ein Zwischenstand wie „01:00“ die Formular-/
// Validierungs-/ArbZG-Logik. Ungültiges (25:00, 12:60, 9:99) wird nie „korrigiert“.
export function parseCompleteTime24(text) {
  const t = String(text ?? '').trim()
  return /^\d{1,2}[:.,hH]\d{2}$/.test(t) || /^\d{4}$/.test(t) || /^[3-9]\d{2}$/.test(t) ? parseTime24(t) : null
}
