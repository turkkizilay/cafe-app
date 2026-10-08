// Profil-Laden (App.jsx → fetchProfile): Was passiert, wenn das Laden scheitert? Rein – ohne React, testbar.
//
// Hintergrund: auth-js meldet bei JEDER Rückkehr in die App „SIGNED_IN“; fetchProfile lädt dann (gedrosselt) neu.
// Ist das Netz in diesem Moment noch nicht bereit (iPhone-PWA, WLAN → Mobilfunk), ersetzte der Fehlerbildschirm
// früher die ganze App – offene Dialoge und Eingaben gingen verloren.
//
// Regel (wie nextAckState in privacyAck.js): Ein fehlgeschlagener Request ist NIE ein gültiger leerer Zustand.
//   'apply' – Antwort vom Server (auch „kein Profil“ = Konto gelöscht ist eine gültige Antwort)
//   'keep'  – vorübergehender Fehler (keine Antwort / Serverfehler 5xx), das Profil derselben Person ist bereits
//             geladen → bestätigten Stand behalten, Hinweis zeigen
//   'fatal' – sonst (Start, andere Person, oder der Server hat die Anfrage abgelehnt, z. B. 401/403)
//             → Fehlerbildschirm mit „Erneut versuchen“ / „Abmelden“ wie bisher
export function isTransientFailure(status) {
  return !(Number(status) > 0) || Number(status) >= 500
}

export function profileLoadOutcome({ failed, transient, uid, loadedUid }) {
  if (!failed) return 'apply'
  return transient && uid && loadedUid === uid ? 'keep' : 'fatal'
}
