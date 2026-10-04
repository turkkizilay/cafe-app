-- ============================================================
-- 38 · Zugang zurücksetzen durch den Admin (temporäres Passwort + Pflicht zur Passwortänderung)
-- Ablauf (Edge Function „admin-reset-access“, Service-Schlüssel nur dort):
--   1. admin_begin_access_reset(employee_id, erwartete Generation) – mit dem JWT des Admins: Admin live geprüft,
--      Ziel serverseitig aus employee_id abgeleitet (nie aus dem Client), Pflicht zur Passwortänderung gesetzt,
--      Generation +1, bestehende Sitzungen beendet, Sperre gegen parallele Resets (60 s).
--   2. Edge Function setzt per Auth Admin API (updateUserById) ein zufälliges Passwort – nicht gespeichert.
--   3. service_access_reset_finish(): beendet erneut alle Sitzungen (auch die in der Zwischenzeit mit dem alten
--      Passwort begonnenen), gibt die Sperre frei, protokolliert. Nur service_role.
-- Passwortänderung (Edge Function „complete-password-change“): Auth-Endpunkt PUT /user mit dem JWT der Person,
-- erst danach service_complete_password_change() → Pflicht gelöscht. Die Person selbst kann die Pflicht NIE löschen.
--
-- Durchsetzung serverseitig, nicht nur im Browser:
--   • access_gate() als PostgREST-Pre-Request (pgrst.db_pre_request): blockiert JEDE Data-API-Anfrage (Tabellen,
--     Views, RPCs) einer Person mit Pflicht zur Passwortänderung – außer rpc/my_access_state – und jede Anfrage
--     aus einer beendeten Sitzung (Access-Token bleibt laut Supabase bis exp gültig; hier wird er abgewiesen).
--   • Storage nutzt PostgREST nicht → zusätzliche RESTRICTIVE-Policy auf storage.objects (gleiche Prüfung).
--   • Realtime: keine Tabelle in der Publikation (geprüft) – sonst müsste die Prüfung auch dort in die Policies.
-- Unberührt: Mitarbeiter, Auth-Verknüpfung, Personalnummer, Zeiten, Pausen, Urlaub, Krankheit, Dokumente, Lohn,
-- DATEV, Onboarding, Registrierungs-Reset (Migration 26). Keine Datenänderung an Bestandszeilen.
-- Rückbau: ALTER ROLE authenticator RESET pgrst.db_pre_request; NOTIFY pgrst, 'reload config';
--          DROP POLICY access_gate_restrictive ON storage.objects;
-- ============================================================

CREATE TABLE IF NOT EXISTS public.account_security (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  must_change_password    boolean NOT NULL DEFAULT false,
  reset_generation        integer NOT NULL DEFAULT 0 CHECK (reset_generation >= 0),
  sessions_valid_after    timestamptz,     -- Sitzungen, die vorher begonnen haben (oder fehlen), sind ungültig
  reset_in_progress_until timestamptz,     -- Sperre gegen parallele Resets, solange die Edge Function läuft
  updated_at              timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.account_security ENABLE ROW LEVEL SECURITY;   -- keine Policy: nur über die Funktionen unten
REVOKE ALL ON public.account_security FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.account_reset_audit (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event       text NOT NULL CHECK (event IN ('reset_started', 'reset_completed', 'reset_failed', 'reset_rejected',
                                             'password_changed', 'password_change_failed')),
  generation  integer,
  must_change_password boolean,
  detail      text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{1,40}$')   -- nur Codes: nie Passwort, Hash oder Token
);
CREATE INDEX IF NOT EXISTS account_reset_audit_user ON public.account_reset_audit (user_id, created_at DESC);
ALTER TABLE public.account_reset_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_reset_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.account_reset_audit TO authenticated;
DROP POLICY IF EXISTS account_reset_audit_admin_read ON public.account_reset_audit;
CREATE POLICY account_reset_audit_admin_read ON public.account_reset_audit FOR SELECT TO authenticated USING (is_admin());

-- Warum ist die aktuelle Anfrage gesperrt? NULL = nicht gesperrt. Liest nur JWT-Claims, account_security, auth.sessions.
CREATE OR REPLACE FUNCTION public._access_block_reason() RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  c jsonb; v_uid uuid; v_sid uuid; s account_security%ROWTYPE; v_started timestamptz;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  c := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  IF c IS NULL OR c->>'role' IS DISTINCT FROM 'authenticated' OR COALESCE(c->>'sub', '') !~ uuid_re THEN RETURN NULL; END IF;
  v_uid := (c->>'sub')::uuid;
  SELECT * INTO s FROM account_security WHERE user_id = v_uid;
  IF NOT FOUND THEN RETURN NULL; END IF;                  -- Normalfall: kein Reset je erfolgt
  IF s.sessions_valid_after IS NOT NULL THEN
    IF COALESCE(c->>'session_id', '') ~ uuid_re THEN
      v_sid := (c->>'session_id')::uuid;
      SELECT created_at INTO v_started FROM auth.sessions WHERE id = v_sid AND user_id = v_uid;
      IF v_started IS NULL OR v_started < s.sessions_valid_after THEN RETURN 'session_revoked'; END IF;
    ELSE
      RETURN 'session_revoked';                           -- Token ohne Sitzungsbezug: nach einem Reset nicht mehr
    END IF;
  END IF;
  IF s.must_change_password THEN RETURN 'password_change_required'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._access_block_reason() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._access_block_reason() TO anon, authenticated, service_role;

-- PostgREST-Pre-Request: läuft vor JEDER Data-API-Anfrage. Ohne Reset-Zeile sofort fertig (ein Primärschlüssel-Zugriff).
CREATE OR REPLACE FUNCTION public.access_gate() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r text;
BEGIN
  r := _access_block_reason();
  IF r IS NULL THEN RETURN; END IF;
  -- Einzige erlaubte Data-API-Anfrage während der Pflicht zur Passwortänderung (Pfad fehlt → gesperrt)
  IF r = 'password_change_required' AND COALESCE(current_setting('request.path', true), '') ~ '(^|/)rpc/my_access_state$' THEN RETURN; END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', HINT = r,
    MESSAGE = CASE r WHEN 'session_revoked' THEN 'Sitzung beendet – bitte neu anmelden.'
                     ELSE 'Bitte zuerst ein neues Passwort festlegen.' END;
END $$;
REVOKE ALL ON FUNCTION public.access_gate() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.access_gate() TO anon, authenticated, service_role;

-- Storage läuft nicht über PostgREST: dieselbe Sperre als RESTRICTIVE-Policy (UND-verknüpft mit allen übrigen)
DROP POLICY IF EXISTS access_gate_restrictive ON storage.objects;
CREATE POLICY access_gate_restrictive ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public._access_block_reason()) IS NULL)
  WITH CHECK ((SELECT public._access_block_reason()) IS NULL);

-- Eigener Status (einzige Data-API-Anfrage, die während der Pflicht erlaubt ist)
CREATE OR REPLACE FUNCTION public.my_access_state() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s account_security%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Nicht angemeldet.' USING ERRCODE = '42501'; END IF;
  IF _access_block_reason() = 'session_revoked' THEN
    RAISE EXCEPTION 'Sitzung beendet – bitte neu anmelden.' USING ERRCODE = '42501', HINT = 'session_revoked';
  END IF;
  SELECT * INTO s FROM account_security WHERE user_id = auth.uid();
  RETURN jsonb_build_object('must_change_password', COALESCE(s.must_change_password, false),
                            'generation', COALESCE(s.reset_generation, 0));
END $$;
REVOKE ALL ON FUNCTION public.my_access_state() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_access_state() TO authenticated;

-- Wer darf zurückgesetzt werden? Nur freigeschaltete Mitarbeiter/Manager eines aktiven Mitarbeiters, nicht man selbst,
-- nicht der Inhaber, kein Admin (Admins nutzen „Passwort vergessen?“ – kein Admin übernimmt einen anderen Admin-Zugang).
CREATE OR REPLACE FUNCTION public._access_reset_target(p_employee_id uuid, p_lock boolean,
                                                      OUT o_user_id uuid, OUT o_reason text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE p profiles%ROWTYPE; v_active boolean;
BEGIN
  IF p_lock THEN SELECT * INTO p FROM profiles WHERE employee_id = p_employee_id FOR UPDATE;
  ELSE SELECT * INTO p FROM profiles WHERE employee_id = p_employee_id; END IF;
  IF NOT FOUND THEN o_reason := 'no_login'; RETURN; END IF;
  o_user_id := p.id;
  SELECT e.is_active INTO v_active FROM employees e WHERE e.id = p_employee_id;
  o_reason := CASE
    WHEN p.id = auth.uid()                       THEN 'self'
    WHEN p.is_owner                              THEN 'owner'
    WHEN p.role NOT IN ('employee', 'manager')   THEN 'privileged_role'
    WHEN p.status IS DISTINCT FROM 'approved'    THEN 'not_active'
    WHEN v_active IS NOT TRUE                    THEN 'inactive_employee'
    WHEN NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id) THEN 'no_login'
  END;
END $$;
REVOKE ALL ON FUNCTION public._access_reset_target(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._access_reset_audit(p_user uuid, p_employee uuid, p_actor uuid, p_event text,
                                                     p_generation integer, p_must boolean, p_detail text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  INSERT INTO account_reset_audit (user_id, employee_id, actor_id, event, generation, must_change_password, detail)
  VALUES (p_user, p_employee, p_actor, p_event, p_generation, p_must, p_detail)
$$;
REVOKE ALL ON FUNCTION public._access_reset_audit(uuid, uuid, uuid, text, integer, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

-- Admin-Ansicht vor dem Bestätigen: darf zurückgesetzt werden, aktuelle Generation (gegen Doppelklick/zwei Admins)
CREATE OR REPLACE FUNCTION public.admin_access_reset_state(p_employee_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE t record; s account_security%ROWTYPE;
BEGIN
  IF NOT is_admin() OR _access_block_reason() IS NOT NULL THEN RAISE EXCEPTION 'Nicht autorisiert.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM _access_reset_target(p_employee_id, false);
  IF t.o_user_id IS NOT NULL THEN SELECT * INTO s FROM account_security WHERE user_id = t.o_user_id; END IF;
  RETURN jsonb_build_object('eligible', t.o_reason IS NULL, 'reason', t.o_reason,
                            'generation', COALESCE(s.reset_generation, 0),
                            'must_change_password', COALESCE(s.must_change_password, false),
                            'in_progress', COALESCE(s.reset_in_progress_until > clock_timestamp(), false));
END $$;
REVOKE ALL ON FUNCTION public.admin_access_reset_state(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_access_reset_state(uuid) TO authenticated;

-- Schritt 1 (JWT des Admins): Pflicht setzen, Generation +1, Sitzungen beenden, Sperre setzen.
-- Ablehnungen kommen als {ok:false, reason} zurück (und werden protokolliert), statt die Protokollzeile zurückzurollen.
CREATE OR REPLACE FUNCTION public.admin_begin_access_reset(p_employee_id uuid, p_expected_generation integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_actor uuid := auth.uid(); t record; s account_security%ROWTYPE; v_now timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Nicht angemeldet.' USING ERRCODE = '42501'; END IF;
  IF NOT is_admin() OR _access_block_reason() IS NOT NULL THEN
    PERFORM _access_reset_audit(NULL, CASE WHEN EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id) THEN p_employee_id END,
                                v_actor, 'reset_rejected', NULL, NULL, 'forbidden');
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  SELECT * INTO t FROM _access_reset_target(p_employee_id, true);   -- sperrt die Profilzeile (Rollen-/Statuswechsel parallel)
  IF t.o_reason IS NOT NULL THEN
    PERFORM _access_reset_audit(t.o_user_id, CASE WHEN EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id) THEN p_employee_id END,
                                v_actor, 'reset_rejected', NULL, NULL, t.o_reason);
    RETURN jsonb_build_object('ok', false, 'reason', t.o_reason);
  END IF;
  INSERT INTO account_security (user_id) VALUES (t.o_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO s FROM account_security WHERE user_id = t.o_user_id FOR UPDATE;
  v_now := clock_timestamp();
  IF s.reset_in_progress_until > v_now THEN
    PERFORM _access_reset_audit(t.o_user_id, p_employee_id, v_actor, 'reset_rejected', s.reset_generation, s.must_change_password, 'in_progress');
    RETURN jsonb_build_object('ok', false, 'reason', 'in_progress');
  END IF;
  IF p_expected_generation IS DISTINCT FROM s.reset_generation THEN
    PERFORM _access_reset_audit(t.o_user_id, p_employee_id, v_actor, 'reset_rejected', s.reset_generation, s.must_change_password, 'stale');
    RETURN jsonb_build_object('ok', false, 'reason', 'stale', 'generation', s.reset_generation);
  END IF;
  UPDATE account_security
     SET reset_generation = s.reset_generation + 1, must_change_password = true, sessions_valid_after = v_now,
         reset_in_progress_until = v_now + interval '60 seconds', updated_at = v_now
   WHERE user_id = t.o_user_id;
  DELETE FROM auth.sessions WHERE user_id = t.o_user_id;   -- Refresh-Tokens folgen per ON DELETE CASCADE
  PERFORM _access_reset_audit(t.o_user_id, p_employee_id, v_actor, 'reset_started', s.reset_generation + 1, true, NULL);
  RETURN jsonb_build_object('ok', true, 'user_id', t.o_user_id, 'generation', s.reset_generation + 1);
END $$;
REVOKE ALL ON FUNCTION public.admin_begin_access_reset(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_begin_access_reset(uuid, integer) TO authenticated;

-- Nur der Server (Edge Function mit Service-Schlüssel): Grants + Rollen-Claim
CREATE OR REPLACE FUNCTION public._require_service_role() RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
  IF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Nur für den Server.' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._require_service_role() FROM PUBLIC, anon, authenticated, service_role;

-- Schritt 3 (nach erfolgreichem updateUserById): alle Sitzungen beenden (auch zwischenzeitlich mit dem alten Passwort
-- begonnene), Sperre lösen, protokollieren. superseded = inzwischen neuerer Reset → Passwort NICHT anzeigen.
CREATE OR REPLACE FUNCTION public.service_access_reset_finish(p_user_id uuid, p_generation integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s account_security%ROWTYPE; v_actor uuid; v_emp uuid; v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM _require_service_role();
  SELECT * INTO s FROM account_security WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR s.reset_generation <> p_generation THEN RETURN jsonb_build_object('ok', false, 'reason', 'superseded'); END IF;
  SELECT actor_id, employee_id INTO v_actor, v_emp FROM account_reset_audit
   WHERE user_id = p_user_id AND event = 'reset_started' AND generation = p_generation ORDER BY id DESC LIMIT 1;
  UPDATE account_security SET sessions_valid_after = v_now, reset_in_progress_until = NULL, must_change_password = true, updated_at = v_now
   WHERE user_id = p_user_id;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  PERFORM _access_reset_audit(p_user_id, v_emp, v_actor, 'reset_completed', p_generation, true, NULL);
  BEGIN
    INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
    SELECT v_actor, COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin'), a.role,
           'employee.access_reset', 'employee',
           COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email, 'Admin') || ' hat den App-Zugang von '
             || COALESCE(NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), ''), 'Mitarbeiter') || ' zurückgesetzt (temporäres Passwort).',
           'employee', v_emp::text, NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), '')
      FROM profiles a LEFT JOIN employees e ON e.id = v_emp WHERE a.id = v_actor;
  EXCEPTION WHEN OTHERS THEN NULL;   -- Aktivitätsprotokoll darf die Aktion nie blockieren (Pflichtprotokoll: account_reset_audit)
  END;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.service_access_reset_finish(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.service_access_reset_finish(uuid, integer) TO service_role;

-- Passwort konnte nicht gesetzt werden: protokollieren, Sperre lösen. Die Pflicht zur Passwortänderung BLEIBT
-- (Antwort von Auth evtl. verloren → unbekannt, ob das Passwort schon geändert ist; so ist es in jedem Fall sicher).
CREATE OR REPLACE FUNCTION public.service_access_reset_failed(p_user_id uuid, p_generation integer, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_actor uuid; v_emp uuid;
BEGIN
  PERFORM _require_service_role();
  SELECT actor_id, employee_id INTO v_actor, v_emp FROM account_reset_audit
   WHERE user_id = p_user_id AND event = 'reset_started' AND generation = p_generation ORDER BY id DESC LIMIT 1;
  UPDATE account_security SET reset_in_progress_until = NULL, updated_at = clock_timestamp()
   WHERE user_id = p_user_id AND reset_generation = p_generation;
  PERFORM _access_reset_audit(p_user_id, v_emp, v_actor, 'reset_failed', p_generation, true,
                              CASE WHEN p_reason ~ '^[a-z0-9_]{1,40}$' THEN p_reason ELSE 'unknown' END);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.service_access_reset_failed(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.service_access_reset_failed(uuid, integer, text) TO service_role;

-- Nach erfolgreicher Passwortänderung durch die Person (Auth PUT /user mit ihrem JWT): Pflicht löschen, übrige
-- Sitzungen beenden (aktuelle bleibt). Idempotent; Generation muss passen (inzwischen neuer Reset → nicht löschen).
CREATE OR REPLACE FUNCTION public.service_complete_password_change(p_user_id uuid, p_generation integer, p_keep_session uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s account_security%ROWTYPE; v_emp uuid;
BEGIN
  PERFORM _require_service_role();
  SELECT * INTO s FROM account_security WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_required'); END IF;
  IF s.reset_generation <> p_generation THEN RETURN jsonb_build_object('ok', false, 'reason', 'superseded'); END IF;
  IF NOT s.must_change_password THEN RETURN jsonb_build_object('ok', true, 'already', true); END IF;
  SELECT employee_id INTO v_emp FROM profiles WHERE id = p_user_id;
  UPDATE account_security SET must_change_password = false, updated_at = clock_timestamp() WHERE user_id = p_user_id;
  DELETE FROM auth.sessions WHERE user_id = p_user_id AND id IS DISTINCT FROM p_keep_session;
  PERFORM _access_reset_audit(p_user_id, v_emp, p_user_id, 'password_changed', p_generation, false, NULL);
  RETURN jsonb_build_object('ok', true, 'already', false);
END $$;
REVOKE ALL ON FUNCTION public.service_complete_password_change(uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.service_complete_password_change(uuid, integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.service_password_change_failed(p_user_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s account_security%ROWTYPE;
BEGIN
  PERFORM _require_service_role();
  SELECT * INTO s FROM account_security WHERE user_id = p_user_id;
  PERFORM _access_reset_audit(p_user_id, (SELECT employee_id FROM profiles WHERE id = p_user_id), p_user_id, 'password_change_failed',
                              s.reset_generation, s.must_change_password, CASE WHEN p_reason ~ '^[a-z0-9_]{1,40}$' THEN p_reason ELSE 'unknown' END);
END $$;
REVOKE ALL ON FUNCTION public.service_password_change_failed(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.service_password_change_failed(uuid, text) TO service_role;

-- Pre-Request aktivieren (offizieller Supabase-Weg, docs: „Securing your API“ → pgrst.db_pre_request)
ALTER ROLE authenticator SET pgrst.db_pre_request TO 'public.access_gate';
NOTIFY pgrst, 'reload config';
