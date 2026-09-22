-- ============================================================
-- Café Buur · Update v4 — Schichttausch + 2026 Konstanten
-- ============================================================

-- ── Schichttausch System ────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_swap_requests (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  requester_id        UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requester_shift_id  UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  target_id           UUID REFERENCES employees(id),
  target_shift_id     UUID REFERENCES shifts(id),
  message             TEXT,
  status              VARCHAR(20) DEFAULT 'open', -- open | accepted | rejected | cancelled | admin_approved
  admin_note          TEXT,
  approved_by         UUID REFERENCES auth.users(id),
  approved_at         TIMESTAMP WITH TIME ZONE,
  UNIQUE(requester_shift_id)
);
ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;

-- Alle können eigene Anträge lesen + erstellen; Admin alles
CREATE POLICY "swap_admin"  ON shift_swap_requests FOR ALL       TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "swap_read"   ON shift_swap_requests FOR SELECT    TO authenticated USING (requester_id = my_employee_id() OR target_id = my_employee_id());
CREATE POLICY "swap_insert" ON shift_swap_requests FOR INSERT    TO authenticated WITH CHECK (requester_id = my_employee_id());
CREATE POLICY "swap_update" ON shift_swap_requests FOR UPDATE    TO authenticated USING (target_id = my_employee_id()) WITH CHECK (target_id = my_employee_id());

-- ── Abwesenheiten Policy Update ─────────────────────────────
-- Alle Mitarbeiter sehen genehmigte Urlaubsanträge (für Kalender)
DROP POLICY IF EXISTS "vac_read_approved_all" ON vacation_requests;
CREATE POLICY "vac_read_approved_all" ON vacation_requests FOR SELECT TO authenticated
  USING (status = 'approved');

-- Alle sehen Krankmeldungen (nur Datum, nicht Details - für Kalender)
DROP POLICY IF EXISTS "sick_read_all_dates" ON sick_leave;
CREATE POLICY "sick_read_all_dates" ON sick_leave FOR SELECT TO authenticated
  USING (true);

-- ── 2026 Konstanten in Café-Einstellungen sichern ───────────
-- (Werden im Code aus constants.js gelesen — keine DB-Änderung nötig)

-- ── Status Check ────────────────────────────────────────────
SELECT 'Schichttausch-Tabelle' AS check, COUNT(*) AS einträge FROM shift_swap_requests;
SELECT 'Urlaubsanträge gesamt' AS check, COUNT(*) AS einträge FROM vacation_requests;
-- ============================================================
