-- ============================================================
-- 35 · Live-Personalkosten: zentrale Tagesbasis labor_cost_today() (nur Admin, nur Summen)
-- (additiv: zwei Funktionen, keine Tabellen-/Datenänderung, Lohn/DATEV/Timesheet unberührt)
--
-- Fachliche Vorgaben (Entscheidung 2026-10-03):
-- • Tag = Kalendertag Europe/Berlin (00:00–24:00 Ortszeit, Sommer-/Winterzeit korrekt: 23 h / 25 h).
-- • Netto = Arbeitsintervall ∩ Tag − Pausenintervalle ∩ (Arbeitsintervall ∩ Tag). Schichten und Pausen über
--   Mitternacht werden an der Tagesgrenze geteilt. Laufende Schicht zählt bis jetzt, offene Pause zählt nicht.
-- • Beendete Einträge: maßgeblich bleibt hours_worked (dieselbe Zahl wie Timesheet/Payroll). Liegt ein Eintrag
--   ganz im Tag, zählt hours_worked exakt; über Mitternacht anteilig nach Intervall-Netto. Dadurch bleiben
--   Altbestand (pauschale break_minutes ohne Pausenzeilen) und „Ausstempeln vergessen“ (0 Std.) kompatibel,
--   ohne Doppelabzug.
-- • Kosten nur für Stundenlohn (pay_type = 'hourly'): Netto × hourly_rate. Fixgehalt wird NICHT in einen
--   Stundenlohn umgerechnet und nicht eingerechnet (auch kein interner hourly_rate); Anzahl nur als Hinweis.
-- • Geplant = Schichten, deren Intervall den Tag berührt (inkl. Nachtschicht vom Vortag), anteilig im Tag;
--   Ende vor Beginn = Folgetag (nie negativ). Nicht als Arbeitszeit geplant und daher NICHT gezählt: Schichten
--   an Tagen mit genehmigtem Urlaub oder Krankmeldung der Person sowie Schichten Ausgeschiedener.
--   Kosten wieder nur Stundenlohn.
-- • Für die Live-Anzeige liefert die Funktion zusätzlich die Summe der Stundensätze aller gerade arbeitenden
--   (eingestempelt, keine laufende Pause) Stundenlohn-Kräfte: Der Client schreibt damit zwischen zwei Abfragen
--   fort, ohne einzelne Löhne zu kennen.
-- Rechte: nur Admin (Löhne sind für Manager/Mitarbeiter nicht lesbar – Migration 19). Keine Einzelwerte, keine
-- Namen, keine IDs im Ergebnis.
-- Rückweg: beide Funktionen löschen. Wiederholt ausführbar.
-- Bereits live eingespielt (Migration labor_cost_today, Version 20261003085206, 2026-10-03; alle drei
-- pg_get_functiondef und Rechte identisch mit dieser Datei) — NICHT erneut ausführen.
-- ============================================================

-- Netto-Sekunden eines Eintrags innerhalb [p_from, p_to): Arbeitsintervall [p_in, p_work_end) ∩ Fenster minus
-- die Pausen ∩ (Arbeitsintervall ∩ Fenster); laufende Pause bis p_now.
CREATE OR REPLACE FUNCTION public._entry_net_seconds(p_entry uuid, p_in timestamptz, p_work_end timestamptz,
                                                     p_from timestamptz, p_to timestamptz, p_now timestamptz)
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT GREATEST(0,
      GREATEST(0, EXTRACT(EPOCH FROM (LEAST(p_work_end, p_to) - GREATEST(p_in, p_from))))
    - COALESCE((SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(b.break_end, p_now), p_work_end, p_to) - GREATEST(b.break_start, p_in, p_from)))))
                  FROM time_entry_breaks b WHERE b.time_entry_id = p_entry), 0))
$$;
REVOKE ALL ON FUNCTION public._entry_net_seconds(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- Tagesbasis zu einem Zeitpunkt (testbar mit festem p_now); nur intern
CREATE OR REPLACE FUNCTION public._labor_cost_at(p_now timestamptz)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_day date := (p_now AT TIME ZONE 'Europe/Berlin')::date;
  v_ds  timestamptz := v_day::timestamp AT TIME ZONE 'Europe/Berlin';
  v_de  timestamptz := (v_day + 1)::timestamp AT TIME ZONE 'Europe/Berlin';
  v_wd  date := v_day - (EXTRACT(ISODOW FROM v_day)::int - 1);
  v_ws  timestamptz := v_wd::timestamp AT TIME ZONE 'Europe/Berlin';
  v_today jsonb; v_week jsonb; v_plan jsonb;
BEGIN
  WITH ent AS (
    SELECT t.id, t.employee_id, t.clock_in, t.hours_worked, (e.pay_type = 'hourly') AS hourly, e.hourly_rate AS rate,
           (t.clock_out IS NOT NULL AND t.clock_out <= p_now) AS closed,
           LEAST(COALESCE(t.clock_out, p_now), p_now) AS work_end,
           EXISTS (SELECT 1 FROM time_entry_breaks b WHERE b.time_entry_id = t.id AND b.break_start <= p_now
                     AND (b.break_end IS NULL OR b.break_end > p_now)) AS on_break
      FROM time_entries t JOIN employees e ON e.id = t.employee_id
     WHERE t.clock_in < p_now AND COALESCE(t.clock_out, 'infinity') > v_ws
  ), net AS (
    SELECT ent.*,
           _entry_net_seconds(id, clock_in, work_end, '-infinity', 'infinity', p_now) AS iv_total,
           _entry_net_seconds(id, clock_in, work_end, v_ds, v_de, p_now)               AS iv_day,
           _entry_net_seconds(id, clock_in, work_end, v_ws, v_de, p_now)               AS iv_week
      FROM ent
  ), sec AS (
    SELECT net.*,
           CASE WHEN NOT closed THEN iv_day
                WHEN iv_total > 0 THEN COALESCE(hours_worked, 0) * 3600 * iv_day / iv_total ELSE 0 END AS day_sec,
           CASE WHEN NOT closed THEN iv_week
                WHEN iv_total > 0 THEN COALESCE(hours_worked, 0) * 3600 * iv_week / iv_total ELSE 0 END AS week_sec,
           (NOT closed AND NOT on_break) AS running
      FROM net
  )
  SELECT jsonb_build_object(
           'net_seconds',         ROUND(COALESCE(sum(day_sec), 0), 3),
           'net_seconds_hourly',  ROUND(COALESCE(sum(day_sec) FILTER (WHERE hourly), 0), 3),
           'cost',                ROUND(COALESCE(sum(day_sec / 3600 * rate) FILTER (WHERE hourly), 0), 6),
           'running',             count(*) FILTER (WHERE running),
           'running_hourly',      count(*) FILTER (WHERE running AND hourly),
           'running_rate',        ROUND(COALESCE(sum(rate) FILTER (WHERE running AND hourly), 0), 6),
           'on_break',            count(*) FILTER (WHERE NOT closed AND on_break),
           'fixed_working',       count(DISTINCT employee_id) FILTER (WHERE NOT hourly AND (day_sec > 0 OR running))),
         jsonb_build_object('cost', ROUND(COALESCE(sum(week_sec / 3600 * rate) FILTER (WHERE hourly), 0), 6))
    INTO v_today, v_week FROM sec;

  WITH sh AS (
    SELECT s.employee_id, (e.pay_type = 'hourly') AS hourly, e.hourly_rate AS rate,
           (s.date + s.start_time) AT TIME ZONE 'Europe/Berlin' AS ps,
           (s.date + s.end_time + CASE WHEN s.end_time < s.start_time THEN interval '1 day' ELSE interval '0' END)
             AT TIME ZONE 'Europe/Berlin' AS pe,
           (EXISTS (SELECT 1 FROM vacation_requests v WHERE v.employee_id = s.employee_id AND v.status = 'approved'
                      AND s.date BETWEEN v.start_date AND v.end_date)
            OR EXISTS (SELECT 1 FROM sick_leave k WHERE k.employee_id = s.employee_id
                      AND s.date >= k.start_date AND (k.end_date IS NULL OR s.date <= k.end_date))) AS absent,
           (NOT COALESCE(e.is_active, false) AND (e.end_date IS NULL OR e.end_date < s.date)) AS gone
      FROM shifts s JOIN employees e ON e.id = s.employee_id
     WHERE s.date BETWEEN v_day - 1 AND v_day
  ), part AS (
    SELECT sh.*, GREATEST(0, EXTRACT(EPOCH FROM (LEAST(pe, v_de) - GREATEST(ps, v_ds)))) AS sec FROM sh
  )
  SELECT jsonb_build_object(
           'cost',             ROUND(COALESCE(sum(sec / 3600 * rate) FILTER (WHERE hourly AND NOT absent AND NOT gone), 0), 6),
           'seconds',          ROUND(COALESCE(sum(sec) FILTER (WHERE NOT absent AND NOT gone), 0), 3),
           'seconds_hourly',   ROUND(COALESCE(sum(sec) FILTER (WHERE hourly AND NOT absent AND NOT gone), 0), 3),
           'shifts',           count(*) FILTER (WHERE sec > 0 AND NOT absent AND NOT gone),
           'excluded_absent',  count(*) FILTER (WHERE sec > 0 AND absent AND NOT gone),
           'fixed_shifts',     count(*) FILTER (WHERE sec > 0 AND NOT hourly AND NOT absent AND NOT gone))
    INTO v_plan FROM part;

  RETURN jsonb_build_object(
    'server_now', p_now, 'day', v_day, 'day_start', v_ds, 'day_end', v_de, 'week_start', v_ws,
    'today', v_today, 'week', v_week, 'planned', v_plan);
END $function$;
REVOKE ALL ON FUNCTION public._labor_cost_at(timestamptz) FROM PUBLIC, anon, authenticated;

-- Öffentliche RPC: nur Admin, Zeitpunkt = Serverzeit
CREATE OR REPLACE FUNCTION public.labor_cost_today()
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'Nicht autorisiert.' USING HINT = 'labor_cost_admin_only';
  END IF;
  RETURN _labor_cost_at(clock_timestamp());
END $function$;
REVOKE ALL ON FUNCTION public.labor_cost_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.labor_cost_today() TO authenticated;

NOTIFY pgrst, 'reload schema';
