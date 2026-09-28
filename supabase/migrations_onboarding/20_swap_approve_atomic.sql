-- ============================================================
-- 20 · Schichttausch: atomare Freigabe + erneute Anfrage möglich
-- • B1: UNIQUE(requester_shift_id) galt für ALLE Status → nach Ablehnung/Storno war für
--   diese Schicht nie wieder eine Anfrage möglich. Neu: eindeutig nur für laufende
--   Anfragen (open/accepted). Guard meldet Doppelanfragen mit klarer Meldung.
-- • B2: Freigabe lief als 3 getrennte Client-Updates (halber Tausch möglich).
--   Neu: approve_swap(p_swap_id) – eine Transaktion, alles oder nichts.
-- • B3: Bei der Freigabe wird erneut geprüft: Status 'accepted', Schichten gehören noch
--   Anfragendem bzw. Zielperson, liegen nicht in der Vergangenheit (Europe/Berlin).
--   Zeilen werden gesperrt (FOR UPDATE) → keine Doppel-Freigabe bei Parallelklick.
--   'approved' kann nur noch über approve_swap gesetzt werden (kein Status ohne Umbuchung).
-- • RLS-Policies unverändert. Neue Funktion: EXECUTE nur für authenticated (Rollenprüfung in der Funktion).
-- • Keine Datenänderung. Bestehende Daten erfüllen den neuen Index (bisher strenger eindeutig).
-- Bereits live eingespielt (Migration swap_approve_atomic, 2026-09-28) — NICHT erneut ausführen.
-- ============================================================

-- B1: Eindeutigkeit nur für laufende Anfragen
ALTER TABLE public.shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_requester_shift_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS shift_swap_requests_active_shift_key
  ON public.shift_swap_requests (requester_shift_id) WHERE status IN ('open','accepted');

-- Guard: unverändert bis auf (a) Freigabe nur über approve_swap, (b) klare Meldung bei Doppelanfrage
CREATE OR REPLACE FUNCTION public.swap_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE me uuid := my_employee_id();
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'
     AND COALESCE(current_setting('cafe.swap_approving', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Freigabe nur über die Freigabe-Funktion möglich.';
  END IF;
  IF is_manager_or_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'open'; NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.admin_note := NULL;
    IF NEW.target_id IS NULL OR NEW.target_id = NEW.requester_id THEN
      RAISE EXCEPTION 'Bitte eine andere Person auswählen.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM shifts WHERE id = NEW.requester_shift_id AND employee_id = NEW.requester_id
                   AND date >= (now() AT TIME ZONE 'Europe/Berlin')::date) THEN
      RAISE EXCEPTION 'Du kannst nur eigene, zukünftige Schichten tauschen.';
    END IF;
    IF NEW.target_shift_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM shifts WHERE id = NEW.target_shift_id AND employee_id = NEW.target_id) THEN
      RAISE EXCEPTION 'Die gewählte Gegenschicht gehört nicht zu dieser Person.';
    END IF;
    IF EXISTS (SELECT 1 FROM shift_swap_requests WHERE requester_shift_id = NEW.requester_shift_id
               AND status IN ('open','accepted')) THEN
      RAISE EXCEPTION 'Für diese Schicht läuft bereits eine Tauschanfrage.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'Diese Anfrage ist bereits abgeschlossen.'; END IF;
  IF me = OLD.requester_id AND NEW.status = 'cancelled' THEN NULL;
  ELSIF me = OLD.target_id AND NEW.status IN ('accepted','declined') THEN NULL;
  ELSE RAISE EXCEPTION 'Diese Änderung ist nicht erlaubt.';
  END IF;
  NEW.requester_id := OLD.requester_id; NEW.requester_shift_id := OLD.requester_shift_id;
  NEW.target_id := OLD.target_id; NEW.target_shift_id := OLD.target_shift_id;
  NEW.message := OLD.message; NEW.admin_note := OLD.admin_note;
  NEW.approved_by := OLD.approved_by; NEW.approved_at := OLD.approved_at;
  RETURN NEW;
END $$;

-- B2 + B3: Freigabe als eine Transaktion mit erneuter Prüfung
CREATE OR REPLACE FUNCTION public.approve_swap(p_swap_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  sw shift_swap_requests%ROWTYPE;
  today date := (now() AT TIME ZONE 'Europe/Berlin')::date;
BEGIN
  IF NOT is_manager_or_admin() THEN
    RAISE EXCEPTION 'Nur Admin oder Manager können einen Tausch freigeben.';
  END IF;
  SELECT * INTO sw FROM shift_swap_requests WHERE id = p_swap_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tauschanfrage nicht gefunden.'; END IF;
  IF sw.status <> 'accepted' THEN
    RAISE EXCEPTION 'Nur angenommene Tauschanfragen können freigegeben werden.';
  END IF;
  IF sw.target_id IS NULL OR sw.target_id = sw.requester_id THEN
    RAISE EXCEPTION 'Tauschanfrage ist unvollständig.';
  END IF;
  -- Schichten in fester Reihenfolge sperren (keine Deadlocks bei parallelen Freigaben)
  PERFORM 1 FROM shifts WHERE id IN (sw.requester_shift_id, sw.target_shift_id) ORDER BY id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM shifts WHERE id = sw.requester_shift_id
                 AND employee_id = sw.requester_id AND date >= today) THEN
    RAISE EXCEPTION 'Die angefragte Schicht wurde inzwischen geändert oder liegt in der Vergangenheit. Bitte Anfrage ablehnen.';
  END IF;
  IF sw.target_shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shifts WHERE id = sw.target_shift_id
                 AND employee_id = sw.target_id AND date >= today) THEN
    RAISE EXCEPTION 'Die Gegenschicht wurde inzwischen geändert oder liegt in der Vergangenheit. Bitte Anfrage ablehnen.';
  END IF;

  UPDATE shifts SET employee_id = sw.target_id WHERE id = sw.requester_shift_id;
  IF sw.target_shift_id IS NOT NULL THEN
    UPDATE shifts SET employee_id = sw.requester_id WHERE id = sw.target_shift_id;
  END IF;

  PERFORM set_config('cafe.swap_approving', 'on', true);
  UPDATE shift_swap_requests SET status = 'approved', approved_by = auth.uid(), approved_at = now()
   WHERE id = sw.id;
  PERFORM set_config('cafe.swap_approving', '', true);
END $$;
REVOKE ALL ON FUNCTION public.approve_swap(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_swap(uuid) TO authenticated;
