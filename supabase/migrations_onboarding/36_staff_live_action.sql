-- ============================================================
-- 36 · Stellvertretende Live-Buchung durch Manager/Admin („JETZT“, Serverzeit) – KEINE Zeitkorrektur
-- (additiv: eine Audit-Tabelle, eine RPC, zwei interne Pausen-Funktionen; Trigger um einen Zweig erweitert.
--  Keine Datenänderung, kein Backfill.)
--
-- staff_live_action(employee, action, expected_state, confirmed) – nur Manager/Admin (Rolle live aus profiles),
-- nur für ANDERE Personen, nur mit Serverzeit (es gibt keinen Zeit-Parameter). Vergangene Zeiten bleiben
-- ausschließlich in der Zeitkorrektur (admin_save_time_entry, nur Admin) – diese Funktion gibt keine Korrekturrechte.
--
-- Zustandsmaschine je Person (abgeleitet, nie gespeichert):
--   OFF_CLOCK  (kein offener Eintrag)            → clock_in
--   WORKING    (offener Eintrag, keine Pause)    → break_start, clock_out
--   ON_BREAK   (offener Eintrag, offene Pause)   → break_end, clock_out
-- Der Client schickt den Zustand mit, den er angezeigt hat; weicht der Server-Zustand ab → code 'stale', nichts
-- passiert (veraltete Ansicht, Doppelklick, zweiter Manager, Mitarbeiter hat selbst gestempelt).
--
-- Wiederverwendet statt dupliziert:
--   • Einstempeln/Ausstempeln laufen über dieselben Trigger wie das Selbststempeln (time_entry_guard_insert,
--     prevent_time_entry_backdating): Serverzeit (clock_timestamp beim Ausstempeln), ein offener Eintrag
--     (Unique-Index), laufende Pause endet mit dem Ausstempeln, > 12 h-Regel, verzögerte Konsistenzprüfung
--     (Migration 34). Neu ist nur ein Zweig: Setzt staff_live_action das transaktionslokale Flag cafe.live_action
--     UND ist die aufrufende Person Manager/Admin, entfällt die Standortprüfung (Methode = 'live_action').
--     Das Selbststempeln, seine Standortregeln und Remote-Stempeln (Migration 29) bleiben unverändert.
--   • Pausen: start_break()/end_break() werden auf zwei interne Funktionen _break_start_for/_break_end_for
--     umgestellt, die staff_live_action ebenfalls nutzt (gleiche Sperre, gleiche Prüfungen, gleiche Meldungen).
--   • Serialisierung je Person: Transaktions-Advisory-Lock (wie Remote-Stempeln) + Zeilensperre des offenen
--     Eintrags (wie Ausstempeln/Pause) + Unique-Index „ein offener Eintrag“.
-- Audit: time_live_actions – nur von dieser Funktion geschrieben (keine Schreibrechte für App-Rollen, also nicht
-- vom Client fälschbar): Mitarbeiter, ausführende Person + Rolle, Aktion, Serverzeit, vorher/nachher, Quelle
-- MANAGER_LIVE_ACTION. Zusätzlich ein Eintrag im Aktivitätsprotokoll (Anzeige) in derselben Transaktion.
-- Rückweg: RPC, Tabelle und die zwei internen Funktionen löschen; Funktionen aus Migration 34 erneut einspielen.
-- Wiederholt ausführbar.
-- Bereits live eingespielt (Migration staff_live_action, Version 20261003091231, 2026-10-03; 44 Objekte inkl. aller
-- pg_get_functiondef, Constraints, Policy und Rechte identisch mit dieser Datei) — NICHT erneut ausführen.
-- ============================================================

-- ── Audit-Tabelle (nur lesen; geschrieben nur von staff_live_action) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.time_live_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  employee_id    uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  time_entry_id  uuid REFERENCES public.time_entries(id) ON DELETE SET NULL,
  actor_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role     text NOT NULL,
  action         text NOT NULL CHECK (action IN ('clock_in', 'break_start', 'break_end', 'clock_out')),
  previous_state text NOT NULL CHECK (previous_state IN ('OFF_CLOCK', 'WORKING', 'ON_BREAK')),
  new_state      text NOT NULL CHECK (new_state IN ('OFF_CLOCK', 'WORKING', 'ON_BREAK')),
  server_time    timestamptz NOT NULL,
  source         text NOT NULL DEFAULT 'MANAGER_LIVE_ACTION' CHECK (source = 'MANAGER_LIVE_ACTION')
);
CREATE INDEX IF NOT EXISTS time_live_actions_employee ON public.time_live_actions (employee_id, created_at);
ALTER TABLE public.time_live_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.time_live_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.time_live_actions TO authenticated;
DROP POLICY IF EXISTS time_live_actions_read ON public.time_live_actions;
CREATE POLICY time_live_actions_read ON public.time_live_actions FOR SELECT TO authenticated
  USING (is_admin() OR employee_id = my_employee_id());

-- Pause, die eine stellvertretende Aktion beendet, ist als solche erkennbar
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entry_breaks_closed_by_check'
                   AND pg_get_constraintdef(oid) LIKE '%live_action%') THEN
    ALTER TABLE public.time_entry_breaks DROP CONSTRAINT IF EXISTS time_entry_breaks_closed_by_check;
    ALTER TABLE public.time_entry_breaks ADD CONSTRAINT time_entry_breaks_closed_by_check
      CHECK (closed_by IN ('employee', 'clock_out', 'admin', 'live_action'));
  END IF;
END $$;

-- ── Pausen: gemeinsamer Kern für Selbst- und stellvertretende Aktion ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public._break_start_for(p_emp uuid)
 RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_entry uuid; r time_entry_breaks;
BEGIN
  SELECT id INTO v_entry FROM time_entries
   WHERE employee_id = p_emp AND clock_out IS NULL
   ORDER BY clock_in DESC LIMIT 1 FOR UPDATE;
  IF v_entry IS NULL THEN RAISE EXCEPTION 'Du bist nicht eingeclockt.'; END IF;
  IF EXISTS (SELECT 1 FROM time_entry_breaks WHERE time_entry_id = v_entry AND break_end IS NULL) THEN
    RAISE EXCEPTION 'Deine Pause läuft bereits.';
  END IF;
  INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start)
  VALUES (v_entry, p_emp, clock_timestamp()) RETURNING * INTO r;
  RETURN r;
END $function$;
REVOKE ALL ON FUNCTION public._break_start_for(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._break_end_for(p_emp uuid, p_closed_by text)
 RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_entry uuid; r time_entry_breaks;
BEGIN
  SELECT id INTO v_entry FROM time_entries
   WHERE employee_id = p_emp AND clock_out IS NULL
   ORDER BY clock_in DESC LIMIT 1 FOR UPDATE;
  IF v_entry IS NOT NULL THEN
    UPDATE time_entry_breaks SET break_end = clock_timestamp(), closed_by = p_closed_by
     WHERE time_entry_id = v_entry AND break_end IS NULL
     RETURNING * INTO r;
  END IF;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Es läuft keine Pause.'; END IF;
  RETURN r;
END $function$;
REVOKE ALL ON FUNCTION public._break_end_for(uuid, text) FROM PUBLIC, anon, authenticated;

-- start_break / end_break: Verhalten und Meldungen wie Migration 34, jetzt über den gemeinsamen Kern
CREATE OR REPLACE FUNCTION public.start_break()
 RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid := my_employee_id();
BEGIN
  IF v_emp IS NULL OR NOT COALESCE(my_is_active_employee(), false) THEN
    RAISE EXCEPTION 'Dein Mitarbeiterkonto ist nicht aktiv.';
  END IF;
  RETURN _break_start_for(v_emp);
END $function$;

CREATE OR REPLACE FUNCTION public.end_break()
 RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid := my_employee_id();
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Dein Mitarbeiterkonto ist nicht aktiv.'; END IF;
  RETURN _break_end_for(v_emp, 'employee');
END $function$;
REVOKE ALL ON FUNCTION public.start_break() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_break()   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_break() TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_break()   TO authenticated;

-- ── Einstempeln (Stand 34) + Zweig für die stellvertretende Live-Aktion ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.time_entry_guard_insert()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE loc jsonb; v_remote boolean := false;
        -- nur für ANDERE Personen: das eigene Stempeln behält immer die Standortregeln
        v_live boolean := COALESCE(current_setting('cafe.live_action', true), '') = 'on' AND is_manager_or_admin()
                          AND NEW.employee_id IS DISTINCT FROM my_employee_id();
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('cafe.time_correction', true), '') = 'on' AND is_admin() THEN RETURN NEW; END IF;
  -- (Mitarbeiter/Manager: RLS lehnt Fremdes ohnehin ab; Admins haben keine Sonderpolicy mehr – klare Meldung)
  IF NOT v_live AND is_admin() AND NEW.employee_id IS DISTINCT FROM my_employee_id() THEN
    RAISE EXCEPTION 'Zeiteinträge für andere Personen bitte über die Zeitkorrektur anlegen.' USING HINT = 'use_time_correction';
  END IF;
  IF EXISTS (SELECT 1 FROM time_entries WHERE employee_id = NEW.employee_id AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'Du bist bereits eingeclockt.';
  END IF;
  IF v_live THEN
    -- stellvertretend durch Manager/Admin (nur aus staff_live_action): kein Standort der Person, Methode markiert
    loc := jsonb_build_object('gps_ok', false);
  ELSE
    loc := _clock_location(NEW.gps_lat_in, NEW.gps_lng_in);
    IF (loc->>'required')::boolean AND NOT ((loc->>'gps_ok')::boolean OR (loc->>'net_ok')::boolean) THEN
      -- Nur clock_in_remote setzt das Flag (nach Rollen-, Standort- und Bestätigungsprüfung); Rolle hier erneut live
      IF COALESCE(current_setting('cafe.remote_clock', true), '') = 'on' AND is_manager_or_admin() THEN
        v_remote := true;
      ELSE
        RAISE EXCEPTION 'Einclocken geht nur im Café: Bitte GPS erlauben oder mit dem Café-WLAN verbinden.';
      END IF;
    END IF;
    IF (loc->>'net_ok')::boolean THEN
      UPDATE cafe_networks SET last_seen_at = now() WHERE id = (loc->>'net_id')::uuid;
    END IF;
  END IF;
  NEW.clock_in        := now();
  NEW.date            := (now() AT TIME ZONE 'Europe/Berlin')::date;
  NEW.clock_out       := NULL;
  NEW.hours_worked    := NULL;
  NEW.break_minutes   := 0;
  NEW.is_overtime     := false;
  NEW.overtime_hours  := 0;
  NEW.approved        := false;
  NEW.gps_ok_in       := CASE WHEN v_live THEN false ELSE (loc->>'gps_ok')::boolean END;
  NEW.clock_in_method := CASE WHEN v_live THEN 'live_action' WHEN v_remote THEN 'remote' ELSE _clock_method(loc) END;
  IF v_remote OR v_live THEN NEW.gps_lat_in := NULL; NEW.gps_lng_in := NULL; END IF;
  NEW.gps_lat_out := NULL; NEW.gps_lng_out := NULL; NEW.gps_ok_out := false; NEW.clock_out_method := NULL;
  RETURN NEW;
END $function$;

-- ── Ausstempeln (Stand 34) + Zweig für die stellvertretende Live-Aktion ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prevent_time_entry_backdating()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_total numeric; v_break int; v_sum int; loc jsonb; v_remote boolean := false;
        -- nur für ANDERE Personen: das eigene Stempeln behält immer die Standortregeln
        v_live boolean := COALESCE(current_setting('cafe.live_action', true), '') = 'on' AND is_manager_or_admin()
                          AND OLD.employee_id IS DISTINCT FROM my_employee_id();
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Admin-Zeitkorrektur: admin_save_time_entry prüft und rechnet selbst (Flag nur dort gesetzt)
  IF COALESCE(current_setting('cafe.time_correction', true), '') = 'on' AND is_admin() THEN RETURN NEW; END IF;
  IF NOT v_live AND is_admin() AND OLD.employee_id IS DISTINCT FROM my_employee_id() THEN
    RAISE EXCEPTION 'Zeiteinträge anderer Personen bitte über die Zeitkorrektur ändern.' USING HINT = 'use_time_correction';
  END IF;
  NEW.employee_id     := OLD.employee_id;
  NEW.date            := OLD.date;
  NEW.clock_in        := OLD.clock_in;
  NEW.gps_lat_in      := OLD.gps_lat_in; NEW.gps_lng_in := OLD.gps_lng_in; NEW.gps_ok_in := OLD.gps_ok_in;
  NEW.clock_in_method := OLD.clock_in_method;
  NEW.approved        := OLD.approved;
  NEW.is_overtime     := OLD.is_overtime;
  NEW.overtime_hours  := OLD.overtime_hours;
  IF NEW.clock_out IS NOT NULL AND OLD.clock_out IS NULL THEN
    IF v_live THEN
      -- stellvertretend durch Manager/Admin (nur aus staff_live_action): kein Standort der Person, Methode markiert
      NEW.gps_ok_out := false; NEW.gps_lat_out := NULL; NEW.gps_lng_out := NULL;
      NEW.clock_out_method := 'live_action';
    ELSE
      loc := _clock_location(NEW.gps_lat_out, NEW.gps_lng_out);
      IF (loc->>'required')::boolean AND NOT ((loc->>'gps_ok')::boolean OR (loc->>'net_ok')::boolean) THEN
        -- Nur clock_out_remote setzt das Flag; Rolle hier erneut live
        IF COALESCE(current_setting('cafe.remote_clock', true), '') = 'on' AND is_manager_or_admin() THEN
          v_remote := true;
        ELSE
          RAISE EXCEPTION 'Ausclocken geht nur im Café: Bitte GPS erlauben oder mit dem Café-WLAN verbinden.';
        END IF;
      END IF;
      IF (loc->>'net_ok')::boolean THEN
        UPDATE cafe_networks SET last_seen_at = now() WHERE id = (loc->>'net_id')::uuid;
      END IF;
      NEW.gps_ok_out       := (loc->>'gps_ok')::boolean;
      NEW.clock_out_method := CASE WHEN v_remote THEN 'remote' ELSE _clock_method(loc) END;
      IF v_remote THEN NEW.gps_lat_out := NULL; NEW.gps_lng_out := NULL; END IF;
    END IF;
    -- Zeit NACH der Zeilensperre: eine inzwischen gestartete Pause liegt nie hinter dem Ausstempeln
    NEW.clock_out := clock_timestamp();
    v_total := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
    v_sum   := _close_and_sum_breaks(NEW.id, NEW.clock_out);   -- offene Pause endet mit dem Ausclocken
    IF v_total > 12 THEN
      NEW.break_minutes := 0;
      NEW.hours_worked  := 0;
      NEW.notes := '⚠️ AUSSTEMPELN VERGESSEN – Zeit bitte korrigieren (' || ROUND(v_total::numeric, 1) || ' Std. offen)';
    ELSE
      v_break := COALESCE(v_sum, OLD.break_minutes, 0);   -- nur tatsächlich erfasste Pausen, keine automatische
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
END $function$;
REVOKE ALL ON FUNCTION public.time_entry_guard_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_time_entry_backdating() FROM PUBLIC, anon, authenticated;

-- ── Stellvertretende Live-Aktion ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_live_action(p_employee_id uuid, p_action text, p_expected_state text, p_confirmed boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_role text; v_actor_name text;
  v_emp record; v_entry uuid; v_state text; v_new text; v_at timestamptz; v_n int; v_br time_entry_breaks;
BEGIN
  IF v_actor IS NULL OR NOT is_manager_or_admin() THEN
    RAISE EXCEPTION 'Nur Manager und Admins dürfen stellvertretend stempeln.' USING HINT = 'live_not_allowed';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('clock_in', 'break_start', 'break_end', 'clock_out') THEN
    RAISE EXCEPTION 'Unbekannte Aktion.' USING HINT = 'live_action_unknown';
  END IF;
  IF p_expected_state IS NULL OR p_expected_state NOT IN ('OFF_CLOCK', 'WORKING', 'ON_BREAK') THEN
    RAISE EXCEPTION 'Unbekannter Ausgangszustand.' USING HINT = 'live_state_unknown';
  END IF;
  IF p_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Bitte die stellvertretende Buchung ausdrücklich bestätigen.' USING HINT = 'live_not_confirmed';
  END IF;
  SELECT id, first_name, last_name, is_active INTO v_emp FROM employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mitarbeiter nicht gefunden.' USING HINT = 'live_employee_missing'; END IF;
  IF p_employee_id = my_employee_id() THEN
    RAISE EXCEPTION 'Für dich selbst bitte normal über „Einclocken“ stempeln.' USING HINT = 'live_self';
  END IF;
  IF p_action IN ('clock_in', 'break_start') AND NOT COALESCE(v_emp.is_active, false) THEN
    RAISE EXCEPTION 'Der Mitarbeiter ist nicht aktiv.' USING HINT = 'live_employee_inactive';
  END IF;

  -- je Person serialisieren (gleicher Schlüssel wie Remote-Stempeln), dann offenen Eintrag sperren
  PERFORM pg_advisory_xact_lock(hashtext('cafe.clock:' || p_employee_id::text));
  SELECT id INTO v_entry FROM time_entries
   WHERE employee_id = p_employee_id AND clock_out IS NULL
   ORDER BY clock_in DESC LIMIT 1 FOR UPDATE;
  v_state := CASE WHEN v_entry IS NULL THEN 'OFF_CLOCK'
                  WHEN EXISTS (SELECT 1 FROM time_entry_breaks WHERE time_entry_id = v_entry AND break_end IS NULL) THEN 'ON_BREAK'
                  ELSE 'WORKING' END;
  IF v_state <> p_expected_state THEN
    RETURN jsonb_build_object('success', false, 'code', 'stale', 'state', v_state);
  END IF;
  IF NOT ((p_action = 'clock_in' AND v_state = 'OFF_CLOCK') OR (p_action = 'break_start' AND v_state = 'WORKING')
       OR (p_action = 'break_end' AND v_state = 'ON_BREAK') OR (p_action = 'clock_out' AND v_state IN ('WORKING', 'ON_BREAK'))) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_transition', 'state', v_state);
  END IF;

  PERFORM set_config('cafe.live_action', 'on', true);
  IF p_action = 'clock_in' THEN
    BEGIN
      -- Zeit, Datum, Methode setzt der Einstempel-Trigger (Serverzeit); ein offener Eintrag per Unique-Index
      INSERT INTO time_entries (employee_id, date, clock_in) VALUES (p_employee_id, (now() AT TIME ZONE 'Europe/Berlin')::date, now())
      RETURNING id, clock_in INTO v_entry, v_at;
    EXCEPTION
      WHEN unique_violation THEN
        PERFORM set_config('cafe.live_action', '', true);
        RETURN jsonb_build_object('success', false, 'code', 'stale', 'state', 'WORKING');
      WHEN raise_exception THEN
        IF SQLERRM LIKE '%bereits eingeclockt%' THEN
          PERFORM set_config('cafe.live_action', '', true);
          RETURN jsonb_build_object('success', false, 'code', 'stale', 'state', 'WORKING');
        END IF;
        RAISE;
    END;
    v_new := 'WORKING';
  ELSIF p_action = 'break_start' THEN
    v_br := _break_start_for(p_employee_id); v_at := v_br.break_start; v_new := 'ON_BREAK';
  ELSIF p_action = 'break_end' THEN
    v_br := _break_end_for(p_employee_id, 'live_action'); v_at := v_br.break_end; v_new := 'WORKING';
  ELSE
    -- Ausstempel-Trigger: Serverzeit nach Sperre, laufende Pause endet mit, > 12 h-Regel, Konsistenzprüfung
    UPDATE time_entries SET clock_out = now() WHERE id = v_entry AND clock_out IS NULL RETURNING clock_out INTO v_at;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      PERFORM set_config('cafe.live_action', '', true);
      RETURN jsonb_build_object('success', false, 'code', 'stale', 'state', 'OFF_CLOCK');
    END IF;
    v_new := 'OFF_CLOCK';
  END IF;
  PERFORM set_config('cafe.live_action', '', true);

  SELECT role, COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) INTO v_role, v_actor_name
    FROM profiles WHERE id = v_actor;
  INSERT INTO time_live_actions (employee_id, time_entry_id, actor_id, actor_role, action, previous_state, new_state, server_time)
  VALUES (p_employee_id, v_entry, v_actor, v_role, p_action, v_state, v_new, v_at);
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name, metadata)
  VALUES (v_actor, v_actor_name, v_role, 'time.live_' || p_action, 'time',
          COALESCE(v_actor_name, 'Manager') || ' hat stellvertretend ' ||
            CASE p_action WHEN 'clock_in' THEN 'eingestempelt' WHEN 'break_start' THEN 'eine Pause gestartet'
                          WHEN 'break_end' THEN 'die Pause beendet' ELSE 'ausgestempelt' END ||
            ' (Serverzeit ' || to_char(v_at AT TIME ZONE 'Europe/Berlin', 'HH24:MI:SS') || ').',
          'time_entry', v_entry::text, CONCAT(v_emp.first_name, ' ', v_emp.last_name),
          jsonb_build_object('source', 'MANAGER_LIVE_ACTION', 'action', p_action, 'previous_state', v_state,
                             'new_state', v_new, 'server_time', v_at));
  RETURN jsonb_build_object('success', true, 'state', v_new, 'previous_state', v_state, 'entry_id', v_entry, 'server_time', v_at);
END $function$;
REVOKE ALL ON FUNCTION public.staff_live_action(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_live_action(uuid, text, text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
