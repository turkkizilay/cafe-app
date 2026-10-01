-- ============================================================
-- 31 · Hessische Feiertage berechnet statt gepflegt (additiv; KEINE Änderung an Geschäftsdaten)
-- Bereits live eingespielt (Migration hessen_holidays, Version 20261001123906, 2026-10-01) — in Production
-- NICHT erneut ausführen (lokal in tests/db bewusst wiederholt ausführbar).
--
-- Bisher: public_holidays war eine von Hand befüllte Tabelle (Hessen 2025 + 2026, ab 2027 leer) und enthielt
-- fälschlich „Allerheiligen 01.11.2026“ (in Hessen kein gesetzlicher Feiertag). Gelesen von: vacation_guard_insert
-- (days_count beim Urlaubsantrag), Urlaubsantrag/-konto/§9-Prüfung (Vacation, MyHours, Account) und dem
-- Stundenzettel (Feiertagsvermerk). Lohnabrechnung/DATEV lesen KEINE Feiertage – daran ändert sich nichts.
--
-- Fachgrundlage (bestätigt 2026-10-01, Hessisches Feiertagsrecht): genau 10 gesetzliche Feiertage –
-- Neujahr (01.01.), Karfreitag, Ostermontag, Tag der Arbeit (01.05.), Christi Himmelfahrt, Pfingstmontag,
-- Fronleichnam, Tag der Deutschen Einheit (03.10.), 1. und 2. Weihnachtstag (25./26.12.). Nicht: Allerheiligen.
--
-- Neu – EINE Definition, jahresunabhängig:
-- • cafe_calendar.easter_sunday(year) – gregorianische Osterformel (Meeus/Jones/Butcher), reine Ganzzahlrechnung.
-- • cafe_calendar.hessen_holidays(year) – die 10 Feiertage; bewegliche relativ zu Ostern
--   (−2, +1, +39, +50, +60 Tage).
-- • public.public_holidays wird eine VIEW mit denselben Spalten (id, date, name, bundesland, year), berechnet für
--   1990–2100. Alle bestehenden Abfragen (App + vacation_guard_insert) bleiben unverändert und lesen damit dieselbe
--   Definition – Browser und Server kennen dieselben Feiertage, eine zweite Liste im Frontend gibt es nicht.
-- • Die bisherige Tabelle bleibt unverändert als public_holidays_manual_2025_2026 erhalten (Nachvollziehbarkeit),
--   wird aber nirgends mehr gelesen.
-- • Schema cafe_calendar ist nicht über die REST-API veröffentlicht → keine neuen öffentlich aufrufbaren Funktionen;
--   die Funktionen sind IMMUTABLE, SECURITY INVOKER und lesen keine Daten.
--
-- Bewusst NICHT geändert: gespeicherte vacation_requests.days_count, Krankmeldungen, continued_pay_end,
-- Abrechnungsmonate, vacation_guard_insert (unverändert; liest weiterhin public_holidays), jede Vergütungsregel.
-- Wiederholt ausführbar. Deploy: nur diese Migration (App-Abfragen unverändert).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS cafe_calendar;
REVOKE ALL ON SCHEMA cafe_calendar FROM PUBLIC;
GRANT USAGE ON SCHEMA cafe_calendar TO anon, authenticated, service_role;

-- Ostersonntag (gregorianisch; Meeus/Jones/Butcher). Gültig für 1583–9999.
CREATE OR REPLACE FUNCTION cafe_calendar.easter_sunday(p_year integer)
 RETURNS date
 LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; n int;
BEGIN
  IF p_year < 1583 OR p_year > 9999 THEN
    RAISE EXCEPTION 'Jahr % außerhalb des gregorianischen Bereichs.', p_year;
  END IF;
  a := p_year % 19;
  b := p_year / 100;  c := p_year % 100;
  d := b / 4;         e := b % 4;
  f := (b + 8) / 25;  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;         k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  n := h + l - 7 * m + 114;
  RETURN make_date(p_year, n / 31, (n % 31) + 1);
END $function$;

-- Die 10 gesetzlichen Feiertage in Hessen (Namen wie bisher in der Tabelle → gleiche Anzeige im Stundenzettel)
CREATE OR REPLACE FUNCTION cafe_calendar.hessen_holidays(p_year integer)
 RETURNS TABLE(holiday_date date, holiday_name text)
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT v.d, v.n
    FROM (SELECT cafe_calendar.easter_sunday(p_year) AS e) o,
         LATERAL (VALUES
           (make_date(p_year, 1, 1),   'Neujahr'),
           (o.e - 2,                   'Karfreitag'),
           (o.e + 1,                   'Ostermontag'),
           (make_date(p_year, 5, 1),   'Tag der Arbeit'),
           (o.e + 39,                  'Christi Himmelfahrt'),
           (o.e + 50,                  'Pfingstmontag'),
           (o.e + 60,                  'Fronleichnam'),
           (make_date(p_year, 10, 3),  'Tag der Deutschen Einheit'),
           (make_date(p_year, 12, 25), '1. Weihnachtstag'),
           (make_date(p_year, 12, 26), '2. Weihnachtstag')
         ) AS v(d, n)
$function$;

CREATE OR REPLACE FUNCTION cafe_calendar.is_hessen_holiday(p_date date)
 RETURNS boolean
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT EXISTS (SELECT 1 FROM cafe_calendar.hessen_holidays(EXTRACT(YEAR FROM p_date)::int) h WHERE h.holiday_date = p_date)
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cafe_calendar FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cafe_calendar.easter_sunday(integer), cafe_calendar.hessen_holidays(integer),
                          cafe_calendar.is_hessen_holiday(date) TO anon, authenticated, service_role;

-- Bisherige Tabelle unverändert aufbewahren (nur einmal umbenennen; bei Wiederholung nichts tun)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.public_holidays') AND relkind = 'r') THEN
    IF to_regclass('public.public_holidays_manual_2025_2026') IS NOT NULL THEN
      RAISE EXCEPTION 'public_holidays_manual_2025_2026 existiert bereits – bitte manuell prüfen.';
    END IF;
    ALTER TABLE public.public_holidays RENAME TO public_holidays_manual_2025_2026;
    COMMENT ON TABLE public.public_holidays_manual_2025_2026 IS
      'Historische, von Hand gepflegte Feiertagsliste bis Migration 31 (enthält fälschlich Allerheiligen 2026). Wird nicht mehr gelesen; maßgeblich ist cafe_calendar.hessen_holidays().';
  END IF;
END $$;

-- Gleiche Spalten wie die bisherige Tabelle; nur Hessen; deterministische, eindeutige id (Datum + Name: am
-- 01.05.2008 fielen Tag der Arbeit und Christi Himmelfahrt zusammen – zwei Zeilen, gezählt wird der Tag einmal)
CREATE OR REPLACE VIEW public.public_holidays WITH (security_invoker = true) AS
  SELECT md5('Hessen|' || h.holiday_date::text || '|' || h.holiday_name)::uuid AS id,
         h.holiday_date                                     AS date,
         h.holiday_name::character varying(200)             AS name,
         'Hessen'::character varying(50)                    AS bundesland,
         y.y::integer                                       AS year
    FROM generate_series(1990, 2100) AS y(y),
         LATERAL cafe_calendar.hessen_holidays(y.y::integer) AS h;

COMMENT ON VIEW public.public_holidays IS
  'Gesetzliche Feiertage Hessen 1990–2100, berechnet (cafe_calendar.hessen_holidays). Einzige Feiertagsquelle für App und Server (Migration 31).';

-- Nur lesen (Supabase-Standardrechte würden sonst auch Schreibrechte auf neue Views vergeben)
REVOKE ALL ON public.public_holidays FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.public_holidays TO anon, authenticated, service_role;
