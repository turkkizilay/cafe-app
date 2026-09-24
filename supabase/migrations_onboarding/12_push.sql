-- ============================================================
-- 12 · Push-Benachrichtigungen
-- Bereits live eingespielt (Migration push_notifications) — NICHT erneut ausführen.
--
--  * push_subscriptions: Geräte, die Benachrichtigungen bekommen (nur eigene sichtbar).
--  * push_outbox: Warteschlange. Trigger legen Nachrichten an, pg_net stößt die
--    Edge Function „send-push" an, die verschlüsselt (RFC 8291) an Apple/Google sendet.
--  * VAPID-Schlüssel erzeugt die Edge Function beim ersten Lauf selbst; der private
--    Schlüssel liegt im Supabase Vault, nie im Frontend.
--  * Inhalte bewusst knapp (Sperrbildschirm!): keine Gesundheitsdaten, keine Beträge.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subs_own_read ON public.push_subscriptions;
CREATE POLICY push_subs_own_read ON public.push_subscriptions FOR SELECT USING (profile_id = auth.uid());
REVOKE INSERT, UPDATE, DELETE ON public.push_subscriptions FROM anon, authenticated;   -- nur über Funktionen
REVOKE ALL ON public.push_subscriptions FROM anon;

CREATE TABLE IF NOT EXISTS public.push_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text,
  url         text,
  tag         text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  attempts    int NOT NULL DEFAULT 0,
  error       text
);
CREATE INDEX IF NOT EXISTS push_outbox_pending ON public.push_outbox (created_at) WHERE sent_at IS NULL;
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;          -- keine Policies: kein Zugriff aus der App
REVOKE ALL ON public.push_outbox FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.push_config (key text PRIMARY KEY, value text NOT NULL);
ALTER TABLE public.push_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_config FROM anon, authenticated;

-- ── Versand anstoßen ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._push_kick() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://hhzcckervnapkiotattl.supabase.co/functions/v1/send-push',
    body := '{}'::jsonb,
    -- öffentlicher anon-Schlüssel (steht ohnehin im Frontend) – erfüllt die JWT-Prüfung der Function
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <öffentlicher anon-Schlüssel, siehe .env VITE_SUPABASE_ANON_KEY>'),
    timeout_milliseconds := 10000);
EXCEPTION WHEN OTHERS THEN NULL;   -- Versand darf nie eine App-Aktion blockieren
END $$;

-- Nachricht an ein Profil (nur freigeschaltete Profile mit Gerät)
CREATE OR REPLACE FUNCTION public._push_to_profile(p_profile uuid, p_title text, p_body text, p_url text, p_tag text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF p_profile IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM push_subscriptions s JOIN profiles p ON p.id = s.profile_id
                 WHERE s.profile_id = p_profile AND p.status = 'approved') THEN RETURN; END IF;
  INSERT INTO push_outbox (profile_id, title, body, url, tag) VALUES (p_profile, LEFT(p_title, 120), LEFT(p_body, 240), p_url, p_tag);
  PERFORM _push_kick();
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public._push_to_employee(p_emp uuid, p_title text, p_body text, p_url text, p_tag text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE pid uuid;
BEGIN
  FOR pid IN SELECT id FROM profiles WHERE employee_id = p_emp AND status = 'approved' LOOP
    PERFORM _push_to_profile(pid, p_title, p_body, p_url, p_tag);
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- An Admins (und optional Manager) – die auslösende Person selbst nicht
CREATE OR REPLACE FUNCTION public._push_to_staff(p_with_managers boolean, p_title text, p_body text, p_url text, p_tag text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE pid uuid;
BEGIN
  FOR pid IN SELECT id FROM profiles WHERE status = 'approved'
               AND (role = 'admin' OR (p_with_managers AND role = 'manager'))
               AND id IS DISTINCT FROM auth.uid() LOOP
    PERFORM _push_to_profile(pid, p_title, p_body, p_url, p_tag);
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public._emp_short(p_emp uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(NULLIF(TRIM(first_name || ' ' || LEFT(COALESCE(last_name,''), 1) || CASE WHEN COALESCE(last_name,'') <> '' THEN '.' ELSE '' END), ''), 'Ein Mitarbeiter')
  FROM employees WHERE id = p_emp
$$;
CREATE OR REPLACE FUNCTION public._d(p date) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT to_char(p, 'DD.MM.') $$;
CREATE OR REPLACE FUNCTION public._wd(p date) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT (ARRAY['So','Mo','Di','Mi','Do','Fr','Sa'])[EXTRACT(DOW FROM p)::int + 1] $$;

-- ── Ereignisse ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_on_onboarding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM _push_to_staff(false, '🔑 Neue Registrierung', 'Eine neue Person wartet auf Freischaltung.', '/benutzer', 'onboarding');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.push_on_vacation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM _push_to_staff(true, '🌴 Neuer Urlaubsantrag',
      _emp_short(NEW.employee_id) || ' · ' || _d(NEW.start_date) || '–' || _d(NEW.end_date), '/urlaub', 'vacation');
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
    PERFORM _push_to_employee(NEW.employee_id,
      CASE WHEN NEW.status = 'approved' THEN '✅ Urlaub genehmigt' ELSE '❌ Urlaub abgelehnt' END,
      _d(NEW.start_date) || '–' || to_char(NEW.end_date, 'DD.MM.YYYY'), '/urlaub', 'vacation-' || NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.push_on_sick() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  -- Bewusst ohne Namen: Gesundheitsdaten gehören nicht auf den Sperrbildschirm
  IF TG_OP = 'INSERT' THEN
    PERFORM _push_to_staff(true, '🤒 Neue Krankmeldung', 'Bitte in der App ansehen.', '/urlaub', 'sick');
  ELSIF TG_OP = 'UPDATE' AND NEW.certificate_file_path IS NOT NULL AND OLD.certificate_file_path IS NULL THEN
    PERFORM _push_to_staff(true, '📎 Neue AU-Bescheinigung', 'Bitte in der App ansehen.', '/urlaub', 'sick');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.push_on_swap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.target_id IS NOT NULL THEN
    PERFORM _push_to_employee(NEW.target_id, '🔄 Anfrage zum Schichttausch', _emp_short(NEW.requester_id) || ' möchte mit dir tauschen.', '/schichten', 'swap-' || NEW.id);
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'accepted' THEN
      PERFORM _push_to_staff(true, '🔄 Schichttausch wartet auf Freigabe', _emp_short(NEW.requester_id) || ' ⇄ ' || COALESCE(_emp_short(NEW.target_id), '–'), '/schichten', 'swap');
    ELSIF NEW.status = 'declined' THEN
      PERFORM _push_to_employee(NEW.requester_id, '🔄 Schichttausch abgelehnt', COALESCE(_emp_short(NEW.target_id), 'Die Person') || ' hat abgelehnt.', '/schichten', 'swap-' || NEW.id);
    ELSIF NEW.status IN ('approved','rejected') THEN
      PERFORM _push_to_employee(NEW.requester_id, CASE WHEN NEW.status = 'approved' THEN '✅ Schichttausch freigegeben' ELSE '❌ Schichttausch nicht freigegeben' END, 'Details im Schichtplan.', '/schichten', 'swap-' || NEW.id);
      PERFORM _push_to_employee(NEW.target_id,    CASE WHEN NEW.status = 'approved' THEN '✅ Schichttausch freigegeben' ELSE '❌ Schichttausch nicht freigegeben' END, 'Details im Schichtplan.', '/schichten', 'swap-' || NEW.id);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.push_on_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE today date := (now() AT TIME ZONE 'Europe/Berlin')::date; r shifts%ROWTYPE; txt text;
BEGIN
  r := COALESCE(NEW, OLD);
  IF r.date < today THEN RETURN r; END IF;
  txt := _wd(r.date) || ', ' || _d(r.date) || ' ' || to_char(r.start_time, 'HH24:MI') || '–' || to_char(r.end_time, 'HH24:MI') || ' Uhr';
  IF TG_OP = 'INSERT' THEN
    PERFORM _push_to_employee(NEW.employee_id, '📅 Neue Schicht', txt, '/schichten', 'shifts');
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM _push_to_employee(OLD.employee_id, '📅 Schicht entfällt', _wd(OLD.date) || ', ' || _d(OLD.date), '/schichten', 'shifts');
  ELSIF NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    PERFORM _push_to_employee(NEW.employee_id, '📅 Neue Schicht', txt, '/schichten', 'shifts');
    PERFORM _push_to_employee(OLD.employee_id, '📅 Schicht abgegeben', _wd(OLD.date) || ', ' || _d(OLD.date), '/schichten', 'shifts');
  ELSIF (NEW.date, NEW.start_time, NEW.end_time) IS DISTINCT FROM (OLD.date, OLD.start_time, OLD.end_time) THEN
    PERFORM _push_to_employee(NEW.employee_id, '📅 Schicht geändert', txt, '/schichten', 'shifts');
  END IF;
  RETURN r;
EXCEPTION WHEN OTHERS THEN RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.push_on_payroll_doc() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM _push_to_employee(NEW.employee_id, '📄 Neue Lohnabrechnung',
    (ARRAY['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'])[NEW.month] || ' ' || NEW.year || ' ist verfügbar.', '/dokumente', 'payroll');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_push_onboarding ON public.employee_onboarding;
CREATE TRIGGER trg_push_onboarding AFTER UPDATE ON public.employee_onboarding FOR EACH ROW EXECUTE FUNCTION public.push_on_onboarding();
DROP TRIGGER IF EXISTS trg_push_vacation ON public.vacation_requests;
CREATE TRIGGER trg_push_vacation AFTER INSERT OR UPDATE ON public.vacation_requests FOR EACH ROW EXECUTE FUNCTION public.push_on_vacation();
DROP TRIGGER IF EXISTS trg_push_sick ON public.sick_leave;
CREATE TRIGGER trg_push_sick AFTER INSERT OR UPDATE ON public.sick_leave FOR EACH ROW EXECUTE FUNCTION public.push_on_sick();
DROP TRIGGER IF EXISTS trg_push_swap ON public.shift_swap_requests;
CREATE TRIGGER trg_push_swap AFTER INSERT OR UPDATE ON public.shift_swap_requests FOR EACH ROW EXECUTE FUNCTION public.push_on_swap();
DROP TRIGGER IF EXISTS trg_push_shift ON public.shifts;
CREATE TRIGGER trg_push_shift AFTER INSERT OR UPDATE OR DELETE ON public.shifts FOR EACH ROW EXECUTE FUNCTION public.push_on_shift();
DROP TRIGGER IF EXISTS trg_push_payroll_doc ON public.payroll_documents;
CREATE TRIGGER trg_push_payroll_doc AFTER INSERT ON public.payroll_documents FOR EACH ROW EXECUTE FUNCTION public.push_on_payroll_doc();

-- ── Funktionen für die App ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_public_key() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT value FROM push_config WHERE key = 'vapid_public' AND is_approved()
$$;

CREATE OR REPLACE FUNCTION public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT is_approved() THEN RETURN jsonb_build_object('success', false, 'error', 'Nicht angemeldet.'); END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR length(p_endpoint) > 1000
     OR p_p256dh IS NULL OR length(p_p256dh) NOT BETWEEN 80 AND 100 OR p_auth IS NULL OR length(p_auth) NOT BETWEEN 16 AND 30 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ungültige Anmeldung für Benachrichtigungen.');
  END IF;
  -- Gleiches Gerät, anderer Nutzer: Gerät wechselt den Besitzer
  INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent)
  VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth, LEFT(p_ua, 200))
  ON CONFLICT (endpoint) DO UPDATE SET profile_id = auth.uid(), p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
    user_agent = EXCLUDED.user_agent, created_at = now();
  -- höchstens 10 Geräte pro Person (älteste fliegen raus)
  DELETE FROM push_subscriptions WHERE profile_id = auth.uid() AND id NOT IN
    (SELECT id FROM push_subscriptions WHERE profile_id = auth.uid() ORDER BY created_at DESC LIMIT 10);
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.push_unsubscribe(p_endpoint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false); END IF;
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint AND profile_id = auth.uid();
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.push_test()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT is_approved() THEN RETURN jsonb_build_object('success', false, 'error', 'Nicht angemeldet.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Auf diesem Konto ist noch kein Gerät angemeldet.');
  END IF;
  IF EXISTS (SELECT 1 FROM push_outbox WHERE profile_id = auth.uid() AND tag = 'test' AND created_at > now() - interval '30 seconds') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Bitte kurz warten und dann erneut versuchen.');
  END IF;
  INSERT INTO push_outbox (profile_id, title, body, url, tag) VALUES (auth.uid(), '🔔 Test', 'Benachrichtigungen funktionieren.', '/konto?tab=app', 'test');
  PERFORM _push_kick();
  RETURN jsonb_build_object('success', true);
END $$;

-- ── Funktionen nur für die Edge Function (service_role) ─────
CREATE OR REPLACE FUNCTION public.push_worker_keys() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pub text; v_priv text;
BEGIN
  SELECT value INTO v_pub FROM push_config WHERE key = 'vapid_public';
  SELECT decrypted_secret INTO v_priv FROM vault.decrypted_secrets WHERE name = 'push_vapid_private_jwk';
  IF v_pub IS NULL OR v_priv IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('public', v_pub, 'private_jwk', v_priv::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.push_worker_set_keys(p_public text, p_private_jwk jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('push_vapid'));
  IF NOT EXISTS (SELECT 1 FROM push_config WHERE key = 'vapid_public') THEN
    PERFORM vault.create_secret(p_private_jwk::text, 'push_vapid_private_jwk', 'VAPID-Schlüssel für Push-Benachrichtigungen');
    INSERT INTO push_config (key, value) VALUES ('vapid_public', p_public);
  END IF;
  RETURN push_worker_keys();
END $$;

CREATE OR REPLACE FUNCTION public.push_worker_claim(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb;
BEGIN
  -- Alte/aufgegebene Nachrichten nicht ewig aufheben
  DELETE FROM push_outbox WHERE created_at < now() - interval '7 days';
  WITH picked AS (
    SELECT o.id FROM push_outbox o
    WHERE o.sent_at IS NULL AND o.attempts < 5 AND o.created_at > now() - interval '2 days'
      AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '2 minutes')
    ORDER BY o.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE push_outbox o SET claimed_at = now(), attempts = o.attempts + 1 FROM picked WHERE o.id = picked.id RETURNING o.*
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'body', u.body, 'url', u.url, 'tag', u.tag,
           'subs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                             FROM push_subscriptions s JOIN profiles p ON p.id = s.profile_id
                             WHERE s.profile_id = u.profile_id AND p.status = 'approved'), '[]'::jsonb))), '[]'::jsonb)
    INTO v FROM upd u;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.push_worker_done(p_results jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r jsonb;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    IF (r->>'ok')::boolean THEN
      UPDATE push_outbox SET sent_at = now(), error = NULL WHERE id = (r->>'id')::uuid;
    ELSE
      UPDATE push_outbox SET error = LEFT(r->>'error', 300), claimed_at = NULL WHERE id = (r->>'id')::uuid;
    END IF;
    DELETE FROM push_subscriptions WHERE id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(COALESCE(r->'gone', '[]'::jsonb)) x);
    UPDATE push_subscriptions SET last_used_at = now() WHERE id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(COALESCE(r->'delivered', '[]'::jsonb)) x);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public._push_kick(), public._push_to_profile(uuid,text,text,text,text), public._push_to_employee(uuid,text,text,text,text),
  public._push_to_staff(boolean,text,text,text,text), public._emp_short(uuid), public._d(date), public._wd(date),
  public.push_on_onboarding(), public.push_on_vacation(), public.push_on_sick(), public.push_on_swap(), public.push_on_shift(), public.push_on_payroll_doc()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_worker_keys(), public.push_worker_set_keys(text, jsonb), public.push_worker_claim(int), public.push_worker_done(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_worker_keys(), public.push_worker_set_keys(text, jsonb), public.push_worker_claim(int), public.push_worker_done(jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.push_public_key(), public.push_subscribe(text,text,text,text), public.push_unsubscribe(text), public.push_test() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_public_key(), public.push_subscribe(text,text,text,text), public.push_unsubscribe(text), public.push_test() TO authenticated;

-- Liegengebliebene Nachrichten alle 5 Minuten erneut anstoßen
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cafe-push-retry';
SELECT cron.schedule('cafe-push-retry', '*/5 * * * *',
  $cron$SELECT public._push_kick() WHERE EXISTS (SELECT 1 FROM public.push_outbox WHERE sent_at IS NULL AND attempts < 5 AND created_at > now() - interval '2 days')$cron$);
