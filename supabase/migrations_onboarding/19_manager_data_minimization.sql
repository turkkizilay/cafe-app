-- ============================================================
-- 19 · Datenminimierung für Manager (operative Rolle, keine Lohn-/HR-Rolle)
-- • Manager lesen fremde Mitarbeiter NICHT mehr direkt aus `employees` (dort liegen
--   Stundenlohn, Fixgehalt, IBAN, Steuer-ID, SV-Nummer, Krankenkasse, Adresse …).
--   Stattdessen: get_staff_operational() – nur operative Felder, nur für Manager/Admin.
-- • payroll_months: Lesen nur noch Admin + eigener Mitarbeiter (keine Manager-Leseregel).
-- • employee_onboarding (Personaldaten neuer Mitarbeiter): Lesen nur Admin + eigener Antrag.
-- • Admin: unverändert voller Zugriff (emp_admin_write, pay_manage, …).
-- • Mitarbeiter: unverändert nur eigene Daten (emp_read_self, pay_read, onb_select_own).
-- • Keine Datenänderung.
-- NOCH NICHT live eingespielt.
-- ============================================================

DROP POLICY IF EXISTS emp_manager_read   ON public.employees;
DROP POLICY IF EXISTS pay_manager_read   ON public.payroll_months;
DROP POLICY IF EXISTS onb_select_staff   ON public.employee_onboarding;
DROP POLICY IF EXISTS onb_select_admin   ON public.employee_onboarding;
CREATE POLICY onb_select_admin ON public.employee_onboarding FOR SELECT TO authenticated USING (is_admin());

-- Operative Mitarbeiterdaten für Manager/Admin (Schichtplanung, Urlaub, Abwesenheit, Stunden)
CREATE OR REPLACE FUNCTION public.get_staff_operational()
RETURNS TABLE (
  id uuid, first_name character varying, last_name character varying, email character varying,
  phone character varying, "position" character varying, employment_type character varying,
  hours_per_week numeric, vacation_days_per_year integer, start_date date, end_date date,
  is_active boolean, avatar_color character varying, avatar_url text, birth_date date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT e.id, e.first_name, e.last_name, e.email, e.phone, e."position", e.employment_type,
         e.hours_per_week, e.vacation_days_per_year, e.start_date, e.end_date,
         e.is_active, e.avatar_color, e.avatar_url, e.birth_date
    FROM employees e
   WHERE is_manager_or_admin()
   ORDER BY e.last_name, e.first_name
$$;
REVOKE ALL ON FUNCTION public.get_staff_operational() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_operational() TO authenticated;
