-- ============================================================
-- Testvorlage: Invite/Auth/Onboarding-Funktionen exakt wie in Production (pg_get_functiondef, Stand 2026-09-28).
-- Nur Struktur/Logik, keine Daten. Wird von lifecycle.test.mjs NACH dem Anlegen der Grund-Personen geladen,
-- weil on_auth_user_created bei jedem neuen auth.users-Eintrag ein Profil anlegt.
-- ============================================================

CREATE OR REPLACE FUNCTION public._onb_log(p_action text, p_summary text, p_target_id text, p_target_name text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_name TEXT; v_role TEXT;
BEGIN
  SELECT COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role INTO v_name, v_role FROM profiles WHERE id = auth.uid();
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
  VALUES (auth.uid(), v_name, v_role, p_action, 'employee', v_name || ' ' || p_summary, 'onboarding', p_target_id, p_target_name);
EXCEPTION WHEN OTHERS THEN NULL;
END; $function$;

CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE inv RECORD; v_auth_email TEXT;
BEGIN
  SELECT * INTO inv FROM invitations
   WHERE token = p_token AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN
    RETURN '{"success":false,"error":"Ungültige, abgelaufene oder zurückgezogene Einladung."}'::json;
  END IF;
  IF inv.employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees WHERE id = inv.employee_id AND is_active) THEN
    RETURN '{"success":false,"error":"Diese Einladung wurde zurückgezogen."}'::json;
  END IF;
  SELECT email INTO v_auth_email FROM auth.users WHERE id = auth.uid();
  IF v_auth_email IS NULL OR LOWER(TRIM(v_auth_email)) <> LOWER(TRIM(inv.email)) THEN
    RETURN '{"success":false,"error":"Diese Einladung ist für eine andere E-Mail-Adresse bestimmt."}'::json;
  END IF;
  UPDATE invitations SET used_at = NOW()
   WHERE token = p_token AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN
    RETURN '{"success":false,"error":"Ungültige, abgelaufene oder zurückgezogene Einladung."}'::json;
  END IF;
  PERFORM set_config('app.bypass_privilege_trigger', 'on', true);
  IF inv.employee_id IS NULL THEN
    INSERT INTO profiles (id, email, role, status, employee_id)
    VALUES (auth.uid(), inv.email, 'employee', 'pending', NULL)
    ON CONFLICT (id) DO UPDATE SET status = 'pending', role = 'employee', employee_id = NULL
      WHERE profiles.employee_id IS NULL AND profiles.status IN ('pending');
    INSERT INTO employee_onboarding (profile_id, invitation_id, email, role)
    VALUES (auth.uid(), inv.id, LOWER(inv.email), inv.role)
    ON CONFLICT (profile_id) DO NOTHING;
    PERFORM set_config('app.bypass_privilege_trigger', '', true);
    RETURN '{"success":true,"onboarding":true}'::json;
  END IF;
  INSERT INTO profiles (id, email, role, status, employee_id, approved_at)
  VALUES (auth.uid(), inv.email, inv.role, 'approved', inv.employee_id, NOW())
  ON CONFLICT (id) DO UPDATE SET status = 'approved', role = inv.role, employee_id = inv.employee_id, approved_at = NOW();
  PERFORM set_config('app.bypass_privilege_trigger', '', true);
  RETURN '{"success":true,"onboarding":false}'::json;
END; $function$;

CREATE OR REPLACE FUNCTION public.approve_onboarding(p_id uuid, p_role text, p_position text, p_employment_type text, p_hours_per_week numeric, p_hourly_rate numeric, p_start_date date, p_vacation_days integer)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE o employee_onboarding%ROWTYPE; v_emp UUID;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF p_role NOT IN ('employee','manager','admin') THEN RETURN json_build_object('success', false, 'error', 'Ungültige Rolle.'); END IF;
  IF p_employment_type NOT IN ('vollzeit','teilzeit','werkstudent','minijob') THEN RETURN json_build_object('success', false, 'error', 'Bitte wähle eine Beschäftigungsart.'); END IF;
  IF p_hourly_rate IS NULL OR p_hourly_rate <= 0 THEN RETURN json_build_object('success', false, 'error', 'Bitte gib einen Stundenlohn an.'); END IF;
  IF p_start_date IS NULL THEN RETURN json_build_object('success', false, 'error', 'Bitte gib das Eintrittsdatum an.'); END IF;
  IF p_hours_per_week IS NULL OR p_hours_per_week <= 0 OR p_hours_per_week > 60 THEN RETURN json_build_object('success', false, 'error', 'Bitte prüfe die Wochenstunden.'); END IF;
  IF p_vacation_days IS NULL OR p_vacation_days < 0 OR p_vacation_days > 60 THEN RETURN json_build_object('success', false, 'error', 'Bitte prüfe den Urlaubsanspruch.'); END IF;
  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'submitted' THEN RETURN json_build_object('success', false, 'error', 'Diese Einreichung kann gerade nicht freigeschaltet werden.'); END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = o.profile_id AND employee_id IS NOT NULL) THEN RETURN json_build_object('success', false, 'error', 'Dieser Account ist bereits mit einem Mitarbeiter verknüpft.'); END IF;
  IF EXISTS (SELECT 1 FROM employees WHERE LOWER(email) = LOWER(o.email)) THEN RETURN json_build_object('success', false, 'error', 'Es gibt bereits einen Mitarbeiter mit dieser E-Mail-Adresse.'); END IF;
  INSERT INTO employees (first_name, last_name, email, phone, birth_date, address, position, employment_type, hours_per_week, hourly_rate, start_date, vacation_days_per_year, iban, is_active, avatar_initials, birth_name, birth_place, nationality, street, house_number, postal_code, city, account_holder, tax_id, social_security_number, health_insurance, other_employment, other_employment_note, emergency_contact_name, emergency_contact_phone, onboarding_completed_at)
  VALUES (o.first_name, o.last_name, LOWER(o.email), o.phone, o.birth_date, CONCAT(o.street,' ',o.house_number,', ',o.postal_code,' ',o.city), NULLIF(TRIM(COALESCE(p_position,'')),''), p_employment_type, p_hours_per_week, p_hourly_rate, p_start_date, p_vacation_days, o.iban, true, UPPER(LEFT(o.first_name,1) || LEFT(o.last_name,1)), o.birth_name, o.birth_place, o.nationality, o.street, o.house_number, o.postal_code, o.city, o.account_holder, o.tax_id, o.social_security_number, o.health_insurance, o.other_employment, o.other_employment_note, o.emergency_contact_name, o.emergency_contact_phone, NOW())
  RETURNING id INTO v_emp;
  UPDATE profiles SET status = 'approved', role = p_role, employee_id = v_emp, approved_at = NOW(), approved_by = auth.uid(), first_name = o.first_name, last_name = o.last_name WHERE id = o.profile_id;
  UPDATE employee_onboarding SET status = 'approved', employee_id = v_emp, reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW() WHERE id = p_id;
  PERFORM _onb_log('employee.approved', 'hat ' || CONCAT(o.first_name,' ',o.last_name) || ' freigeschaltet.', v_emp::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true, 'employee_id', v_emp);
END; $function$;

CREATE OR REPLACE FUNCTION public.check_email_registered(p_email text)
 RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE in_auth BOOLEAN; in_employees BOOLEAN;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT EXISTS(SELECT 1 FROM auth.users WHERE LOWER(email) = LOWER(TRIM(p_email))) INTO in_auth;
  SELECT EXISTS(SELECT 1 FROM employees WHERE LOWER(TRIM(email)) = LOWER(TRIM(p_email))) INTO in_employees;
  IF in_auth      THEN RETURN '{"exists": true, "reason": "auth"}'::json;     END IF;
  IF in_employees THEN RETURN '{"exists": true, "reason": "employee"}'::json; END IF;
  RETURN '{"exists": false, "reason": null}'::json;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_invitation_info(p_token text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE inv RECORD; emp RECORD;
BEGIN
  SELECT * INTO inv FROM invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN json_build_object('valid',false,'reason','not_found','error','Diese Einladung gibt es nicht. Bitte prüfe, ob du den vollständigen Link geöffnet hast.');
  END IF;
  IF inv.revoked_at IS NOT NULL THEN
    RETURN json_build_object('valid',false,'reason','revoked','error','Diese Einladung wurde zurückgezogen. Bitte wende dich an die Geschäftsführung des Café Buur.');
  END IF;
  IF inv.used_at IS NOT NULL THEN
    RETURN json_build_object('valid',false,'reason','used','error','Diese Einladung wurde bereits verwendet. Wenn das dein Account ist, melde dich einfach an.');
  END IF;
  IF inv.expires_at < NOW() THEN
    RETURN json_build_object('valid',false,'reason','expired','error','Diese Einladung ist abgelaufen (7 Tage gültig). Bitte lass dir einen neuen Link schicken.');
  END IF;
  IF inv.employee_id IS NULL THEN
    RETURN json_build_object('valid',true,'new_employee',true,'employee_name',NULL,'email',inv.email,'position','','role',inv.role,'expires_at',inv.expires_at);
  END IF;
  SELECT * INTO emp FROM employees WHERE id = inv.employee_id;
  IF NOT FOUND OR NOT COALESCE(emp.is_active, false) THEN
    RETURN json_build_object('valid',false,'reason','revoked','error','Diese Einladung wurde zurückgezogen. Bitte wende dich an die Geschäftsführung des Café Buur.');
  END IF;
  RETURN json_build_object('valid',true,'new_employee',false,'employee_name',emp.first_name||' '||emp.last_name,'email',inv.email,'position',COALESCE(emp.position,''),'role',inv.role,'expires_at',inv.expires_at);
END; $function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_token text := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'invite_token','')), '');
  inv     RECORD;
  emp     RECORD;
BEGIN
  IF v_token IS NOT NULL THEN
    BEGIN
      SELECT * INTO inv FROM invitations
       WHERE token = v_token AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
         AND LOWER(TRIM(email)) = LOWER(TRIM(NEW.email))
       FOR UPDATE;
      IF FOUND AND (inv.employee_id IS NULL
                    OR EXISTS (SELECT 1 FROM employees WHERE id = inv.employee_id AND is_active)) THEN
        UPDATE invitations SET used_at = NOW() WHERE id = inv.id;
        IF inv.employee_id IS NULL THEN
          INSERT INTO profiles (id, email, role, status)
          VALUES (NEW.id, LOWER(NEW.email), 'employee', 'pending')
          ON CONFLICT (id) DO NOTHING;
          INSERT INTO employee_onboarding (profile_id, invitation_id, email, role)
          VALUES (NEW.id, inv.id, LOWER(NEW.email), 'employee')
          ON CONFLICT (profile_id) DO NOTHING;
        ELSE
          SELECT first_name, last_name INTO emp FROM employees WHERE id = inv.employee_id;
          INSERT INTO profiles (id, email, role, status, employee_id, approved_at, approved_by, first_name, last_name)
          VALUES (NEW.id, LOWER(NEW.email), inv.role, 'approved', inv.employee_id, NOW(), inv.created_by, emp.first_name, emp.last_name)
          ON CONFLICT (id) DO NOTHING;
        END IF;
        RETURN NEW;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  INSERT INTO public.profiles (id, email, role, status, first_name, last_name)
  VALUES (NEW.id, NEW.email, 'employee', 'pending',
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name',  ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.onboarding_wipe_after_approval()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'approved' AND NEW.employee_id IS NOT NULL THEN
    NEW.birth_name := NULL; NEW.birth_date := NULL; NEW.birth_place := NULL; NEW.nationality := NULL;
    NEW.street := NULL; NEW.house_number := NULL; NEW.postal_code := NULL; NEW.city := NULL; NEW.phone := NULL;
    NEW.iban := NULL; NEW.account_holder := NULL; NEW.tax_id := NULL; NEW.social_security_number := NULL;
    NEW.health_insurance := NULL; NEW.other_employment := NULL; NEW.other_employment_note := NULL;
    NEW.emergency_contact_name := NULL; NEW.emergency_contact_phone := NULL;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.reject_onboarding(p_id uuid, p_note text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE o employee_onboarding%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status IN ('approved','rejected') THEN
    RETURN json_build_object('success', false, 'error', 'Diese Registrierung kann nicht mehr abgebrochen werden.');
  END IF;
  UPDATE employee_onboarding SET
     status = 'rejected',
     review_note = NULLIF(TRIM(COALESCE(p_note,'')),''),
     reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW(),
     birth_name = NULL, birth_date = NULL, birth_place = NULL, nationality = NULL,
     street = NULL, house_number = NULL, postal_code = NULL, city = NULL, phone = NULL,
     iban = NULL, account_holder = NULL, tax_id = NULL, social_security_number = NULL,
     health_insurance = NULL, other_employment = NULL, other_employment_note = NULL,
     emergency_contact_name = NULL, emergency_contact_phone = NULL
   WHERE id = p_id;
  UPDATE profiles SET status = 'disabled' WHERE id = o.profile_id AND employee_id IS NULL;
  PERFORM _onb_log('employee.onboarding_rejected',
    'hat die Registrierung von ' || COALESCE(NULLIF(TRIM(CONCAT(o.first_name,' ',o.last_name)),''), o.email) || ' abgelehnt.',
    o.id::TEXT, COALESCE(NULLIF(TRIM(CONCAT(o.first_name,' ',o.last_name)),''), o.email));
  RETURN json_build_object('success', true);
END; $function$;

CREATE OR REPLACE FUNCTION public.revoke_invitation(p_id uuid)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE inv invitations%ROWTYPE; v_name text;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT * INTO inv FROM invitations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Einladung nicht gefunden.');
  END IF;
  IF inv.revoked_at IS NOT NULL THEN
    RETURN json_build_object('success', true, 'already', true);
  END IF;
  IF inv.used_at IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error',
      'Diese Einladung wurde bereits benutzt – der Account existiert schon. Neue Mitarbeiter bitte unter „Neue Mitarbeiter“ ablehnen, bestehende Accounts unter „Aktive Benutzer“ entfernen.');
  END IF;
  UPDATE invitations SET revoked_at = NOW(), revoked_by = auth.uid() WHERE id = p_id;
  SELECT CONCAT(first_name,' ',last_name) INTO v_name FROM employees WHERE id = inv.employee_id;
  PERFORM _onb_log('employee.invitation_revoked',
    'hat die Einladung für ' || COALESCE(NULLIF(TRIM(v_name),''), inv.email) || ' zurückgezogen.',
    inv.id::text, COALESCE(NULLIF(TRIM(v_name),''), inv.email));
  RETURN json_build_object('success', true);
END; $function$;

CREATE OR REPLACE FUNCTION public.save_onboarding(p_data jsonb, p_submit boolean DEFAULT false)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  o employee_onboarding%ROWTYPE;
  v_iban TEXT; v_tax TEXT; v_sv TEXT; v_plz TEXT; v_birth DATE; f TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RETURN json_build_object('success', false, 'error', 'Nicht angemeldet.'); END IF;
  SELECT * INTO o FROM employee_onboarding WHERE profile_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Für diesen Account gibt es keine Einladung. Bitte wende dich an dein Management.'); END IF;
  IF o.status NOT IN ('draft','changes_requested') THEN RETURN json_build_object('success', false, 'error', 'Deine Angaben wurden bereits eingereicht und können gerade nicht geändert werden.'); END IF;
  v_iban := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'iban',''), '\s', '', 'g')), '');
  v_tax  := NULLIF(REGEXP_REPLACE(COALESCE(p_data->>'tax_id',''), '\s', '', 'g'), '');
  v_sv   := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'social_security_number',''), '\s', '', 'g')), '');
  v_plz  := NULLIF(TRIM(COALESCE(p_data->>'postal_code','')), '');
  BEGIN v_birth := NULLIF(p_data->>'birth_date','')::DATE;
  EXCEPTION WHEN OTHERS THEN RETURN json_build_object('success', false, 'error', 'Das Geburtsdatum ist ungültig.', 'field', 'birth_date'); END;
  UPDATE employee_onboarding SET
    first_name = NULLIF(TRIM(COALESCE(p_data->>'first_name','')), ''),
    last_name = NULLIF(TRIM(COALESCE(p_data->>'last_name','')), ''),
    birth_name = NULLIF(TRIM(COALESCE(p_data->>'birth_name','')), ''),
    birth_date = v_birth,
    birth_place = NULLIF(TRIM(COALESCE(p_data->>'birth_place','')), ''),
    nationality = NULLIF(TRIM(COALESCE(p_data->>'nationality','')), ''),
    street = NULLIF(TRIM(COALESCE(p_data->>'street','')), ''),
    house_number = NULLIF(TRIM(COALESCE(p_data->>'house_number','')), ''),
    postal_code = v_plz,
    city = NULLIF(TRIM(COALESCE(p_data->>'city','')), ''),
    phone = NULLIF(TRIM(COALESCE(p_data->>'phone','')), ''),
    iban = v_iban,
    account_holder = NULLIF(TRIM(COALESCE(p_data->>'account_holder','')), ''),
    tax_id = v_tax,
    social_security_number = v_sv,
    health_insurance = NULLIF(TRIM(COALESCE(p_data->>'health_insurance','')), ''),
    other_employment = CASE WHEN p_data ? 'other_employment' AND p_data->>'other_employment' IS NOT NULL THEN (p_data->>'other_employment')::BOOLEAN ELSE NULL END,
    other_employment_note = NULLIF(TRIM(COALESCE(p_data->>'other_employment_note','')), ''),
    emergency_contact_name = NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_name','')), ''),
    emergency_contact_phone = NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_phone','')), ''),
    updated_at = NOW()
  WHERE id = o.id RETURNING * INTO o;
  IF NOT p_submit THEN RETURN json_build_object('success', true, 'status', o.status); END IF;
  FOREACH f IN ARRAY ARRAY['first_name','last_name','street','house_number','postal_code','city','phone','iban','account_holder','tax_id','social_security_number','health_insurance','emergency_contact_name','emergency_contact_phone'] LOOP
    IF (to_jsonb(o) ->> f) IS NULL THEN RETURN json_build_object('success', false, 'error', 'Bitte fülle alle Pflichtfelder aus.', 'field', f); END IF;
  END LOOP;
  IF o.birth_date IS NULL THEN RETURN json_build_object('success', false, 'error', 'Bitte gib dein Geburtsdatum an.', 'field', 'birth_date'); END IF;
  IF o.birth_date > (CURRENT_DATE - INTERVAL '14 years') OR o.birth_date < (CURRENT_DATE - INTERVAL '100 years') THEN RETURN json_build_object('success', false, 'error', 'Bitte prüfe dein Geburtsdatum.', 'field', 'birth_date'); END IF;
  IF o.other_employment IS NULL THEN RETURN json_build_object('success', false, 'error', 'Bitte gib an, ob du noch eine weitere Beschäftigung hast.', 'field', 'other_employment'); END IF;
  IF o.postal_code !~ '^[0-9]{5}$' THEN RETURN json_build_object('success', false, 'error', 'Die Postleitzahl muss 5 Ziffern haben.', 'field', 'postal_code'); END IF;
  IF o.iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' OR (o.iban LIKE 'DE%' AND LENGTH(o.iban) <> 22) THEN RETURN json_build_object('success', false, 'error', 'Die IBAN ist ungültig.', 'field', 'iban'); END IF;
  IF o.tax_id !~ '^[0-9]{11}$' THEN RETURN json_build_object('success', false, 'error', 'Die Steuer-ID besteht aus 11 Ziffern.', 'field', 'tax_id'); END IF;
  IF o.social_security_number !~ '^[0-9]{8}[A-Z][0-9]{3}$' THEN RETURN json_build_object('success', false, 'error', 'Die Sozialversicherungsnummer hat das Format 12 345678 A 123.', 'field', 'social_security_number'); END IF;
  IF NOT COALESCE((p_data->>'privacy_accepted')::BOOLEAN, false) THEN RETURN json_build_object('success', false, 'error', 'Bitte bestätige den Datenschutzhinweis.', 'field', 'privacy_accepted'); END IF;
  UPDATE employee_onboarding SET status = 'submitted', submitted_at = NOW(), privacy_accepted_at = NOW(), updated_at = NOW() WHERE id = o.id;
  UPDATE profiles SET first_name = o.first_name, last_name = o.last_name WHERE id = auth.uid();
  PERFORM _onb_log('employee.onboarding_submitted', 'hat die Personalangaben zur Prüfung eingereicht.', o.id::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true, 'status', 'submitted');
END; $function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._onb_log(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.onboarding_wipe_after_approval() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_email_registered(text) FROM anon;

DROP TRIGGER IF EXISTS trg_onboarding_wipe_after_approval ON public.employee_onboarding;
CREATE TRIGGER trg_onboarding_wipe_after_approval BEFORE UPDATE ON public.employee_onboarding FOR EACH ROW EXECUTE FUNCTION onboarding_wipe_after_approval();
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
