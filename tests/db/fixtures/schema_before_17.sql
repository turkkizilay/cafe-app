-- ============================================================
-- Testvorlage: Production-Schema (NUR Struktur, keine Daten) VOR Migration 17, Stand 2026-09-25.
-- Auszug aus einem schema-only pg_dump: die für Zeiterfassung, Rollen/RLS, Urlaub, Krankheit,
-- Schichten/Tausch, Onboarding und Lohn nötigen Tabellen, Funktionen, Trigger und Policies.
-- Darauf spielt tests/db/harness.mjs die Repository-Migrationen 17–23 in Reihenfolge ein.
-- Unterschiede zu Production: _push_kick() ist wirkungslos (kein Aufruf der Edge Function).
-- Keine Secrets, keine URLs, keine Personaldaten. Nicht auf einer echten Datenbank ausführen.
-- ============================================================
SET check_function_bodies = false;

-- FUNCTION: _client_ip()
CREATE FUNCTION public._client_ip() RETURNS inet
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE v text;
BEGIN
  v := NULLIF(TRIM((current_setting('request.headers', true))::json->>'cf-connecting-ip'), '');
  IF v IS NULL THEN RETURN NULL; END IF;
  RETURN v::inet;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

-- FUNCTION: _clock_location(numeric, numeric)
CREATE FUNCTION public._clock_location(p_lat numeric, p_lng numeric) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- FUNCTION: _clock_method(jsonb)
CREATE FUNCTION public._clock_method(loc jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN (loc->>'gps_ok')::boolean AND (loc->>'net_ok')::boolean THEN 'gps+wlan'
    WHEN (loc->>'gps_ok')::boolean THEN 'gps'
    WHEN (loc->>'net_ok')::boolean THEN 'wlan'
    WHEN NOT (loc->>'required')::boolean THEN 'ohne Prüfung'
    ELSE NULL END
$$;

-- FUNCTION: _d(date)
CREATE FUNCTION public._d(p date) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT to_char(p, 'DD.MM.') $$;

-- FUNCTION: _dist_m(numeric, numeric, numeric, numeric)
CREATE FUNCTION public._dist_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT (2 * 6371000 * asin(sqrt(
      power(sin(radians((lat2 - lat1)::float8) / 2), 2)
    + cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lng2 - lng1)::float8) / 2), 2)
  )))::numeric
$$;

-- FUNCTION: _emp_short(uuid)
CREATE FUNCTION public._emp_short(p_emp uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(NULLIF(TRIM(first_name || ' ' || LEFT(COALESCE(last_name,''), 1) || CASE WHEN COALESCE(last_name,'') <> '' THEN '.' ELSE '' END), ''), 'Ein Mitarbeiter')
  FROM employees WHERE id = p_emp
$$;

-- FUNCTION: _push_kick()
CREATE FUNCTION public._push_kick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$ BEGIN RETURN; END $$;  -- Branch: kein Aufruf der Production-Edge-Function

-- FUNCTION: _push_to_employee(uuid, text, text, text, text)
CREATE FUNCTION public._push_to_employee(p_emp uuid, p_title text, p_body text, p_url text, p_tag text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE pid uuid;
BEGIN
  FOR pid IN SELECT id FROM profiles WHERE employee_id = p_emp AND status = 'approved' LOOP
    PERFORM _push_to_profile(pid, p_title, p_body, p_url, p_tag);
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- FUNCTION: _push_to_profile(uuid, text, text, text, text)
CREATE FUNCTION public._push_to_profile(p_profile uuid, p_title text, p_body text, p_url text, p_tag text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_profile IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM push_subscriptions s JOIN profiles p ON p.id = s.profile_id
                 WHERE s.profile_id = p_profile AND p.status = 'approved') THEN RETURN; END IF;
  INSERT INTO push_outbox (profile_id, title, body, url, tag) VALUES (p_profile, LEFT(p_title, 120), LEFT(p_body, 240), p_url, p_tag);
  PERFORM _push_kick();
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- FUNCTION: _push_to_staff(boolean, text, text, text, text)
CREATE FUNCTION public._push_to_staff(p_with_managers boolean, p_title text, p_body text, p_url text, p_tag text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE pid uuid;
BEGIN
  FOR pid IN SELECT id FROM profiles WHERE status = 'approved'
               AND (role = 'admin' OR (p_with_managers AND role = 'manager'))
               AND id IS DISTINCT FROM auth.uid() LOOP
    PERFORM _push_to_profile(pid, p_title, p_body, p_url, p_tag);
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- FUNCTION: _wd(date)
CREATE FUNCTION public._wd(p date) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT (ARRAY['So','Mo','Di','Mi','Do','Fr','Sa'])[EXTRACT(DOW FROM p)::int + 1] $$;

-- FUNCTION: calc_continued_pay_end()
CREATE FUNCTION public.calc_continued_pay_end() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.continued_pay_end := NEW.start_date + INTERVAL '42 days';
  RETURN NEW;
END;
$$;

-- FUNCTION: is_admin()
CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM profiles WHERE id = auth.uid() AND status = 'approved'),
    false
  )
$$;

-- FUNCTION: is_approved()
CREATE FUNCTION public.is_approved() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE((SELECT status = 'approved' FROM profiles WHERE id = auth.uid()), false)
$$;

-- FUNCTION: is_manager_or_admin()
CREATE FUNCTION public.is_manager_or_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT role IN ('admin','manager') FROM profiles WHERE id = auth.uid() AND status = 'approved'),
    false
  )
$$;

-- FUNCTION: lock_profile_identity()
CREATE FUNCTION public.lock_profile_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF current_user = 'authenticated' AND NOT is_admin() THEN
    NEW.first_name := OLD.first_name;
    NEW.last_name  := OLD.last_name;
    NEW.email      := OLD.email;
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: my_employee_id()
CREATE FUNCTION public.my_employee_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT employee_id FROM profiles WHERE id = auth.uid() AND status = 'approved'
$$;

-- FUNCTION: my_is_active_employee()
CREATE FUNCTION public.my_is_active_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT e.is_active FROM employees e JOIN profiles p ON p.employee_id = e.id
      WHERE p.id = auth.uid() AND p.status = 'approved'),
    false)
$$;

-- FUNCTION: onboarding_wipe_after_approval()
CREATE FUNCTION public.onboarding_wipe_after_approval() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- FUNCTION: prevent_profile_privilege_escalation()
CREATE FUNCTION public.prevent_profile_privilege_escalation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT is_admin() AND coalesce(current_setting('app.bypass_privilege_trigger', true), '') <> 'on' THEN
    NEW.role        := OLD.role;
    NEW.status      := OLD.status;
    NEW.employee_id := OLD.employee_id;
    NEW.approved_at := OLD.approved_at;
    NEW.approved_by := OLD.approved_by;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: prevent_time_entry_backdating()
CREATE FUNCTION public.prevent_time_entry_backdating() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_total numeric; v_break int; loc jsonb;
BEGIN
  IF auth.uid() IS NULL OR is_admin() THEN RETURN NEW; END IF;
  NEW.employee_id     := OLD.employee_id;
  NEW.date            := OLD.date;
  NEW.clock_in        := OLD.clock_in;
  NEW.gps_lat_in      := OLD.gps_lat_in; NEW.gps_lng_in := OLD.gps_lng_in; NEW.gps_ok_in := OLD.gps_ok_in;
  NEW.clock_in_method := OLD.clock_in_method;
  NEW.approved        := OLD.approved;
  NEW.is_overtime     := OLD.is_overtime;
  NEW.overtime_hours  := OLD.overtime_hours;
  IF NEW.clock_out IS NOT NULL AND OLD.clock_out IS NULL THEN
    loc := _clock_location(NEW.gps_lat_out, NEW.gps_lng_out);
    IF (loc->>'required')::boolean AND NOT ((loc->>'gps_ok')::boolean OR (loc->>'net_ok')::boolean) THEN
      RAISE EXCEPTION 'Ausclocken geht nur im Café: Bitte GPS erlauben oder mit dem Café-WLAN verbinden.';
    END IF;
    IF (loc->>'net_ok')::boolean THEN
      UPDATE cafe_networks SET last_seen_at = now() WHERE id = (loc->>'net_id')::uuid;
    END IF;
    NEW.gps_ok_out       := (loc->>'gps_ok')::boolean;
    NEW.clock_out_method := _clock_method(loc);
    NEW.clock_out := now();
    v_total := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
    IF v_total > 12 THEN
      NEW.break_minutes := 0;
      NEW.hours_worked  := 0;
      NEW.notes := '⚠️ AUSSTEMPELN VERGESSEN – Zeit bitte korrigieren (' || ROUND(v_total::numeric, 1) || ' Std. offen)';
    ELSE
      v_break := COALESCE(OLD.break_minutes, 0);   -- nur tatsächlich erfasste Pause, keine automatische
      NEW.break_minutes := v_break;
      NEW.hours_worked  := ROUND(GREATEST(0, v_total - v_break / 60.0)::numeric, 2);
      NEW.notes := OLD.notes;
    END IF;
  ELSE
    NEW.clock_out        := OLD.clock_out;
    NEW.break_minutes    := OLD.break_minutes;
    NEW.hours_worked     := OLD.hours_worked;
    NEW.notes            := OLD.notes;
    NEW.gps_lat_out      := OLD.gps_lat_out; NEW.gps_lng_out := OLD.gps_lng_out; NEW.gps_ok_out := OLD.gps_ok_out;
    NEW.clock_out_method := OLD.clock_out_method;
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: protect_owner_employee()
CREATE FUNCTION public.protect_owner_employee() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE employee_id = OLD.id AND is_owner AND id <> auth.uid()) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Der Mitarbeiter-Eintrag des Inhabers kann nur vom Inhaber selbst gelöscht werden.';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.end_date IS DISTINCT FROM OLD.end_date
       OR NEW.email IS DISTINCT FROM OLD.email OR NEW.iban IS DISTINCT FROM OLD.iban
       OR NEW.account_holder IS DISTINCT FROM OLD.account_holder OR NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate THEN
      RAISE EXCEPTION 'Nur der Inhaber selbst kann seinen Eintrag deaktivieren oder Bank-/Lohndaten ändern.';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- FUNCTION: protect_owner_profile()
CREATE FUNCTION public.protect_owner_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- FUNCTION: push_on_onboarding()
CREATE FUNCTION public.push_on_onboarding() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM _push_to_staff(false, '🔑 Neue Registrierung', 'Eine neue Person wartet auf Freischaltung.', '/benutzer', 'onboarding');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

-- FUNCTION: push_on_payroll_doc()
CREATE FUNCTION public.push_on_payroll_doc() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM _push_to_employee(NEW.employee_id, '📄 Neue Lohnabrechnung',
    (ARRAY['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'])[NEW.month] || ' ' || NEW.year || ' ist verfügbar.', '/dokumente', 'payroll');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

-- FUNCTION: push_on_shift()
CREATE FUNCTION public.push_on_shift() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE today date := (now() AT TIME ZONE 'Europe/Berlin')::date; r shifts%ROWTYPE; txt text;
BEGIN
  r := COALESCE(NEW, OLD);
  IF r.date < today THEN RETURN r; END IF;
  txt := _wd(r.date) || ', ' || _d(r.date) || ' ' || to_char(r.start_time, 'HH24:MI') || '–' || to_char(r.end_time, 'HH24:MI') || ' Uhr';
  IF TG_OP = 'INSERT' THEN
    PERFORM _push_to_employee(NEW.employee_id, '📅 Neue Schicht', txt, '/schichten', 'shifts');
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM _push_to_employee(OLD.employee_id, '📅 Schicht entfällt', _wd(OLD.date) || ', ' || _d(OLD.date), '/schichten', 'shifts');
  ELSIF NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    PERFORM _push_to_employee(NEW.employee_id, '📅 Neue Schicht', txt, '/schichten', 'shifts');
    PERFORM _push_to_employee(OLD.employee_id, '📅 Schicht abgegeben', _wd(OLD.date) || ', ' || _d(OLD.date), '/schichten', 'shifts');
  ELSIF (NEW.date, NEW.start_time, NEW.end_time) IS DISTINCT FROM (OLD.date, OLD.start_time, OLD.end_time) THEN
    PERFORM _push_to_employee(NEW.employee_id, '📅 Schicht geändert', txt, '/schichten', 'shifts');
  END IF;
  RETURN r;
EXCEPTION WHEN OTHERS THEN RETURN r;
END $$;

-- FUNCTION: push_on_sick()
CREATE FUNCTION public.push_on_sick() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM _push_to_staff(true, '🤒 Neue Krankmeldung', 'Bitte in der App ansehen.', '/urlaub', 'sick');
  ELSIF TG_OP = 'UPDATE' AND NEW.certificate_file_path IS NOT NULL AND OLD.certificate_file_path IS NULL THEN
    PERFORM _push_to_staff(true, '📎 Neue AU-Bescheinigung', 'Bitte in der App ansehen.', '/urlaub', 'sick');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

-- FUNCTION: push_on_swap()
CREATE FUNCTION public.push_on_swap() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.target_id IS NOT NULL THEN
    PERFORM _push_to_employee(NEW.target_id, '🔄 Anfrage zum Schichttausch', _emp_short(NEW.requester_id) || ' möchte mit dir tauschen.', '/schichten', 'swap-' || NEW.id);
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'accepted' THEN
      PERFORM _push_to_staff(true, '🔄 Schichttausch wartet auf Freigabe', _emp_short(NEW.requester_id) || ' ⇄ ' || COALESCE(_emp_short(NEW.target_id), '–'), '/schichten', 'swap');
    ELSIF NEW.status = 'declined' THEN
      PERFORM _push_to_employee(NEW.requester_id, '🔄 Schichttausch abgelehnt', COALESCE(_emp_short(NEW.target_id), 'Die Person') || ' hat abgelehnt.', '/schichten', 'swap-' || NEW.id);
    ELSIF NEW.status IN ('approved','rejected') THEN
      PERFORM _push_to_employee(NEW.requester_id, CASE WHEN NEW.status = 'approved' THEN '✅ Schichttausch freigegeben' ELSE '❌ Schichttausch nicht freigegeben' END, 'Details im Schichtplan.', '/schichten', 'swap-' || NEW.id);
      PERFORM _push_to_employee(NEW.target_id,    CASE WHEN NEW.status = 'approved' THEN '✅ Schichttausch freigegeben' ELSE '❌ Schichttausch nicht freigegeben' END, 'Details im Schichtplan.', '/schichten', 'swap-' || NEW.id);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

-- FUNCTION: push_on_vacation()
CREATE FUNCTION public.push_on_vacation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM _push_to_staff(true, '🌴 Neuer Urlaubsantrag',
      _emp_short(NEW.employee_id) || ' · ' || _d(NEW.start_date) || '–' || _d(NEW.end_date), '/urlaub', 'vacation');
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
    PERFORM _push_to_employee(NEW.employee_id,
      CASE WHEN NEW.status = 'approved' THEN '✅ Urlaub genehmigt' ELSE '❌ Urlaub abgelehnt' END,
      _d(NEW.start_date) || '–' || to_char(NEW.end_date, 'DD.MM.YYYY'), '/urlaub', 'vacation-' || NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

-- FUNCTION: revoke_invites_on_deactivate()
CREATE FUNCTION public.revoke_invites_on_deactivate() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF COALESCE(OLD.is_active, true) AND NOT COALESCE(NEW.is_active, true) THEN
    UPDATE invitations SET revoked_at = NOW(), revoked_by = auth.uid()
     WHERE employee_id = NEW.id AND used_at IS NULL AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END; $$;

-- FUNCTION: sick_leave_guard()
CREATE FUNCTION public.sick_leave_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL OR is_manager_or_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.certificate_received    := false;
    NEW.certificate_file_path   := NULL;
    NEW.certificate_file_name   := NULL;
    NEW.certificate_uploaded_at := NULL;
    NEW.certificate_date        := NULL;
    NEW.acknowledged_by         := NULL;
    NEW.acknowledged_at         := NULL;
    IF NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date THEN
      RAISE EXCEPTION 'Ungültiger Zeitraum.';
    END IF;
    RETURN NEW;
  END IF;
  NEW.employee_id       := OLD.employee_id;
  NEW.start_date        := OLD.start_date;
  NEW.end_date          := OLD.end_date;
  NEW.notes             := OLD.notes;
  NEW.days_count        := OLD.days_count;
  NEW.continued_pay_end := OLD.continued_pay_end;
  NEW.certificate_date  := OLD.certificate_date;
  NEW.acknowledged_by   := OLD.acknowledged_by;
  NEW.acknowledged_at   := OLD.acknowledged_at;
  IF NEW.certificate_file_path IS DISTINCT FROM OLD.certificate_file_path THEN
    IF NEW.certificate_file_path IS NULL
       OR split_part(NEW.certificate_file_path, '/', 1) <> OLD.employee_id::text
       OR NOT EXISTS (SELECT 1 FROM storage.objects o
                       WHERE o.bucket_id = 'sick-certs' AND o.name = NEW.certificate_file_path) THEN
      RAISE EXCEPTION 'Attest-Datei nicht gefunden. Bitte erneut hochladen.';
    END IF;
    NEW.certificate_uploaded_at := now();
  ELSE
    NEW.certificate_uploaded_at := OLD.certificate_uploaded_at;
    NEW.certificate_file_name   := OLD.certificate_file_name;
  END IF;
  NEW.certificate_received := (NEW.certificate_file_path IS NOT NULL);
  RETURN NEW;
END $$;

-- FUNCTION: swap_guard()
CREATE FUNCTION public.swap_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE me uuid := my_employee_id();
BEGIN
  IF auth.uid() IS NULL OR is_manager_or_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'open'; NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.admin_note := NULL;
    IF NEW.target_id IS NULL OR NEW.target_id = NEW.requester_id THEN
      RAISE EXCEPTION 'Bitte eine andere Person auswählen.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM shifts WHERE id = NEW.requester_shift_id AND employee_id = NEW.requester_id
                   AND date >= (now() AT TIME ZONE 'Europe/Berlin')::date) THEN
      RAISE EXCEPTION 'Du kannst nur eigene, zukünftige Schichten tauschen.';
    END IF;
    IF NEW.target_shift_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM shifts WHERE id = NEW.target_shift_id AND employee_id = NEW.target_id) THEN
      RAISE EXCEPTION 'Die gewählte Gegenschicht gehört nicht zu dieser Person.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'Diese Anfrage ist bereits abgeschlossen.'; END IF;
  IF me = OLD.requester_id AND NEW.status = 'cancelled' THEN NULL;
  ELSIF me = OLD.target_id AND NEW.status IN ('accepted','declined') THEN NULL;
  ELSE RAISE EXCEPTION 'Diese Änderung ist nicht erlaubt.';
  END IF;
  NEW.requester_id := OLD.requester_id; NEW.requester_shift_id := OLD.requester_shift_id;
  NEW.target_id := OLD.target_id; NEW.target_shift_id := OLD.target_shift_id;
  NEW.message := OLD.message; NEW.admin_note := OLD.admin_note;
  NEW.approved_by := OLD.approved_by; NEW.approved_at := OLD.approved_at;
  RETURN NEW;
END $$;

-- FUNCTION: sync_profile_names()
CREATE FUNCTION public.sync_profile_names() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name THEN
    UPDATE profiles SET first_name = NEW.first_name, last_name = NEW.last_name WHERE employee_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: time_entry_guard_insert()
CREATE FUNCTION public.time_entry_guard_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE loc jsonb;
BEGIN
  IF auth.uid() IS NULL OR is_admin() THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM time_entries WHERE employee_id = NEW.employee_id AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'Du bist bereits eingeclockt.';
  END IF;
  loc := _clock_location(NEW.gps_lat_in, NEW.gps_lng_in);
  IF (loc->>'required')::boolean AND NOT ((loc->>'gps_ok')::boolean OR (loc->>'net_ok')::boolean) THEN
    RAISE EXCEPTION 'Einclocken geht nur im Café: Bitte GPS erlauben oder mit dem Café-WLAN verbinden.';
  END IF;
  IF (loc->>'net_ok')::boolean THEN
    UPDATE cafe_networks SET last_seen_at = now() WHERE id = (loc->>'net_id')::uuid;
  END IF;
  NEW.clock_in        := now();
  NEW.date            := (now() AT TIME ZONE 'Europe/Berlin')::date;
  NEW.clock_out       := NULL;
  NEW.hours_worked    := NULL;
  NEW.break_minutes   := 0;
  NEW.is_overtime     := false;
  NEW.overtime_hours  := 0;
  NEW.approved        := false;
  NEW.gps_ok_in       := (loc->>'gps_ok')::boolean;
  NEW.clock_in_method := _clock_method(loc);
  NEW.gps_lat_out := NULL; NEW.gps_lng_out := NULL; NEW.gps_ok_out := false; NEW.clock_out_method := NULL;
  RETURN NEW;
END $$;

-- FUNCTION: vacation_guard_insert()
CREATE FUNCTION public.vacation_guard_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL OR is_manager_or_admin() THEN RETURN NEW; END IF;
  IF NEW.start_date IS NULL OR NEW.end_date IS NULL OR NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'Ungültiger Zeitraum.';
  END IF;
  IF NEW.end_date - NEW.start_date > 90 THEN
    RAISE EXCEPTION 'Ein Urlaubsantrag darf höchstens 90 Tage umfassen.';
  END IF;
  NEW.status           := 'pending';
  NEW.approved_by      := NULL;
  NEW.approved_at      := NULL;
  NEW.approved_by_name := NULL;
  NEW.rejection_reason := NULL;
  SELECT count(*) INTO NEW.days_count
    FROM generate_series(NEW.start_date, NEW.end_date, interval '1 day') g(d)
   WHERE EXTRACT(ISODOW FROM g.d) < 6
     AND NOT EXISTS (SELECT 1 FROM public_holidays h WHERE h.date = g.d::date AND h.bundesland = 'Hessen');
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

-- TABLE: activity_log
CREATE TABLE public.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    actor_name text,
    actor_role text,
    action text NOT NULL,
    category text NOT NULL,
    summary text NOT NULL,
    target_type text,
    target_id text,
    target_name text,
    metadata jsonb,
    ip_address text
);

-- TABLE: cafe_networks
CREATE TABLE public.cafe_networks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cidr cidr NOT NULL,
    label text DEFAULT 'Café-WLAN'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    last_seen_at timestamp with time zone
);

-- TABLE: cafe_settings
CREATE TABLE public.cafe_settings (
    id integer DEFAULT 1 NOT NULL,
    cafe_name character varying(200) DEFAULT 'Mein Café'::character varying,
    address text,
    gps_lat numeric(10,8),
    gps_lng numeric(11,8),
    gps_radius_m integer DEFAULT 50,
    bundesland character varying(50) DEFAULT 'Hessen'::character varying,
    break_30min_after_h numeric(3,1) DEFAULT 6.0,
    break_45min_after_h numeric(3,1) DEFAULT 9.0,
    overtime_daily_h numeric(5,2) DEFAULT 8.0,
    overtime_weekly_h numeric(5,2) DEFAULT 40.0,
    updated_at timestamp with time zone DEFAULT now(),
    clock_require_network boolean DEFAULT false NOT NULL
);

-- TABLE: employee_documents
CREATE TABLE public.employee_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    document_type text DEFAULT 'other'::text NOT NULL,
    title text NOT NULL,
    description text,
    file_path text NOT NULL,
    file_name text NOT NULL,
    file_size bigint,
    mime_type text,
    uploaded_by uuid,
    uploaded_by_name text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    valid_from date,
    valid_until date,
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    archived_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: employee_onboarding
CREATE TABLE public.employee_onboarding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    invitation_id uuid,
    email text NOT NULL,
    role text DEFAULT 'employee'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    first_name text,
    last_name text,
    birth_name text,
    birth_date date,
    birth_place text,
    nationality text,
    street text,
    house_number text,
    postal_code text,
    city text,
    phone text,
    iban text,
    account_holder text,
    tax_id text,
    social_security_number text,
    health_insurance text,
    other_employment boolean,
    other_employment_note text,
    emergency_contact_name text,
    emergency_contact_phone text,
    privacy_accepted_at timestamp with time zone,
    submitted_at timestamp with time zone,
    review_note text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    employee_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_onboarding_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'changes_requested'::text, 'approved'::text, 'rejected'::text])))
);

-- TABLE: employees
CREATE TABLE public.employees (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    phone character varying(50),
    birth_date date,
    address text,
    "position" character varying(100),
    employment_type character varying(20) DEFAULT 'vollzeit'::character varying,
    hours_per_week numeric(5,2) DEFAULT 40,
    hourly_rate numeric(8,2) NOT NULL,
    start_date date NOT NULL,
    end_date date,
    vacation_days_per_year integer DEFAULT 28,
    iban character varying(34),
    notes text,
    avatar_initials character varying(3),
    avatar_color character varying(20) DEFAULT 'blue'::character varying,
    is_active boolean DEFAULT true,
    avatar_url text,
    birth_name text,
    birth_place text,
    nationality text,
    street text,
    house_number text,
    postal_code text,
    city text,
    account_holder text,
    tax_id text,
    social_security_number text,
    health_insurance text,
    other_employment boolean,
    other_employment_note text,
    emergency_contact_name text,
    emergency_contact_phone text,
    onboarding_completed_at timestamp with time zone,
    app_access_hidden boolean DEFAULT false NOT NULL,
    CONSTRAINT employees_avatar_url_safe CHECK (((avatar_url IS NULL) OR ((length(avatar_url) <= 400000) AND ((avatar_url ~ '^data:image/(png|jpeg|jpg|webp);base64,'::text) OR (avatar_url ~~ 'https://%'::text))))),
    CONSTRAINT employees_hourly_rate_positive CHECK ((hourly_rate > (0)::numeric)),
    CONSTRAINT employees_hours_per_week_nonneg CHECK (((hours_per_week IS NULL) OR (hours_per_week >= (0)::numeric))),
    CONSTRAINT employees_vacation_days_nonneg CHECK (((vacation_days_per_year IS NULL) OR (vacation_days_per_year >= 0)))
);

-- TABLE: invitations
CREATE TABLE public.invitations (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    token text DEFAULT (gen_random_uuid())::text NOT NULL,
    employee_id uuid,
    email text NOT NULL,
    role text DEFAULT 'employee'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    used_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    revoked_at timestamp with time zone,
    revoked_by uuid,
    job jsonb
);

-- TABLE: payroll_documents
CREATE TABLE public.payroll_documents (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    employee_id uuid NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    file_name character varying(255) NOT NULL,
    file_path character varying(500) NOT NULL,
    file_size integer,
    uploaded_by uuid,
    notes text
);

-- TABLE: payroll_months
CREATE TABLE public.payroll_months (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    employee_id uuid NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    planned_hours numeric(6,2) DEFAULT 0,
    actual_hours numeric(6,2) DEFAULT 0,
    overtime_hours numeric(6,2) DEFAULT 0,
    sick_hours numeric(6,2) DEFAULT 0,
    vacation_hours numeric(6,2) DEFAULT 0,
    holiday_hours numeric(6,2) DEFAULT 0,
    hourly_rate numeric(8,2),
    gross_salary numeric(10,2) DEFAULT 0,
    sick_pay numeric(10,2) DEFAULT 0,
    overtime_pay numeric(10,2) DEFAULT 0,
    total_payout numeric(10,2) DEFAULT 0,
    is_finalized boolean DEFAULT false,
    notes text
);

-- TABLE: profiles
CREATE TABLE public.profiles (
    id uuid NOT NULL,
    employee_id uuid,
    role character varying(20) DEFAULT 'employee'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    status character varying(20) DEFAULT 'pending'::character varying,
    email character varying(255),
    approved_at timestamp with time zone,
    approved_by uuid,
    first_name text,
    last_name text,
    avatar_url text,
    is_owner boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_avatar_url_safe CHECK (((avatar_url IS NULL) OR ((length(avatar_url) <= 400000) AND ((avatar_url ~ '^data:image/(png|jpeg|jpg|webp);base64,'::text) OR (avatar_url ~~ 'https://%'::text)))))
);

-- TABLE: public_holidays
CREATE TABLE public.public_holidays (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    date date NOT NULL,
    name character varying(200) NOT NULL,
    bundesland character varying(50) DEFAULT 'Hessen'::character varying,
    year integer NOT NULL
);

-- TABLE: push_outbox
CREATE TABLE public.push_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    title text NOT NULL,
    body text,
    url text,
    tag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    sent_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    error text
);

-- TABLE: push_subscriptions
CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);

-- TABLE: shift_swap_requests
CREATE TABLE public.shift_swap_requests (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    requester_id uuid NOT NULL,
    requester_shift_id uuid NOT NULL,
    target_id uuid,
    target_shift_id uuid,
    message text,
    status character varying(20) DEFAULT 'open'::character varying,
    admin_note text,
    approved_by uuid,
    approved_at timestamp with time zone
);

-- TABLE: shifts
CREATE TABLE public.shifts (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    employee_id uuid NOT NULL,
    date date NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    planned_hours numeric(5,2),
    "position" character varying(100),
    notes text,
    CONSTRAINT shifts_planned_hours_nonneg CHECK (((planned_hours IS NULL) OR (planned_hours >= (0)::numeric)))
);

-- TABLE: sick_leave
CREATE TABLE public.sick_leave (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    employee_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date,
    certificate_received boolean DEFAULT false,
    certificate_date date,
    continued_pay_end date,
    days_count integer,
    notes text,
    certificate_file_path character varying(500),
    certificate_file_name character varying(255),
    certificate_uploaded_at timestamp with time zone,
    acknowledged_by uuid,
    acknowledged_at timestamp with time zone,
    CONSTRAINT sick_leave_date_order CHECK (((end_date IS NULL) OR (end_date >= start_date))),
    CONSTRAINT sick_leave_days_nonneg CHECK (((days_count IS NULL) OR (days_count >= 0)))
);

-- TABLE: time_corrections
CREATE TABLE public.time_corrections (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    time_entry_id uuid,
    employee_id uuid,
    corrected_by uuid,
    field_changed character varying(50),
    old_value text,
    new_value text,
    reason text NOT NULL
);

-- TABLE: time_entries
CREATE TABLE public.time_entries (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    employee_id uuid NOT NULL,
    date date NOT NULL,
    clock_in timestamp with time zone NOT NULL,
    clock_out timestamp with time zone,
    break_minutes integer DEFAULT 0,
    hours_worked numeric(5,2),
    is_overtime boolean DEFAULT false,
    overtime_hours numeric(5,2) DEFAULT 0,
    gps_lat_in numeric(10,8),
    gps_lng_in numeric(11,8),
    gps_ok_in boolean DEFAULT false,
    gps_lat_out numeric(10,8),
    gps_lng_out numeric(11,8),
    gps_ok_out boolean DEFAULT false,
    notes text,
    approved boolean DEFAULT false,
    clock_in_method text,
    clock_out_method text,
    CONSTRAINT time_entries_break_nonneg CHECK (((break_minutes IS NULL) OR (break_minutes >= 0))),
    CONSTRAINT time_entries_clock_order CHECK (((clock_out IS NULL) OR (clock_out >= clock_in))),
    CONSTRAINT time_entries_hours_nonneg CHECK (((hours_worked IS NULL) OR (hours_worked >= (0)::numeric)))
);

-- TABLE: vacation_requests
CREATE TABLE public.vacation_requests (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    employee_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days_count integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    reason text,
    approved_by uuid,
    approved_at timestamp with time zone,
    rejection_reason text,
    approved_by_name text,
    CONSTRAINT vacation_requests_date_order CHECK ((start_date <= end_date)),
    CONSTRAINT vacation_requests_days_positive CHECK ((days_count > 0))
);

-- CONSTRAINT: activity_log activity_log_pkey
ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);

-- CONSTRAINT: cafe_networks cafe_networks_cidr_key
ALTER TABLE ONLY public.cafe_networks
    ADD CONSTRAINT cafe_networks_cidr_key UNIQUE (cidr);

-- CONSTRAINT: cafe_networks cafe_networks_pkey
ALTER TABLE ONLY public.cafe_networks
    ADD CONSTRAINT cafe_networks_pkey PRIMARY KEY (id);

-- CONSTRAINT: cafe_settings cafe_settings_pkey
ALTER TABLE ONLY public.cafe_settings
    ADD CONSTRAINT cafe_settings_pkey PRIMARY KEY (id);

-- CONSTRAINT: employee_documents employee_documents_pkey
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_pkey PRIMARY KEY (id);

-- CONSTRAINT: employee_onboarding employee_onboarding_pkey
ALTER TABLE ONLY public.employee_onboarding
    ADD CONSTRAINT employee_onboarding_pkey PRIMARY KEY (id);

-- CONSTRAINT: employee_onboarding employee_onboarding_profile_id_key
ALTER TABLE ONLY public.employee_onboarding
    ADD CONSTRAINT employee_onboarding_profile_id_key UNIQUE (profile_id);

-- CONSTRAINT: employees employees_email_key
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_email_key UNIQUE (email);

-- CONSTRAINT: employees employees_pkey
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);

-- CONSTRAINT: invitations invitations_pkey
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

-- CONSTRAINT: invitations invitations_token_key
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_key UNIQUE (token);

-- CONSTRAINT: payroll_documents payroll_documents_employee_id_year_month_key
ALTER TABLE ONLY public.payroll_documents
    ADD CONSTRAINT payroll_documents_employee_id_year_month_key UNIQUE (employee_id, year, month);

-- CONSTRAINT: payroll_documents payroll_documents_pkey
ALTER TABLE ONLY public.payroll_documents
    ADD CONSTRAINT payroll_documents_pkey PRIMARY KEY (id);

-- CONSTRAINT: payroll_months payroll_months_employee_id_year_month_key
ALTER TABLE ONLY public.payroll_months
    ADD CONSTRAINT payroll_months_employee_id_year_month_key UNIQUE (employee_id, year, month);

-- CONSTRAINT: payroll_months payroll_months_pkey
ALTER TABLE ONLY public.payroll_months
    ADD CONSTRAINT payroll_months_pkey PRIMARY KEY (id);

-- CONSTRAINT: profiles profiles_employee_id_key
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_employee_id_key UNIQUE (employee_id);

-- CONSTRAINT: profiles profiles_pkey
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

-- CONSTRAINT: public_holidays public_holidays_date_bundesland_key
ALTER TABLE ONLY public.public_holidays
    ADD CONSTRAINT public_holidays_date_bundesland_key UNIQUE (date, bundesland);

-- CONSTRAINT: public_holidays public_holidays_pkey
ALTER TABLE ONLY public.public_holidays
    ADD CONSTRAINT public_holidays_pkey PRIMARY KEY (id);

-- CONSTRAINT: push_outbox push_outbox_pkey
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_pkey PRIMARY KEY (id);

-- CONSTRAINT: push_subscriptions push_subscriptions_endpoint_key
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

-- CONSTRAINT: push_subscriptions push_subscriptions_pkey
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

-- CONSTRAINT: shift_swap_requests shift_swap_requests_pkey
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_pkey PRIMARY KEY (id);

-- CONSTRAINT: shift_swap_requests shift_swap_requests_requester_shift_id_key
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requester_shift_id_key UNIQUE (requester_shift_id);

-- CONSTRAINT: shifts shifts_pkey
ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);

-- CONSTRAINT: sick_leave sick_leave_pkey
ALTER TABLE ONLY public.sick_leave
    ADD CONSTRAINT sick_leave_pkey PRIMARY KEY (id);

-- CONSTRAINT: time_corrections time_corrections_pkey
ALTER TABLE ONLY public.time_corrections
    ADD CONSTRAINT time_corrections_pkey PRIMARY KEY (id);

-- CONSTRAINT: time_entries time_entries_pkey
ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);

-- CONSTRAINT: vacation_requests vacation_requests_pkey
ALTER TABLE ONLY public.vacation_requests
    ADD CONSTRAINT vacation_requests_pkey PRIMARY KEY (id);

-- FK CONSTRAINT: activity_log activity_log_actor_id_fkey
ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: cafe_networks cafe_networks_created_by_fkey
ALTER TABLE ONLY public.cafe_networks
    ADD CONSTRAINT cafe_networks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: employee_documents employee_documents_archived_by_fkey
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: employee_documents employee_documents_employee_id_fkey
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: employee_documents employee_documents_uploaded_by_fkey
ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: employee_onboarding employee_onboarding_employee_id_fkey
ALTER TABLE ONLY public.employee_onboarding
    ADD CONSTRAINT employee_onboarding_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;

-- FK CONSTRAINT: employee_onboarding employee_onboarding_invitation_id_fkey
ALTER TABLE ONLY public.employee_onboarding
    ADD CONSTRAINT employee_onboarding_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.invitations(id) ON DELETE SET NULL;

-- FK CONSTRAINT: employee_onboarding employee_onboarding_profile_id_fkey
ALTER TABLE ONLY public.employee_onboarding
    ADD CONSTRAINT employee_onboarding_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- FK CONSTRAINT: employee_onboarding employee_onboarding_reviewed_by_fkey
ALTER TABLE ONLY public.employee_onboarding
    ADD CONSTRAINT employee_onboarding_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- FK CONSTRAINT: invitations invitations_created_by_fkey
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: invitations invitations_employee_id_fkey
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: invitations invitations_revoked_by_fkey
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- FK CONSTRAINT: payroll_documents payroll_documents_employee_id_fkey
ALTER TABLE ONLY public.payroll_documents
    ADD CONSTRAINT payroll_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: payroll_documents payroll_documents_uploaded_by_fkey
ALTER TABLE ONLY public.payroll_documents
    ADD CONSTRAINT payroll_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: payroll_months payroll_months_employee_id_fkey
ALTER TABLE ONLY public.payroll_months
    ADD CONSTRAINT payroll_months_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: profiles profiles_approved_by_fkey
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: profiles profiles_id_fkey
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- FK CONSTRAINT: push_outbox push_outbox_profile_id_fkey
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- FK CONSTRAINT: push_subscriptions push_subscriptions_profile_id_fkey
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- FK CONSTRAINT: shift_swap_requests shift_swap_requests_approved_by_fkey
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: shift_swap_requests shift_swap_requests_requester_id_fkey
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: shift_swap_requests shift_swap_requests_requester_shift_id_fkey
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requester_shift_id_fkey FOREIGN KEY (requester_shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;

-- FK CONSTRAINT: shift_swap_requests shift_swap_requests_target_id_fkey
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.employees(id);

-- FK CONSTRAINT: shift_swap_requests shift_swap_requests_target_shift_id_fkey
ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_target_shift_id_fkey FOREIGN KEY (target_shift_id) REFERENCES public.shifts(id);

-- FK CONSTRAINT: shifts shifts_employee_id_fkey
ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: sick_leave sick_leave_acknowledged_by_fkey
ALTER TABLE ONLY public.sick_leave
    ADD CONSTRAINT sick_leave_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- FK CONSTRAINT: sick_leave sick_leave_employee_id_fkey
ALTER TABLE ONLY public.sick_leave
    ADD CONSTRAINT sick_leave_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: time_corrections time_corrections_corrected_by_fkey
ALTER TABLE ONLY public.time_corrections
    ADD CONSTRAINT time_corrections_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- FK CONSTRAINT: time_corrections time_corrections_employee_id_fkey
ALTER TABLE ONLY public.time_corrections
    ADD CONSTRAINT time_corrections_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);

-- FK CONSTRAINT: time_corrections time_corrections_time_entry_id_fkey
ALTER TABLE ONLY public.time_corrections
    ADD CONSTRAINT time_corrections_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE SET NULL;

-- FK CONSTRAINT: time_entries time_entries_employee_id_fkey
ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- FK CONSTRAINT: vacation_requests vacation_requests_approved_by_fkey
ALTER TABLE ONLY public.vacation_requests
    ADD CONSTRAINT vacation_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.employees(id);

-- FK CONSTRAINT: vacation_requests vacation_requests_employee_id_fkey
ALTER TABLE ONLY public.vacation_requests
    ADD CONSTRAINT vacation_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- INDEX: idx_activity_log_actor
CREATE INDEX idx_activity_log_actor ON public.activity_log USING btree (actor_id);

-- INDEX: idx_activity_log_category
CREATE INDEX idx_activity_log_category ON public.activity_log USING btree (category);

-- INDEX: idx_activity_log_created
CREATE INDEX idx_activity_log_created ON public.activity_log USING btree (created_at DESC);

-- INDEX: idx_activity_log_target
CREATE INDEX idx_activity_log_target ON public.activity_log USING btree (target_id);

-- INDEX: idx_onboarding_status
CREATE INDEX idx_onboarding_status ON public.employee_onboarding USING btree (status);

-- INDEX: push_outbox_pending
CREATE INDEX push_outbox_pending ON public.push_outbox USING btree (created_at) WHERE (sent_at IS NULL);

-- TRIGGER: profiles trg_lock_profile_identity
CREATE TRIGGER trg_lock_profile_identity BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.lock_profile_identity();

-- TRIGGER: employee_onboarding trg_onboarding_wipe_after_approval
CREATE TRIGGER trg_onboarding_wipe_after_approval BEFORE UPDATE ON public.employee_onboarding FOR EACH ROW EXECUTE FUNCTION public.onboarding_wipe_after_approval();

-- TRIGGER: profiles trg_prevent_profile_privilege_escalation
CREATE TRIGGER trg_prevent_profile_privilege_escalation BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_privilege_escalation();

-- TRIGGER: time_entries trg_prevent_time_entry_backdating
CREATE TRIGGER trg_prevent_time_entry_backdating BEFORE UPDATE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.prevent_time_entry_backdating();

-- TRIGGER: employees trg_protect_owner_employee
CREATE TRIGGER trg_protect_owner_employee BEFORE DELETE OR UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.protect_owner_employee();

-- TRIGGER: profiles trg_protect_owner_profile
CREATE TRIGGER trg_protect_owner_profile BEFORE INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_owner_profile();

-- TRIGGER: employee_onboarding trg_push_onboarding
CREATE TRIGGER trg_push_onboarding AFTER UPDATE ON public.employee_onboarding FOR EACH ROW EXECUTE FUNCTION public.push_on_onboarding();

-- TRIGGER: payroll_documents trg_push_payroll_doc
CREATE TRIGGER trg_push_payroll_doc AFTER INSERT ON public.payroll_documents FOR EACH ROW EXECUTE FUNCTION public.push_on_payroll_doc();

-- TRIGGER: shifts trg_push_shift
CREATE TRIGGER trg_push_shift AFTER INSERT OR DELETE OR UPDATE ON public.shifts FOR EACH ROW EXECUTE FUNCTION public.push_on_shift();

-- TRIGGER: sick_leave trg_push_sick
CREATE TRIGGER trg_push_sick AFTER INSERT OR UPDATE ON public.sick_leave FOR EACH ROW EXECUTE FUNCTION public.push_on_sick();

-- TRIGGER: shift_swap_requests trg_push_swap
CREATE TRIGGER trg_push_swap AFTER INSERT OR UPDATE ON public.shift_swap_requests FOR EACH ROW EXECUTE FUNCTION public.push_on_swap();

-- TRIGGER: vacation_requests trg_push_vacation
CREATE TRIGGER trg_push_vacation AFTER INSERT OR UPDATE ON public.vacation_requests FOR EACH ROW EXECUTE FUNCTION public.push_on_vacation();

-- TRIGGER: employees trg_revoke_invites_on_deactivate
CREATE TRIGGER trg_revoke_invites_on_deactivate AFTER UPDATE OF is_active ON public.employees FOR EACH ROW EXECUTE FUNCTION public.revoke_invites_on_deactivate();

-- TRIGGER: sick_leave trg_sick_leave_guard
CREATE TRIGGER trg_sick_leave_guard BEFORE INSERT OR UPDATE ON public.sick_leave FOR EACH ROW EXECUTE FUNCTION public.sick_leave_guard();

-- TRIGGER: sick_leave trg_sick_leave_pay_end
CREATE TRIGGER trg_sick_leave_pay_end BEFORE INSERT OR UPDATE OF start_date ON public.sick_leave FOR EACH ROW EXECUTE FUNCTION public.calc_continued_pay_end();

-- TRIGGER: shift_swap_requests trg_swap_guard
CREATE TRIGGER trg_swap_guard BEFORE INSERT OR UPDATE ON public.shift_swap_requests FOR EACH ROW EXECUTE FUNCTION public.swap_guard();

-- TRIGGER: employees trg_sync_profile_names
CREATE TRIGGER trg_sync_profile_names AFTER UPDATE OF first_name, last_name ON public.employees FOR EACH ROW EXECUTE FUNCTION public.sync_profile_names();

-- TRIGGER: time_entries trg_time_entry_guard_insert
CREATE TRIGGER trg_time_entry_guard_insert BEFORE INSERT ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.time_entry_guard_insert();

-- TRIGGER: vacation_requests trg_vacation_guard_insert
CREATE TRIGGER trg_vacation_guard_insert BEFORE INSERT ON public.vacation_requests FOR EACH ROW EXECUTE FUNCTION public.vacation_guard_insert();

-- ROW SECURITY: activity_log
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: cafe_networks
ALTER TABLE public.cafe_networks ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: cafe_settings
ALTER TABLE public.cafe_settings ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: employee_documents
ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: employee_onboarding
ALTER TABLE public.employee_onboarding ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: employees
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: invitations
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: payroll_documents
ALTER TABLE public.payroll_documents ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: payroll_months
ALTER TABLE public.payroll_months ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: public_holidays
ALTER TABLE public.public_holidays ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: push_outbox
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: push_subscriptions
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: shift_swap_requests
ALTER TABLE public.shift_swap_requests ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: shifts
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: sick_leave
ALTER TABLE public.sick_leave ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: time_corrections
ALTER TABLE public.time_corrections ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: time_entries
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: vacation_requests
ALTER TABLE public.vacation_requests ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

-- POLICY: activity_log activity_log_admin_read
CREATE POLICY activity_log_admin_read ON public.activity_log FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text) AND ((profiles.status)::text = 'approved'::text)))));

-- POLICY: cafe_networks cafe_networks_admin
CREATE POLICY cafe_networks_admin ON public.cafe_networks USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: time_corrections corr_insert
CREATE POLICY corr_insert ON public.time_corrections FOR INSERT TO authenticated WITH CHECK (public.is_admin());

-- POLICY: time_corrections corr_read
CREATE POLICY corr_read ON public.time_corrections FOR SELECT TO authenticated USING ((public.is_admin() OR (employee_id = public.my_employee_id())));

-- POLICY: payroll_documents doc_manage
CREATE POLICY doc_manage ON public.payroll_documents TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: payroll_documents doc_read
CREATE POLICY doc_read ON public.payroll_documents FOR SELECT TO authenticated USING ((employee_id = public.my_employee_id()));

-- POLICY: employees emp_admin_write
CREATE POLICY emp_admin_write ON public.employees TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: employee_documents emp_docs_insert
CREATE POLICY emp_docs_insert ON public.employee_documents FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text) AND ((profiles.status)::text = 'approved'::text)))));

-- POLICY: employee_documents emp_docs_select
CREATE POLICY emp_docs_select ON public.employee_documents FOR SELECT TO authenticated USING ((((employee_id = ( SELECT profiles.employee_id
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.status)::text = 'approved'::text)))) AND (is_active = true)) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text) AND ((profiles.status)::text = 'approved'::text))))));

-- POLICY: employee_documents emp_docs_update
CREATE POLICY emp_docs_update ON public.employee_documents FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text) AND ((profiles.status)::text = 'approved'::text)))));

-- POLICY: employees emp_manager_read
CREATE POLICY emp_manager_read ON public.employees FOR SELECT TO authenticated USING (public.is_manager_or_admin());

-- POLICY: employees emp_read_self
CREATE POLICY emp_read_self ON public.employees FOR SELECT TO authenticated USING ((id = public.my_employee_id()));

-- POLICY: public_holidays holidays_read
CREATE POLICY holidays_read ON public.public_holidays FOR SELECT USING (true);

-- POLICY: invitations inv_admin
CREATE POLICY inv_admin ON public.invitations TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: invitations inv_read_own
CREATE POLICY inv_read_own ON public.invitations FOR SELECT TO authenticated USING ((created_by = auth.uid()));

-- POLICY: employee_onboarding onb_select_own
CREATE POLICY onb_select_own ON public.employee_onboarding FOR SELECT TO authenticated USING ((profile_id = auth.uid()));

-- POLICY: employee_onboarding onb_select_staff
CREATE POLICY onb_select_staff ON public.employee_onboarding FOR SELECT TO authenticated USING (public.is_manager_or_admin());

-- POLICY: payroll_months pay_manage
CREATE POLICY pay_manage ON public.payroll_months TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: payroll_months pay_manager_read
CREATE POLICY pay_manager_read ON public.payroll_months FOR SELECT TO authenticated USING (public.is_manager_or_admin());

-- POLICY: payroll_months pay_read
CREATE POLICY pay_read ON public.payroll_months FOR SELECT TO authenticated USING ((employee_id = public.my_employee_id()));

-- POLICY: profiles prof_admin_all
CREATE POLICY prof_admin_all ON public.profiles TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: profiles prof_self
CREATE POLICY prof_self ON public.profiles FOR SELECT TO authenticated USING ((id = auth.uid()));

-- POLICY: profiles prof_update_own
CREATE POLICY prof_update_own ON public.profiles FOR UPDATE TO authenticated USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));

-- POLICY: push_subscriptions push_subs_own_read
CREATE POLICY push_subs_own_read ON public.push_subscriptions FOR SELECT USING ((profile_id = auth.uid()));

-- POLICY: cafe_settings set_manage
CREATE POLICY set_manage ON public.cafe_settings TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: cafe_settings set_read
CREATE POLICY set_read ON public.cafe_settings FOR SELECT TO authenticated USING (public.is_approved());

-- POLICY: shifts shifts_manage
CREATE POLICY shifts_manage ON public.shifts TO authenticated USING (public.is_manager_or_admin()) WITH CHECK (public.is_manager_or_admin());

-- POLICY: shifts shifts_read
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated USING (public.is_approved());

-- POLICY: sick_leave sick_delete_own_recent
CREATE POLICY sick_delete_own_recent ON public.sick_leave FOR DELETE TO authenticated USING (((employee_id = public.my_employee_id()) AND (certificate_file_path IS NULL) AND (created_at > (now() - '24:00:00'::interval))));

-- POLICY: sick_leave sick_insert
CREATE POLICY sick_insert ON public.sick_leave FOR INSERT TO authenticated WITH CHECK (((employee_id = public.my_employee_id()) AND public.my_is_active_employee()));

-- POLICY: sick_leave sick_manage
CREATE POLICY sick_manage ON public.sick_leave TO authenticated USING (public.is_manager_or_admin()) WITH CHECK (public.is_manager_or_admin());

-- POLICY: sick_leave sick_read
CREATE POLICY sick_read ON public.sick_leave FOR SELECT TO authenticated USING (((employee_id = public.my_employee_id()) OR public.is_manager_or_admin()));

-- POLICY: sick_leave sick_update_own_certificate
CREATE POLICY sick_update_own_certificate ON public.sick_leave FOR UPDATE TO authenticated USING ((employee_id = public.my_employee_id())) WITH CHECK ((employee_id = public.my_employee_id()));

-- POLICY: shift_swap_requests swap_insert
CREATE POLICY swap_insert ON public.shift_swap_requests FOR INSERT TO authenticated WITH CHECK (((requester_id = public.my_employee_id()) AND public.my_is_active_employee()));

-- POLICY: shift_swap_requests swap_manager_all
CREATE POLICY swap_manager_all ON public.shift_swap_requests TO authenticated USING (public.is_manager_or_admin()) WITH CHECK (public.is_manager_or_admin());

-- POLICY: shift_swap_requests swap_read
CREATE POLICY swap_read ON public.shift_swap_requests FOR SELECT TO authenticated USING (((requester_id = public.my_employee_id()) OR (target_id = public.my_employee_id())));

-- POLICY: shift_swap_requests swap_requester_cancel
CREATE POLICY swap_requester_cancel ON public.shift_swap_requests FOR UPDATE TO authenticated USING (((requester_id = public.my_employee_id()) AND ((status)::text = 'open'::text))) WITH CHECK ((requester_id = public.my_employee_id()));

-- POLICY: shift_swap_requests swap_update
CREATE POLICY swap_update ON public.shift_swap_requests FOR UPDATE TO authenticated USING ((target_id = public.my_employee_id()));

-- POLICY: time_entries time_admin
CREATE POLICY time_admin ON public.time_entries TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- POLICY: time_entries time_insert
CREATE POLICY time_insert ON public.time_entries FOR INSERT TO authenticated WITH CHECK (((employee_id = public.my_employee_id()) AND (public.my_is_active_employee() = true)));

-- POLICY: time_entries time_read
CREATE POLICY time_read ON public.time_entries FOR SELECT TO authenticated USING (((employee_id = public.my_employee_id()) OR public.is_manager_or_admin()));

-- POLICY: time_entries time_update_own_open
CREATE POLICY time_update_own_open ON public.time_entries FOR UPDATE TO authenticated USING (((employee_id = public.my_employee_id()) AND (public.my_is_active_employee() = true) AND (clock_out IS NULL))) WITH CHECK ((employee_id = public.my_employee_id()));

-- POLICY: vacation_requests vac_delete_own_pending
CREATE POLICY vac_delete_own_pending ON public.vacation_requests FOR DELETE TO authenticated USING (((employee_id = public.my_employee_id()) AND ((status)::text = 'pending'::text)));

-- POLICY: vacation_requests vac_insert
CREATE POLICY vac_insert ON public.vacation_requests FOR INSERT TO authenticated WITH CHECK (((employee_id = public.my_employee_id()) AND public.my_is_active_employee()));

-- POLICY: vacation_requests vac_manage
CREATE POLICY vac_manage ON public.vacation_requests TO authenticated USING (public.is_manager_or_admin()) WITH CHECK (public.is_manager_or_admin());

-- POLICY: vacation_requests vac_read
CREATE POLICY vac_read ON public.vacation_requests FOR SELECT TO authenticated USING (((employee_id = public.my_employee_id()) OR public.is_manager_or_admin()));
