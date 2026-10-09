// Abmelden beendet nur die Sitzung auf DIESEM Gerät (Produktentscheidung, Resilience Batch 2a / F6-1).
// supabase-js meldet ohne Angabe global ab (alle Geräte der Person) – Auto-Logout am Café-Tablet beendete so auch die
// Sitzung auf dem privaten Handy. Mit 'local' widerruft der Server das Refresh-Token genau dieser Sitzung und der
// Browser leert den Speicher dieses Geräts (alle Tabs hier). Ein ausdrücklich übergebener Scope gilt weiter.
//
// Sicherheitsfunktionen bleiben unberührt, weil sie auf dem Server wirken: Zugang zurücksetzen löscht alle Sitzungen
// (auth.sessions) und setzt sessions_valid_after; access_gate weist jede Data-API-Anfrage einer widerrufenen Sitzung ab;
// der erzwungene Passwortwechsel sperrt bis zur Änderung (Migration 38).
export function deviceSignOutOptions(options) {
  const given = options && typeof options === 'object' ? options : {}
  return { ...given, scope: given.scope ?? 'local' }
}
