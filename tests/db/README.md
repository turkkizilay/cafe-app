# DB-/RLS-/Concurrency-Regressionstests

Prüfen die serverseitigen Invarianten (RLS, Guards, RPCs, Constraints, echte Parallelität) gegen ein
**temporäres lokales PostgreSQL 17** – nie gegen Production. Es werden keine Verbindungsdaten aus der Umgebung
gelesen; der Harness startet seinen eigenen Server auf `127.0.0.1` in einem Temp-Ordner und löscht ihn danach.

```sh
npm --prefix tests/db ci      # einmalig (installiert embedded-postgres + pg nur für diese Tests)
npm --prefix tests/db test    # ca. 10–20 s
```

Aufbau: `fixtures/schema_before_17.sql` (Production-Struktur vor Migration 17, nur Schema, keine Daten/Secrets)
+ die Repository-Migrationen 17–23 in Reihenfolge (`harness.mjs`). Nur synthetische Personen.

| Datei | Schützt |
| --- | --- |
| `rls_access.test.mjs` | Mitarbeiter nur eigene Daten; Manager ohne Vergütung/Bank/Steuer/SV/Lohn; Admin; anonym; Vergütungs-Constraints |
| `time_tracking.test.mjs` | Server-Guards beim Stempeln, keine Auto-Pause, > 12 h-Markierung, Pausen-RPCs, eine offene Pause, paralleles Einstempeln (Migration 21) |
| `shift_swap.test.mjs` | Tausch-Guards, `approve_swap` atomar, veraltete Zustände, parallele Freigaben (Migration 20) |
| `storage_sick_certs.test.mjs` | Atteste: nur Admin löscht, Upload/Lesen/Ersetzen wie vorgesehen (Migration 22) |
| `privacy_ack.test.mjs` | Versionierte Kenntnisnahme, nur eigene, kein Backfill, idempotent (Migration 23) |

Neue Migration `NN_*.sql`: in `harness.mjs` → `MIGRATIONS` ergänzen und hier einen Test dafür anlegen.
Ändert sich die Production-Struktur außerhalb der Migrationen (z. B. Dashboard), die Vorlage per schema-only
Dump erneuern – Secrets/URLs entfernen, `_push_kick()` wirkungslos lassen.
