-- =============================================================================
-- Migration 019 — leave
-- Source: docs/plan/04-data-model.md §3.7 (leave_types, leave_balances,
--         leave_ledger, leave_requests, leave_request_days, comp_off_ledger,
--         leave_year_rollovers — all columns verbatim), §8.2
--         (recompute_leave_balance), §8.3 (expire_comp_off), §8.4
--         (accrue_leave); spec-migrations §2 row 019.
--
-- Ledger-first: leave_balances is a CACHE — every figure on it is reproducible
-- by folding leave_ledger (recompute_leave_balance). The ledger is
-- append-only; corrections are reversing entries, never edits.
--
-- Leave enums (§3.7) were created in migration 003. util.*, app.*, audit.*
-- helpers come from 002/005/006; resolve_policy / is_weekly_off from 014.
--
-- Deliberate, noted deviations from the plan doc (details in each spot):
--   * comp_off_ledger gains `source_comp_off_id` (self-FK): §8.3 requires
--     idempotency "by (source_id, 'expired') uniqueness" — the doc's column
--     list has no such linking column, so it is added here.
--   * recompute_leave_balance folds `comp_off_expiry` into lapsed_days and
--     `settlement` into encashed_days; the doc's bucket filters omit both,
--     which would break "balances always reproducible from ledger rows".
--   * The doc's availed_days expression is sign-garbled pseudo-SQL (it would
--     store a negative and then be subtracted again by the generated column).
--     Implemented as the positive magnitude: ABS(availed-like) − reversals.
--   * leave_ledger allows exactly ONE update path: setting reversed_by_id
--     from NULL (nothing else, no DELETE) — the doc both forbids updates and
--     requires reversed_by_id to be populated by reversals; this is the
--     narrowest trigger that satisfies both intents.
--   * accrue_leave takes an optional p_dry_run (doc: "on-demand with
--     dry_run"); default false keeps the documented call signature valid.
--   * public.leave_year_of(date) helper added so every writer derives the
--     FY-start year (April basis, matching util.financial_year) identically.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Shared helper — leave year (financial year start year; 2026 = FY 2026-27)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leave_year_of(p_date date)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT CASE WHEN EXTRACT(MONTH FROM p_date) >= 4
              THEN EXTRACT(YEAR FROM p_date)::integer
              ELSE EXTRACT(YEAR FROM p_date)::integer - 1
         END;
$$;

-- -----------------------------------------------------------------------------
-- 1. leave_types (§3.7)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_types (
  id                                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                        uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                              text NOT NULL,
  name                              text NOT NULL,
  description                       text,
  sort_order                        integer NOT NULL DEFAULT 100,
  is_active                         boolean NOT NULL DEFAULT true,
  is_paid                           boolean NOT NULL DEFAULT true,
  unit                              text NOT NULL DEFAULT 'day',
  allow_half_day                    boolean NOT NULL DEFAULT true,
  annual_quota_days                 numeric(6,2),
  accrual_frequency                 public.accrual_frequency NOT NULL DEFAULT 'monthly',
  accrual_days_per_period           numeric(6,3),
  accrual_on_working_days_basis     boolean NOT NULL DEFAULT false,
  accrual_days_per_worked_days      numeric(6,3),
  accrual_start_after_months        integer NOT NULL DEFAULT 0,
  availing_allowed_during_probation boolean NOT NULL DEFAULT false,
  pro_rata_on_join                  boolean NOT NULL DEFAULT true,
  pro_rata_on_exit                  boolean NOT NULL DEFAULT true,
  max_balance_days                  numeric(6,2),
  carry_forward_allowed             boolean NOT NULL DEFAULT true,
  max_carry_forward_days            numeric(6,2),
  carry_forward_expiry_months       integer,
  encashment_allowed                boolean NOT NULL DEFAULT false,
  max_encashment_days               numeric(6,2),
  min_days_per_request              numeric(6,2) NOT NULL DEFAULT 0.5,
  max_days_per_request              numeric(6,2),
  max_consecutive_days              numeric(6,2),
  min_notice_days                   integer NOT NULL DEFAULT 0,
  max_backdated_days                integer NOT NULL DEFAULT 2,
  requires_document_after_days      numeric(6,2),
  document_type_id                  uuid,   -- FK added by deferred sweep (document_types in 025)
  allow_negative_balance            boolean NOT NULL DEFAULT false,
  max_negative_days                 numeric(6,2) NOT NULL DEFAULT 0,
  sandwich_holidays                 boolean NOT NULL DEFAULT false,
  count_weekly_off_as_leave         boolean NOT NULL DEFAULT false,
  count_holiday_as_leave            boolean NOT NULL DEFAULT false,
  gender_restriction                public.gender,
  min_service_months                integer NOT NULL DEFAULT 0,
  max_times_in_service              integer,
  applies_to_employment_types       public.employment_type[],
  requires_approval                 boolean NOT NULL DEFAULT true,
  approval_chain_id                 uuid,   -- FK added by deferred sweep (approval_chains in 029)
  colour_hex                        text,
  is_comp_off                       boolean NOT NULL DEFAULT false,
  is_system_managed                 boolean NOT NULL DEFAULT false,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  created_by                        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  updated_by                        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                        timestamptz,
  deleted_by                        uuid REFERENCES public.profiles(id),
  deletion_reason                   text,
  CONSTRAINT ck_lt__unit            CHECK (unit IN ('day','half_day','hour')),
  CONSTRAINT ck_lt__colour          CHECK (colour_hex IS NULL OR colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT ck_lt__nonnegatives    CHECK (
        min_days_per_request >= 0 AND min_notice_days >= 0 AND max_backdated_days >= 0
    AND accrual_start_after_months >= 0 AND min_service_months >= 0 AND max_negative_days >= 0),
  CONSTRAINT ck_lt__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_types__company_code ON public.leave_types (company_id, code) WHERE deleted_at IS NULL;
-- Exactly one comp-off type per company (§3.7 is_comp_off note).
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_types__one_comp_off ON public.leave_types (company_id) WHERE is_comp_off AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leave_types__company ON public.leave_types (company_id);

-- LWP / CO / OD are system-managed and cannot be deleted (§3.7).
CREATE OR REPLACE FUNCTION public.leave_types_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system_managed THEN
      RAISE EXCEPTION 'leave type % is system-managed and cannot be deleted', OLD.code
        USING errcode = '0A000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.is_system_managed THEN
    RAISE EXCEPTION 'leave type % is system-managed and cannot be deleted', OLD.code
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leave_types__guard
  BEFORE UPDATE OR DELETE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION public.leave_types_guard();

CREATE TRIGGER trg_leave_types__stamp BEFORE INSERT ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_leave_types__touch BEFORE UPDATE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;

-- P7 read, P8 write.
DROP POLICY IF EXISTS leave_types__ref_read ON public.leave_types;
CREATE POLICY leave_types__ref_read ON public.leave_types
  FOR SELECT TO authenticated
  USING ((is_active AND deleted_at IS NULL) OR app.is_admin());

DROP POLICY IF EXISTS leave_types__admin_write ON public.leave_types;
CREATE POLICY leave_types__admin_write ON public.leave_types
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 2. leave_requests (§3.7)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id                       uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_number           text NOT NULL,
  employee_id              uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  leave_type_id            uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE RESTRICT,
  from_date                date NOT NULL,
  to_date                  date NOT NULL,
  total_days               numeric(6,2) NOT NULL DEFAULT 0,
  paid_days                numeric(6,2) NOT NULL DEFAULT 0,
  unpaid_days              numeric(6,2) NOT NULL DEFAULT 0,
  portion                  public.leave_day_portion NOT NULL DEFAULT 'full_day',
  reason                   text NOT NULL,
  contact_during_leave     text,
  address_during_leave     text,
  handover_to_employee_id  uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  handover_notes           text,
  status                   public.leave_request_status NOT NULL DEFAULT 'draft',
  approval_request_id      uuid,   -- FK added by deferred sweep (approval_requests in 029)
  current_approver_id      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  approved_days            numeric(6,2),
  decided_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at               timestamptz,
  decision_comment         text,
  cancelled_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_at             timestamptz,
  cancellation_reason      text,
  supporting_document_id   uuid,   -- FK added by deferred sweep (documents in 025)
  is_backdated             boolean NOT NULL GENERATED ALWAYS AS (from_date < util.ist_date(created_at)) STORED,
  ledger_applied_at        timestamptz,
  clash_summary            jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_lr__range        CHECK (to_date >= from_date),
  CONSTRAINT ck_lr__sane_dates   CHECK (to_date < DATE '2100-01-01'),
  CONSTRAINT ck_lr__reason       CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT ck_lr__portion      CHECK (portion = 'full_day' OR from_date = to_date),
  CONSTRAINT ck_lr__days         CHECK (total_days >= 0 AND paid_days >= 0 AND unpaid_days >= 0
                                        AND paid_days + unpaid_days <= total_days + 0.001),
  CONSTRAINT ck_lr__approved     CHECK (approved_days IS NULL OR approved_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_requests__number ON public.leave_requests (request_number);
CREATE INDEX IF NOT EXISTS idx_leave_requests__employee_dates  ON public.leave_requests (employee_id, from_date DESC, to_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests__status_approver ON public.leave_requests (status, current_approver_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests__type            ON public.leave_requests (leave_type_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests__handover        ON public.leave_requests (handover_to_employee_id) WHERE handover_to_employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leave_requests__range           ON public.leave_requests USING gist (daterange(from_date, to_date, '[]'));

-- Request number: LV-<IST year>-<000123>, generated, never client-supplied.
-- SECURITY DEFINER so the MAX() scan sees all rows regardless of the caller's
-- RLS slice; advisory lock serialises concurrent submitters (same pattern as
-- generate_employee_code, §8.6).
CREATE OR REPLACE FUNCTION public.generate_leave_request_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year integer := EXTRACT(YEAR FROM util.ist_date(now()))::integer;
  v_next integer;
BEGIN
  IF NEW.request_number IS NULL OR btrim(NEW.request_number) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('leave_request_number:' || v_year::text));
    SELECT COALESCE(MAX(substring(lr.request_number FROM '[0-9]+$')::integer), 0) + 1
      INTO v_next
      FROM public.leave_requests lr
     WHERE lr.request_number LIKE 'LV-' || v_year::text || '-%';
    NEW.request_number := format('LV-%s-%s', v_year, lpad(v_next::text, 6, '0'));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leave_requests__number
  BEFORE INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.generate_leave_request_number();

-- uq_leave_requests__no_overlap (§3.7): a pending/approved request may not
-- overlap another live request for the same employee. Trigger-enforced (a
-- partial exclusion constraint cannot reference the status set cleanly across
-- updates).
CREATE OR REPLACE FUNCTION public.leave_requests_no_overlap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_clash text;
BEGIN
  IF NEW.status IN ('pending','approved','partially_approved','cancellation_pending') THEN
    SELECT lr.request_number INTO v_clash
      FROM public.leave_requests lr
     WHERE lr.employee_id = NEW.employee_id
       AND lr.id <> NEW.id
       AND lr.status IN ('pending','approved','partially_approved','cancellation_pending')
       AND daterange(lr.from_date, lr.to_date, '[]') && daterange(NEW.from_date, NEW.to_date, '[]')
     LIMIT 1;
    IF v_clash IS NOT NULL THEN
      RAISE EXCEPTION 'leave request overlaps existing request % for the same employee', v_clash
        USING errcode = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leave_requests__no_overlap
  BEFORE INSERT OR UPDATE OF from_date, to_date, status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_no_overlap();

CREATE TRIGGER trg_leave_requests__stamp BEFORE INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_leave_requests__touch BEFORE UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

-- P1 self CRUD-while-draft, P5 manager read/decide, P8 admin all.
DROP POLICY IF EXISTS leave_requests__scope_read ON public.leave_requests;
CREATE POLICY leave_requests__scope_read ON public.leave_requests
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

DROP POLICY IF EXISTS leave_requests__self_insert ON public.leave_requests;
CREATE POLICY leave_requests__self_insert ON public.leave_requests
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id() AND status = 'draft');

DROP POLICY IF EXISTS leave_requests__self_update ON public.leave_requests;
CREATE POLICY leave_requests__self_update ON public.leave_requests
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','withdrawn'));

DROP POLICY IF EXISTS leave_requests__self_delete ON public.leave_requests;
CREATE POLICY leave_requests__self_delete ON public.leave_requests
  FOR DELETE TO authenticated
  USING (employee_id = app.current_employee_id() AND status = 'draft');

DROP POLICY IF EXISTS leave_requests__manager_decide ON public.leave_requests;
CREATE POLICY leave_requests__manager_decide ON public.leave_requests
  FOR UPDATE TO authenticated
  USING (app.is_manager_of(employee_id)
         AND status IN ('pending','cancellation_pending'))
  WITH CHECK (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS leave_requests__admin_all ON public.leave_requests;
CREATE POLICY leave_requests__admin_all ON public.leave_requests
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 3. leave_request_days (§3.7) — one row per calendar date in the request
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_request_days (
  id                 uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  leave_request_id   uuid NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  leave_date         date NOT NULL,
  portion            public.leave_day_portion NOT NULL DEFAULT 'full_day',
  day_value          numeric(4,3) NOT NULL DEFAULT 1.000,
  is_holiday         boolean NOT NULL DEFAULT false,
  is_weekly_off      boolean NOT NULL DEFAULT false,
  is_counted         boolean NOT NULL DEFAULT true,
  status             public.leave_request_status NOT NULL DEFAULT 'draft',
  attendance_day_id  uuid REFERENCES public.attendance_days(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_lrd__day_value CHECK (day_value IN (0.000, 0.500, 1.000)),
  CONSTRAINT ck_lrd__sane_date CHECK (leave_date < DATE '2100-01-01')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lrd__request_date ON public.leave_request_days (leave_request_id, leave_date);
CREATE INDEX IF NOT EXISTS idx_lrd__date ON public.leave_request_days (leave_date);
CREATE INDEX IF NOT EXISTS idx_lrd__attendance_day ON public.leave_request_days (attendance_day_id) WHERE attendance_day_id IS NOT NULL;

CREATE TRIGGER trg_leave_request_days__stamp BEFORE INSERT ON public.leave_request_days
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_leave_request_days__touch BEFORE UPDATE ON public.leave_request_days
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.leave_request_days ENABLE ROW LEVEL SECURITY;

-- Inherits the parent's audience (P5 via the request join). Rows are built by
-- calc_leave_days() (SECURITY DEFINER); direct client writes are admin-only.
DROP POLICY IF EXISTS leave_request_days__parent_read ON public.leave_request_days;
CREATE POLICY leave_request_days__parent_read ON public.leave_request_days
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leave_requests lr
                 WHERE lr.id = leave_request_id
                   AND app.can_see_employee(lr.employee_id)));

DROP POLICY IF EXISTS leave_request_days__admin_write ON public.leave_request_days;
CREATE POLICY leave_request_days__admin_write ON public.leave_request_days
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 4. comp_off_ledger (§3.7)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.comp_off_ledger (
  id                             uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id                    uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  entry_type                     text NOT NULL,
  days                           numeric(6,3) NOT NULL,
  earned_on_date                 date,
  earned_from_attendance_day_id  uuid REFERENCES public.attendance_days(id) ON DELETE SET NULL,
  earned_minutes                 integer,
  earn_source                    text,
  event_reference                text,
  expires_on                     date,
  availed_via_leave_request_id   uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  availed_on_date                date,
  status                         text NOT NULL DEFAULT 'available',
  days_remaining                 numeric(6,3),
  -- DEVIATION (§8.3): links consumption/expiry event rows to the earned credit
  -- they act on; required for the "(source_id, 'expired')" idempotency rule.
  source_comp_off_id             uuid REFERENCES public.comp_off_ledger(id) ON DELETE SET NULL,
  approved_by                    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at                    timestamptz,
  reason                         text,
  recorded_at                    timestamptz NOT NULL DEFAULT now(),
  recorded_by                    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_col__entry_type  CHECK (entry_type IN ('earned','availed','expired','encashed','cancelled','adjusted')),
  CONSTRAINT ck_col__status      CHECK (status IN ('pending_approval','available','partially_used','used','expired','cancelled')),
  CONSTRAINT ck_col__earn_source CHECK (earn_source IS NULL OR earn_source IN
                                        ('weekly_off_worked','holiday_worked','event_overtime','manual_grant')),
  CONSTRAINT ck_col__granularity CHECK (days <> 0 AND mod(days, 0.5) = 0),
  CONSTRAINT ck_col__sign        CHECK (
        (entry_type = 'earned' AND days > 0)
     OR (entry_type IN ('availed','expired','encashed') AND days < 0)
     OR (entry_type IN ('cancelled','adjusted'))),
  CONSTRAINT ck_col__remaining   CHECK (days_remaining IS NULL OR days_remaining >= 0),
  CONSTRAINT ck_col__sane_dates  CHECK (
        (earned_on_date IS NULL OR earned_on_date < DATE '2100-01-01')
    AND (expires_on     IS NULL OR expires_on     < DATE '2100-01-01'))
);

CREATE INDEX IF NOT EXISTS idx_col__employee_status ON public.comp_off_ledger (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_col__expiring ON public.comp_off_ledger (expires_on)
  WHERE status IN ('available','partially_used');
CREATE INDEX IF NOT EXISTS idx_col__leave_request ON public.comp_off_ledger (availed_via_leave_request_id)
  WHERE availed_via_leave_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_col__source ON public.comp_off_ledger (source_comp_off_id)
  WHERE source_comp_off_id IS NOT NULL;
-- §8.5: one earned credit per attendance day (sync_comp_off_for_day upserts on it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_col__earned_per_day ON public.comp_off_ledger (earned_from_attendance_day_id)
  WHERE entry_type = 'earned' AND earned_from_attendance_day_id IS NOT NULL;
-- §8.3: expiry idempotency — at most one expired row per source credit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_col__expired_once ON public.comp_off_ledger (source_comp_off_id)
  WHERE entry_type = 'expired';

ALTER TABLE public.comp_off_ledger ENABLE ROW LEVEL SECURITY;

-- P5 read, service/RPC write: no write policy for authenticated at all.
DROP POLICY IF EXISTS comp_off_ledger__scope_read ON public.comp_off_ledger;
CREATE POLICY comp_off_ledger__scope_read ON public.comp_off_ledger
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- -----------------------------------------------------------------------------
-- 5. leave_ledger (§3.7) — append-only
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_ledger (
  id                 uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id        uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  leave_type_id      uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE RESTRICT,
  leave_year         integer NOT NULL,
  entry_type         public.ledger_entry_type NOT NULL,
  days               numeric(8,3) NOT NULL,
  effective_date     date NOT NULL,
  description        text NOT NULL,
  source_table       text,
  source_id          uuid,
  leave_request_id   uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  attendance_day_id  uuid REFERENCES public.attendance_days(id) ON DELETE SET NULL,
  comp_off_ledger_id uuid REFERENCES public.comp_off_ledger(id) ON DELETE SET NULL,
  payroll_run_id     uuid,   -- FK added by deferred sweep (payroll_runs in 022)
  balance_after      numeric(8,3),
  reversed_by_id     uuid REFERENCES public.leave_ledger(id) ON DELETE SET NULL,
  reverses_id        uuid REFERENCES public.leave_ledger(id) ON DELETE SET NULL,
  reason             text,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ll__leave_year   CHECK (leave_year BETWEEN 2000 AND 2099),
  CONSTRAINT ck_ll__sane_date    CHECK (effective_date < DATE '2100-01-01'),
  CONSTRAINT ck_ll__days_nonzero CHECK (days <> 0),
  -- ck_ll__sign (§3.7): one sign convention — credits positive, debits negative.
  CONSTRAINT ck_ll__sign CHECK (
    CASE entry_type
      WHEN 'accrual'           THEN days > 0
      WHEN 'pro_rata_accrual'  THEN days > 0
      WHEN 'credit_adjustment' THEN days > 0
      WHEN 'carry_forward_in'  THEN days > 0
      WHEN 'comp_off_credit'   THEN days > 0
      WHEN 'availed_reversal'  THEN days > 0
      WHEN 'availed'           THEN days < 0
      WHEN 'debit_adjustment'  THEN days < 0
      WHEN 'late_deduction'    THEN days < 0
      WHEN 'comp_off_debit'    THEN days < 0
      WHEN 'comp_off_expiry'   THEN days < 0
      WHEN 'carry_forward_out' THEN days < 0
      WHEN 'encashment'        THEN days < 0
      WHEN 'lapse'             THEN days < 0
      ELSE true   -- opening_balance, settlement: either sign
    END),
  -- Reason mandatory for manual adjustments (§3.7).
  CONSTRAINT ck_ll__adjustment_reason CHECK (
    entry_type NOT IN ('credit_adjustment','debit_adjustment')
    OR length(btrim(COALESCE(reason, ''))) >= 10)
);

CREATE INDEX IF NOT EXISTS idx_leave_ledger__emp_type_date ON public.leave_ledger (employee_id, leave_type_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_leave_ledger__source        ON public.leave_ledger (source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_leave_ledger__request       ON public.leave_ledger (leave_request_id) WHERE leave_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leave_ledger__comp_off      ON public.leave_ledger (comp_off_ledger_id) WHERE comp_off_ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leave_ledger__attendance    ON public.leave_ledger (attendance_day_id) WHERE attendance_day_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leave_ledger__payroll_run   ON public.leave_ledger (payroll_run_id) WHERE payroll_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leave_ledger__recorded_brin ON public.leave_ledger USING brin (recorded_at);
-- §8.4: accrual idempotency — one (pro-rata) accrual per employee/type/date.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_ledger__accrual_once
  ON public.leave_ledger (employee_id, leave_type_id, entry_type, effective_date)
  WHERE entry_type IN ('accrual','pro_rata_accrual');

-- balance_after: running per-(employee, type, year) snapshot, stamped by the
-- table itself so every writer gets it for free and statements stay
-- reproducible (§3.7).
CREATE OR REPLACE FUNCTION public.leave_ledger_before_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.balance_after IS NULL THEN
    SELECT COALESCE(SUM(ll.days), 0) + NEW.days
      INTO NEW.balance_after
      FROM public.leave_ledger ll
     WHERE ll.employee_id = NEW.employee_id
       AND ll.leave_type_id = NEW.leave_type_id
       AND ll.leave_year = NEW.leave_year;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leave_ledger__balance_after
  BEFORE INSERT ON public.leave_ledger
  FOR EACH ROW EXECUTE FUNCTION public.leave_ledger_before_insert();

-- Append-only: no DELETE ever; the single permitted UPDATE is stamping
-- reversed_by_id (NULL → id) when a reversing entry is written.
CREATE OR REPLACE FUNCTION public.leave_ledger_guard_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on public.leave_ledger is not permitted: append-only ledger (write a reversing entry)'
      USING errcode = '0A000';
  END IF;
  IF (to_jsonb(NEW) - 'reversed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id') THEN
    RAISE EXCEPTION 'UPDATE on public.leave_ledger may only set reversed_by_id: append-only ledger'
      USING errcode = '0A000';
  END IF;
  IF NEW.reversed_by_id IS DISTINCT FROM OLD.reversed_by_id AND OLD.reversed_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'leave_ledger row % is already reversed by %', OLD.id, OLD.reversed_by_id
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leave_ledger__immutable
  BEFORE UPDATE OR DELETE ON public.leave_ledger
  FOR EACH ROW EXECUTE FUNCTION public.leave_ledger_guard_mutation();

ALTER TABLE public.leave_ledger ENABLE ROW LEVEL SECURITY;

-- P5 read; no client insert/update/delete policy at all — rows arrive only
-- through the SECURITY DEFINER functions below (and service-role jobs).
DROP POLICY IF EXISTS leave_ledger__scope_read ON public.leave_ledger;
CREATE POLICY leave_ledger__scope_read ON public.leave_ledger
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- -----------------------------------------------------------------------------
-- 6. leave_balances (§3.7) — a cache, not a source of truth
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_balances (
  id                      uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id             uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type_id           uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
  leave_year              integer NOT NULL,
  opening_days            numeric(8,3) NOT NULL DEFAULT 0,
  accrued_days            numeric(8,3) NOT NULL DEFAULT 0,
  carried_forward_days    numeric(8,3) NOT NULL DEFAULT 0,
  adjusted_days           numeric(8,3) NOT NULL DEFAULT 0,
  availed_days            numeric(8,3) NOT NULL DEFAULT 0,
  pending_days            numeric(8,3) NOT NULL DEFAULT 0,
  encashed_days           numeric(8,3) NOT NULL DEFAULT 0,
  lapsed_days             numeric(8,3) NOT NULL DEFAULT 0,
  available_days          numeric(8,3) NOT NULL GENERATED ALWAYS AS
    (opening_days + accrued_days + carried_forward_days + adjusted_days
     - availed_days - encashed_days - lapsed_days) STORED,
  -- Generated columns may not reference each other; the expression repeats.
  available_after_pending numeric(8,3) NOT NULL GENERATED ALWAYS AS
    (opening_days + accrued_days + carried_forward_days + adjusted_days
     - availed_days - encashed_days - lapsed_days - pending_days) STORED,
  last_recomputed_at      timestamptz NOT NULL DEFAULT now(),
  ledger_high_water_mark  uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_lb__leave_year CHECK (leave_year BETWEEN 2000 AND 2099)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_balances__emp_type_year ON public.leave_balances (employee_id, leave_type_id, leave_year);
CREATE INDEX IF NOT EXISTS idx_leave_balances__employee ON public.leave_balances (employee_id);

CREATE TRIGGER trg_leave_balances__stamp BEFORE INSERT ON public.leave_balances
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_leave_balances__touch BEFORE UPDATE ON public.leave_balances
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;

-- P5 read; no client write — only recompute_leave_balance() writes here.
DROP POLICY IF EXISTS leave_balances__scope_read ON public.leave_balances;
CREATE POLICY leave_balances__scope_read ON public.leave_balances
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- -----------------------------------------------------------------------------
-- 7. leave_year_rollovers (§3.7)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_year_rollovers (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  from_leave_year      integer NOT NULL,
  to_leave_year        integer NOT NULL,
  leave_type_id        uuid REFERENCES public.leave_types(id) ON DELETE RESTRICT,
  run_at               timestamptz NOT NULL DEFAULT now(),
  run_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status               public.job_run_status NOT NULL DEFAULT 'running',
  employees_processed  integer NOT NULL DEFAULT 0,
  days_carried         numeric(12,3) NOT NULL DEFAULT 0,
  days_lapsed          numeric(12,3) NOT NULL DEFAULT 0,
  days_encashed        numeric(12,3) NOT NULL DEFAULT 0,
  dry_run              boolean NOT NULL DEFAULT true,
  report               jsonb,
  error_detail         text,
  CONSTRAINT ck_lyr__years CHECK (to_leave_year > from_leave_year
                                  AND from_leave_year BETWEEN 2000 AND 2099
                                  AND to_leave_year   BETWEEN 2000 AND 2099)
);

CREATE INDEX IF NOT EXISTS idx_lyr__company_years ON public.leave_year_rollovers (company_id, from_leave_year, to_leave_year);

ALTER TABLE public.leave_year_rollovers ENABLE ROW LEVEL SECURITY;

-- P8 read, P9 execute (super-admin writes; the rollover job runs service-role).
DROP POLICY IF EXISTS leave_year_rollovers__admin_read ON public.leave_year_rollovers;
CREATE POLICY leave_year_rollovers__admin_read ON public.leave_year_rollovers
  FOR SELECT TO authenticated USING (app.is_admin());

DROP POLICY IF EXISTS leave_year_rollovers__super_admin_write ON public.leave_year_rollovers;
CREATE POLICY leave_year_rollovers__super_admin_write ON public.leave_year_rollovers
  FOR ALL TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 8. recompute_leave_balance (§8.2) — folds leave_ledger into leave_balances
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.recompute_leave_balance(
  p_employee_id uuid, p_leave_type_id uuid, p_leave_year integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_prev_reason text := current_setting('app.reason', true);
BEGIN
  -- leave_balances is reason-gated for UPDATE (audit.reason_required_tables,
  -- 006). This is a derived-cache fold, so it self-annotates; the caller's
  -- reason (if any) is restored afterwards.
  PERFORM set_config('app.reason', 'system: leave balance recomputed from ledger', true);

  INSERT INTO public.leave_balances AS lb (employee_id, leave_type_id, leave_year,
    opening_days, accrued_days, carried_forward_days, adjusted_days,
    availed_days, encashed_days, lapsed_days, pending_days,
    last_recomputed_at, ledger_high_water_mark)
  SELECT p_employee_id, p_leave_type_id, p_leave_year,
    COALESCE(SUM(days) FILTER (WHERE entry_type = 'opening_balance'), 0),
    COALESCE(SUM(days) FILTER (WHERE entry_type IN ('accrual','pro_rata_accrual','comp_off_credit')), 0),
    COALESCE(SUM(days) FILTER (WHERE entry_type = 'carry_forward_in'), 0),
    COALESCE(SUM(days) FILTER (WHERE entry_type IN ('credit_adjustment','debit_adjustment')), 0),
    -- positive magnitude of consumption, reduced by reversals (see header note)
    ABS(COALESCE(SUM(days) FILTER (WHERE entry_type IN ('availed','late_deduction','comp_off_debit')), 0))
      - COALESCE(SUM(days) FILTER (WHERE entry_type = 'availed_reversal'), 0),
    ABS(COALESCE(SUM(days) FILTER (WHERE entry_type IN ('encashment','settlement')), 0)),
    ABS(COALESCE(SUM(days) FILTER (WHERE entry_type IN ('lapse','carry_forward_out','comp_off_expiry')), 0)),
    (SELECT COALESCE(SUM(lrd.day_value), 0)
       FROM public.leave_request_days lrd
       JOIN public.leave_requests lr ON lr.id = lrd.leave_request_id
      WHERE lr.employee_id = p_employee_id AND lr.leave_type_id = p_leave_type_id
        AND lr.status = 'pending' AND lrd.is_counted),
    now(),
    (SELECT ll2.id FROM public.leave_ledger ll2
      WHERE ll2.employee_id = p_employee_id AND ll2.leave_type_id = p_leave_type_id
        AND ll2.leave_year = p_leave_year
      ORDER BY ll2.recorded_at DESC, ll2.id DESC LIMIT 1)
  FROM public.leave_ledger
  WHERE employee_id = p_employee_id AND leave_type_id = p_leave_type_id AND leave_year = p_leave_year
  ON CONFLICT (employee_id, leave_type_id, leave_year) DO UPDATE SET
    opening_days           = EXCLUDED.opening_days,
    accrued_days           = EXCLUDED.accrued_days,
    carried_forward_days   = EXCLUDED.carried_forward_days,
    adjusted_days          = EXCLUDED.adjusted_days,
    availed_days           = EXCLUDED.availed_days,
    encashed_days          = EXCLUDED.encashed_days,
    lapsed_days            = EXCLUDED.lapsed_days,
    pending_days           = EXCLUDED.pending_days,
    last_recomputed_at     = EXCLUDED.last_recomputed_at,
    ledger_high_water_mark = EXCLUDED.ledger_high_water_mark;

  PERFORM set_config('app.reason', COALESCE(v_prev_reason, ''), true);
END;
$$;

-- §8.2 trigger 1: any leave_ledger insert — statement-level, per distinct key.
CREATE OR REPLACE FUNCTION public.leave_ledger_recompute_balances()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT nr.employee_id, nr.leave_type_id, nr.leave_year FROM new_rows nr LOOP
    PERFORM public.recompute_leave_balance(r.employee_id, r.leave_type_id, r.leave_year);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_leave_ledger__recompute
  AFTER INSERT ON public.leave_ledger
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.leave_ledger_recompute_balances();

-- §8.2 trigger 2: any leave_requests status change (pending_days moves).
CREATE OR REPLACE FUNCTION public.leave_requests_recompute_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.recompute_leave_balance(
    NEW.employee_id, NEW.leave_type_id, public.leave_year_of(NEW.from_date));
  IF public.leave_year_of(NEW.to_date) <> public.leave_year_of(NEW.from_date) THEN
    PERFORM public.recompute_leave_balance(
      NEW.employee_id, NEW.leave_type_id, public.leave_year_of(NEW.to_date));
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.leave_type_id <> NEW.leave_type_id THEN
    PERFORM public.recompute_leave_balance(
      OLD.employee_id, OLD.leave_type_id, public.leave_year_of(OLD.from_date));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_leave_requests__recompute
  AFTER INSERT OR UPDATE OF status, total_days, leave_type_id ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_recompute_balance();

-- -----------------------------------------------------------------------------
-- 9. calc_leave_days (§3.7) — expands a request into leave_request_days and
--    computes total_days; never client-supplied.
-- -----------------------------------------------------------------------------

-- Internal expander: rebuilds the day rows for the given span and returns the
-- counted total. Parameterised so the submit guard can run it against NEW
-- values before they are stored.
CREATE OR REPLACE FUNCTION public.rebuild_leave_request_days(
  p_request_id uuid, p_employee_id uuid, p_leave_type_id uuid,
  p_from date, p_to date, p_portion public.leave_day_portion,
  p_status public.leave_request_status)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  lt        public.leave_types%ROWTYPE;
  e         public.employees%ROWTYPE;
  d         date;
  v_cal     uuid;
  v_rule    uuid;
  v_is_hol  boolean;
  v_is_off  boolean;
  v_counted boolean;
  v_portion public.leave_day_portion;
  v_value   numeric(4,3);
  v_total   numeric := 0;
BEGIN
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'leave request span exceeds 366 days' USING errcode = '23514';
  END IF;

  SELECT * INTO lt FROM public.leave_types WHERE id = p_leave_type_id;
  SELECT * INTO e  FROM public.employees   WHERE id = p_employee_id;
  IF lt.id IS NULL OR e.id IS NULL THEN
    RAISE EXCEPTION 'leave request references unknown employee or leave type' USING errcode = '23503';
  END IF;

  DELETE FROM public.leave_request_days WHERE leave_request_id = p_request_id;

  d := p_from;
  WHILE d <= p_to LOOP
    v_cal    := COALESCE(public.resolve_policy('holiday_calendar', p_employee_id, d), e.holiday_calendar_id);
    v_is_hol := EXISTS (
      SELECT 1 FROM public.holidays h
       WHERE h.holiday_calendar_id = v_cal
         AND h.holiday_date = d
         AND h.is_active
         AND NOT h.is_optional
         AND (h.applies_to_department_ids IS NULL OR e.department_id = ANY (h.applies_to_department_ids))
         AND (h.applies_to_location_ids   IS NULL OR e.location_id   = ANY (h.applies_to_location_ids)));
    v_rule   := COALESCE(public.resolve_policy('weekly_off_rule', p_employee_id, d), e.weekly_off_rule_id);
    v_is_off := public.is_weekly_off(v_rule, d, p_employee_id);

    v_portion := CASE WHEN p_from = p_to THEN p_portion ELSE 'full_day' END;
    v_counted := CASE
                   WHEN v_is_hol THEN (lt.count_holiday_as_leave    OR lt.sandwich_holidays)
                   WHEN v_is_off THEN (lt.count_weekly_off_as_leave OR lt.sandwich_holidays)
                   ELSE true
                 END;
    v_value   := CASE
                   WHEN NOT v_counted THEN 0.000
                   WHEN v_portion = 'full_day' THEN 1.000
                   ELSE 0.500
                 END;

    INSERT INTO public.leave_request_days
      (leave_request_id, leave_date, portion, day_value, is_holiday, is_weekly_off, is_counted, status)
    VALUES (p_request_id, d, v_portion, v_value, v_is_hol, v_is_off, v_counted, p_status);

    v_total := v_total + v_value;
    d := d + 1;
  END LOOP;

  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.calc_leave_days(p_leave_request_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  lr      public.leave_requests%ROWTYPE;
  lt      public.leave_types%ROWTYPE;
  v_total numeric;
BEGIN
  SELECT * INTO lr FROM public.leave_requests WHERE id = p_leave_request_id;
  IF lr.id IS NULL THEN
    RAISE EXCEPTION 'leave request % not found', p_leave_request_id USING errcode = 'P0002';
  END IF;
  -- Definer function: re-assert the caller's right to touch this request.
  IF app.ctx_actor_id() IS NOT NULL AND NOT app.can_see_employee(lr.employee_id) THEN
    RAISE EXCEPTION 'not allowed to compute days for this leave request' USING errcode = '42501';
  END IF;
  IF lr.status NOT IN ('draft','pending') THEN
    RAISE EXCEPTION 'leave request % is % — days can only be recomputed while draft/pending',
      lr.request_number, lr.status USING errcode = '23514';
  END IF;

  SELECT * INTO lt FROM public.leave_types WHERE id = lr.leave_type_id;
  v_total := public.rebuild_leave_request_days(
    lr.id, lr.employee_id, lr.leave_type_id, lr.from_date, lr.to_date, lr.portion, lr.status);

  UPDATE public.leave_requests
     SET total_days  = v_total,
         unpaid_days = CASE WHEN lt.is_paid THEN LEAST(unpaid_days, v_total) ELSE v_total END,
         paid_days   = CASE WHEN lt.is_paid THEN v_total - LEAST(unpaid_days, v_total) ELSE 0 END
   WHERE id = lr.id;

  RETURN v_total;
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. Submit guard — validates the draft → pending transition, recomputes the
--     day expansion from NEW values, and enforces the leave_types rulebook.
--     Policy-rule checks (notice, backdating, probation, service, quota
--     counters) apply to self-service submissions; admin/HR and service-role
--     writers bypass those but never the structural ones.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leave_requests_submit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  lt            public.leave_types%ROWTYPE;
  e             public.employees%ROWTYPE;
  v_today       date := util.ist_today();
  v_total       numeric;
  v_self_serve  boolean;
  v_year        integer;
  v_available   numeric;
  v_have_co     numeric;
  v_times       integer;
  v_service_mo  integer;
BEGIN
  IF NOT (NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status = 'draft')) THEN
    RETURN NEW;   -- only the submission transition is validated here
  END IF;

  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;
  SELECT * INTO e  FROM public.employees   WHERE id = NEW.employee_id;
  v_self_serve := (NEW.employee_id = app.current_employee_id()) AND NOT app.is_admin();

  IF NOT lt.is_active OR lt.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'leave type % is not active', lt.code USING errcode = '23514';
  END IF;

  -- Structural checks (everyone).
  IF NEW.portion <> 'full_day' AND NOT lt.allow_half_day THEN
    RAISE EXCEPTION 'leave type % does not allow half days', lt.code USING errcode = '23514';
  END IF;
  IF lt.gender_restriction IS NOT NULL AND e.gender IS DISTINCT FROM lt.gender_restriction THEN
    RAISE EXCEPTION 'leave type % is restricted to % employees', lt.code, lt.gender_restriction
      USING errcode = '23514';
  END IF;
  IF lt.applies_to_employment_types IS NOT NULL
     AND NOT (e.employment_type = ANY (lt.applies_to_employment_types)) THEN
    RAISE EXCEPTION 'leave type % does not apply to % employees', lt.code, e.employment_type
      USING errcode = '23514';
  END IF;

  -- Recompute the day expansion from NEW values; totals are never client-set.
  v_total := public.rebuild_leave_request_days(
    NEW.id, NEW.employee_id, NEW.leave_type_id, NEW.from_date, NEW.to_date, NEW.portion, 'pending');
  NEW.total_days  := v_total;
  IF lt.is_paid THEN
    NEW.unpaid_days := LEAST(COALESCE(NEW.unpaid_days, 0), v_total);
    NEW.paid_days   := v_total - NEW.unpaid_days;
  ELSE
    NEW.paid_days   := 0;
    NEW.unpaid_days := v_total;
  END IF;

  IF v_total < lt.min_days_per_request THEN
    RAISE EXCEPTION 'request is % day(s); leave type % requires at least %',
      v_total, lt.code, lt.min_days_per_request USING errcode = '23514';
  END IF;
  IF lt.max_days_per_request IS NOT NULL AND v_total > lt.max_days_per_request THEN
    RAISE EXCEPTION 'request is % day(s); leave type % allows at most % per request',
      v_total, lt.code, lt.max_days_per_request USING errcode = '23514';
  END IF;
  IF lt.max_consecutive_days IS NOT NULL AND v_total > lt.max_consecutive_days THEN
    RAISE EXCEPTION 'request is % consecutive day(s); leave type % allows at most %',
      v_total, lt.code, lt.max_consecutive_days USING errcode = '23514';
  END IF;

  -- Venue rules (everyone): named cover for operational departments; contact
  -- address for long leaves (§3.7).
  IF NEW.handover_to_employee_id IS NULL
     AND EXISTS (SELECT 1 FROM public.departments d
                 WHERE d.id = e.department_id AND d.is_operational) THEN
    RAISE EXCEPTION 'handover_to_employee_id is mandatory for operational departments'
      USING errcode = '23514';
  END IF;
  IF v_total > 7 AND NULLIF(btrim(COALESCE(NEW.address_during_leave, '')), '') IS NULL THEN
    RAISE EXCEPTION 'address_during_leave is required for leave longer than 7 days'
      USING errcode = '23514';
  END IF;

  -- Policy-rule checks (self-service only; HR/admin/system entries bypass).
  IF v_self_serve THEN
    IF NEW.from_date < v_today AND (v_today - NEW.from_date) > lt.max_backdated_days THEN
      RAISE EXCEPTION 'leave type % may be backdated at most % day(s)',
        lt.code, lt.max_backdated_days USING errcode = '23514';
    END IF;
    IF NEW.from_date >= v_today AND (NEW.from_date - v_today) < lt.min_notice_days THEN
      RAISE EXCEPTION 'leave type % requires % day(s) notice', lt.code, lt.min_notice_days
        USING errcode = '23514';
    END IF;
    IF e.employment_status = 'on_probation' AND NOT lt.availing_allowed_during_probation THEN
      RAISE EXCEPTION 'leave type % cannot be availed during probation', lt.code
        USING errcode = '23514';
    END IF;
    IF lt.min_service_months > 0 THEN
      v_service_mo := (EXTRACT(YEAR  FROM age(NEW.from_date, e.date_of_join)) * 12
                     + EXTRACT(MONTH FROM age(NEW.from_date, e.date_of_join)))::integer;
      IF e.date_of_join IS NULL OR v_service_mo < lt.min_service_months THEN
        RAISE EXCEPTION 'leave type % requires % month(s) of service', lt.code, lt.min_service_months
          USING errcode = '23514';
      END IF;
    END IF;
    IF lt.max_times_in_service IS NOT NULL THEN
      SELECT count(*) INTO v_times
        FROM public.leave_requests lr
       WHERE lr.employee_id = NEW.employee_id
         AND lr.leave_type_id = NEW.leave_type_id
         AND lr.id <> NEW.id
         AND lr.status IN ('approved','partially_approved');
      IF v_times >= lt.max_times_in_service THEN
        RAISE EXCEPTION 'leave type % may be availed at most % time(s) in service',
          lt.code, lt.max_times_in_service USING errcode = '23514';
      END IF;
    END IF;
  END IF;

  -- Balance gate: the spendable figure is available_after_pending (§3.7).
  IF lt.is_comp_off THEN
    SELECT COALESCE(SUM(COALESCE(c.days_remaining, c.days)), 0) INTO v_have_co
      FROM public.comp_off_ledger c
     WHERE c.employee_id = NEW.employee_id
       AND c.entry_type = 'earned'
       AND c.status IN ('available','partially_used')
       AND (c.expires_on IS NULL OR c.expires_on >= NEW.from_date);
    IF NEW.paid_days > v_have_co THEN
      RAISE EXCEPTION 'insufficient comp-off balance: need %, have % unexpired day(s)',
        NEW.paid_days, v_have_co USING errcode = '23514';
    END IF;
  ELSIF lt.is_paid AND NOT lt.is_system_managed THEN
    v_year := public.leave_year_of(NEW.from_date);
    PERFORM public.recompute_leave_balance(NEW.employee_id, NEW.leave_type_id, v_year);
    SELECT lb.available_after_pending INTO v_available
      FROM public.leave_balances lb
     WHERE lb.employee_id = NEW.employee_id
       AND lb.leave_type_id = NEW.leave_type_id
       AND lb.leave_year = v_year;
    v_available := COALESCE(v_available, 0);
    -- The CASE must be parenthesised: plpgsql's IF parser terminates its
    -- condition at the first THEN token, which would otherwise be the CASE's.
    IF NEW.paid_days > v_available + (CASE WHEN lt.allow_negative_balance THEN lt.max_negative_days ELSE 0 END) THEN
      RAISE EXCEPTION
        'insufficient % balance: need % paid day(s), % available — reduce days or mark the overflow as unpaid (LWP)',
        lt.code, NEW.paid_days, v_available USING errcode = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leave_requests__submit_guard
  BEFORE INSERT OR UPDATE OF status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_submit_guard();

-- -----------------------------------------------------------------------------
-- 11. consume_comp_off — FIFO by expires_on (§3.7 comp_off_ledger notes)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.consume_comp_off(
  p_employee_id uuid, p_days numeric, p_leave_request_id uuid DEFAULT NULL,
  p_availed_on date DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c            record;
  v_on         date := COALESCE(p_availed_on, util.ist_today());
  v_needed     numeric := p_days;
  v_take       numeric;
  v_remaining  numeric;
  v_co_type    uuid;
  v_req_number text;
BEGIN
  IF p_days IS NULL OR p_days <= 0 OR mod(p_days, 0.5) <> 0 THEN
    RAISE EXCEPTION 'comp-off consumption must be a positive multiple of 0.5, got %', p_days
      USING errcode = '22023';
  END IF;

  -- Serialise per employee so two approvals cannot spend the same credit.
  PERFORM pg_advisory_xact_lock(hashtext('comp_off_consume:' || p_employee_id::text));

  FOR c IN
    SELECT * FROM public.comp_off_ledger col
     WHERE col.employee_id = p_employee_id
       AND col.entry_type = 'earned'
       AND col.status IN ('available','partially_used')
       AND (col.expires_on IS NULL OR col.expires_on >= v_on)
     ORDER BY col.expires_on ASC NULLS LAST, col.earned_on_date ASC, col.recorded_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_needed <= 0;
    v_remaining := COALESCE(c.days_remaining, c.days);
    CONTINUE WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, v_needed);

    INSERT INTO public.comp_off_ledger
      (employee_id, entry_type, days, earned_on_date, earn_source, event_reference,
       expires_on, availed_via_leave_request_id, availed_on_date, status,
       source_comp_off_id, reason, recorded_by)
    VALUES
      (p_employee_id, 'availed', -v_take, c.earned_on_date, c.earn_source, c.event_reference,
       c.expires_on, p_leave_request_id, v_on, 'used',
       c.id, 'comp-off consumed (FIFO by expiry)', app.ctx_actor_id());

    UPDATE public.comp_off_ledger
       SET days_remaining = v_remaining - v_take,
           status = CASE WHEN v_remaining - v_take <= 0 THEN 'used' ELSE 'partially_used' END
     WHERE id = c.id;

    v_needed := v_needed - v_take;
  END LOOP;

  IF v_needed > 0 THEN
    RAISE EXCEPTION 'insufficient comp-off balance: short % day(s)', v_needed
      USING errcode = '23514';
  END IF;

  -- Mirror the debit into the leave ledger against the comp-off leave type.
  SELECT lt.id INTO v_co_type
    FROM public.leave_types lt
    JOIN public.employees e ON e.company_id = lt.company_id
   WHERE e.id = p_employee_id AND lt.is_comp_off AND lt.deleted_at IS NULL
   LIMIT 1;
  IF v_co_type IS NOT NULL THEN
    SELECT lr.request_number INTO v_req_number
      FROM public.leave_requests lr WHERE lr.id = p_leave_request_id;
    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, source_id, leave_request_id, recorded_by)
    VALUES
      (p_employee_id, v_co_type, public.leave_year_of(v_on), 'comp_off_debit', -p_days, v_on,
       'Comp-off availed' || COALESCE(' against ' || v_req_number, ''),
       'leave_requests', p_leave_request_id, p_leave_request_id, app.ctx_actor_id());
  END IF;

  RETURN p_days;
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. Ledger application — approval debits, cancellation reversals (§3.7
--     ledger_applied_at: "set when debits were written; makes double-debiting
--     impossible").
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leave_requests_apply_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  lt       public.leave_types%ROWTYPE;
  r        record;
  v_days   numeric;
  v_debit  numeric;
  v_rev_id uuid;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;

  -- ── Approval: write the availed debits exactly once ──────────────────────
  IF NEW.status IN ('approved','partially_approved') AND NEW.ledger_applied_at IS NULL THEN
    IF NEW.status = 'approved' THEN
      UPDATE public.leave_request_days
         SET status = 'approved' WHERE leave_request_id = NEW.id;
    END IF;
    -- Partial approvals: the decider marks per-day statuses first; only
    -- approved+counted day rows are debited.
    SELECT COALESCE(SUM(day_value), 0) INTO v_days
      FROM public.leave_request_days
     WHERE leave_request_id = NEW.id AND is_counted AND status = 'approved';

    v_debit := GREATEST(v_days - COALESCE(NEW.unpaid_days, 0), 0);

    IF lt.is_comp_off THEN
      IF v_debit > 0 THEN
        PERFORM public.consume_comp_off(NEW.employee_id, v_debit, NEW.id, NEW.from_date);
      END IF;
    ELSIF lt.is_paid AND NOT lt.is_system_managed AND v_debit > 0 THEN
      INSERT INTO public.leave_ledger
        (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
         description, source_table, source_id, leave_request_id, recorded_by)
      VALUES
        (NEW.employee_id, NEW.leave_type_id, public.leave_year_of(NEW.from_date),
         'availed', -v_debit, NEW.from_date,
         format('%s availed %s to %s (%s)', lt.code,
                to_char(NEW.from_date, 'DD-Mon-YYYY'), to_char(NEW.to_date, 'DD-Mon-YYYY'),
                NEW.request_number),
         'leave_requests', NEW.id, NEW.id, app.ctx_actor_id());
    END IF;
    -- LWP/OD (unpaid or no-balance types) mark attendance only; no ledger debit.

    UPDATE public.leave_requests
       SET ledger_applied_at = now(),
           approved_days     = COALESCE(approved_days, v_days)
     WHERE id = NEW.id;

  -- ── Un-approval: reverse every un-reversed debit of this request ─────────
  ELSIF OLD.status IN ('approved','partially_approved')
        AND NEW.status IN ('cancelled','rejected','withdrawn')
        AND NEW.ledger_applied_at IS NOT NULL THEN

    FOR r IN
      SELECT * FROM public.leave_ledger ll
       WHERE ll.leave_request_id = NEW.id
         AND ll.entry_type IN ('availed','comp_off_debit')
         AND ll.reversed_by_id IS NULL
    LOOP
      INSERT INTO public.leave_ledger
        (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
         description, source_table, source_id, leave_request_id, reverses_id, recorded_by)
      VALUES
        (r.employee_id, r.leave_type_id, r.leave_year, 'availed_reversal', -r.days,
         util.ist_today(),
         format('Reversal of %s — request %s %s', r.entry_type, NEW.request_number, NEW.status),
         'leave_requests', NEW.id, NEW.id, r.id, app.ctx_actor_id())
      RETURNING id INTO v_rev_id;
      UPDATE public.leave_ledger SET reversed_by_id = v_rev_id WHERE id = r.id;
    END LOOP;

    -- Comp-off: restore the consumed credits (unless they have since expired).
    FOR r IN
      SELECT * FROM public.comp_off_ledger col
       WHERE col.availed_via_leave_request_id = NEW.id
         AND col.entry_type = 'availed'
         AND col.source_comp_off_id IS NOT NULL
    LOOP
      UPDATE public.comp_off_ledger c
         SET days_remaining = LEAST(COALESCE(c.days_remaining, 0) + ABS(r.days), c.days),
             status = CASE WHEN COALESCE(c.days_remaining, 0) + ABS(r.days) >= c.days
                           THEN 'available' ELSE 'partially_used' END
       WHERE c.id = r.source_comp_off_id
         AND c.status IN ('available','partially_used','used');
      IF FOUND THEN
        INSERT INTO public.comp_off_ledger
          (employee_id, entry_type, days, earned_on_date, expires_on,
           availed_via_leave_request_id, availed_on_date, status,
           source_comp_off_id, reason, recorded_by)
        VALUES
          (r.employee_id, 'adjusted', ABS(r.days), r.earned_on_date, r.expires_on,
           NEW.id, r.availed_on_date, 'available',
           r.source_comp_off_id,
           format('credit restored — request %s %s', NEW.request_number, NEW.status),
           app.ctx_actor_id());
      END IF;
    END LOOP;

    UPDATE public.leave_request_days
       SET status = NEW.status WHERE leave_request_id = NEW.id;
    UPDATE public.leave_requests
       SET ledger_applied_at = NULL WHERE id = NEW.id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_leave_requests__apply_ledger
  AFTER UPDATE OF status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_apply_ledger();

-- -----------------------------------------------------------------------------
-- 13. accrue_leave (§8.4) — monthly on the 1st at 01:00 IST; on-demand with
--     dry_run. Idempotent via uq_leave_ledger__accrual_once.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.accrue_leave(p_as_of date, p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  rec           record;
  v_month_start date := date_trunc('month', p_as_of)::date;
  v_prev_start  date := (date_trunc('month', p_as_of) - interval '1 month')::date;
  v_prev_end    date := v_month_start - 1;
  v_days_prev   integer := v_prev_end - v_prev_start + 1;
  v_days        numeric;
  v_paid        numeric;
  v_entry       public.ledger_entry_type;
  v_year        integer := public.leave_year_of(v_month_start);
  v_id          uuid;
  v_balance     numeric;
  v_excess      numeric;
  v_written     integer := 0;
  v_skipped     integer := 0;
  v_details     jsonb := '[]'::jsonb;
BEGIN
  FOR rec IN
    SELECT e.id AS employee_id, e.employee_code, e.date_of_join, e.employment_status,
           lt.id AS leave_type_id, lt.code AS lt_code, lt.*
      FROM public.employees e
      JOIN public.leave_types lt
        ON lt.company_id = e.company_id
     WHERE e.deleted_at IS NULL
       AND e.employment_status IN ('active','on_probation','confirmed','on_notice','on_long_leave')
       AND e.date_of_join IS NOT NULL
       AND e.date_of_join <= v_prev_end
       AND lt.is_active AND lt.deleted_at IS NULL
       AND lt.accrual_frequency = 'monthly'
       AND (lt.accrual_days_per_period IS NOT NULL
            OR (lt.accrual_on_working_days_basis AND lt.accrual_days_per_worked_days IS NOT NULL))
  LOOP
    -- Eligibility gates.
    IF rec.gender_restriction IS NOT NULL THEN
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.employees e2
                                WHERE e2.id = rec.employee_id
                                  AND e2.gender = rec.gender_restriction);
    END IF;
    IF rec.applies_to_employment_types IS NOT NULL THEN
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.employees e2
                                WHERE e2.id = rec.employee_id
                                  AND e2.employment_type = ANY (rec.applies_to_employment_types));
    END IF;
    IF (EXTRACT(YEAR  FROM age(v_month_start, rec.date_of_join)) * 12
      + EXTRACT(MONTH FROM age(v_month_start, rec.date_of_join)))::integer
       < rec.accrual_start_after_months THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Amount.
    v_entry := 'accrual';
    IF rec.accrual_on_working_days_basis AND rec.accrual_days_per_worked_days IS NOT NULL THEN
      -- Karnataka S&E earned leave: 1 day per 20 days worked (§3.7).
      SELECT COALESCE(SUM(ad.day_fraction_paid), 0) INTO v_paid
        FROM public.attendance_days ad
       WHERE ad.employee_id = rec.employee_id
         AND ad.ist_date BETWEEN v_prev_start AND v_prev_end;
      v_days := round(rec.accrual_days_per_worked_days * v_paid, 3);
    ELSE
      v_days := rec.accrual_days_per_period;
      IF rec.pro_rata_on_join AND rec.date_of_join > v_prev_start THEN
        SELECT COALESCE(SUM(ad.day_fraction_paid), 0) INTO v_paid
          FROM public.attendance_days ad
         WHERE ad.employee_id = rec.employee_id
           AND ad.ist_date BETWEEN v_prev_start AND v_prev_end;
        IF v_paid <= 0 THEN
          -- attendance not yet computed for the month — calendar fallback
          v_paid := (v_prev_end - rec.date_of_join + 1);
        END IF;
        v_days  := round(v_days * v_paid / v_days_prev, 3);
        v_entry := 'pro_rata_accrual';
      END IF;
    END IF;

    IF v_days IS NULL OR v_days <= 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF p_dry_run THEN
      v_details := v_details || jsonb_build_object(
        'employee_code', rec.employee_code, 'leave_type', rec.lt_code,
        'entry_type', v_entry::text, 'days', v_days, 'effective_date', v_month_start);
      v_written := v_written + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, recorded_by)
    VALUES
      (rec.employee_id, rec.leave_type_id, v_year, v_entry, v_days, v_month_start,
       format('Monthly accrual for %s', to_char(v_prev_start, 'FMMonth YYYY')),
       CASE WHEN app.ctx_actor_id() IS NULL THEN 'cron' ELSE 'manual' END,
       app.ctx_actor_id())
    ON CONFLICT (employee_id, leave_type_id, entry_type, effective_date)
      WHERE entry_type IN ('accrual','pro_rata_accrual')
      DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      v_skipped := v_skipped + 1;   -- already accrued for this month (idempotent re-run)
      CONTINUE;
    END IF;
    v_written := v_written + 1;

    -- Cap at max_balance_days; the excess lapses loudly, never silently (§8.4).
    IF rec.max_balance_days IS NOT NULL THEN
      SELECT COALESCE(SUM(ll.days), 0) INTO v_balance
        FROM public.leave_ledger ll
       WHERE ll.employee_id = rec.employee_id
         AND ll.leave_type_id = rec.leave_type_id
         AND ll.leave_year = v_year;
      v_excess := v_balance - rec.max_balance_days;
      IF v_excess > 0 THEN
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
           description, source_table, source_id, recorded_by)
        VALUES
          (rec.employee_id, rec.leave_type_id, v_year, 'lapse', -v_excess, v_month_start,
           format('Accrual capped at %s days', rec.max_balance_days),
           'cron', v_id, app.ctx_actor_id());
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'as_of', p_as_of, 'effective_date', v_month_start,
    'accrued_for_month', to_char(v_prev_start, 'FMMonth YYYY'),
    'dry_run', p_dry_run, 'entries', v_written, 'skipped', v_skipped,
    'details', CASE WHEN p_dry_run THEN v_details ELSE NULL END);
END;
$$;

-- -----------------------------------------------------------------------------
-- 14. expire_comp_off (§8.3) — daily 01:30 IST. The −14/−7/−1 day
--     COMP_OFF_EXPIRING notifications are enqueued by the cron/edge layer
--     (041 + notifications, 027) reading idx_col__expiring; this function
--     performs only the ledger work.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_comp_off()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r           record;
  v_today     date := util.ist_today();
  v_remaining numeric;
  v_exp_id    uuid;
  v_co_type   uuid;
  v_count     integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.comp_off_ledger col
     WHERE col.entry_type = 'earned'
       AND col.status IN ('available','partially_used')
       AND col.expires_on IS NOT NULL
       AND col.expires_on < v_today
     FOR UPDATE
  LOOP
    v_remaining := COALESCE(r.days_remaining, r.days);

    IF v_remaining > 0 THEN
      INSERT INTO public.comp_off_ledger
        (employee_id, entry_type, days, earned_on_date, earned_minutes, earn_source,
         event_reference, expires_on, status, source_comp_off_id, reason)
      VALUES
        (r.employee_id, 'expired', -v_remaining, r.earned_on_date, r.earned_minutes, r.earn_source,
         r.event_reference, r.expires_on, 'expired', r.id, 'comp-off credit expired unused')
      ON CONFLICT (source_comp_off_id) WHERE entry_type = 'expired' DO NOTHING
      RETURNING id INTO v_exp_id;

      IF v_exp_id IS NOT NULL THEN
        SELECT lt.id INTO v_co_type
          FROM public.leave_types lt
          JOIN public.employees e ON e.company_id = lt.company_id
         WHERE e.id = r.employee_id AND lt.is_comp_off AND lt.deleted_at IS NULL
         LIMIT 1;
        IF v_co_type IS NOT NULL THEN
          INSERT INTO public.leave_ledger
            (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
             description, source_table, source_id, comp_off_ledger_id)
          VALUES
            (r.employee_id, v_co_type, public.leave_year_of(r.expires_on),
             'comp_off_expiry', -v_remaining, r.expires_on,
             format('Comp-off earned on %s expired unused',
                    COALESCE(to_char(r.earned_on_date, 'DD-Mon-YYYY'), '(unknown date)')),
             'comp_off_ledger', v_exp_id, r.id);
        END IF;
        v_count := v_count + 1;
      END IF;
    END IF;

    UPDATE public.comp_off_ledger
       SET status = 'expired', days_remaining = 0
     WHERE id = r.id;
  END LOOP;

  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 15. Grants
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT SELECT ON public.leave_types, public.leave_requests, '
        || 'public.leave_request_days, public.comp_off_ledger, public.leave_ledger, '
        || 'public.leave_balances, public.leave_year_rollovers TO %I', v_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Row access is policy-gated; ledger/balances/comp-off get NO client write.
    GRANT INSERT, UPDATE ON public.leave_types TO authenticated;
    GRANT INSERT, UPDATE, DELETE ON public.leave_requests, public.leave_request_days TO authenticated;
    GRANT INSERT, UPDATE ON public.leave_year_rollovers TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT INSERT, UPDATE, DELETE ON public.leave_types, public.leave_requests,
      public.leave_request_days, public.leave_year_rollovers TO service_role;
    GRANT INSERT, UPDATE ON public.comp_off_ledger, public.leave_balances TO service_role;
    GRANT INSERT, UPDATE ON public.leave_ledger TO service_role;  -- UPDATE limited to reversed_by_id by trigger
  END IF;
END $$;

DO $$
DECLARE
  v_fn   text;
  v_fns  text[] := ARRAY[
    'public.leave_year_of(date)',
    'public.recompute_leave_balance(uuid, uuid, integer)',
    'public.rebuild_leave_request_days(uuid, uuid, uuid, date, date, public.leave_day_portion, public.leave_request_status)',
    'public.calc_leave_days(uuid)',
    'public.consume_comp_off(uuid, numeric, uuid, date)',
    'public.accrue_leave(date, boolean)',
    'public.expire_comp_off()'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.leave_year_of(date) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.calc_leave_days(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.recompute_leave_balance(uuid, uuid, integer) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.leave_year_of(date) TO service_role;
    GRANT EXECUTE ON FUNCTION public.calc_leave_days(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.recompute_leave_balance(uuid, uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.consume_comp_off(uuid, numeric, uuid, date) TO service_role;
    GRANT EXECUTE ON FUNCTION public.accrue_leave(date, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION public.expire_comp_off() TO service_role;
  END IF;
END $$;

COMMIT;
