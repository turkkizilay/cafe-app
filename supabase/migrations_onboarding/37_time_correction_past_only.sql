-- ============================================================
-- 37 · Zeitkorrektur nur für Vergangenes, keine überlappenden Zeiteinträge (Audit H1/M1, 2026-10-03)
-- (Funktionen + ein Index – KEINE Datenänderung, kein Backfill, bestehende Einträge werden nicht neu bewertet)
--
-- H1 admin_save_time_entry nahm ein Ende (und damit Pausen) in der Zukunft an: Stunden zählten vor der Arbeit, die
--    Person galt als „nicht eingestempelt“ und konnte erneut (selbst oder stellvertretend) eingestempelt werden.
--    Jetzt: Beginn und Ende dürfen höchstens 1 Minute in der Zukunft liegen (Uhren-/Eingabetoleranz) – für offene
--    UND beendete Schichten. Laufende Arbeit = Stempeln (selbst / Live-Steuerung), Geplantes = Schichtplan.
-- M1 Nichts verhinderte überlappende Einträge derselben Person (nur „ein offener Eintrag“ per Unique-Index).
--    Jetzt dreifach:
--      • admin_save_time_entry lehnt Überschneidungen mit anderen Einträgen der Person ab (klare Meldung mit Zeiten),
--      • der Einstempel-Trigger (Selbst-, Remote- und Live-Einstempeln) lehnt ab, solange ein Eintrag der Person noch
--        nicht zu Ende ist (Ende in der Zukunft – nur bei Altbestand vor dieser Migration möglich),
--      • die verzögerte Konsistenzprüfung (Migration 34) prüft jeden geänderten Eintrag zusätzlich auf Überschneidung.
--    Kein Exclusion-Constraint: Er würde bestehende Daten prüfen (Production enthält ein überlappendes Testpaar) –
--    bestehende Daten werden bewusst nicht verändert; geprüft werden nur neue/geänderte Einträge.
-- Übernommen sind die aktiven Fassungen aus Migration 34 (admin_save_time_entry, time_entry_consistency_check) und
-- 36 (time_entry_guard_insert); geändert sind nur die markierten Prüfungen.
-- Rückweg: die drei Funktionen aus 34/36 erneut einspielen, Index löschen. Wiederholt ausführbar.
-- Bereits live eingespielt (Migration time_correction_past_only, Version 20261004080623, 2026-10-04; alle Funktionen,
-- Trigger, Index, Rechte identisch mit dieser Datei) — NICHT erneut ausführen.
-- ============================================================

-- Überschneidungsprüfung je Person ohne Tabellen-Scan
CREATE INDEX IF NOT EXISTS time_entries_employee_clock_in ON public.time_entries (employee_id, clock_in);

-- ── Einstempeln (Stand 36) + Überschneidung mit einem noch nicht beendeten Eintrag ──────────────────────────
CREATE OR REPLACE FUNCTION public.time_entry_guard_insert()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE loc jsonb; v_remote boolean := false; v_other record;
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
  -- Ein (korrigierter) Eintrag, der jetzt noch nicht zu Ende ist, würde sich mit dem neuen Einstempeln überschneiden
  SELECT clock_in, clock_out INTO v_other FROM time_entries
   WHERE employee_id = NEW.employee_id AND clock_out > now() ORDER BY clock_in LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Für diese Person gibt es bereits einen Zeiteintrag bis %, der sich mit dem Einstempeln überschneiden würde. Bitte zuerst in der Zeitkorrektur prüfen.',
      to_char(v_other.clock_out AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI') USING HINT = 'entry_overlap';
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
REVOKE ALL ON FUNCTION public.time_entry_guard_insert() FROM PUBLIC, anon, authenticated;

-- ── Admin-Zeitkorrektur (Stand 34) + keine Zukunft, keine Überschneidung ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_save_time_entry(
  p_id uuid, p_employee_id uuid, p_date date, p_in time, p_out time, p_breaks jsonb,
  p_break_minutes integer, p_notes text, p_reason text, p_expected jsonb)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_in timestamptz; v_out timestamptz; v_id uuid := p_id; v_emp uuid; b jsonb; v_bs timestamptz; v_be timestamptz;
  v_old text; v_new text; v_break_min int; v_hours numeric; v_cnt int := 0; v_n int := 0;
  v_old_date date; v_legacy int; v_lump int := COALESCE(p_break_minutes, 0); v_other record;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Bitte einen Grund für die Korrektur angeben.'; END IF;
  IF p_date IS NULL OR p_in IS NULL THEN RAISE EXCEPTION 'Datum und Einstempelzeit sind Pflicht.'; END IF;
  IF p_out IS NOT NULL AND p_out = p_in THEN RAISE EXCEPTION 'Ein- und Ausstempelzeit dürfen nicht gleich sein.'; END IF;
  IF p_breaks IS NOT NULL AND jsonb_typeof(p_breaks) <> 'array' THEN RAISE EXCEPTION 'Ungültige Pausen.'; END IF;
  IF v_lump < 0 THEN RAISE EXCEPTION 'Ungültige Pausenminuten.'; END IF;
  v_in  := _shift_ts(p_date, p_in, p_in);
  v_out := CASE WHEN p_out IS NULL THEN NULL ELSE _shift_ts(p_date, p_in, p_out) END;
  IF v_out IS NULL AND v_in > clock_timestamp() THEN
    RAISE EXCEPTION 'Eine laufende Schicht kann nicht in der Zukunft beginnen.' USING HINT = 'entry_future';
  END IF;
  -- Zeitkorrektur = Vergangenheit: weder Beginn noch Ende in der Zukunft (1 Min. Toleranz für Uhren/Eingabe).
  -- Laufende/kommende Arbeit gehört ins Stempeln (selbst oder Live-Steuerung), Geplantes in den Schichtplan.
  IF v_in > clock_timestamp() + interval '1 minute' OR v_out > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'Beginn oder Ende liegt in der Zukunft (% – %). Die Zeitkorrektur ist nur für vergangene Zeiten – laufende Arbeit bitte stempeln.',
      to_char(v_in AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI'), COALESCE(to_char(v_out AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI'), 'offen')
      USING HINT = 'entry_future';
  END IF;
  PERFORM set_config('cafe.time_correction', 'on', true);

  IF v_id IS NULL THEN
    IF p_employee_id IS NULL OR NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id) THEN
      RAISE EXCEPTION 'Mitarbeiter nicht gefunden.';
    END IF;
    v_emp := p_employee_id;
    IF _payroll_month_locked(v_emp, p_date) THEN
      RAISE EXCEPTION 'Der Lohnmonat % ist für diese Person abgeschlossen. Bitte zuerst in der Lohnabrechnung den Monat wieder öffnen.',
        to_char(p_date, 'MM/YYYY') USING HINT = 'payroll_locked';
    END IF;
    SELECT clock_in, clock_out INTO v_other FROM time_entries
     WHERE employee_id = v_emp AND tstzrange(clock_in, COALESCE(clock_out, 'infinity')) && tstzrange(v_in, COALESCE(v_out, 'infinity'))
     ORDER BY clock_in LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Die Zeiten überschneiden sich mit einem anderen Eintrag dieser Person (% – %). Bitte diesen zuerst anpassen oder löschen.',
        to_char(v_other.clock_in AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI'), COALESCE(to_char(v_other.clock_out AT TIME ZONE 'Europe/Berlin', 'HH24:MI'), 'offen')
        USING HINT = 'entry_overlap';
    END IF;
    -- Neue Einträge: Pausen nur als Intervalle (keine pauschalen Minuten)
    IF v_lump > 0 THEN
      RAISE EXCEPTION 'Pausen bitte mit Beginn und Ende erfassen. Pauschale Pausenminuten gibt es nur noch für unveränderten Altbestand.' USING HINT = 'lump_break_not_allowed';
    END IF;
    -- direkt mit Zielzeiten (kein Zwischenstand „offen“ – sonst Konflikt mit einer laufenden Schicht der Person)
    INSERT INTO time_entries (employee_id, date, clock_in, clock_out, break_minutes, notes, approved)
    VALUES (v_emp, p_date, v_in, v_out, 0, trim('[ADMIN-KORREKTUR] ' || COALESCE(p_notes, '')), true)
    RETURNING id INTO v_id;
    v_old := NULL;
  ELSE
    SELECT employee_id, date INTO v_emp, v_old_date FROM time_entries WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Der Zeiteintrag existiert nicht mehr. Bitte die Ansicht aktualisieren.'; END IF;
    IF p_employee_id IS NOT NULL AND p_employee_id IS DISTINCT FROM v_emp THEN
      RAISE EXCEPTION 'Der Mitarbeiter eines bestehenden Zeiteintrags kann nicht geändert werden. Bitte den Eintrag löschen und für die richtige Person neu anlegen.' USING HINT = 'employee_locked';
    END IF;
    IF p_expected IS NULL OR _time_entry_state(v_id) IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'Der Zeiteintrag wurde inzwischen geändert (z. B. ausgestempelt oder Pause). Bitte die Ansicht aktualisieren und erneut korrigieren.';
    END IF;
    IF _payroll_month_locked(v_emp, v_old_date) OR _payroll_month_locked(v_emp, p_date) THEN
      RAISE EXCEPTION 'Der Lohnmonat % ist für diese Person abgeschlossen. Bitte zuerst in der Lohnabrechnung den Monat wieder öffnen.',
        to_char(CASE WHEN _payroll_month_locked(v_emp, v_old_date) THEN v_old_date ELSE p_date END, 'MM/YYYY') USING HINT = 'payroll_locked';
    END IF;
    SELECT clock_in, clock_out INTO v_other FROM time_entries
     WHERE employee_id = v_emp AND id <> v_id
       AND tstzrange(clock_in, COALESCE(clock_out, 'infinity')) && tstzrange(v_in, COALESCE(v_out, 'infinity'))
     ORDER BY clock_in LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Die Zeiten überschneiden sich mit einem anderen Eintrag dieser Person (% – %). Bitte diesen zuerst anpassen oder löschen.',
        to_char(v_other.clock_in AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI'), COALESCE(to_char(v_other.clock_out AT TIME ZONE 'Europe/Berlin', 'HH24:MI'), 'offen')
        USING HINT = 'entry_overlap';
    END IF;
    -- Altbestand = pauschale Minuten ohne Pausenzeilen: darf unverändert bleiben (oder entfernt werden)
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM time_entry_breaks WHERE time_entry_id = v_id) THEN COALESCE(break_minutes, 0) END
      INTO v_legacy FROM time_entries WHERE id = v_id;
    IF v_lump > 0 AND (COALESCE(jsonb_array_length(p_breaks), 0) > 0 OR v_legacy IS NULL OR v_lump <> v_legacy) THEN
      RAISE EXCEPTION 'Pausen bitte mit Beginn und Ende erfassen. Pauschale Pausenminuten gibt es nur noch für unveränderten Altbestand.' USING HINT = 'lump_break_not_allowed';
    END IF;
    v_old := _time_entry_label(v_id);
    DELETE FROM time_entry_breaks WHERE time_entry_id = v_id;
    -- Zielzeiten direkt setzen (Pausen danach dagegen prüfen); kein Zwischenstand „offen“.
    -- Pausen/Stunden bis zur Neuberechnung unten neutral (alte Werte könnten länger als die neue Schicht sein)
    UPDATE time_entries SET date = p_date, clock_in = v_in, clock_out = v_out, break_minutes = 0, hours_worked = NULL,
           notes = trim('[ADMIN-KORREKTUR] ' || COALESCE(p_notes, '')), approved = true
     WHERE id = v_id;
  END IF;

  FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_breaks, '[]'::jsonb)) LOOP
    v_n := v_n + 1;
    IF NULLIF(b->>'start', '') IS NULL THEN RAISE EXCEPTION 'Pause %: Bitte einen Beginn angeben.', v_n USING HINT = 'break_missing'; END IF;
    v_bs := _shift_ts(p_date, p_in, (b->>'start')::time);
    v_be := CASE WHEN NULLIF(b->>'end', '') IS NULL THEN NULL ELSE _shift_ts(p_date, p_in, (b->>'end')::time) END;
    IF v_out IS NOT NULL AND v_be IS NULL THEN
      RAISE EXCEPTION 'Pause %: Bitte ein Ende angeben (die Schicht ist beendet).', v_n USING HINT = 'break_missing';
    END IF;
    -- Uhrzeiten vor der Einstempelzeit gehören zum Folgetag → eine Pause „vor Arbeitsbeginn“ landet hinter dem Ende
    IF (v_out IS NOT NULL AND (v_be > v_out OR v_bs >= v_out))
       OR (v_out IS NULL AND (v_bs > clock_timestamp() OR v_be > clock_timestamp())) THEN
      RAISE EXCEPTION 'Pause % (%–%) liegt außerhalb der Arbeitszeit (% – %). Bitte diese Pause zuerst anpassen oder löschen – Pausen werden nicht automatisch verschoben.',
        v_n, b->>'start', COALESCE(NULLIF(b->>'end', ''), 'offen'), to_char(p_in, 'HH24:MI'), COALESCE(to_char(p_out, 'HH24:MI'), 'jetzt')
        USING HINT = 'break_outside';
    END IF;
    IF v_be IS NOT NULL AND v_be <= v_bs THEN
      RAISE EXCEPTION 'Pause % (%–%): Das Ende muss nach dem Beginn liegen.', v_n, b->>'start', b->>'end' USING HINT = 'break_order';
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
      v_break_min := v_lump;   -- nur Altbestand (oben geprüft) oder 0
    END IF;
    IF v_break_min > ROUND(EXTRACT(EPOCH FROM (v_out - v_in)) / 60.0) THEN
      RAISE EXCEPTION 'Die Pausen (% Min.) sind länger als die Arbeitszeit.', v_break_min USING HINT = 'break_exceeds_shift';
    END IF;
    v_hours := ROUND(GREATEST(0, EXTRACT(EPOCH FROM (v_out - v_in)) / 3600.0 - v_break_min / 60.0)::numeric, 2);
    UPDATE time_entries SET clock_out = v_out, break_minutes = v_break_min, hours_worked = v_hours WHERE id = v_id;
  ELSE
    UPDATE time_entries SET break_minutes = 0, hours_worked = NULL WHERE id = v_id;
  END IF;

  v_new := _time_entry_label(v_id);
  INSERT INTO time_corrections (time_entry_id, employee_id, corrected_by, field_changed, old_value, new_value, reason)
  VALUES (v_id, v_emp, auth.uid(), CASE WHEN p_id IS NULL THEN 'new_entry' ELSE 'manual_edit' END, v_old, v_new, trim(p_reason));
  PERFORM set_config('cafe.time_correction', '', true);
  RETURN jsonb_build_object('success', true, 'id', v_id, 'hours_worked', v_hours, 'break_minutes', v_break_min,
                            'clock_in', v_in, 'clock_out', v_out, 'state', _time_entry_state(v_id));
END $$;
REVOKE ALL ON FUNCTION public.admin_save_time_entry(uuid, uuid, date, time, time, jsonb, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_time_entry(uuid, uuid, date, time, time, jsonb, integer, text, text, jsonb) TO authenticated;

-- ── Konsistenz am Transaktionsende (Stand 34) + keine Überschneidung von Einträgen derselben Person ──────
CREATE OR REPLACE FUNCTION public.time_entry_consistency_check()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; e record; v_bad record; v_cnt int; v_sec numeric; v_other record;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;   -- Systemkontext wie bei allen Guards
  IF TG_TABLE_NAME = 'time_entries' THEN v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_id := OLD.time_entry_id;
  ELSE v_id := NEW.time_entry_id; END IF;
  SELECT * INTO e FROM time_entries WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;            -- Eintrag gelöscht (Pausen per CASCADE)
  IF TG_TABLE_NAME = 'time_entries' THEN
    SELECT clock_in, clock_out INTO v_other FROM time_entries o
     WHERE o.employee_id = e.employee_id AND o.id <> e.id
       AND tstzrange(o.clock_in, COALESCE(o.clock_out, 'infinity')) && tstzrange(e.clock_in, COALESCE(e.clock_out, 'infinity'))
     ORDER BY o.clock_in LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Der Zeiteintrag überschneidet sich mit einem anderen Eintrag derselben Person (% – %).',
        to_char(v_other.clock_in AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI'), COALESCE(to_char(v_other.clock_out AT TIME ZONE 'Europe/Berlin', 'HH24:MI'), 'offen')
        USING ERRCODE = '23514', HINT = 'entry_overlap';
    END IF;
  END IF;
  SELECT b.break_start, b.break_end INTO v_bad FROM time_entry_breaks b
   WHERE b.time_entry_id = v_id
     AND (b.break_start < e.clock_in OR (e.clock_out IS NOT NULL AND (b.break_end IS NULL OR b.break_end > e.clock_out)))
   ORDER BY b.break_start LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Die Pause % – % liegt außerhalb der Arbeitszeit. Bitte diese Pause zuerst anpassen oder löschen.',
      to_char(v_bad.break_start AT TIME ZONE 'Europe/Berlin', 'DD.MM. HH24:MI'),
      COALESCE(to_char(v_bad.break_end AT TIME ZONE 'Europe/Berlin', 'HH24:MI'), 'offen')
      USING ERRCODE = '23514', HINT = 'break_outside';
  END IF;
  IF EXISTS (SELECT 1 FROM time_entry_breaks b1 JOIN time_entry_breaks b2
               ON b1.time_entry_id = b2.time_entry_id AND b1.id < b2.id
              AND tstzrange(b1.break_start, COALESCE(b1.break_end, 'infinity')) && tstzrange(b2.break_start, COALESCE(b2.break_end, 'infinity'))
             WHERE b1.time_entry_id = v_id) THEN
    RAISE EXCEPTION 'Pausen dürfen sich nicht überschneiden.' USING ERRCODE = '23514', HINT = 'break_overlap';
  END IF;
  -- Beendete Schicht (nicht als „Ausstempeln vergessen“ mit 0 Std. markiert): Werte = Rechnung aus den Zeiten
  IF e.clock_out IS NOT NULL AND COALESCE(e.notes, '') NOT LIKE '%AUSSTEMPELN VERGESSEN%' THEN
    SELECT count(*), COALESCE(sum(EXTRACT(EPOCH FROM (break_end - break_start))), 0) INTO v_cnt, v_sec
      FROM time_entry_breaks WHERE time_entry_id = v_id;
    -- Pausenzeilen gelöscht, Minuten stehen geblieben: das ist kein Altbestand (der hatte nie Zeilen) → muss 0 sein
    IF (v_cnt > 0 OR (TG_TABLE_NAME = 'time_entry_breaks' AND TG_OP = 'DELETE'))
       AND e.break_minutes IS DISTINCT FROM GREATEST(0, ROUND(v_sec / 60.0))::int THEN
      RAISE EXCEPTION 'Die Pausenminuten stimmen nicht mit den erfassten Pausen überein.' USING ERRCODE = '23514', HINT = 'break_sum_mismatch';
    END IF;
    IF e.hours_worked IS DISTINCT FROM ROUND(GREATEST(0, EXTRACT(EPOCH FROM (e.clock_out - e.clock_in)) / 3600.0 - COALESCE(e.break_minutes, 0) / 60.0)::numeric, 2) THEN
      RAISE EXCEPTION 'Die Nettoarbeitszeit stimmt nicht mit Arbeitszeit und Pausen überein.' USING ERRCODE = '23514', HINT = 'net_mismatch';
    END IF;
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.time_entry_consistency_check() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
