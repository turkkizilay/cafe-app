-- ============================================================
-- 29 · Ein-/Ausstempeln außerhalb des Cafés – nur Manager/Admin, nur nach ausdrücklicher Bestätigung
-- (additiv, keine Datenänderung)
-- Bereits live eingespielt (Migration remote_clock, Version 20261001112645, 2026-10-01) — NICHT erneut ausführen.
--
-- Bisher: Die Standortprüfung (GPS im Radius ODER Café-WLAN) erzwingen die Trigger time_entry_guard_insert
-- (Einstempeln) und prevent_time_entry_backdating (Ausstempeln) für alle Nicht-Admins. Admins umgehen beide
-- Trigger vollständig (für Admin-Korrekturen); die App sperrte den Button trotzdem auch für sie.
--
-- Neu:
-- • clock_in_remote(lat, lng, confirmed) / clock_out_remote(lat, lng, confirmed): stempeln IMMER die aufrufende
--   Person selbst (keine Mitarbeiter-ID als Parameter). Rolle live aus profiles über is_manager_or_admin()
--   (bestehende Rollenlogik) – Mitarbeiter werden abgelehnt, auch per direktem API-/RPC-Aufruf. Aktiv-Prüfung wie
--   beim normalen Stempeln (my_is_active_employee()).
-- • Außerhalb wird NUR gestempelt, wenn (a) der Standort tatsächlich bestimmt wurde (GPS-Modus: gültige Koordinaten
--   außerhalb des Radius; reiner WLAN-Modus: Client-IP bekannt und nicht im Café-Netz) und (b) confirmed = true.
--   Standort unbekannt (GPS verweigert/nicht verfügbar) → Ablehnung mit Hinweis, kein stilles Remote-Stempeln.
-- • Ist der Standort doch im Café (z. B. WLAN inzwischen verbunden), wird normal gestempelt – ohne Remote-Markierung
--   und ohne Protokolleintrag.
-- • Die Trigger lassen die Standortprüfung nur aus, wenn diese Funktionen das transaktionslokale Flag
--   cafe.remote_clock gesetzt haben UND die Person Manager/Admin ist. Alle übrigen Regeln bleiben aktiv
--   (Serverzeit, ein offener Eintrag – Unique-Index aus Migration 21 unverändert –, Pausen, > 12 h-Regel).
-- • Nachweis: Eintrag erhält clock_in_method/clock_out_method = 'remote' (dauerhaft am Eintrag, für die
--   Mitarbeiterin selbst nicht änderbar) und einen Protokolleintrag (activity_log, Kategorie time) in DERSELBEN
--   Transaktion – kein Eintrag ohne Protokoll. Gespeichert werden Person, Rolle, Zeitpunkt, Prüfart (gps/network).
--   KEINE Koordinaten: bei Remote-Stempeln werden gps_lat/gps_lng NULL gesetzt (der Standort außerhalb ist für den
--   Zweck nicht nötig).
-- Deploy-Reihenfolge: zuerst diese Migration, dann das Frontend (alter Client ruft die neuen Funktionen nie auf;
-- neuer Client ohne Migration bekäme „Funktion nicht gefunden“ → keine Stempelung, klare Fehlermeldung).
-- ============================================================

-- ── Einstempeln: Trigger wie Production, plus bestätigte Ausnahme für Manager/Admin ──────────────────────
CREATE OR REPLACE FUNCTION public.time_entry_guard_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE loc jsonb; v_remote boolean := false;
BEGIN
  IF auth.uid() IS NULL OR is_admin() THEN RETURN NEW; END IF;
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

-- ── Ausstempeln: Trigger wie Production (Migration 17), plus bestätigte Ausnahme für Manager/Admin ────────
CREATE OR REPLACE FUNCTION public.prevent_time_entry_backdating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total numeric; v_break int; v_sum int; loc jsonb; v_remote boolean := false;
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

REVOKE ALL ON FUNCTION public.time_entry_guard_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_time_entry_backdating() FROM PUBLIC, anon, authenticated;

-- ── Gemeinsame Prüfung: Rolle, aktives Konto, Standort bestimmt?, Bestätigung ────────────────────────────
-- Liefert NULL (= im Café bzw. keine Prüfung eingerichtet → normal stempeln) oder die Prüfart ('gps'/'network')
-- eines bestätigten Stempelns außerhalb. Lehnt sonst mit HINT ab (Client entscheidet am HINT, nie am Text).
CREATE OR REPLACE FUNCTION public._remote_clock_check(p_lat numeric, p_lng numeric, p_confirmed boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE loc jsonb; v_gps_conf boolean;
BEGIN
  loc := _clock_location(p_lat, p_lng);
  IF NOT (loc->>'required')::boolean OR (loc->>'gps_ok')::boolean OR (loc->>'net_ok')::boolean THEN
    RETURN NULL;
  END IF;
  SELECT gps_lat IS NOT NULL AND gps_lng IS NOT NULL INTO v_gps_conf FROM cafe_settings WHERE id = 1;
  v_gps_conf := COALESCE(v_gps_conf, false) AND NOT (loc->>'net_only')::boolean;
  IF v_gps_conf THEN
    -- GPS-Modus: „außerhalb“ nur mit tatsächlich ermittelter Position – fehlendes GPS ist NICHT „außerhalb“
    IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
      RAISE EXCEPTION 'Dein Standort konnte nicht bestimmt werden. Bitte Standortzugriff erlauben und erneut prüfen.'
        USING HINT = 'location_unknown';
    END IF;
    IF p_confirmed IS NOT TRUE THEN
      RAISE EXCEPTION 'Bitte bestätige das Stempeln außerhalb des Cafés.' USING HINT = 'confirmation_required';
    END IF;
    RETURN 'gps';
  END IF;
  -- Nur WLAN eingerichtet: der Server sieht die Client-IP selbst; ohne IP ist der Standort unbekannt
  IF _client_ip() IS NULL THEN
    RAISE EXCEPTION 'Dein Standort konnte nicht bestimmt werden. Bitte erneut prüfen.' USING HINT = 'location_unknown';
  END IF;
  IF p_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Bitte bestätige das Stempeln außerhalb des Cafés.' USING HINT = 'confirmation_required';
  END IF;
  RETURN 'network';
END $function$;
REVOKE ALL ON FUNCTION public._remote_clock_check(numeric, numeric, boolean) FROM PUBLIC, anon, authenticated;

-- Rolle + aktives eigenes Konto; liefert die eigene Mitarbeiter-ID (nie aus dem Request)
CREATE OR REPLACE FUNCTION public._remote_clock_self()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT is_manager_or_admin() THEN
    RAISE EXCEPTION 'Stempeln außerhalb des Cafés ist nur für Manager und Admins möglich.' USING HINT = 'remote_not_allowed';
  END IF;
  v_emp := my_employee_id();
  IF v_emp IS NULL OR NOT COALESCE(my_is_active_employee(), false) THEN
    RAISE EXCEPTION 'Dein Mitarbeiterkonto ist nicht aktiv.' USING HINT = 'inactive';
  END IF;
  RETURN v_emp;
END $function$;
REVOKE ALL ON FUNCTION public._remote_clock_self() FROM PUBLIC, anon, authenticated;

-- Pflichtprotokoll (gleiche Transaktion → kein Remote-Eintrag ohne Protokoll)
CREATE OR REPLACE FUNCTION public._remote_clock_log(p_action text, p_summary text, p_entry uuid, p_emp uuid, p_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_name text;
BEGIN
  SELECT p.role, COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), ''),
                          NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), ''), p.email, 'Unbekannt')
    INTO v_role, v_name
    FROM profiles p LEFT JOIN employees e ON e.id = p_emp
   WHERE p.id = auth.uid();
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary,
                            target_type, target_id, target_name, metadata)
  VALUES (auth.uid(), v_name, v_role, p_action, 'time', v_name || ' ' || p_summary,
          'time_entry', p_entry::text, v_name,
          jsonb_build_object('employee_id', p_emp, 'role', v_role, 'location_check', p_mode, 'confirmed', true));
END $function$;
REVOKE ALL ON FUNCTION public._remote_clock_log(text, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ── Einstempeln (nur sich selbst) ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.clock_in_remote(p_lat numeric, p_lng numeric, p_confirmed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid; v_mode text; v_remote boolean; v_id uuid; v_in timestamptz; loc jsonb;
BEGIN
  v_emp := _remote_clock_self();
  -- je Person serialisieren: parallele Aufrufe (zwei Geräte/Tabs, Doppeltipp) prüfen nacheinander;
  -- der Unique-Index „ein offener Eintrag“ (Migration 21) bleibt die letzte Verteidigungslinie
  PERFORM pg_advisory_xact_lock(hashtext('cafe.clock:' || v_emp::text));
  IF EXISTS (SELECT 1 FROM time_entries WHERE employee_id = v_emp AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'Du bist bereits eingeclockt.' USING HINT = 'already_clocked_in';
  END IF;
  v_mode   := _remote_clock_check(p_lat, p_lng, p_confirmed);
  v_remote := v_mode IS NOT NULL;

  PERFORM set_config('cafe.remote_clock', CASE WHEN v_remote THEN 'on' ELSE '' END, true);
  INSERT INTO time_entries (employee_id, date, clock_in, gps_lat_in, gps_lng_in,
                            break_minutes, is_overtime, overtime_hours, approved)
  VALUES (v_emp, (now() AT TIME ZONE 'Europe/Berlin')::date, now(),
          CASE WHEN v_remote THEN NULL ELSE p_lat END, CASE WHEN v_remote THEN NULL ELSE p_lng END,
          0, false, 0, false)
  RETURNING id, clock_in INTO v_id, v_in;
  PERFORM set_config('cafe.remote_clock', '', true);

  -- Admins umgehen den Einstempel-Trigger (Korrekturen) → Nachweisfelder hier serverseitig setzen
  IF is_admin() THEN
    loc := _clock_location(CASE WHEN v_remote THEN NULL ELSE p_lat END, CASE WHEN v_remote THEN NULL ELSE p_lng END);
    UPDATE time_entries
       SET clock_in_method = CASE WHEN v_remote THEN 'remote' ELSE _clock_method(loc) END,
           gps_ok_in = COALESCE((loc->>'gps_ok')::boolean, false)
     WHERE id = v_id;
  END IF;

  IF v_remote THEN
    PERFORM _remote_clock_log('time.remote_clock_in', 'hat sich außerhalb des Cafés eingestempelt (bestätigt).', v_id, v_emp, v_mode);
  END IF;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'clock_in', v_in, 'remote', v_remote);
END $function$;
REVOKE ALL ON FUNCTION public.clock_in_remote(numeric, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_in_remote(numeric, numeric, boolean) TO authenticated;

-- ── Ausstempeln (nur sich selbst) ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.clock_out_remote(p_lat numeric, p_lng numeric, p_confirmed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid; v_mode text; v_remote boolean; v_id uuid; v_in timestamptz; v_out timestamptz;
        v_total numeric; v_sum int; v_cnt int; v_break int; v_hours numeric; v_notes text; v_old_break int; loc jsonb;
BEGIN
  v_emp := _remote_clock_self();
  PERFORM pg_advisory_xact_lock(hashtext('cafe.clock:' || v_emp::text));
  SELECT id, clock_in, break_minutes, notes INTO v_id, v_in, v_old_break, v_notes
    FROM time_entries WHERE employee_id = v_emp AND clock_out IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Du bist nicht eingeclockt.' USING HINT = 'not_clocked_in';
  END IF;
  v_mode   := _remote_clock_check(p_lat, p_lng, p_confirmed);
  v_remote := v_mode IS NOT NULL;

  PERFORM set_config('cafe.remote_clock', CASE WHEN v_remote THEN 'on' ELSE '' END, true);
  UPDATE time_entries
     SET clock_out = now(),
         gps_lat_out = CASE WHEN v_remote THEN NULL ELSE p_lat END,
         gps_lng_out = CASE WHEN v_remote THEN NULL ELSE p_lng END
   WHERE id = v_id AND clock_out IS NULL;
  PERFORM set_config('cafe.remote_clock', '', true);

  -- Admins: der Trigger übernimmt App-Werte → hier dieselbe Rechnung wie beim Mitarbeiter-Ausstempeln
  -- (Serverzeit, nur erfasste Pausen, > 12 h → 0 Std. + Markierung)
  IF is_admin() THEN
    SELECT clock_out INTO v_out FROM time_entries WHERE id = v_id;
    v_total := EXTRACT(EPOCH FROM (v_out - v_in)) / 3600.0;
    SELECT count(*), GREATEST(0, ROUND(COALESCE(sum(EXTRACT(EPOCH FROM (break_end - break_start))), 0) / 60.0))::int
      INTO v_cnt, v_sum FROM time_entry_breaks WHERE time_entry_id = v_id;
    IF v_total > 12 THEN
      v_break := 0; v_hours := 0;
      v_notes := '⚠️ AUSSTEMPELN VERGESSEN – Zeit bitte korrigieren (' || ROUND(v_total::numeric, 1) || ' Std. offen)';
    ELSE
      v_break := CASE WHEN v_cnt > 0 THEN v_sum ELSE COALESCE(v_old_break, 0) END;
      v_hours := ROUND(GREATEST(0, v_total - v_break / 60.0)::numeric, 2);
    END IF;
    loc := _clock_location(CASE WHEN v_remote THEN NULL ELSE p_lat END, CASE WHEN v_remote THEN NULL ELSE p_lng END);
    UPDATE time_entries
       SET break_minutes = v_break, hours_worked = v_hours, notes = v_notes,
           clock_out_method = CASE WHEN v_remote THEN 'remote' ELSE _clock_method(loc) END,
           gps_ok_out = COALESCE((loc->>'gps_ok')::boolean, false)
     WHERE id = v_id;
  END IF;

  IF v_remote THEN
    PERFORM _remote_clock_log('time.remote_clock_out', 'hat sich außerhalb des Cafés ausgestempelt (bestätigt).', v_id, v_emp, v_mode);
  END IF;
  SELECT clock_out, hours_worked, break_minutes, notes INTO v_out, v_hours, v_break, v_notes FROM time_entries WHERE id = v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'clock_out', v_out, 'hours_worked', v_hours,
                            'break_minutes', v_break, 'notes', v_notes, 'remote', v_remote);
END $function$;
REVOKE ALL ON FUNCTION public.clock_out_remote(numeric, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_out_remote(numeric, numeric, boolean) TO authenticated;
