-- ============================================================
-- Café Buur · Update v5 — Auth Fix
-- ============================================================

-- 1. Sicherstellen dass prof_self policy korrekt ist
DROP POLICY IF EXISTS "prof_self" ON profiles;
CREATE POLICY "prof_self" ON profiles 
  FOR SELECT TO authenticated USING (id = auth.uid());

-- 2. Funktion: E-Mail prüfen (für Passwort-Reset-Validation)
CREATE OR REPLACE FUNCTION check_email_registered(p_email TEXT)
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM auth.users 
    WHERE email = LOWER(TRIM(p_email))
  )
$$;

-- 3. Admin-Status nochmal sicher setzen
UPDATE profiles 
SET role = 'admin', status = 'approved', approved_at = NOW()
WHERE email = 'can_apple97@icloud.com';

-- 4. Test: Alles korrekt?
SELECT email, role, status FROM profiles;
-- ============================================================
