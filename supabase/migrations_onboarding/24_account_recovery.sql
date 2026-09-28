-- ============================================================
-- 24 · Recovery für festhängende Registrierungen (nur Admin)
-- Problem: Die Einladung wird schon beim signUp eingelöst (02_signup_trigger). Kommt die Bestätigungs-E-Mail
-- nicht an, existiert ein Auth-Konto ohne bestätigte E-Mail; der Admin sah diesen Zustand nicht, konnte keine
-- Bestätigung erneut anstoßen, „Registrierung abbrechen“ sperrte das Profil endgültig und eine neue Einladung
-- scheiterte, weil die Adresse schon registriert ist.
-- • admin_account_states(): je Profil nur, ob die E-Mail bestätigt ist, wann zuletzt eine Bestätigung verschickt
--   wurde und ob sich die Person je angemeldet hat. Keine weiteren Auth-Daten.
-- • admin_prepare_confirmation_resend(p_profile_id): prüft serverseitig (Admin, Konto existiert, E-Mail NICHT
--   bestätigt), protokolliert und liefert die Adresse. Den Versand selbst übernimmt der von Supabase vorgesehene
--   Endpunkt auth.resend (type 'signup'), der nur an diese Adresse schickt – kein eigener Token, kein Service-Key.
-- • admin_reopen_registration(p_profile_id): macht einen versehentlichen Abbruch rückgängig (Profil disabled →
--   pending, Onboarding rejected → draft), nur solange KEIN Mitarbeiter-Datensatz verknüpft ist. Einladung und die
--   dort hinterlegten Vertrags-/Vergütungsdaten (invitations.job) bleiben unverändert erhalten.
-- • Keine E-Mail-Bestätigung durch den Admin (würde die Adresse ohne Nachweis als bestätigt markieren).
-- • Additiv: keine bestehende Tabelle/Funktion wird geändert, keine Daten werden geändert.
-- Bereits live eingespielt (Migration account_recovery, 2026-09-28) — NICHT erneut ausführen.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_account_states()
RETURNS TABLE (profile_id uuid, email_confirmed boolean, confirmation_sent_at timestamptz, ever_signed_in boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  RETURN QUERY
    SELECT p.id, (u.email_confirmed_at IS NOT NULL), u.confirmation_sent_at, (u.last_sign_in_at IS NOT NULL)
      FROM profiles p JOIN auth.users u ON u.id = p.id;
END $$;
REVOKE ALL ON FUNCTION public.admin_account_states() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_account_states() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_prepare_confirmation_resend(p_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_email text; v_confirmed boolean;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT u.email, (u.email_confirmed_at IS NOT NULL) INTO v_email, v_confirmed
    FROM auth.users u JOIN profiles p ON p.id = u.id WHERE u.id = p_profile_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'Konto nicht gefunden.'; END IF;
  IF v_confirmed THEN RAISE EXCEPTION 'Die E-Mail-Adresse ist bereits bestätigt.'; END IF;
  BEGIN
    INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
    SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin'), a.role,
           'employee.confirmation_resent', 'employee',
           COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin') || ' hat die Bestätigungs-E-Mail für ' || v_email || ' erneut angefordert.',
           'profile', p_profile_id::text, v_email
      FROM profiles a WHERE a.id = auth.uid();
  EXCEPTION WHEN OTHERS THEN NULL;   -- Protokoll darf die Aktion nie blockieren
  END;
  RETURN jsonb_build_object('email', v_email);
END $$;
REVOKE ALL ON FUNCTION public.admin_prepare_confirmation_resend(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_prepare_confirmation_resend(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reopen_registration(p_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  p profiles%ROWTYPE; o employee_onboarding%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT * INTO p FROM profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Konto nicht gefunden.'; END IF;
  IF p.employee_id IS NOT NULL THEN RAISE EXCEPTION 'Dieses Konto ist bereits mit einem Mitarbeiter verknüpft – bitte dort entsperren.'; END IF;
  SELECT * INTO o FROM employee_onboarding WHERE profile_id = p_profile_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'rejected' OR p.status <> 'disabled' THEN
    RAISE EXCEPTION 'Diese Registrierung kann nicht wieder geöffnet werden.';
  END IF;
  UPDATE employee_onboarding SET status = 'draft', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
   WHERE id = o.id;
  UPDATE profiles SET status = 'pending' WHERE id = p_profile_id;
  BEGIN
    INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
    SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin'), a.role,
           'employee.registration_reopened', 'employee',
           COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin') || ' hat die Registrierung von ' || o.email || ' wieder geöffnet.',
           'onboarding', o.id::text, o.email
      FROM profiles a WHERE a.id = auth.uid();
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.admin_reopen_registration(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reopen_registration(uuid) TO authenticated;
