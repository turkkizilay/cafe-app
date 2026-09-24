-- ============================================================
-- 14 · Korrekturen nach unabhängiger Prüfung
-- Bereits live eingespielt (Migration review_fixes) — NICHT erneut ausführen.
-- ============================================================

-- (a) Option „Einclocken nur über Café-WLAN“ (GPS lässt sich technisch fälschen)
ALTER TABLE public.cafe_settings ADD COLUMN IF NOT EXISTS clock_require_network boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public._clock_location(p_lat numeric, p_lng numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s cafe_settings%ROWTYPE; v_ip inet; v_net uuid; v_gps_conf boolean; v_net_conf boolean; v_gps_ok boolean := false; v_net_only boolean;
BEGIN
  SELECT * INTO s FROM cafe_settings WHERE id = 1;
  v_net_conf := EXISTS (SELECT 1 FROM cafe_networks);
  v_net_only := COALESCE(s.clock_require_network, false) AND v_net_conf;
  v_gps_conf := s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL AND NOT v_net_only;
  IF v_gps_conf AND p_lat IS NOT NULL AND p_lng IS NOT NULL
     AND p_lat BETWEEN -90 AND 90 AND p_lng BETWEEN -180 AND 180 THEN
    v_gps_ok := _dist_m(p_lat, p_lng, s.gps_lat, s.gps_lng) <= COALESCE(s.gps_radius_m, 50);
  END IF;
  v_ip := _client_ip();
  IF v_net_conf AND v_ip IS NOT NULL THEN
    SELECT id INTO v_net FROM cafe_networks WHERE cidr >>= v_ip ORDER BY masklen(cidr) DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object('required', v_gps_conf OR v_net_conf, 'gps_ok', v_gps_ok,
                            'net_ok', v_net IS NOT NULL, 'net_id', v_net, 'net_only', v_net_only);
END $$;

CREATE OR REPLACE FUNCTION public.clock_network_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE loc jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT is_approved() THEN
    RETURN jsonb_build_object('configured', false, 'net_ok', false, 'net_only', false);
  END IF;
  loc := _clock_location(NULL, NULL);
  RETURN jsonb_build_object('configured', EXISTS (SELECT 1 FROM cafe_networks), 'net_ok', (loc->>'net_ok')::boolean,
                            'net_only', (loc->>'net_only')::boolean);
END $$;

-- (b) Inhaber-Schutz auch für den Mitarbeiter-Datensatz und Name/E-Mail
CREATE OR REPLACE FUNCTION public.protect_owner_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'INSERT' THEN NEW.is_owner := false; RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner AND auth.uid() <> OLD.id THEN
      RAISE EXCEPTION 'Der Zugang des Inhabers kann nur vom Inhaber selbst gelöscht werden.';
    END IF;
    RETURN OLD;
  END IF;
  NEW.is_owner := OLD.is_owner;
  IF OLD.is_owner AND auth.uid() <> OLD.id
     AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.email IS DISTINCT FROM OLD.email
          OR NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name) THEN
    RAISE EXCEPTION 'Zugang und Daten des Inhabers kann nur der Inhaber selbst ändern.';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.protect_owner_employee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE employee_id = OLD.id AND is_owner AND id <> auth.uid()) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Der Mitarbeiter-Eintrag des Inhabers kann nur vom Inhaber selbst gelöscht werden.';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.end_date IS DISTINCT FROM OLD.end_date
       OR NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Nur der Inhaber selbst kann seinen Eintrag deaktivieren oder ändern.';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_protect_owner_employee ON public.employees;
CREATE TRIGGER trg_protect_owner_employee BEFORE UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.protect_owner_employee();
REVOKE ALL ON FUNCTION public.protect_owner_employee() FROM PUBLIC, anon, authenticated;

-- Inhaber nie in „ausgeschiedene Mitarbeiter“
CREATE OR REPLACE FUNCTION public._ret_former_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT e.id FROM employees e WHERE e.is_active = false AND e.end_date IS NOT NULL AND e.end_date < _ret_cut8()
    AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.employee_id = e.id AND p.is_owner)
$$;
REVOKE ALL ON FUNCTION public._ret_former_ids() FROM PUBLIC, anon, authenticated;

-- (c) Löschen: erst Probelauf (ohne Dateien), dann Dateien, dann echte Löschung
ALTER FUNCTION public.retention_purge(text) RENAME TO _retention_purge_do;
CREATE OR REPLACE FUNCTION public._retention_purge_do(p_cat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
END $$;
REVOKE ALL ON FUNCTION public._retention_purge_do(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retention_purge(p_cat text, p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE res jsonb;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  IF NOT p_dry_run THEN
    BEGIN
      RETURN _retention_purge_do(p_cat);
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
    END;
  END IF;
  -- Probelauf: alles ausführen und dann zurückrollen
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
END $$;
REVOKE ALL ON FUNCTION public.retention_purge(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retention_purge(text, boolean) TO authenticated;

-- (d) Sicherung ohne Geheimnisse (Einladungs-Token, Webhook-Secrets …)
CREATE OR REPLACE FUNCTION public._backup_scrub(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(j) AS e(k, v) WHERE k !~* '(token|secret|password)'
$$;
CREATE OR REPLACE FUNCTION public._backup_build()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t record; v jsonb; data jsonb := '{}'::jsonb; counts jsonb := '{}'::jsonb; files jsonb;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name LOOP
    CONTINUE WHEN _backup_excluded(t.table_name);
    EXECUTE format('SELECT COALESCE(jsonb_agg(public._backup_scrub(to_jsonb(x))), ''[]''::jsonb) FROM public.%I x', t.table_name) INTO v;
    data   := data   || jsonb_build_object(t.table_name, v);
    counts := counts || jsonb_build_object(t.table_name, jsonb_array_length(v));
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'name', name,
           'size', (metadata->>'size')::bigint, 'created_at', created_at) ORDER BY bucket_id, name), '[]'::jsonb)
    INTO files FROM storage.objects;
  RETURN jsonb_build_object(
    'meta', jsonb_build_object('app', 'Café Buur Personalverwaltung', 'format', 1,
                               'created_at', now(), 'counts', counts,
                               'hinweis', 'Enthält sensible Personaldaten. Sicher aufbewahren, nicht per E-Mail versenden.'),
    'tables', data,
    'files', files);
END $$;
REVOKE ALL ON FUNCTION public._backup_scrub(jsonb), public._backup_build() FROM PUBLIC, anon, authenticated;
-- vorhandene Sicherungen nachträglich bereinigen
UPDATE public.backup_snapshots b SET data = jsonb_set(b.data, '{tables}',
  (SELECT COALESCE(jsonb_object_agg(tk, (SELECT COALESCE(jsonb_agg(public._backup_scrub(r)), '[]'::jsonb) FROM jsonb_array_elements(tv) r)), '{}'::jsonb)
   FROM jsonb_each(b.data->'tables') AS t(tk, tv)));

-- (e) Erinnerung richtet sich nach dem STAND der heruntergeladenen Sicherung
CREATE OR REPLACE FUNCTION public.backup_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  RETURN jsonb_build_object('success', true,
    'last_download_at', (SELECT max(created_at) FROM backup_snapshots WHERE downloaded_at IS NOT NULL),
    'backups', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'kind', kind,
                 'size_bytes', size_bytes, 'counts', counts, 'downloaded_at', downloaded_at) ORDER BY created_at DESC)
               FROM backup_snapshots), '[]'::jsonb));
END $$;

-- (f) Push nur an echte Push-Dienste
CREATE OR REPLACE FUNCTION public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT is_approved() THEN RETURN jsonb_build_object('success', false, 'error', 'Nicht angemeldet.'); END IF;
  IF p_endpoint IS NULL OR length(p_endpoint) > 1000
     OR p_endpoint !~ '^https://(fcm\.googleapis\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|push\.api\.chrome\.google\.com)/'
     OR p_p256dh IS NULL OR length(p_p256dh) NOT BETWEEN 80 AND 100 OR p_auth IS NULL OR length(p_auth) NOT BETWEEN 16 AND 30 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Dieser Browser wird für Benachrichtigungen nicht unterstützt.');
  END IF;
  INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent)
  VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth, LEFT(p_ua, 200))
  ON CONFLICT (endpoint) DO UPDATE SET profile_id = auth.uid(), p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
    user_agent = EXCLUDED.user_agent, created_at = now();
  DELETE FROM push_subscriptions WHERE profile_id = auth.uid() AND id NOT IN
    (SELECT id FROM push_subscriptions WHERE profile_id = auth.uid() ORDER BY created_at DESC LIMIT 10);
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.push_subscribe(text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_subscribe(text,text,text,text) TO authenticated;

-- ── Nachtrag (Migration review_fixes_2) ─────────────────────
-- Inhaber: auch IBAN, Kontoinhaber und Stundenlohn nur durch den Inhaber selbst.
-- protect_owner_employee(): zusätzlich iban, account_holder, hourly_rate geprüft.
-- cafe_network_remove(): wird das letzte Café-WLAN entfernt, wird
-- cafe_settings.clock_require_network automatisch ausgeschaltet.
