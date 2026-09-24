-- ============================================================
-- 10 · Datensicherung
-- Bereits live eingespielt (Migration backups_weekly) — NICHT erneut ausführen.
--
--  * Jede Woche (So 04:00 Uhr dt. Zeit) automatische Sicherung aller Tabellen
--    in backup_snapshots (die letzten 8 bleiben, manuelle: die letzten 5).
--    Schützt vor versehentlichem Löschen/Überschreiben.
--  * Admin kann jederzeit eine Sicherung als Datei herunterladen (Schutz, falls
--    das Supabase-Projekt selbst ausfällt – Free-Plan hat keine Backups).
--  * NICHT gesichert: Passwörter (liegen nur bei Supabase Auth) und Zugangstokens
--    von Kassen-Integrationen.
--  * Zugriff ausschließlich über Admin-Funktionen; Tabelle selbst ist gesperrt.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE IF NOT EXISTS public.backup_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('auto','manual')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  size_bytes    integer,
  counts        jsonb,
  data          jsonb NOT NULL,
  downloaded_at timestamptz
);
ALTER TABLE public.backup_snapshots ENABLE ROW LEVEL SECURITY;   -- keine Policies = kein direkter Zugriff
REVOKE ALL ON public.backup_snapshots FROM anon, authenticated;

-- Tabellen, die NIE in eine Sicherung gehören (Geheimnisse / die Sicherung selbst)
CREATE OR REPLACE FUNCTION public._backup_excluded(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IN ('backup_snapshots', 'lightspeed_tokens', 'pos_oauth_tokens', 'push_subscriptions', 'push_config')
$$;

CREATE OR REPLACE FUNCTION public._backup_build()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t record; v jsonb; data jsonb := '{}'::jsonb; counts jsonb := '{}'::jsonb; files jsonb;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name LOOP
    CONTINUE WHEN _backup_excluded(t.table_name);
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM public.%I x', t.table_name) INTO v;
    data   := data   || jsonb_build_object(t.table_name, v);
    counts := counts || jsonb_build_object(t.table_name, jsonb_array_length(v));
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'name', name,
           'size', (metadata->>'size')::bigint, 'created_at', created_at) ORDER BY bucket_id, name), '[]'::jsonb)
    INTO files FROM storage.objects;
  RETURN jsonb_build_object(
    'meta', jsonb_build_object('app', 'Café Buur Personalverwaltung', 'format', 1,
                               'created_at', now(), 'counts', counts,
                               'hinweis', 'Enthält sensible Personaldaten. Sicher aufbewahren, nicht per E-Mail versenden.'),
    'tables', data,
    'files', files);
END $$;

CREATE OR REPLACE FUNCTION public._backup_create(p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb; v_id uuid;
BEGIN
  v := _backup_build();
  INSERT INTO backup_snapshots (kind, created_by, size_bytes, counts, data)
  VALUES (p_kind, auth.uid(), octet_length(v::text), v->'meta'->'counts', v)
  RETURNING id INTO v_id;
  -- Aufräumen: automatische 8, manuelle 5 behalten
  DELETE FROM backup_snapshots WHERE kind = 'auto' AND id NOT IN
    (SELECT id FROM backup_snapshots WHERE kind = 'auto' ORDER BY created_at DESC LIMIT 8);
  DELETE FROM backup_snapshots WHERE kind = 'manual' AND id NOT IN
    (SELECT id FROM backup_snapshots WHERE kind = 'manual' ORDER BY created_at DESC LIMIT 5);
  RETURN v_id;
END $$;

-- ── Admin-Funktionen ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backup_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  RETURN jsonb_build_object('success', true,
    'last_download_at', (SELECT max(downloaded_at) FROM backup_snapshots),
    'backups', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'kind', kind,
                 'size_bytes', size_bytes, 'counts', counts, 'downloaded_at', downloaded_at) ORDER BY created_at DESC)
               FROM backup_snapshots), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.backup_create_now()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  IF EXISTS (SELECT 1 FROM backup_snapshots WHERE kind = 'manual' AND created_at > now() - interval '1 minute') THEN
    SELECT id INTO v_id FROM backup_snapshots WHERE kind = 'manual' ORDER BY created_at DESC LIMIT 1;
    RETURN jsonb_build_object('success', true, 'id', v_id, 'reused', true);
  END IF;
  v_id := _backup_create('manual');
  RETURN jsonb_build_object('success', true, 'id', v_id, 'reused', false);
END $$;

CREATE OR REPLACE FUNCTION public.backup_get(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb; v_at timestamptz;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  UPDATE backup_snapshots SET downloaded_at = now() WHERE id = p_id RETURNING data, created_at INTO v, v_at;
  IF v IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sicherung nicht gefunden.'); END IF;
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_name)
  SELECT auth.uid(), COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role, 'backup.downloaded', 'settings',
         COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email) || ' hat eine Datensicherung heruntergeladen (Stand '
           || to_char(v_at AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY HH24:MI') || ' Uhr).',
         'backup', to_char(v_at AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY')
  FROM profiles WHERE id = auth.uid();
  RETURN jsonb_build_object('success', true, 'created_at', v_at, 'data', v);
END $$;

REVOKE ALL ON FUNCTION public._backup_excluded(text), public._backup_build(), public._backup_create(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_list(), public.backup_create_now(), public.backup_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backup_list(), public.backup_create_now(), public.backup_get(uuid) TO authenticated;

-- Wöchentlich sonntags 02:00 UTC (= 03:00/04:00 Uhr deutsche Zeit)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cafe-weekly-backup';
SELECT cron.schedule('cafe-weekly-backup', '0 2 * * 0', $cron$SELECT public._backup_create('auto')$cron$);
-- Erste Sicherung sofort
SELECT public._backup_create('auto');
