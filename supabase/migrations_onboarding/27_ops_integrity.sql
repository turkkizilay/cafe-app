-- ============================================================
-- 27 · Betriebsintegrität vor dem Go-Live (additiv, keine Datenänderung)
-- • Schichttausch: shift_swap_requests.target_shift_id verwies OHNE Löschregel auf shifts. Folge: Eine Schicht,
--   die je als Gegenschicht in einer Tauschanfrage stand (auch abgelehnt/erledigt), war für Manager UND Admin nicht
--   mehr löschbar (FK-Fehler, kein Weg in der App). Jetzt wie die Anfrage-Seite (requester_shift_id): ON DELETE
--   CASCADE – eine Tauschanfrage ohne ihre Schicht ist gegenstandslos. SET NULL wäre falsch: aus einem Tausch würde
--   eine „Abgabe“, die approve_swap dann ohne Gegenschicht ausführen würde.
-- • Krankmeldungen/Urlaubsanträge: breite FOR-ALL-Policies (sick_manage, vac_manage) erlaubten Managern auch
--   DELETE – Krankmeldungen samt Attest-Verweis wurden ohne Protokoll gelöscht (Attest-Datei verwaist, da Manager seit
--   Migration 22 keine Dateien löschen), genehmigter Urlaub per direktem REST-Aufruf. Ersetzt durch getrennte
--   Policies: Manager/Admin lesen (bestehende *_read), anlegen, ändern; LÖSCHEN nur Admin. Eigene Löschrechte der
--   Mitarbeiter (sick_delete_own_recent, vac_delete_own_pending) bleiben unverändert.
-- • Mindestens ein Admin: Die DB erlaubte dem EINZIGEN freigeschalteten Admin, sich selbst herabzustufen oder zu
--   sperren (nur das Frontend verhinderte es) → niemand könnte die App mehr verwalten, nur per manuellem DB-Eingriff
--   reparierbar. Trigger ensure_admin_remains: Änderung/Löschung, nach der kein freigeschalteter Admin mehr übrig
--   wäre, wird abgelehnt. Serialisiert per Transaktions-Advisory-Lock (zwei Admins gleichzeitig → nie null).
-- • Personalnummer (DATEV): employees.personnel_number – feste Nummer je Person, eindeutig (auch über Ausgeschiedene),
--   nur Ziffern. Der Export nutzt ausschließlich diese Nummer (vorher: laufende Zeilennummer der gefilterten Liste).
--   Keine automatische Vergabe/kein Backfill: die Nummer muss der aus DATEV/Lohnbüro entsprechen.
-- • Admin-Zeitkorrektur atomar: admin_save_time_entry / admin_delete_time_entry – Eintrag, Pausen, Stunden und
--   Korrekturprotokoll in EINER Transaktion; veraltete Ansicht (Eintrag/Pausen inzwischen geändert) → Abbruch.
--   Zeiten kommen als Datum + Wanduhrzeit (Europe/Berlin): Uhrzeiten VOR der Einstempelzeit gehören zum Folgetag
--   (Schichten über Mitternacht, jede Schicht < 24 h). Die Umrechnung in Zeitstempel macht die DB – Sommer-/Winterzeit
--   korrekt, unabhängig von der Zeitzone des Browsers. Stunden = Anwesenheit − erfasste Pausen (serverseitig).
-- • Datenschutz-Nachweise bei Kontolöschung: Wird ein App-Konto gelöscht (Selbstlöschung, Aufbewahrungsfristen),
--   verschwanden die Kenntnisnahmen per CASCADE. Jetzt werden sie vorher in privacy_proof_history an die
--   Personalakte (employee_id) gehängt und teilen deren Lebensdauer (werden mit der Personalakte gelöscht, z. B. über
--   die bestehende Aufbewahrungs-Löschung „ausgeschiedene Mitarbeiter“). Keine neue Frist. Konten OHNE Personalakte
--   (nie freigeschaltete Registrierungen): unverändert – Aufbewahrung dafür ist eine offene organisatorische Frage.
-- • Offboarding: admin_offboarding_check(employee) – read-only Übersicht offener Punkte vor dem Deaktivieren
--   (zukünftige Schichten, offene Tauschanfragen, offene/künftige Urlaube, offene Schicht, offene Krankmeldung).
--   Es wird nichts automatisch gelöscht oder abgelehnt.
-- Bereits live eingespielt (Migration ops_integrity, 2026-09-29) — NICHT erneut ausführen.
-- ============================================================

ALTER TABLE public.shift_swap_requests DROP CONSTRAINT shift_swap_requests_target_shift_id_fkey;
ALTER TABLE public.shift_swap_requests ADD CONSTRAINT shift_swap_requests_target_shift_id_fkey
  FOREIGN KEY (target_shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;

DROP POLICY IF EXISTS sick_manage ON public.sick_leave;
CREATE POLICY sick_manage_insert ON public.sick_leave FOR INSERT TO authenticated WITH CHECK (public.is_manager_or_admin());
CREATE POLICY sick_manage_update ON public.sick_leave FOR UPDATE TO authenticated USING (public.is_manager_or_admin()) WITH CHECK (public.is_manager_or_admin());
CREATE POLICY sick_admin_delete  ON public.sick_leave FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS vac_manage ON public.vacation_requests;
CREATE POLICY vac_manage_insert ON public.vacation_requests FOR INSERT TO authenticated WITH CHECK (public.is_manager_or_admin());
CREATE POLICY vac_manage_update ON public.vacation_requests FOR UPDATE TO authenticated USING (public.is_manager_or_admin()) WITH CHECK (public.is_manager_or_admin());
CREATE POLICY vac_admin_delete  ON public.vacation_requests FOR DELETE TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.ensure_admin_remains() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT (OLD.role = 'admin' AND OLD.status = 'approved') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'approved' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cafe.ensure_admin_remains'));
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id <> OLD.id AND role = 'admin' AND status = 'approved') THEN
    RAISE EXCEPTION 'Es muss mindestens ein freigeschalteter Admin bleiben. Bitte zuerst eine andere Person zum Admin machen.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION public.ensure_admin_remains() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_ensure_admin_remains ON public.profiles;
CREATE TRIGGER trg_ensure_admin_remains BEFORE UPDATE OF role, status OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.ensure_admin_remains();

-- ── Personalnummer ───────────────────────────────────────────
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS personnel_number text;
ALTER TABLE public.employees ADD CONSTRAINT employees_personnel_number_format
  CHECK (personnel_number IS NULL OR personnel_number ~ '^[0-9]{1,10}$');
CREATE UNIQUE INDEX IF NOT EXISTS employees_personnel_number_key ON public.employees (personnel_number)
  WHERE personnel_number IS NOT NULL;

-- ── Admin-Zeitkorrektur (atomar) ─────────────────────────────
-- Wanduhrzeit (Europe/Berlin) → Zeitstempel. Uhrzeiten vor p_in gehören zum Folgetag.
CREATE OR REPLACE FUNCTION public._shift_ts(p_date date, p_in time, p_t time) RETURNS timestamptz
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$ SELECT ((p_date + CASE WHEN p_t < p_in THEN 1 ELSE 0 END) + p_t) AT TIME ZONE 'Europe/Berlin' $$;
REVOKE ALL ON FUNCTION public._shift_ts(date, time, time) FROM PUBLIC, anon, authenticated;

-- Vergleichswert für optimistische Sperre: Ein-/Ausstempelzeit + Pausen in Epoch-Sekunden
CREATE OR REPLACE FUNCTION public._time_entry_state(p_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'clock_in',  floor(extract(epoch FROM e.clock_in))::bigint,
    'clock_out', floor(extract(epoch FROM e.clock_out))::bigint,
    'breaks', COALESCE((SELECT jsonb_agg(jsonb_build_array(floor(extract(epoch FROM b.break_start))::bigint,
                                                           floor(extract(epoch FROM b.break_end))::bigint) ORDER BY b.break_start)
                        FROM time_entry_breaks b WHERE b.time_entry_id = e.id), '[]'::jsonb))
  FROM time_entries e WHERE e.id = p_id $$;
REVOKE ALL ON FUNCTION public._time_entry_state(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._time_entry_label(p_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT to_char(e.clock_in AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI') || ' – ' ||
         COALESCE(to_char(e.clock_out AT TIME ZONE 'Europe/Berlin',
                  CASE WHEN (e.clock_out AT TIME ZONE 'Europe/Berlin')::date <> (e.clock_in AT TIME ZONE 'Europe/Berlin')::date
                       THEN 'DD.MM. HH24:MI' ELSE 'HH24:MI' END), 'offen') ||
         COALESCE(' | Pausen: ' || (SELECT string_agg(to_char(b.break_start AT TIME ZONE 'Europe/Berlin', 'HH24:MI') || '–' ||
                                                     COALESCE(to_char(b.break_end AT TIME ZONE 'Europe/Berlin', 'HH24:MI'), 'offen'), ', ' ORDER BY b.break_start)
                                    FROM time_entry_breaks b WHERE b.time_entry_id = e.id), '')
  FROM time_entries e WHERE e.id = p_id $$;
REVOKE ALL ON FUNCTION public._time_entry_label(uuid) FROM PUBLIC, anon, authenticated;

-- p_id NULL = neuer Eintrag (p_employee_id Pflicht); sonst Korrektur mit p_expected (Stand der Admin-Ansicht).
-- p_breaks: [{"start":"HH:MM","end":"HH:MM"|null}]; ohne Pausenzeilen gilt p_break_minutes (Altbestand).
CREATE OR REPLACE FUNCTION public.admin_save_time_entry(
  p_id uuid, p_employee_id uuid, p_date date, p_in time, p_out time, p_breaks jsonb,
  p_break_minutes integer, p_notes text, p_reason text, p_expected jsonb)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_in timestamptz; v_out timestamptz; v_id uuid := p_id; v_emp uuid; b jsonb; v_bs timestamptz; v_be timestamptz;
  v_old text; v_new text; v_old_breaks jsonb; v_break_min int; v_hours numeric; v_cnt int := 0;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Bitte einen Grund für die Korrektur angeben.'; END IF;
  IF p_date IS NULL OR p_in IS NULL THEN RAISE EXCEPTION 'Datum und Einstempelzeit sind Pflicht.'; END IF;
  IF p_out IS NOT NULL AND p_out = p_in THEN RAISE EXCEPTION 'Ein- und Ausstempelzeit dürfen nicht gleich sein.'; END IF;
  IF p_breaks IS NOT NULL AND jsonb_typeof(p_breaks) <> 'array' THEN RAISE EXCEPTION 'Ungültige Pausen.'; END IF;
  v_in  := _shift_ts(p_date, p_in, p_in);
  v_out := CASE WHEN p_out IS NULL THEN NULL ELSE _shift_ts(p_date, p_in, p_out) END;

  IF v_id IS NULL THEN
    IF p_employee_id IS NULL OR NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id) THEN
      RAISE EXCEPTION 'Mitarbeiter nicht gefunden.';
    END IF;
    v_emp := p_employee_id;
    -- direkt mit Zielzeiten (kein Zwischenstand „offen“ – sonst Konflikt mit einer laufenden Schicht der Person)
    INSERT INTO time_entries (employee_id, date, clock_in, clock_out, break_minutes, notes, approved)
    VALUES (v_emp, p_date, v_in, v_out, 0, trim('[ADMIN-KORREKTUR] ' || COALESCE(p_notes, '')), true)
    RETURNING id INTO v_id;
    v_old := NULL; v_old_breaks := '[]'::jsonb;
  ELSE
    SELECT employee_id INTO v_emp FROM time_entries WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Der Zeiteintrag existiert nicht mehr. Bitte die Ansicht aktualisieren.'; END IF;
    IF p_expected IS NULL OR _time_entry_state(v_id) IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'Der Zeiteintrag wurde inzwischen geändert (z. B. ausgestempelt oder Pause). Bitte die Ansicht aktualisieren und erneut korrigieren.';
    END IF;
    v_old := _time_entry_label(v_id);
    v_old_breaks := _time_entry_state(v_id)->'breaks';
    DELETE FROM time_entry_breaks WHERE time_entry_id = v_id;
    -- Zielzeiten direkt setzen (Pausen danach dagegen prüfen); kein Zwischenstand „offen“
    UPDATE time_entries SET date = p_date, clock_in = v_in, clock_out = v_out,
           notes = trim('[ADMIN-KORREKTUR] ' || COALESCE(p_notes, '')), approved = true
     WHERE id = v_id;
  END IF;

  FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_breaks, '[]'::jsonb)) LOOP
    IF NULLIF(b->>'start', '') IS NULL THEN RAISE EXCEPTION 'Jede Pause braucht einen Beginn.'; END IF;
    v_bs := _shift_ts(p_date, p_in, (b->>'start')::time);
    v_be := CASE WHEN NULLIF(b->>'end', '') IS NULL THEN NULL ELSE _shift_ts(p_date, p_in, (b->>'end')::time) END;
    IF v_out IS NOT NULL AND (v_be IS NULL OR v_be > v_out OR v_bs >= v_out) THEN
      RAISE EXCEPTION 'Jede Pause muss innerhalb der Schicht liegen und enden.';
    END IF;
    INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end, closed_by)
    VALUES (v_id, v_emp, v_bs, v_be, CASE WHEN v_be IS NULL THEN NULL ELSE 'admin' END);
    v_cnt := v_cnt + 1;
  END LOOP;

  IF v_out IS NOT NULL THEN
    IF v_cnt > 0 THEN
      SELECT GREATEST(0, ROUND(COALESCE(sum(EXTRACT(EPOCH FROM (break_end - break_start))), 0) / 60.0))::int INTO v_break_min
        FROM time_entry_breaks WHERE time_entry_id = v_id;
    ELSE
      v_break_min := GREATEST(0, COALESCE(p_break_minutes, 0));
    END IF;
    v_hours := ROUND(GREATEST(0, EXTRACT(EPOCH FROM (v_out - v_in)) / 3600.0 - v_break_min / 60.0)::numeric, 2);
    UPDATE time_entries SET clock_out = v_out, break_minutes = v_break_min, hours_worked = v_hours WHERE id = v_id;
  ELSE
    UPDATE time_entries SET break_minutes = 0, hours_worked = NULL WHERE id = v_id;
  END IF;

  v_new := _time_entry_label(v_id);
  INSERT INTO time_corrections (time_entry_id, employee_id, corrected_by, field_changed, old_value, new_value, reason)
  VALUES (v_id, v_emp, auth.uid(), CASE WHEN p_id IS NULL THEN 'new_entry' ELSE 'manual_edit' END, v_old, v_new, trim(p_reason));
  RETURN jsonb_build_object('success', true, 'id', v_id, 'hours_worked', v_hours, 'break_minutes', v_break_min,
                            'clock_in', v_in, 'clock_out', v_out, 'state', _time_entry_state(v_id));
END $$;
REVOKE ALL ON FUNCTION public.admin_save_time_entry(uuid, uuid, date, time, time, jsonb, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_time_entry(uuid, uuid, date, time, time, jsonb, integer, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_time_entry(p_id uuid, p_reason text, p_expected jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_emp uuid; v_old text;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Bitte einen Grund für das Löschen angeben.'; END IF;
  SELECT employee_id INTO v_emp FROM time_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', true, 'already', true); END IF;
  IF p_expected IS NULL OR _time_entry_state(p_id) IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'Der Zeiteintrag wurde inzwischen geändert. Bitte die Ansicht aktualisieren und erneut prüfen.';
  END IF;
  v_old := _time_entry_label(p_id);
  INSERT INTO time_corrections (time_entry_id, employee_id, corrected_by, field_changed, old_value, new_value, reason)
  VALUES (p_id, v_emp, auth.uid(), 'deleted', v_old, NULL, trim(p_reason));
  DELETE FROM time_entries WHERE id = p_id;   -- Pausen per CASCADE; Protokoll bleibt (Verweis → NULL)
  RETURN jsonb_build_object('success', true, 'already', false);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_time_entry(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_time_entry(uuid, text, jsonb) TO authenticated;

-- ── Datenschutz-Nachweise überdauern die Kontolöschung (an der Personalakte) ──
CREATE TABLE IF NOT EXISTS public.privacy_proof_history (
  employee_id     uuid        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  source          text        NOT NULL CHECK (source IN ('portal', 'onboarding')),
  notice_version  text        NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  archived_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, source, notice_version)
);
ALTER TABLE public.privacy_proof_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_proof_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.privacy_proof_history TO authenticated;
DROP POLICY IF EXISTS pph_admin_read ON public.privacy_proof_history;
CREATE POLICY pph_admin_read ON public.privacy_proof_history FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.archive_privacy_proof() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_emp uuid;
BEGIN
  v_emp := COALESCE(OLD.employee_id, (SELECT o.employee_id FROM employee_onboarding o WHERE o.profile_id = OLD.id));
  IF v_emp IS NULL OR NOT EXISTS (SELECT 1 FROM employees WHERE id = v_emp) THEN RETURN OLD; END IF;
  INSERT INTO privacy_proof_history (employee_id, source, notice_version, acknowledged_at)
  SELECT v_emp, 'portal', a.notice_version, a.acknowledged_at FROM privacy_notice_acknowledgements a WHERE a.profile_id = OLD.id
  ON CONFLICT DO NOTHING;
  INSERT INTO privacy_proof_history (employee_id, source, notice_version, acknowledged_at)
  SELECT v_emp, 'onboarding', 'onboarding', o.privacy_accepted_at FROM employee_onboarding o
   WHERE o.profile_id = OLD.id AND o.privacy_accepted_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.archive_privacy_proof() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_archive_privacy_proof ON public.profiles;
CREATE TRIGGER trg_archive_privacy_proof BEFORE DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.archive_privacy_proof();

-- ── Offboarding: offene Punkte vor dem Deaktivieren (read-only) ──
CREATE OR REPLACE FUNCTION public.admin_offboarding_check(p_employee_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE today date := (now() AT TIME ZONE 'Europe/Berlin')::date;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id) THEN RAISE EXCEPTION 'Mitarbeiter nicht gefunden.'; END IF;
  RETURN jsonb_build_object(
    'open_time_entry',   EXISTS (SELECT 1 FROM time_entries WHERE employee_id = p_employee_id AND clock_out IS NULL),
    'future_shifts',     (SELECT count(*) FROM shifts WHERE employee_id = p_employee_id AND date >= today),
    'next_shift',        (SELECT min(date) FROM shifts WHERE employee_id = p_employee_id AND date >= today),
    'open_swaps',        (SELECT count(*) FROM shift_swap_requests WHERE status IN ('open', 'accepted')
                            AND (requester_id = p_employee_id OR target_id = p_employee_id)),
    'pending_vacation',  (SELECT count(*) FROM vacation_requests WHERE employee_id = p_employee_id AND status = 'pending'),
    'future_vacation',   (SELECT count(*) FROM vacation_requests WHERE employee_id = p_employee_id AND status = 'approved' AND end_date >= today),
    'open_sick_leave',   (SELECT count(*) FROM sick_leave WHERE employee_id = p_employee_id AND (end_date IS NULL OR end_date >= today)));
END $$;
REVOKE ALL ON FUNCTION public.admin_offboarding_check(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_offboarding_check(uuid) TO authenticated;
