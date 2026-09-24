-- ============================================================
-- 09 · Einclocken per GPS ODER Café-WLAN (serverseitig geprüft)
-- Bereits live eingespielt (Migration clockin_gps_or_network) — NICHT erneut ausführen.
--
-- Prinzip:
--  * Browser können den WLAN-Namen nicht lesen. Stattdessen wird die öffentliche
--    Internet-Adresse geprüft, unter der das Gerät beim Server ankommt.
--    Im Café-WLAN ist das die Adresse des Café-Routers.
--  * Vertrauenswürdig ist NUR der Header cf-connecting-ip (setzt Cloudflare selbst).
--    x-forwarded-for kann vom Gerät gefälscht werden (getestet) → wird ignoriert.
--  * Mitarbeiter-IP-Adressen werden NICHT gespeichert, nur „per GPS/WLAN".
--  * Admins sind wie bisher ausgenommen (manuelle Korrekturen).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cafe_networks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cidr         cidr NOT NULL UNIQUE,
  label        text NOT NULL DEFAULT 'Café-WLAN',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_seen_at timestamptz
);
ALTER TABLE public.cafe_networks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cafe_networks_admin ON public.cafe_networks;
CREATE POLICY cafe_networks_admin ON public.cafe_networks FOR ALL USING (is_admin()) WITH CHECK (is_admin());
REVOKE ALL ON public.cafe_networks FROM anon;

ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS clock_in_method  text;
ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS clock_out_method text;

-- Vertrauenswürdige Client-Adresse (nur cf-connecting-ip)
CREATE OR REPLACE FUNCTION public._client_ip()
RETURNS inet LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
DECLARE v text;
BEGIN
  v := NULLIF(TRIM((current_setting('request.headers', true))::json->>'cf-connecting-ip'), '');
  IF v IS NULL THEN RETURN NULL; END IF;
  RETURN v::inet;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

-- Entfernung in Metern (Haversine)
CREATE OR REPLACE FUNCTION public._dist_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT (2 * 6371000 * asin(sqrt(
      power(sin(radians((lat2 - lat1)::float8) / 2), 2)
    + cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lng2 - lng1)::float8) / 2), 2)
  )))::numeric
$$;

-- Standortprüfung: {required, gps_ok, net_ok, net_id}
CREATE OR REPLACE FUNCTION public._clock_location(p_lat numeric, p_lng numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s cafe_settings%ROWTYPE; v_ip inet; v_net uuid; v_gps_conf boolean; v_net_conf boolean; v_gps_ok boolean := false;
BEGIN
  SELECT * INTO s FROM cafe_settings WHERE id = 1;
  v_gps_conf := s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL;
  v_net_conf := EXISTS (SELECT 1 FROM cafe_networks);
  IF v_gps_conf AND p_lat IS NOT NULL AND p_lng IS NOT NULL
     AND p_lat BETWEEN -90 AND 90 AND p_lng BETWEEN -180 AND 180 THEN
    v_gps_ok := _dist_m(p_lat, p_lng, s.gps_lat, s.gps_lng) <= COALESCE(s.gps_radius_m, 50);
  END IF;
  v_ip := _client_ip();
  IF v_net_conf AND v_ip IS NOT NULL THEN
    SELECT id INTO v_net FROM cafe_networks WHERE cidr >>= v_ip ORDER BY masklen(cidr) DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object('required', v_gps_conf OR v_net_conf, 'gps_ok', v_gps_ok,
                            'net_ok', v_net IS NOT NULL, 'net_id', v_net);
END $$;

CREATE OR REPLACE FUNCTION public._clock_method(loc jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (loc->>'gps_ok')::boolean AND (loc->>'net_ok')::boolean THEN 'gps+wlan'
    WHEN (loc->>'gps_ok')::boolean THEN 'gps'
    WHEN (loc->>'net_ok')::boolean THEN 'wlan'
    WHEN NOT (loc->>'required')::boolean THEN 'ohne Prüfung'
    ELSE NULL END
$$;

-- ── Einclocken ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.time_entry_guard_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
END $function$;

-- ── Ausclocken / Änderungen durch Mitarbeiter ─────────────────
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
      v_break := CASE WHEN v_total > 9 THEN 45 WHEN v_total > 6 THEN 30 ELSE 0 END;
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

-- ── Für die Einclock-Seite: ist dieses Gerät im Café-WLAN? (verrät keine Adresse)
CREATE OR REPLACE FUNCTION public.clock_network_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE loc jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT is_approved() THEN
    RETURN jsonb_build_object('configured', false, 'net_ok', false);
  END IF;
  loc := _clock_location(NULL, NULL);
  RETURN jsonb_build_object('configured', EXISTS (SELECT 1 FROM cafe_networks), 'net_ok', (loc->>'net_ok')::boolean);
END $$;

-- ── Admin: Übersicht, hinzufügen, entfernen ──────────────────
CREATE OR REPLACE FUNCTION public.cafe_network_info()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ip inet;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  v_ip := _client_ip();
  RETURN jsonb_build_object(
    'success', true,
    'current_ip', host(v_ip),
    'is_ipv6', family(v_ip) = 6,
    'matched', EXISTS (SELECT 1 FROM cafe_networks WHERE v_ip IS NOT NULL AND cidr >>= v_ip),
    'networks', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'label', label, 'cidr', cidr::text,
                           'created_at', created_at, 'last_seen_at', last_seen_at) ORDER BY created_at)
                          FROM cafe_networks), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.cafe_network_add(p_label text, p_lat numeric, p_lng numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ip inet; v_cidr cidr; loc jsonb; s cafe_settings%ROWTYPE; v_label text;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  v_ip := _client_ip();
  IF v_ip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Deine Verbindung konnte nicht erkannt werden. Bitte später erneut versuchen.');
  END IF;
  -- Nur möglich, wenn man nachweislich im Café ist (GPS), damit nicht aus Versehen
  -- das Heim-WLAN oder mobile Daten freigeschaltet werden.
  SELECT * INTO s FROM cafe_settings WHERE id = 1;
  IF s.gps_lat IS NOT NULL THEN
    loc := _clock_location(p_lat, p_lng);
    IF NOT (loc->>'gps_ok')::boolean THEN
      RETURN jsonb_build_object('success', false, 'error', 'Du musst dafür im Café sein und GPS erlauben.');
    END IF;
  END IF;
  -- Private / Sonder-Adressbereiche nie freischalten
  IF v_ip << '10.0.0.0/8' OR v_ip << '172.16.0.0/12' OR v_ip << '192.168.0.0/16'
     OR v_ip << '100.64.0.0/10' OR v_ip << '127.0.0.0/8' OR v_ip << 'fc00::/7' OR v_ip << 'fe80::/10' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Diese Verbindung kann nicht als Café-WLAN gespeichert werden.');
  END IF;
  v_cidr := CASE WHEN family(v_ip) = 6 THEN set_masklen(v_ip, 64)::cidr ELSE set_masklen(v_ip, 32)::cidr END;
  IF EXISTS (SELECT 1 FROM cafe_networks WHERE cidr >>= v_ip) THEN
    UPDATE cafe_networks SET last_seen_at = now() WHERE cidr >>= v_ip;
    RETURN jsonb_build_object('success', true, 'already', true);
  END IF;
  IF (SELECT count(*) FROM cafe_networks) >= 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Es sind schon 10 Einträge gespeichert. Bitte alte Einträge zuerst entfernen.');
  END IF;
  v_label := LEFT(COALESCE(NULLIF(TRIM(p_label), ''), 'Café-WLAN'), 60);
  INSERT INTO cafe_networks (cidr, label, created_by, last_seen_at) VALUES (v_cidr, v_label, auth.uid(), now());
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_name)
  SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role, 'settings.network_added', 'settings',
         COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email) || ' hat ein Café-WLAN fürs Einclocken gespeichert (' || v_label || ').',
         'cafe_network', v_label
  FROM profiles WHERE id = auth.uid();
  RETURN jsonb_build_object('success', true, 'already', false);
END $$;

CREATE OR REPLACE FUNCTION public.cafe_network_remove(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_label text;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  DELETE FROM cafe_networks WHERE id = p_id RETURNING label INTO v_label;
  IF v_label IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Eintrag nicht gefunden.'); END IF;
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_name)
  SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role, 'settings.network_removed', 'settings',
         COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email) || ' hat ein Café-WLAN entfernt (' || v_label || ').',
         'cafe_network', v_label
  FROM profiles WHERE id = auth.uid();
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public._client_ip(), public._clock_location(numeric, numeric), public._dist_m(numeric,numeric,numeric,numeric),
  public._clock_method(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clock_network_status(), public.cafe_network_info(), public.cafe_network_add(text, numeric, numeric),
  public.cafe_network_remove(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_network_status(), public.cafe_network_info(), public.cafe_network_add(text, numeric, numeric),
  public.cafe_network_remove(uuid) TO authenticated;
