# Engineering Memory

Kompaktes, wiederverwendbares Wissen für Arbeiten an diesem Repository (Café-Buur-Mitarbeiterportal:
React/Vite-PWA auf Vercel, Supabase mit Postgres/RLS/Storage/RPC). Kein Verlauf, kein Tagebuch.
Vertrauensstufen: **VERIFIED** (Test/Code/DB belegt) · **OBSERVED** (im Betrieb beobachtet) · **ASSUMPTION** (unbestätigt).
Pflege: siehe „Memory Hygiene“ am Ende. Stand: 2026-09-28.

Tests: App/Logik `node --test tests/*.test.mjs` · Server-Invarianten `npm --prefix tests/db test` (lokales Postgres 17, nie Production).

## Architecture Invariants

1. **Autorisierung ist serverseitig.** RLS, SECURITY-DEFINER-RPCs mit eigener Rollenprüfung und Guard-Trigger
   (`*_guard`, `prevent_*`) sind die Grenze. Versteckte Buttons/Routen sind nur Komfort. (VERIFIED)
2. **Manager sind eine operative Rolle:** keine fremden Vergütungs-, Bank-, Steuer-, SV-Daten, kein Payroll/DATEV,
   `/lohn` nur Admin. Manager lesen Mitarbeiter über `get_staff_operational()`, nicht aus `employees`. (VERIFIED, Migration 19)
3. **Mehrzeilige Invarianten in genau einer DB-Transaktion** (z. B. Schichttausch nur über `approve_swap`, mit
   `FOR UPDATE`, Prüfung von Status/Besitz/Datum). Kein Status „approved“ ohne vollständigen Tausch. (VERIFIED, Migration 20)
4. **Daten-Invarianten per Constraint/Index, nicht per Check-then-Insert:** max. ein offener Zeiteintrag
   (Migration 21), max. eine offene Pause pro Eintrag, eine laufende Tauschanfrage pro Schicht (partieller Unique-Index). (VERIFIED)
5. **Arbeitszeit:** Netto = Anwesenheit − tatsächlich erfasste Pausen. Nie automatische 30/45-Min.-Pausen,
   nie Stunden kappen (220 h / 80 h Werkstudent sind nur Warnungen). > 12 h offen → Stunden 0 + Markierung,
   bezahlt erst nach Admin-Korrektur. (VERIFIED, Migrationen 07/16/17, `tests/workHours`, `workTimeModels`)
6. **Vergütung:** Fixgehalt = Brutto-Monatsgehalt, keine Teilmonatskürzung, keine Erhöhung durch Überstunden;
   Fixgehalt nur Vollzeit/Teilzeit (DB-Constraint); `hourly_rate` bleibt Pflicht. (VERIFIED, Migration 18, `tests/compensation`)
7. **DATEV-Export (`exportDATEV`) ist eingefroren:** Spalten/Format nur mit ausdrücklicher Freigabe ändern; die
   i18n-Baseline (`.i18n-work/baseline.zip`) erzwingt das. Erlaubt war nur RFC-4180-Escaping. (VERIFIED)
8. **Angewendete Migrationen werden nie geändert oder erneut ausgeführt.** Neue Änderung = neue Datei `NN_*.sql`;
   nach dem Einspielen nur den Kopf auf „Bereits live eingespielt … NICHT erneut ausführen“ setzen. (VERIFIED)
9. **Datenschutz:** Onboarding/Portal holen eine *Kenntnisnahme*, keine Einwilligung. Kenntnisnahme ist versioniert
   (`privacy_notice_acknowledgements`, nur per RPC für das eigene Konto); neue Hinweisversion = `LEGAL_VERSION` erhöhen,
   kein Backfill. Rechtstexte beschreiben nur tatsächlich Implementiertes. (VERIFIED, Migration 23, `tests/legal`, `privacyAck`)
10. **i18n:** DE ist Default. Im State werden Nachrichten-Deskriptoren (`message`, `formatParam`) gehalten, nicht
    übersetzte Strings; Freitext/Namen/Audit-`summary` werden nie übersetzt; API-/Audit-Aufrufe bleiben sprachneutral.
    (VERIFIED, `I18N_IMPLEMENTATION_REPORT.md`, `tests/i18n`, `scripts/check-i18n-invariants.py`)
11. **Production ist keine Testumgebung.** Dort nur Read-only-Prüfungen; destruktive Tests lokal mit synthetischen Daten.

## Lessons Learned

### Veraltete Ansicht überschreibt fremde Entscheidung
Problem: Zweiter Manager lehnte einen bereits freigegebenen Tausch ab (Schichten getauscht, Status „rejected“);
Admin-Ausstempeln aus alter Ansicht überschrieb einen abgeschlossenen Eintrag; Urlaubsentscheidungen überschrieben sich.
Root Cause: Status-Übergänge als `update(...).eq('id')` ohne Vorbedingung; UI-Zustand älter als Server-Zustand.
Fix: Bedingtes Update auf den erwarteten Ausgangszustand (`.in('status', …)`, `.is('clock_out', null)`,
`.eq('status', from)`) plus `.select()` und Prüfung, ob eine Zeile betroffen war. (VERIFIED, 6dcdeb9, 82984cd)
Permanent Lesson: Jeder Zustandsübergang nennt seinen erwarteten Ausgangszustand (optimistic concurrency).
Regression Protection: `tests/errorPaths.test.mjs` (Tausch ablehnen, Ausstempeln, Urlaub, Zurückziehen).

### 0 betroffene Zeilen ist kein Fehler – und kein Erfolg
Problem: Erfolgs-Toasts, obwohl RLS/Filter nichts geändert hatte (z. B. Ausstempeln auf anderem Gerät, Antrag zurückziehen).
Root Cause: Supabase liefert bei 0 Zeilen `error: null`; Code wertete nur `error` aus.
Fix/Lesson: Bei Schreibaktionen mit Filter/RLS `.select()` anhängen und `data.length` prüfen; Erfolg erst nach
bestätigter Serverwirkung. Sperren (`saving`/Guards) in jedem Pfad freigeben. (VERIFIED, b8bde27, 82984cd)
Regression Protection: `tests/errorPaths.test.mjs` inkl. „Keine Supabase-Schreibaktion ohne Fehlerauswertung“.

### Check-then-Insert ist unter Parallelität nicht sicher
Problem: Zwei Geräte konnten gleichzeitig einstempeln; mit echten Verbindungen entstanden bei 12 parallelen Requests 9 offene Einträge.
Root Cause: Trigger prüfte „bereits eingeclockt“ per `EXISTS`; unter READ COMMITTED sehen parallele Transaktionen
die ungecommittete Zeile nicht. Client-Loading-Guards schützen nur ein Gerät.
Fix: Partieller Unique-Index `time_entries(employee_id) WHERE clock_out IS NULL` (Migration 21). (VERIFIED)
Permanent Lesson: Eindeutigkeitsregeln als Constraint/Index; Trigger nur für Meldungen/Normalisierung.
Regression Protection: Index in DB; `tests/db/time_tracking.test.mjs` (2 Geräte, Abbruch, 20 parallele Requests; echtes Postgres).

### Mehrschritt-Schreibvorgänge im Client sind nicht atomar
Problem: Tausch-Freigabe bestand aus drei Client-Updates → halber Tausch möglich; zu breite Eindeutigkeit
(`UNIQUE(requester_shift_id)` über alle Status) verhinderte neue Anfragen nach Ablehnung.
Fix: RPC `approve_swap` (eine Transaktion, Zeilensperren, erneute Prüfung); partieller Unique-Index nur für
`open/accepted`; Status „approved“ nur über die RPC setzbar (Guard). (VERIFIED, da14abc, Migration 20)
Permanent Lesson: Alles, was mehrere Zeilen konsistent halten muss, gehört in eine DB-Funktion; Constraints auf den
tatsächlich gemeinten Zustand begrenzen.
Regression Protection: `tests/db/shift_swap.test.mjs` (Guards, erneute Prüfung, parallele Freigaben, Freigabe vs. Ablehnen).

### Permissive Policies addieren sich
Problem: Manager konnten Atteste löschen, obwohl eine eigene Admin-only-DELETE-Policy existierte.
Root Cause: Eine breite `FOR ALL`-Policy (`sick_certs_admin`, Manager+Admin) wurde mit ODER verknüpft.
Fix: Breite Policy entfernt; Lesen/Upload/Ersetzen blieben über spezifische Policies (Migration 22). (VERIFIED)
Permanent Lesson: Rechte immer als Vereinigung aller Policies je Befehl (SELECT/INSERT/UPDATE/DELETE) prüfen;
`FOR ALL` vermeiden.
Regression Protection: `tests/db/storage_sick_certs.test.mjs` (Storage-Policies nicht in Migrationen → dort nachgebildet).

### Belastbare DB-Tests brauchen echtes Postgres und gehören ins Repository
Problem: Die wichtigsten Server-Tests (RLS, Guards, Parallelität) lagen zunächst nur im temporären Session-Verzeichnis.
Root Cause: Ad-hoc-Tests während der Arbeit; PGlite (eine Verbindung) kann Parallelität nicht prüfen.
Fix: `tests/db/` mit eigenem Paket (embedded-postgres 17 + pg), Schema-Vorlage + Repo-Migrationen 17–23; Gegenprobe:
jede Datei schlägt ohne ihre Migration fehl. Eigenes Paket, weil die Haupt-`package.json` durch die i18n-Baseline
byte-geschützt ist und Vercel keine Postgres-Binärdateien installieren soll. (VERIFIED)
Permanent Lesson: Server-Invarianten werden mit versionierten, reproduzierbaren Tests geschützt – nie nur ad hoc.

### Auth-/Einladungs-Zwischenzustände brauchen Recovery-Pfade
Problem: Eingeladene Person registriert sich, die Bestätigungs-E-Mail kommt nicht an; der Admin sieht nur „Entwurf“,
kann nichts erneut senden, „Registrierung abbrechen“ sperrt endgültig, neue Einladung scheitert („bereits registriert“).
Root Cause: Die Einladung wird schon beim signUp eingelöst (02_signup_trigger), der Bestätigungsstatus liegt nur in
`auth.users` (für den Browser unsichtbar), und für „Konto existiert, aber nicht aktiviert“ gab es keinen Admin-Pfad.
Fix: Migration 24 – `admin_account_states()`, `admin_prepare_confirmation_resend()` (Versand über Supabase
`auth.resend`, kein eigener Token/Service-Key), `admin_reopen_registration()`; UI zeigt Zustand + nur passende Aktion;
Einladen einer registrierten Adresse bietet Recovery statt Duplikat. (VERIFIED, Tests unten)
Permanent Lesson: „Account existiert“ ≠ „Account aktiviert“. Jeder mehrstufige Auth-/Invite-Flow braucht sichtbare
Zwischenzustände und einen Admin-Recovery-Pfad ohne Datenverlust.
Nicht per Code lösbar: Warum Mails nicht ankommen (Supabase meldete keine Versandfehler) – E-Mail-Versand/SMTP im
Supabase-Dashboard prüfen. (ASSUMPTION bis geprüft)
Regression Protection: `tests/accountRecovery.test.mjs`, `tests/db/account_recovery.test.mjs`.

### Lange Dialoge auf dem iPhone nicht erreichbar
Problem: Einladungs-Dialog auf dem iPhone nicht bis zum Bestätigungsbutton scrollbar (auch am Desktop bei sehr langen Dialogen).
Root Cause: Globale `.modal-overlay`/`.modal` ohne maximale Höhe und ohne Scrollbereich – zentrierter Inhalt lief oben
und unten aus dem sichtbaren Bereich; betraf alle Dialoge, nicht nur diesen.
Fix: Einmal global: Overlay mit Safe-Area-Abstand, `.modal` max. 100 % der Overlay-Höhe (keine vh-Probleme),
Kopf/Fuß fix, `.modal-body` scrollt; Hintergrund per `.content:has(.modal-overlay)` gesperrt; Tabellen der
Benutzerverwaltung unter 640 px gestapelt (`.table-stack` + `data-label`). (VERIFIED)
Permanent Lesson: UI-Container global robust machen statt Einzeldialoge flicken; Layout mit echten langen Inhalten
auf kleinen Viewports prüfen.
Regression Protection: `tests/modalLayout.test.mjs` (Headless Chrome, iframes 320–1280 px; ohne Chrome sichtbar übersprungen).

### Nicht-eindeutige CSV aus Freitext
Problem: Ein `"` im Namen (Freitext aus dem Onboarding) machte den DATEV-Export ungültig.
Fix: RFC-4180-Escaping (`"` → `""`); Ausgabe für normale Daten byte-identisch belegt. (VERIFIED, 82984cd)
Regression Protection: `tests/downloads.test.mjs` (adversariale Namen, Byte-Vergleich mit früherem Export).
Offen (Entscheidung ausstehend): Formel-Injection (`=`-Präfix) in Excel ist nicht abgesichert.

### Custom Pull-to-Refresh ließ sich nicht vom Scrollen trennen
Problem: Unbeabsichtigte Refreshs beim normalen Scrollen auf dem Handy, auch nach einem Gesten-Fix. (OBSERVED, zweimal auf Geräten)
Root Cause: Der Haupt-Scroller ist verschachtelt (`.content`, nicht das Dokument); iOS-Überfedern (negatives
`scrollTop`), Momentum und nicht abbrechbare `touchmove` machen den Zustand „oben in Ruhe“ unzuverlässig. (VERIFIED im Code; Ursache teils ASSUMPTION, nur simuliert getestet)
Fix: Geste entfernt, ↻-Button + zentrale `refreshData()` (68876a4). → siehe Decisions.
Permanent Lesson: Gerätegesten nur mit Gerätetest ausliefern; Simulation belegt keine echte Scrollphysik.

## Important Engineering Decisions

### Kein Custom Pull-to-Refresh
Context: Zwei fehlgeschlagene Gerätetests (s. o.). Decision: Nur ↻-Button (`RefreshButton` → `refreshData()`,
Single-Flight, schützt offene Dialoge/Eingaben). Reason: Normales Scrollen hat Vorrang. Do Not: Touch-/Pointer-Gesten
auf `.content` wieder einbauen, ohne den Scroll-Konflikt auf echten iOS/Android-Geräten zu lösen. (`tests/refresh.test.mjs`)

### Service Worker ohne Offline-Cache
Context/Decision: `public/sw.js` nur für Push. Reason: Nie eine veraltete App-Version ausliefern. Do Not: Caching
„nebenbei“ ergänzen.

### Deploy-Reihenfolge je Änderung festlegen
Decision: Vor jedem Rollout prüfen, ob alter Client + neue DB bzw. neuer Client + alte DB funktioniert.
Beispiele: `approve_swap` → erst Frontend, dann Migration 20 (alter Client hätte sonst halb getauscht);
Datenschutz-Kenntnisnahme → erst Migration 23, dann Frontend (sonst App gesperrt). Do Not: Migration und Frontend
ohne diese Prüfung „zusammen“ ausrollen.

### Kenntnisnahme statt Einwilligung, versioniert, ohne Backfill
Decision: Eigene Tabelle statt Spalten in `profiles` (dort darf jeder die eigene Zeile ändern → rückdatierbar).
Alte `privacy_accepted_at` gilt nicht als Kenntnisnahme neuer Versionen. Do Not: Bestehende Konten per UPDATE als
„bestätigt“ markieren.

### Uhrzeit-Versatz bei JWT abfangen
Decision: `fetchWithSkewRetry` in `src/lib/supabase.js` wiederholt Anfragen bei „JWT issued at future“ (c38252f).
Do Not: entfernen – die Anfrage wurde in diesem Fall nicht ausgeführt, Wiederholen ist sicher.

## Project Anti-Patterns

1. Berechtigung nur per UI (versteckter Button, Route) statt RLS/RPC.
2. Zustandsübergang per `update().eq('id')` ohne erwarteten Ausgangszustand.
3. Erfolgsmeldung, ohne die tatsächliche Serverwirkung (betroffene Zeilen, bestätigte Werte) zu prüfen.
4. Eindeutigkeit per `IF EXISTS` in Triggern oder im Client statt per Constraint/Index.
5. Mehrere zusammengehörige Schreibvorgänge nacheinander aus dem Client.
6. Breite `FOR ALL`-Policies neben spezifischen Policies.
7. Angewendete Migrationen ändern oder Daten in Migrationen ohne vorherige Read-only-Konfliktprüfung „korrigieren“.
8. Production-Daten für Tests anlegen/ändern; echte Personaldaten in Tests.
9. Übersetzte Strings im State speichern oder Freitext übersetzen.
10. Rechtstexte, die mehr/weniger behaupten als der Code tut (z. B. „keine Standortdaten gespeichert“, erfundene Fristen).

## Definition of Done

Risikobasiert – nur was die Änderung berührt:
- Anforderung und betroffene Invarianten verstanden; bestehende Tests des Bereichs gelesen.
- Kleinste robuste Änderung; Root Cause statt Symptom.
- Security: Wer darf das serverseitig? RLS/RPC/Guard geprüft; Fehlerpfade ohne False-Success; Doppelklick/parallel unschädlich.
- Regressionstest, wenn ein realistisches Wiederholungsrisiko besteht (Gegenprobe: Test schlägt mit altem Code fehl).
- Immer: `node --test tests/*.test.mjs`, `python3 scripts/check-jsx-syntax.py`, `python3 scripts/check-i18n-invariants.py`, `npm run build`.
- DB/RLS/Rechte/Zeiterfassung/Tausch/Datenschutz betroffen: `npm --prefix tests/db ci && npm --prefix tests/db test`
  (temporäres lokales Postgres 17, nie Production; siehe `tests/db/README.md`).
- DB-Änderung: neue additive Migration, in `tests/db/harness.mjs` → `MIGRATIONS` eintragen und mit Test absichern
  (Parallelität nur mit mehreren echten Verbindungen belastbar), Production vorher read-only auf Konflikte geprüft, Deploy-Reihenfolge festgelegt,
  Anwendung erst nach Review/Freigabe, danach read-only verifiziert und Kopf als „eingespielt“ markiert.
- Deployment: Vercel-Status `success` und Live-Bundle byte-identisch mit lokalem Build.
- Mobile-Layout (Dialoge, Tabellen): `tests/modalLayout.test.mjs` (braucht lokales Chrome); Gerätegesten auf echtem iOS/Android bestätigen.

## Continuous Learning Workflow

Before coding: CLAUDE.md → ENGINEERING_MEMORY.md → relevante Tests → betroffene Architektur verstehen.
During coding: Invarianten respektieren; Root Cause fixen; kleinste robuste Änderung; kritische Regeln serverseitig.
After coding: Was haben wir gelernt? Projektspezifisch und wiederverwendbar? Verhindert es realistisch einen Fehler?
Stärkste Schutzschicht wählen (Constraint > RLS > Test > Dokumentation). Nur dann diese Datei aktualisieren.

## Memory Hygiene

Keine Chat-Zusammenfassungen, Logs, To-dos, trivialen Bugs, temporären Debug-Schritte, Secrets, Personaldaten oder
Production-Datensätze. Gleiches Prinzip → zusammenführen. Durch Architekturänderung falsch gewordene Einträge
anpassen oder löschen. Ziel: diese Datei bleibt in wenigen Minuten lesbar.
