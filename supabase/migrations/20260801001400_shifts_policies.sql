-- =============================================================================
-- Migration 014 — shifts, weekly offs, holidays, attendance policies,
--                 policy assignments, pay periods + resolver functions
-- Source: docs/plan/04-data-model.md §3.6 (all columns), §8.7
--         (resolve_shift_for_date), §8.8 (is_weekly_off), §1.7 (lookup shape),
--         §1.8 (exclusion constraints); spec-migrations §2 row 014.
--
-- Every attendance threshold lives in attendance_policies — no threshold is
-- hard-coded in TypeScript. shifts.display_label is maintained by trigger
-- (to_char is STABLE, so a generated column is not legal for it).
-- resolve_shift_for_date/is_weekly_off are plpgsql so their references to
-- roster_slots (migration 015) bind at first execution, not at creation.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. shifts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shifts (
  id                          uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                        text NOT NULL,
  name                        text NOT NULL,
  description                 text,
  sort_order                  integer NOT NULL DEFAULT 100,
  is_active                   boolean NOT NULL DEFAULT true,
  start_time                  time NOT NULL,
  end_time                    time NOT NULL,
  crosses_midnight            boolean NOT NULL GENERATED ALWAYS AS (end_time <= start_time) STORED,
  duration_minutes            integer NOT NULL,
  unpaid_break_minutes        integer NOT NULL DEFAULT 60,
  paid_break_minutes          integer NOT NULL DEFAULT 0,
  grace_in_minutes            integer NOT NULL DEFAULT 10,
  grace_out_minutes           integer NOT NULL DEFAULT 10,
  half_day_minutes            integer NOT NULL DEFAULT 240,
  absent_below_minutes        integer NOT NULL DEFAULT 120,
  full_day_minutes            integer NOT NULL DEFAULT 480,
  min_minutes_for_present     integer NOT NULL DEFAULT 240,
  ot_threshold_minutes        integer NOT NULL DEFAULT 30,
  night_shift                 boolean NOT NULL DEFAULT false,
  night_allowance_component_id uuid,  -- FK added by deferred sweep (salary_components in 020)
  day_cutover_time            time NOT NULL DEFAULT '05:00',
  colour_hex                  text,
  display_label               text NOT NULL DEFAULT '',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                  timestamptz,
  deleted_by                  uuid REFERENCES public.profiles(id),
  deletion_reason             text,
  CONSTRAINT ck_shifts__thresholds CHECK (absent_below_minutes <= half_day_minutes AND half_day_minutes <= full_day_minutes),
  CONSTRAINT ck_shifts__colour     CHECK (colour_hex IS NULL OR colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT ck_shifts__durations  CHECK (duration_minutes > 0 AND unpaid_break_minutes >= 0 AND paid_break_minutes >= 0),
  CONSTRAINT ck_shifts__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts__company_code ON public.shifts (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shifts__company ON public.shifts (company_id);
CREATE INDEX IF NOT EXISTS idx_shifts__night_component ON public.shifts (night_allowance_component_id);

-- display_label + duration validation. to_char(time,…) is STABLE, so the
-- label is trigger-maintained, one implementation (§3.6: "one place produces
-- `G — 09:30 AM to 06:30 PM`").
CREATE OR REPLACE FUNCTION public.shifts_before_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_span integer;
BEGIN
  v_span := (
    (EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60)::integer + 1440
  ) % 1440;
  IF v_span = 0 THEN v_span := 1440; END IF;
  IF NEW.duration_minutes <> v_span - NEW.unpaid_break_minutes THEN
    RAISE EXCEPTION
      'shift %: duration_minutes (%) must equal wall span (%) minus unpaid break (%)',
      NEW.code, NEW.duration_minutes, v_span, NEW.unpaid_break_minutes
      USING errcode = '23514';
  END IF;
  NEW.display_label := NEW.code || ' — '
    || to_char(NEW.start_time, 'HH12:MI AM') || ' to '
    || to_char(NEW.end_time, 'HH12:MI AM');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_shifts__before_write
  BEFORE INSERT OR UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.shifts_before_write();

CREATE TRIGGER trg_shifts__stamp BEFORE INSERT ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_shifts__touch BEFORE UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shifts__ref_read ON public.shifts;
CREATE POLICY shifts__ref_read ON public.shifts
  FOR SELECT TO authenticated
  USING ((is_active AND deleted_at IS NULL) OR app.is_admin());

DROP POLICY IF EXISTS shifts__admin_write ON public.shifts;
CREATE POLICY shifts__admin_write ON public.shifts
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 2. shift_assignments (effective-dated; overlap-impossible)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shift_assignments (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  shift_id        uuid NOT NULL REFERENCES public.shifts(id) ON DELETE RESTRICT,
  effective_from  date NOT NULL,
  effective_to    date,
  assigned_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES public.profiles(id),
  deletion_reason text,
  CONSTRAINT ck_shift_assignments__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_shift_assignments__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10)),
  CONSTRAINT ex_shift_assignments__no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  ) WHERE (deleted_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_shift_assignments__employee ON public.shift_assignments (employee_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_shift_assignments__shift    ON public.shift_assignments (shift_id);

CREATE TRIGGER trg_shift_assignments__stamp BEFORE INSERT ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_shift_assignments__touch BEFORE UPDATE ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shift_assignments__scope_read ON public.shift_assignments;
CREATE POLICY shift_assignments__scope_read ON public.shift_assignments
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id) AND deleted_at IS NULL);

DROP POLICY IF EXISTS shift_assignments__admin_write ON public.shift_assignments;
CREATE POLICY shift_assignments__admin_write ON public.shift_assignments
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 3. weekly_off_rules
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.weekly_off_rules (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  description          text,
  sort_order           integer NOT NULL DEFAULT 100,
  is_active            boolean NOT NULL DEFAULT true,
  rule_kind            text NOT NULL DEFAULT 'fixed_weekdays',
  first_off_dow        smallint,
  first_off_weeks      smallint[] DEFAULT '{1,2,3,4,5}',
  second_off_dow       smallint,
  second_off_weeks     smallint[],
  third_off_dow        smallint,
  third_off_weeks      smallint[],
  offs_per_week        smallint,
  week_of_month_basis  text NOT NULL DEFAULT 'calendar_dom',
  half_day_dow         smallint,
  is_rotational        boolean NOT NULL DEFAULT false,
  rotation_pattern     smallint[],
  rotation_anchor_date date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_wor__rule_kind CHECK (rule_kind IN ('fixed_weekdays','rotational','roster_driven','days_per_week')),
  CONSTRAINT ck_wor__basis     CHECK (week_of_month_basis IN ('calendar_dom','iso_week_parity')),
  CONSTRAINT ck_wor__dows      CHECK (
        (first_off_dow  IS NULL OR first_off_dow  BETWEEN 0 AND 6)
    AND (second_off_dow IS NULL OR second_off_dow BETWEEN 0 AND 6)
    AND (third_off_dow  IS NULL OR third_off_dow  BETWEEN 0 AND 6)
    AND (half_day_dow   IS NULL OR half_day_dow   BETWEEN 0 AND 6))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_off_rules__company_code ON public.weekly_off_rules (company_id, code);

CREATE TRIGGER trg_weekly_off_rules__stamp BEFORE INSERT ON public.weekly_off_rules
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_weekly_off_rules__touch BEFORE UPDATE ON public.weekly_off_rules
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.weekly_off_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weekly_off_rules__ref_read ON public.weekly_off_rules;
CREATE POLICY weekly_off_rules__ref_read ON public.weekly_off_rules
  FOR SELECT TO authenticated USING (is_active OR app.is_admin());

DROP POLICY IF EXISTS weekly_off_rules__admin_write ON public.weekly_off_rules;
CREATE POLICY weekly_off_rules__admin_write ON public.weekly_off_rules
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 4. holiday_calendars + holidays
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.holiday_calendars (
  id                     uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                   text NOT NULL,
  name                   text NOT NULL,
  description            text,
  sort_order             integer NOT NULL DEFAULT 100,
  is_active              boolean NOT NULL DEFAULT true,
  year                   integer NOT NULL,
  state                  text NOT NULL DEFAULT 'Karnataka',
  is_default             boolean NOT NULL DEFAULT false,
  total_holiday_quota    integer,
  optional_holiday_quota integer NOT NULL DEFAULT 2,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at             timestamptz,
  deleted_by             uuid REFERENCES public.profiles(id),
  deletion_reason        text,
  CONSTRAINT ck_hc__year CHECK (year BETWEEN 2020 AND 2099),
  CONSTRAINT ck_hc__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_calendars__company_code ON public.holiday_calendars (company_id, code) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_holiday_calendars__stamp BEFORE INSERT ON public.holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_holiday_calendars__touch BEFORE UPDATE ON public.holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.holiday_calendars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS holiday_calendars__ref_read ON public.holiday_calendars;
CREATE POLICY holiday_calendars__ref_read ON public.holiday_calendars
  FOR SELECT TO authenticated
  USING ((is_active AND deleted_at IS NULL) OR app.is_admin());

DROP POLICY IF EXISTS holiday_calendars__admin_write ON public.holiday_calendars;
CREATE POLICY holiday_calendars__admin_write ON public.holiday_calendars
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE TABLE IF NOT EXISTS public.holidays (
  id                         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  holiday_calendar_id        uuid NOT NULL REFERENCES public.holiday_calendars(id) ON DELETE CASCADE,
  holiday_date               date NOT NULL,
  name                       text NOT NULL,
  local_name                 text,
  holiday_type               public.holiday_type NOT NULL DEFAULT 'national',
  is_paid                    boolean NOT NULL DEFAULT true,
  is_optional                boolean NOT NULL DEFAULT false,
  applies_to_department_ids  uuid[],
  applies_to_location_ids    uuid[],
  working_if_event_booked    boolean NOT NULL DEFAULT true,
  compensatory_off_if_worked boolean NOT NULL DEFAULT true,
  pay_multiplier_if_worked   numeric(9,4) NOT NULL DEFAULT 2.0000,
  description                text,
  is_active                  boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_holidays__sane_date CHECK (holiday_date < DATE '2100-01-01')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_holidays__calendar_date_name ON public.holidays (holiday_calendar_id, holiday_date, name);
CREATE INDEX IF NOT EXISTS idx_holidays__date ON public.holidays (holiday_date);

CREATE TRIGGER trg_holidays__stamp BEFORE INSERT ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_holidays__touch BEFORE UPDATE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS holidays__ref_read ON public.holidays;
CREATE POLICY holidays__ref_read ON public.holidays
  FOR SELECT TO authenticated USING (is_active OR app.is_admin());

DROP POLICY IF EXISTS holidays__admin_write ON public.holidays;
CREATE POLICY holidays__admin_write ON public.holidays
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 5. attendance_policies — every engine threshold, one row (§3.6)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_policies (
  id                              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                      uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                            text NOT NULL,
  name                            text NOT NULL,
  description                     text,
  is_active                       boolean NOT NULL DEFAULT true,
  grace_in_minutes                integer NOT NULL DEFAULT 10,
  grace_out_minutes               integer NOT NULL DEFAULT 10,
  late_after_grace_counts_full    boolean NOT NULL DEFAULT true,
  max_late_days_before_deduction  integer NOT NULL DEFAULT 3,
  late_deduction_leave_days       numeric(4,3) NOT NULL DEFAULT 0.500,
  late_deduction_leave_type_id    uuid,   -- FK added by deferred sweep (leave_types in 019)
  late_deduction_reset_period     text NOT NULL DEFAULT 'calendar_month',
  early_exit_deduction_enabled    boolean NOT NULL DEFAULT false,
  auto_deduct_break               boolean NOT NULL DEFAULT true,
  min_break_minutes_to_count      integer NOT NULL DEFAULT 15,
  max_break_minutes_paid          integer NOT NULL DEFAULT 0,
  overtime_enabled                boolean NOT NULL DEFAULT true,
  overtime_requires_approval      boolean NOT NULL DEFAULT true,
  overtime_multiplier             numeric(9,4) NOT NULL DEFAULT 2.0000,
  overtime_min_minutes            integer NOT NULL DEFAULT 30,
  overtime_rounding_minutes       integer NOT NULL DEFAULT 15,
  max_overtime_minutes_per_day    integer NOT NULL DEFAULT 240,
  max_overtime_minutes_per_week   integer NOT NULL DEFAULT 600,
  max_payable_minutes_per_day     integer NOT NULL DEFAULT 720,
  extra_work_compensation         text NOT NULL DEFAULT 'comp_off',
  comp_off_min_minutes            integer NOT NULL DEFAULT 240,
  comp_off_full_day_minutes       integer NOT NULL DEFAULT 480,
  comp_off_expiry_days            integer NOT NULL DEFAULT 90,
  half_day_minutes                integer,
  absent_below_minutes            integer,
  single_punch_treatment          text NOT NULL DEFAULT 'half_day_flag_review',
  missing_out_grace_minutes       integer NOT NULL DEFAULT 0,
  regularization_window_days      integer NOT NULL DEFAULT 15,
  max_regularizations_per_month   integer NOT NULL DEFAULT 3,
  regularization_requires_manager boolean NOT NULL DEFAULT true,
  absent_marking_delay_hours      integer NOT NULL DEFAULT 6,
  allow_web_punch                 boolean NOT NULL DEFAULT false,
  allow_mobile_punch              boolean NOT NULL DEFAULT false,
  punch_debounce_seconds          integer NOT NULL DEFAULT 120,
  min_confidence_for_auto_accept  numeric(8,5) NOT NULL DEFAULT 0.62000,
  min_margin_for_auto_accept      numeric(8,5) NOT NULL DEFAULT 0.06000,
  require_liveness                boolean NOT NULL DEFAULT true,
  week_start_dow                  smallint NOT NULL DEFAULT 1,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                      timestamptz,
  deleted_by                      uuid REFERENCES public.profiles(id),
  deletion_reason                 text,
  CONSTRAINT ck_ap__reset_period    CHECK (late_deduction_reset_period IN ('calendar_month','pay_period')),
  CONSTRAINT ck_ap__extra_comp      CHECK (extra_work_compensation IN ('comp_off','paid','both','none')),
  CONSTRAINT ck_ap__single_punch    CHECK (single_punch_treatment IN ('absent','half_day','present_flag_review','half_day_flag_review')),
  CONSTRAINT ck_ap__week_start      CHECK (week_start_dow BETWEEN 0 AND 6),
  CONSTRAINT ck_ap__confidence      CHECK (min_confidence_for_auto_accept BETWEEN 0 AND 1 AND min_margin_for_auto_accept BETWEEN 0 AND 1),
  CONSTRAINT ck_ap__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_policies__company_code ON public.attendance_policies (company_id, code) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_attendance_policies__stamp BEFORE INSERT ON public.attendance_policies
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_attendance_policies__touch BEFORE UPDATE ON public.attendance_policies
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.attendance_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_policies__ref_read ON public.attendance_policies;
CREATE POLICY attendance_policies__ref_read ON public.attendance_policies
  FOR SELECT TO authenticated
  USING ((is_active AND deleted_at IS NULL) OR app.is_admin());

DROP POLICY IF EXISTS attendance_policies__admin_write ON public.attendance_policies;
CREATE POLICY attendance_policies__admin_write ON public.attendance_policies
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 6. policy_assignments — one effective-dated binding table for every kind
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.policy_assignments (
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  assignment_kind  text NOT NULL,
  policy_id        uuid NOT NULL,   -- polymorphic per kind; integrity by trigger in the engine
  scope            text NOT NULL,
  company_id       uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  location_id      uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  department_id    uuid REFERENCES public.departments(id) ON DELETE CASCADE,
  section_id       uuid REFERENCES public.sections(id) ON DELETE CASCADE,
  grade_id         uuid REFERENCES public.grades(id) ON DELETE CASCADE,
  designation_id   uuid REFERENCES public.designations(id) ON DELETE CASCADE,
  employment_type  public.employment_type,
  employee_id      uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_from   date NOT NULL,
  effective_to     date,
  priority         smallint NOT NULL DEFAULT 100,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES public.profiles(id),
  deletion_reason  text,
  CONSTRAINT ck_pa__kind CHECK (assignment_kind IN
    ('attendance_policy','weekly_off_rule','holiday_calendar','leave_policy','pay_period','shift')),
  CONSTRAINT ck_pa__scope CHECK (scope IN
    ('company','location','department','section','grade','designation','employment_type','employee')),
  CONSTRAINT ck_pa__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_pa__scope_target CHECK (
    CASE scope
      WHEN 'company'         THEN company_id      IS NOT NULL
      WHEN 'location'        THEN location_id     IS NOT NULL
      WHEN 'department'      THEN department_id   IS NOT NULL
      WHEN 'section'         THEN section_id      IS NOT NULL
      WHEN 'grade'           THEN grade_id        IS NOT NULL
      WHEN 'designation'     THEN designation_id  IS NOT NULL
      WHEN 'employment_type' THEN employment_type IS NOT NULL
      WHEN 'employee'        THEN employee_id     IS NOT NULL
    END),
  CONSTRAINT ck_pa__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE INDEX IF NOT EXISTS idx_pa__kind_scope ON public.policy_assignments (assignment_kind, scope) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pa__employee   ON public.policy_assignments (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pa__policy     ON public.policy_assignments (policy_id);
CREATE INDEX IF NOT EXISTS idx_pa__kind_range ON public.policy_assignments
  USING gist (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]'))
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_policy_assignments__stamp BEFORE INSERT ON public.policy_assignments
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_policy_assignments__touch BEFORE UPDATE ON public.policy_assignments
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.policy_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_assignments__ref_read ON public.policy_assignments;
CREATE POLICY policy_assignments__ref_read ON public.policy_assignments
  FOR SELECT TO authenticated
  USING (deleted_at IS NULL OR app.is_admin());

DROP POLICY IF EXISTS policy_assignments__admin_write ON public.policy_assignments;
CREATE POLICY policy_assignments__admin_write ON public.policy_assignments
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 7. pay_periods
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_periods (
  id                      uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                    text NOT NULL,
  name                    text NOT NULL,
  period_kind             text NOT NULL DEFAULT 'monthly',
  start_date              date NOT NULL,
  end_date                date NOT NULL,
  attendance_cutoff_date  date NOT NULL,
  pay_date                date NOT NULL,
  financial_year          text NOT NULL,
  month_days_basis        text NOT NULL DEFAULT 'actual',
  is_open                 boolean NOT NULL DEFAULT true,
  attendance_locked_at    timestamptz,
  payroll_finalised_at    timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_pp__range CHECK (end_date >= start_date),
  CONSTRAINT ck_pp__kind  CHECK (period_kind IN ('monthly','fortnightly','weekly')),
  CONSTRAINT ck_pp__basis CHECK (month_days_basis IN ('actual','fixed_30','fixed_26')),
  CONSTRAINT ck_pp__sane_dates CHECK (end_date < DATE '2100-01-01')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_periods__company_code ON public.pay_periods (company_id, code);
CREATE INDEX IF NOT EXISTS idx_pay_periods__range ON public.pay_periods
  USING gist (daterange(start_date, end_date, '[]'));

-- No overlapping open periods of the same kind for a company.
CREATE OR REPLACE FUNCTION public.pay_periods_no_overlap()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pay_periods p
    WHERE p.company_id = NEW.company_id
      AND p.period_kind = NEW.period_kind
      AND p.id <> NEW.id
      AND daterange(p.start_date, p.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'pay period % overlaps an existing % period', NEW.code, NEW.period_kind
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pay_periods__no_overlap
  BEFORE INSERT OR UPDATE OF start_date, end_date ON public.pay_periods
  FOR EACH ROW EXECUTE FUNCTION public.pay_periods_no_overlap();

CREATE TRIGGER trg_pay_periods__stamp BEFORE INSERT ON public.pay_periods
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_pay_periods__touch BEFORE UPDATE ON public.pay_periods
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.pay_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pay_periods__ref_read ON public.pay_periods;
CREATE POLICY pay_periods__ref_read ON public.pay_periods
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS pay_periods__admin_write ON public.pay_periods;
CREATE POLICY pay_periods__admin_write ON public.pay_periods
  FOR INSERT TO authenticated WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS pay_periods__admin_update ON public.pay_periods;
CREATE POLICY pay_periods__admin_update ON public.pay_periods
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND (payroll_finalised_at IS NULL OR app.is_super_admin()))
  WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 8. Resolver functions (§8.7, §8.8, §3.6)
-- -----------------------------------------------------------------------------

-- Narrowest live assignment wins; tie-break priority then recency (§3.6).
CREATE OR REPLACE FUNCTION public.resolve_policy(p_kind text, p_employee_id uuid, p_date date)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pa.policy_id
  FROM public.policy_assignments pa
  JOIN public.employees e ON e.id = p_employee_id
  WHERE pa.assignment_kind = p_kind
    AND pa.deleted_at IS NULL
    AND p_date >= pa.effective_from
    AND (pa.effective_to IS NULL OR p_date <= pa.effective_to)
    AND CASE pa.scope
          WHEN 'employee'        THEN pa.employee_id     = e.id
          WHEN 'designation'     THEN pa.designation_id  = e.designation_id
          WHEN 'grade'           THEN pa.grade_id        = e.grade_id
          WHEN 'section'         THEN pa.section_id      = e.section_id
          WHEN 'department'      THEN pa.department_id   = e.department_id
          WHEN 'employment_type' THEN pa.employment_type = e.employment_type
          WHEN 'location'        THEN pa.location_id     = e.location_id
          WHEN 'company'         THEN pa.company_id      = e.company_id
        END
  ORDER BY CASE pa.scope
             WHEN 'employee'        THEN 10
             WHEN 'designation'     THEN 20
             WHEN 'grade'           THEN 30
             WHEN 'section'         THEN 40
             WHEN 'department'      THEN 50
             WHEN 'employment_type' THEN 60
             WHEN 'location'        THEN 70
             WHEN 'company'         THEN 80
           END,
           pa.priority,
           pa.effective_from DESC
  LIMIT 1;
$$;

-- Shift priority: published roster slot → live shift_assignments →
-- employees.shift_id → designations.default_shift_id → company default 'G'.
-- plpgsql so the roster_slots reference (migration 015) binds at execution.
CREATE OR REPLACE FUNCTION public.resolve_shift_for_date(p_employee_id uuid, p_date date)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_shift uuid;
  v_company uuid;
BEGIN
  SELECT rs.shift_id INTO v_shift
  FROM public.roster_slots rs
  WHERE rs.employee_id = p_employee_id
    AND rs.slot_date = p_date
    AND rs.is_published
    AND rs.deleted_at IS NULL
    AND rs.shift_id IS NOT NULL
  LIMIT 1;
  IF v_shift IS NOT NULL THEN RETURN v_shift; END IF;

  SELECT sa.shift_id INTO v_shift
  FROM public.shift_assignments sa
  WHERE sa.employee_id = p_employee_id
    AND sa.deleted_at IS NULL
    AND p_date >= sa.effective_from
    AND (sa.effective_to IS NULL OR p_date <= sa.effective_to)
  ORDER BY sa.effective_from DESC
  LIMIT 1;
  IF v_shift IS NOT NULL THEN RETURN v_shift; END IF;

  SELECT e.shift_id, e.company_id INTO v_shift, v_company
  FROM public.employees e WHERE e.id = p_employee_id;
  IF v_shift IS NOT NULL THEN RETURN v_shift; END IF;

  SELECT d.default_shift_id INTO v_shift
  FROM public.employees e
  JOIN public.designations d ON d.id = e.designation_id
  WHERE e.id = p_employee_id;
  IF v_shift IS NOT NULL THEN RETURN v_shift; END IF;

  SELECT s.id INTO v_shift
  FROM public.shifts s
  WHERE s.company_id = v_company AND s.code = 'G' AND s.deleted_at IS NULL
  LIMIT 1;
  RETURN v_shift;
END;
$$;

-- Single implementation of the weekly-off decision (§8.8).
CREATE OR REPLACE FUNCTION public.is_weekly_off(p_rule_id uuid, p_date date, p_employee_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r        public.weekly_off_rules%ROWTYPE;
  v_dow    smallint := EXTRACT(DOW FROM p_date)::smallint;
  v_wom    smallint := util.week_of_month(p_date);
  v_weeks  integer;
  v_offset smallint;
  v_is_off boolean;
BEGIN
  IF p_rule_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO r FROM public.weekly_off_rules WHERE id = p_rule_id;
  IF r.id IS NULL THEN RETURN false; END IF;

  IF r.rule_kind = 'fixed_weekdays' THEN
    RETURN (r.first_off_dow  IS NOT NULL AND v_dow = r.first_off_dow  AND v_wom = ANY (COALESCE(r.first_off_weeks,  '{1,2,3,4,5}')))
        OR (r.second_off_dow IS NOT NULL AND v_dow = r.second_off_dow AND v_wom = ANY (COALESCE(r.second_off_weeks, '{}')))
        OR (r.third_off_dow  IS NOT NULL AND v_dow = r.third_off_dow  AND v_wom = ANY (COALESCE(r.third_off_weeks,  '{}')));

  ELSIF r.rule_kind = 'rotational' THEN
    IF r.rotation_pattern IS NULL OR r.rotation_anchor_date IS NULL OR r.first_off_dow IS NULL THEN
      RETURN false;
    END IF;
    v_weeks  := FLOOR((p_date - r.rotation_anchor_date) / 7.0)::integer;
    v_offset := r.rotation_pattern[(v_weeks % array_length(r.rotation_pattern, 1)) + 1];
    RETURN v_dow = ((r.first_off_dow + v_offset) % 7);

  ELSIF r.rule_kind = 'roster_driven' THEN
    SELECT rs.is_weekly_off INTO v_is_off
    FROM public.roster_slots rs
    WHERE rs.employee_id = p_employee_id
      AND rs.slot_date = p_date
      AND rs.is_published
      AND rs.deleted_at IS NULL
    LIMIT 1;
    RETURN COALESCE(v_is_off, false);

  ELSE  -- days_per_week: roster is authoritative; weekly compliance job flags shortfalls
    RETURN false;
  END IF;
END;
$$;

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.resolve_policy(text, uuid, date), public.resolve_shift_for_date(uuid, date), public.is_weekly_off(uuid, date, uuid) TO %I', v_role);
      EXECUTE format('GRANT SELECT ON public.shifts, public.shift_assignments, public.weekly_off_rules, public.holiday_calendars, public.holidays, public.attendance_policies, public.policy_assignments, public.pay_periods TO %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT INSERT, UPDATE ON public.shifts, public.shift_assignments, public.weekly_off_rules,
      public.holiday_calendars, public.holidays, public.attendance_policies,
      public.policy_assignments, public.pay_periods TO authenticated;  -- row access is policy-gated (admin only)
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT INSERT, UPDATE, DELETE ON public.shifts, public.shift_assignments, public.weekly_off_rules,
      public.holiday_calendars, public.holidays, public.attendance_policies,
      public.policy_assignments, public.pay_periods TO service_role;
  END IF;
END $$;

COMMIT;
