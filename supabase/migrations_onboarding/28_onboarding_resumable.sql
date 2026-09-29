-- ============================================================
-- 28 · Onboarding fortsetzbar, idempotent, konfliktsicher (additiv, keine Datenänderung)
-- Grundlage: Audit 2026-09-29 (Production-Definitionen gelesen, Fälle lokal nachgestellt).
-- • Registrierung ohne stillen Fallback: handle_new_user fing im Einladungszweig JEDEN Fehler ab
--   (EXCEPTION WHEN OTHERS THEN NULL) und legte dann ein normales „wartendes“ Profil OHNE Onboarding an – auch wenn
--   die Einladung zwischen Öffnen der Seite und Absenden abgelaufen/zurückgezogen war. Folge: Client meldete Erfolg,
--   die Person sah dauerhaft „wartet auf Freischaltung“, obwohl nichts zur Prüfung vorlag (nur der Admin konnte
--   helfen). Jetzt: Wer MIT Einladungs-Token registriert, bekommt entweder den vollständigen Einladungsweg
--   (Einladung eingelöst + Profil + Onboarding-Entwurf bzw. freigeschaltetes Profil) oder gar nichts – der Fehler
--   bricht das Anlegen des Auth-Kontos ab (nichts bleibt zurück, erneuter Versuch mit neuem Link möglich).
--   Registrierung OHNE Token: unverändert.
-- • Keine stillen Überschreibungen: employee_onboarding.revision zählt jede Änderung (Trigger, auch Admin-Aktionen).
--   save_onboarding nimmt optional p_expected_revision; passt sie nicht, wird NICHTS geschrieben (conflict) –
--   vorher überschrieb ein veralteter Tab/ein zweites Gerät die Angaben des anderen mit leeren Feldern.
--   Außerdem Patch-Semantik: nur mitgesendete Felder werden geändert (ein Schritt kann nur seine Felder ändern).
-- • Einreichen idempotent: erneutes Einreichen (z. B. Antwort ging verloren) liefert Erfolg mit already = true
--   statt eines Fehlers. Die mitgesendeten Daten werden dabei NICHT übernommen (eingereicht ist eingereicht).
-- • Server prüft beim Einreichen wie der Client: Beschreibung bei weiterer Beschäftigung, Telefonformat,
--   IBAN-Prüfsumme (ISO 13616, mod 97). Entwürfe bleiben ungeprüft speicherbar.
-- Rückwärtskompatibel: Der bisherige Client ruft save_onboarding(p_data, p_submit) mit allen Feldern auf →
-- identisches Ergebnis (keine Revisionsprüfung ohne p_expected_revision). Deploy-Reihenfolge: erst diese Migration,
-- dann das Frontend. Rückweg: Funktionen aus fixtures/lifecycle_functions.sql wiederherstellen; die Spalte revision
-- und der Trigger können bleiben (stören den alten Stand nicht).
-- Bereits live eingespielt (Migration onboarding_resumable, 2026-09-29) — NICHT erneut ausführen.
-- ============================================================

-- ── Revision: jede Änderung am Onboarding zählt hoch ─────────
ALTER TABLE public.employee_onboarding ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.onboarding_bump_revision()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $function$;
REVOKE EXECUTE ON FUNCTION public.onboarding_bump_revision() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_onboarding_revision ON public.employee_onboarding;
CREATE TRIGGER trg_onboarding_revision BEFORE UPDATE ON public.employee_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_bump_revision();

-- ── IBAN-Prüfsumme (identisch mit isValidIBAN in src/lib/personalData.js) ──
CREATE OR REPLACE FUNCTION public._iban_checksum_ok(p_iban text)
 RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE s text; d text; r int := 0; i int; j int;
BEGIN
  IF p_iban IS NULL OR p_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN RETURN false; END IF;
  s := substr(p_iban, 5) || substr(p_iban, 1, 4);
  FOR i IN 1..length(s) LOOP
    d := substr(s, i, 1);
    IF d ~ '[A-Z]' THEN d := (ascii(d) - 55)::text; END IF;
    FOR j IN 1..length(d) LOOP r := (r * 10 + substr(d, j, 1)::int) % 97; END LOOP;
  END LOOP;
  RETURN r = 1;
END $function$;
REVOKE EXECUTE ON FUNCTION public._iban_checksum_ok(text) FROM PUBLIC, anon, authenticated;

-- ── Registrierung: Einladungsweg ganz oder gar nicht ─────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token text := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'invite_token','')), '');
  inv     RECORD;
  emp     RECORD;
BEGIN
  IF v_token IS NOT NULL THEN
    SELECT * INTO inv FROM invitations WHERE token = v_token FOR UPDATE;
    IF NOT FOUND OR inv.revoked_at IS NOT NULL OR inv.used_at IS NOT NULL OR inv.expires_at <= NOW()
       OR LOWER(TRIM(inv.email)) <> LOWER(TRIM(NEW.email))
       OR (inv.employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees WHERE id = inv.employee_id AND is_active)) THEN
      -- Kein Konto ohne passenden Einladungsweg (sonst „wartendes“ Konto ohne Onboarding = Sackgasse)
      RAISE EXCEPTION 'Die Einladung ist nicht mehr gültig (abgelaufen, zurückgezogen oder bereits verwendet).'
        USING ERRCODE = 'P0001', HINT = 'invite_invalid';
    END IF;
    UPDATE invitations SET used_at = NOW() WHERE id = inv.id;
    IF inv.employee_id IS NULL THEN
      INSERT INTO profiles (id, email, role, status)
      VALUES (NEW.id, LOWER(NEW.email), 'employee', 'pending');
      INSERT INTO employee_onboarding (profile_id, invitation_id, email, role)
      VALUES (NEW.id, inv.id, LOWER(NEW.email), 'employee');
    ELSE
      SELECT first_name, last_name INTO emp FROM employees WHERE id = inv.employee_id;
      INSERT INTO profiles (id, email, role, status, employee_id, approved_at, approved_by, first_name, last_name)
      VALUES (NEW.id, LOWER(NEW.email), inv.role, 'approved', inv.employee_id, NOW(), inv.created_by, emp.first_name, emp.last_name);
    END IF;
    RETURN NEW;
  END IF;
  -- Registrierung ohne Einladung: unverändert (wartendes Profil, Admin entscheidet)
  INSERT INTO public.profiles (id, email, role, status, first_name, last_name)
  VALUES (NEW.id, NEW.email, 'employee', 'pending',
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name',  ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $function$;

-- ── Onboarding speichern/einreichen ──────────────────────────
-- Neue Signatur (optionaler dritter Parameter) → alte Variante entfernen, sonst wäre der Aufruf mit zwei Namen
-- für PostgREST mehrdeutig. Läuft in einer Transaktion: zu keinem Zeitpunkt fehlt die Funktion.
DROP FUNCTION IF EXISTS public.save_onboarding(jsonb, boolean);

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
  FOREACH f IN ARRAY ARRAY['first_name','last_name','street','house_number','postal_code','city','phone','iban','account_holder','tax_id','social_security_number','health_insurance','emergency_contact_name','emergency_contact_phone'] LOOP
    IF (to_jsonb(o) ->> f) IS NULL THEN v_err := 'Bitte fülle alle Pflichtfelder aus.'; v_field := f; EXIT; END IF;
  END LOOP;
  IF v_err IS NULL THEN
    IF o.birth_date IS NULL THEN v_err := 'Bitte gib dein Geburtsdatum an.'; v_field := 'birth_date';
    ELSIF o.birth_date > (CURRENT_DATE - INTERVAL '14 years') OR o.birth_date < (CURRENT_DATE - INTERVAL '100 years') THEN v_err := 'Bitte prüfe dein Geburtsdatum.'; v_field := 'birth_date';
    ELSIF o.other_employment IS NULL THEN v_err := 'Bitte gib an, ob du noch eine weitere Beschäftigung hast.'; v_field := 'other_employment';
    ELSIF o.other_employment AND o.other_employment_note IS NULL THEN v_err := 'Bitte beschreibe kurz deine weitere Beschäftigung.'; v_field := 'other_employment_note';
    ELSIF o.postal_code !~ '^[0-9]{5}$' THEN v_err := 'Die Postleitzahl muss 5 Ziffern haben.'; v_field := 'postal_code';
    ELSIF o.phone !~ '^[-+0-9 ()/]{6,}$' THEN v_err := 'Bitte prüfe die Telefonnummer.'; v_field := 'phone';
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
