-- Mitarbeiter pflegt eigene Personaldaten ("Meine Daten").
-- Nur der verknüpfte Mitarbeiter-Datensatz des eingeloggten Users.
-- NIE änderbar: Name, E-Mail, Stundenlohn, Position, Beschäftigungsart, Stunden, Urlaub, Eintritt, aktiv.
CREATE OR REPLACE FUNCTION public.update_own_personal_data(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp   uuid;
  e       employees%ROWTYPE;
  n       employees%ROWTYPE;
  v_birth date;
  v_iban  text; v_tax text; v_sv text; v_plz text;
  v_other boolean;
  v_changed text[] := ARRAY[]::text[];
  v_name  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht angemeldet.');
  END IF;
  SELECT employee_id INTO v_emp FROM profiles WHERE id = auth.uid() AND status = 'approved';
  IF v_emp IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Mitarbeiter-Profil verknüpft.');
  END IF;
  SELECT * INTO e FROM employees WHERE id = v_emp FOR UPDATE;

  v_iban := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'iban',''), '\s', '', 'g')), '');
  v_tax  := NULLIF(REGEXP_REPLACE(COALESCE(p_data->>'tax_id',''), '\s', '', 'g'), '');
  v_sv   := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'social_security_number',''), '\s', '', 'g')), '');
  v_plz  := NULLIF(TRIM(COALESCE(p_data->>'postal_code','')), '');
  BEGIN
    v_birth := NULLIF(p_data->>'birth_date','')::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'Das Geburtsdatum ist ungültig.', 'field', 'birth_date');
  END;
  BEGIN
    v_other := CASE WHEN p_data->>'other_employment' IS NULL THEN NULL ELSE (p_data->>'other_employment')::boolean END;
  EXCEPTION WHEN OTHERS THEN
    v_other := NULL;
  END;

  -- Formatprüfungen (leere Felder sind erlaubt)
  IF v_birth IS NOT NULL AND (v_birth > CURRENT_DATE - INTERVAL '14 years' OR v_birth < CURRENT_DATE - INTERVAL '100 years') THEN
    RETURN json_build_object('success', false, 'error', 'Bitte prüfe dein Geburtsdatum.', 'field', 'birth_date');
  END IF;
  IF v_plz IS NOT NULL AND v_plz !~ '^[0-9]{5}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Postleitzahl muss 5 Ziffern haben.', 'field', 'postal_code');
  END IF;
  IF v_iban IS NOT NULL AND (v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' OR (v_iban LIKE 'DE%' AND LENGTH(v_iban) <> 22)) THEN
    RETURN json_build_object('success', false, 'error', 'Die IBAN ist ungültig.', 'field', 'iban');
  END IF;
  IF v_tax IS NOT NULL AND v_tax !~ '^[0-9]{11}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Steuer-ID besteht aus 11 Ziffern.', 'field', 'tax_id');
  END IF;
  IF v_sv IS NOT NULL AND v_sv !~ '^[0-9]{8}[A-Z][0-9]{3}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Sozialversicherungsnummer hat das Format 12 345678 A 123.', 'field', 'social_security_number');
  END IF;

  UPDATE employees SET
    birth_name = CASE WHEN p_data ? 'birth_name' THEN NULLIF(TRIM(COALESCE(p_data->>'birth_name','')), '') ELSE birth_name END,
    birth_date = CASE WHEN p_data ? 'birth_date' THEN v_birth ELSE birth_date END,
    birth_place = CASE WHEN p_data ? 'birth_place' THEN NULLIF(TRIM(COALESCE(p_data->>'birth_place','')), '') ELSE birth_place END,
    nationality = CASE WHEN p_data ? 'nationality' THEN NULLIF(TRIM(COALESCE(p_data->>'nationality','')), '') ELSE nationality END,
    street = CASE WHEN p_data ? 'street' THEN NULLIF(TRIM(COALESCE(p_data->>'street','')), '') ELSE street END,
    house_number = CASE WHEN p_data ? 'house_number' THEN NULLIF(TRIM(COALESCE(p_data->>'house_number','')), '') ELSE house_number END,
    postal_code = CASE WHEN p_data ? 'postal_code' THEN v_plz ELSE postal_code END,
    city = CASE WHEN p_data ? 'city' THEN NULLIF(TRIM(COALESCE(p_data->>'city','')), '') ELSE city END,
    phone = CASE WHEN p_data ? 'phone' THEN NULLIF(TRIM(COALESCE(p_data->>'phone','')), '') ELSE phone END,
    iban = CASE WHEN p_data ? 'iban' THEN v_iban ELSE iban END,
    account_holder = CASE WHEN p_data ? 'account_holder' THEN NULLIF(TRIM(COALESCE(p_data->>'account_holder','')), '') ELSE account_holder END,
    tax_id = CASE WHEN p_data ? 'tax_id' THEN v_tax ELSE tax_id END,
    social_security_number = CASE WHEN p_data ? 'social_security_number' THEN v_sv ELSE social_security_number END,
    health_insurance = CASE WHEN p_data ? 'health_insurance' THEN NULLIF(TRIM(COALESCE(p_data->>'health_insurance','')), '') ELSE health_insurance END,
    other_employment = CASE WHEN p_data ? 'other_employment' THEN v_other ELSE other_employment END,
    other_employment_note = CASE WHEN p_data ? 'other_employment_note' THEN CASE WHEN v_other THEN NULLIF(TRIM(COALESCE(p_data->>'other_employment_note','')), '') ELSE NULL END ELSE other_employment_note END,
    emergency_contact_name = CASE WHEN p_data ? 'emergency_contact_name' THEN NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_name','')), '') ELSE emergency_contact_name END,
    emergency_contact_phone = CASE WHEN p_data ? 'emergency_contact_phone' THEN NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_phone','')), '') ELSE emergency_contact_phone END
  WHERE id = v_emp
  RETURNING * INTO n;

  -- Zusammengesetzte Adresse (wird z. B. in Übersichten genutzt) nur aktualisieren,
  -- wenn die Einzelfelder vollständig sind — sonst alte Angabe behalten.
  IF n.street IS NOT NULL AND n.house_number IS NOT NULL AND n.postal_code IS NOT NULL AND n.city IS NOT NULL THEN
    UPDATE employees SET address = CONCAT(n.street,' ',n.house_number,', ',n.postal_code,' ',n.city) WHERE id = v_emp;
  END IF;

  -- Protokoll: welche Felder geändert wurden (ohne Werte)
  IF e.iban IS DISTINCT FROM n.iban THEN v_changed := array_append(v_changed, 'Bankverbindung'::text); END IF;
  IF e.account_holder IS DISTINCT FROM n.account_holder AND NOT ('Bankverbindung' = ANY(v_changed)) THEN v_changed := array_append(v_changed, 'Bankverbindung'::text); END IF;
  IF e.tax_id IS DISTINCT FROM n.tax_id THEN v_changed := array_append(v_changed, 'Steuer-ID'::text); END IF;
  IF e.social_security_number IS DISTINCT FROM n.social_security_number THEN v_changed := array_append(v_changed, 'SV-Nummer'::text); END IF;
  IF e.health_insurance IS DISTINCT FROM n.health_insurance THEN v_changed := array_append(v_changed, 'Krankenkasse'::text); END IF;
  IF e.other_employment IS DISTINCT FROM n.other_employment OR e.other_employment_note IS DISTINCT FROM n.other_employment_note THEN v_changed := array_append(v_changed, 'weitere Beschäftigung'::text); END IF;
  IF (e.street, e.house_number, e.postal_code, e.city) IS DISTINCT FROM (n.street, n.house_number, n.postal_code, n.city) THEN v_changed := array_append(v_changed, 'Adresse'::text); END IF;
  IF e.phone IS DISTINCT FROM n.phone THEN v_changed := array_append(v_changed, 'Telefon'::text); END IF;
  IF (e.birth_date, e.birth_name, e.birth_place, e.nationality) IS DISTINCT FROM (n.birth_date, n.birth_name, n.birth_place, n.nationality) THEN v_changed := array_append(v_changed, 'Geburtsangaben'::text); END IF;
  IF (e.emergency_contact_name, e.emergency_contact_phone) IS DISTINCT FROM (n.emergency_contact_name, n.emergency_contact_phone) THEN v_changed := array_append(v_changed, 'Notfallkontakt'::text); END IF;

  IF array_length(v_changed, 1) > 0 THEN
    v_name := CONCAT(n.first_name,' ',n.last_name);
    PERFORM _onb_log('employee.personal_data_updated',
      'hat eigene Personaldaten geändert: ' || array_to_string(v_changed, ', ') || '.',
      v_emp::text, v_name);
  END IF;

  RETURN json_build_object('success', true, 'changed', to_json(v_changed));
END;
$function$;

REVOKE ALL ON FUNCTION public.update_own_personal_data(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_own_personal_data(jsonb) TO authenticated;

-- ── check_email_registered: nur noch für Admins (Einladen), nicht mehr öffentlich ──
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
REVOKE EXECUTE ON FUNCTION public.check_email_registered(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_email_registered(text) TO authenticated;
