-- ============================================================
-- Café Buur · Neue Registrierung: Einladung → Selbst-Onboarding → Admin-Freigabe
-- Stand: 23.09.2026
--
-- Was diese Migration macht (nur additiv, bestehende Daten bleiben unverändert):
--   1. employees: neue Spalten für Personalstammdaten (Adresse, Steuer-ID, SV-Nr. …)
--   2. invitations.employee_id darf leer sein (Einladung ohne vorher angelegten Mitarbeiter)
--   3. Neue Tabelle employee_onboarding (Entwurf/Einreichung des Mitarbeiters)
--      RLS: nur lesen (eigener Eintrag bzw. Manager/Admin). Schreiben NUR über RPCs.
--   4. RPCs: save_onboarding, request_onboarding_changes, approve_onboarding, reject_onboarding
--   5. accept_invitation / get_invitation_info: unterstützen Einladungen ohne Mitarbeiter
--      (alter Weg mit vorhandenem Mitarbeiter bleibt unverändert erhalten)
--
-- Idempotent: kann gefahrlos mehrfach ausgeführt werden.
-- Rollback: Tabelle employee_onboarding + neue Funktionen löschen; neue Spalten sind nullable.
-- ============================================================

-- ── 1. employees: neue Stammdaten-Spalten ─────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS birth_name               TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS birth_place              TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS nationality              TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS street                   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS house_number             TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS postal_code              TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS city                     TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS account_holder           TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tax_id                   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS social_security_number   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS health_insurance         TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS other_employment         BOOLEAN;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS other_employment_note    TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_name   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_phone  TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS onboarding_completed_at  TIMESTAMPTZ;

-- ── 2. Einladung ohne vorher angelegten Mitarbeiter erlauben ──
ALTER TABLE invitations ALTER COLUMN employee_id DROP NOT NULL;

-- ── 3. Tabelle employee_onboarding ────────────────────────────
CREATE TABLE IF NOT EXISTS employee_onboarding (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  invitation_id            UUID REFERENCES invitations(id) ON DELETE SET NULL,
  email                    TEXT NOT NULL,
  role                     TEXT NOT NULL DEFAULT 'employee',
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','submitted','changes_requested','approved','rejected')),
  -- Persönliches
  first_name               TEXT,
  last_name                TEXT,
  birth_name               TEXT,
  birth_date               DATE,
  birth_place              TEXT,
  nationality              TEXT,
  -- Kontakt
  street                   TEXT,
  house_number             TEXT,
  postal_code              TEXT,
  city                     TEXT,
  phone                    TEXT,
  -- Bank
  iban                     TEXT,
  account_holder           TEXT,
  -- Lohn / Sozialversicherung
  tax_id                   TEXT,
  social_security_number   TEXT,
  health_insurance         TEXT,
  other_employment         BOOLEAN,
  other_employment_note    TEXT,
  -- Notfall
  emergency_contact_name   TEXT,
  emergency_contact_phone  TEXT,
  -- Ablauf
  privacy_accepted_at      TIMESTAMPTZ,
  submitted_at             TIMESTAMPTZ,
  review_note              TEXT,
  reviewed_by              UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at              TIMESTAMPTZ,
  employee_id              UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_status ON employee_onboarding(status);

ALTER TABLE employee_onboarding ENABLE ROW LEVEL SECURITY;

-- Lesen: eigener Eintrag ODER freigeschalteter Manager/Admin
DROP POLICY IF EXISTS "onb_select_own"   ON employee_onboarding;
DROP POLICY IF EXISTS "onb_select_staff" ON employee_onboarding;
CREATE POLICY "onb_select_own" ON employee_onboarding
  FOR SELECT TO authenticated USING (profile_id = auth.uid());
CREATE POLICY "onb_select_staff" ON employee_onboarding
  FOR SELECT TO authenticated USING (is_manager_or_admin());
-- Bewusst KEINE INSERT/UPDATE/DELETE-Policy: Schreiben nur über die RPCs unten.
REVOKE INSERT, UPDATE, DELETE ON employee_onboarding FROM anon, authenticated;

-- ── Hilfsfunktion: serverseitiger Protokolleintrag ───────────
CREATE OR REPLACE FUNCTION _onb_log(p_action TEXT, p_summary TEXT, p_target_id TEXT, p_target_name TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name TEXT; v_role TEXT;
BEGIN
  SELECT COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role
    INTO v_name, v_role FROM profiles WHERE id = auth.uid();
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
  VALUES (auth.uid(), v_name, v_role, p_action, 'employee', v_name || ' ' || p_summary, 'onboarding', p_target_id, p_target_name);
EXCEPTION WHEN OTHERS THEN
  NULL; -- Protokoll darf die eigentliche Aktion nie verhindern
END;
$$;
REVOKE ALL ON FUNCTION _onb_log(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;

-- ── 4a. save_onboarding: Mitarbeiter speichert Entwurf / reicht ein ─
-- Nur der Eigentümer, nur solange Status 'draft' oder 'changes_requested'.
-- Nur freigegebene Felder werden übernommen (Whitelist).
CREATE OR REPLACE FUNCTION save_onboarding(p_data JSONB, p_submit BOOLEAN DEFAULT false)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o   employee_onboarding%ROWTYPE;
  v_iban TEXT; v_tax TEXT; v_sv TEXT; v_plz TEXT; v_birth DATE;
  f   TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht angemeldet.');
  END IF;

  SELECT * INTO o FROM employee_onboarding WHERE profile_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Für diesen Account gibt es keine Einladung. Bitte wende dich an dein Management.');
  END IF;
  IF o.status NOT IN ('draft','changes_requested') THEN
    RETURN json_build_object('success', false, 'error', 'Deine Angaben wurden bereits eingereicht und können gerade nicht geändert werden.');
  END IF;

  -- Normalisieren
  v_iban  := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'iban',''), '\s', '', 'g')), '');
  v_tax   := NULLIF(REGEXP_REPLACE(COALESCE(p_data->>'tax_id',''), '\s', '', 'g'), '');
  v_sv    := NULLIF(UPPER(REGEXP_REPLACE(COALESCE(p_data->>'social_security_number',''), '\s', '', 'g')), '');
  v_plz   := NULLIF(TRIM(COALESCE(p_data->>'postal_code','')), '');
  BEGIN
    v_birth := NULLIF(p_data->>'birth_date','')::DATE;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'Das Geburtsdatum ist ungültig.', 'field', 'birth_date');
  END;

  UPDATE employee_onboarding SET
    first_name              = NULLIF(TRIM(COALESCE(p_data->>'first_name','')), ''),
    last_name               = NULLIF(TRIM(COALESCE(p_data->>'last_name','')), ''),
    birth_name              = NULLIF(TRIM(COALESCE(p_data->>'birth_name','')), ''),
    birth_date              = v_birth,
    birth_place             = NULLIF(TRIM(COALESCE(p_data->>'birth_place','')), ''),
    nationality             = NULLIF(TRIM(COALESCE(p_data->>'nationality','')), ''),
    street                  = NULLIF(TRIM(COALESCE(p_data->>'street','')), ''),
    house_number            = NULLIF(TRIM(COALESCE(p_data->>'house_number','')), ''),
    postal_code             = v_plz,
    city                    = NULLIF(TRIM(COALESCE(p_data->>'city','')), ''),
    phone                   = NULLIF(TRIM(COALESCE(p_data->>'phone','')), ''),
    iban                    = v_iban,
    account_holder          = NULLIF(TRIM(COALESCE(p_data->>'account_holder','')), ''),
    tax_id                  = v_tax,
    social_security_number  = v_sv,
    health_insurance        = NULLIF(TRIM(COALESCE(p_data->>'health_insurance','')), ''),
    other_employment        = CASE WHEN p_data ? 'other_employment' AND p_data->>'other_employment' IS NOT NULL
                                   THEN (p_data->>'other_employment')::BOOLEAN ELSE NULL END,
    other_employment_note   = NULLIF(TRIM(COALESCE(p_data->>'other_employment_note','')), ''),
    emergency_contact_name  = NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_name','')), ''),
    emergency_contact_phone = NULLIF(TRIM(COALESCE(p_data->>'emergency_contact_phone','')), ''),
    updated_at              = NOW()
  WHERE id = o.id
  RETURNING * INTO o;

  IF NOT p_submit THEN
    RETURN json_build_object('success', true, 'status', o.status);
  END IF;

  -- ── Prüfung vor dem Einreichen (serverseitig, nicht umgehbar) ──
  FOREACH f IN ARRAY ARRAY['first_name','last_name','street','house_number','postal_code','city','phone',
                           'iban','account_holder','tax_id','social_security_number','health_insurance',
                           'emergency_contact_name','emergency_contact_phone'] LOOP
    IF (to_jsonb(o) ->> f) IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Bitte fülle alle Pflichtfelder aus.', 'field', f);
    END IF;
  END LOOP;
  IF o.birth_date IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib dein Geburtsdatum an.', 'field', 'birth_date');
  END IF;
  IF o.birth_date > (CURRENT_DATE - INTERVAL '14 years') OR o.birth_date < (CURRENT_DATE - INTERVAL '100 years') THEN
    RETURN json_build_object('success', false, 'error', 'Bitte prüfe dein Geburtsdatum.', 'field', 'birth_date');
  END IF;
  IF o.other_employment IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib an, ob du noch eine weitere Beschäftigung hast.', 'field', 'other_employment');
  END IF;
  IF o.postal_code !~ '^[0-9]{5}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Postleitzahl muss 5 Ziffern haben.', 'field', 'postal_code');
  END IF;
  IF o.iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' OR (o.iban LIKE 'DE%' AND LENGTH(o.iban) <> 22) THEN
    RETURN json_build_object('success', false, 'error', 'Die IBAN ist ungültig.', 'field', 'iban');
  END IF;
  IF o.tax_id !~ '^[0-9]{11}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Steuer-ID besteht aus 11 Ziffern.', 'field', 'tax_id');
  END IF;
  IF o.social_security_number !~ '^[0-9]{8}[A-Z][0-9]{3}$' THEN
    RETURN json_build_object('success', false, 'error', 'Die Sozialversicherungsnummer hat das Format 12 345678 A 123.', 'field', 'social_security_number');
  END IF;
  IF NOT COALESCE((p_data->>'privacy_accepted')::BOOLEAN, false) THEN
    RETURN json_build_object('success', false, 'error', 'Bitte bestätige den Datenschutzhinweis.', 'field', 'privacy_accepted');
  END IF;

  UPDATE employee_onboarding
     SET status = 'submitted', submitted_at = NOW(), privacy_accepted_at = NOW(), updated_at = NOW()
   WHERE id = o.id;

  -- Namen auch ins Profil übernehmen (nur Namensfelder; Rolle/Status schützt der Trigger)
  UPDATE profiles SET first_name = o.first_name, last_name = o.last_name WHERE id = auth.uid();

  PERFORM _onb_log('employee.onboarding_submitted', 'hat die Personalangaben zur Prüfung eingereicht.', o.id::TEXT,
                   CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true, 'status', 'submitted');
END;
$$;
REVOKE ALL ON FUNCTION save_onboarding(JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_onboarding(JSONB, BOOLEAN) TO authenticated;

-- ── 4b. request_onboarding_changes: Admin schickt zur Korrektur zurück ─
CREATE OR REPLACE FUNCTION request_onboarding_changes(p_id UUID, p_note TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o employee_onboarding%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  IF NULLIF(TRIM(COALESCE(p_note,'')),'') IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Bitte schreibe kurz, was korrigiert werden soll.');
  END IF;
  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'submitted' THEN
    RETURN json_build_object('success', false, 'error', 'Diese Einreichung kann gerade nicht zurückgeschickt werden.');
  END IF;
  UPDATE employee_onboarding
     SET status = 'changes_requested', review_note = TRIM(p_note), reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW()
   WHERE id = p_id;
  PERFORM _onb_log('employee.onboarding_changes_requested', 'hat Korrekturen an den Angaben von ' || CONCAT(o.first_name,' ',o.last_name) || ' angefordert.',
                   o.id::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION request_onboarding_changes(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_onboarding_changes(UUID, TEXT) TO authenticated;

-- ── 4c. approve_onboarding: Admin legt Mitarbeiter an + schaltet frei (atomar) ─
CREATE OR REPLACE FUNCTION approve_onboarding(
  p_id                UUID,
  p_role              TEXT,
  p_position          TEXT,
  p_employment_type   TEXT,
  p_hours_per_week    NUMERIC,
  p_hourly_rate       NUMERIC,
  p_start_date        DATE,
  p_vacation_days     INTEGER
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o     employee_onboarding%ROWTYPE;
  v_emp UUID;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;

  IF p_role NOT IN ('employee','manager','admin') THEN
    RETURN json_build_object('success', false, 'error', 'Ungültige Rolle.');
  END IF;
  IF p_employment_type NOT IN ('vollzeit','teilzeit','werkstudent','minijob') THEN
    RETURN json_build_object('success', false, 'error', 'Bitte wähle eine Beschäftigungsart.');
  END IF;
  IF p_hourly_rate IS NULL OR p_hourly_rate <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib einen Stundenlohn an.');
  END IF;
  IF p_start_date IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Bitte gib das Eintrittsdatum an.');
  END IF;
  IF p_hours_per_week IS NULL OR p_hours_per_week <= 0 OR p_hours_per_week > 60 THEN
    RETURN json_build_object('success', false, 'error', 'Bitte prüfe die Wochenstunden.');
  END IF;
  IF p_vacation_days IS NULL OR p_vacation_days < 0 OR p_vacation_days > 60 THEN
    RETURN json_build_object('success', false, 'error', 'Bitte prüfe den Urlaubsanspruch.');
  END IF;

  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'submitted' THEN
    RETURN json_build_object('success', false, 'error', 'Diese Einreichung kann gerade nicht freigeschaltet werden.');
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = o.profile_id AND employee_id IS NOT NULL) THEN
    RETURN json_build_object('success', false, 'error', 'Dieser Account ist bereits mit einem Mitarbeiter verknüpft.');
  END IF;
  IF EXISTS (SELECT 1 FROM employees WHERE LOWER(email) = LOWER(o.email)) THEN
    RETURN json_build_object('success', false, 'error', 'Es gibt bereits einen Mitarbeiter mit dieser E-Mail-Adresse.');
  END IF;

  INSERT INTO employees (
    first_name, last_name, email, phone, birth_date, address,
    position, employment_type, hours_per_week, hourly_rate, start_date, vacation_days_per_year,
    iban, is_active, avatar_initials,
    birth_name, birth_place, nationality, street, house_number, postal_code, city,
    account_holder, tax_id, social_security_number, health_insurance,
    other_employment, other_employment_note, emergency_contact_name, emergency_contact_phone,
    onboarding_completed_at
  ) VALUES (
    o.first_name, o.last_name, LOWER(o.email), o.phone, o.birth_date,
    CONCAT(o.street,' ',o.house_number,', ',o.postal_code,' ',o.city),
    NULLIF(TRIM(COALESCE(p_position,'')),''), p_employment_type, p_hours_per_week, p_hourly_rate, p_start_date, p_vacation_days,
    o.iban, true, UPPER(LEFT(o.first_name,1) || LEFT(o.last_name,1)),
    o.birth_name, o.birth_place, o.nationality, o.street, o.house_number, o.postal_code, o.city,
    o.account_holder, o.tax_id, o.social_security_number, o.health_insurance,
    o.other_employment, o.other_employment_note, o.emergency_contact_name, o.emergency_contact_phone,
    NOW()
  ) RETURNING id INTO v_emp;

  -- is_admin() ist wahr → Schutz-Trigger auf profiles lässt die Rollenänderung zu
  UPDATE profiles
     SET status = 'approved', role = p_role, employee_id = v_emp,
         approved_at = NOW(), approved_by = auth.uid(),
         first_name = o.first_name, last_name = o.last_name
   WHERE id = o.profile_id;

  UPDATE employee_onboarding
     SET status = 'approved', employee_id = v_emp, reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW()
   WHERE id = p_id;

  PERFORM _onb_log('employee.approved', 'hat ' || CONCAT(o.first_name,' ',o.last_name) || ' freigeschaltet.',
                   v_emp::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true, 'employee_id', v_emp);
END;
$$;
REVOKE ALL ON FUNCTION approve_onboarding(UUID,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,DATE,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_onboarding(UUID,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,DATE,INTEGER) TO authenticated;

-- ── 4d. reject_onboarding: Admin lehnt ab → Account gesperrt ─
CREATE OR REPLACE FUNCTION reject_onboarding(p_id UUID, p_note TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o employee_onboarding%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Nicht autorisiert.'; END IF;
  SELECT * INTO o FROM employee_onboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status IN ('approved','rejected') THEN
    RETURN json_build_object('success', false, 'error', 'Diese Einreichung kann nicht abgelehnt werden.');
  END IF;
  UPDATE employee_onboarding
     SET status = 'rejected', review_note = NULLIF(TRIM(COALESCE(p_note,'')),''), reviewed_by = auth.uid(), reviewed_at = NOW(), updated_at = NOW()
   WHERE id = p_id;
  UPDATE profiles SET status = 'disabled' WHERE id = o.profile_id AND employee_id IS NULL;
  PERFORM _onb_log('employee.onboarding_rejected', 'hat die Registrierung von ' || COALESCE(NULLIF(TRIM(CONCAT(o.first_name,' ',o.last_name)),''), o.email) || ' abgelehnt.',
                   o.id::TEXT, CONCAT(o.first_name,' ',o.last_name));
  RETURN json_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION reject_onboarding(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_onboarding(UUID, TEXT) TO authenticated;

-- ── 5a. get_invitation_info: auch Einladungen ohne Mitarbeiter ─
CREATE OR REPLACE FUNCTION get_invitation_info(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv RECORD; emp RECORD;
BEGIN
  SELECT * INTO inv FROM invitations WHERE token = p_token;
  IF NOT FOUND        THEN RETURN '{"valid":false,"error":"Einladung nicht gefunden."}'::json; END IF;
  IF inv.used_at IS NOT NULL THEN RETURN '{"valid":false,"error":"Diese Einladung wurde bereits verwendet."}'::json; END IF;
  IF inv.expires_at < NOW()  THEN RETURN '{"valid":false,"error":"Diese Einladung ist abgelaufen (7 Tage)."}'::json; END IF;
  IF inv.employee_id IS NULL THEN
    RETURN json_build_object('valid',true,'new_employee',true,'employee_name',NULL,
      'email',inv.email,'position','','role',inv.role,'expires_at',inv.expires_at);
  END IF;
  SELECT * INTO emp FROM employees WHERE id = inv.employee_id;
  RETURN json_build_object('valid',true,'new_employee',false,'employee_name',emp.first_name||' '||emp.last_name,
    'email',inv.email,'position',COALESCE(emp.position,''),'role',inv.role,'expires_at',inv.expires_at);
END;
$$;

-- ── 5b. accept_invitation: neuer Weg (ohne Mitarbeiter) → Onboarding-Entwurf ─
CREATE OR REPLACE FUNCTION accept_invitation(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv RECORD;
  v_auth_email TEXT;
BEGIN
  SELECT * INTO inv FROM invitations
   WHERE token = p_token AND used_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN
    RETURN '{"success":false,"error":"Ungültige oder abgelaufene Einladung."}'::json;
  END IF;

  SELECT email INTO v_auth_email FROM auth.users WHERE id = auth.uid();
  IF v_auth_email IS NULL OR LOWER(TRIM(v_auth_email)) <> LOWER(TRIM(inv.email)) THEN
    RETURN '{"success":false,"error":"Diese Einladung ist für eine andere E-Mail-Adresse bestimmt."}'::json;
  END IF;

  -- Atomar: nur ein Aufrufer kann used_at setzen
  UPDATE invitations SET used_at = NOW()
   WHERE token = p_token AND used_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN
    RETURN '{"success":false,"error":"Ungültige oder abgelaufene Einladung."}'::json;
  END IF;

  PERFORM set_config('app.bypass_privilege_trigger', 'on', true);

  IF inv.employee_id IS NULL THEN
    -- Neuer Weg: Account bleibt 'pending', bis der Admin die Angaben freigibt
    INSERT INTO profiles (id, email, role, status, employee_id)
    VALUES (auth.uid(), inv.email, 'employee', 'pending', NULL)
    ON CONFLICT (id) DO UPDATE SET status = 'pending', role = 'employee', employee_id = NULL
      WHERE profiles.employee_id IS NULL AND profiles.status IN ('pending');
    INSERT INTO employee_onboarding (profile_id, invitation_id, email, role)
    VALUES (auth.uid(), inv.id, LOWER(inv.email), inv.role)
    ON CONFLICT (profile_id) DO NOTHING;
    PERFORM set_config('app.bypass_privilege_trigger', '', true);  -- Freigabe sofort wieder schließen
    RETURN '{"success":true,"onboarding":true}'::json;
  END IF;

  -- Alter Weg: Mitarbeiter existiert schon → direkt freischalten (unverändert)
  INSERT INTO profiles (id, email, role, status, employee_id, approved_at)
  VALUES (auth.uid(), inv.email, inv.role, 'approved', inv.employee_id, NOW())
  ON CONFLICT (id) DO UPDATE SET status = 'approved', role = inv.role, employee_id = inv.employee_id, approved_at = NOW();

  PERFORM set_config('app.bypass_privilege_trigger', '', true);  -- Freigabe sofort wieder schließen
  RETURN '{"success":true,"onboarding":false}'::json;
END;
$$;

SELECT 'migration_onboarding angewendet ✅' AS status;
