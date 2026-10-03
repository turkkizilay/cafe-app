-- ============================================================
-- 33 · Krankheitsfälle (Phase A): zusammenhängende Krankmeldungen bewusst zu Fällen zuordnen
-- (additiv, kein Backfill, keine Datenänderung, KEINE Lohnwirkung)
-- Drei getrennte Ebenen:
--   1. Zeitlicher Zusammenhang  → wird NUR im Client als Vorschlag berechnet (nie gespeichert, nie bindend).
--   2. Bestätigter Fall         → sick_cases + sick_leave.case_id; nur Admin per RPC, mit Protokoll.
--   3. Beziehung zwischen Fällen → sick_case_relations: neue Erkrankung / Fortsetzung derselben Erkrankung;
--                                  nur Admin, Pflicht: Quelle (Kategorie) + kurze Begründung. Keine Diagnose.
-- Ein Fall sagt NICHTS über die Krankheit aus (auch verschiedene Krankheiten ohne Genesung dazwischen = ein Fall,
-- BAG 11.12.2019 – 5 AZR 505/18). „Gleiche Krankheit“ gibt es nur als ausdrückliche Admin-Entscheidung (Ebene 3).
-- eau_kind (Erst-/Folgemeldung laut eAU) ist ein optionales, rein informatives Merkmal – es entscheidet nie über
-- Zuordnung oder Fortsetzung.
-- Lohn/DATEV lesen sick_cases, sick_case_relations, case_id und eau_kind in Phase A NICHT; continued_pay_end und
-- alle Berechnungen bleiben exakt wie bisher. Abgeschlossene Monate (payroll_months) werden nicht berührt.
-- Sichtbarkeit: Fälle (Gruppierung) Manager + Admin; Beziehungen (Gesundheitsinformation) nur Admin;
-- Mitarbeiter sehen keine Fälle. Direkte Schreibzugriffe gesperrt – nur über die Admin-RPCs.
-- Rückweg: RPCs, Trigger und die beiden Tabellen löschen, Spalten case_id/eau_kind entfernen (enthalten nur
-- Phase-A-Entscheidungen; Lohn unabhängig davon).
-- Wiederholt ausführbar.
-- Bereits live eingespielt (Migration sick_cases_phase_a, Version 20261002090703; 52 Objekte inkl. aller
-- pg_get_functiondef identisch mit dieser Datei) — NICHT erneut ausführen.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sick_cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  revision     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sick_cases_employee_idx ON public.sick_cases (employee_id);

CREATE TABLE IF NOT EXISTS public.sick_case_relations (
  case_id       uuid PRIMARY KEY REFERENCES public.sick_cases(id) ON DELETE CASCADE,
  relation      text NOT NULL CHECK (relation IN ('new_illness', 'same_illness')),
  prior_case_id uuid REFERENCES public.sick_cases(id) ON DELETE CASCADE,
  basis         text NOT NULL CHECK (basis IN ('kk_auskunft', 'lohnbuero', 'arbeitnehmer', 'sonstiges')),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 200),
  decided_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sick_case_relations_prior_needed CHECK (relation <> 'same_illness' OR prior_case_id IS NOT NULL),
  CONSTRAINT sick_case_relations_not_self CHECK (prior_case_id IS NULL OR prior_case_id <> case_id)
);

ALTER TABLE public.sick_leave ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES public.sick_cases(id) ON DELETE SET NULL;
ALTER TABLE public.sick_leave ADD COLUMN IF NOT EXISTS eau_kind text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sick_leave_eau_kind_check') THEN
    ALTER TABLE public.sick_leave ADD CONSTRAINT sick_leave_eau_kind_check CHECK (eau_kind IS NULL OR eau_kind IN ('erst', 'folge'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS sick_leave_case_idx ON public.sick_leave (case_id);

-- ── Zugriff: lesen per RLS, schreiben nur über die RPCs ─────────
ALTER TABLE public.sick_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sick_case_relations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sick_cases, public.sick_case_relations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sick_cases, public.sick_case_relations TO authenticated;
DROP POLICY IF EXISTS sick_cases_read ON public.sick_cases;
CREATE POLICY sick_cases_read ON public.sick_cases FOR SELECT TO authenticated USING (public.is_manager_or_admin());
DROP POLICY IF EXISTS sick_case_relations_read ON public.sick_case_relations;
CREATE POLICY sick_case_relations_read ON public.sick_case_relations FOR SELECT TO authenticated USING (public.is_admin());

-- case_id / eau_kind sind über die bestehenden UPDATE-Policies (Manager, eigener Nachweis-Upload) erreichbar →
-- eigener Guard: Änderung nur innerhalb der Admin-RPCs (transaktionslokales Flag + Admin live geprüft) oder im
-- Systemkontext (Löschung/Aufbewahrung über Fremdschlüssel).
CREATE OR REPLACE FUNCTION public.sick_leave_case_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(current_setting('cafe.sick_case', true), '') = 'on' AND is_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.case_id IS NOT NULL OR NEW.eau_kind IS NOT NULL THEN
      RAISE EXCEPTION 'Fall-Zuordnung und eAU-Merkmal können nur von Admins über die Fallverwaltung gesetzt werden.' USING HINT = 'sick_case_admin_only';
    END IF;
  ELSIF NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.eau_kind IS DISTINCT FROM OLD.eau_kind THEN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- Systemkontext (z. B. ON DELETE SET NULL beim Aufräumen)
    RAISE EXCEPTION 'Fall-Zuordnung und eAU-Merkmal können nur von Admins über die Fallverwaltung geändert werden.' USING HINT = 'sick_case_admin_only';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.sick_leave_case_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_sick_leave_case_guard ON public.sick_leave;
CREATE TRIGGER trg_sick_leave_case_guard BEFORE INSERT OR UPDATE ON public.sick_leave
  FOR EACH ROW EXECUTE FUNCTION public.sick_leave_case_guard();

-- Leere Fälle nicht stehen lassen (Krankmeldung gelöscht – auch durch Mitarbeiter/Aufbewahrung – oder umgehängt)
CREATE OR REPLACE FUNCTION public.sick_cases_cleanup()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.case_id IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.case_id IS DISTINCT FROM OLD.case_id)
     AND NOT EXISTS (SELECT 1 FROM sick_leave WHERE case_id = OLD.case_id) THEN
    DELETE FROM sick_cases WHERE id = OLD.case_id;
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.sick_cases_cleanup() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_sick_cases_cleanup ON public.sick_leave;
CREATE TRIGGER trg_sick_cases_cleanup AFTER DELETE OR UPDATE OF case_id ON public.sick_leave
  FOR EACH ROW EXECUTE FUNCTION public.sick_cases_cleanup();

-- ── Hilfen ───────────────────────────────────────────────────
-- Pflichtprotokoll (Fehler → ganze Aktion zurück). Keine Begründungstexte, keine medizinischen Angaben.
CREATE OR REPLACE FUNCTION public._sick_case_log(p_action text, p_summary text, p_case uuid, p_employee uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_actor text; v_role text; v_emp text;
BEGIN
  SELECT COALESCE(NULLIF(TRIM(CONCAT(first_name,' ',last_name)),''), email), role INTO v_actor, v_role FROM profiles WHERE id = auth.uid();
  SELECT CONCAT(first_name,' ',last_name) INTO v_emp FROM employees WHERE id = p_employee;
  INSERT INTO activity_log (actor_id, actor_name, actor_role, action, category, summary, target_type, target_id, target_name)
  VALUES (auth.uid(), v_actor, v_role, p_action, 'sick_leave', COALESCE(v_actor, 'Admin') || ' ' || p_summary, 'sick_case', p_case::text, v_emp);
END $function$;
REVOKE ALL ON FUNCTION public._sick_case_log(text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._sick_case_admin()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'Krankheitsfälle können nur Admins zuordnen.' USING HINT = 'sick_case_admin_only';
  END IF;
  PERFORM set_config('cafe.sick_case', 'on', true);
END $function$;
REVOKE ALL ON FUNCTION public._sick_case_admin() FROM PUBLIC, anon, authenticated;

-- Ein Fall darf keine Lücke überspannen, in der die Person nachweislich gearbeitet hat (dann war die AU beendet).
CREATE OR REPLACE FUNCTION public._sick_case_worked_gap(p_case uuid)
 RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT employee_id, start_date, end_date,
           max(COALESCE(end_date, 'infinity'::date)) OVER (ORDER BY start_date ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM sick_leave WHERE case_id = p_case)
  SELECT min(t.date) FROM r JOIN time_entries t ON t.employee_id = r.employee_id
   WHERE r.prev_end IS NOT NULL AND r.prev_end <> 'infinity'::date
     AND t.date > r.prev_end AND t.date < r.start_date
$function$;
REVOKE ALL ON FUNCTION public._sick_case_worked_gap(uuid) FROM PUBLIC, anon, authenticated;

-- ── RPCs (nur Admin) ─────────────────────────────────────────
-- Krankmeldungen bewusst einem (neuen oder bestehenden) Fall zuordnen
CREATE OR REPLACE FUNCTION public.admin_confirm_sick_case(p_record_ids uuid[], p_case_id uuid DEFAULT NULL, p_expected_revision integer DEFAULT NULL)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid; v_n int; v_case sick_cases%ROWTYPE; v_gap date; v_new boolean := p_case_id IS NULL;
BEGIN
  PERFORM _sick_case_admin();
  IF p_record_ids IS NULL OR cardinality(p_record_ids) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Bitte mindestens eine Krankmeldung auswählen.', 'code', 'empty');
  END IF;
  PERFORM 1 FROM sick_leave WHERE id = ANY(p_record_ids) ORDER BY id FOR UPDATE;
  SELECT count(*), min(employee_id::text)::uuid INTO v_n, v_emp FROM sick_leave WHERE id = ANY(p_record_ids);
  IF v_n <> cardinality(ARRAY(SELECT DISTINCT unnest(p_record_ids))) THEN
    RETURN json_build_object('success', false, 'error', 'Eine Krankmeldung wurde nicht gefunden (inzwischen gelöscht?).', 'code', 'missing');
  END IF;
  IF (SELECT count(DISTINCT employee_id) FROM sick_leave WHERE id = ANY(p_record_ids)) > 1 THEN
    RETURN json_build_object('success', false, 'error', 'Ein Fall kann nur Krankmeldungen derselben Person enthalten.', 'code', 'mixed_employees');
  END IF;
  IF NOT v_new THEN
    SELECT * INTO v_case FROM sick_cases WHERE id = p_case_id FOR UPDATE;
    IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Der Fall existiert nicht mehr.', 'code', 'case_missing'); END IF;
    IF v_case.employee_id <> v_emp THEN RETURN json_build_object('success', false, 'error', 'Ein Fall kann nur Krankmeldungen derselben Person enthalten.', 'code', 'mixed_employees'); END IF;
    IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_case.revision THEN
      RETURN json_build_object('success', false, 'conflict', true, 'revision', v_case.revision, 'error', 'Der Fall wurde inzwischen geändert. Bitte neu laden.', 'code', 'conflict');
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM sick_leave WHERE id = ANY(p_record_ids) AND case_id IS NOT NULL AND case_id IS DISTINCT FROM p_case_id) THEN
    RETURN json_build_object('success', false, 'error', 'Eine Krankmeldung gehört bereits zu einem anderen Fall. Bitte dort zuerst entfernen.', 'code', 'other_case');
  END IF;
  IF v_new THEN
    INSERT INTO sick_cases (employee_id, confirmed_by) VALUES (v_emp, auth.uid()) RETURNING * INTO v_case;
  END IF;
  UPDATE sick_leave SET case_id = v_case.id WHERE id = ANY(p_record_ids);
  v_gap := _sick_case_worked_gap(v_case.id);
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION 'Zwischen diesen Krankmeldungen wurde gearbeitet (%). Das sind getrennte Fälle.', to_char(v_gap, 'DD.MM.YYYY') USING HINT = 'worked_gap';
  END IF;
  UPDATE sick_cases SET revision = revision + 1, confirmed_by = auth.uid(), confirmed_at = now() WHERE id = v_case.id RETURNING * INTO v_case;
  PERFORM _sick_case_log('sick_case.confirmed',
    'hat ' || cardinality(p_record_ids) || ' Krankmeldung(en) ' || CASE WHEN v_new THEN 'als einen Krankheitsfall bestätigt.' ELSE 'einem bestehenden Krankheitsfall zugeordnet.' END,
    v_case.id, v_emp);
  RETURN json_build_object('success', true, 'case_id', v_case.id, 'revision', v_case.revision);
END $function$;

-- Krankmeldungen aus einem Fall lösen (leerer Fall verschwindet, Beziehungen darauf ebenfalls)
CREATE OR REPLACE FUNCTION public.admin_remove_from_sick_case(p_record_ids uuid[], p_expected_revision integer DEFAULT NULL)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_case sick_cases%ROWTYPE; v_ids uuid[];
BEGIN
  PERFORM _sick_case_admin();
  SELECT array_agg(DISTINCT case_id) INTO v_ids FROM sick_leave WHERE id = ANY(p_record_ids);
  IF v_ids IS NULL OR cardinality(v_ids) <> 1 OR v_ids[1] IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Die Krankmeldungen gehören nicht zu genau einem Fall.', 'code', 'not_one_case');
  END IF;
  SELECT * INTO v_case FROM sick_cases WHERE id = v_ids[1] FOR UPDATE;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_case.revision THEN
    RETURN json_build_object('success', false, 'conflict', true, 'revision', v_case.revision, 'error', 'Der Fall wurde inzwischen geändert. Bitte neu laden.', 'code', 'conflict');
  END IF;
  PERFORM _sick_case_log('sick_case.records_removed', 'hat ' || cardinality(p_record_ids) || ' Krankmeldung(en) aus einem Krankheitsfall gelöst.', v_case.id, v_case.employee_id);
  UPDATE sick_leave SET case_id = NULL WHERE id = ANY(p_record_ids);
  UPDATE sick_cases SET revision = revision + 1 WHERE id = v_case.id;
  RETURN json_build_object('success', true, 'case_id', v_case.id, 'case_deleted', NOT EXISTS (SELECT 1 FROM sick_cases WHERE id = v_case.id));
END $function$;

-- Beziehung eines Falls zu einem früheren Fall: unknown (löscht) | new_illness | same_illness
CREATE OR REPLACE FUNCTION public.admin_set_sick_case_relation(p_case_id uuid, p_relation text, p_prior_case_id uuid DEFAULT NULL,
  p_basis text DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_revision integer DEFAULT NULL)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_case sick_cases%ROWTYPE; v_prior sick_cases%ROWTYPE; v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  PERFORM _sick_case_admin();
  SELECT * INTO v_case FROM sick_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Der Fall existiert nicht mehr.', 'code', 'case_missing'); END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_case.revision THEN
    RETURN json_build_object('success', false, 'conflict', true, 'revision', v_case.revision, 'error', 'Der Fall wurde inzwischen geändert. Bitte neu laden.', 'code', 'conflict');
  END IF;
  IF p_relation = 'unknown' THEN
    DELETE FROM sick_case_relations WHERE case_id = p_case_id;
  ELSIF p_relation IN ('new_illness', 'same_illness') THEN
    IF p_basis IS NULL OR p_basis NOT IN ('kk_auskunft', 'lohnbuero', 'arbeitnehmer', 'sonstiges') THEN
      RETURN json_build_object('success', false, 'error', 'Bitte eine Quelle für die Entscheidung angeben.', 'code', 'basis');
    END IF;
    IF char_length(v_reason) < 5 OR char_length(v_reason) > 200 THEN
      RETURN json_build_object('success', false, 'error', 'Bitte eine kurze Begründung angeben (5–200 Zeichen, keine Diagnose).', 'code', 'reason');
    END IF;
    IF p_relation = 'same_illness' AND p_prior_case_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Bitte den früheren Fall auswählen, der fortgesetzt wird.', 'code', 'prior');
    END IF;
    IF p_prior_case_id IS NOT NULL THEN
      SELECT * INTO v_prior FROM sick_cases WHERE id = p_prior_case_id;
      IF NOT FOUND OR v_prior.employee_id <> v_case.employee_id OR p_prior_case_id = p_case_id
         OR (SELECT min(start_date) FROM sick_leave WHERE case_id = p_prior_case_id) >= (SELECT min(start_date) FROM sick_leave WHERE case_id = p_case_id) THEN
        RETURN json_build_object('success', false, 'error', 'Der frühere Fall muss derselben Person gehören und vorher begonnen haben.', 'code', 'prior');
      END IF;
    END IF;
    INSERT INTO sick_case_relations (case_id, relation, prior_case_id, basis, reason, decided_by)
    VALUES (p_case_id, p_relation, p_prior_case_id, p_basis, v_reason, auth.uid())
    ON CONFLICT (case_id) DO UPDATE SET relation = EXCLUDED.relation, prior_case_id = EXCLUDED.prior_case_id, basis = EXCLUDED.basis,
      reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by, decided_at = now();
  ELSE
    RETURN json_build_object('success', false, 'error', 'Unbekannte Beziehung.', 'code', 'relation');
  END IF;
  UPDATE sick_cases SET revision = revision + 1 WHERE id = p_case_id RETURNING * INTO v_case;
  PERFORM _sick_case_log('sick_case.relation_set',
    'hat für einen Krankheitsfall die Beziehung „' || CASE p_relation WHEN 'same_illness' THEN 'Fortsetzung derselben Erkrankung' WHEN 'new_illness' THEN 'neue Erkrankung' ELSE 'ungeklärt' END
    || '“ vermerkt' || CASE WHEN p_relation <> 'unknown' THEN ' (Quelle: ' || p_basis || ').' ELSE '.' END,
    p_case_id, v_case.employee_id);
  RETURN json_build_object('success', true, 'revision', v_case.revision);
END $function$;

-- Optionales eAU-Merkmal (Erst-/Folgemeldung) – rein informativ
CREATE OR REPLACE FUNCTION public.admin_set_sick_eau_kind(p_record_id uuid, p_kind text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_emp uuid;
BEGIN
  PERFORM _sick_case_admin();
  IF p_kind IS NOT NULL AND p_kind NOT IN ('erst', 'folge') THEN
    RETURN json_build_object('success', false, 'error', 'Unbekanntes eAU-Merkmal.', 'code', 'kind');
  END IF;
  UPDATE sick_leave SET eau_kind = p_kind WHERE id = p_record_id RETURNING employee_id INTO v_emp;
  IF v_emp IS NULL THEN RETURN json_build_object('success', false, 'error', 'Krankmeldung nicht gefunden.', 'code', 'missing'); END IF;
  PERFORM _sick_case_log('sick_case.eau_kind_set', 'hat bei einer Krankmeldung das eAU-Merkmal „' || COALESCE(p_kind, '–') || '“ vermerkt.', NULL, v_emp);
  RETURN json_build_object('success', true);
END $function$;

REVOKE ALL ON FUNCTION public.admin_confirm_sick_case(uuid[], uuid, integer), public.admin_remove_from_sick_case(uuid[], integer),
  public.admin_set_sick_case_relation(uuid, text, uuid, text, text, integer), public.admin_set_sick_eau_kind(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_sick_case(uuid[], uuid, integer), public.admin_remove_from_sick_case(uuid[], integer),
  public.admin_set_sick_case_relation(uuid, text, uuid, text, text, integer), public.admin_set_sick_eau_kind(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
