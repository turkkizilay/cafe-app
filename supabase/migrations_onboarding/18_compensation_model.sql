-- ============================================================
-- 18 · Vergütungsmodell getrennt von der Beschäftigungsart
-- • pay_type: 'hourly' (Stundenlohn) | 'fixed' (Fixgehalt)
-- • monthly_salary: Brutto-Monatsgehalt bei Fixgehalt (keine Teilmonats-Kürzung)
-- • Fixgehalt nur bei Vollzeit/Teilzeit; Werkstudent & Minijob nur Stundenlohn
-- • hourly_rate bleibt Pflicht (> 0) – bei Fixgehalt nur interner Satz (Kostenschätzung)
-- • Bestandsmitarbeiter → 'hourly' (DEFAULT) – Berechnung für sie unverändert
-- • payroll_months friert pay_type/monthly_salary beim Monatsabschluss mit ein
-- • Keine Änderung an RLS/Grants: bestehende Zeilen-Policies gelten für die neuen Spalten
-- Bereits live eingespielt (Migration compensation_model, 2026-09-25) — NICHT erneut ausführen.
-- ============================================================

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS pay_type text NOT NULL DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS monthly_salary numeric(10,2);

ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_pay_type_valid;
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_monthly_salary_positive;
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_pay_model_complete;
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_fixed_pay_types;
ALTER TABLE public.employees
  ADD CONSTRAINT employees_pay_type_valid CHECK (pay_type IN ('hourly', 'fixed')),
  ADD CONSTRAINT employees_monthly_salary_positive CHECK (monthly_salary IS NULL OR monthly_salary > 0),
  ADD CONSTRAINT employees_pay_model_complete CHECK (pay_type = 'hourly' OR monthly_salary IS NOT NULL),
  ADD CONSTRAINT employees_fixed_pay_types CHECK (pay_type = 'hourly' OR employment_type IN ('vollzeit', 'teilzeit'));

ALTER TABLE public.payroll_months
  ADD COLUMN IF NOT EXISTS pay_type text,
  ADD COLUMN IF NOT EXISTS monthly_salary numeric(10,2);
