-- Onboarding Teil 2: Einladung wird schon beim Anlegen des Auth-Users eingelöst.
-- Grund: E-Mail-Bestätigung ist aktiv → signUp() liefert KEINE Session,
-- accept_invitation() (braucht auth.uid()) konnte deshalb nie laufen.
-- Lösung: Der Einladungs-Token wird beim signUp als Metadaten mitgeschickt
-- und hier serverseitig geprüft (Token gültig + E-Mail passt exakt).
-- Ohne gültigen Token: Verhalten wie bisher (Profil 'pending').
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_token text := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'invite_token','')), '');
  inv     RECORD;
BEGIN
  IF v_token IS NOT NULL THEN
    BEGIN
      SELECT * INTO inv FROM invitations
       WHERE token = v_token
         AND used_at IS NULL
         AND expires_at > NOW()
         AND LOWER(TRIM(email)) = LOWER(TRIM(NEW.email))
       FOR UPDATE;
      IF FOUND THEN
        UPDATE invitations SET used_at = NOW() WHERE id = inv.id;
        IF inv.employee_id IS NULL THEN
          -- Neuer Mitarbeiter: Profil wartet, Onboarding-Entwurf wird angelegt
          INSERT INTO profiles (id, email, role, status)
          VALUES (NEW.id, LOWER(NEW.email), 'employee', 'pending')
          ON CONFLICT (id) DO NOTHING;
          INSERT INTO employee_onboarding (profile_id, invitation_id, email, role)
          VALUES (NEW.id, inv.id, LOWER(NEW.email), 'employee')
          ON CONFLICT (profile_id) DO NOTHING;
        ELSE
          -- Bestehender Mitarbeiter-Datensatz (alter Weg): direkt verknüpfen
          INSERT INTO profiles (id, email, role, status, employee_id, approved_at)
          VALUES (NEW.id, LOWER(NEW.email), inv.role, 'approved', inv.employee_id, NOW())
          ON CONFLICT (id) DO NOTHING;
        END IF;
        RETURN NEW;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Niemals die Registrierung abbrechen – Einladung bleibt dann ungenutzt,
      -- der User landet unten als normales 'pending'-Profil.
      NULL;
    END;
  END IF;

  INSERT INTO public.profiles (id, email, role, status, first_name, last_name)
  VALUES (
    NEW.id, NEW.email, 'employee', 'pending',
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name',  '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
