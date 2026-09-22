-- ============================================================
-- Café Buur · Security & Feature Update v2
-- In Supabase SQL Editor ausführen
-- ============================================================

-- ── 1. Profiles Tabelle erweitern ──────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status    VARCHAR(20) DEFAULT 'pending';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email     VARCHAR(255);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMP WITH TIME ZONE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS approved_by  UUID REFERENCES auth.users(id);

-- ── 2. Hilfsfunktionen für Rollenprüfungen ─────────────────
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT COALESCE((SELECT role = 'admin' FROM profiles WHERE id = auth.uid()), false)
$$;

CREATE OR REPLACE FUNCTION is_manager_or_admin()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT COALESCE((SELECT role IN ('admin','manager') FROM profiles WHERE id = auth.uid()), false)
$$;

CREATE OR REPLACE FUNCTION my_employee_id()
RETURNS UUID LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT employee_id FROM profiles WHERE id = auth.uid()
$$;

-- ── 3. Automatisch Profil bei Registrierung erstellen ──────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, role, status, email)
  VALUES (NEW.id, 'employee', 'pending', NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Profile für bereits existierende User anlegen
INSERT INTO profiles (id, role, status, email)
SELECT id, 'employee', 'pending', email
FROM auth.users
WHERE id NOT IN (SELECT id FROM profiles)
ON CONFLICT (id) DO NOTHING;

-- ── 4. Lohnabrechnungen Tabelle (PDF-Upload) ───────────────
CREATE TABLE IF NOT EXISTS payroll_documents (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL,
  file_name   VARCHAR(255) NOT NULL,
  file_path   VARCHAR(500) NOT NULL,
  file_size   INTEGER,
  uploaded_by UUID REFERENCES auth.users(id),
  notes       TEXT,
  UNIQUE(employee_id, year, month)
);
ALTER TABLE payroll_documents ENABLE ROW LEVEL SECURITY;

-- ── 5. Zeitkorrektur-Log (Audit Trail) ─────────────────────
CREATE TABLE IF NOT EXISTS time_corrections (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  time_entry_id  UUID REFERENCES time_entries(id) ON DELETE SET NULL,
  employee_id    UUID REFERENCES employees(id),
  corrected_by   UUID REFERENCES auth.users(id),
  field_changed  VARCHAR(50),
  old_value      TEXT,
  new_value      TEXT,
  reason         TEXT NOT NULL
);
ALTER TABLE time_corrections ENABLE ROW LEVEL SECURITY;

-- ── 6. ALTE zu lockere Policies löschen ────────────────────
DROP POLICY IF EXISTS "rls_employees"   ON employees;
DROP POLICY IF EXISTS "rls_time"        ON time_entries;
DROP POLICY IF EXISTS "rls_shifts"      ON shifts;
DROP POLICY IF EXISTS "rls_vacation"    ON vacation_requests;
DROP POLICY IF EXISTS "rls_sick"        ON sick_leave;
DROP POLICY IF EXISTS "rls_payroll"     ON payroll_months;
DROP POLICY IF EXISTS "rls_profiles"    ON profiles;
DROP POLICY IF EXISTS "rls_settings"    ON cafe_settings;

-- ── 7. NEUE sichere Policies ───────────────────────────────

-- EMPLOYEES: Admin/Manager sehen alles · Mitarbeiter nur sich selbst
-- (Kein Mitarbeiter sieht das Gehalt eines Kollegen!)
CREATE POLICY "emp_admin"   ON employees FOR ALL       TO authenticated USING (is_manager_or_admin()) WITH CHECK (is_admin());
CREATE POLICY "emp_self"    ON employees FOR SELECT    TO authenticated USING (id = my_employee_id());

-- TIME ENTRIES: Admin kann alles · Mitarbeiter: nur eigene lesen + einfügen, NICHT ändern!
CREATE POLICY "time_admin"  ON time_entries FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "time_read"   ON time_entries FOR SELECT TO authenticated USING (employee_id = my_employee_id());
CREATE POLICY "time_insert" ON time_entries FOR INSERT TO authenticated WITH CHECK (employee_id = my_employee_id());

-- SHIFTS: Admin/Manager verwalten · Mitarbeiter lesen nur eigene
CREATE POLICY "shift_admin" ON shifts FOR ALL          TO authenticated USING (is_manager_or_admin()) WITH CHECK (is_manager_or_admin());
CREATE POLICY "shift_self"  ON shifts FOR SELECT       TO authenticated USING (employee_id = my_employee_id());

-- VACATION: Admin verwaltet · Mitarbeiter nur eigene lesen + neu stellen
-- (Kein Mitarbeiter kann seinen eigenen Antrag genehmigen!)
CREATE POLICY "vac_admin"   ON vacation_requests FOR ALL    TO authenticated USING (is_manager_or_admin()) WITH CHECK (is_manager_or_admin());
CREATE POLICY "vac_read"    ON vacation_requests FOR SELECT TO authenticated USING (employee_id = my_employee_id());
CREATE POLICY "vac_insert"  ON vacation_requests FOR INSERT TO authenticated WITH CHECK (employee_id = my_employee_id());

-- SICK LEAVE: Admin verwaltet · Mitarbeiter nur lesen
CREATE POLICY "sick_admin"  ON sick_leave FOR ALL      TO authenticated USING (is_manager_or_admin()) WITH CHECK (is_manager_or_admin());
CREATE POLICY "sick_self"   ON sick_leave FOR SELECT   TO authenticated USING (employee_id = my_employee_id());

-- PAYROLL: Admin verwaltet · Mitarbeiter sehen nur eigene Zahlen
CREATE POLICY "pay_admin"   ON payroll_months FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "pay_self"    ON payroll_months FOR SELECT TO authenticated USING (employee_id = my_employee_id());

-- LOHNABRECHNUNGEN PDF: Admin lädt hoch · Mitarbeiter nur eigene
CREATE POLICY "doc_admin"   ON payroll_documents FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "doc_self"    ON payroll_documents FOR SELECT TO authenticated USING (employee_id = my_employee_id());

-- ZEITKORREKTUREN: Nur Admin schreibt · Mitarbeiter sehen eigene
CREATE POLICY "corr_admin"  ON time_corrections FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "corr_self"   ON time_corrections FOR SELECT TO authenticated USING (employee_id = my_employee_id());

-- PROFILES: Admin alles · jeder nur eigenes Profil lesen
CREATE POLICY "prof_admin"  ON profiles FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "prof_self"   ON profiles FOR SELECT TO authenticated USING (id = auth.uid());

-- EINSTELLUNGEN: Nur Admin darf ändern · alle dürfen GPS lesen
CREATE POLICY "set_admin"   ON cafe_settings FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "set_read"    ON cafe_settings FOR SELECT TO authenticated USING (true);

-- FEIERTAGE: Alle lesen
DROP POLICY IF EXISTS "rls_holidays" ON public_holidays;
CREATE POLICY "holidays_read" ON public_holidays FOR SELECT USING (true);

-- ── 8. Storage Bucket für Lohnabrechnungen (PDFs) ──────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('payroll-docs', 'payroll-docs', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "storage_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "storage_admin_select" ON storage.objects;
DROP POLICY IF EXISTS "storage_admin_delete" ON storage.objects;
DROP POLICY IF EXISTS "storage_employee_read" ON storage.objects;

CREATE POLICY "storage_admin_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payroll-docs' AND is_admin());
CREATE POLICY "storage_admin_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'payroll-docs' AND is_admin());
CREATE POLICY "storage_admin_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'payroll-docs' AND is_admin());
CREATE POLICY "storage_employee_read" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'payroll-docs'
    AND split_part(name, '/', 1) = my_employee_id()::text
  );

-- ── 9. ⚠️  WICHTIG: Deinen Account als Admin setzen ────────
-- !! Ersetze 'DEINE_EMAIL@HIER.DE' mit deiner echten E-Mail !!
UPDATE profiles
SET role = 'admin', status = 'approved', approved_at = NOW()
WHERE email = 'DEINE_EMAIL@HIER.DE';

-- Zum Prüfen ob es funktioniert hat:
SELECT id, email, role, status FROM profiles;

-- ============================================================
-- FERTIG! Sicherheitsupdate abgeschlossen.
-- ============================================================
