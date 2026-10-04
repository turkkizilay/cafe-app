-- ============================================================
-- 39 · Aktivitätsprotokoll: 12-Monats-Frist serverseitig durchsetzen
-- Datenschutzhinweise (src/legal/legalContent.js): „Protokolleinträge 12 Monate“. Bisher rief nur die Protokoll-Seite im
-- Browser cleanup_old_activity_logs() auf – das darf (richtig so) nur der Server: Die Funktion ist SECURITY DEFINER ohne
-- Admin-Prüfung, EXECUTE haben nur postgres/service_role → im Browser immer 403, die Frist wurde nie durchgesetzt.
-- Jetzt: täglicher pg_cron-Job (läuft als postgres, wie cafe-weekly-backup), Browser-Aufruf entfernt.
-- • Funktion unverändert (löscht activity_log-Einträge älter als 12 Monate); Rechte nur bestätigt, keine neuen.
-- • Keine Datenänderung durch die Migration selbst (der erste Lauf löscht erst, wenn Einträge älter als 12 Monate sind:
--   ältester Eintrag 12.07.2026 → frühestens ab 12.07.2027).
-- • Wiederholt ausführbar (vorhandener Job gleichen Namens wird ersetzt).
-- Rückbau: SELECT cron.unschedule('cafe-activity-log-retention');
-- Bereits live eingespielt (Migration activity_log_retention_job, Version 20261004095208, 2026-10-04; angewendet mit dem
-- byte-gleichen Inhalt dieser Datei vor diesem Vermerk, sha256 93fa6839…f8dde0; Job jobid 3 als postgres, Rechte und
-- 177 Protokolleinträge unverändert verifiziert) — NICHT erneut ausführen.
-- ============================================================

REVOKE ALL ON FUNCTION public.cleanup_old_activity_logs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_activity_logs() TO service_role;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cafe-activity-log-retention';
SELECT cron.schedule('cafe-activity-log-retention', '30 3 * * *', $cron$SELECT public.cleanup_old_activity_logs()$cron$);
