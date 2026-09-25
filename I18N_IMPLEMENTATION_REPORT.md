# Deutsch/Englisch-i18n – Fortsetzungsbericht

Stand: 25.09.2026 (Abschluss nach Codex-Unterbrechung). Ergebnis: **I18N_IMPLEMENTATION_READY_FOR_FINAL_REVIEW**.

## Ausgangspunkt und Grenzen

Die unterbrochene Implementierung wurde im bestehenden Workspace fortgesetzt, nicht neu aufgebaut. Vorhanden waren LocaleContext, LanguageSwitcher, sechs i18n-Module, bereits migrierte Komponenten und `.i18n-work/baseline.zip`. Der Ordner `tests/` war leer; ein Implementierungsbericht lag nicht vor. Es gab keine AGENTS.md im Workspace.

Die erste Syntaxprüfung fand sieben fehlerhafte Dateien. Das vorhandene `refine.py` hatte beim Ersetzen von Übersetzungsaufrufen nicht nur Klammern, sondern nachfolgende Anweisungen entfernt. Wiederherstellung erfolgte anhand der bereits vorhandenen Workspace-Sicherung. Die historischen Migrationsskripte in `.i18n-work/` sind keine idempotenten Wartungsbefehle und dürfen nicht erneut pauschal ausgeführt werden.

Der Workspace besitzt kein eigenes `.git`; der erste Statusaufruf fiel auf das Elternrepository zurück und zeigte auch Namen außerhalb des Workspaces. Danach wurden keine repositoryweiten Git-Abfragen verwendet. Quellvergleiche beziehen sich ausschließlich auf die vorhandene Sicherung im Workspace, nicht auf einen anderen Projektcheckout.

Keine Netzwerkverbindung, Datenbankabfrage, Migration, Secret-Konfiguration, Veröffentlichung, Push, Merge oder Deployment wurde ausgeführt. Paketmanifest und Lockfile wurden nicht geändert. SQL-Quelltexte wurden nur lokal zur Zuordnung vorhandener Anzeige-Texte gelesen.

## Fortgesetzte Änderungen

- Syntax und abgeschnittene Anweisungen in RetentionCard, ClockIn, Dashboard, Timesheet, Vacation sowie sickLeaveLogic und vacationLogic repariert. Insbesondere wurden der Abschluss der Löschaktion, Erfolgs-/Teilfehlermeldungen, Aktualisierung und die ursprünglichen Verzweigungen wiederhergestellt.
- Vorhandene DE-/EN-Kataloge auf 1.879 Schlüssel je Sprache ergänzt (aktuell 1.883 je Sprache nach Deskriptor-Migration und Abschluss). Schlüssel- und Platzhalter-Parität einschließlich Pluralvarianten werden automatisiert geprüft.
- Verbliebene Texte für Dokumentladefenster, Lightspeed-Trenndialog, Personalformular-Feldnamen, archivierte Mitarbeiter, fehlenden Zugang und bekannte Push-Fehler ergänzt.
- Bekannte serverseitige Aufbewahrungs-Titel/-Regeln werden erst an der Anzeige übersetzt; die empfangenen Daten bleiben unverändert.
- Zusammengesetzte deutsche Plural-Endungen bei offenen Urlaubsanträgen, Arbeitstagen, fehlenden Austrittsdaten und vergessenen Zeiteinträgen durch vollständige DE-/EN-Pluraltexte ersetzt.
- Weitere Stunden-, Betrag-, Dateigrößen- und Mindestlohn-Platzhalteranzeigen verwenden die ausgewählte Locale. Persistierte Zahlen, GPS-Koordinaten und DATEV-Formatierung bleiben unverändert.
- Dokumenttitel folgt der Sprache; `html.lang`, persistierte Auswahl, Storage-Fehlerbehandlung und Tab-Synchronisierung bleiben zentral im LocaleProvider.
- Vorhandener LanguageSwitcher bleibt außerhalb der Auth-/Routing-Verzweigungen verfügbar. Label/select-Verknüpfung und Fokus-CSS sind vorhanden. Der statische Test bestätigt die gemeinsame Provider-Struktur ohne localeabhängiges Remounting.
- Bekannte Fehlermeldungen mit dem vorhandenen `❌ `-Präfix werden ebenfalls bei der Anzeige lokalisiert.
- Übersetzungen aus dem Audit-Modul an die Anzeige in ActivityLog verlagert; das Audit-Modul selbst entspricht wieder bytegenau der Sicherung.
- Einen fälschlich übersetzten `approved_by_name`-Fallback auf den ursprünglichen API-Wert `Admin` zurückgesetzt. Vorgaben für neue gespeicherte Café-Netzwerknamen entsprechen ebenfalls wieder der Sicherung.

## Nachrichten-Deskriptoren (Abschluss der unterbrochenen Arbeit)

Die frühere, auf 2.000 Einträge begrenzte Herkunftstabelle (fertiger String → Schlüssel) ist entfernt. `src/i18n/runtime.js` arbeitet ausschließlich mit expliziten, eingefrorenen Deskriptoren, die der Aufrufer selbst hält:

- `message(key, values)` – Übersetzungsschlüssel plus **rohe** Parameter; verschachtelte Deskriptoren werden erst bei `localizeMessage` in der aktuellen Sprache aufgelöst (DE→EN→DE ohne eingefrorene Teilstrings).
- `messageParts(parts)` – zusammengesetzte Meldungen aus Deskriptoren und wörtlichen Strings (z. B. Kontext + Backend-Fehlertext).
- `formatParam(format, value, options)` – Datum/Zahl/Währung als Rohwert (Date wird als Zeitstempel kopiert), Formatierung erst bei der Anzeige.
- `messageError`/`errorMessage` – Fehlerobjekte tragen den Deskriptor in `displayMessage`; `Error.message` bleibt ein String.
- Strings sind immer wörtlich: freie Eingaben, Namen, Backend-Freitext, Dokumentinhalte und historische Audit-`summary` werden nie anhand ihres Wortlauts übersetzt. `sourceLabel` ist nur eine endliche Katalogzuordnung für app-eigene bzw. bekannte feste Server-Labels (Aufbewahrungskategorien, Audit-Kategorienamen, Datenschutztexte).

## Prüfung und Korrekturen in diesem Abschluss

Geprüft wurden die zuletzt durch Codex migrierten Dateien auf doppelte Imports (keine), Deskriptoren, die ohne `localizeMessage` in JSX landen (keine; alle Toast-, Fehler-, Info-, Fortschritts- und Warnungszustände lokalisieren an der Anzeige), Übersetzungsaufrufe auf Modulebene (keine) sowie übersetzte Strings in API-/Audit-Aufrufen (keine). Alle übersetzenden Komponenten abonnieren den LocaleContext, damit ein Sprachwechsel sie neu rendert.

Notwendige Korrekturen:

- `src/pages/Shifts.jsx`: ArbZG-Warnungen wurden als sofort übersetzte Strings mit vorformatierten Stundenwerten im State gehalten und blieben nach Sprachwechsel in der alten Sprache. Jetzt `message(...)` + `formatParam('number', …)`, Anzeige über `localizeMessage`.
- `src/pages/Dashboard.jsx`: Der Aufbewahrungs-Hinweis wurde als fertig übersetzter Satz im State gespeichert. Jetzt werden nur die empfangenen Kategorien (`key`, `due`, `title`) gehalten; der Text wird beim Rendern in der aktuellen Sprache zusammengesetzt (bekannte Titel wie in RetentionCard über `sourceLabel`).
- `src/pages/Vacation.jsx`: Überlappungshinweis enthielt ein fest codiertes deutsches „ und “ auch im englischen Satz. Neuer Schlüssel `vacation.overlapPair` (DE/EN); Zeiträume werden erst bei der Anzeige formatiert.
- `tests/i18n.test.mjs`: Die Regressionsprüfung „stored UI message sites“ erfasst jetzt alle State-Setter (außer `setTimeout`/`setInterval`) sowie `push(...)`-Sammlungen statt nur einer Namensliste von Fehler-Settern.

Bewusst unverändert: Audit-Texte (`logActivity`), DATEV-/CSV-Exportkopfzeilen, Backup-Artefakttexte, persistierte Werte wie `'ohne Prüfung'`, interne Lightspeed-Servicefehler (in der UI über `toPosUserMessage` per Code lokalisiert) und das Bestätigungswort `LÖSCHEN`.

## Exakte Abschlussprüfungen

Die vollständigen Ausgaben stehen in [.i18n-work/verification-final.txt](.i18n-work/verification-final.txt).

| Befehl | Ergebnis |
| --- | --- |
| `node --test tests/i18n.test.mjs` | Exit 0; 17 Tests, 17 bestanden, 0 fehlgeschlagen, 0 übersprungen |
| `python3 scripts/check-jsx-syntax.py` | Exit 0; 78 JS-/JSX-Dateien, 0 Fehler |
| `python3 scripts/check-i18n-invariants.py` | Exit 0; 0 Abweichungen (28 Audit-Aufrufe, 529 API-Aufrufe, 46 Auswahlwerte, 3 bytegleiche geschützte Dateien, 1 DATEV-Funktion) |
| `npm run build` | Exit 0; Vite 5.4.21, 146 Module, Production-Build erfolgreich |

Build-Hinweise (keine Fehler, vorbestehend im Baseline-Stand): `push.js` wird sowohl dynamisch als auch statisch importiert; Hauptchunk > 500 kB.

`node_modules` war zu Beginn dieses Abschlusses bereits lokal vorhanden; es wurde nichts installiert und `package.json`/`package-lock.json` wurden nicht geändert.

Die Tests decken zusätzlich zu Katalog-/Platzhalter-Parität, Persistenz, Fallback, Plural, Formatierung, Datenschutz und Provider-Struktur ab: verschachtelte Urlaubs-/Ausstempelmeldungen DE→EN→DE, Lohnmonate/Dokumentnamen/Zahlen in der neuen Locale, zusammengesetzte Fragmente und Fehlerkontexte, >2.000 erzeugte Meldungen ohne Verdrängung, wörtliche Freitexte (auch wenn identisch mit einer Katalogübersetzung), Snapshot von Datums-/Formatparametern sowie Fehlerträger mit Deskriptor. Fachlogik (Urlaub, Krankheit, IBAN, Pflichtfelder) wird gegen die reinen Module der Sicherung unter DE und EN verglichen.

## Verbleibende Punkte für das finale Review

1. **Browser-Abnahme:** Keine gerenderte Desktop-/Mobile-Prüfung ausgeführt (Auth-/Public-Zustände, offene Dialoge/Toasts beim Umschalten, Tastatur/Fokus, schmale Viewports, Druck). Statische Prüfungen und Build ersetzen diese Sichtprüfung nicht.
2. **Sprachliche Sichtprüfung:** Englische Formulierungen sollten fachlich gegengelesen werden.
3. **Grenzen der statischen Prüfungen:** Der API-/Audit-Vergleich ist lexikalisch; die Syntaxprüfung ist eine JSX-Absenkung plus `node --check` (die vollständige Kompilierung ist durch den bestandenen Build belegt).

Keine Netzwerkverbindung, DB-Änderung, Migration, RLS/Auth-Änderung, Secret-Konfiguration, Paketinstallation, Push, Merge oder Deployment wurde ausgeführt. `/Users/can/cafe-app` wurde nicht verwendet.

**I18N_IMPLEMENTATION_READY_FOR_FINAL_REVIEW**
