-- ============================================================
-- 25 · Account-Lifecycle härten (nur Admin, additiv)
-- • approve_onboarding_with_pay(...): Freischaltung + Vergütungsmodell in EINER Transaktion. Bisher legte
--   approve_onboarding immer mit Stundenlohn an und das Fixgehalt wurde vom Browser in einem zweiten Schritt
--   gesetzt – schlug der fehl, war der Mitarbeiter mit falschem Vergütungsmodell angelegt. Jetzt: alles oder nichts
--   (ungültige Kombination → keine Freischaltung, kein Mitarbeiter-Datensatz).
-- • Verwaiste Anmeldungen = Auth-Konto OHNE Profil. Entstanden, weil „Registrierung ablehnen“ (alte Registrierungen
--   ohne Einladung) nur das Profil löschte. Folge: Diese Adresse konnte weder eingeladen werden noch sich registrieren.
--   – admin_login_orphans(): listet sie (Adresse, angelegt, bestätigt, gibt es einen Mitarbeiter mit dieser Adresse).
--   – admin_remove_orphan_login(p_user_id): entfernt NUR ein Auth-Konto ohne Profil (es hat keinerlei App-Zugriff
--     und keine eigenen Daten). Danach kann die Person normal eingeladen werden und bestätigt ihre E-Mail neu –
--     kein Zusammenführen nach E-Mail, keine Umgehung der Bestätigung.
--   – admin_reject_pending_login(p_profile_id): ersetzt das reine Profil-Löschen: entfernt ein wartendes Konto ohne
--     Mitarbeiter und ohne Onboarding vollständig (Auth + Profil) → es entstehen keine neuen Waisen.
-- • Keine Änderung bestehender Tabellen/Funktionen, keine Datenänderung.
-- Bereits live eingespielt (Migration account_lifecycle_hardening, 2026-09-28) — NICHT erneut ausführen.
-- ============================================================

CREATE OR REPLACE FUNCTION public.approve_onboarding_with_pay(
  p_id uuid, p_role text, p_position text, p_employment_type text, p_hours_per_week numeric,
  p_hourly_rate numeric, p_start_date date, p_vacation_days integer, p_pay_type text, p_monthly_salary numeric)
RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v json;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_pay_type NOT IN ('hourly', 'fixed') THEN RETURN json_build_object('success', false, 'error', 'Ungültiges Vergütungsmodell.'); END IF;
  IF p_pay_type = 'fixed' AND p_employment_type NOT IN ('vollzeit', 'teilzeit') THEN
    RETURN json_build_object('success', false, 'error', 'Fixgehalt ist nur bei Vollzeit oder Teilzeit möglich.');
  END IF;
  IF p_pay_type = 'fixed' AND (p_monthly_salary IS NULL OR p_monthly_salary <= 0) THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib das Brutto-Monatsgehalt an.');
  END IF;
  v := approve_onboarding(p_id, p_role, p_position, p_employment_type, p_hours_per_week, p_hourly_rate, p_start_date, p_vacation_days);
  IF NOT COALESCE((v->>'success')::boolean, false) THEN RETURN v; END IF;
  IF p_pay_type = 'fixed' THEN
    -- Constraints (Migration 18) greifen hier; jeder Fehler macht die gesamte Freischaltung rückgängig
    UPDATE employees SET pay_type = 'fixed', monthly_salary = p_monthly_salary WHERE id = (v->>'employee_id')::uuid;
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.approve_onboarding_with_pay(uuid, text, text, text, numeric, numeric, date, integer, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_onboarding_with_pay(uuid, text, text, text, numeric, numeric, date, integer, text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_login_orphans()
RETURNS TABLE (user_id uuid, email text, created_at timestamptz, email_confirmed boolean, employee_match boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  RETURN QUERY
    SELECT u.id, u.email::text, u.created_at, (u.email_confirmed_at IS NOT NULL),
           EXISTS (SELECT 1 FROM employees e WHERE lower(e.email) = lower(u.email))
      FROM auth.users u
     WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id)
     ORDER BY u.created_at;
END $$;
REVOKE ALL ON FUNCTION public.admin_login_orphans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_login_orphans() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_remove_orphan_login(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_email text;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'Das eigene Konto kann so nicht entfernt werden.'; END IF;
  DELETE FROM auth.users u
   WHERE u.id = p_user_id AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id)
  RETURNING u.email INTO v_email;
  IF v_email IS NULL THEN RAISE EXCEPTION 'Nur Anmeldungen ohne Benutzerkonto können entfernt werden.'; END IF;
  BEGIN
    INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
    SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin'), a.role,
           'employee.orphan_login_removed', 'employee',
           COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin') || ' hat die verwaiste Anmeldung ' || v_email || ' entfernt.',
           'auth_user', p_user_id::text, v_email
      FROM profiles a WHERE a.id = auth.uid();
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('success', true, 'email', v_email);
END $$;
REVOKE ALL ON FUNCTION public.admin_remove_orphan_login(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remove_orphan_login(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reject_pending_login(p_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE p profiles%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT * INTO p FROM profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Konto nicht gefunden.'; END IF;
  IF p.id = auth.uid() OR p.is_owner THEN RAISE EXCEPTION 'Dieses Konto kann nicht abgelehnt werden.'; END IF;
  IF p.status <> 'pending' OR p.employee_id IS NOT NULL OR EXISTS (SELECT 1 FROM employee_onboarding o WHERE o.profile_id = p.id) THEN
    RAISE EXCEPTION 'Nur wartende Registrierungen ohne Mitarbeiter und ohne Onboarding können so abgelehnt werden.';
  END IF;
  DELETE FROM auth.users WHERE id = p.id;   -- Profil folgt per ON DELETE CASCADE
  BEGIN
    INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
    SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin'), a.role,
           'employee.pending_login_rejected', 'employee',
           COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin') || ' hat die Registrierung ' || COALESCE(p.email, '') || ' abgelehnt.',
           'auth_user', p.id::text, p.email
      FROM profiles a WHERE a.id = auth.uid();
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.admin_reject_pending_login(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_pending_login(uuid) TO authenticated;
