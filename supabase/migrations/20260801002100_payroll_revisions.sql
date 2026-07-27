-- ============================================================================
-- Migration 021: payroll revisions
--   employee_salary_revisions, employee_salary_revision_lines
--   (+ exclusion constraint, generated columns, end-dating trigger); RLS.
-- Source: docs/plan/04-data-model.md §3.8 (lines 1989–2022), §1 conventions,
--         §4.3 P6, §4.4 matrix rows.
-- Money convention: integer paise columns suffixed _paise (matches 020).
-- Forward FKs (added by 20260801004900_deferred_fks.sql):
--   employee_salary_revisions.approval_request_id -> approval_requests (029)
--   employee_salary_revisions.letter_document_id  -> documents (025)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. employee_salary_revisions
--    Effective-dated, versioned, approval-gated. Powers the Salary tab's
--    revision KPIs, CTC timeline chart and versioned history with end dates.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_salary_revisions (
  id                                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id                         uuid        NOT NULL,
  revision_number                     integer     NOT NULL,
  salary_structure_id                 uuid        NULL,
  effective_from                      date        NOT NULL,
  -- NULL = current. Maintained by trigger when the next approved revision
  -- arrives — this IS the "End Date / Active" column in Salary History.
  effective_to                        date        NULL,
  revision_kind                       text        NOT NULL DEFAULT 'annual_increment',
  monthly_gross_paise                 bigint      NOT NULL,  -- bucket A total
  monthly_employer_contribution_paise bigint      NOT NULL DEFAULT 0,  -- bucket C total
  -- A+C, computed, never entered.
  monthly_ctc_paise                   bigint      NOT NULL GENERATED ALWAYS AS
    (monthly_gross_paise + monthly_employer_contribution_paise) STORED,
  annual_ctc_paise                    bigint      NOT NULL GENERATED ALWAYS AS
    ((monthly_gross_paise + monthly_employer_contribution_paise) * 12) STORED,
  previous_monthly_ctc_paise          bigint      NULL,      -- snapshotted at insert
  increment_amount_paise              bigint      GENERATED ALWAYS AS
    ((monthly_gross_paise + monthly_employer_contribution_paise) - previous_monthly_ctc_paise) STORED,
  -- A percentage, already ×100, per §1.6.
  increment_pct                       numeric(9,4) GENERATED ALWAYS AS
    (round(((monthly_gross_paise + monthly_employer_contribution_paise) - previous_monthly_ctc_paise)
           * 100.0 / NULLIF(previous_monthly_ctc_paise, 0), 4)) STORED,
  months_since_previous               integer     NULL,      -- trigger-set from previous revision
  ctc_at_join_paise                   bigint      NULL,      -- denormalised for the timeline chart
  status                              public.approval_status NOT NULL DEFAULT 'pending',
  approval_request_id                 uuid        NULL,      -- FK via deferred sweep (029)
  proposed_by                         uuid        NULL,
  approved_by                         uuid        NULL,
  approved_at                         timestamptz NULL,
  letter_document_id                  uuid        NULL,      -- FK via deferred sweep (025)
  notes                               text        NULL,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  created_by                          uuid        NULL,
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  updated_by                          uuid        NULL,
  CONSTRAINT pk_employee_salary_revisions PRIMARY KEY (id),
  CONSTRAINT fk_esr__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_esr__salary_structure_id
    FOREIGN KEY (salary_structure_id) REFERENCES public.salary_structures(id) ON DELETE RESTRICT,
  CONSTRAINT fk_esr__proposed_by
    FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_esr__approved_by
    FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_esr__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_esr__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_esr__employee_revision UNIQUE (employee_id, revision_number),
  -- Overlap ban for approved revisions (btree_gist; open-ended = NULL).
  CONSTRAINT ex_esr__no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  ) WHERE (status = 'approved'),
  CONSTRAINT ck_esr__revision_number CHECK (revision_number >= 1),
  CONSTRAINT ck_esr__kind CHECK (revision_kind IN
    ('initial','annual_increment','promotion','market_correction','role_change',
     'confirmation','statutory_revision','correction','demotion')),
  CONSTRAINT ck_esr__amounts_nonneg
    CHECK (monthly_gross_paise >= 0 AND monthly_employer_contribution_paise >= 0
           AND (previous_monthly_ctc_paise IS NULL OR previous_monthly_ctc_paise >= 0)
           AND (ctc_at_join_paise IS NULL OR ctc_at_join_paise >= 0)),
  CONSTRAINT ck_esr__range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_esr__no_sentinel_dates
    CHECK (effective_from <= DATE '2100-01-01'
           AND (effective_to IS NULL OR effective_to <= DATE '2100-01-01')),
  CONSTRAINT ck_esr__approved_fields
    CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

COMMENT ON TABLE  public.employee_salary_revisions IS 'Effective-dated, versioned, approval-gated salary revisions. effective_to NULL = current; end-dated by trigger when the next approved revision is inserted.';
COMMENT ON COLUMN public.employee_salary_revisions.increment_pct IS 'Generated: round((monthly_ctc - previous_monthly_ctc) * 100 / previous_monthly_ctc, 4) — a percentage, already ×100, per §1.6.';
COMMENT ON COLUMN public.employee_salary_revisions.months_since_previous IS 'Set at insert from the previous revision''s effective_from. Powers "Duration Between Revisions: 21 Months".';

CREATE INDEX IF NOT EXISTS idx_esr__employee_effective
  ON public.employee_salary_revisions (employee_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_esr__salary_structure
  ON public.employee_salary_revisions (salary_structure_id) WHERE salary_structure_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_esr__approval_request
  ON public.employee_salary_revisions (approval_request_id) WHERE approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_esr__status
  ON public.employee_salary_revisions (status) WHERE status IN ('draft','pending');

-- ----------------------------------------------------------------------------
-- 1a. Before-write trigger: snapshot previous CTC, months-since-previous and
--     ctc-at-join at INSERT; end-date the prior approved revision when a
--     revision becomes approved (BEFORE, so ex_esr__no_overlap passes).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.esr_before_write()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_prev record;
  v_was_approved boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_was_approved := (OLD.status = 'approved');
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- auto-number when the client did not supply one (1, 2, 3 … per employee)
    IF NEW.revision_number IS NULL THEN
      SELECT COALESCE(MAX(r.revision_number), 0) + 1
        INTO NEW.revision_number
        FROM public.employee_salary_revisions r
       WHERE r.employee_id = NEW.employee_id;
    END IF;

    SELECT r.effective_from, r.monthly_ctc_paise, r.ctc_at_join_paise
      INTO v_prev
      FROM public.employee_salary_revisions r
     WHERE r.employee_id = NEW.employee_id
     ORDER BY r.revision_number DESC
     LIMIT 1;

    IF FOUND THEN
      NEW.previous_monthly_ctc_paise :=
        COALESCE(NEW.previous_monthly_ctc_paise, v_prev.monthly_ctc_paise);
      NEW.months_since_previous :=
        COALESCE(NEW.months_since_previous,
                 (EXTRACT(YEAR  FROM age(NEW.effective_from, v_prev.effective_from)) * 12
                + EXTRACT(MONTH FROM age(NEW.effective_from, v_prev.effective_from)))::integer);
      NEW.ctc_at_join_paise := COALESCE(NEW.ctc_at_join_paise, v_prev.ctc_at_join_paise);
    ELSE
      -- first revision: its own A+C is the joining CTC
      NEW.ctc_at_join_paise := COALESCE(NEW.ctc_at_join_paise,
        NEW.monthly_gross_paise + NEW.monthly_employer_contribution_paise);
    END IF;
  END IF;

  -- End-date the previously-current approved revision exactly when this row
  -- transitions to approved (INSERT as approved, or UPDATE pending->approved).
  IF NEW.status = 'approved' AND NOT v_was_approved THEN
    UPDATE public.employee_salary_revisions r
       SET effective_to = NEW.effective_from - 1
     WHERE r.employee_id = NEW.employee_id
       AND r.id <> NEW.id
       AND r.status = 'approved'
       AND r.effective_from < NEW.effective_from
       AND (r.effective_to IS NULL OR r.effective_to >= NEW.effective_from);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_esr__before_write ON public.employee_salary_revisions;
CREATE TRIGGER trg_esr__before_write
  BEFORE INSERT OR UPDATE OF status, effective_from ON public.employee_salary_revisions
  FOR EACH ROW EXECUTE FUNCTION public.esr_before_write();

DROP TRIGGER IF EXISTS trg_esr__stamp ON public.employee_salary_revisions;
CREATE TRIGGER trg_esr__stamp
  BEFORE INSERT ON public.employee_salary_revisions
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_esr__touch ON public.employee_salary_revisions;
CREATE TRIGGER trg_esr__touch
  BEFORE UPDATE ON public.employee_salary_revisions
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_salary_revisions ENABLE ROW LEVEL SECURITY;

-- P6 sensitive: self read (own revisions only). Manager: NO — a manager sees
-- no salary data unless explicitly granted SALARY_VIEW via
-- employee_role_assignments (served by the reveal RPC in 032, not this table).
DROP POLICY IF EXISTS esr__self__select ON public.employee_salary_revisions;
CREATE POLICY esr__self__select ON public.employee_salary_revisions
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

-- Admin read within scope. Reads of ANOTHER person's salary are written to
-- data_access_log by the API/reveal layer (§4.7 / migration 032).
DROP POLICY IF EXISTS esr__admin__select ON public.employee_salary_revisions;
CREATE POLICY esr__admin__select ON public.employee_salary_revisions
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

-- P6 write: admin with mandatory reason.
DROP POLICY IF EXISTS esr__admin__insert ON public.employee_salary_revisions;
CREATE POLICY esr__admin__insert ON public.employee_salary_revisions
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id) AND app.has_reason());

DROP POLICY IF EXISTS esr__admin__update ON public.employee_salary_revisions;
CREATE POLICY esr__admin__update ON public.employee_salary_revisions
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id) AND app.has_reason());

GRANT SELECT, INSERT, UPDATE ON public.employee_salary_revisions TO authenticated;
REVOKE DELETE ON public.employee_salary_revisions FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.employee_salary_revisions TO service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. employee_salary_revision_lines — the per-component breakup the Salary
--    tab renders. annual_amount is DERIVED so 9,163 × 12 = 1,09,956 can
--    never drift.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_salary_revision_lines (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  revision_id          uuid        NOT NULL,
  salary_component_id  uuid        NOT NULL,
  monthly_amount_paise bigint      NOT NULL,
  annual_amount_paise  bigint      NOT NULL GENERATED ALWAYS AS (monthly_amount_paise * 12) STORED,
  calc_note            text        NULL,
  sequence             integer     NOT NULL DEFAULT 100,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NULL,
  CONSTRAINT pk_employee_salary_revision_lines PRIMARY KEY (id),
  CONSTRAINT fk_esrl__revision_id
    FOREIGN KEY (revision_id) REFERENCES public.employee_salary_revisions(id) ON DELETE CASCADE,
  CONSTRAINT fk_esrl__salary_component_id
    FOREIGN KEY (salary_component_id) REFERENCES public.salary_components(id) ON DELETE RESTRICT,
  CONSTRAINT fk_esrl__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_esrl__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_esrl__revision_component UNIQUE (revision_id, salary_component_id),
  CONSTRAINT ck_esrl__amount_nonneg CHECK (monthly_amount_paise >= 0)
);

CREATE INDEX IF NOT EXISTS idx_esrl__revision_seq
  ON public.employee_salary_revision_lines (revision_id, sequence);
CREATE INDEX IF NOT EXISTS idx_esrl__component
  ON public.employee_salary_revision_lines (salary_component_id);

DROP TRIGGER IF EXISTS trg_esrl__stamp ON public.employee_salary_revision_lines;
CREATE TRIGGER trg_esrl__stamp
  BEFORE INSERT ON public.employee_salary_revision_lines
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_esrl__touch ON public.employee_salary_revision_lines;
CREATE TRIGGER trg_esrl__touch
  BEFORE UPDATE ON public.employee_salary_revision_lines
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_salary_revision_lines ENABLE ROW LEVEL SECURITY;

-- Visibility follows the parent revision: the EXISTS runs under the caller's
-- own RLS on employee_salary_revisions (self / scoped admin).
DROP POLICY IF EXISTS esrl__via_parent__select ON public.employee_salary_revision_lines;
CREATE POLICY esrl__via_parent__select ON public.employee_salary_revision_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.employee_salary_revisions r WHERE r.id = revision_id));

DROP POLICY IF EXISTS esrl__admin__insert ON public.employee_salary_revision_lines;
CREATE POLICY esrl__admin__insert ON public.employee_salary_revision_lines
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND EXISTS (
    SELECT 1 FROM public.employee_salary_revisions r
    WHERE r.id = revision_id AND app.admin_scope_covers(r.employee_id)));

DROP POLICY IF EXISTS esrl__admin__update ON public.employee_salary_revision_lines;
CREATE POLICY esrl__admin__update ON public.employee_salary_revision_lines
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND EXISTS (
    SELECT 1 FROM public.employee_salary_revisions r
    WHERE r.id = revision_id AND app.admin_scope_covers(r.employee_id)))
  WITH CHECK (app.is_admin() AND EXISTS (
    SELECT 1 FROM public.employee_salary_revisions r
    WHERE r.id = revision_id AND app.admin_scope_covers(r.employee_id)));

GRANT SELECT, INSERT, UPDATE ON public.employee_salary_revision_lines TO authenticated;
REVOKE DELETE ON public.employee_salary_revision_lines FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_salary_revision_lines TO service_role;
  END IF;
END $$;

COMMIT;
