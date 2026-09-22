-- ============================================================
-- Café Buur · Update v6 — Einladungssystem
-- ============================================================

-- ── Einladungen-Tabelle ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  token        TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'employee',
  expires_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_at      TIMESTAMP WITH TIME ZONE,
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inv_admin"    ON invitations;
DROP POLICY IF EXISTS "inv_read_own" ON invitations;
CREATE POLICY "inv_admin"    ON invitations FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "inv_read_own" ON invitations FOR SELECT TO authenticated USING (created_by = auth.uid());

-- ── Öffentliche Funktion: Einladungs-Info lesen (ohne Auth!) ─
CREATE OR REPLACE FUNCTION get_invitation_info(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv RECORD;
  emp RECORD;
BEGIN
  SELECT * INTO inv FROM invitations WHERE token = p_token;
  IF NOT FOUND        THEN RETURN '{"valid":false,"error":"Einladung nicht gefunden. Bitte den Administrator kontaktieren."}'::json; END IF;
  IF inv.used_at IS NOT NULL THEN RETURN '{"valid":false,"error":"Diese Einladung wurde bereits verwendet. Bitte anmelden."}'::json; END IF;
  IF inv.expires_at < NOW()  THEN RETURN '{"valid":false,"error":"Diese Einladung ist abgelaufen (7 Tage). Bitte einen neuen Link beim Administrator anfordern."}'::json; END IF;
  SELECT * INTO emp FROM employees WHERE id = inv.employee_id;
  RETURN json_build_object(
    'valid',         true,
    'employee_name', emp.first_name || ' ' || emp.last_name,
    'email',         inv.email,
    'position',      COALESCE(emp.position, ''),
    'role',          inv.role,
    'expires_at',    inv.expires_at
  );
END;
$$;

-- ── Authentifizierte Funktion: Einladung annehmen ───────────
CREATE OR REPLACE FUNCTION accept_invitation(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT * INTO inv FROM invitations
  WHERE token = p_token AND used_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN RETURN '{"success":false,"error":"Ungültige oder abgelaufene Einladung."}'::json; END IF;

  -- Profil erstellen oder aktualisieren (UPSERT)
  INSERT INTO profiles (id, email, role, status, employee_id, approved_at)
  VALUES (auth.uid(), inv.email, inv.role, 'approved', inv.employee_id, NOW())
  ON CONFLICT (id) DO UPDATE SET
    status = 'approved', role = inv.role,
    employee_id = inv.employee_id, approved_at = NOW();

  -- Einladung als benutzt markieren
  UPDATE invitations SET used_at = NOW() WHERE token = p_token;
  RETURN '{"success":true}'::json;
END;
$$;

SELECT 'Einladungssystem installiert ✅' AS status;
-- ============================================================
