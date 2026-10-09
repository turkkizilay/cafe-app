// Profil-Anfragen nur für die AKTUELLE Person und nur die jüngste Anfrage anwenden (Resilience Batch 2c-1). Rein, testbar.
// Hintergrund: fetchProfile (App.jsx) wartet nacheinander auf my_access_state, das Profil, die Kenntnisnahme und die Zähler.
// Kam eine Antwort für Person A erst nach Abmelden + Anmeldung von B an, setzte sie A's Profil (Name, Rolle, Menüs, Zähler)
// in B's Sitzung – ohne Lade-Bildschirm, bis B's Antwort kam. Eine veraltete „revoked“-Antwort für A hätte B abmelden können.
// Regel: Personenwechsel oder Abmelden (setUser) und jede neue Anfrage (begin) machen ältere Anfragen ungültig; eine ungültige
// Anfrage setzt KEINEN Zustand mehr und löst nichts aus (kein Abmelden, kein Laden, kein Schreiben).
export function createRequestGate() {
  let seq = 0
  let user = null
  return {
    setUser(uid) { const next = uid || null; if (next !== user) { user = next; seq++ } },
    begin(uid) { seq++; return { seq, uid } },
    isCurrent(token) { return !!token && token.seq === seq && token.uid === user },
    get user() { return user },
  }
}
