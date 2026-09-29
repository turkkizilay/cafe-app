-- ============================================================
-- 26 · Registrierung sicher zurücksetzen (nur Admin, additiv)
-- Problem: Registrierungen MIT Onboarding (Einladung beim signUp eingelöst, z. B. Bestätigungs-E-Mail kam nie an)
-- konnten nicht entfernt werden – admin_reject_pending_login (25) greift nur ohne Onboarding. Die Adresse blieb in
-- auth.users belegt; eine neue Einladung war unmöglich.
-- Löschwirkung heute (Production-Katalog, read-only geprüft 2026-09-29):
--   auth.users ─CASCADE→ profiles ─CASCADE→ employee_onboarding, push_subscriptions, push_outbox,
--                                            privacy_notice_acknowledgements (!)
--   alle *_by/actor_id-Spalten → SET NULL; employees hat KEINEN FK auf auth.users/profiles
--   (Personalakte + Zeiten/Pausen/Schichten/Urlaub/Krankheit/Lohn/Dokumente hängen nur an employees.id).
-- Deshalb:
-- • admin_registration_reset_check(p_user_id): klassifiziert serverseitig, ändert nichts.
--     mode 'full'       – Registrierung ohne Personalakte (Profil wartend/gesperrt, Onboarding fehlt oder Entwurf/
--                          abgebrochen, keine Datenschutz-Kenntnisnahme): Auth-Konto + Profil + Onboarding-Entwurf.
--     mode 'login_only' – mit Personalakte verknüpft, aber Login NIE benutzt: nur Auth-Konto + Profil; die
--                          Personalakte und ihre gesamte Historie bleiben unangetastet (neu einladen verknüpft wieder).
--     mode 'blocked'    – alles andere, mit exakten Gründen (blockers).
--   Jede weitere FK-Referenz auf das Konto (dynamisch aus pg_constraint, auch künftige Tabellen) blockiert –
--   insbesondere Datenschutz-Kenntnisnahmen und Protokoll-/Bearbeiter-Einträge. Storage-Objekte des Kontos blockieren.
-- • admin_reset_registration(p_user_id, p_expected_email, p_expected_mode): sperrt auth.users- und Profilzeile,
--   klassifiziert NEU (veraltete Ansicht → Abbruch, wenn Adresse oder Modus abweichen), löscht in EINER Transaktion
--   und protokolliert PFLICHTMÄSSIG (Protokollfehler → nichts gelöscht). Bereits entfernt → already = true, keine Änderung.
-- • Kein Service-Key, keine Bestätigung/Zusammenführung durch den Admin; nach dem Reset normal neu einladen.
-- Bereits live eingespielt (Migration registration_reset, 2026-09-29) — NICHT erneut ausführen.
-- ============================================================

CREATE OR REPLACE FUNCTION public._registration_reset_assessment(p_user_id uuid)
RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  u record; p profiles%ROWTYPE; o employee_onboarding%ROWTYPE; has_o boolean := false;
  r record; n bigint; blockers jsonb := '[]'::jsonb; refs jsonb := '{}'::jsonb; keeps jsonb := '{}'::jsonb;
  v_mode text; v_storage bigint := 0;
BEGIN
  SELECT id, email::text AS email, (email_confirmed_at IS NOT NULL) AS confirmed, (last_sign_in_at IS NOT NULL) AS signed_in
    INTO u FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('mode', 'gone', 'blockers', '[]'::jsonb); END IF;
  SELECT * INTO p FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    -- Auth-Konto ohne Profil: eigener, bereits vorhandener Weg (admin_remove_orphan_login, Migration 25)
    RETURN jsonb_build_object('mode', 'blocked', 'email', u.email, 'email_confirmed', u.confirmed, 'ever_signed_in', u.signed_in,
                              'blockers', jsonb_build_array(jsonb_build_object('code', 'orphan_login')));
  END IF;
  SELECT * INTO o FROM employee_onboarding WHERE profile_id = p_user_id;
  has_o := FOUND;

  IF p_user_id = auth.uid() THEN blockers := blockers || jsonb_build_object('code', 'self'); END IF;
  IF p.is_owner THEN blockers := blockers || jsonb_build_object('code', 'owner'); END IF;
  IF p.role NOT IN ('employee', 'manager') THEN blockers := blockers || jsonb_build_object('code', 'privileged_role'); END IF;

  IF p.employee_id IS NULL THEN
    v_mode := 'full';
    IF p.status NOT IN ('pending', 'disabled') THEN blockers := blockers || jsonb_build_object('code', 'active_account'); END IF;
    IF has_o THEN
      IF o.status NOT IN ('draft', 'rejected') THEN blockers := blockers || jsonb_build_object('code', 'onboarding_' || o.status); END IF;
      IF o.employee_id IS NOT NULL THEN blockers := blockers || jsonb_build_object('code', 'onboarding_employee_linked'); END IF;
      IF o.privacy_accepted_at IS NOT NULL THEN blockers := blockers || jsonb_build_object('code', 'privacy_proof'); END IF;
    END IF;
  ELSE
    v_mode := 'login_only';
    IF u.signed_in THEN blockers := blockers || jsonb_build_object('code', 'login_used'); END IF;
    IF has_o THEN blockers := blockers || jsonb_build_object('code', 'onboarding_history'); END IF;
    -- Nur zur Anzeige „bleibt erhalten“ – diese Daten hängen an employees.id und werden nie berührt
    SELECT jsonb_build_object(
      'time_entries',      (SELECT count(*) FROM time_entries      WHERE employee_id = p.employee_id),
      'breaks',            (SELECT count(*) FROM time_entry_breaks WHERE employee_id = p.employee_id),
      'time_corrections',  (SELECT count(*) FROM time_corrections  WHERE employee_id = p.employee_id),
      'shifts',            (SELECT count(*) FROM shifts            WHERE employee_id = p.employee_id),
      'vacation_requests', (SELECT count(*) FROM vacation_requests WHERE employee_id = p.employee_id),
      'sick_leave',        (SELECT count(*) FROM sick_leave        WHERE employee_id = p.employee_id),
      'payroll_months',    (SELECT count(*) FROM payroll_months    WHERE employee_id = p.employee_id),
      'payroll_documents', (SELECT count(*) FROM payroll_documents WHERE employee_id = p.employee_id),
      'employee_documents',(SELECT count(*) FROM employee_documents WHERE employee_id = p.employee_id))
      INTO keeps;
  END IF;

  -- Jede FK-Referenz auf dieses Konto außer den reinen Registrierungs-/Gerätedaten blockiert
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conrelid::regclass::text AS tname, a.attname::text AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
       AND c.confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)
       AND c.connamespace = 'public'::regnamespace
  LOOP
    CONTINUE WHEN (r.tname, r.col) IN (('profiles', 'id'), ('employee_onboarding', 'profile_id'),
                                        ('push_subscriptions', 'profile_id'), ('push_outbox', 'profile_id'));
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO n USING p_user_id;
    IF n > 0 THEN refs := refs || jsonb_build_object(r.tname || '.' || r.col, n); END IF;
  END LOOP;
  IF refs <> '{}'::jsonb THEN
    IF refs ? 'privacy_notice_acknowledgements.profile_id' THEN
      blockers := blockers || jsonb_build_object('code', 'privacy_proof');
    END IF;
    IF (refs - 'privacy_notice_acknowledgements.profile_id') <> '{}'::jsonb THEN
      blockers := blockers || jsonb_build_object('code', 'references', 'refs', refs - 'privacy_notice_acknowledgements.profile_id');
    END IF;
  END IF;
  -- Storage hat keinen FK (Objekte würden verwaisen); neuere Storage-Versionen setzen owner_id (text) statt/zusätzlich zu owner
  SELECT count(*) INTO v_storage FROM storage.objects WHERE owner = p_user_id OR owner_id = p_user_id::text;
  IF v_storage > 0 THEN blockers := blockers || jsonb_build_object('code', 'storage_objects', 'count', v_storage); END IF;

  RETURN jsonb_build_object(
    'mode', CASE WHEN jsonb_array_length(blockers) > 0 THEN 'blocked' ELSE v_mode END,
    'intended_mode', v_mode,
    'email', u.email, 'email_confirmed', u.confirmed, 'ever_signed_in', u.signed_in,
    'profile_status', p.status, 'onboarding_status', CASE WHEN has_o THEN o.status END,
    'employee_id', p.employee_id,
    'blockers', (SELECT COALESCE(jsonb_agg(DISTINCT b), '[]'::jsonb) FROM jsonb_array_elements(blockers) b),
    'deletes', jsonb_build_object('auth_user', 1, 'profile', 1, 'onboarding', CASE WHEN has_o THEN 1 ELSE 0 END,
                                  'push_subscriptions', (SELECT count(*) FROM push_subscriptions WHERE profile_id = p_user_id)),
    'keeps', keeps,
    'open_invitations', (SELECT count(*) FROM invitations i WHERE lower(trim(i.email)) = lower(trim(u.email))
                            AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()));
END $$;
REVOKE ALL ON FUNCTION public._registration_reset_assessment(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_registration_reset_check(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  RETURN _registration_reset_assessment(p_user_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_registration_reset_check(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_registration_reset_check(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reset_registration(p_user_id uuid, p_expected_email text, p_expected_mode text)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_locked uuid; a jsonb; v_mode text; v_email text; v_onb int; v_push int; v_actor text; v_role text;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_expected_mode NOT IN ('full', 'login_only') OR NULLIF(trim(COALESCE(p_expected_email, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Ungültige Anfrage.';
  END IF;
  -- Sperren in fester Reihenfolge (auth.users → profiles → onboarding): parallele Bestätigung, Onboarding-Speichern,
  -- Kenntnisnahme (FK-Sperre) und ein zweiter Reset warten bzw. sehen danach den neuen Zustand.
  SELECT id INTO v_locked FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Bereits entfernt (Doppelklick, zweiter Admin): nichts zu tun, nichts geändert
    RETURN jsonb_build_object('success', true, 'already', true,
      'email_registered_again', EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(trim(p_expected_email))));
  END IF;
  PERFORM 1 FROM profiles WHERE id = p_user_id FOR UPDATE;
  PERFORM 1 FROM employee_onboarding WHERE profile_id = p_user_id FOR UPDATE;

  a := _registration_reset_assessment(p_user_id);
  v_mode := a->>'mode'; v_email := a->>'email';
  IF lower(trim(v_email)) <> lower(trim(p_expected_email)) OR COALESCE(a->>'intended_mode', '') <> p_expected_mode THEN
    RAISE EXCEPTION 'Der Zustand dieses Kontos hat sich geändert. Bitte die Ansicht aktualisieren und erneut prüfen.';
  END IF;
  IF v_mode <> p_expected_mode THEN
    RAISE EXCEPTION 'Zurücksetzen nicht möglich: %', (SELECT string_agg(b->>'code', ', ') FROM jsonb_array_elements(a->'blockers') b);
  END IF;

  v_onb := (a->'deletes'->>'onboarding')::int;
  v_push := (a->'deletes'->>'push_subscriptions')::int;
  DELETE FROM auth.users WHERE id = p_user_id;   -- Profil, Onboarding-Entwurf, Push-Geräte folgen per ON DELETE CASCADE
  IF EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id) THEN RAISE EXCEPTION 'Zurücksetzen unvollständig.'; END IF;

  -- Pflichtprotokoll: schlägt es fehl, wird die gesamte Aktion zurückgerollt. Keine Tokens, keine Personalangaben.
  SELECT COALESCE(NULLIF(TRIM(CONCAT(x.first_name, ' ', x.last_name)), ''), x.email, 'Admin'), x.role
    INTO v_actor, v_role FROM profiles x WHERE x.id = auth.uid();
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name, metadata)
  VALUES (auth.uid(), COALESCE(v_actor, 'Admin'), v_role,
          CASE p_expected_mode WHEN 'full' THEN 'employee.registration_reset' ELSE 'employee.login_reset' END, 'employee',
          COALESCE(v_actor, 'Admin') || CASE p_expected_mode
            WHEN 'full' THEN ' hat die Registrierung ' || v_email || ' vollständig zurückgesetzt.'
            ELSE ' hat die unbenutzte Anmeldung ' || v_email || ' zurückgesetzt (Personalakte unverändert).' END,
          'auth_user', p_user_id::text, v_email,
          jsonb_build_object('mode', p_expected_mode, 'onboarding_status', a->>'onboarding_status',
                             'email_confirmed', (a->>'email_confirmed')::boolean,
                             'deleted', jsonb_build_object('auth_user', 1, 'profile', 1, 'onboarding', v_onb, 'push_subscriptions', v_push),
                             'employee_id', a->>'employee_id'));
  RETURN jsonb_build_object('success', true, 'already', false, 'mode', p_expected_mode, 'email', v_email);
END $$;
REVOKE ALL ON FUNCTION public.admin_reset_registration(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reset_registration(uuid, text, text) TO authenticated;
