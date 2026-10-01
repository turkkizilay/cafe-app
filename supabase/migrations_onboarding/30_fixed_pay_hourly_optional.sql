-- ============================================================
-- 30 · Fixgehalt ohne Stundenlohn (additiv; KEINE Datenänderung)
-- Bereits live eingespielt (Migration fixed_pay_hourly_optional, Version 20261001112822, 2026-10-01) — in Production
-- NICHT erneut ausführen (lokal in tests/db bewusst wiederholt ausführbar).
--
-- Fehler (Production): Freischaltung mit Vergütung „Fixgehalt“ + gültigem Brutto-Monatsgehalt scheiterte mit
-- „Bitte einen Stundenlohn angeben.“ Der Stundenlohn war auf drei Ebenen IMMER Pflicht:
--   1. App (Freischaltungs- und Mitarbeiterformular),
--   2. approve_onboarding (wird von approve_onboarding_with_pay aufgerufen; prüfte p_hourly_rate vor dem Modell),
--   3. Spalte employees.hourly_rate NOT NULL.
-- Fachlich (Migration 18): Fixgehalt-Brutto = Monatsgehalt, nie Stunden × Satz; der Stundenlohn wird dafür nirgends
-- verwendet (Lohn, Lohnfortzahlung und DATEV-Stundenlohn-Spalte sind bei Fixgehalt bereits leer/0).
--
-- Neu – Quelle der Wahrheit ist pay_type:
-- • Stundenlohn: hourly_rate Pflicht (> 0) – jetzt als Tabellenregel employees_hourly_rate_required.
-- • Fixgehalt:   monthly_salary Pflicht (bestehende Regeln aus Migration 18); hourly_rate optional (NULL erlaubt,
--                wenn angegeben weiterhin > 0). KEIN Ersatz-/Schein-Stundenlohn wird erzeugt.
-- • Freischaltung: _approve_onboarding_core legt den Mitarbeiter in EINEM INSERT direkt mit pay_type und
--   monthly_salary an (vorher: als Stundenlohn anlegen, dann auf Fixgehalt umstellen – dafür war der Stundenlohn
--   technisch nötig). approve_onboarding (alte Signatur) verhält sich unverändert (immer Stundenlohn, Satz Pflicht).
-- Bestehende Daten: unverändert (alle Zeilen haben einen Stundenlohn; die neue Regel ist für sie erfüllt).
-- Wiederholt ausführbar (tests/db: LIFECYCLE_MIGRATIONS, weil die Vorlage approve_onboarding neu einspielt).
-- Deploy-Reihenfolge: zuerst diese Migration, dann das Frontend (alter Client schickt bei Fixgehalt immer einen
-- Stundenlohn mit → funktioniert weiter; neuer Client ohne Migration: Fixgehalt ohne Satz → klare Serverablehnung).
-- ============================================================

ALTER TABLE public.employees ALTER COLUMN hourly_rate DROP NOT NULL;
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_hourly_rate_required;
ALTER TABLE public.employees ADD CONSTRAINT employees_hourly_rate_required
  CHECK (pay_type = 'fixed' OR hourly_rate IS NOT NULL);
-- employees_hourly_rate_positive (hourly_rate > 0) bleibt: ein angegebener Satz muss weiterhin > 0 sein.

-- ── Gemeinsamer Kern der Freischaltung (nicht direkt aufrufbar) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._approve_onboarding_core(p_id uuid, p_role text, p_position text, p_employment_type text,
  p_hours_per_week numeric, p_hourly_rate numeric, p_start_date date, p_vacation_days integer, p_pay_type text, p_monthly_salary numeric)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE o employee_onboarding%ROWTYPE; v_emp UUID;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_role NOT IN ('employee','manager','admin') THEN RETURN json_build_object('success', false, 'error', 'Ungültige Rolle.'); END IF;
  IF p_employment_type NOT IN ('vollzeit','teilzeit','werkstudent','minijob') THEN RETURN json_build_object('success', false, 'error', 'Bitte wähle eine Beschäftigungsart.'); END IF;
  IF p_pay_type IS NULL OR p_pay_type NOT IN ('hourly', 'fixed') THEN RETURN json_build_object('success', false, 'error', 'Ungültiges Vergütungsmodell.'); END IF;
  IF p_pay_type = 'hourly' AND (p_hourly_rate IS NULL OR p_hourly_rate <= 0) THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib einen Stundenlohn an.');
  END IF;
  IF p_pay_type = 'fixed' AND p_hourly_rate IS NOT NULL AND p_hourly_rate <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Der Stundenlohn muss größer als 0 sein oder leer bleiben.');
  END IF;
  IF p_start_date IS NULL THEN RETURN json_build_object('success', false, 'error', 'Bitte gib das Eintrittsdatum an.'); END IF;
  IF p_hours_per_week IS NULL OR p_hours_per_week <= 0 OR p_hours_per_week > 60 THEN RETURN json_build_object('success', false, 'error', 'Bitte prüfe die Wochenstunden.'); END IF;
  IF p_vacation_days IS NULL OR p_vacation_days < 0 OR p_vacation_days > 60 THEN RETURN json_build_object('success', false, 'error', 'Bitte prüfe den Urlaubsanspruch.'); END IF;
  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'submitted' THEN RETURN json_build_object('success', false, 'error', 'Diese Einreichung kann gerade nicht freigeschaltet werden.'); END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = o.profile_id AND employee_id IS NOT NULL) THEN RETURN json_build_object('success', false, 'error', 'Dieser Account ist bereits mit einem Mitarbeiter verknüpft.'); END IF;
  IF EXISTS (SELECT 1 FROM employees WHERE LOWER(email) = LOWER(o.email)) THEN RETURN json_build_object('success', false, 'error', 'Es gibt bereits einen Mitarbeiter mit dieser E-Mail-Adresse.'); END IF;
  -- Ein INSERT mit dem endgültigen Vergütungsmodell; Tabellenregeln (Migration 18/30) greifen, jeder Fehler rollt alles zurück
  INSERT INTO employees (first_name, last_name, email, phone, birth_date, address, position, employment_type, hours_per_week, hourly_rate, pay_type, monthly_salary, start_date, vacation_days_per_year, iban, is_active, avatar_initials, birth_name, birth_place, nationality, street, house_number, postal_code, city, account_holder, tax_id, social_security_number, health_insurance, other_employment, other_employment_note, emergency_contact_name, emergency_contact_phone, onboarding_completed_at)
  VALUES (o.first_name, o.last_name, LOWER(o.email), o.phone, o.birth_date, CONCAT(o.street,' ',o.house_number,', ',o.postal_code,' ',o.city), NULLIF(TRIM(COALESCE(p_position,'')),''), p_employment_type, p_hours_per_week, p_hourly_rate, p_pay_type, CASE WHEN p_pay_type = 'fixed' THEN p_monthly_salary ELSE NULL END, p_start_date, p_vacation_days, o.iban, true, UPPER(LEFT(o.first_name,1) || LEFT(o.last_name,1)), o.birth_name, o.birth_place, o.nationality, o.street, o.house_number, o.postal_code, o.city, o.account_holder, o.tax_id, o.social_security_number, o.health_insurance, o.other_employment, o.other_employment_note, o.emergency_contact_name, o.emergency_contact_phone, NOW())
  RETURNING id INTO v_emp;
  UPDATE profiles SET status = 'approved', role = p_role, employee_id = v_emp, approved_at = NOW(), approved_by = auth.uid(), first_name = o.first_name, last_name = o.last_name WHERE id = o.profile_id;
  UPDATE employee_onboarding SET status = 'approved', employee_id = v_emp, reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW() WHERE id = p_id;
  PERFORM _onb_log('employee.approved', 'hat ' || CONCAT(o.first_name,' ',o.last_name) || ' freigeschaltet.', v_emp::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true, 'employee_id', v_emp);
END; $function$;
REVOKE ALL ON FUNCTION public._approve_onboarding_core(uuid, text, text, text, numeric, numeric, date, integer, text, numeric) FROM PUBLIC, anon, authenticated;

-- ── Alte Signatur: unverändertes Verhalten (immer Stundenlohn, Satz Pflicht) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_onboarding(p_id uuid, p_role text, p_position text, p_employment_type text,
  p_hours_per_week numeric, p_hourly_rate numeric, p_start_date date, p_vacation_days integer)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  RETURN _approve_onboarding_core(p_id, p_role, p_position, p_employment_type, p_hours_per_week, p_hourly_rate,
                                  p_start_date, p_vacation_days, 'hourly', NULL);
END; $function$;
REVOKE ALL ON FUNCTION public.approve_onboarding(uuid, text, text, text, numeric, numeric, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_onboarding(uuid, text, text, text, numeric, numeric, date, integer) TO authenticated;

-- ── Freischaltung mit Vergütung (App): Prüfreihenfolge wie Migration 25, Anlage in einem Schritt ───────────
CREATE OR REPLACE FUNCTION public.approve_onboarding_with_pay(p_id uuid, p_role text, p_position text, p_employment_type text,
  p_hours_per_week numeric, p_hourly_rate numeric, p_start_date date, p_vacation_days integer, p_pay_type text, p_monthly_salary numeric)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_pay_type IS NULL OR p_pay_type NOT IN ('hourly', 'fixed') THEN RETURN json_build_object('success', false, 'error', 'Ungültiges Vergütungsmodell.'); END IF;
  IF p_pay_type = 'fixed' AND p_employment_type NOT IN ('vollzeit', 'teilzeit') THEN
    RETURN json_build_object('success', false, 'error', 'Fixgehalt ist nur bei Vollzeit oder Teilzeit möglich.');
  END IF;
  IF p_pay_type = 'fixed' AND (p_monthly_salary IS NULL OR p_monthly_salary <= 0) THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib das Brutto-Monatsgehalt an.');
  END IF;
  RETURN _approve_onboarding_core(p_id, p_role, p_position, p_employment_type, p_hours_per_week, p_hourly_rate,
                                  p_start_date, p_vacation_days, p_pay_type, p_monthly_salary);
END $function$;
REVOKE ALL ON FUNCTION public.approve_onboarding_with_pay(uuid, text, text, text, numeric, numeric, date, integer, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_onboarding_with_pay(uuid, text, text, text, numeric, numeric, date, integer, text, numeric) TO authenticated;
