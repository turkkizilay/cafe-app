import { message } from '../i18n/runtime.js'

// Zeitkorrektur: Ablehnung wegen Überschneidung verständlich anzeigen (06.10.2026). Der Server (Migration 37) lehnt
// ab, wenn sich der Zeitraum mit einem anderen Eintrag derselben Person überschneidet, und nennt den ERSTEN Konflikt
// nur auf Minuten genau – ein versehentlicher 5-Sekunden-Stempel erschien so als „09:03 – 09:03“ und die Meldung
// wirkte wie ein Fehler der App. Erkennung über den Server-Hinweis (HINT entry_overlap), der Text dient nur dazu,
// Datum/Uhrzeit des Konflikts zu übernehmen. Reine Anzeige: Die Schutzregel selbst bleibt allein auf dem Server.
const OVERLAP_TEXT = /überschneide[nt] sich mit einem anderen Eintrag (?:dieser|derselben) Person \((\d{2}\.\d{2}\.) (\d{2}:\d{2}) – (\d{2}:\d{2}|offen)\)/

export function isOverlapError(error) {
  return error?.hint === 'entry_overlap' || OVERLAP_TEXT.test(error?.message || '')
}

// Meldung für den Toast oder null (dann gilt die bisherige Anzeige: „nicht gespeichert: <Servertext>“)
export function timeCorrectionSaveError(error) {
  if (!isOverlapError(error)) return null
  const m = OVERLAP_TEXT.exec(error?.message || '')
  if (!m) return message('time.overlapBlockedGeneric')
  const [, day, from, to] = m
  const range = to === 'offen' ? message('time.overlapRangeOpen', { p1: day, p2: from })
    : to === from ? message('time.overlapRangeShort', { p1: day, p2: from })   // Eintrag kürzer als 1 Minute
    : message('time.overlapRange', { p1: day, p2: from, p3: to })
  return message('time.overlapBlocked', { p1: range })
}
