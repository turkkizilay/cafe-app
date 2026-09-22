-- ============================================================
-- Café Buur · FINALES SICHERHEITS-UPDATE
-- Datum: 2026 — Alle kritischen RLS-Fixes
-- ============================================================

-- ── 1. Helper-Funktionen (neu und sicher) ──────────────────
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM profiles WHERE id = auth.uid() AND status = 'approved'),
    false
  )
$$;

CREATE OR REPLACE FUNCTION is_manager_or_admin()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT COALESCE(
    (SELECT role IN ('admin','manager') FROM profiles WHERE id = auth.uid() AND status = 'approved'),
    false
  )
$$;

CREATE OR REPLACE FUNCTION my_employee_id()
RETURNS UUID LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT employee_id FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION my_is_active_employee()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT COALESCE(
    (SELECT e.is_active FROM employees e
     JOIN profiles p ON p.employee_id = e.id
     WHERE p.id = auth.uid()),
    false
  )
$$;

-- ── 2. Employees ────────────────────────────────────────────
DROP POLICY IF EXISTS "emp_read"   ON employees;
DROP POLICY IF EXISTS "emp_manage" ON employees;
DROP POLICY IF EXISTS "emp_admin"  ON employees;
DROP POLICY IF EXISTS "emp_self"   ON employees;
DROP POLICY IF EXISTS "emp_read_all_active" ON employees;
DROP POLICY IF EXISTS "manager_read_all"    ON employees;

CREATE POLICY "emp_read"   ON employees FOR SELECT TO authenticated USING (is_active = true);
CREATE POLICY "emp_manage" ON employees FOR ALL    TO authenticated
  USING (is_manager_or_admin()) WITH CHECK (is_admin());

-- ── 3. Time Entries — KRITISCH: Deaktivierte können nicht clocken ──
DROP POLICY IF EXISTS "time_admin"  ON time_entries;
DROP POLICY IF EXISTS "time_read"   ON time_entries;
DROP POLICY IF EXISTS "time_insert" ON time_entries;
DROP POLICY IF EXISTS "time_update" ON time_entries;

-- Admin: alles
CREATE POLICY "time_admin"  ON time_entries FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- Eigene Einträge lesen
CREATE POLICY "time_read"   ON time_entries FOR SELECT TO authenticated
  USING (employee_id = my_employee_id() OR is_manager_or_admin());

-- Nur aktive Mitarbeiter dürfen einclocken
CREATE POLICY "time_insert" ON time_entries FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = my_employee_id()
    AND my_is_active_employee() = true  -- SICHERHEIT: Deaktivierte ausgeschlossen
  );

-- Nur eigenes Ausclocken (clock_out setzen wenn clock_in vorhanden)
CREATE POLICY "time_update" ON time_entries FOR UPDATE TO authenticated
  USING (employee_id = my_employee_id() AND my_is_active_employee() = true)
  WITH CHECK (employee_id = my_employee_id());

-- ── 4. Time Corrections — AUDIT-LOG: NUR INSERT, nie löschen/ändern ──
DROP POLICY IF EXISTS "corr_manage" ON time_corrections;
DROP POLICY IF EXISTS "corr_self"   ON time_corrections;
DROP POLICY IF EXISTS "corr_read"   ON time_corrections;
DROP POLICY IF EXISTS "corr_insert" ON time_corrections;

-- Nur einfügen (Audit-Log ist UNVERÄNDERLICH)
CREATE POLICY "corr_insert" ON time_corrections FOR INSERT TO authenticated
  WITH CHECK (is_admin());

-- Lesen: Admin alles, Mitarbeiter nur eigene
CREATE POLICY "corr_read"   ON time_corrections FOR SELECT TO authenticated
  USING (is_admin() OR employee_id = my_employee_id());

-- KEIN UPDATE, KEIN DELETE Policy → Audit-Trail ist dauerhaft

-- ── 5. Profiles ─────────────────────────────────────────────
DROP POLICY IF EXISTS "prof_admin" ON profiles;
DROP POLICY IF EXISTS "prof_self"  ON profiles;
DROP POLICY IF EXISTS "update_own_profile" ON profiles;

CREATE POLICY "prof_admin" ON profiles FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "prof_self"  ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

-- ── 6. Shifts ───────────────────────────────────────────────
DROP POLICY IF EXISTS "shifts_read"   ON shifts;
DROP POLICY IF EXISTS "shifts_manage" ON shifts;
DROP POLICY IF EXISTS "shift_admin"   ON shifts;
DROP POLICY IF EXISTS "shift_read_all" ON shifts;

CREATE POLICY "shifts_read"   ON shifts FOR SELECT TO authenticated USING (true);
CREATE POLICY "shifts_manage" ON shifts FOR ALL    TO authenticated
  USING (is_manager_or_admin()) WITH CHECK (is_manager_or_admin());

-- ── 7. Vacation Requests ─────────────────────────────────────
DROP POLICY IF EXISTS "vac_manage"           ON vacation_requests;
DROP POLICY IF EXISTS "vac_read"             ON vacation_requests;
DROP POLICY IF EXISTS "vac_insert"           ON vacation_requests;
DROP POLICY IF EXISTS "vac_read_approved_all" ON vacation_requests;
DROP POLICY IF EXISTS "vac_admin"            ON vacation_requests;
DROP POLICY IF EXISTS "vac_update_self"      ON vacation_requests;

CREATE POLICY "vac_manage" ON vacation_requests FOR ALL    TO authenticated
  USING (is_manager_or_admin()) WITH CHECK (is_manager_or_admin());
CREATE POLICY "vac_read"   ON vacation_requests FOR SELECT TO authenticated
  USING (employee_id = my_employee_id() OR is_manager_or_admin());
CREATE POLICY "vac_insert" ON vacation_requests FOR INSERT TO authenticated
  WITH CHECK (employee_id = my_employee_id() AND my_is_active_employee());

-- ── 8. Sick Leave ───────────────────────────────────────────
DROP POLICY IF EXISTS "sick_manage"       ON sick_leave;
DROP POLICY IF EXISTS "sick_read"         ON sick_leave;
DROP POLICY IF EXISTS "sick_insert"       ON sick_leave;
DROP POLICY IF EXISTS "sick_admin"        ON sick_leave;
DROP POLICY IF EXISTS "sick_self"         ON sick_leave;
DROP POLICY IF EXISTS "sick_insert_self"  ON sick_leave;
DROP POLICY IF EXISTS "sick_read_all_dates" ON sick_leave;

CREATE POLICY "sick_manage" ON sick_leave FOR ALL    TO authenticated
  USING (is_manager_or_admin()) WITH CHECK (is_manager_or_admin());
CREATE POLICY "sick_read"   ON sick_leave FOR SELECT TO authenticated
  USING (employee_id = my_employee_id() OR is_manager_or_admin());
CREATE POLICY "sick_insert" ON sick_leave FOR INSERT TO authenticated
  WITH CHECK (employee_id = my_employee_id() AND my_is_active_employee());

-- ── 9. Payroll Months ────────────────────────────────────────
DROP POLICY IF EXISTS "pay_manage" ON payroll_months;
DROP POLICY IF EXISTS "pay_read"   ON payroll_months;
DROP POLICY IF EXISTS "pay_admin"  ON payroll_months;
DROP POLICY IF EXISTS "pay_self"   ON payroll_months;

CREATE POLICY "pay_manage" ON payroll_months FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "pay_read"   ON payroll_months FOR SELECT TO authenticated
  USING (employee_id = my_employee_id());

-- ── 10. Payroll Documents — Lohnabrechnungen sicher ─────────
DROP POLICY IF EXISTS "doc_manage" ON payroll_documents;
DROP POLICY IF EXISTS "doc_read"   ON payroll_documents;
DROP POLICY IF EXISTS "doc_admin"  ON payroll_documents;
DROP POLICY IF EXISTS "doc_self"   ON payroll_documents;

CREATE POLICY "doc_manage" ON payroll_documents FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
-- Mitarbeiter sieht NUR EIGENE Abrechnungen
CREATE POLICY "doc_read"   ON payroll_documents FOR SELECT TO authenticated
  USING (employee_id = my_employee_id());

-- ── 11. Café Settings ────────────────────────────────────────
DROP POLICY IF EXISTS "set_manage" ON cafe_settings;
DROP POLICY IF EXISTS "set_read"   ON cafe_settings;
DROP POLICY IF EXISTS "set_admin"  ON cafe_settings;

CREATE POLICY "set_manage" ON cafe_settings FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "set_read"   ON cafe_settings FOR SELECT TO authenticated
  USING (true); -- Café-Koordinaten müssen alle Mitarbeiter lesen (für GPS)

-- ── 12. Public Holidays ──────────────────────────────────────
DROP POLICY IF EXISTS "holidays_read" ON public_holidays;
CREATE POLICY "holidays_read" ON public_holidays FOR SELECT USING (true);

-- ── 13. Invitations ─────────────────────────────────────────
DROP POLICY IF EXISTS "inv_admin"    ON invitations;
DROP POLICY IF EXISTS "inv_read_own" ON invitations;

CREATE POLICY "inv_admin"    ON invitations FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "inv_read_own" ON invitations FOR SELECT TO authenticated
  USING (created_by = auth.uid());

-- ── 14. Shift Swap ───────────────────────────────────────────
DROP POLICY IF EXISTS "swap_admin"  ON shift_swap_requests;
DROP POLICY IF EXISTS "swap_read"   ON shift_swap_requests;
DROP POLICY IF EXISTS "swap_insert" ON shift_swap_requests;
DROP POLICY IF EXISTS "swap_update" ON shift_swap_requests;

CREATE POLICY "swap_admin"  ON shift_swap_requests FOR ALL       TO authenticated USING (is_admin());
CREATE POLICY "swap_read"   ON shift_swap_requests FOR SELECT    TO authenticated
  USING (requester_id = my_employee_id() OR target_id = my_employee_id());
CREATE POLICY "swap_insert" ON shift_swap_requests FOR INSERT    TO authenticated
  WITH CHECK (requester_id = my_employee_id() AND my_is_active_employee());
CREATE POLICY "swap_update" ON shift_swap_requests FOR UPDATE    TO authenticated
  USING (target_id = my_employee_id());

-- ── 15. RPC-Funktionen ─────────────────────────────────────
-- E-Mail prüfen für Passwort-Reset (öffentlich zugänglich)
CREATE OR REPLACE FUNCTION check_email_registered(p_email TEXT)
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM auth.users WHERE email = LOWER(TRIM(p_email)))
$$;

-- Einladungs-Info (öffentlich für nicht-eingeloggte Nutzer)
CREATE OR REPLACE FUNCTION get_invitation_info(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE inv RECORD; emp RECORD;
BEGIN
  SELECT * INTO inv FROM invitations WHERE token = p_token;
  IF NOT FOUND        THEN RETURN '{"valid":false,"error":"Einladung nicht gefunden."}'::json; END IF;
  IF inv.used_at IS NOT NULL THEN RETURN '{"valid":false,"error":"Diese Einladung wurde bereits verwendet."}'::json; END IF;
  IF inv.expires_at < NOW()  THEN RETURN '{"valid":false,"error":"Diese Einladung ist abgelaufen (7 Tage)."}'::json; END IF;
  SELECT * INTO emp FROM employees WHERE id = inv.employee_id;
  RETURN json_build_object('valid',true,'employee_name',emp.first_name||' '||emp.last_name,
    'email',inv.email,'position',COALESCE(emp.position,''),'role',inv.role,'expires_at',inv.expires_at);
END;
$$;

-- Einladung annehmen (setzt Profil auf approved)
CREATE OR REPLACE FUNCTION accept_invitation(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE inv RECORD;
BEGIN
  SELECT * INTO inv FROM invitations
  WHERE token=p_token AND used_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN RETURN '{"success":false,"error":"Ungültige oder abgelaufene Einladung."}'::json; END IF;
  INSERT INTO profiles(id,email,role,status,employee_id,approved_at)
  VALUES(auth.uid(),inv.email,inv.role,'approved',inv.employee_id,NOW())
  ON CONFLICT(id) DO UPDATE SET status='approved',role=inv.role,employee_id=inv.employee_id,approved_at=NOW();
  UPDATE invitations SET used_at=NOW() WHERE token=p_token;
  RETURN '{"success":true}'::json;
END;
$$;

-- ── 16. Admin → Can Kizilay verknüpfen ─────────────────────
UPDATE profiles
SET employee_id = (
  SELECT id FROM employees
  WHERE first_name ILIKE 'Can%' AND is_active = true LIMIT 1
)
WHERE email = 'can_apple97@icloud.com' AND employee_id IS NULL;

-- ── 17. Storage Policies ────────────────────────────────────
-- Sick Certs Bucket
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('sick-certs','sick-certs',false,10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
ON CONFLICT(id) DO NOTHING;

DROP POLICY IF EXISTS "sick_certs_upload_own" ON storage.objects;
DROP POLICY IF EXISTS "sick_certs_read"       ON storage.objects;
DROP POLICY IF EXISTS "sick_certs_admin"      ON storage.objects;

-- Mitarbeiter lädt in eigenen Ordner (Ordnername = employee_id)
CREATE POLICY "sick_certs_upload_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK(bucket_id='sick-certs' AND
    (storage.foldername(name))[1]=(SELECT employee_id::text FROM profiles WHERE id=auth.uid()));

-- Lesen: nur eigene ODER Manager/Admin
CREATE POLICY "sick_certs_read" ON storage.objects FOR SELECT TO authenticated
  USING(bucket_id='sick-certs' AND(
    (storage.foldername(name))[1]=(SELECT employee_id::text FROM profiles WHERE id=auth.uid())
    OR is_manager_or_admin()
  ));

-- Admin: voller Zugriff
CREATE POLICY "sick_certs_admin" ON storage.objects FOR ALL TO authenticated
  USING(bucket_id='sick-certs' AND is_manager_or_admin())
  WITH CHECK(bucket_id='sick-certs' AND is_manager_or_admin());

-- Payroll Docs Bucket
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('payroll-docs','payroll-docs',false,10485760,ARRAY['application/pdf'])
ON CONFLICT(id) DO NOTHING;

DROP POLICY IF EXISTS "payroll_docs_upload" ON storage.objects;
DROP POLICY IF EXISTS "payroll_docs_read"   ON storage.objects;
DROP POLICY IF EXISTS "payroll_docs_admin"  ON storage.objects;

-- Nur Admin darf hochladen
CREATE POLICY "payroll_docs_upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK(bucket_id='payroll-docs' AND is_admin());

-- Mitarbeiter liest nur eigenen Ordner
CREATE POLICY "payroll_docs_read" ON storage.objects FOR SELECT TO authenticated
  USING(bucket_id='payroll-docs' AND(
    (storage.foldername(name))[1]=(SELECT employee_id::text FROM profiles WHERE id=auth.uid())
    OR is_admin()
  ));

CREATE POLICY "payroll_docs_admin" ON storage.objects FOR ALL TO authenticated
  USING(bucket_id='payroll-docs' AND is_admin())
  WITH CHECK(bucket_id='payroll-docs' AND is_admin());

-- ── 18. Hessische Feiertage 2026 sicherstellen ─────────────
INSERT INTO public_holidays(date, name, bundesland, year) VALUES
  ('2026-01-01','Neujahr','Hessen',2026),
  ('2026-04-03','Karfreitag','Hessen',2026),
  ('2026-04-06','Ostermontag','Hessen',2026),
  ('2026-05-01','Tag der Arbeit','Hessen',2026),
  ('2026-05-14','Christi Himmelfahrt','Hessen',2026),
  ('2026-05-25','Pfingstmontag','Hessen',2026),
  ('2026-06-04','Fronleichnam','Hessen',2026),
  ('2026-10-03','Tag der Deutschen Einheit','Hessen',2026),
  ('2026-11-01','Allerheiligen','Hessen',2026),
  ('2026-12-25','1. Weihnachtstag','Hessen',2026),
  ('2026-12-26','2. Weihnachtstag','Hessen',2026)
ON CONFLICT(date, bundesland) DO NOTHING;

-- ── 19. Verifikation ─────────────────────────────────────────
SELECT 'RLS Check' AS info,
  schemaname, tablename, COUNT(*) AS policies
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN('employees','time_entries','time_corrections','profiles',
                   'vacation_requests','sick_leave','payroll_documents','invitations','shifts')
GROUP BY schemaname, tablename ORDER BY tablename;

SELECT 'Aktive Mitarbeiter' AS info, COUNT(*) FROM employees WHERE is_active=true;
SELECT 'Admin verknüpft' AS info, p.email, e.first_name||' '||e.last_name AS mitarbeiter
FROM profiles p LEFT JOIN employees e ON e.id=p.employee_id WHERE p.email='can_apple97@icloud.com';
-- ============================================================
