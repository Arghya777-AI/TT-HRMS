-- ============================================================================
-- Migration 022: payroll runs
--   payroll_runs, payroll_run_employees, payslips, payslip_lines,
--   payroll_inputs_snapshot, bank_advice_batches, form16_documents;
--   two-person approve trigger; RLS.
-- Source: docs/plan/04-data-model.md §3.8 (lines 2023–2193), §4.3/§4.4,
--         §8.11 (trg_payroll_runs__two_person).
-- Money convention: integer paise columns suffixed _paise (matches 020/021).
-- Forward FKs (added by 20260801004900_deferred_fks.sql):
--   payroll_runs.attendance_lock_id     -> attendance_locks (017; file pending)
--   payslips.pdf_document_id            -> documents (025)
--   form16_documents.document_id        -> documents (025)
--   bank_advice_batches.file_document_id-> documents (025)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. payroll_runs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL,
  pay_period_id             uuid        NOT NULL,
  run_number                text        NOT NULL,   -- PR-2026-07-01
  run_kind                  text        NOT NULL DEFAULT 'regular',
  status                    public.payroll_run_status NOT NULL DEFAULT 'draft',
  employee_filter           jsonb       NULL,       -- NULL = all eligible
  -- The exact statutory rate set used — PINNED, so recomputing an old run
  -- cannot apply today's PF ceiling.
  statutory_settings_id     uuid        NOT NULL,
  engine_version            integer     NOT NULL DEFAULT 1,
  inputs_locked_at          timestamptz NULL,
  attendance_lock_id        uuid        NULL,       -- FK via deferred sweep (017)
  computed_at               timestamptz NULL,
  computed_by               uuid        NULL,
  reviewed_at               timestamptz NULL,
  reviewed_by               uuid        NULL,
  approved_at               timestamptz NULL,
  approved_by               uuid        NULL,       -- two-person: <> computed_by
  paid_at                   timestamptz NULL,
  paid_by                   uuid        NULL,
  closed_at                 timestamptz NULL,       -- immutable after closure
  cancelled_at              timestamptz NULL,
  cancelled_by              uuid        NULL,
  cancellation_reason       text        NULL,
  employee_count            integer     NOT NULL DEFAULT 0,
  total_gross_paise         bigint      NOT NULL DEFAULT 0,
  total_deductions_paise    bigint      NOT NULL DEFAULT 0,
  total_net_paise           bigint      NOT NULL DEFAULT 0,
  total_employer_cost_paise bigint      NOT NULL DEFAULT 0,
  variance_vs_previous_pct  numeric(9,4) NULL,      -- > ±10% blocks approval w/o reason
  exception_count           integer     NOT NULL DEFAULT 0,
  notes                     text        NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NULL,
  CONSTRAINT pk_payroll_runs PRIMARY KEY (id),
  CONSTRAINT fk_payroll_runs__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payroll_runs__pay_period_id
    FOREIGN KEY (pay_period_id) REFERENCES public.pay_periods(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payroll_runs__statutory_settings_id
    FOREIGN KEY (statutory_settings_id) REFERENCES public.statutory_settings(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payroll_runs__computed_by
    FOREIGN KEY (computed_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_runs__reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_runs__approved_by
    FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_runs__paid_by
    FOREIGN KEY (paid_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_runs__cancelled_by
    FOREIGN KEY (cancelled_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_runs__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_runs__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_payroll_runs__run_number UNIQUE (run_number),
  CONSTRAINT ck_payroll_runs__kind CHECK (run_kind IN
    ('regular','off_cycle','arrears','bonus','full_and_final','correction')),
  CONSTRAINT ck_payroll_runs__totals_shape
    CHECK (employee_count >= 0 AND exception_count >= 0),
  CONSTRAINT ck_payroll_runs__cancel_reason
    CHECK (cancelled_at IS NULL
           OR (cancelled_by IS NOT NULL AND length(btrim(coalesce(cancellation_reason, ''))) >= 10)),
  CONSTRAINT ck_payroll_runs__approved_fields
    CHECK (approved_at IS NULL OR approved_by IS NOT NULL)
);

COMMENT ON TABLE public.payroll_runs IS 'Payroll run header. Pins statutory_settings_id. Two-person rule (approved_by <> computed_by) and closed-run immutability enforced by trg_payroll_runs__two_person / trg_payroll_runs__closed_guard.';

CREATE INDEX IF NOT EXISTS idx_payroll_runs__company     ON public.payroll_runs (company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs__pay_period  ON public.payroll_runs (pay_period_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs__statutory   ON public.payroll_runs (statutory_settings_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs__status      ON public.payroll_runs (status)
  WHERE status NOT IN ('closed','cancelled');
CREATE INDEX IF NOT EXISTS idx_payroll_runs__attendance_lock
  ON public.payroll_runs (attendance_lock_id) WHERE attendance_lock_id IS NOT NULL;

-- Two-person approval + variance acknowledgement + cancellation authority +
-- closed-run immutability (§8.11 trg_payroll_runs__two_person, §3.8 notes).
CREATE OR REPLACE FUNCTION public.payroll_runs_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- After closure the run is immutable; corrections require an arrears run.
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'payroll run % is closed and immutable; corrections require an arrears run',
      OLD.run_number USING errcode = '0A000';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'payroll run % is cancelled and immutable', OLD.run_number
      USING errcode = '0A000';
  END IF;

  -- Transition to approved: two-person rule.
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    NEW.approved_at := COALESCE(NEW.approved_at, now());
    NEW.approved_by := COALESCE(NEW.approved_by, app.ctx_actor_id());
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'payroll run approval requires an identified approver'
        USING errcode = '23514';
    END IF;
    IF NEW.computed_by IS NULL OR NEW.approved_by = NEW.computed_by THEN
      RAISE EXCEPTION 'two-person rule: approved_by must differ from computed_by (run %)',
        NEW.run_number USING errcode = '23514';
    END IF;
    -- Errors (incl. minimum-wage violations) block approval.
    IF EXISTS (SELECT 1 FROM public.payroll_run_employees pre
               WHERE pre.payroll_run_id = NEW.id AND pre.status = 'error') THEN
      RAISE EXCEPTION 'payroll run % has employees in error state; resolve before approval',
        NEW.run_number USING errcode = '23514';
    END IF;
    -- Variance > ±10% blocks approval until acknowledged with a reason.
    IF NEW.variance_vs_previous_pct IS NOT NULL
       AND abs(NEW.variance_vs_previous_pct) > 10
       AND NOT app.has_reason() THEN
      RAISE EXCEPTION 'variance vs previous run is % %% (> 10 %%); approval requires an acknowledgement reason',
        NEW.variance_vs_previous_pct USING errcode = '23514';
    END IF;
  END IF;

  -- Cancellation is P9 (super-admin) with mandatory reason. auth.uid() IS NULL
  -- covers the service-role / migration paths.
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    IF auth.uid() IS NOT NULL AND NOT app.is_super_admin() THEN
      RAISE EXCEPTION 'only a super-admin may cancel a payroll run'
        USING errcode = '42501';
    END IF;
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
    NEW.cancelled_by := COALESCE(NEW.cancelled_by, app.ctx_actor_id());
    IF length(btrim(coalesce(NEW.cancellation_reason, ''))) < 10 THEN
      RAISE EXCEPTION 'cancelling a payroll run requires a reason (>= 10 chars)'
        USING errcode = '23514';
    END IF;
  END IF;

  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_runs__two_person ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs__two_person
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_guard();

DROP TRIGGER IF EXISTS trg_payroll_runs__stamp ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs__stamp
  BEFORE INSERT ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_payroll_runs__touch ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs__touch
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Payslip visibility gate: employees may see a payslip only once its run is
-- approved or later. SECURITY DEFINER so the check works from policies on
-- payslips even though payroll_runs itself is admin-only.
CREATE OR REPLACE FUNCTION public.payroll_run_is_released(p_payroll_run_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payroll_runs r
    WHERE r.id = p_payroll_run_id
      AND r.status IN ('approved','disbursement_pending','paid','closed'));
$$;

REVOKE ALL ON FUNCTION public.payroll_run_is_released(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_run_is_released(uuid) TO authenticated;

ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;

-- P8: admin read/create/compute. Approval additionally gated by the
-- two-person trigger; cancellation by the P9 check inside the trigger.
DROP POLICY IF EXISTS payroll_runs__admin__select ON public.payroll_runs;
CREATE POLICY payroll_runs__admin__select ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS payroll_runs__admin__insert ON public.payroll_runs;
CREATE POLICY payroll_runs__admin__insert ON public.payroll_runs
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS payroll_runs__admin__update ON public.payroll_runs;
CREATE POLICY payroll_runs__admin__update ON public.payroll_runs
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

-- DELETE: never, for anyone.
GRANT SELECT, INSERT, UPDATE ON public.payroll_runs TO authenticated;
REVOKE DELETE ON public.payroll_runs FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.payroll_runs TO service_role;
    REVOKE DELETE ON public.payroll_runs FROM service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. payroll_run_employees
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_run_employees (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  payroll_run_id   uuid        NOT NULL,
  employee_id      uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'pending',
  exclusion_reason text        NULL,
  hold_reason      text        NULL,
  error_detail     text        NULL,
  computed_at      timestamptz NULL,
  payslip_id       uuid        NULL,   -- FK added below, after payslips exists
  retry_count      integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NULL,
  CONSTRAINT pk_payroll_run_employees PRIMARY KEY (id),
  CONSTRAINT fk_pre__payroll_run_id
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_pre__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pre__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_pre__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_pre__run_employee UNIQUE (payroll_run_id, employee_id),
  CONSTRAINT ck_pre__status CHECK (status IN ('pending','computed','excluded','error','held')),
  CONSTRAINT ck_pre__retry_nonneg CHECK (retry_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pre__status   ON public.payroll_run_employees (payroll_run_id, status);
CREATE INDEX IF NOT EXISTS idx_pre__employee ON public.payroll_run_employees (employee_id);
CREATE INDEX IF NOT EXISTS idx_pre__payslip  ON public.payroll_run_employees (payslip_id)
  WHERE payslip_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pre__stamp ON public.payroll_run_employees;
CREATE TRIGGER trg_pre__stamp
  BEFORE INSERT ON public.payroll_run_employees
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_pre__touch ON public.payroll_run_employees;
CREATE TRIGGER trg_pre__touch
  BEFORE UPDATE ON public.payroll_run_employees
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.payroll_run_employees ENABLE ROW LEVEL SECURITY;

-- P8: admin S,U (hold/exclude with reasons). Rows are created by the compute
-- engine (SECURITY DEFINER, table owner) — no client INSERT.
DROP POLICY IF EXISTS pre__admin__select ON public.payroll_run_employees;
CREATE POLICY pre__admin__select ON public.payroll_run_employees
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS pre__admin__update ON public.payroll_run_employees;
CREATE POLICY pre__admin__update ON public.payroll_run_employees
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

GRANT SELECT, UPDATE ON public.payroll_run_employees TO authenticated;
REVOKE INSERT, DELETE ON public.payroll_run_employees FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_run_employees TO service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. payslips
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payslips (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  payroll_run_id              uuid        NOT NULL,
  employee_id                 uuid        NOT NULL,
  pay_period_id               uuid        NOT NULL,
  payslip_number              text        NOT NULL,   -- TT0007/2026-07
  period_start                date        NOT NULL,   -- snapshotted
  period_end                  date        NOT NULL,   -- snapshotted
  pay_date                    date        NOT NULL,
  period_days                 integer     NOT NULL,   -- per month_days_basis
  -- SUM(attendance_days.day_fraction_paid) + paid leave. THE one definition.
  paid_days                   numeric(6,3) NOT NULL,
  lop_days                    numeric(6,3) NOT NULL DEFAULT 0,
  present_days                numeric(6,3) NOT NULL DEFAULT 0,
  weekly_off_days             numeric(6,3) NOT NULL DEFAULT 0,
  holiday_days                numeric(6,3) NOT NULL DEFAULT 0,
  leave_days_paid             numeric(6,3) NOT NULL DEFAULT 0,
  leave_days_unpaid           numeric(6,3) NOT NULL DEFAULT 0,
  overtime_minutes            integer     NOT NULL DEFAULT 0,   -- approved only
  extra_work_minutes          integer     NOT NULL DEFAULT 0,
  late_deduction_days         numeric(6,3) NOT NULL DEFAULT 0,
  gross_earnings_paise        bigint      NOT NULL DEFAULT 0,
  total_deductions_paise      bigint      NOT NULL DEFAULT 0,
  net_pay_paise               bigint      NOT NULL DEFAULT 0,
  net_pay_words               text        NULL,       -- generated once, server-side
  employer_contributions_paise bigint     NOT NULL DEFAULT 0,
  total_ctc_for_period_paise  bigint      NOT NULL DEFAULT 0,
  ytd_gross_paise             bigint      NOT NULL DEFAULT 0,
  ytd_deductions_paise        bigint      NOT NULL DEFAULT 0,
  ytd_net_paise               bigint      NOT NULL DEFAULT 0,
  ytd_tds_paise               bigint      NOT NULL DEFAULT 0,
  bank_account_id             uuid        NULL,       -- account snapshotted at run time
  payment_mode                public.payment_mode NOT NULL,
  payment_status              text        NOT NULL DEFAULT 'pending',
  payment_reference           text        NULL,       -- UTR
  paid_on                     date        NULL,
  bank_advice_batch_id        uuid        NULL,       -- FK added below
  pdf_document_id             uuid        NULL,       -- FK via deferred sweep (025)
  pdf_generated_at            timestamptz NULL,
  emailed_at                  timestamptz NULL,
  viewed_at                   timestamptz NULL,       -- first view = proof of delivery
  is_reversed                 boolean     NOT NULL DEFAULT false,
  reversed_by_payslip_id      uuid        NULL,       -- reversal + reissue, never edits
  computed_snapshot_id        uuid        NULL,       -- FK added below
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  CONSTRAINT pk_payslips PRIMARY KEY (id),
  CONSTRAINT fk_payslips__payroll_run_id
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payslips__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payslips__pay_period_id
    FOREIGN KEY (pay_period_id) REFERENCES public.pay_periods(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payslips__bank_account_id
    FOREIGN KEY (bank_account_id) REFERENCES public.employee_bank_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payslips__reversed_by_payslip_id
    FOREIGN KEY (reversed_by_payslip_id) REFERENCES public.payslips(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payslips__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_payslips__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_payslips__number UNIQUE (payslip_number),
  CONSTRAINT uq_payslips__run_employee UNIQUE (payroll_run_id, employee_id),
  CONSTRAINT ck_payslips__period CHECK (period_end >= period_start),
  CONSTRAINT ck_payslips__period_days CHECK (period_days BETWEEN 1 AND 31),
  CONSTRAINT ck_payslips__days_nonneg CHECK (
    paid_days >= 0 AND lop_days >= 0 AND present_days >= 0 AND weekly_off_days >= 0
    AND holiday_days >= 0 AND leave_days_paid >= 0 AND leave_days_unpaid >= 0
    AND late_deduction_days >= 0 AND overtime_minutes >= 0 AND extra_work_minutes >= 0),
  CONSTRAINT ck_payslips__payment_status CHECK (payment_status IN
    ('pending','in_batch','paid','failed','held','reversed')),
  CONSTRAINT ck_payslips__no_sentinel_dates
    CHECK (period_end <= DATE '2100-01-01' AND pay_date <= DATE '2100-01-01'
           AND (paid_on IS NULL OR paid_on <= DATE '2100-01-01'))
);

COMMENT ON COLUMN public.payslips.paid_days IS 'SUM(attendance_days.day_fraction_paid) over the period (paid leave is already reflected in day_fraction_paid). The one and only definition of Paid Days.';
COMMENT ON COLUMN public.payslips.net_pay_words IS '"Rupees Twenty Two Thousand Four Hundred Only" — generated once, server-side (payslip-pdf edge function).';

CREATE INDEX IF NOT EXISTS idx_payslips__employee_period
  ON public.payslips (employee_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_payslips__payroll_run  ON public.payslips (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips__pay_period   ON public.payslips (pay_period_id);
CREATE INDEX IF NOT EXISTS idx_payslips__bank_account ON public.payslips (bank_account_id)
  WHERE bank_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payslips__advice_batch ON public.payslips (bank_advice_batch_id)
  WHERE bank_advice_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payslips__payment_status ON public.payslips (payment_status)
  WHERE payment_status NOT IN ('paid');

DROP TRIGGER IF EXISTS trg_payslips__stamp ON public.payslips;
CREATE TRIGGER trg_payslips__stamp
  BEFORE INSERT ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_payslips__touch ON public.payslips;
CREATE TRIGGER trg_payslips__touch
  BEFORE UPDATE ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;

-- P6 sensitive: self read ONLY when the run is approved or later — draft
-- payroll is never visible. Manager: none.
DROP POLICY IF EXISTS payslips__self__select ON public.payslips;
CREATE POLICY payslips__self__select ON public.payslips
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id()
         AND public.payroll_run_is_released(payroll_run_id));

DROP POLICY IF EXISTS payslips__admin__select ON public.payslips;
CREATE POLICY payslips__admin__select ON public.payslips
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

-- Writes happen only via the compute engine / edge functions. No client write.
GRANT SELECT ON public.payslips TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payslips FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.payslips TO service_role;
    REVOKE DELETE ON public.payslips FROM service_role;
  END IF;
END $$;

-- payroll_run_employees.payslip_id FK, now that payslips exists.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pre__payslip_id') THEN
    ALTER TABLE public.payroll_run_employees
      ADD CONSTRAINT fk_pre__payslip_id
      FOREIGN KEY (payslip_id) REFERENCES public.payslips(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. payslip_lines — every rupee traceable to its input.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payslip_lines (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  payslip_id             uuid        NOT NULL,
  salary_component_id    uuid        NULL,   -- NULL only for ad-hoc lines
  label                  text        NOT NULL,   -- snapshotted component name
  line_kind              public.payslip_line_kind NOT NULL,
  sequence               integer     NOT NULL,   -- print order
  full_month_amount_paise bigint     NOT NULL DEFAULT 0,  -- entitlement before proration
  amount_paise           bigint      NOT NULL DEFAULT 0,  -- actual
  calc_kind              text        NOT NULL,   -- copied from the component at run time
  calc_basis             jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- THE proof
  ytd_amount_paise       bigint      NOT NULL DEFAULT 0,
  is_prorated            boolean     NOT NULL DEFAULT false,
  is_arrear              boolean     NOT NULL DEFAULT false,
  arrear_for_period_id   uuid        NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_payslip_lines PRIMARY KEY (id),
  CONSTRAINT fk_payslip_lines__payslip_id
    FOREIGN KEY (payslip_id) REFERENCES public.payslips(id) ON DELETE CASCADE,
  CONSTRAINT fk_payslip_lines__salary_component_id
    FOREIGN KEY (salary_component_id) REFERENCES public.salary_components(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payslip_lines__arrear_for_period_id
    FOREIGN KEY (arrear_for_period_id) REFERENCES public.pay_periods(id) ON DELETE RESTRICT,
  -- Ad-hoc lines (no component) must carry their justification in calc_basis.
  CONSTRAINT ck_payslip_lines__adhoc_reason
    CHECK (salary_component_id IS NOT NULL OR (calc_basis ? 'reason')),
  CONSTRAINT ck_payslip_lines__label CHECK (length(btrim(label)) > 0)
);

COMMENT ON COLUMN public.payslip_lines.calc_basis IS 'The proof, money in integer paise: {"basis":"pct_of_component","base_component":"BASIC","base_amount_paise":2200000,"percentage":40.0,"paid_days":24.5,"period_days":31,"proration":0.7903}. Rendered in the admin payslip inspector; consumed by the AI agent.';

CREATE INDEX IF NOT EXISTS idx_payslip_lines__payslip_seq
  ON public.payslip_lines (payslip_id, sequence);
CREATE INDEX IF NOT EXISTS idx_payslip_lines__component
  ON public.payslip_lines (salary_component_id) WHERE salary_component_id IS NOT NULL;

ALTER TABLE public.payslip_lines ENABLE ROW LEVEL SECURITY;

-- Follows payslips (P6, via join): the EXISTS runs under the caller's RLS on
-- payslips (self + released, or scoped admin). No update/delete for clients;
-- the engine (table owner) replaces lines only while the run is pre-approval.
DROP POLICY IF EXISTS payslip_lines__via_parent__select ON public.payslip_lines;
CREATE POLICY payslip_lines__via_parent__select ON public.payslip_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payslips p WHERE p.id = payslip_id));

GRANT SELECT ON public.payslip_lines TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payslip_lines FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, DELETE ON public.payslip_lines TO service_role;
    REVOKE UPDATE ON public.payslip_lines FROM service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5. payroll_inputs_snapshot — the immutable input bundle for one payslip.
--    Without it, "recompute" is unfalsifiable.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_inputs_snapshot (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  payroll_run_id           uuid        NOT NULL,
  employee_id              uuid        NOT NULL,
  payslip_id               uuid        NULL,
  snapshot                 jsonb       NOT NULL,
  snapshot_hash            text        NOT NULL,   -- SHA-256 of canonical JSON
  attendance_days_included uuid[]      NULL,
  leave_ledger_included    uuid[]      NULL,
  salary_revision_id       uuid        NULL,
  statutory_settings_id    uuid        NULL,
  policy_ids               jsonb       NULL,
  engine_version           integer     NOT NULL DEFAULT 1,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_payroll_inputs_snapshot PRIMARY KEY (id),
  CONSTRAINT fk_pis__payroll_run_id
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pis__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pis__payslip_id
    FOREIGN KEY (payslip_id) REFERENCES public.payslips(id) ON DELETE SET NULL,
  CONSTRAINT fk_pis__salary_revision_id
    FOREIGN KEY (salary_revision_id) REFERENCES public.employee_salary_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pis__statutory_settings_id
    FOREIGN KEY (statutory_settings_id) REFERENCES public.statutory_settings(id) ON DELETE RESTRICT,
  CONSTRAINT ck_pis__hash CHECK (snapshot_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.payroll_inputs_snapshot IS 'Immutable input bundle per payslip: per-day attendance summary, leave debits, revision component lines, statutory rates, pay-period definition. Never updated (trigger-enforced).';

CREATE INDEX IF NOT EXISTS idx_pis__run_employee
  ON public.payroll_inputs_snapshot (payroll_run_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_pis__payslip
  ON public.payroll_inputs_snapshot (payslip_id) WHERE payslip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pis__salary_revision
  ON public.payroll_inputs_snapshot (salary_revision_id) WHERE salary_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pis__statutory
  ON public.payroll_inputs_snapshot (statutory_settings_id) WHERE statutory_settings_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pis__employee
  ON public.payroll_inputs_snapshot (employee_id);

-- Never updated. (DELETE stays possible for the table owner only — retention
-- sweeps — but is refused for every client role below.)
DROP TRIGGER IF EXISTS trg_pis__immutable ON public.payroll_inputs_snapshot;
CREATE TRIGGER trg_pis__immutable
  BEFORE UPDATE ON public.payroll_inputs_snapshot
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.payroll_inputs_snapshot ENABLE ROW LEVEL SECURITY;

-- P8 read; service write; never updated.
DROP POLICY IF EXISTS pis__admin__select ON public.payroll_inputs_snapshot;
CREATE POLICY pis__admin__select ON public.payroll_inputs_snapshot
  FOR SELECT TO authenticated
  USING (app.is_admin());

GRANT SELECT ON public.payroll_inputs_snapshot TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payroll_inputs_snapshot FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.payroll_inputs_snapshot TO service_role;
    REVOKE UPDATE, DELETE ON public.payroll_inputs_snapshot FROM service_role;
  END IF;
END $$;

-- payslips.computed_snapshot_id FK, now that the snapshot table exists.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslips__computed_snapshot_id') THEN
    ALTER TABLE public.payslips
      ADD CONSTRAINT fk_payslips__computed_snapshot_id
      FOREIGN KEY (computed_snapshot_id) REFERENCES public.payroll_inputs_snapshot(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. bank_advice_batches
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_advice_batches (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  payroll_run_id     uuid        NOT NULL,
  batch_number       text        NOT NULL,
  bank_name          text        NULL,
  format             text        NOT NULL DEFAULT 'generic_csv',
  value_date         date        NULL,
  total_amount_paise bigint      NOT NULL DEFAULT 0,
  record_count       integer     NOT NULL DEFAULT 0,
  file_document_id   uuid        NULL,   -- FK via deferred sweep (025)
  checksum           text        NULL,
  status             text        NOT NULL DEFAULT 'draft',
  downloaded_by      uuid        NULL,
  downloaded_at      timestamptz NULL,
  bank_reference     text        NULL,
  failure_detail     jsonb       NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL,
  CONSTRAINT pk_bank_advice_batches PRIMARY KEY (id),
  CONSTRAINT fk_bab__payroll_run_id
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bab__downloaded_by
    FOREIGN KEY (downloaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_bab__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_bab__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_bab__batch_number UNIQUE (batch_number),
  CONSTRAINT ck_bab__format CHECK (format IN
    ('icici_h2h','hdfc_neft','sbi_ct','npci_nach','generic_csv')),
  CONSTRAINT ck_bab__status CHECK (status IN
    ('draft','generated','downloaded','uploaded_to_bank','acknowledged',
     'partially_failed','completed')),
  CONSTRAINT ck_bab__amounts CHECK (total_amount_paise >= 0 AND record_count >= 0)
);

COMMENT ON TABLE public.bank_advice_batches IS 'Bank advice files. Every download is logged in export_log by the exporting edge function — the file contains every bank account in the company.';

CREATE INDEX IF NOT EXISTS idx_bab__payroll_run ON public.bank_advice_batches (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_bab__status ON public.bank_advice_batches (status)
  WHERE status NOT IN ('completed');

DROP TRIGGER IF EXISTS trg_bab__stamp ON public.bank_advice_batches;
CREATE TRIGGER trg_bab__stamp
  BEFORE INSERT ON public.bank_advice_batches
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_bab__touch ON public.bank_advice_batches;
CREATE TRIGGER trg_bab__touch
  BEFORE UPDATE ON public.bank_advice_batches
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.bank_advice_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bab__admin__select ON public.bank_advice_batches;
CREATE POLICY bab__admin__select ON public.bank_advice_batches
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS bab__admin__insert ON public.bank_advice_batches;
CREATE POLICY bab__admin__insert ON public.bank_advice_batches
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS bab__admin__update ON public.bank_advice_batches;
CREATE POLICY bab__admin__update ON public.bank_advice_batches
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.bank_advice_batches TO authenticated;
REVOKE DELETE ON public.bank_advice_batches FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.bank_advice_batches TO service_role;
  END IF;
END $$;

-- payslips.bank_advice_batch_id FK, now that batches exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslips__bank_advice_batch_id') THEN
    ALTER TABLE public.payslips
      ADD CONSTRAINT fk_payslips__bank_advice_batch_id
      FOREIGN KEY (bank_advice_batch_id) REFERENCES public.bank_advice_batches(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7. form16_documents
--    Filenames follow <employee_code>_FORM16_<PART>_FY<yyyy-yy>.pdf — a
--    DEFINED convention.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.form16_documents (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id        uuid        NOT NULL,
  financial_year     text        NOT NULL,   -- '2025-26'
  part               text        NOT NULL,   -- A | B | consolidated
  document_id        uuid        NULL,       -- FK via deferred sweep (025)
  tan                text        NULL,
  certificate_number text        NULL,
  total_income_paise bigint      NULL,
  total_tds_paise    bigint      NULL,
  issued_on          date        NULL,
  issued_by          uuid        NULL,
  distributed_at     timestamptz NULL,
  acknowledged_at    timestamptz NULL,
  traces_reference   text        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL,
  CONSTRAINT pk_form16_documents PRIMARY KEY (id),
  CONSTRAINT fk_f16__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_f16__issued_by
    FOREIGN KEY (issued_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_f16__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_f16__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_f16__employee_fy_part UNIQUE (employee_id, financial_year, part),
  CONSTRAINT ck_f16__fy CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT ck_f16__part CHECK (part IN ('A','B','consolidated')),
  CONSTRAINT ck_f16__tan CHECK (tan IS NULL OR tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  CONSTRAINT ck_f16__amounts CHECK (
    (total_income_paise IS NULL OR total_income_paise >= 0)
    AND (total_tds_paise IS NULL OR total_tds_paise >= 0))
);

CREATE INDEX IF NOT EXISTS idx_f16__employee ON public.form16_documents (employee_id);
CREATE INDEX IF NOT EXISTS idx_f16__fy       ON public.form16_documents (financial_year);

DROP TRIGGER IF EXISTS trg_f16__stamp ON public.form16_documents;
CREATE TRIGGER trg_f16__stamp
  BEFORE INSERT ON public.form16_documents
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_f16__touch ON public.form16_documents;
CREATE TRIGGER trg_f16__touch
  BEFORE UPDATE ON public.form16_documents
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.form16_documents ENABLE ROW LEVEL SECURITY;

-- P6: self read + admin.
DROP POLICY IF EXISTS f16__self__select ON public.form16_documents;
CREATE POLICY f16__self__select ON public.form16_documents
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS f16__admin__select ON public.form16_documents;
CREATE POLICY f16__admin__select ON public.form16_documents
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS f16__admin__insert ON public.form16_documents;
CREATE POLICY f16__admin__insert ON public.form16_documents
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS f16__admin__update ON public.form16_documents;
CREATE POLICY f16__admin__update ON public.form16_documents
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

GRANT SELECT, INSERT, UPDATE ON public.form16_documents TO authenticated;
REVOKE DELETE ON public.form16_documents FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.form16_documents TO service_role;
  END IF;
END $$;

COMMIT;
