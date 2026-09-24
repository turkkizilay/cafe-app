-- ============================================================
-- 15 · Löschfristen: genaue Angaben vor dem Löschen + im Protokoll
-- Bereits live eingespielt (Migration retention_details) — NICHT erneut ausführen.
-- ============================================================

-- Beschreibung einer Datei: Art, Mitarbeiter, Datum, Größe
CREATE OR REPLACE FUNCTION public._ret_file_json(p_bucket text, p_name text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'bucket', p_bucket, 'name', p_name,
    'kind', CASE p_bucket WHEN 'sick-certs' THEN 'AU-Bescheinigung' WHEN 'payroll-docs' THEN 'Lohnabrechnung'
                          WHEN 'employee-documents' THEN 'Personalunterlage' WHEN 'avatars' THEN 'Profilbild' ELSE p_bucket END,
    'employee', COALESCE(
        (SELECT first_name || ' ' || COALESCE(last_name, '') FROM employees WHERE id::text = split_part(p_name, '/', 1)),
        (SELECT COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email) FROM profiles WHERE id::text = split_part(p_name, '/', 1)),
        'unbekannt'),
    'uploaded_at', (SELECT created_at FROM storage.objects WHERE bucket_id = p_bucket AND name = p_name),
    'size', (SELECT (metadata->>'size')::bigint FROM storage.objects WHERE bucket_id = p_bucket AND name = p_name))
$$;
REVOKE ALL ON FUNCTION public._ret_file_json(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retention_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c3 date := _ret_cut3(); c8 date := _ret_cut8(); y int := _ret_year(); cats jsonb := '[]'::jsonb;
  n int; nx date; files jsonb; bd jsonb;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;

  bd := jsonb_build_object(
    'Zeiteinträge', (SELECT count(*) FROM time_entries WHERE date < c3),
    'Schichten', (SELECT count(*) FROM shifts WHERE date < c3),
    'Urlaubsanträge', (SELECT count(*) FROM vacation_requests WHERE end_date < c3),
    'Zeitkorrekturen', (SELECT count(*) FROM time_corrections WHERE created_at < c3));
  SELECT COALESCE(sum(v::int), 0) INTO n FROM jsonb_each_text(bd) AS e(k, v);
  SELECT make_date(EXTRACT(YEAR FROM LEAST((SELECT min(date) FROM time_entries), (SELECT min(date) FROM shifts),
         (SELECT min(end_date) FROM vacation_requests)))::int + 4, 1, 1) INTO nx;
  cats := cats || jsonb_build_object('key','zeiten','title','Arbeitszeiten, Schichten & Urlaub',
    'rule','3 volle Kalenderjahre nach dem Jahr des Eintrags', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END,
    'breakdown', bd, 'files', '[]'::jsonb);

  SELECT count(*) INTO n FROM sick_leave WHERE COALESCE(end_date, start_date) < c3;
  SELECT make_date(EXTRACT(YEAR FROM min(COALESCE(end_date, start_date)))::int + 4, 1, 1) INTO nx FROM sick_leave;
  SELECT COALESCE(jsonb_agg(_ret_file_json(bucket, name)), '[]'::jsonb) INTO files FROM _ret_files('krank');
  cats := cats || jsonb_build_object('key','krank','title','Krankmeldungen & AU-Bescheinigungen',
    'rule','3 volle Kalenderjahre nach Ende der Krankmeldung', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END,
    'breakdown', jsonb_build_object('Krankmeldungen', n), 'files', files);

  bd := jsonb_build_object(
    'Lohnabrechnungen (PDF)', (SELECT count(*) FROM payroll_documents WHERE year < EXTRACT(YEAR FROM c8)::int),
    'Lohnmonate', (SELECT count(*) FROM payroll_months WHERE year < EXTRACT(YEAR FROM c8)::int));
  SELECT COALESCE(sum(v::int), 0) INTO n FROM jsonb_each_text(bd) AS e(k, v);
  SELECT make_date(LEAST((SELECT min(year) FROM payroll_documents), (SELECT min(year) FROM payroll_months)) + 9, 1, 1) INTO nx;
  SELECT COALESCE(jsonb_agg(_ret_file_json(bucket, name)), '[]'::jsonb) INTO files FROM _ret_files('lohn');
  cats := cats || jsonb_build_object('key','lohn','title','Lohnabrechnungen',
    'rule','8 volle Kalenderjahre nach dem Abrechnungsjahr', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END,
    'breakdown', bd, 'files', files);

  SELECT count(*) INTO n FROM _ret_former_ids();
  SELECT make_date(EXTRACT(YEAR FROM min(end_date))::int + 9, 1, 1) INTO nx FROM employees e
    WHERE e.is_active = false AND e.end_date IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.employee_id = e.id AND p.is_owner);
  SELECT COALESCE(jsonb_agg(_ret_file_json(bucket, name)), '[]'::jsonb) INTO files FROM _ret_files('ehemalige');
  cats := cats || jsonb_build_object('key','ehemalige','title','Ausgeschiedene Mitarbeiter (komplett)',
    'rule','8 volle Kalenderjahre nach dem Austrittsjahr', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END, 'files', files,
    'names', COALESCE((SELECT jsonb_agg(first_name || ' ' || last_name || ' (ausgetreten ' || to_char(end_date, 'DD.MM.YYYY') || ')')
                       FROM employees WHERE id IN (SELECT _ret_former_ids())), '[]'::jsonb),
    'missing_end_date', (SELECT count(*) FROM employees WHERE is_active = false AND end_date IS NULL));

  SELECT count(*) INTO n FROM activity_log WHERE created_at < c3;
  SELECT make_date(EXTRACT(YEAR FROM min(created_at AT TIME ZONE 'Europe/Berlin'))::int + 4, 1, 1) INTO nx FROM activity_log;
  cats := cats || jsonb_build_object('key','protokoll','title','Aktivitätsprotokoll',
    'rule','3 volle Kalenderjahre', 'due', n, 'next_due', CASE WHEN n = 0 THEN nx END,
    'breakdown', jsonb_build_object('Protokolleinträge', n), 'files', '[]'::jsonb);

  SELECT count(*) INTO n FROM invitations WHERE created_at < now() - interval '6 months'
    AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now());
  cats := cats || jsonb_build_object('key','einladungen','title','Alte Einladungen',
    'rule','6 Monate nach Nutzung, Ablauf oder Rückzug', 'due', n, 'next_due', NULL,
    'breakdown', jsonb_build_object('Einladungen', n), 'files', '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(_ret_file_json(bucket, name)), '[]'::jsonb) INTO files FROM _ret_files('verwaist');
  cats := cats || jsonb_build_object('key','verwaist','title','Verwaiste Dateien (ohne Datensatz)',
    'rule','sofort – die Datei gehört zu keinem Eintrag mehr (z. B. Krankmeldung gelöscht, Datei ist geblieben)',
    'due', jsonb_array_length(files), 'next_due', NULL, 'files', files);

  RETURN jsonb_build_object('success', true, 'year', y, 'categories', cats,
    'total_due', (SELECT COALESCE(sum((c->>'due')::int), 0) FROM jsonb_array_elements(cats) c));
END $$;
REVOKE ALL ON FUNCTION public.retention_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retention_overview() TO authenticated;

-- Löschen: die App übergibt die Liste der gelöschten Dateien → landet im Protokoll
DROP FUNCTION IF EXISTS public.retention_purge(text, boolean);
CREATE OR REPLACE FUNCTION public.retention_purge(p_cat text, p_dry_run boolean DEFAULT false, p_deleted_files jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE res jsonb; v_list text; v_cnt int;
BEGIN
  IF NOT is_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Nur für Admins.'); END IF;
  IF NOT p_dry_run THEN
    BEGIN
      res := _retention_purge_do(p_cat);
      -- Protokoll um die gelöschten Dateien ergänzen (Art · Mitarbeiter · Datum)
      IF COALESCE((res->>'success')::boolean, false) AND jsonb_typeof(p_deleted_files) = 'array' AND jsonb_array_length(p_deleted_files) > 0 THEN
        v_cnt := jsonb_array_length(p_deleted_files);
        SELECT string_agg(cnt || '× ' || kind || ' von ' || emp, ', ' ORDER BY emp, kind) INTO v_list FROM (
          SELECT LEFT(f->>'kind', 40) kind, LEFT(f->>'employee', 60) emp, count(*) cnt
          FROM jsonb_array_elements(p_deleted_files) f GROUP BY 1, 2) z;
        UPDATE activity_log SET
          summary = LEFT(regexp_replace(summary, ' \(0 Einträge\)\.$', '.'), 300) || ' Dateien: ' || v_cnt || ' (' || LEFT(v_list, 600) || ').',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('files', (
            SELECT jsonb_agg(jsonb_build_object('kind', LEFT(f->>'kind', 40), 'employee', LEFT(f->>'employee', 60),
                   'uploaded_at', f->>'uploaded_at', 'size', f->>'size')) FROM jsonb_array_elements(p_deleted_files) f))
        WHERE id = (SELECT id FROM activity_log WHERE action = 'retention.purged' AND actor_id = auth.uid() ORDER BY created_at DESC LIMIT 1);
        res := res || jsonb_build_object('files_logged', v_cnt);
      END IF;
      RETURN res;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
    END;
  END IF;
  BEGIN
    PERFORM set_config('app.retention_dry_run', 'on', true);
    res := _retention_purge_do(p_cat);
    IF NOT COALESCE((res->>'success')::boolean, false) THEN
      PERFORM set_config('app.retention_dry_run', '', true);
      RETURN res;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'dry-run';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      PERFORM set_config('app.retention_dry_run', '', true);
      RETURN jsonb_build_object('success', true, 'dry_run', true);
    WHEN OTHERS THEN
      PERFORM set_config('app.retention_dry_run', '', true);
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;
END $$;
REVOKE ALL ON FUNCTION public.retention_purge(text, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retention_purge(text, boolean, jsonb) TO authenticated;

-- Heutige Löschung der 9 verwaisten AU-Dateien nachträglich genau protokollieren
UPDATE public.activity_log SET
  summary = regexp_replace(summary, ' \(0 Einträge\)\.$', '.') || ' Dateien: 9 verwaiste AU-Bescheinigungen ohne zugehörige Krankmeldung (5× Mikail Ö., 2× Selina Y., 2× Can K.; hochgeladen 25.–28.06.2026, zus. ca. 35 MB).'
WHERE action = 'retention.purged' AND target_name = 'verwaist' AND summary NOT LIKE '%Dateien:%'
  AND created_at::date = '2026-09-24';
