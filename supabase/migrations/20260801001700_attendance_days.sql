-- =============================================================================
-- Migration 017 — attendance_days, attendance_regularizations, attendance_locks,
--                 attendance_recompute_queue, attendance_recompute_runs
-- Source: docs/plan/04-data-model.md §3.5 (lines 1413–1556, column contracts
--         and index/constraint SQL verbatim); spec-migrations §2 row 017.
--
-- attendance_days is the computed per-employee-per-IST-date record: exactly
-- one row per (employee_id, ist_date), one writer (compute_attendance_day,
-- migration 018), one formula. is_working_day is a GENERATED column — THE
-- single definition of "working day"; every denominator reads it.
--
-- FK notes:
--   * first_in_punch_id / last_out_punch_id are plain uuids — the punches
--     parent is partitioned with PK (id, punched_at), so a plain-id FK is
--     impossible (same treatment as face_match_log_id in 016).
--   * leave_type_id / leave_request_id / comp_off_ledger_id (019) and
--     payroll_run_id (022), plus regularizations.supporting_document_id (025)
--     and approval_request_id (029), are attached by the deferred sweep (049).
--   * attendance_days.regularization_id ↔ attendance_regularizations is
--     circular within this file; the FK is ALTERed on after both exist.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. attendance_locks — freezes a date range under finalised payroll (§3.5)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_locks (
  id             uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  scope          text NOT NULL DEFAULT 'company',
  location_id    uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  department_id  uuid REFERENCES public.departments(id) ON DELETE CASCADE,
  employee_id    uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  pay_period_id  uuid REFERENCES public.pay_periods(id) ON DELETE SET NULL,
  from_date      date NOT NULL,   -- inclusive
  to_date        date NOT NULL,   -- inclusive: all ranges in this product are [from, to]
  lock_kind      text NOT NULL DEFAULT 'soft',
  reason         text NOT NULL,
  locked_by      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  locked_at      timestamptz NOT NULL DEFAULT now(),
  unlocked_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  unlocked_at    timestamptz,
  unlock_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_al__scope     CHECK (scope IN ('company','location','department','employee')),
  CONSTRAINT ck_al__lock_kind CHECK (lock_kind IN ('soft','hard')),
  CONSTRAINT ck_al__range     CHECK (to_date >= from_date),
  CONSTRAINT ck_al__sane_dates CHECK (to_date < DATE '2100-01-01'),
  CONSTRAINT ck_al__reason    CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT ck_al__scope_target CHECK (
    CASE scope
      WHEN 'company'    THEN true
      WHEN 'location'   THEN location_id   IS NOT NULL
      WHEN 'department' THEN department_id IS NOT NULL
      WHEN 'employee'   THEN employee_id   IS NOT NULL
    END),
  CONSTRAINT ck_al__unlock_fields CHECK (
    unlocked_at IS NULL
    OR (unlocked_by IS NOT NULL AND length(btrim(coalesce(unlock_reason, ''))) >= 10))
);

CREATE INDEX IF NOT EXISTS idx_al__range_live ON public.attendance_locks
  USING gist (daterange(from_date, to_date, '[]')) WHERE unlocked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_al__employee_live ON public.attendance_locks
  (employee_id) WHERE unlocked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_al__company    ON public.attendance_locks (company_id);
CREATE INDEX IF NOT EXISTS idx_al__pay_period ON public.attendance_locks (pay_period_id);
CREATE INDEX IF NOT EXISTS idx_al__location   ON public.attendance_locks (location_id);
CREATE INDEX IF NOT EXISTS idx_al__department ON public.attendance_locks (department_id);

CREATE TRIGGER trg_attendance_locks__stamp BEFORE INSERT ON public.attendance_locks
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_attendance_locks__touch BEFORE UPDATE ON public.attendance_locks
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.attendance_locks ENABLE ROW LEVEL SECURITY;

-- P7: every authenticated user may read (employees must be able to see WHY
-- they cannot regularize a locked date).
DROP POLICY IF EXISTS attendance_locks__read ON public.attendance_locks;
CREATE POLICY attendance_locks__read ON public.attendance_locks
  FOR SELECT TO authenticated
  USING (app.is_active_user());

-- P8: admins create soft locks; P9: only super-admin creates hard locks.
DROP POLICY IF EXISTS attendance_locks__admin_insert ON public.attendance_locks;
CREATE POLICY attendance_locks__admin_insert ON public.attendance_locks
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND (lock_kind = 'soft' OR app.is_super_admin()));

-- P9: all unlocks / edits are super-admin.
DROP POLICY IF EXISTS attendance_locks__super_update ON public.attendance_locks;
CREATE POLICY attendance_locks__super_update ON public.attendance_locks
  FOR UPDATE TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 2. attendance_days — the computed per-employee-per-IST-date record (§3.5)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_days (
  id                        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id               uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  ist_date                  date NOT NULL,   -- the business date (= punches.effective_date)
  status                    public.attendance_status NOT NULL DEFAULT 'pending',
  status_source             public.attendance_day_source NOT NULL DEFAULT 'computed',
  shift_id                  uuid REFERENCES public.shifts(id) ON DELETE RESTRICT,
  shift_start_at            timestamptz,
  shift_end_at              timestamptz,   -- next calendar day for night shifts
  shift_duration_minutes    integer,       -- excluding the shift's unpaid break
  attendance_policy_id      uuid REFERENCES public.attendance_policies(id) ON DELETE RESTRICT,
  weekly_off_rule_id        uuid REFERENCES public.weekly_off_rules(id) ON DELETE RESTRICT,
  holiday_id                uuid REFERENCES public.holidays(id) ON DELETE SET NULL,
  roster_slot_id            uuid REFERENCES public.roster_slots(id) ON DELETE SET NULL,
  first_in_at               timestamptz,   -- MIN(punched_at) over non-voided punches
  last_out_at               timestamptz,   -- MAX(punched_at); NULL if only one punch
  first_in_punch_id         uuid,          -- traceability; no FK across partitions
  last_out_punch_id         uuid,
  punch_count               integer NOT NULL DEFAULT 0,
  gross_span_minutes        integer NOT NULL DEFAULT 0,
  break_minutes             integer NOT NULL DEFAULT 0,
  break_count               integer NOT NULL DEFAULT 0,
  total_worked_minutes      integer NOT NULL DEFAULT 0,
  payable_worked_minutes    integer NOT NULL DEFAULT 0,
  is_late                   boolean NOT NULL DEFAULT false,
  late_minutes              integer NOT NULL DEFAULT 0,   -- measured from SHIFT START, not end of grace
  is_early_exit             boolean NOT NULL DEFAULT false,
  early_exit_minutes        integer NOT NULL DEFAULT 0,
  overtime_minutes          integer NOT NULL DEFAULT 0,
  approved_overtime_minutes integer NOT NULL DEFAULT 0,   -- computed automatically, paid only when approved
  extra_work_minutes        integer NOT NULL DEFAULT 0,   -- worked on weekly_off/holiday
  day_fraction_paid         numeric(4,3) NOT NULL DEFAULT 0.000,  -- THE definition of "Paid Days"
  leave_type_id             uuid,   -- FK via deferred sweep (leave_types in 019)
  leave_request_id          uuid,   -- FK via deferred sweep (leave_requests in 019)
  leave_day_fraction        numeric(4,3) NOT NULL DEFAULT 0.000,
  comp_off_ledger_id        uuid,   -- FK via deferred sweep (comp_off_ledger in 019)
  late_deduction_leave_days numeric(4,3) NOT NULL DEFAULT 0.000,
  is_holiday                boolean NOT NULL DEFAULT false,
  is_weekly_off             boolean NOT NULL DEFAULT false,
  -- THE single definition of "working day" — every denominator in §9 uses it.
  is_working_day            boolean NOT NULL GENERATED ALWAYS AS
    (NOT is_holiday AND NOT is_weekly_off
     AND status NOT IN ('not_yet_joined', 'post_exit')) STORED,
  location_id               uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  department_id             uuid REFERENCES public.departments(id) ON DELETE SET NULL,   -- snapshotted
  designation_id            uuid REFERENCES public.designations(id) ON DELETE SET NULL,  -- snapshotted
  manager_id                uuid REFERENCES public.employees(id) ON DELETE SET NULL,     -- snapshotted
  manual_override_status    boolean NOT NULL DEFAULT false,
  manual_override_times     boolean NOT NULL DEFAULT false,
  manual_override_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  manual_override_at        timestamptz,
  manual_override_reason    text,
  regularization_id         uuid,   -- FK added below (circular with regularizations)
  anomaly_flags             text[] NOT NULL DEFAULT '{}',
  computed_at               timestamptz NOT NULL DEFAULT now(),
  computed_version          integer NOT NULL DEFAULT 1,
  computed_by               text NOT NULL DEFAULT 'engine',
  is_locked                 boolean NOT NULL DEFAULT false,
  lock_id                   uuid REFERENCES public.attendance_locks(id) ON DELETE SET NULL,
  payroll_run_id            uuid,   -- FK via deferred sweep (payroll_runs in 022)
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ad__fraction CHECK (day_fraction_paid IN (0, 0.5, 1)),
  CONSTRAINT ck_ad__override_reason CHECK (
    NOT (manual_override_status OR manual_override_times)
    OR length(btrim(coalesce(manual_override_reason, ''))) >= 10),
  CONSTRAINT ck_ad__minutes_nonneg CHECK (
        punch_count               >= 0
    AND gross_span_minutes        >= 0
    AND break_minutes             >= 0
    AND break_count               >= 0
    AND total_worked_minutes      >= 0
    AND payable_worked_minutes    >= 0
    AND late_minutes              >= 0
    AND early_exit_minutes        >= 0
    AND overtime_minutes          >= 0
    AND approved_overtime_minutes >= 0
    AND extra_work_minutes        >= 0
    AND (shift_duration_minutes IS NULL OR shift_duration_minutes >= 0)),
  CONSTRAINT ck_ad__worked_le_span CHECK (total_worked_minutes <= gross_span_minutes),
  CONSTRAINT ck_ad__computed_by CHECK (computed_by IN ('engine', 'batch', 'admin_override', 'import')),
  CONSTRAINT ck_ad__sane_date CHECK (ist_date < DATE '2100-01-01')
);

-- Indexes (§3.5 verbatim)
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_days__employee_ist_date ON public.attendance_days (employee_id, ist_date);
CREATE INDEX IF NOT EXISTS idx_attendance_days__date_status   ON public.attendance_days (ist_date, status);
CREATE INDEX IF NOT EXISTS idx_attendance_days__emp_date_desc ON public.attendance_days (employee_id, ist_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_days__manager_date  ON public.attendance_days (manager_id, ist_date);
CREATE INDEX IF NOT EXISTS idx_attendance_days__dept_date     ON public.attendance_days (department_id, ist_date);
CREATE INDEX IF NOT EXISTS idx_attendance_days__late          ON public.attendance_days (ist_date) WHERE is_late;
CREATE INDEX IF NOT EXISTS idx_attendance_days__anomaly       ON public.attendance_days USING gin (anomaly_flags) WHERE anomaly_flags <> '{}';
CREATE INDEX IF NOT EXISTS idx_attendance_days__unlocked      ON public.attendance_days (ist_date) WHERE NOT is_locked;
-- FK hygiene (§12.2: every FK column indexed)
CREATE INDEX IF NOT EXISTS idx_attendance_days__shift         ON public.attendance_days (shift_id);
CREATE INDEX IF NOT EXISTS idx_attendance_days__policy        ON public.attendance_days (attendance_policy_id);
CREATE INDEX IF NOT EXISTS idx_attendance_days__holiday       ON public.attendance_days (holiday_id) WHERE holiday_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_days__roster_slot   ON public.attendance_days (roster_slot_id) WHERE roster_slot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_days__leave_request ON public.attendance_days (leave_request_id) WHERE leave_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_days__payroll_run   ON public.attendance_days (payroll_run_id) WHERE payroll_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_days__lock          ON public.attendance_days (lock_id) WHERE lock_id IS NOT NULL;

CREATE TRIGGER trg_attendance_days__stamp BEFORE INSERT ON public.attendance_days
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_attendance_days__touch BEFORE UPDATE ON public.attendance_days
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- DELETE: nobody (§3.5 RLS). The engine upserts; rows are never removed.
CREATE TRIGGER trg_attendance_days__no_delete
  BEFORE DELETE ON public.attendance_days
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.attendance_days ENABLE ROW LEVEL SECURITY;

-- P5 read: self / manager-scope / admin. No INSERT/UPDATE for authenticated —
-- only compute_attendance_day() (SECURITY DEFINER, 018) and the admin-override
-- RPC write here.
DROP POLICY IF EXISTS attendance_days__self_read ON public.attendance_days;
CREATE POLICY attendance_days__self_read ON public.attendance_days
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS attendance_days__manager_read ON public.attendance_days;
CREATE POLICY attendance_days__manager_read ON public.attendance_days
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS attendance_days__admin_read ON public.attendance_days;
CREATE POLICY attendance_days__admin_read ON public.attendance_days
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 3. attendance_regularizations — employee-raised corrections (§3.5)
-- Approval creates NEW punches (source='system_regularization') then
-- recomputes; the raw log is never rewritten.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_regularizations (
  id                     uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id            uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  ist_date               date NOT NULL,
  attendance_day_id      uuid REFERENCES public.attendance_days(id) ON DELETE SET NULL,
  regularization_kind    text NOT NULL,
  requested_first_in_at  timestamptz,
  requested_last_out_at  timestamptz,
  requested_status       public.attendance_status,   -- for on_duty / work_from_home
  employee_reason        text NOT NULL,
  supporting_document_id uuid,   -- FK via deferred sweep (documents in 025)
  status                 public.regularization_status NOT NULL DEFAULT 'pending',
  approval_request_id    uuid,   -- FK via deferred sweep (approval_requests in 029)
  decided_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at             timestamptz,
  decision_comment       text,
  applied_at             timestamptz,
  created_punch_ids      uuid[],
  month_quota_counter    integer,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ar__kind CHECK (regularization_kind IN
    ('missed_in','missed_out','missed_both','wrong_time','marked_absent',
     'on_duty','work_from_home','shift_mismatch','break_correction')),
  CONSTRAINT ck_ar__requested_status CHECK (
    requested_status IS NULL OR requested_status IN ('on_duty', 'work_from_home')),
  CONSTRAINT ck_ar__employee_reason CHECK (length(btrim(employee_reason)) >= 15),
  CONSTRAINT ck_ar__date_not_future CHECK (ist_date <= (util.ist_date(now()))),
  CONSTRAINT ck_ar__rejection_comment CHECK (
    status <> 'rejected' OR length(btrim(coalesce(decision_comment, ''))) > 0),
  CONSTRAINT ck_ar__times_order CHECK (
    requested_first_in_at IS NULL OR requested_last_out_at IS NULL
    OR requested_last_out_at > requested_first_in_at)
);

CREATE INDEX IF NOT EXISTS idx_ar__employee_date  ON public.attendance_regularizations (employee_id, ist_date);
CREATE INDEX IF NOT EXISTS idx_ar__status_created ON public.attendance_regularizations (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ar__one_open_per_day
  ON public.attendance_regularizations (employee_id, ist_date)
  WHERE status IN ('draft', 'pending');
CREATE INDEX IF NOT EXISTS idx_ar__attendance_day ON public.attendance_regularizations (attendance_day_id) WHERE attendance_day_id IS NOT NULL;

-- ck_ar__within_window (§3.5): trigger-enforced against
-- attendance_policies.regularization_window_days (default 15),
-- employees.attendance_regularize_from, and the monthly quota
-- (max_regularizations_per_month, default 3). Also stamps month_quota_counter.
CREATE OR REPLACE FUNCTION public.attendance_regularizations_window_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_window   integer := 15;
  v_quota    integer := 3;
  v_from     date;
  v_used     integer;
  v_pol_id   uuid;
BEGIN
  v_pol_id := public.resolve_policy('attendance_policy', NEW.employee_id, NEW.ist_date);
  IF v_pol_id IS NOT NULL THEN
    SELECT ap.regularization_window_days, ap.max_regularizations_per_month
      INTO v_window, v_quota
    FROM public.attendance_policies ap WHERE ap.id = v_pol_id;
  END IF;

  IF NEW.ist_date < util.ist_today() - v_window THEN
    RAISE EXCEPTION 'regularization_window_exceeded: % is older than the % day window',
      NEW.ist_date, v_window USING errcode = '23514';
  END IF;

  SELECT e.attendance_regularize_from INTO v_from
  FROM public.employees e WHERE e.id = NEW.employee_id;
  IF v_from IS NOT NULL AND NEW.ist_date < v_from THEN
    RAISE EXCEPTION 'regularization_before_allowed_from: % precedes %',
      NEW.ist_date, v_from USING errcode = '23514';
  END IF;

  SELECT count(*) INTO v_used
  FROM public.attendance_regularizations ar
  WHERE ar.employee_id = NEW.employee_id
    AND ar.id <> NEW.id
    AND date_trunc('month', ar.ist_date) = date_trunc('month', NEW.ist_date)
    AND ar.status NOT IN ('rejected', 'cancelled');
  IF v_used >= v_quota THEN
    RAISE EXCEPTION 'regularization_quota_exceeded: % of % used for the month of %',
      v_used, v_quota, to_char(NEW.ist_date, 'FMMonth YYYY') USING errcode = '23514';
  END IF;
  NEW.month_quota_counter := v_used + 1;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_attendance_regularizations__window
  BEFORE INSERT ON public.attendance_regularizations
  FOR EACH ROW EXECUTE FUNCTION public.attendance_regularizations_window_guard();

CREATE TRIGGER trg_attendance_regularizations__stamp BEFORE INSERT ON public.attendance_regularizations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_attendance_regularizations__touch BEFORE UPDATE ON public.attendance_regularizations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.attendance_regularizations ENABLE ROW LEVEL SECURITY;

-- P1: self insert / read / cancel-while-pending.
DROP POLICY IF EXISTS attendance_regularizations__self_read ON public.attendance_regularizations;
CREATE POLICY attendance_regularizations__self_read ON public.attendance_regularizations
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS attendance_regularizations__self_insert ON public.attendance_regularizations;
CREATE POLICY attendance_regularizations__self_insert ON public.attendance_regularizations
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = app.current_employee_id()
    AND status IN ('draft', 'pending'));

DROP POLICY IF EXISTS attendance_regularizations__self_cancel ON public.attendance_regularizations;
CREATE POLICY attendance_regularizations__self_cancel ON public.attendance_regularizations
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft', 'pending'))
  WITH CHECK (
    employee_id = app.current_employee_id()
    AND status IN ('draft', 'pending', 'cancelled'));

-- P5: manager read (decisions go through the approval RPC, not direct UPDATE).
DROP POLICY IF EXISTS attendance_regularizations__manager_read ON public.attendance_regularizations;
CREATE POLICY attendance_regularizations__manager_read ON public.attendance_regularizations
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

-- P8: admin all (scope-covered).
DROP POLICY IF EXISTS attendance_regularizations__admin_all ON public.attendance_regularizations;
CREATE POLICY attendance_regularizations__admin_all ON public.attendance_regularizations
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- Close the circular FK: attendance_days.regularization_id → regularizations.
DO $$ BEGIN
  ALTER TABLE public.attendance_days
    ADD CONSTRAINT fk_attendance_days__regularization
    FOREIGN KEY (regularization_id) REFERENCES public.attendance_regularizations(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_attendance_days__regularization
  ON public.attendance_days (regularization_id) WHERE regularization_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. attendance_recompute_runs — one row per batch/backfill (§3.5)
-- (created before the queue so queue.run_id can reference it)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_recompute_runs (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_kind            text NOT NULL,
  requested_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason              text,
  from_date           date,
  to_date             date,
  employee_filter     jsonb,
  engine_version      integer,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  days_targeted       integer NOT NULL DEFAULT 0,
  days_written        integer NOT NULL DEFAULT 0,
  days_skipped_locked integer NOT NULL DEFAULT 0,
  days_unchanged      integer NOT NULL DEFAULT 0,
  errors              integer NOT NULL DEFAULT 0,
  error_detail        jsonb,
  status              public.job_run_status NOT NULL DEFAULT 'running',
  duration_ms         integer,
  CONSTRAINT ck_arr__run_kind CHECK (run_kind IN
    ('queue_drain', 'nightly', 'range_backfill', 'version_upgrade', 'single'))
);

CREATE INDEX IF NOT EXISTS idx_arr__started ON public.attendance_recompute_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_arr__status  ON public.attendance_recompute_runs (status) WHERE finished_at IS NULL;

ALTER TABLE public.attendance_recompute_runs ENABLE ROW LEVEL SECURITY;

-- P8 read; service-role write (no client-write policy at all).
DROP POLICY IF EXISTS attendance_recompute_runs__admin_read ON public.attendance_recompute_runs;
CREATE POLICY attendance_recompute_runs__admin_read ON public.attendance_recompute_runs
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- -----------------------------------------------------------------------------
-- 5. attendance_recompute_queue — append-only, drained (§3.5)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_recompute_queue (
  id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id  uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  ist_date     date NOT NULL,
  reason       text NOT NULL,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  enqueued_by  uuid,
  source_table text,
  source_id    uuid,
  priority     smallint NOT NULL DEFAULT 5,
  claimed_at   timestamptz,
  claimed_by   text,
  processed_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  run_id       uuid REFERENCES public.attendance_recompute_runs(id) ON DELETE SET NULL,
  CONSTRAINT ck_arq__reason CHECK (reason IN
    ('punch_inserted', 'punch_voided', 'leave_approved', 'leave_cancelled',
     'holiday_changed', 'roster_changed', 'shift_changed', 'policy_changed',
     'regularization_applied', 'manual', 'backfill'))
);

-- Natural dedupe: 12 scans in a day enqueue exactly one pending job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_arq__pending
  ON public.attendance_recompute_queue (employee_id, ist_date)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_arq__claimable
  ON public.attendance_recompute_queue (priority, enqueued_at)
  WHERE processed_at IS NULL AND claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_arq__run      ON public.attendance_recompute_queue (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arq__employee ON public.attendance_recompute_queue (employee_id);

ALTER TABLE public.attendance_recompute_queue ENABLE ROW LEVEL SECURITY;

-- P8 read; writes only via the SECURITY DEFINER enqueue triggers / drainer.
DROP POLICY IF EXISTS attendance_recompute_queue__admin_read ON public.attendance_recompute_queue;
CREATE POLICY attendance_recompute_queue__admin_read ON public.attendance_recompute_queue
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON public.attendance_days, public.attendance_regularizations, '
        || 'public.attendance_locks, public.attendance_recompute_queue, '
        || 'public.attendance_recompute_runs FROM %I', v_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.attendance_days, public.attendance_regularizations,
      public.attendance_locks, public.attendance_recompute_queue,
      public.attendance_recompute_runs TO authenticated;
    -- Row access is policy-gated: self insert/cancel on regularizations,
    -- admin/super-admin on locks. attendance_days has NO client write policy.
    GRANT INSERT, UPDATE ON public.attendance_regularizations TO authenticated;
    GRANT INSERT, UPDATE ON public.attendance_locks TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.attendance_days TO service_role;  -- engine path; DELETE for nobody
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_regularizations TO service_role;
    GRANT SELECT, INSERT, UPDATE ON public.attendance_locks TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_recompute_queue TO service_role;
    GRANT SELECT, INSERT, UPDATE ON public.attendance_recompute_runs TO service_role;
  END IF;
END $$;

COMMIT;
