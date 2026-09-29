-- ============================================================
-- Testvorlage: go-live-relevante Production-Funktionen, die NICHT in schema_before_17.sql enthalten sind
-- (pg_get_functiondef, read-only abgerufen 2026-09-29): Konto selbst löschen, Freischaltung alter Registrierungen,
-- Onboarding-Korrektur anfordern, Aufbewahrungs-Löschung (inkl. Hilfsfunktionen), eigene Personaldaten, Protokoll.
-- Nur Struktur/Logik, keine Daten. Wird NACH lifecycle_functions.sql geladen (_onb_log).
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); p profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('success', false, 'error', 'Nicht angemeldet.'); END IF;
  SELECT * INTO p FROM profiles WHERE id = v_uid;

  IF p.role = 'admin' AND p.status = 'approved' AND NOT EXISTS (
       SELECT 1 FROM profiles WHERE role = 'admin' AND status = 'approved' AND id <> v_uid) THEN
    RETURN json_build_object('success', false, 'error',
      'Du bist der einzige Admin. Bitte ernenne zuerst eine andere Person zum Admin, sonst kann niemand mehr die App verwalten.');
  END IF;
  IF p.employee_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM time_entries WHERE employee_id = p.employee_id AND clock_out IS NULL) THEN
    RETURN json_build_object('success', false, 'error', 'Du bist noch eingestempelt. Bitte zuerst ausstempeln.');
  END IF;

  PERFORM _onb_log('account.deleted', 'hat das eigene App-Konto gelöscht.', v_uid::text,
                   COALESCE(NULLIF(TRIM(CONCAT(p.first_name,' ',p.last_name)),''), p.email));

  IF p.employee_id IS NOT NULL THEN
    UPDATE employees SET avatar_url = NULL WHERE id = p.employee_id;
  END IF;
  DELETE FROM auth.users WHERE id = v_uid;   -- Profil & Registrierung werden automatisch mitgelöscht
  RETURN json_build_object('success', true);
END $function$;

CREATE OR REPLACE FUNCTION public.approve_user(p_profile_id uuid, p_role text, p_employee_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE emp RECORD;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_role NOT IN ('employee','manager','admin') THEN RAISE EXCEPTION 'Ungültige Rolle.'; END IF;
  IF p_employee_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM profiles WHERE employee_id = p_employee_id AND id <> p_profile_id) THEN
    RAISE EXCEPTION 'Dieser Mitarbeiter ist bereits mit einem anderen Konto verknüpft.';
  END IF;
  SELECT first_name, last_name INTO emp FROM employees WHERE id = p_employee_id;
  UPDATE profiles
     SET status = 'approved', role = p_role, employee_id = p_employee_id,
         approved_at = COALESCE(approved_at, NOW()), approved_by = COALESCE(approved_by, auth.uid()),
         first_name = COALESCE(NULLIF(emp.first_name,''), first_name),
         last_name  = COALESCE(NULLIF(emp.last_name,''),  last_name)
   WHERE id = p_profile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profil nicht gefunden.'; END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.request_onboarding_changes(p_id uuid, p_note text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE o employee_onboarding%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NULLIF(TRIM(COALESCE(p_note,'')),'') IS NULL THEN RETURN json_build_object('success', false, 'error', 'Bitte schreibe kurz, was korrigiert werden soll.'); END IF;
  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'submitted' THEN RETURN json_build_object('success', false, 'error', 'Diese Einreichung kann gerade nicht zurückgeschickt werden.'); END IF;
  UPDATE employee_onboarding SET status = 'changes_requested', review_note = TRIM(p_note), reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW() WHERE id = p_id;
  PERFORM _onb_log('employee.onboarding_changes_requested', 'hat Korrekturen an den Angaben von ' || CONCAT(o.first_name,' ',o.last_name) || ' angefordert.', o.id::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true);
END; $function$;

CREATE OR REPLACE FUNCTION public._ret_year() RETURNS integer LANGUAGE sql STABLE
AS $function$ SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'Europe/Berlin'))::int $function$;
CREATE OR REPLACE FUNCTION public._ret_cut3() RETURNS date LANGUAGE sql STABLE
AS $function$ SELECT make_date(_ret_year() - 3, 1, 1) $function$;
CREATE OR REPLACE FUNCTION public._ret_cut8() RETURNS date LANGUAGE sql STABLE
AS $function$ SELECT make_date(_ret_year() - 8, 1, 1) $function$;

CREATE OR REPLACE FUNCTION public._file_exists(p_bucket text, p_name text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT p_name IS NOT NULL AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = p_bucket AND name = p_name) $function$;

CREATE OR REPLACE FUNCTION public._ret_former_ids()
 RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT e.id FROM employees e WHERE e.is_active = false AND e.end_date IS NOT NULL AND e.end_date < _ret_cut8()
    AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.employee_id = e.id AND p.is_owner)
$function$;

CREATE OR REPLACE FUNCTION public._ret_files(p_cat text)
 RETURNS TABLE(bucket text, name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
END $function$;

CREATE OR REPLACE FUNCTION public._retention_purge_do(p_cat text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c3 date := _ret_cut3(); c8 date := _ret_cut8(); n int := 0; k int; skipped int := 0; v_label text;
  v_dry boolean := COALESCE(current_setting('app.retention_dry_run', true), '') = 'on';
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  IF p_cat = 'zeiten' THEN
    DELETE FROM time_corrections WHERE created_at < c3 OR time_entry_id IN (SELECT id FROM time_entries WHERE date < c3);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM shift_swap_requests WHERE requester_shift_id IN (SELECT id FROM shifts WHERE date < c3)
                                       OR target_shift_id IN (SELECT id FROM shifts WHERE date < c3);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM time_entries WHERE date < c3;          GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM shifts WHERE date < c3;                GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM vacation_requests WHERE end_date < c3; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    v_label := 'Arbeitszeiten, Schichten & Urlaub';
  ELSIF p_cat = 'krank' THEN
    SELECT count(*) INTO skipped FROM sick_leave WHERE COALESCE(end_date, start_date) < c3 AND _file_exists('sick-certs', certificate_file_path);
    DELETE FROM sick_leave WHERE COALESCE(end_date, start_date) < c3 AND (v_dry OR NOT _file_exists('sick-certs', certificate_file_path));
    GET DIAGNOSTICS n = ROW_COUNT;
    v_label := 'Krankmeldungen';
  ELSIF p_cat = 'lohn' THEN
    SELECT count(*) INTO skipped FROM payroll_documents WHERE year < EXTRACT(YEAR FROM c8)::int AND _file_exists('payroll-docs', file_path);
    DELETE FROM payroll_documents WHERE year < EXTRACT(YEAR FROM c8)::int AND (v_dry OR NOT _file_exists('payroll-docs', file_path));
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM payroll_months WHERE year < EXTRACT(YEAR FROM c8)::int; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    v_label := 'Lohnabrechnungen';
  ELSIF p_cat = 'ehemalige' THEN
    IF NOT v_dry AND EXISTS (SELECT 1 FROM _ret_files('ehemalige')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Es gibt noch Dateien dieser Mitarbeiter. Bitte erneut versuchen.');
    END IF;
    UPDATE vacation_requests SET approved_by = NULL WHERE approved_by IN (SELECT _ret_former_ids());
    DELETE FROM shift_swap_requests WHERE requester_id IN (SELECT _ret_former_ids()) OR target_id IN (SELECT _ret_former_ids())
      OR requester_shift_id IN (SELECT id FROM shifts WHERE employee_id IN (SELECT _ret_former_ids()))
      OR target_shift_id IN (SELECT id FROM shifts WHERE employee_id IN (SELECT _ret_former_ids()));
    DELETE FROM time_corrections WHERE employee_id IN (SELECT _ret_former_ids());
    DELETE FROM employee_onboarding WHERE employee_id IN (SELECT _ret_former_ids());
    DELETE FROM auth.users WHERE id IN (SELECT id FROM profiles WHERE employee_id IN (SELECT _ret_former_ids()) AND NOT is_owner);
    UPDATE profiles SET employee_id = NULL WHERE employee_id IN (SELECT _ret_former_ids());
    DELETE FROM employees WHERE id IN (SELECT _ret_former_ids());
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
    SELECT count(*) INTO skipped FROM _ret_files('verwaist');
    v_label := 'verwaiste Dateien';
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Unbekannte Kategorie.');
  END IF;
  IF NOT v_dry THEN
    INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_name, metadata)
    SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role, 'retention.purged', 'settings',
           COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email) || ' hat Daten nach Ablauf der Aufbewahrungsfrist gelöscht: '
             || v_label || ' (' || n || ' Einträge).', 'retention', p_cat, jsonb_build_object('deleted', n, 'skipped', skipped)
    FROM profiles WHERE id = auth.uid();
  END IF;
  RETURN jsonb_build_object('success', true, 'deleted', n, 'skipped', skipped);
END $function$;

CREATE OR REPLACE FUNCTION public.retention_purge(p_cat text, p_dry_run boolean DEFAULT false, p_deleted_files jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE res jsonb; v_list text; v_cnt int;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  IF NOT p_dry_run THEN
    BEGIN
      res := _retention_purge_do(p_cat);
      IF COALESCE((res->>'success')::boolean, false) AND jsonb_typeof(p_deleted_files) = 'array' AND jsonb_array_length(p_deleted_files) > 0 THEN
        v_cnt := jsonb_array_length(p_deleted_files);
        SELECT string_agg(cnt || '× ' || kind || ' von ' || emp, ', ' ORDER BY emp, kind) INTO v_list FROM (
          SELECT LEFT(f->>'kind', 40) kind, LEFT(f->>'employee', 60) emp, count(*) cnt
          FROM jsonb_array_elements(p_deleted_files) f GROUP BY 1, 2) z;
        UPDATE activity_log SET
          summary = LEFT(regexp_replace(summary, ' \(0 Einträge\)\.$', '.'), 300) || ' Dateien: ' || v_cnt || ' (' || LEFT(v_list, 600) || ').',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('files', (
            SELECT jsonb_agg(jsonb_build_object('kind', LEFT(f->>'kind', 40), 'employee', LEFT(f->>'employee', 60),
                   'uploaded_at', f->>'uploaded_at', 'size', f->>'size')) FROM jsonb_array_elements(p_deleted_files) f))
        WHERE id = (SELECT id FROM activity_log WHERE action = 'retention.purged' AND actor_id = auth.uid() ORDER BY created_at DESC LIMIT 1);
        res := res || jsonb_build_object('files_logged', v_cnt);
      END IF;
      RETURN res;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
    END;
  END IF;
  BEGIN
    PERFORM set_config('app.retention_dry_run', 'on', true);
    res := _retention_purge_do(p_cat);
    IF NOT COALESCE((res->>'success')::boolean, false) THEN
      PERFORM set_config('app.retention_dry_run', '', true);
      RETURN res;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'dry-run';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      PERFORM set_config('app.retention_dry_run', '', true);
      RETURN jsonb_build_object('success', true, 'dry_run', true);
    WHEN OTHERS THEN
      PERFORM set_config('app.retention_dry_run', '', true);
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;
END $function$;

CREATE OR REPLACE FUNCTION public.log_activity(p_action text, p_category text, p_summary text, p_actor_name text DEFAULT NULL::text, p_actor_role text DEFAULT NULL::text, p_target_type text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_target_name text DEFAULT NULL::text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_role text; v_name text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Nicht authentifiziert'; END IF;
  SELECT role, COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email, 'Unbekannt')
    INTO v_role, v_name FROM profiles WHERE id = auth.uid();
  IF length(COALESCE(p_summary,'')) > 500 OR length(COALESCE(p_action,'')) > 80 THEN
    RAISE EXCEPTION 'Eintrag zu lang.';
  END IF;
  IF p_summary ~ '^[a-zäöü]' THEN p_summary := v_name || ' ' || p_summary; END IF;
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary,
                            target_type, target_id, target_name, metadata)
  VALUES (auth.uid(), v_name, v_role, p_action, p_category, p_summary,
          p_target_type, p_target_id, p_target_name, p_metadata)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public.update_own_personal_data(p_data jsonb)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_emp   uuid;
  e       employees%ROWTYPE;
  n       employees%ROWTYPE;
  v_birth date;
  v_iban  text; v_tax text; v_sv text; v_plz text;
  v_other boolean;
  v_changed text[] := ARRAY[]::text[];
  v_name  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht angemeldet.');
  END IF;
  SELECT employee_id INTO v_emp FROM profiles WHERE id = auth.uid() AND status = 'approved';
  IF v_emp IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Mitarbeiter-Profil verknüpft.');
  END IF;
  SELECT * INTO e FROM employees WHERE id = v_emp FOR UPDATE;

  v_iban := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'iban',''), '\s', '', 'g')), '');
  v_tax  := NULLIF(REGEXP_REPLACE(COALESCE(p_data->>'tax_id',''), '\s', '', 'g'), '');
  v_sv   := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'social_security_number',''), '\s', '', 'g')), '');
  v_plz  := NULLIF(TRIM(COALESCE(p_data->>'postal_code','')), '');
  BEGIN
    v_birth := NULLIF(p_data->>'birth_date','')::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'Das Geburtsdatum ist ungültig.', 'field', 'birth_date');
  END;
  BEGIN
    v_other := CASE WHEN p_data->>'other_employment' IS NULL THEN NULL ELSE (p_data->>'other_employment')::boolean END;
  EXCEPTION WHEN OTHERS THEN
    v_other := NULL;
  END;

  IF v_birth IS NOT NULL AND (v_birth > CURRENT_DATE - INTERVAL '14 years' OR v_birth < CURRENT_DATE - INTERVAL '100 years') THEN
    RETURN json_build_object('success', false, 'error', 'Bitte prüfe dein Geburtsdatum.', 'field', 'birth_date');
  END IF;
  IF v_plz IS NOT NULL AND v_plz !~ '^[0-9]{5}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Postleitzahl muss 5 Ziffern haben.', 'field', 'postal_code');
  END IF;
  IF v_iban IS NOT NULL AND (v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' OR (v_iban LIKE 'DE%' AND LENGTH(v_iban) <> 22)) THEN
    RETURN json_build_object('success', false, 'error', 'Die IBAN ist ungültig.', 'field', 'iban');
  END IF;
  IF v_tax IS NOT NULL AND v_tax !~ '^[0-9]{11}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Steuer-ID besteht aus 11 Ziffern.', 'field', 'tax_id');
  END IF;
  IF v_sv IS NOT NULL AND v_sv !~ '^[0-9]{8}[A-Z][0-9]{3}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Sozialversicherungsnummer hat das Format 12 345678 A 123.', 'field', 'social_security_number');
  END IF;

  UPDATE employees SET
    birth_name = CASE WHEN p_data ? 'birth_name' THEN NULLIF(TRIM(COALESCE(p_data->>'birth_name','')), '') ELSE birth_name END,
    birth_date = CASE WHEN p_data ? 'birth_date' THEN v_birth ELSE birth_date END,
    birth_place = CASE WHEN p_data ? 'birth_place' THEN NULLIF(TRIM(COALESCE(p_data->>'birth_place','')), '') ELSE birth_place END,
    nationality = CASE WHEN p_data ? 'nationality' THEN NULLIF(TRIM(COALESCE(p_data->>'nationality','')), '') ELSE nationality END,
    street = CASE WHEN p_data ? 'street' THEN NULLIF(TRIM(COALESCE(p_data->>'street','')), '') ELSE street END,
    house_number = CASE WHEN p_data ? 'house_number' THEN NULLIF(TRIM(COALESCE(p_data->>'house_number','')), '') ELSE house_number END,
    postal_code = CASE WHEN p_data ? 'postal_code' THEN v_plz ELSE postal_code END,
    city = CASE WHEN p_data ? 'city' THEN NULLIF(TRIM(COALESCE(p_data->>'city','')), '') ELSE city END,
    phone = CASE WHEN p_data ? 'phone' THEN NULLIF(TRIM(COALESCE(p_data->>'phone','')), '') ELSE phone END,
    iban = CASE WHEN p_data ? 'iban' THEN v_iban ELSE iban END,
    account_holder = CASE WHEN p_data ? 'account_holder' THEN NULLIF(TRIM(COALESCE(p_data->>'account_holder','')), '') ELSE account_holder END,
    tax_id = CASE WHEN p_data ? 'tax_id' THEN v_tax ELSE tax_id END,
    social_security_number = CASE WHEN p_data ? 'social_security_number' THEN v_sv ELSE social_security_number END,
    health_insurance = CASE WHEN p_data ? 'health_insurance' THEN NULLIF(TRIM(COALESCE(p_data->>'health_insurance','')), '') ELSE health_insurance END,
    other_employment = CASE WHEN p_data ? 'other_employment' THEN v_other ELSE other_employment END,
    other_employment_note = CASE WHEN p_data ? 'other_employment_note' THEN CASE WHEN v_other THEN NULLIF(TRIM(COALESCE(p_data->>'other_employment_note','')), '') ELSE NULL END ELSE other_employment_note END,
    emergency_contact_name = CASE WHEN p_data ? 'emergency_contact_name' THEN NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_name','')), '') ELSE emergency_contact_name END,
    emergency_contact_phone = CASE WHEN p_data ? 'emergency_contact_phone' THEN NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_phone','')), '') ELSE emergency_contact_phone END
  WHERE id = v_emp
  RETURNING * INTO n;

  IF n.street IS NOT NULL AND n.house_number IS NOT NULL AND n.postal_code IS NOT NULL AND n.city IS NOT NULL THEN
    UPDATE employees SET address = CONCAT(n.street,' ',n.house_number,', ',n.postal_code,' ',n.city) WHERE id = v_emp;
  END IF;

  IF e.iban IS DISTINCT FROM n.iban THEN v_changed := array_append(v_changed, 'Bankverbindung'::text); END IF;
  IF e.account_holder IS DISTINCT FROM n.account_holder AND NOT ('Bankverbindung' = ANY(v_changed)) THEN v_changed := array_append(v_changed, 'Bankverbindung'::text); END IF;
  IF e.tax_id IS DISTINCT FROM n.tax_id THEN v_changed := array_append(v_changed, 'Steuer-ID'::text); END IF;
  IF e.social_security_number IS DISTINCT FROM n.social_security_number THEN v_changed := array_append(v_changed, 'SV-Nummer'::text); END IF;
  IF e.health_insurance IS DISTINCT FROM n.health_insurance THEN v_changed := array_append(v_changed, 'Krankenkasse'::text); END IF;
  IF e.other_employment IS DISTINCT FROM n.other_employment OR e.other_employment_note IS DISTINCT FROM n.other_employment_note THEN v_changed := array_append(v_changed, 'weitere Beschäftigung'::text); END IF;
  IF (e.street, e.house_number, e.postal_code, e.city) IS DISTINCT FROM (n.street, n.house_number, n.postal_code, n.city) THEN v_changed := array_append(v_changed, 'Adresse'::text); END IF;
  IF e.phone IS DISTINCT FROM n.phone THEN v_changed := array_append(v_changed, 'Telefon'::text); END IF;
  IF (e.birth_date, e.birth_name, e.birth_place, e.nationality) IS DISTINCT FROM (n.birth_date, n.birth_name, n.birth_place, n.nationality) THEN v_changed := array_append(v_changed, 'Geburtsangaben'::text); END IF;
  IF (e.emergency_contact_name, e.emergency_contact_phone) IS DISTINCT FROM (n.emergency_contact_name, n.emergency_contact_phone) THEN v_changed := array_append(v_changed, 'Notfallkontakt'::text); END IF;

  IF array_length(v_changed, 1) > 0 THEN
    v_name := CONCAT(n.first_name,' ',n.last_name);
    PERFORM _onb_log('employee.personal_data_updated',
      'hat eigene Personaldaten geändert: ' || array_to_string(v_changed, ', ') || '.',
      v_emp::text, v_name);
  END IF;

  RETURN json_build_object('success', true, 'changed', to_json(v_changed));
END;
$function$;

-- Rechte wie in Production (read-only geprüft 2026-09-29): Hilfsfunktionen nicht per API, öffentliche nur für Angemeldete
REVOKE ALL ON FUNCTION public._retention_purge_do(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ret_former_ids() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ret_files(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._file_exists(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ret_cut3(), public._ret_cut8(), public._ret_year() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_user(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_onboarding_changes(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.retention_purge(text, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.log_activity(text, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_own_personal_data(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_own_personal_data(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_own_account(), public.approve_user(uuid, text, uuid), public.request_onboarding_changes(uuid, text),
  public.retention_purge(text, boolean, jsonb), public.log_activity(text, text, text, text, text, text, text, text, jsonb) TO authenticated;
