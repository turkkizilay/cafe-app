-- ============================================================
-- 21 · Höchstens EIN offener Zeiteintrag pro Mitarbeiter (DB-Garantie)
-- Der Trigger time_entry_guard_insert prüft „bereits eingeclockt“ per EXISTS. Zwei GLEICHZEITIGE
-- Einstempel-Requests (zwei Geräte) sehen unter READ COMMITTED die jeweils andere, noch nicht
-- committete Zeile nicht → beide könnten durchkommen. Der partielle Unique-Index schließt das aus.
-- Vorab live geprüft: 0 Mitarbeiter mit mehreren offenen Einträgen. Keine Datenänderung.
-- Bereits live eingespielt (Migration one_open_time_entry, 2026-09-28) — NICHT erneut ausführen.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open_per_employee
  ON public.time_entries (employee_id) WHERE clock_out IS NULL;
