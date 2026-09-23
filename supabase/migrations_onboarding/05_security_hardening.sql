-- ═══════════════════════════════════════════════════════════════════════════
-- 05 Sicherheits-Härtung (Audit 23.09.2026) — live angewendet, NICHT erneut ausführen
-- Grundsatz: Die Datenbank vertraut dem Browser nicht. Alles, was Lohn, Zeiten,
-- Urlaub, Krankmeldungen oder Protokoll betrifft, wird serverseitig erzwungen.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Hilfsfunktionen ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_approved()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT status = 'approved' FROM profiles WHERE id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION public.is_approved() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_approved() TO authenticated;

-- Gesperrte / wartende Accounts haben KEINE Mitarbeiter-Identität mehr
-- (vorher konnte ein deaktivierter Login weiter einstempeln, Urlaub beantragen …)
CREATE OR REPLACE FUNCTION public.my_employee_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT employee_id FROM profiles WHERE id = auth.uid() AND status = 'approved'
$$;

CREATE OR REPLACE FUNCTION public.my_is_active_employee()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT e.is_active FROM employees e JOIN profiles p ON p.employee_id = e.id
      WHERE p.id = auth.uid() AND p.status = 'approved'),
    false)
$$;

-- ── 1. Zeiterfassung: Uhrzeiten setzt der Server, nicht das Handy ─────────
CREATE OR REPLACE FUNCTION public.time_entry_guard_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM time_entries WHERE employee_id = NEW.employee_id AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'Du bist bereits eingeclockt.';
  END IF;
  NEW.clock_in       := now();
  NEW.date           := (now() AT TIME ZONE 'Europe/Berlin')::date;
  NEW.clock_out      := NULL;
  NEW.hours_worked   := NULL;
  NEW.break_minutes  := 0;
  NEW.is_overtime    := false;
  NEW.overtime_hours := 0;
  NEW.approved       := false;
  NEW.gps_lat_out := NULL; NEW.gps_lng_out := NULL; NEW.gps_ok_out := false;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.time_entry_guard_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_time_entry_guard_insert ON time_entries;
CREATE TRIGGER trg_time_entry_guard_insert BEFORE INSERT ON time_entries
  FOR EACH ROW EXECUTE FUNCTION public.time_entry_guard_insert();

CREATE OR REPLACE FUNCTION public.prevent_time_entry_backdating()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_total numeric; v_break int;
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  NEW.employee_id    := OLD.employee_id;
  NEW.date           := OLD.date;
  NEW.clock_in       := OLD.clock_in;
  NEW.gps_lat_in     := OLD.gps_lat_in; NEW.gps_lng_in := OLD.gps_lng_in; NEW.gps_ok_in := OLD.gps_ok_in;
  NEW.approved       := OLD.approved;
  NEW.is_overtime    := OLD.is_overtime;
  NEW.overtime_hours := OLD.overtime_hours;
  IF NEW.clock_out IS NOT NULL AND OLD.clock_out IS NULL THEN
    -- Ausstempeln: Zeitpunkt = jetzt; Pause & Stunden nach §4 ArbZG serverseitig
    NEW.clock_out := now();
    v_total := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
    v_break := CASE WHEN v_total > 9 THEN 45 WHEN v_total > 6 THEN 30 ELSE 0 END;
    NEW.break_minutes := v_break;
    NEW.hours_worked  := ROUND(GREATEST(0, v_total - v_break / 60.0)::numeric, 2);
  ELSE
    NEW.clock_out     := OLD.clock_out;
    NEW.break_minutes := OLD.break_minutes;
    NEW.hours_worked  := OLD.hours_worked;
  END IF;
  RETURN NEW;
END $$;

-- ── 2. Urlaub: Mitarbeiter können sich nicht selbst genehmigen ─────────────
CREATE OR REPLACE FUNCTION public.vacation_guard_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF is_manager_or_admin() THEN RETURN NEW; END IF;
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
  -- Arbeitstage wie in der App: Mo–Fr ohne gesetzliche Feiertage (Hessen)
  SELECT count(*) INTO NEW.days_count
    FROM generate_series(NEW.start_date, NEW.end_date, interval '1 day') g(d)
   WHERE EXTRACT(ISODOW FROM g.d) < 6
     AND NOT EXISTS (SELECT 1 FROM public_holidays h WHERE h.date = g.d::date AND h.bundesland = 'Hessen');
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.vacation_guard_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_vacation_guard_insert ON vacation_requests;
CREATE TRIGGER trg_vacation_guard_insert BEFORE INSERT ON vacation_requests
  FOR EACH ROW EXECUTE FUNCTION public.vacation_guard_insert();

-- ── 3. Krankmeldungen: Attest nur mit echter hochgeladener Datei ───────────
CREATE OR REPLACE FUNCTION public.sick_leave_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF is_manager_or_admin() THEN RETURN NEW; END IF;
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
  -- UPDATE durch Mitarbeiter: nur das Attest darf nachgereicht werden
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
REVOKE EXECUTE ON FUNCTION public.sick_leave_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_sick_leave_guard ON sick_leave;
CREATE TRIGGER trg_sick_leave_guard BEFORE INSERT OR UPDATE ON sick_leave
  FOR EACH ROW EXECUTE FUNCTION public.sick_leave_guard();

-- Mitarbeiter dürfen nur eigene, frische (24 h) Krankmeldungen ohne Attest löschen
DROP POLICY IF EXISTS employee_delete_own_sickleve ON sick_leave;
CREATE POLICY sick_delete_own_recent ON sick_leave FOR DELETE TO authenticated
  USING (employee_id = my_employee_id()
         AND certificate_file_path IS NULL
         AND created_at > now() - interval '24 hours');
DROP POLICY IF EXISTS employee_update_own_certificate ON sick_leave;
CREATE POLICY sick_update_own_certificate ON sick_leave FOR UPDATE TO authenticated
  USING (employee_id = my_employee_id()) WITH CHECK (employee_id = my_employee_id());
-- (Manager/Admin: weiterhin über sick_manage)

-- Atteste nach dem Hochladen nicht mehr durch Mitarbeiter überschreibbar
DROP POLICY IF EXISTS sick_certs_update ON storage.objects;
CREATE POLICY sick_certs_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'sick-certs' AND is_manager_or_admin());

-- ── 4. Schichttausch: nur erlaubte Statuswechsel ───────────────────────────
CREATE OR REPLACE FUNCTION public.swap_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE me uuid := my_employee_id();
BEGIN
  IF is_manager_or_admin() THEN RETURN NEW; END IF;
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
  -- UPDATE
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
REVOKE EXECUTE ON FUNCTION public.swap_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_swap_guard ON shift_swap_requests;
CREATE TRIGGER trg_swap_guard BEFORE INSERT OR UPDATE ON shift_swap_requests
  FOR EACH ROW EXECUTE FUNCTION public.swap_guard();

-- ── 5. Protokoll: Name & Rolle kommen immer vom Server ─────────────────────
CREATE OR REPLACE FUNCTION public.log_activity(p_action text, p_category text, p_summary text,
  p_actor_name text DEFAULT NULL, p_actor_role text DEFAULT NULL, p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL, p_target_name text DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid; v_role text; v_name text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Nicht authentifiziert'; END IF;
  -- p_actor_name / p_actor_role werden bewusst ignoriert (Fälschungsschutz)
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
END $$;

-- ── 6. Profil: Name/E-Mail nicht selbst änderbar (nur über geprüfte Abläufe) ─
CREATE OR REPLACE FUNCTION public.lock_profile_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public' AS $$
BEGIN
  -- current_user = 'authenticated' nur bei direktem API-Zugriff aus dem Browser,
  -- nicht innerhalb geprüfter Server-Funktionen (Onboarding, Freischaltung)
  IF current_user = 'authenticated' AND NOT is_admin() THEN
    NEW.first_name := OLD.first_name;
    NEW.last_name  := OLD.last_name;
    NEW.email      := OLD.email;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_lock_profile_identity ON profiles;
CREATE TRIGGER trg_lock_profile_identity BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.lock_profile_identity();

-- Profilbilder: nur Bilder, maximal ~400 KB
ALTER TABLE profiles  DROP CONSTRAINT IF EXISTS profiles_avatar_url_safe;
ALTER TABLE profiles  ADD  CONSTRAINT profiles_avatar_url_safe CHECK (avatar_url IS NULL OR (length(avatar_url) <= 400000
  AND (avatar_url ~ '^data:image/(png|jpeg|jpg|webp);base64,' OR avatar_url LIKE 'https://%')));
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_avatar_url_safe;
ALTER TABLE employees ADD  CONSTRAINT employees_avatar_url_safe CHECK (avatar_url IS NULL OR (length(avatar_url) <= 400000
  AND (avatar_url ~ '^data:image/(png|jpeg|jpg|webp);base64,' OR avatar_url LIKE 'https://%')));

-- ── 7. Nur freigeschaltete Accounts sehen Schichtplan, Kollegen, Einstellungen ─
DROP POLICY IF EXISTS shifts_read ON shifts;
CREATE POLICY shifts_read ON shifts FOR SELECT TO authenticated USING (is_approved());
DROP POLICY IF EXISTS set_read ON cafe_settings;
CREATE POLICY set_read ON cafe_settings FOR SELECT TO authenticated USING (is_approved());
CREATE OR REPLACE FUNCTION public.get_employees_directory()
RETURNS TABLE(id uuid, first_name character varying, last_name character varying, avatar_color character varying,
              avatar_url text, "position" character varying, hours_per_week numeric, employment_type character varying, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT id, first_name, last_name, avatar_color, avatar_url, "position", hours_per_week, employment_type, is_active
    FROM employees WHERE is_approved()
$$;

-- ── 8. Profilbild-Speicher nicht mehr öffentlich auflistbar ────────────────
DROP POLICY IF EXISTS avatars_public ON storage.objects;
DROP POLICY IF EXISTS avatars_read ON storage.objects;
CREATE POLICY avatars_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND is_approved());
UPDATE storage.buckets SET public = false WHERE id = 'avatars';

-- ── 9. Alte Schnittstellen stilllegen ─────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.update_own_employee_profile(text, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_invitation(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_manager_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_manager_or_admin() TO authenticated;
