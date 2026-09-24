-- ============================================================
-- 13 · Inhaber-Schutz
-- Bereits live eingespielt (Migration protect_owner_account) — NICHT erneut ausführen.
-- Ein weiterer Admin kann Rolle, Status (Sperre) und Verknüpfung des Inhabers nicht
-- ändern und den Inhaber-Zugang nicht löschen. Das Kennzeichen is_owner ist über die
-- App nie änderbar (nur direkt in der Datenbank).
-- ============================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;
UPDATE public.profiles SET is_owner = true WHERE id = 'c8712929-e1a4-406b-a474-348e93a9edb1';

CREATE OR REPLACE FUNCTION public.protect_owner_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'INSERT' THEN NEW.is_owner := false; RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner AND auth.uid() <> OLD.id THEN
      RAISE EXCEPTION 'Der Zugang des Inhabers kann nur vom Inhaber selbst gelöscht werden.';
    END IF;
    RETURN OLD;
  END IF;
  NEW.is_owner := OLD.is_owner;
  IF OLD.is_owner AND auth.uid() <> OLD.id
     AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.employee_id IS DISTINCT FROM OLD.employee_id) THEN
    RAISE EXCEPTION 'Rolle und Zugang des Inhabers kann nur der Inhaber selbst ändern.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_owner_profile ON public.profiles;
CREATE TRIGGER trg_protect_owner_profile BEFORE INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_owner_profile();
REVOKE ALL ON FUNCTION public.protect_owner_profile() FROM PUBLIC, anon, authenticated;
