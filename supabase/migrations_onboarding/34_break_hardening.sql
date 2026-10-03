-- ============================================================
-- 34 · Pausen + Zeitkorrektur serverseitig härten (Audit C1–C7)
-- (Rechte, Prüfungen, Funktionen – KEINE Datenänderung, kein Backfill, keine Neuberechnung bestehender Einträge)
--
-- Source of Truth der Nettozeit bleibt time_entries.hours_worked (alle Ansichten, Lohn, DATEV, PDF lesen nur diesen
-- Wert). Er entsteht ausschließlich serverseitig: beim Ausstempeln (Trigger) oder in admin_save_time_entry.
-- Neu ist, dass KEIN anderer Weg ihn – oder die Pausen, aus denen er entsteht – mehr ändern kann:
--
-- C1 Direkte Tabellenwege geschlossen:
--    • time_entry_breaks: keine Schreibrechte/-Policy mehr für App-Rollen. Pausen entstehen nur über start_break /
--      end_break (Mitarbeiter, Serverzeit), das Ausstempeln und admin_save_time_entry (Admin, mit Protokoll).
--    • time_entries: Admin-Sonderpolicy „time_admin“ (ALL) entfällt. Jede Person – auch Admins – stempelt nur sich
--      selbst ein/aus (bestehende Policies time_insert / time_update_own_open). Löschen nur über
--      admin_delete_time_entry (Protokoll); Aufbewahrungs-Löschung und CASCADE laufen als Funktionsbesitzer weiter.
--    • time_corrections: Protokoll nur noch aus den Funktionen (keine direkten Einträge mehr).
--    • Trigger behandeln Admins außerhalb der Zeitkorrektur wie alle anderen (Serverzeit, ein offener Eintrag,
--      Standort-/Remote-Regel, Pausen, > 12 h-Regel). Nur admin_save_time_entry setzt das transaktionslokale Flag
--      cafe.time_correction (und nur zusammen mit is_admin() wirksam).
-- C2 Laufende Schicht: Pausen und Arbeitsbeginn dürfen nicht in der Zukunft liegen (sonst konnte die Person nicht
--    mehr ausstempeln). Prüfung in der Zeitkorrektur UND im Pausen-Guard.
-- C3 Abgeschlossener Lohnmonat (payroll_months.is_finalized der Person): Zeitkorrektur und Löschen werden abgelehnt,
--    für das alte UND das neue Datum. Wieder möglich nach „Monat wieder öffnen“ in der Lohnabrechnung (bestehendes
--    Modell). Das normale Ausstempeln einer noch laufenden Schicht bleibt immer möglich (Arbeitszeit nie verlieren).
-- C4 Neue Korrekturen nur mit echten Pausenintervallen. Pauschale break_minutes ohne Pausenzeilen bleiben nur für
--    unveränderten Altbestand gültig (gleicher Wert oder 0 = entfernen). break_minutes ≤ Schichtdauer und
--    hours_worked ≤ Schichtdauer als CHECK (Minuten bzw. Stunden, gleich gerundet wie die Berechnung).
-- C5 Admin-Ausstempeln = derselbe Serverweg wie bei allen (Serverzeit, laufende Pause endet, > 12 h-Regel).
-- C6 Mitarbeiter eines bestehenden Zeiteintrags ist in der Korrektur nicht änderbar (Ablehnung statt Ignorieren).
-- C7 Ausstempeln und Pausen nutzen clock_timestamp() (Zeit NACH der Zeilensperre) – kein Fehler mehr, wenn
--    „Pause starten“ und „Ausstempeln“ gleichzeitig ankommen.
-- Zusätzlich: verzögerte Konsistenzprüfung am Transaktionsende (Pausen in der Schicht, keine Überschneidung,
-- break_minutes = Summe der Pausenzeilen, hours_worked = Dauer − break_minutes). Sie prüft nur geänderte Einträge;
-- Altbestand wird nie neu bewertet. Systemkontext (auth.uid() NULL: Wartung, Aufbewahrung) wie bei allen Guards frei.
--
-- Bestehende Daten: vor dem Einspielen read-only geprüft – 0 Verstöße gegen die neuen CHECKs.
-- Rückweg: Policies time_admin / breaks_admin / corr_insert und Grants wiederherstellen, Funktionen aus 17/27/29
-- erneut einspielen, CHECKs und Konsistenz-Trigger löschen. Daten sind davon nicht betroffen.
-- Wiederholt ausführbar.
-- Bereits live eingespielt (Migration break_hardening, Version 20261003080051, 2026-10-03; 43 Objekte inkl. aller
-- pg_get_functiondef identisch mit dieser Datei) — NICHT erneut ausführen.
-- ============================================================

-- ── Rechte: keine direkten Schreibwege an den Prüfungen vorbei ─────────────────────────────────────────────
DROP POLICY IF EXISTS breaks_admin ON public.time_entry_breaks;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.time_entry_breaks FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS time_admin ON public.time_entries;
REVOKE DELETE, TRUNCATE ON public.time_entries FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE ON public.time_entries FROM anon;
DROP POLICY IF EXISTS corr_insert ON public.time_corrections;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.time_corrections FROM PUBLIC, anon, authenticated;

-- ── Grenzen als CHECK (gleiche Rundung wie die Berechnung → von berechneten Werten immer erfüllbar) ─────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_break_within_shift') THEN
    ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_break_within_shift
      CHECK (clock_out IS NULL OR break_minutes IS NULL OR break_minutes <= ROUND(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 60.0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_hours_within_shift') THEN
    ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_hours_within_shift
      CHECK (clock_out IS NULL OR hours_worked IS NULL OR hours_worked <= ROUND(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600.0, 2));
  END IF;
END $$;

-- ── Abgeschlossener Lohnmonat der Person ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._payroll_month_locked(p_emp uuid, p_date date) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT p_date IS NOT NULL AND EXISTS (SELECT 1 FROM payroll_months
        WHERE employee_id = p_emp AND year = EXTRACT(YEAR FROM p_date)::int AND month = EXTRACT(MONTH FROM p_date)::int
          AND is_finalized) $$;
REVOKE ALL ON FUNCTION public._payroll_month_locked(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── Pausen-Guard: innerhalb der Schicht, keine Überschneidung, laufende Schicht nicht in der Zukunft ──────
CREATE OR REPLACE FUNCTION public.time_entry_breaks_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE e record;
BEGIN
  SELECT employee_id, clock_in, clock_out INTO e FROM time_entries WHERE id = NEW.time_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Zeiteintrag für die Pause nicht gefunden.'; END IF;
  NEW.employee_id := e.employee_id;
  IF NEW.break_end IS NOT NULL AND NEW.break_end <= NEW.break_start THEN
    RAISE EXCEPTION 'Das Pausenende muss nach dem Pausenbeginn liegen.' USING HINT = 'break_order';
  END IF;
  IF NEW.break_start < e.clock_in THEN
    RAISE EXCEPTION 'Die Pause kann nicht vor dem Einclocken beginnen.' USING HINT = 'break_outside';
  END IF;
  IF e.clock_out IS NOT NULL AND (NEW.break_end IS NULL OR NEW.break_end > e.clock_out) THEN
    RAISE EXCEPTION 'Die Pause muss vor dem Ausclocken enden.' USING HINT = 'break_outside';
  END IF;
  IF e.clock_out IS NULL AND (NEW.break_start > clock_timestamp() OR NEW.break_end > clock_timestamp()) THEN
    RAISE EXCEPTION 'Eine Pause der laufenden Schicht kann nicht in der Zukunft liegen.' USING HINT = 'break_future';
  END IF;
  IF EXISTS (SELECT 1 FROM time_entry_breaks b
             WHERE b.time_entry_id = NEW.time_entry_id AND b.id <> NEW.id
               AND tstzrange(b.break_start, COALESCE(b.break_end, 'infinity'))
                && tstzrange(NEW.break_start, COALESCE(NEW.break_end, 'infinity'))) THEN
    RAISE EXCEPTION 'Pausen dürfen sich nicht überschneiden.' USING HINT = 'break_overlap';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.time_entry_breaks_guard() FROM PUBLIC, anon, authenticated;

-- ── Pause starten / beenden: Zeit nach der Sperre; beide sperren zuerst den Zeiteintrag (gleiche Reihenfolge
--    wie das Ausstempeln → keine Verklemmung, Doppeltipp serialisiert) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.start_break()
 RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
  VALUES (v_entry, v_emp, clock_timestamp()) RETURNING * INTO r;
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.end_break()
 RETURNS public.time_entry_breaks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid := my_employee_id(); v_entry uuid; r time_entry_breaks;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Dein Mitarbeiterkonto ist nicht aktiv.'; END IF;
  SELECT id INTO v_entry FROM time_entries
   WHERE employee_id = v_emp AND clock_out IS NULL
   ORDER BY clock_in DESC LIMIT 1 FOR UPDATE;
  IF v_entry IS NOT NULL THEN
    UPDATE time_entry_breaks SET break_end = clock_timestamp(), closed_by = 'employee'
     WHERE time_entry_id = v_entry AND break_end IS NULL
     RETURNING * INTO r;
  END IF;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Es läuft keine Pause.'; END IF;
  RETURN r;
END $function$;
REVOKE ALL ON FUNCTION public.start_break() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_break()   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_break() TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_break()   TO authenticated;

-- ── Einstempeln: Admins wie alle (nur sich selbst, Serverzeit); Ausnahme nur die Admin-Zeitkorrektur ───────
CREATE OR REPLACE FUNCTION public.time_entry_guard_insert()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE loc jsonb; v_remote boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('cafe.time_correction', true), '') = 'on' AND is_admin() THEN RETURN NEW; END IF;
  -- (Mitarbeiter/Manager: RLS lehnt Fremdes ohnehin ab; Admins haben keine Sonderpolicy mehr – klare Meldung)
  IF is_admin() AND NEW.employee_id IS DISTINCT FROM my_employee_id() THEN
    RAISE EXCEPTION 'Zeiteinträge für andere Personen bitte über die Zeitkorrektur anlegen.' USING HINT = 'use_time_correction';
  END IF;
  IF EXISTS (SELECT 1 FROM time_entries WHERE employee_id = NEW.employee_id AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'Du bist bereits eingeclockt.';
  END IF;
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
  NEW.clock_in        := now();
  NEW.date            := (now() AT TIME ZONE 'Europe/Berlin')::date;
  NEW.clock_out       := NULL;
  NEW.hours_worked    := NULL;
  NEW.break_minutes   := 0;
  NEW.is_overtime     := false;
  NEW.overtime_hours  := 0;
  NEW.approved        := false;
  NEW.gps_ok_in       := (loc->>'gps_ok')::boolean;
  NEW.clock_in_method := CASE WHEN v_remote THEN 'remote' ELSE _clock_method(loc) END;
  IF v_remote THEN NEW.gps_lat_in := NULL; NEW.gps_lng_in := NULL; END IF;
  NEW.gps_lat_out := NULL; NEW.gps_lng_out := NULL; NEW.gps_ok_out := false; NEW.clock_out_method := NULL;
  RETURN NEW;
END $function$;

-- ── Ausstempeln: ein Weg für alle (auch Admins), Serverzeit nach der Zeilensperre ─────────────────────────
CREATE OR REPLACE FUNCTION public.prevent_time_entry_backdating()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_total numeric; v_break int; v_sum int; loc jsonb; v_remote boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Admin-Zeitkorrektur: admin_save_time_entry prüft und rechnet selbst (Flag nur dort gesetzt)
  IF COALESCE(current_setting('cafe.time_correction', true), '') = 'on' AND is_admin() THEN RETURN NEW; END IF;
  IF is_admin() AND OLD.employee_id IS DISTINCT FROM my_employee_id() THEN
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

-- ── Admin-Zeitkorrektur (Stand 27) + Sperren/Regeln aus C2, C3, C4, C6 ────────────────────────────────────
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
  v_old_date date; v_legacy int; v_lump int := COALESCE(p_break_minutes, 0);
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

CREATE OR REPLACE FUNCTION public.admin_delete_time_entry(p_id uuid, p_reason text, p_expected jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_emp uuid; v_old text; v_date date;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Bitte einen Grund für das Löschen angeben.'; END IF;
  SELECT employee_id, date INTO v_emp, v_date FROM time_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', true, 'already', true); END IF;
  IF p_expected IS NULL OR _time_entry_state(p_id) IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'Der Zeiteintrag wurde inzwischen geändert. Bitte die Ansicht aktualisieren und erneut prüfen.';
  END IF;
  IF _payroll_month_locked(v_emp, v_date) THEN
    RAISE EXCEPTION 'Der Lohnmonat % ist für diese Person abgeschlossen. Bitte zuerst in der Lohnabrechnung den Monat wieder öffnen.',
      to_char(v_date, 'MM/YYYY') USING HINT = 'payroll_locked';
  END IF;
  v_old := _time_entry_label(p_id);
  INSERT INTO time_corrections (time_entry_id, employee_id, corrected_by, field_changed, old_value, new_value, reason)
  VALUES (p_id, v_emp, auth.uid(), 'deleted', v_old, NULL, trim(p_reason));
  DELETE FROM time_entries WHERE id = p_id;   -- Pausen per CASCADE; Protokoll bleibt (Verweis → NULL)
  RETURN jsonb_build_object('success', true, 'already', false);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_time_entry(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_time_entry(uuid, text, jsonb) TO authenticated;

-- ── Konsistenz am Transaktionsende: Netto = Dauer − erfasste Pausen (nur geänderte Einträge) ───────────────
CREATE OR REPLACE FUNCTION public.time_entry_consistency_check()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; e record; v_bad record; v_cnt int; v_sec numeric;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;   -- Systemkontext wie bei allen Guards
  IF TG_TABLE_NAME = 'time_entries' THEN v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_id := OLD.time_entry_id;
  ELSE v_id := NEW.time_entry_id; END IF;
  SELECT * INTO e FROM time_entries WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;            -- Eintrag gelöscht (Pausen per CASCADE)
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
DROP TRIGGER IF EXISTS trg_time_entry_consistency ON public.time_entries;
CREATE CONSTRAINT TRIGGER trg_time_entry_consistency AFTER INSERT OR UPDATE ON public.time_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.time_entry_consistency_check();
DROP TRIGGER IF EXISTS trg_time_entry_breaks_consistency ON public.time_entry_breaks;
CREATE CONSTRAINT TRIGGER trg_time_entry_breaks_consistency AFTER INSERT OR UPDATE OR DELETE ON public.time_entry_breaks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.time_entry_consistency_check();

NOTIFY pgrst, 'reload schema';
