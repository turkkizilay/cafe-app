-- ============================================================
-- Café Buur · Update v3 — Berechtigungen & Features
-- Neues Tab im SQL Editor → ausführen
-- ============================================================

-- ── 1. Schichtplan: Alle Mitarbeiter sehen alle Schichten ──
DROP POLICY IF EXISTS "shift_self"     ON shifts;
DROP POLICY IF EXISTS "shift_read_all" ON shifts;
CREATE POLICY "shift_read_all" ON shifts FOR SELECT TO authenticated USING (true);

-- ── 2. Mitarbeiternamen für Schichtplan sichtbar machen ─────
-- (Erlaubt Lesen aller aktiven Mitarbeiter — Gehalt/IBAN nur per UI-Rolle sichtbar)
DROP POLICY IF EXISTS "emp_read_all_active" ON employees;
CREATE POLICY "emp_read_all_active" ON employees FOR SELECT TO authenticated
  USING (is_active = true);

-- ── 3. Krankmeldung selbst stellen ─────────────────────────
DROP POLICY IF EXISTS "sick_insert_self" ON sick_leave;
CREATE POLICY "sick_insert_self" ON sick_leave FOR INSERT TO authenticated
  WITH CHECK (employee_id = my_employee_id());

-- ── 4. Urlaubsantrag: Mitarbeiter kann eigenen Antrag aktualisieren ──
-- (Nur pending-Status → approved/rejected nur Admin)
DROP POLICY IF EXISTS "vac_update_self" ON vacation_requests;
CREATE POLICY "vac_update_self" ON vacation_requests FOR UPDATE TO authenticated
  USING (employee_id = my_employee_id() AND status = 'pending')
  WITH CHECK (employee_id = my_employee_id() AND status = 'pending');

-- ── 5. Krankmeldungs-Attest Upload ─────────────────────────
ALTER TABLE sick_leave ADD COLUMN IF NOT EXISTS certificate_file_path  VARCHAR(500);
ALTER TABLE sick_leave ADD COLUMN IF NOT EXISTS certificate_file_name  VARCHAR(255);
ALTER TABLE sick_leave ADD COLUMN IF NOT EXISTS certificate_uploaded_at TIMESTAMP WITH TIME ZONE;

-- ── 6. Storage Bucket für Krankschreibungen ─────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sick-certs', 'sick-certs', false, 10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "sick_cert_insert"      ON storage.objects;
DROP POLICY IF EXISTS "sick_cert_read_own"    ON storage.objects;
DROP POLICY IF EXISTS "sick_cert_admin_read"  ON storage.objects;
DROP POLICY IF EXISTS "sick_cert_admin_delete" ON storage.objects;

CREATE POLICY "sick_cert_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'sick-certs' AND split_part(name,'/',1) = my_employee_id()::text);
CREATE POLICY "sick_cert_read_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sick-certs' AND split_part(name,'/',1) = my_employee_id()::text);
CREATE POLICY "sick_cert_admin_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sick-certs' AND is_admin());
CREATE POLICY "sick_cert_admin_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'sick-certs' AND is_admin());

-- ── Prüfen ──────────────────────────────────────────────────
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename IN ('shifts','employees','sick_leave','vacation_requests')
ORDER BY tablename, policyname;
-- ============================================================
