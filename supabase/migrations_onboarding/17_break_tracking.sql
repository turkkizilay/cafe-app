-- ============================================================
-- 17 · Pausen erfassen: „Pause starten / Pause beenden“
-- • Neue Tabelle time_entry_breaks (mehrere Pausen je Schicht, max. 1 offen)
-- • Mitarbeiter schreiben NUR über start_break() / end_break() (Serverzeit,
--   keine Standortprüfung). Korrekturen nur durch den Admin.
-- • Ausclocken: offene Pause wird zur Ausclock-Zeit beendet; break_minutes =
--   Summe der erfassten Pausen. Ohne Pausen-Zeilen bleibt OLD.break_minutes
--   (historische/manuelle Einträge unverändert). Keine automatische Pause.
-- • Bestehende Daten werden NICHT verändert.
-- Bereits live eingespielt (Migrationen break_tracking + break_tracking_lock_guard, 2026-09-25)
-- — NICHT erneut ausführen.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.time_entry_breaks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id uuid NOT NULL REFERENCES public.time_entries(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  break_start   timestamptz NOT NULL,
  break_end     timestamptz,
  closed_by     text CHECK (closed_by IN ('employee', 'clock_out', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_entry_breaks_end_after_start CHECK (break_end IS NULL OR break_end > break_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_entry_breaks_one_open
  ON public.time_entry_breaks (time_entry_id) WHERE break_end IS NULL;
CREATE INDEX IF NOT EXISTS time_entry_breaks_employee ON public.time_entry_breaks (employee_id, break_start);

ALTER TABLE public.time_entry_breaks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.time_entry_breaks FROM anon;
DROP POLICY IF EXISTS breaks_read  ON public.time_entry_breaks;
DROP POLICY IF EXISTS breaks_admin ON public.time_entry_breaks;
CREATE POLICY breaks_read  ON public.time_entry_breaks FOR SELECT
  USING (employee_id = my_employee_id() OR is_manager_or_admin());
CREATE POLICY breaks_admin ON public.time_entry_breaks FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

-- ── Plausibilität (gilt auch für Admin-Korrekturen) ──────────
CREATE OR REPLACE FUNCTION public.time_entry_breaks_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE e record;
BEGIN
  SELECT employee_id, clock_in, clock_out INTO e FROM time_entries WHERE id = NEW.time_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Zeiteintrag für die Pause nicht gefunden.'; END IF;
  NEW.employee_id := e.employee_id;
  IF NEW.break_end IS NOT NULL AND NEW.break_end <= NEW.break_start THEN
    RAISE EXCEPTION 'Das Pausenende muss nach dem Pausenbeginn liegen.';
  END IF;
  IF NEW.break_start < e.clock_in THEN
    RAISE EXCEPTION 'Die Pause kann nicht vor dem Einclocken beginnen.';
  END IF;
  IF e.clock_out IS NOT NULL AND (NEW.break_end IS NULL OR NEW.break_end > e.clock_out) THEN
    RAISE EXCEPTION 'Die Pause muss vor dem Ausclocken enden.';
  END IF;
  IF EXISTS (SELECT 1 FROM time_entry_breaks b
             WHERE b.time_entry_id = NEW.time_entry_id AND b.id <> NEW.id
               AND tstzrange(b.break_start, COALESCE(b.break_end, 'infinity'))
                && tstzrange(NEW.break_start, COALESCE(NEW.break_end, 'infinity'))) THEN
    RAISE EXCEPTION 'Pausen dürfen sich nicht überschneiden.';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_time_entry_breaks_guard ON public.time_entry_breaks;
CREATE TRIGGER trg_time_entry_breaks_guard BEFORE INSERT OR UPDATE ON public.time_entry_breaks
  FOR EACH ROW EXECUTE FUNCTION public.time_entry_breaks_guard();
-- Trigger-Funktion nicht per API aufrufbar (wie lock_down_trigger_function_execute_grants)
REVOKE ALL ON FUNCTION public.time_entry_breaks_guard() FROM PUBLIC, anon, authenticated;

-- ── Mitarbeiter: Pause starten / beenden (keine Standortprüfung) ──
CREATE OR REPLACE FUNCTION public.start_break()
RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_emp uuid := my_employee_id(); v_entry uuid; r time_entry_breaks;
BEGIN
  IF v_emp IS NULL OR NOT COALESCE(my_is_active_employee(), false) THEN
    RAISE EXCEPTION 'Dein Mitarbeiterkonto ist nicht aktiv.';
  END IF;
  SELECT id INTO v_entry FROM time_entries
   WHERE employee_id = v_emp AND clock_out IS NULL
   ORDER BY clock_in DESC LIMIT 1 FOR UPDATE;
  IF v_entry IS NULL THEN RAISE EXCEPTION 'Du bist nicht eingeclockt.'; END IF;
  IF EXISTS (SELECT 1 FROM time_entry_breaks WHERE time_entry_id = v_entry AND break_end IS NULL) THEN
    RAISE EXCEPTION 'Deine Pause läuft bereits.';
  END IF;
  INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start)
  VALUES (v_entry, v_emp, now()) RETURNING * INTO r;
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.end_break()
RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_emp uuid := my_employee_id(); r time_entry_breaks;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Dein Mitarbeiterkonto ist nicht aktiv.'; END IF;
  UPDATE time_entry_breaks b SET break_end = now(), closed_by = 'employee'
   FROM time_entries t
   WHERE b.time_entry_id = t.id AND t.employee_id = v_emp AND t.clock_out IS NULL AND b.break_end IS NULL
   RETURNING b.* INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Es läuft keine Pause.'; END IF;
  RETURN r;
END $function$;

REVOKE ALL ON FUNCTION public.start_break() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_break()   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_break() TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_break()   TO authenticated;

-- ── Beim Ausclocken: offene Pause schließen, Summe in Minuten (NULL = keine Pausen erfasst)
CREATE OR REPLACE FUNCTION public._close_and_sum_breaks(p_entry uuid, p_end timestamptz)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_cnt int; v_sec numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM time_entry_breaks WHERE time_entry_id = p_entry
             AND (break_start > p_end OR break_end > p_end)) THEN
    RAISE EXCEPTION 'Die Ausclock-Zeit liegt vor dem Ende einer Pause. Bitte zuerst die Pausen korrigieren.';
  END IF;
  -- im selben Moment gestartete Pause hat keine Dauer → entfällt
  DELETE FROM time_entry_breaks WHERE time_entry_id = p_entry AND break_end IS NULL AND break_start = p_end;
  UPDATE time_entry_breaks SET break_end = p_end, closed_by = 'clock_out'
   WHERE time_entry_id = p_entry AND break_end IS NULL;
  SELECT count(*), COALESCE(sum(EXTRACT(EPOCH FROM (break_end - break_start))), 0)
    INTO v_cnt, v_sec FROM time_entry_breaks WHERE time_entry_id = p_entry;
  IF v_cnt = 0 THEN RETURN NULL; END IF;
  RETURN GREATEST(0, ROUND(v_sec / 60.0))::int;
END $function$;
REVOKE ALL ON FUNCTION public._close_and_sum_breaks(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── Ausclocken (Stand 16) + erfasste Pausen ─────────────────
CREATE OR REPLACE FUNCTION public.prevent_time_entry_backdating()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_total numeric; v_break int; v_sum int; loc jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF is_admin() THEN
    -- Admin: Werte der App gelten; nur wenn Pausen erfasst sind, zählen diese
    IF NEW.clock_out IS NOT NULL AND OLD.clock_out IS NULL THEN
      v_sum := _close_and_sum_breaks(NEW.id, NEW.clock_out);
      IF v_sum IS NOT NULL THEN
        NEW.break_minutes := v_sum;
        NEW.hours_worked  := ROUND(GREATEST(0, EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0 - v_sum / 60.0)::numeric, 2);
      END IF;
    END IF;
    RETURN NEW;
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
