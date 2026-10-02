-- ============================================================
-- 32 · Onboarding: Notfallkontakt freiwillig (additiv, keine Datenänderung)
-- • save_onboarding verlangte beim Einreichen Name UND Telefon des Notfallkontakts (Migration 28) – der Client zeigt
--   ihn jetzt als „optional“. Ohne diese Migration würde der Server trotz „optional“ mit „Bitte fülle alle
--   Pflichtfelder aus.“ ablehnen. Neu: beide leer → ok; beide gefüllt → ok (Telefonformat wie bisher geprüft);
--   nur eines gefüllt → Fehler am fehlenden Feld (kein unbrauchbarer Halb-Datensatz).
-- • Eigene Telefonnummer: Pflicht wie bisher, Format wie bisher, zusätzlich höchstens 50 Zeichen – employees.phone ist
--   varchar(50); längere Eingaben ließen sonst erst die Freischaltung durch den Admin scheitern.
-- • Alles andere ist byte-gleich mit Migration 28 (live geprüft: md5(prosrc) der Production-Funktion =
--   dd01e74d7a92416f8ea911ea270bc8b0 = lokaler Stand nach Migration 28, 2026-10-02).
-- Keine Spalten, Constraints, Policies oder Daten geändert. Bestehende Onboardings (13, alle freigegeben) und
-- Mitarbeiter (mit/ohne Notfallkontakt) bleiben unverändert. Signatur unverändert → kein Client-Bruch.
-- Deploy-Reihenfolge: ZUERST diese Migration, DANN das Frontend (der neue Client sendet ggf. leere Notfallkontakt-
-- Felder; der alte Server würde das Einreichen ablehnen). Alter Client + neue Migration: unverändert lauffähig
-- (er verlangt den Notfallkontakt weiterhin selbst).
-- Rückweg: Funktionsdefinition aus 28_onboarding_resumable.sql erneut einspielen (nur CREATE OR REPLACE dieser
-- einen Funktion); Daten sind nicht betroffen.
-- Wiederholt ausführbar (CREATE OR REPLACE).
-- Bereits live eingespielt (Migration onboarding_emergency_optional, 2026-10-02; md5(prosrc) = b51d917c599c45a7982c2751f2ed29e9)
-- — NICHT erneut ausführen.
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_onboarding(p_data jsonb, p_submit boolean DEFAULT false, p_expected_revision integer DEFAULT NULL)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o employee_onboarding%ROWTYPE;
  v_birth DATE; v_other BOOLEAN; f TEXT; v_err TEXT; v_field TEXT;
  -- Feld übernehmen, wenn mitgesendet; sonst gespeicherten Wert behalten (Patch-Semantik)
  has CONSTANT jsonb := COALESCE(p_data, '{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL THEN RETURN json_build_object('success', false, 'error', 'Nicht angemeldet.'); END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN RETURN json_build_object('success', false, 'error', 'Ungültige Angaben.'); END IF;
  SELECT * INTO o FROM employee_onboarding WHERE profile_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Für diesen Account gibt es keine Einladung. Bitte wende dich an dein Management.'); END IF;
  -- Idempotent: bereits eingereicht → Erfolg melden (z. B. erste Antwort verloren); Daten werden nicht übernommen
  IF p_submit AND o.status = 'submitted' THEN
    RETURN json_build_object('success', true, 'status', 'submitted', 'already', true, 'revision', o.revision);
  END IF;
  IF o.status NOT IN ('draft','changes_requested') THEN
    RETURN json_build_object('success', false, 'error', 'Deine Angaben wurden bereits eingereicht und können gerade nicht geändert werden.', 'status', o.status, 'revision', o.revision);
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> o.revision THEN
    RETURN json_build_object('success', false, 'conflict', true, 'status', o.status, 'revision', o.revision,
      'error', 'Deine Angaben wurden inzwischen in einem anderen Fenster oder auf einem anderen Gerät geändert. Es wurde nichts überschrieben – bitte lade die Seite neu.');
  END IF;

  IF has ? 'birth_date' THEN
    BEGIN v_birth := NULLIF(p_data->>'birth_date','')::DATE;
    EXCEPTION WHEN OTHERS THEN RETURN json_build_object('success', false, 'error', 'Das Geburtsdatum ist ungültig.', 'field', 'birth_date', 'revision', o.revision); END;
  ELSE v_birth := o.birth_date; END IF;
  IF has ? 'other_employment' THEN
    BEGIN v_other := (p_data->>'other_employment')::BOOLEAN;
    EXCEPTION WHEN OTHERS THEN RETURN json_build_object('success', false, 'error', 'Bitte gib an, ob du noch eine weitere Beschäftigung hast.', 'field', 'other_employment', 'revision', o.revision); END;
  ELSE v_other := o.other_employment; END IF;

  UPDATE employee_onboarding SET
    first_name   = CASE WHEN has ? 'first_name'   THEN NULLIF(TRIM(COALESCE(p_data->>'first_name','')), '')   ELSE first_name END,
    last_name    = CASE WHEN has ? 'last_name'    THEN NULLIF(TRIM(COALESCE(p_data->>'last_name','')), '')    ELSE last_name END,
    birth_name   = CASE WHEN has ? 'birth_name'   THEN NULLIF(TRIM(COALESCE(p_data->>'birth_name','')), '')   ELSE birth_name END,
    birth_date   = v_birth,
    birth_place  = CASE WHEN has ? 'birth_place'  THEN NULLIF(TRIM(COALESCE(p_data->>'birth_place','')), '')  ELSE birth_place END,
    nationality  = CASE WHEN has ? 'nationality'  THEN NULLIF(TRIM(COALESCE(p_data->>'nationality','')), '')  ELSE nationality END,
    street       = CASE WHEN has ? 'street'       THEN NULLIF(TRIM(COALESCE(p_data->>'street','')), '')       ELSE street END,
    house_number = CASE WHEN has ? 'house_number' THEN NULLIF(TRIM(COALESCE(p_data->>'house_number','')), '') ELSE house_number END,
    postal_code  = CASE WHEN has ? 'postal_code'  THEN NULLIF(TRIM(COALESCE(p_data->>'postal_code','')), '')  ELSE postal_code END,
    city         = CASE WHEN has ? 'city'         THEN NULLIF(TRIM(COALESCE(p_data->>'city','')), '')         ELSE city END,
    phone        = CASE WHEN has ? 'phone'        THEN NULLIF(TRIM(COALESCE(p_data->>'phone','')), '')        ELSE phone END,
    iban         = CASE WHEN has ? 'iban'         THEN NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'iban',''), '\s', '', 'g')), '') ELSE iban END,
    account_holder = CASE WHEN has ? 'account_holder' THEN NULLIF(TRIM(COALESCE(p_data->>'account_holder','')), '') ELSE account_holder END,
    tax_id       = CASE WHEN has ? 'tax_id'       THEN NULLIF(REGEXP_REPLACE(COALESCE(p_data->>'tax_id',''), '\s', '', 'g'), '') ELSE tax_id END,
    social_security_number = CASE WHEN has ? 'social_security_number' THEN NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'social_security_number',''), '\s', '', 'g')), '') ELSE social_security_number END,
    health_insurance = CASE WHEN has ? 'health_insurance' THEN NULLIF(TRIM(COALESCE(p_data->>'health_insurance','')), '') ELSE health_insurance END,
    other_employment = v_other,
    -- Beschreibung nur bei weiterer Beschäftigung (sonst entfernt – auch bei Teiländerung)
    other_employment_note = CASE WHEN v_other IS TRUE
      THEN CASE WHEN has ? 'other_employment_note' THEN NULLIF(TRIM(COALESCE(p_data->>'other_employment_note','')), '') ELSE other_employment_note END
      ELSE NULL END,
    emergency_contact_name  = CASE WHEN has ? 'emergency_contact_name'  THEN NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_name','')), '')  ELSE emergency_contact_name END,
    emergency_contact_phone = CASE WHEN has ? 'emergency_contact_phone' THEN NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_phone','')), '') ELSE emergency_contact_phone END,
    updated_at = NOW()
  WHERE id = o.id RETURNING * INTO o;
  IF NOT p_submit THEN RETURN json_build_object('success', true, 'status', o.status, 'revision', o.revision); END IF;

  -- Einreichen: vollständige Prüfung (Angaben bleiben als Entwurf gespeichert, auch wenn etwas fehlt)
  FOREACH f IN ARRAY ARRAY['first_name','last_name','street','house_number','postal_code','city','phone','iban','account_holder','tax_id','social_security_number','health_insurance'] LOOP
    IF (to_jsonb(o) ->> f) IS NULL THEN v_err := 'Bitte fülle alle Pflichtfelder aus.'; v_field := f; EXIT; END IF;
  END LOOP;
  IF v_err IS NULL THEN
    IF o.birth_date IS NULL THEN v_err := 'Bitte gib dein Geburtsdatum an.'; v_field := 'birth_date';
    ELSIF o.birth_date > (CURRENT_DATE - INTERVAL '14 years') OR o.birth_date < (CURRENT_DATE - INTERVAL '100 years') THEN v_err := 'Bitte prüfe dein Geburtsdatum.'; v_field := 'birth_date';
    ELSIF o.other_employment IS NULL THEN v_err := 'Bitte gib an, ob du noch eine weitere Beschäftigung hast.'; v_field := 'other_employment';
    ELSIF o.other_employment AND o.other_employment_note IS NULL THEN v_err := 'Bitte beschreibe kurz deine weitere Beschäftigung.'; v_field := 'other_employment_note';
    ELSIF o.postal_code !~ '^[0-9]{5}$' THEN v_err := 'Die Postleitzahl muss 5 Ziffern haben.'; v_field := 'postal_code';
    ELSIF o.phone !~ '^[-+0-9 ()/]{6,}$' OR LENGTH(o.phone) > 50 THEN v_err := 'Bitte prüfe die Telefonnummer.'; v_field := 'phone';
    -- Notfallkontakt freiwillig, aber nur vollständig (Name UND Telefon) oder gar nicht
    ELSIF o.emergency_contact_name IS NULL AND o.emergency_contact_phone IS NOT NULL THEN v_err := 'Bitte gib den Namen des Notfallkontakts an – oder lass beide Felder leer.'; v_field := 'emergency_contact_name';
    ELSIF o.emergency_contact_name IS NOT NULL AND o.emergency_contact_phone IS NULL THEN v_err := 'Bitte gib die Telefonnummer des Notfallkontakts an – oder lass beide Felder leer.'; v_field := 'emergency_contact_phone';
    ELSIF o.emergency_contact_phone !~ '^[-+0-9 ()/]{6,}$' THEN v_err := 'Bitte prüfe die Telefonnummer des Notfallkontakts.'; v_field := 'emergency_contact_phone';
    ELSIF o.iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' OR (o.iban LIKE 'DE%' AND LENGTH(o.iban) <> 22) OR NOT _iban_checksum_ok(o.iban) THEN v_err := 'Die IBAN ist ungültig.'; v_field := 'iban';
    ELSIF o.tax_id !~ '^[0-9]{11}$' THEN v_err := 'Die Steuer-ID besteht aus 11 Ziffern.'; v_field := 'tax_id';
    ELSIF o.social_security_number !~ '^[0-9]{8}[A-Z][0-9]{3}$' THEN v_err := 'Die Sozialversicherungsnummer hat das Format 12 345678 A 123.'; v_field := 'social_security_number';
    ELSIF NOT COALESCE((p_data->>'privacy_accepted')::BOOLEAN, false) THEN v_err := 'Bitte bestätige den Datenschutzhinweis.'; v_field := 'privacy_accepted';
    END IF;
  END IF;
  -- revision mitgeben: der Entwurf wurde gespeichert, der Client bleibt damit synchron
  IF v_err IS NOT NULL THEN RETURN json_build_object('success', false, 'error', v_err, 'field', v_field, 'status', o.status, 'revision', o.revision); END IF;

  UPDATE employee_onboarding SET status = 'submitted', submitted_at = NOW(), privacy_accepted_at = NOW(), updated_at = NOW()
   WHERE id = o.id RETURNING * INTO o;
  UPDATE profiles SET first_name = o.first_name, last_name = o.last_name WHERE id = auth.uid();
  PERFORM _onb_log('employee.onboarding_submitted', 'hat die Personalangaben zur Prüfung eingereicht.', o.id::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true, 'status', 'submitted', 'revision', o.revision);
END; $function$;

REVOKE ALL ON FUNCTION public.save_onboarding(jsonb, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_onboarding(jsonb, boolean, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
