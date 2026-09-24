-- ============================================================
-- 11 · Aufbewahrungsfristen & Löschung (Art. 5 Abs. 1 e, Art. 17 DSGVO)
-- Bereits live eingespielt (Migration retention_and_cleanup) — NICHT erneut ausführen.
--
-- Fristen (konservativ, mit Steuerberatung abstimmen):
--   zeiten      Arbeitszeiten, Schichten, Urlaub, Korrekturen, Tauschanfragen:
--               3 volle Kalenderjahre nach dem Jahr des Eintrags
--               (§ 17 MiLoG / § 16 ArbZG: mind. 2 Jahre; Verjährung Lohnansprüche 3 Jahre)
--   krank       Krankmeldungen inkl. AU-Datei: 3 volle Kalenderjahre (wie oben)
--   lohn        Lohnabrechnungen (PDF) & Lohnmonate: 8 volle Kalenderjahre
--               (§ 147 AO Buchungsbelege, § 41 EStG Lohnkonto)
--   ehemalige   Ausgeschiedene Mitarbeiter komplett (Stammdaten + alles Übrige):
--               8 volle Kalenderjahre nach dem Austrittsjahr
--   protokoll   Aktivitätsprotokoll: 3 volle Kalenderjahre
--   einladungen Benutzte/abgelaufene/zurückgezogene Einladungen: nach 6 Monaten
--   verwaist    Dateien ohne zugehörigen Datensatz (älter als 1 Tag): sofort
--
-- Ablauf beim Löschen: Die App löscht zuerst die Dateien (Storage-API), danach
-- löscht retention_purge() die Datensätze. Datensätze, deren Datei noch existiert,
-- werden übersprungen – so bleiben nie Dateien ohne Datensatz zurück.
-- ============================================================

-- Admin darf Personalunterlagen-Dateien löschen (fehlte bisher)
DROP POLICY IF EXISTS emp_docs_storage_delete ON storage.objects;
CREATE POLICY emp_docs_storage_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'employee-documents' AND is_admin());

-- Nach der Freischaltung liegen die Personaldaten in employees; die Kopie in der
-- Registrierung wird nicht mehr gebraucht (Datenminimierung).
CREATE OR REPLACE FUNCTION public.onboarding_wipe_after_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.employee_id IS NOT NULL THEN
    NEW.birth_name := NULL; NEW.birth_date := NULL; NEW.birth_place := NULL; NEW.nationality := NULL;
    NEW.street := NULL; NEW.house_number := NULL; NEW.postal_code := NULL; NEW.city := NULL; NEW.phone := NULL;
    NEW.iban := NULL; NEW.account_holder := NULL; NEW.tax_id := NULL; NEW.social_security_number := NULL;
    NEW.health_insurance := NULL; NEW.other_employment := NULL; NEW.other_employment_note := NULL;
    NEW.emergency_contact_name := NULL; NEW.emergency_contact_phone := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_onboarding_wipe_after_approval ON public.employee_onboarding;
CREATE TRIGGER trg_onboarding_wipe_after_approval BEFORE UPDATE ON public.employee_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_wipe_after_approval();
REVOKE ALL ON FUNCTION public.onboarding_wipe_after_approval() FROM PUBLIC, anon, authenticated;
UPDATE public.employee_onboarding SET updated_at = updated_at WHERE status = 'approved' AND employee_id IS NOT NULL;

-- ── Stichtage ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._ret_year() RETURNS int LANGUAGE sql STABLE AS
$$ SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'Europe/Berlin'))::int $$;
-- Einträge VOR diesem Datum sind fällig (3 volle Kalenderjahre vorbei)
CREATE OR REPLACE FUNCTION public._ret_cut3() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT make_date(_ret_year() - 3, 1, 1) $$;
CREATE OR REPLACE FUNCTION public._ret_cut8() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT make_date(_ret_year() - 8, 1, 1) $$;

-- Ausgeschiedene, deren Frist abgelaufen ist
CREATE OR REPLACE FUNCTION public._ret_former_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT id FROM employees WHERE is_active = false AND end_date IS NOT NULL AND end_date < _ret_cut8()
$$;

-- Fällige Dateien je Kategorie: (bucket, name)
CREATE OR REPLACE FUNCTION public._ret_files(p_cat text)
RETURNS TABLE(bucket text, name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF p_cat = 'krank' THEN
    RETURN QUERY SELECT 'sick-certs'::text, s.certificate_file_path::text FROM sick_leave s
      WHERE s.certificate_file_path IS NOT NULL AND COALESCE(s.end_date, s.start_date) < _ret_cut3();
  ELSIF p_cat = 'lohn' THEN
    RETURN QUERY SELECT 'payroll-docs'::text, d.file_path::text FROM payroll_documents d
      WHERE d.file_path IS NOT NULL AND d.year < EXTRACT(YEAR FROM _ret_cut8())::int;
  ELSIF p_cat = 'ehemalige' THEN
    RETURN QUERY
      SELECT o.bucket_id::text, o.name::text FROM storage.objects o
      WHERE o.bucket_id IN ('sick-certs','payroll-docs','employee-documents','avatars')
        AND ( split_part(o.name, '/', 1) IN (SELECT f::text FROM _ret_former_ids() f)
           OR split_part(o.name, '/', 1) IN (SELECT p.id::text FROM profiles p WHERE p.employee_id IN (SELECT _ret_former_ids())) );
  ELSIF p_cat = 'verwaist' THEN
    RETURN QUERY
      SELECT o.bucket_id::text, o.name::text FROM storage.objects o
      WHERE o.created_at < now() - interval '1 day' AND (
           (o.bucket_id = 'sick-certs'         AND NOT EXISTS (SELECT 1 FROM sick_leave s WHERE s.certificate_file_path = o.name))
        OR (o.bucket_id = 'payroll-docs'       AND NOT EXISTS (SELECT 1 FROM payroll_documents d WHERE d.file_path = o.name))
        OR (o.bucket_id = 'employee-documents' AND NOT EXISTS (SELECT 1 FROM employee_documents d WHERE d.file_path = o.name))
        OR (o.bucket_id = 'avatars' AND split_part(o.name, '/', 1) NOT IN (SELECT id::text FROM employees UNION SELECT id::text FROM profiles)));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._file_exists(p_bucket text, p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT p_name IS NOT NULL AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = p_bucket AND name = p_name) $$;

-- ── Übersicht (Admin) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.retention_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c3 date := _ret_cut3(); c8 date := _ret_cut8(); y int := _ret_year(); cats jsonb := '[]'::jsonb;
  n int; nx date; files jsonb;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;

  -- zeiten
  SELECT (SELECT count(*) FROM time_entries WHERE date < c3) + (SELECT count(*) FROM shifts WHERE date < c3)
       + (SELECT count(*) FROM vacation_requests WHERE end_date < c3) + (SELECT count(*) FROM time_corrections WHERE created_at < c3)
    INTO n;
  SELECT make_date(EXTRACT(YEAR FROM LEAST((SELECT min(date) FROM time_entries), (SELECT min(date) FROM shifts),
         (SELECT min(end_date) FROM vacation_requests)))::int + 4, 1, 1) INTO nx;
  cats := cats || jsonb_build_object('key','zeiten','title','Arbeitszeiten, Schichten & Urlaub',
    'rule','3 volle Kalenderjahre nach dem Jahr des Eintrags', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END, 'files', '[]'::jsonb);

  -- krank
  SELECT count(*) INTO n FROM sick_leave WHERE COALESCE(end_date, start_date) < c3;
  SELECT make_date(EXTRACT(YEAR FROM min(COALESCE(end_date, start_date)))::int + 4, 1, 1) INTO nx FROM sick_leave;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket, 'name', name)), '[]'::jsonb) INTO files FROM _ret_files('krank');
  cats := cats || jsonb_build_object('key','krank','title','Krankmeldungen & AU-Bescheinigungen',
    'rule','3 volle Kalenderjahre nach Ende der Krankmeldung', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END, 'files', files);

  -- lohn
  SELECT (SELECT count(*) FROM payroll_documents WHERE year < EXTRACT(YEAR FROM c8)::int)
       + (SELECT count(*) FROM payroll_months WHERE year < EXTRACT(YEAR FROM c8)::int) INTO n;
  SELECT make_date(LEAST((SELECT min(year) FROM payroll_documents), (SELECT min(year) FROM payroll_months)) + 9, 1, 1) INTO nx;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket, 'name', name)), '[]'::jsonb) INTO files FROM _ret_files('lohn');
  cats := cats || jsonb_build_object('key','lohn','title','Lohnabrechnungen',
    'rule','8 volle Kalenderjahre nach dem Abrechnungsjahr', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END, 'files', files);

  -- ehemalige
  SELECT count(*) INTO n FROM _ret_former_ids();
  SELECT make_date(EXTRACT(YEAR FROM min(end_date))::int + 9, 1, 1) INTO nx FROM employees WHERE is_active = false AND end_date IS NOT NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket, 'name', name)), '[]'::jsonb) INTO files FROM _ret_files('ehemalige');
  cats := cats || jsonb_build_object('key','ehemalige','title','Ausgeschiedene Mitarbeiter (komplett)',
    'rule','8 volle Kalenderjahre nach dem Austrittsjahr', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END, 'files', files,
    'names', COALESCE((SELECT jsonb_agg(first_name || ' ' || last_name) FROM employees WHERE id IN (SELECT _ret_former_ids())), '[]'::jsonb),
    'missing_end_date', (SELECT count(*) FROM employees WHERE is_active = false AND end_date IS NULL));

  -- protokoll
  SELECT count(*) INTO n FROM activity_log WHERE created_at < c3;
  SELECT make_date(EXTRACT(YEAR FROM min(created_at AT TIME ZONE 'Europe/Berlin'))::int + 4, 1, 1) INTO nx FROM activity_log;
  cats := cats || jsonb_build_object('key','protokoll','title','Aktivitätsprotokoll',
    'rule','3 volle Kalenderjahre', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END, 'files', '[]'::jsonb);

  -- einladungen
  SELECT count(*) INTO n FROM invitations WHERE created_at < now() - interval '6 months'
    AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now());
  cats := cats || jsonb_build_object('key','einladungen','title','Alte Einladungen',
    'rule','6 Monate nach Nutzung, Ablauf oder Rückzug', 'due', n, 'next_due', NULL, 'files', '[]'::jsonb);

  -- verwaist
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket, 'name', name)), '[]'::jsonb) INTO files FROM _ret_files('verwaist');
  cats := cats || jsonb_build_object('key','verwaist','title','Verwaiste Dateien (ohne Datensatz)',
    'rule','sofort – gehören zu keinem Eintrag mehr', 'due', jsonb_array_length(files), 'next_due', NULL, 'files', files);

  RETURN jsonb_build_object('success', true, 'year', y, 'categories', cats,
    'total_due', (SELECT COALESCE(sum((c->>'due')::int), 0) FROM jsonb_array_elements(cats) c));
END $$;

-- ── Löschen (Admin, serverseitig geprüft) ────────────────────
CREATE OR REPLACE FUNCTION public.retention_purge(p_cat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c3 date := _ret_cut3(); c8 date := _ret_cut8(); n int := 0; k int; skipped int := 0; v_label text;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;

  IF p_cat = 'zeiten' THEN
    DELETE FROM time_corrections WHERE created_at < c3 OR time_entry_id IN (SELECT id FROM time_entries WHERE date < c3);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM shift_swap_requests WHERE requester_shift_id IN (SELECT id FROM shifts WHERE date < c3)
                                       OR target_shift_id IN (SELECT id FROM shifts WHERE date < c3);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM time_entries WHERE date < c3;       GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM shifts WHERE date < c3;             GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM vacation_requests WHERE end_date < c3; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    v_label := 'Arbeitszeiten, Schichten & Urlaub';

  ELSIF p_cat = 'krank' THEN
    SELECT count(*) INTO skipped FROM sick_leave WHERE COALESCE(end_date, start_date) < c3 AND _file_exists('sick-certs', certificate_file_path);
    DELETE FROM sick_leave WHERE COALESCE(end_date, start_date) < c3 AND NOT _file_exists('sick-certs', certificate_file_path);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_label := 'Krankmeldungen';

  ELSIF p_cat = 'lohn' THEN
    SELECT count(*) INTO skipped FROM payroll_documents WHERE year < EXTRACT(YEAR FROM c8)::int AND _file_exists('payroll-docs', file_path);
    DELETE FROM payroll_documents WHERE year < EXTRACT(YEAR FROM c8)::int AND NOT _file_exists('payroll-docs', file_path);
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM payroll_months WHERE year < EXTRACT(YEAR FROM c8)::int; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    v_label := 'Lohnabrechnungen';

  ELSIF p_cat = 'ehemalige' THEN
    IF EXISTS (SELECT 1 FROM _ret_files('ehemalige')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Es gibt noch Dateien dieser Mitarbeiter. Bitte erneut versuchen.');
    END IF;
    -- Verweise lösen, die das Löschen blockieren würden
    UPDATE vacation_requests SET approved_by = NULL WHERE approved_by IN (SELECT _ret_former_ids());
    DELETE FROM shift_swap_requests WHERE requester_id IN (SELECT _ret_former_ids()) OR target_id IN (SELECT _ret_former_ids())
      OR requester_shift_id IN (SELECT id FROM shifts WHERE employee_id IN (SELECT _ret_former_ids()))
      OR target_shift_id IN (SELECT id FROM shifts WHERE employee_id IN (SELECT _ret_former_ids()));
    DELETE FROM time_corrections WHERE employee_id IN (SELECT _ret_former_ids());
    DELETE FROM employee_onboarding WHERE employee_id IN (SELECT _ret_former_ids());
    -- App-Zugänge der Ehemaligen (falls noch vorhanden) entfernen – nie den Inhaber
    DELETE FROM auth.users WHERE id IN (SELECT id FROM profiles WHERE employee_id IN (SELECT _ret_former_ids()) AND NOT is_owner);
    UPDATE profiles SET employee_id = NULL WHERE employee_id IN (SELECT _ret_former_ids());
    DELETE FROM employees WHERE id IN (SELECT _ret_former_ids());   -- löscht Rest per ON DELETE CASCADE
    GET DIAGNOSTICS n = ROW_COUNT;
    v_label := 'ausgeschiedene Mitarbeiter';

  ELSIF p_cat = 'protokoll' THEN
    DELETE FROM activity_log WHERE created_at < c3; GET DIAGNOSTICS n = ROW_COUNT;
    v_label := 'Protokolleinträge';

  ELSIF p_cat = 'einladungen' THEN
    UPDATE employee_onboarding SET invitation_id = NULL WHERE invitation_id IN (
      SELECT id FROM invitations WHERE created_at < now() - interval '6 months' AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now()));
    DELETE FROM invitations WHERE created_at < now() - interval '6 months' AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now());
    GET DIAGNOSTICS n = ROW_COUNT;
    v_label := 'alte Einladungen';

  ELSIF p_cat = 'verwaist' THEN
    SELECT count(*) INTO skipped FROM _ret_files('verwaist');   -- Dateien löscht die App über die Storage-API
    v_label := 'verwaiste Dateien';
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Unbekannte Kategorie.');
  END IF;

  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_name, metadata)
  SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role, 'retention.purged', 'settings',
         COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email) || ' hat Daten nach Ablauf der Aufbewahrungsfrist gelöscht: '
           || v_label || ' (' || n || ' Einträge).', 'retention', p_cat, jsonb_build_object('deleted', n, 'skipped', skipped)
  FROM profiles WHERE id = auth.uid();
  RETURN jsonb_build_object('success', true, 'deleted', n, 'skipped', skipped);
END $$;

REVOKE ALL ON FUNCTION public._ret_year(), public._ret_cut3(), public._ret_cut8(), public._ret_former_ids(),
  public._ret_files(text), public._file_exists(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retention_overview(), public.retention_purge(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retention_overview(), public.retention_purge(text) TO authenticated;
