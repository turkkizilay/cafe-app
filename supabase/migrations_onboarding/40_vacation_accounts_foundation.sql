-- ============================================================
-- 40 · Urlaubskonten – Phase 1: unsichtbares, auditierbares Fundament (Vacation System 2.0)
--
-- NUR ADDITIV. Keine bestehende Tabelle, Spalte, Funktion, Policy oder Zeile wird geändert. Die bisherige
-- Urlaubsberechnung (src/lib/vacationLogic.js aus vacation_requests + employees.vacation_days_per_year) bleibt
-- alleinige Quelle für alles, was die App anzeigt, prüft und genehmigt. Diese Tabellen werden von keinem
-- bestehenden Ablauf gelesen oder geschrieben; Phase 1 legt KEINE Daten an (keine Rückfüllung).
--
-- Grundsätze (Festlegungen vom 07.10.2026):
--  • Kein automatischer Verfall, keine automatische Jahreswechsel-/Eintritts-/Austrittsberechnung, keine Rundung,
--    keine automatische Trennung gesetzlich/vertraglich – dafür gibt es hier bewusst keine Logik.
--  • Nichts wird still gelöscht: Buchungen, Zuordnungen und Anspruchsstände sind „nur anhängen“ (Trigger sperren
--    UPDATE/DELETE/TRUNCATE – auch für den Datenbank-Owner). Korrektur = Gegenbuchung bzw. Nachfolgezeile.
--  • Abgeschlossene Jahre sind unveränderlich (Konto: nur einmaliger Übergang offen → abgeschlossen).
--  • Least Privilege: Browser-Rollen dürfen nichts schreiben; lesen darf in Phase 1 nur der Admin (es gibt noch
--    keine Anzeige für Mitarbeiter/Manager – Sichtbarkeit ist Business-Entscheidung B10). Schreiben später nur über
--    geprüfte SECURITY-DEFINER-Funktionen (Phase 3), nicht in dieser Migration.
--  • Keine Gesundheitsdaten: keine Diagnose-/Attestfelder; Freitext nur als kurzer Pflicht-Grund (≤ 500 Zeichen).
--  • Akteur = auth.uid() bzw. 00000000-0000-0000-0000-000000000000 für „System/Migration“ – bewusst OHNE
--    Fremdschlüssel, damit ein gelöschtes Login die Buchungshistorie nicht verändert.
--  • Kein Fremdschlüssel auf vacation_requests: die Löschfristen (alte Anträge) laufen unverändert weiter, die
--    festgeschriebene Zuordnung bleibt erhalten. Auf employees: ON DELETE RESTRICT – eine Person mit Urlaubskonto
--    wird nie still mitgelöscht (Vorgang bricht laut ab). Ohne Konten (Stand Phase 1) ändert sich nichts.
--
-- Wiederholt ausführbar (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS vor CREATE).
-- Rückbau (nur solange alle vier Tabellen LEER sind – sonst vorher exportieren, siehe Bericht):
--   DROP TABLE public.vacation_request_allocations, public.vacation_ledger, public.vacation_entitlement_terms, public.vacation_accounts;
--   DROP FUNCTION public._vacation_append_only(), public._vacation_account_guard(), public._vacation_ledger_check(),
--                 public._vacation_allocation_check(), public._vacation_term_check();
-- ============================================================

-- ── 1. Jahreskonto (Kopf): eines je Person und Kalenderjahr ─────────────────
CREATE TABLE IF NOT EXISTS public.vacation_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'closed_exit')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  opened_by   uuid NOT NULL,
  closed_at   timestamptz,
  closed_by   uuid,
  snapshot    jsonb,   -- Stand beim Abschluss (Anspruch, Übertrag, Verbrauch, Rest, Berechnungsbasis) – nur Zahlen/Verweise
  CONSTRAINT vacation_accounts_employee_year_key UNIQUE (employee_id, year),
  CONSTRAINT vacation_accounts_close_consistent CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by IS NULL AND snapshot IS NULL) OR
    (status <> 'open' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND snapshot IS NOT NULL)),
  CONSTRAINT vacation_accounts_snapshot_shape CHECK (snapshot IS NULL OR (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 20000))
);

-- ── 2. Anspruchsstände (Historie, gültig ab Datum) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.vacation_entitlement_terms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  valid_from        date NOT NULL CHECK (valid_from >= DATE '2000-01-01'),
  days_per_year     numeric(6,2) NOT NULL CHECK (days_per_year >= 0 AND days_per_year <= 366),
  workdays_per_week numeric(3,1) CHECK (workdays_per_week IS NULL OR (workdays_per_week > 0 AND workdays_per_week <= 7)),
  weekday_mask      smallint CHECK (weekday_mask IS NULL OR weekday_mask BETWEEN 1 AND 127),   -- Bit 0 = Mo … Bit 6 = So
  reason            text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  supersedes_id     uuid UNIQUE REFERENCES public.vacation_entitlement_terms(id) ON DELETE RESTRICT,   -- Korrektur = Nachfolgezeile
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Buchungsjournal (nur anhängen) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vacation_ledger (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  account_year integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('entitlement', 'entitlement_adjustment', 'opening_balance',
                                             'carry_in', 'carry_out', 'manual_adjustment', 'reversal')),
  days         numeric(6,2) NOT NULL CHECK (days <> 0 AND abs(days) <= 366),
  related_year integer CHECK (related_year IS NULL OR related_year BETWEEN 2000 AND 2100),   -- Herkunft (carry_in/opening) bzw. Ziel (carry_out)
  basis        jsonb CHECK (basis IS NULL OR (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 10000)),   -- technischer Vorschlag + Rechenweg
  reason       text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  reverses_id  uuid UNIQUE REFERENCES public.vacation_ledger(id) ON DELETE RESTRICT,   -- höchstens eine Gegenbuchung je Buchung
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vacation_ledger_account_fk FOREIGN KEY (employee_id, account_year)
    REFERENCES public.vacation_accounts(employee_id, year) ON DELETE RESTRICT,
  CONSTRAINT vacation_ledger_kind_rules CHECK (
    (kind = 'entitlement'            AND days > 0 AND related_year IS NULL AND reverses_id IS NULL) OR
    (kind = 'entitlement_adjustment' AND related_year IS NULL AND reverses_id IS NULL) OR
    (kind = 'opening_balance'        AND (related_year IS NULL OR related_year < account_year) AND reverses_id IS NULL) OR
    (kind = 'carry_in'               AND days > 0 AND related_year IS NOT NULL AND related_year < account_year AND reverses_id IS NULL) OR
    (kind = 'carry_out'              AND days < 0 AND related_year IS NOT NULL AND related_year > account_year AND reverses_id IS NULL) OR
    (kind = 'manual_adjustment'      AND related_year IS NULL AND reverses_id IS NULL) OR
    (kind = 'reversal'               AND related_year IS NULL AND reverses_id IS NOT NULL))
);

-- ── 4. Verbrauch je Antrag und Kalenderjahr (festgeschrieben, nur anhängen) ─
CREATE TABLE IF NOT EXISTS public.vacation_request_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL,   -- vacation_requests.id – bewusst ohne FK (Löschfristen bleiben unberührt)
  employee_id   uuid NOT NULL,
  account_year  integer NOT NULL,
  days          numeric(6,2) NOT NULL CHECK (days >= 0 AND days <= 366),
  computed_with jsonb NOT NULL CHECK (jsonb_typeof(computed_with) = 'object' AND octet_length(computed_with::text) <= 10000),
  supersedes_id uuid UNIQUE REFERENCES public.vacation_request_allocations(id) ON DELETE RESTRICT,   -- Neuberechnung = Nachfolgezeile
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vacation_allocations_account_fk FOREIGN KEY (employee_id, account_year)
    REFERENCES public.vacation_accounts(employee_id, year) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS vacation_ledger_account_idx      ON public.vacation_ledger (employee_id, account_year);
CREATE INDEX IF NOT EXISTS vacation_allocations_request_idx ON public.vacation_request_allocations (request_id, account_year);
CREATE INDEX IF NOT EXISTS vacation_allocations_account_idx ON public.vacation_request_allocations (employee_id, account_year);
CREATE INDEX IF NOT EXISTS vacation_terms_employee_idx      ON public.vacation_entitlement_terms (employee_id, valid_from);
-- Keine Doppelbuchung (z. B. Jahresabschluss zweimal / gleichzeitig): je Konto genau EIN Jahresanspruch, je Herkunfts-
-- bzw. Zieljahr genau EIN Übertrag. Korrekturen laufen über entitlement_adjustment / manual_adjustment / reversal.
CREATE UNIQUE INDEX IF NOT EXISTS vacation_ledger_one_entitlement ON public.vacation_ledger (employee_id, account_year) WHERE kind = 'entitlement';
CREATE UNIQUE INDEX IF NOT EXISTS vacation_ledger_one_carry_in    ON public.vacation_ledger (employee_id, account_year, related_year) WHERE kind = 'carry_in';
CREATE UNIQUE INDEX IF NOT EXISTS vacation_ledger_one_carry_out   ON public.vacation_ledger (employee_id, account_year, related_year) WHERE kind = 'carry_out';

-- ── Schutz: nur anhängen (gilt für ALLE Rollen inkl. Owner; Trigger feuern auch für Superuser) ─────────────
CREATE OR REPLACE FUNCTION public._vacation_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'Urlaubskonto: % ist nicht erlaubt – Einträge werden nie geändert oder gelöscht (Korrektur nur per Gegenbuchung/Nachfolgezeile).', TG_OP
    USING ERRCODE = '42501', HINT = 'vacation_append_only';
END $$;

-- Konto: Löschen gesperrt; Ändern nur einmalig offen → abgeschlossen (alle übrigen Felder unverändert)
CREATE OR REPLACE FUNCTION public._vacation_account_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Urlaubskonto: % ist nicht erlaubt – Jahreskonten werden nie gelöscht.', TG_OP USING ERRCODE = '42501', HINT = 'vacation_append_only';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Urlaubskonto %/% ist abgeschlossen und bleibt unverändert.', OLD.employee_id, OLD.year USING ERRCODE = '42501', HINT = 'vacation_account_closed';
  END IF;
  IF NEW.status = 'open' OR NEW.id <> OLD.id OR NEW.employee_id <> OLD.employee_id OR NEW.year <> OLD.year
     OR NEW.opened_at <> OLD.opened_at OR NEW.opened_by <> OLD.opened_by THEN
    RAISE EXCEPTION 'Urlaubskonto: nur der Abschluss (offen → abgeschlossen) ist änderbar.' USING ERRCODE = '42501', HINT = 'vacation_account_immutable';
  END IF;
  RETURN NEW;
END $$;

-- Gegenbuchung: hebt genau eine Buchung desselben Kontos exakt auf (keine Kette von Gegenbuchungen)
CREATE OR REPLACE FUNCTION public._vacation_ledger_check()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE o vacation_ledger%ROWTYPE; st text;
BEGIN
  IF NEW.kind = 'reversal' THEN
    SELECT * INTO o FROM vacation_ledger WHERE id = NEW.reverses_id;
    IF NOT FOUND OR o.employee_id <> NEW.employee_id OR o.account_year <> NEW.account_year THEN
      RAISE EXCEPTION 'Gegenbuchung muss eine Buchung desselben Urlaubskontos aufheben.' USING HINT = 'vacation_reversal_target';
    END IF;
    IF o.kind = 'reversal' THEN RAISE EXCEPTION 'Eine Gegenbuchung kann nicht erneut aufgehoben werden.' USING HINT = 'vacation_reversal_chain'; END IF;
    IF NEW.days <> -o.days THEN RAISE EXCEPTION 'Gegenbuchung muss genau % Tage betragen.', -o.days USING HINT = 'vacation_reversal_amount'; END IF;
  END IF;
  -- Kontozeile sperren (FOR SHARE, unabhängig vom Status), dann prüfen: ein gleichzeitiger Abschluss wartet auf diese
  -- Buchung oder wird hier bereits als „abgeschlossen“ gesehen – keine Buchung rutscht in ein abgeschlossenes Jahr
  SELECT a.status INTO st FROM vacation_accounts a WHERE a.employee_id = NEW.employee_id AND a.year = NEW.account_year FOR SHARE;
  IF st IS DISTINCT FROM 'open' AND st IS NOT NULL THEN
    RAISE EXCEPTION 'Urlaubskonto %/% ist abgeschlossen – Buchungen nur im offenen Jahr.', NEW.employee_id, NEW.account_year USING HINT = 'vacation_account_closed';
  END IF;
  RETURN NEW;
END $$;

-- Zuordnung: je Antrag und Jahr gilt genau eine aktuelle Zeile; Neuberechnung muss die aktuelle ausdrücklich ablösen
CREATE OR REPLACE FUNCTION public._vacation_allocation_check()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE cur uuid; s vacation_request_allocations%ROWTYPE; st text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vacation_alloc:' || NEW.request_id::text || ':' || NEW.account_year, 0));
  SELECT a.id INTO cur FROM vacation_request_allocations a
   WHERE a.request_id = NEW.request_id AND a.account_year = NEW.account_year
     AND NOT EXISTS (SELECT 1 FROM vacation_request_allocations b WHERE b.supersedes_id = a.id);
  IF cur IS NOT NULL AND NEW.supersedes_id IS DISTINCT FROM cur THEN
    RAISE EXCEPTION 'Für diesen Antrag und dieses Jahr gibt es bereits eine Zuordnung – nur ausdrückliche Ablösung erlaubt.' USING HINT = 'vacation_allocation_current';
  END IF;
  IF cur IS NULL AND NEW.supersedes_id IS NOT NULL THEN
    RAISE EXCEPTION 'Abgelöste Zuordnung ist nicht die aktuelle.' USING HINT = 'vacation_allocation_current';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO s FROM vacation_request_allocations WHERE id = NEW.supersedes_id;
    IF s.employee_id <> NEW.employee_id THEN RAISE EXCEPTION 'Ablösung nur innerhalb derselben Person.' USING HINT = 'vacation_allocation_current'; END IF;
  END IF;
  SELECT a.status INTO st FROM vacation_accounts a WHERE a.employee_id = NEW.employee_id AND a.year = NEW.account_year FOR SHARE;
  IF st IS DISTINCT FROM 'open' AND st IS NOT NULL THEN
    RAISE EXCEPTION 'Urlaubskonto %/% ist abgeschlossen – keine neue Zuordnung.', NEW.employee_id, NEW.account_year USING HINT = 'vacation_account_closed';
  END IF;
  RETURN NEW;
END $$;

-- Anspruchsstand: Nachfolgezeile nur für dieselbe Person
CREATE OR REPLACE FUNCTION public._vacation_term_check()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM vacation_entitlement_terms t WHERE t.id = NEW.supersedes_id AND t.employee_id = NEW.employee_id) THEN
    RAISE EXCEPTION 'Ein Anspruchsstand kann nur einen Stand derselben Person ablösen.' USING HINT = 'vacation_term_supersede';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vacation_ledger_append_only ON public.vacation_ledger;
CREATE TRIGGER trg_vacation_ledger_append_only BEFORE UPDATE OR DELETE ON public.vacation_ledger FOR EACH ROW EXECUTE FUNCTION public._vacation_append_only();
DROP TRIGGER IF EXISTS trg_vacation_ledger_no_truncate ON public.vacation_ledger;
CREATE TRIGGER trg_vacation_ledger_no_truncate BEFORE TRUNCATE ON public.vacation_ledger FOR EACH STATEMENT EXECUTE FUNCTION public._vacation_append_only();
DROP TRIGGER IF EXISTS trg_vacation_ledger_check ON public.vacation_ledger;
CREATE TRIGGER trg_vacation_ledger_check BEFORE INSERT ON public.vacation_ledger FOR EACH ROW EXECUTE FUNCTION public._vacation_ledger_check();

DROP TRIGGER IF EXISTS trg_vacation_alloc_append_only ON public.vacation_request_allocations;
CREATE TRIGGER trg_vacation_alloc_append_only BEFORE UPDATE OR DELETE ON public.vacation_request_allocations FOR EACH ROW EXECUTE FUNCTION public._vacation_append_only();
DROP TRIGGER IF EXISTS trg_vacation_alloc_no_truncate ON public.vacation_request_allocations;
CREATE TRIGGER trg_vacation_alloc_no_truncate BEFORE TRUNCATE ON public.vacation_request_allocations FOR EACH STATEMENT EXECUTE FUNCTION public._vacation_append_only();
DROP TRIGGER IF EXISTS trg_vacation_alloc_check ON public.vacation_request_allocations;
CREATE TRIGGER trg_vacation_alloc_check BEFORE INSERT ON public.vacation_request_allocations FOR EACH ROW EXECUTE FUNCTION public._vacation_allocation_check();

DROP TRIGGER IF EXISTS trg_vacation_terms_append_only ON public.vacation_entitlement_terms;
CREATE TRIGGER trg_vacation_terms_append_only BEFORE UPDATE OR DELETE ON public.vacation_entitlement_terms FOR EACH ROW EXECUTE FUNCTION public._vacation_append_only();
DROP TRIGGER IF EXISTS trg_vacation_terms_no_truncate ON public.vacation_entitlement_terms;
CREATE TRIGGER trg_vacation_terms_no_truncate BEFORE TRUNCATE ON public.vacation_entitlement_terms FOR EACH STATEMENT EXECUTE FUNCTION public._vacation_append_only();
DROP TRIGGER IF EXISTS trg_vacation_terms_check ON public.vacation_entitlement_terms;
CREATE TRIGGER trg_vacation_terms_check BEFORE INSERT ON public.vacation_entitlement_terms FOR EACH ROW EXECUTE FUNCTION public._vacation_term_check();

DROP TRIGGER IF EXISTS trg_vacation_account_guard ON public.vacation_accounts;
CREATE TRIGGER trg_vacation_account_guard BEFORE UPDATE OR DELETE ON public.vacation_accounts FOR EACH ROW EXECUTE FUNCTION public._vacation_account_guard();
DROP TRIGGER IF EXISTS trg_vacation_account_no_truncate ON public.vacation_accounts;
CREATE TRIGGER trg_vacation_account_no_truncate BEFORE TRUNCATE ON public.vacation_accounts FOR EACH STATEMENT EXECUTE FUNCTION public._vacation_append_only();

-- ── Rechte: Browser-Rollen schreiben nie; lesen in Phase 1 nur Admins (RLS) ───────────────────────────────
ALTER TABLE public.vacation_accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vacation_entitlement_terms   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vacation_ledger              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vacation_request_allocations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.vacation_accounts, public.vacation_entitlement_terms, public.vacation_ledger, public.vacation_request_allocations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.vacation_accounts, public.vacation_entitlement_terms, public.vacation_ledger, public.vacation_request_allocations
  TO authenticated;

DROP POLICY IF EXISTS vacation_accounts_admin_read ON public.vacation_accounts;
CREATE POLICY vacation_accounts_admin_read ON public.vacation_accounts FOR SELECT TO authenticated USING (is_admin());
DROP POLICY IF EXISTS vacation_terms_admin_read ON public.vacation_entitlement_terms;
CREATE POLICY vacation_terms_admin_read ON public.vacation_entitlement_terms FOR SELECT TO authenticated USING (is_admin());
DROP POLICY IF EXISTS vacation_ledger_admin_read ON public.vacation_ledger;
CREATE POLICY vacation_ledger_admin_read ON public.vacation_ledger FOR SELECT TO authenticated USING (is_admin());
DROP POLICY IF EXISTS vacation_allocations_admin_read ON public.vacation_request_allocations;
CREATE POLICY vacation_allocations_admin_read ON public.vacation_request_allocations FOR SELECT TO authenticated USING (is_admin());

REVOKE ALL ON FUNCTION public._vacation_append_only(), public._vacation_account_guard(), public._vacation_ledger_check(),
  public._vacation_allocation_check(), public._vacation_term_check() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.vacation_accounts            IS 'Urlaubskonto je Person und Kalenderjahr (Phase 1: Fundament, von der App noch nicht genutzt). Nie löschen; Abschluss einmalig.';
COMMENT ON TABLE public.vacation_entitlement_terms   IS 'Urlaubsanspruch mit Gültigkeit ab Datum (Historie). Nur anhängen; Korrektur per supersedes_id.';
COMMENT ON TABLE public.vacation_ledger              IS 'Urlaubs-Buchungsjournal (Anspruch, Übertrag mit Herkunftsjahr, Korrekturen). Nur anhängen; Korrektur per Gegenbuchung.';
COMMENT ON TABLE public.vacation_request_allocations IS 'Festgeschriebener Verbrauch je Urlaubsantrag und Kalenderjahr. Nur anhängen; Neuberechnung per supersedes_id.';
