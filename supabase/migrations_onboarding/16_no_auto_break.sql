-- ============================================================
-- 16 · Keine automatische Pause beim Ausclocken
-- Café Buur hat keine fest eingeplanten Pausen. Bisher hat der Trigger beim
-- Ausclocken durch Mitarbeiter pauschal 30 Min. (> 6 Std.) bzw. 45 Min.
-- (> 9 Std.) abgezogen. Jetzt zählt nur eine tatsächlich erfasste Pause
-- (break_minutes des Eintrags, sonst 0).
-- Einzige Änderung gegenüber 09: Zeile „v_break := …“.
-- Bestehende Einträge werden NICHT verändert.
-- Bereits live eingespielt (Migration no_auto_break, 2026-09-25) — NICHT erneut ausführen.
-- ============================================================

CREATE OR REPLACE FUNCTION public.prevent_time_entry_backdating()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
END $function$;
