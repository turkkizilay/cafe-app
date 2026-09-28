-- ============================================================
-- 23 · Versionierte Kenntnisnahme der Datenschutzhinweise für Beschäftigte
-- • Neue Tabelle privacy_notice_acknowledgements: WER (profile_id) hat WELCHE Version
--   (notice_version, z. B. '2026-09-28') WANN (acknowledged_at, Serverzeit) zur Kenntnis genommen.
--   Historie bleibt erhalten (je Version ein Eintrag); keine IP-, GPS- oder Geräteangaben.
-- • Schreiben ausschließlich über acknowledge_privacy_notice(p_version): nur für das EIGENE Konto,
--   Zeitstempel vom Server, idempotent (Doppelklick/parallel → ein Eintrag, erster Zeitpunkt bleibt).
-- • Lesen: eigener Status; Admin sieht alle. Kein direktes INSERT/UPDATE/DELETE für Nutzer (auch nicht Manager/Admin).
-- • Kenntnisnahme, KEINE Einwilligung. Kein Backfill: alte Bestätigungen (employee_onboarding.privacy_accepted_at)
--   gelten NICHT als Kenntnisnahme der neuen Version – bestehende Konten sehen die Hinweise einmal.
-- • Additiv: keine bestehende Tabelle/Spalte/Funktion wird geändert.
-- Bereits live eingespielt (Migration privacy_notice_acknowledgements, 2026-09-28) — NICHT erneut ausführen.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.privacy_notice_acknowledgements (
  profile_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notice_version  text        NOT NULL CHECK (notice_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, notice_version)
);

ALTER TABLE public.privacy_notice_acknowledgements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_notice_acknowledgements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.privacy_notice_acknowledgements TO authenticated;

DROP POLICY IF EXISTS pna_select ON public.privacy_notice_acknowledgements;
CREATE POLICY pna_select ON public.privacy_notice_acknowledgements FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR is_admin());

CREATE OR REPLACE FUNCTION public.acknowledge_privacy_notice(p_version text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_at  timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Nicht angemeldet.'; END IF;
  IF p_version IS NULL OR p_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Ungültige Version der Datenschutzhinweise.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_uid AND status IN ('approved', 'pending')) THEN
    RAISE EXCEPTION 'Dein Konto ist nicht aktiv.';
  END IF;
  INSERT INTO privacy_notice_acknowledgements (profile_id, notice_version)
  VALUES (v_uid, p_version)
  ON CONFLICT (profile_id, notice_version) DO NOTHING;
  SELECT a.acknowledged_at INTO v_at FROM privacy_notice_acknowledgements a
   WHERE a.profile_id = v_uid AND a.notice_version = p_version;
  RETURN jsonb_build_object('version', p_version, 'acknowledged_at', v_at);
END $$;
REVOKE ALL ON FUNCTION public.acknowledge_privacy_notice(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_privacy_notice(text) TO authenticated;
