# Café-Buur-Mitarbeiterportal

Vor wesentlichen Änderungen `ENGINEERING_MEMORY.md` lesen (Invarianten, Lessons Learned, Entscheidungen,
Definition of Done). Nach abgeschlossenen Aufgaben dort nur wiederverwendbare, belegte Erkenntnisse ergänzen.

Prüfbefehle: `node --test tests/*.test.mjs` · `python3 scripts/check-jsx-syntax.py` ·
`python3 scripts/check-i18n-invariants.py` · `npm run build`
Server-Invarianten (RLS, Guards, Parallelität; lokales Postgres, nie Production):
`npm --prefix tests/db ci && npm --prefix tests/db test`
