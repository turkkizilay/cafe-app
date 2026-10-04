# DB-/RLS-/Concurrency-Regressionstests

Prüfen die serverseitigen Invarianten (RLS, Guards, RPCs, Constraints, echte Parallelität) gegen ein
**temporäres lokales PostgreSQL 17** – nie gegen Production. Es werden keine Verbindungsdaten aus der Umgebung
gelesen; der Harness startet seinen eigenen Server auf `127.0.0.1` in einem Temp-Ordner und löscht ihn danach.

```sh
npm --prefix tests/db ci      # einmalig (installiert embedded-postgres + pg nur für diese Tests)
npm --prefix tests/db test    # ca. 10–20 s
```

Aufbau: `fixtures/schema_before_17.sql` (Production-Struktur vor Migration 17, nur Schema, keine Daten/Secrets)
+ die Repository-Migrationen 17–39 in Reihenfolge (`harness.mjs`); `fixtures/lifecycle_functions.sql` enthält die
Invite-/Auth-/Onboarding-Funktionen wie in Production VOR Migration 28, `fixtures/prod_functions.sql` weitere go-live-relevante Production-Funktionen. Nur synthetische Personen.
Migrationen, die Funktionen aus `lifecycle_functions.sql` ersetzen, stehen zusätzlich in `LIFECYCLE_MIGRATIONS` und werden
von `loadLifecycle()` nach der Vorlage erneut eingespielt (sonst testete man den alten Stand) – solche Migrationen
müssen wiederholt ausführbar sein.

| Datei | Schützt |
| --- | --- |
| `rls_access.test.mjs` | Mitarbeiter nur eigene Daten; Manager ohne Vergütung/Bank/Steuer/SV/Lohn; Admin; anonym; Vergütungs-Constraints |
| `time_tracking.test.mjs` | Server-Guards beim Stempeln, keine Auto-Pause, > 12 h-Markierung, Pausen-RPCs, eine offene Pause, paralleles Einstempeln (Migration 21) |
| `shift_swap.test.mjs` | Tausch-Guards, `approve_swap` atomar, veraltete Zustände, parallele Freigaben (Migration 20) |
| `storage_sick_certs.test.mjs` | Atteste: nur Admin löscht, Upload/Lesen/Ersetzen wie vorgesehen (Migration 22) |
| `privacy_ack.test.mjs` | Versionierte Kenntnisnahme, nur eigene, kein Backfill, idempotent (Migration 23) |
| `account_recovery.test.mjs` | Auth-Status/Bestätigung erneut anfordern/Registrierung wieder öffnen nur Admin, keine Duplikate, Vergütung bleibt (Migration 24) |
| `lifecycle.test.mjs` | Invite→Signup→Onboarding→Freischaltung mit Production-Funktionen; atomare Freischaltung mit Vergütung, verwaiste Anmeldungen, Ablehnen ohne Waise, Parallelität (Migration 25) |
| `registration_reset.test.mjs` | Registrierung zurücksetzen: Klassifizierung, nur Admin, Personalakte/Historie/Vergütung/Kenntnisnahmen bleiben, Doppelklick/parallel/veraltete Ansicht, Pflichtprotokoll ohne False Success (Migration 26) |
| `ops_integrity.test.mjs` | Schichten mit Tausch-Historie löschbar, Krankmeldungen/Urlaub löscht nur Admin, mindestens ein Admin bleibt (auch parallel) (Migration 27) |
| `time_correction.test.mjs` | Admin-Zeitkorrektur atomar (Eintrag+Pausen+Protokoll), veraltete Ansicht/parallel, Mitternacht, Sommer-/Winterzeit (Sitzungs-TZ UTC wie Production), Frontend-Stand = DB-Stand; Personalnummer; Offboarding-Übersicht (Migration 27) |
| `onboarding_resume.test.mjs` | Registrierung ganz oder gar nicht (ungültige Einladung/Fehler → kein Konto, parallel genau eins), Revision gegen stille Überschreibung (zwei Tabs/Geräte, auch nach Admin-Aktion), Patch-Semantik, idempotentes Einreichen, Server-Prüfung = Client (IBAN mod 97, Telefon, Nebenbeschäftigung), alter Client kompatibel (Migration 28) |
| `remote_clock.test.mjs` | Stempeln außerhalb des Cafés: nur Manager/Admin (Rolle live), nur sich selbst, nur bestätigt und mit bestimmtem Standort; Mitarbeiter auch per RPC/Flag/gefälschtem JWT blockiert; Pflichtprotokoll ohne Koordinaten; parallel/Doppeltipp/Retry genau ein Eintrag; Rolle entzogen/inaktiv; > 12 h, Mitternacht, Admin-Korrektur (Migration 29) |
| `fixed_salary.test.mjs` | Fixgehalt ohne Stundenlohn: Freischaltung Vollzeit/Teilzeit, Monatsgehalt Pflicht, Stundenlohn nur bei Stundenlohn Pflicht (nie Ersatzwert), Werkstudent/Minijob blockiert, alte Signatur unverändert, parallel, spätere Wechsel Stundenlohn ↔ Fixgehalt, Bestand unverändert, wiederholt ausführbar (Migration 30) |
| `holidays.test.mjs` | Hessen-Feiertage berechnet: genau 10 je Jahr (2026–2030 fest geprüft, 1990–2100 gegen unabhängige Osterformel), kein Allerheiligen/Reformationstag, View wie bisherige Tabelle (nur lesen), Server-Zählung über Monats-/Jahreswechsel in jeder Sitzungs-Zeitzone, App = Server, Vorher/Nachher: Daten + Lohn/DATEV identisch (Migration 31) |
| `admin_access_reset.test.mjs` | Zugang zurücksetzen nur Admin (Rolle live), Ziel-Regeln, Pre-Request sperrt alles außer `my_access_state` bei Pflicht zur Passwortänderung, beendete Sitzungen/alte Access-Tokens abgewiesen, Storage-Sperre, Server-Funktionen nur `service_role`, Generation/Sperre gegen Doppelklick und zwei Admins, Protokoll ohne Geheimnisse, keine Datenänderung (Migration 38) |
| `open_time_correction.test.mjs` | Zeitkorrektur mit leerem Arbeitsende = offener Eintrag: Beginn Pflicht, Zukunft/zweiter offener Eintrag (auch parallel)/Überschneidung/Lohnmonat abgelehnt, Pausen im Intervall; danach wie normal offen: Einstempeln gesperrt, Pause, Ausstempeln, Live-Steuerung, Live-Personalkosten, spätere Korrektur mit Protokoll |
| `activity_log_retention.test.mjs` | Aktivitätsprotokoll-Frist 12 Monate per pg_cron (Job genau einmal, als postgres, wiederholt ausführbar), löscht nur Älteres, Funktion nur für den Server (Browser-Rollen verweigert), Migration ohne Datenänderung (Migration 39) |
| `prod_functions.test.mjs` | Production-Funktionen außerhalb der Schema-Vorlage (`fixtures/prod_functions.sql`): Konto selbst löschen + Datenschutz-Nachweise an der Personalakte, Onboarding-Korrektur, `approve_user`, Aufbewahrungs-Löschung, Protokoll |

Neue Migration `NN_*.sql`: in `harness.mjs` → `MIGRATIONS` ergänzen und hier einen Test dafür anlegen.
Ändert sich die Production-Struktur außerhalb der Migrationen (z. B. Dashboard), die Vorlage per schema-only
Dump erneuern – Secrets/URLs entfernen, `_push_kick()` wirkungslos lassen.
