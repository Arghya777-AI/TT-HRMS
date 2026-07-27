-- =============================================================================
-- Migration 018 — the attendance derivation engine
-- Source: docs/plan/04-data-model.md §7 (contract, algorithm, reference SQL,
--         break rules §7.4, enqueue/drain §7.5, fixtures §7.6), §8.4
--         (sync_late_deduction), §8.5 (sync_comp_off_for_day), §8.9
--         (mark_absent_days); spec-migrations §2 row 018.
--
-- Everything else in the product reports what compute_attendance_day decides:
-- first non-voided punch of the business date = check-in, LAST = check-out,
-- one row per (employee_id, ist_date), deterministic / idempotent / total /
-- lock-respecting / override-preserving / traceable.
--
-- Transcription notes against the §7.3 reference (fixes, each deliberate):
--   * ot_threshold_minutes lives on shifts (014), not attendance_policies —
--     the reference's pol.ot_threshold_minutes is corrected to sh.
--   * Break derivation gains the §7.4 "interior gap" filter (both endpoint
--     punches neither first nor last) — without it fixture 1 computes break
--     557 instead of 46.
--   * Decision-table row 2 (suspended) and the row-8 holiday is_paid fraction,
--     present in §7.2 but missing from the reference SQL, are implemented.
--   * §7.2-step-12 anomaly flags the reference omitted are computed:
--     low_confidence_match, offline_replay, needs_review_punch,
--     duplicate_suspected, ot_without_approval.
--   * designations.ot_eligible is honoured per §7.2 step 10.
--   * Fixture 10: a future date with no approved leave writes NO row.
--   * Leave-domain reads (019) are to_regclass-guarded so 017/018 validate on
--     a partial build; on the full schema the guards are always true.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. upsert_attendance_day — minimal writer for out-of-employment dates (§7.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_attendance_day(
  p_employee_id uuid,
  p_ist_date    date,
  p_status      public.attendance_status,
  p_fraction    numeric,
  p_version     integer)
RETURNS public.attendance_days
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.attendance_days;
BEGIN
  INSERT INTO public.attendance_days AS ad (
    employee_id, ist_date, status, status_source, day_fraction_paid,
    is_holiday, is_weekly_off,
    first_in_at, last_out_at, first_in_punch_id, last_out_punch_id,
    punch_count, gross_span_minutes, break_minutes, break_count,
    total_worked_minutes, payable_worked_minutes,
    is_late, late_minutes, is_early_exit, early_exit_minutes,
    overtime_minutes, extra_work_minutes, leave_day_fraction,
    anomaly_flags, computed_at, computed_version, computed_by)
  VALUES (
    p_employee_id, p_ist_date, p_status, 'computed', p_fraction,
    false, false,
    NULL, NULL, NULL, NULL,
    0, 0, 0, 0,
    0, 0,
    false, 0, false, 0,
    0, 0, 0,
    '{}', now(), p_version,
    COALESCE(current_setting('app.compute_source', true), 'engine'))
  ON CONFLICT (employee_id, ist_date) DO UPDATE SET
    status            = CASE WHEN ad.manual_override_status THEN ad.status ELSE EXCLUDED.status END,
    status_source     = CASE WHEN ad.manual_override_status THEN ad.status_source ELSE EXCLUDED.status_source END,
    day_fraction_paid = CASE WHEN ad.manual_override_status THEN ad.day_fraction_paid ELSE EXCLUDED.day_fraction_paid END,
    first_in_at       = CASE WHEN ad.manual_override_times THEN ad.first_in_at ELSE EXCLUDED.first_in_at END,
    last_out_at       = CASE WHEN ad.manual_override_times THEN ad.last_out_at ELSE EXCLUDED.last_out_at END,
    first_in_punch_id = EXCLUDED.first_in_punch_id,
    last_out_punch_id = EXCLUDED.last_out_punch_id,
    punch_count            = EXCLUDED.punch_count,
    gross_span_minutes     = EXCLUDED.gross_span_minutes,
    break_minutes          = EXCLUDED.break_minutes,
    break_count            = EXCLUDED.break_count,
    total_worked_minutes   = EXCLUDED.total_worked_minutes,
    payable_worked_minutes = EXCLUDED.payable_worked_minutes,
    is_late                = EXCLUDED.is_late,
    late_minutes           = EXCLUDED.late_minutes,
    is_early_exit          = EXCLUDED.is_early_exit,
    early_exit_minutes     = EXCLUDED.early_exit_minutes,
    overtime_minutes       = EXCLUDED.overtime_minutes,
    extra_work_minutes     = EXCLUDED.extra_work_minutes,
    leave_day_fraction     = EXCLUDED.leave_day_fraction,
    is_holiday             = EXCLUDED.is_holiday,
    is_weekly_off          = EXCLUDED.is_weekly_off,
    anomaly_flags          = EXCLUDED.anomaly_flags,
    computed_at            = now(),
    computed_version       = EXCLUDED.computed_version,
    computed_by            = EXCLUDED.computed_by
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. compute_attendance_day — THE engine (§7.1–§7.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_attendance_day(
  p_employee_id uuid,
  p_ist_date    date,
  p_reason      text    DEFAULT NULL,
  p_force       boolean DEFAULT false)
RETURNS public.attendance_days
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  ENGINE_VERSION constant integer := 1;
  e              public.employees;
  pol            public.attendance_policies;
  sh             public.shifts;
  v_shift_id     uuid;
  v_lock         public.attendance_locks;
  v_row          public.attendance_days;
  v_existing     public.attendance_days;
  v_is_holiday   boolean := false;
  v_holiday_id   uuid;
  v_holiday_paid boolean;
  v_is_woff      boolean := false;
  v_slot         public.roster_slots;
  v_first        timestamptz; v_last timestamptz;
  v_first_id     uuid;        v_last_id uuid;
  v_count        integer := 0;
  v_span         integer := 0;
  v_break        integer := 0;
  v_break_ct     integer := 0;
  v_worked       integer := 0;
  v_payable      integer := 0;
  v_late         integer := 0;
  v_early        integer := 0;
  v_ot           integer := 0;
  v_extra        integer := 0;
  v_status       public.attendance_status;
  v_fraction     numeric(4,3) := 0;
  v_flags        text[] := '{}';
  v_shift_start  timestamptz; v_shift_end timestamptz;
  v_shift_mins   integer;
  v_grace_in     integer; v_grace_out integer;
  v_min_present  integer; v_half integer; v_absent_below integer;
  -- leave lookup as scalars (leave tables arrive in 019; guarded)
  v_leave_request_id uuid;
  v_leave_type_id    uuid;
  v_leave_is_paid    boolean;
  v_leave_day_value  numeric;
  -- regularizations
  v_reg_id           uuid;
  v_reg_status       public.attendance_status;
  v_applied_reg_id   uuid;
  v_source           public.attendance_day_source := 'computed';
  -- step-12 anomaly inputs
  v_offline      boolean := false;
  v_needs_review boolean := false;
  v_low_conf     boolean := false;
  v_dup          boolean := false;
  v_desig_ot     boolean := true;
  v_suspended    boolean := false;
BEGIN
  -- 0. Audit reason -----------------------------------------------------------
  -- attendance_days is in audit.reason_required_tables, so every UPDATE this
  -- function performs must carry app.reason. Without this the whole recompute
  -- path (and the admin Recompute Console) fails with `reason_required`.
  -- A caller-supplied reason wins; otherwise the automatic engine path states
  -- what it is. Transaction-local, so the caller's own reason is not clobbered
  -- beyond this statement's transaction.
  IF length(btrim(coalesce(p_reason, ''))) >= 10 THEN
    PERFORM set_config('app.reason', p_reason, true);
  ELSIF length(btrim(coalesce(current_setting('app.reason', true), ''))) < 10 THEN
    PERFORM set_config(
      'app.reason',
      format('attendance engine: computed day %s for employee %s', p_ist_date, p_employee_id),
      true);
  END IF;

  -- 1. employee guard ------------------------------------------------------
  SELECT * INTO e FROM public.employees
   WHERE id = p_employee_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'employee_not_found: %', p_employee_id; END IF;
  IF e.exclude_from_attendance THEN RETURN NULL; END IF;

  -- Approved leave for the date (§7.2 row 3/4). Looked up early because it is
  -- the one thing that materialises a FUTURE date (§7.1 "Total").
  IF to_regclass('public.leave_request_days') IS NOT NULL THEN
    SELECT lr.id, lt.id, lt.is_paid, lrd.day_value
      INTO v_leave_request_id, v_leave_type_id, v_leave_is_paid, v_leave_day_value
    FROM public.leave_request_days lrd
    JOIN public.leave_requests lr ON lr.id = lrd.leave_request_id
    JOIN public.leave_types    lt ON lt.id = lr.leave_type_id
    WHERE lr.employee_id = p_employee_id
      AND lrd.leave_date = p_ist_date
      AND lr.status IN ('approved', 'partially_approved')
      AND lrd.status = 'approved'
      AND lrd.is_counted
    LIMIT 1;
  END IF;

  -- Fixture 10: a plain future date creates no row at all.
  IF p_ist_date > util.ist_today() AND v_leave_request_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF e.date_of_join IS NULL OR p_ist_date < e.date_of_join THEN
    RETURN public.upsert_attendance_day(p_employee_id, p_ist_date,
             'not_yet_joined'::public.attendance_status, 0, ENGINE_VERSION);
  END IF;
  IF e.last_working_day IS NOT NULL AND p_ist_date > e.last_working_day THEN
    RETURN public.upsert_attendance_day(p_employee_id, p_ist_date,
             'post_exit'::public.attendance_status, 0, ENGINE_VERSION);
  END IF;

  -- 2. locks ---------------------------------------------------------------
  SELECT * INTO v_lock FROM public.attendance_locks l
   WHERE l.unlocked_at IS NULL
     AND p_ist_date BETWEEN l.from_date AND l.to_date
     AND (l.scope = 'company'
       OR (l.scope = 'location'   AND l.location_id   = e.location_id)
       OR (l.scope = 'department' AND l.department_id = e.department_id)
       OR (l.scope = 'employee'   AND l.employee_id   = e.id))
   ORDER BY CASE l.lock_kind WHEN 'hard' THEN 0 ELSE 1 END
   LIMIT 1;

  IF v_lock.id IS NOT NULL THEN
    IF v_lock.lock_kind = 'hard'
       AND COALESCE(current_setting('app.allow_locked_recompute', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'attendance_locked: % is hard-locked by % (%)',
        p_ist_date, v_lock.id, v_lock.reason USING errcode = '55006';
    END IF;
    IF v_lock.lock_kind = 'soft'
       AND COALESCE(current_setting('app.allow_locked_recompute', true), 'off') <> 'on' THEN
      SELECT * INTO v_existing FROM public.attendance_days
       WHERE employee_id = p_employee_id AND ist_date = p_ist_date;
      RETURN v_existing;
    END IF;
  END IF;

  -- 3. resolve shift + policy ---------------------------------------------
  v_shift_id := public.resolve_shift_for_date(p_employee_id, p_ist_date);
  SELECT * INTO sh  FROM public.shifts s WHERE s.id = v_shift_id;
  SELECT * INTO pol FROM public.attendance_policies ap
   WHERE ap.id = public.resolve_policy('attendance_policy', p_employee_id, p_ist_date);

  IF pol.id IS NULL THEN
    -- No policy assignment resolves for this date. Fall back to the documented
    -- column defaults (014) so the engine degrades predictably instead of
    -- writing NULLs into NOT NULL columns.
    pol.grace_in_minutes               := 10;
    pol.grace_out_minutes              := 10;
    pol.auto_deduct_break              := true;
    pol.min_break_minutes_to_count     := 15;
    pol.overtime_enabled               := true;
    pol.overtime_requires_approval     := true;
    pol.overtime_min_minutes           := 30;
    pol.overtime_rounding_minutes      := 15;
    pol.max_overtime_minutes_per_day   := 240;
    pol.max_payable_minutes_per_day    := 720;
    pol.comp_off_min_minutes           := 240;
    pol.single_punch_treatment         := 'half_day_flag_review';
    pol.absent_marking_delay_hours     := 6;
    pol.min_confidence_for_auto_accept := 0.62;
  END IF;

  v_shift_start := util.ist_instant(p_ist_date, sh.start_time);
  v_shift_end   := util.ist_instant(p_ist_date + (CASE WHEN sh.crosses_midnight THEN 1 ELSE 0 END),
                                    sh.end_time);
  v_shift_mins  := sh.duration_minutes;
  v_grace_in    := COALESCE(pol.grace_in_minutes,  sh.grace_in_minutes, 10);
  v_grace_out   := COALESCE(pol.grace_out_minutes, sh.grace_out_minutes, 10);
  v_half        := COALESCE(pol.half_day_minutes,     sh.half_day_minutes,     240);
  v_absent_below:= COALESCE(pol.absent_below_minutes, sh.absent_below_minutes, 120);
  v_min_present := sh.min_minutes_for_present;

  IF e.designation_id IS NOT NULL THEN
    SELECT d.ot_eligible INTO v_desig_ot FROM public.designations d WHERE d.id = e.designation_id;
    v_desig_ot := COALESCE(v_desig_ot, true);
  END IF;

  -- 4. holiday / weekly off ------------------------------------------------
  SELECT h.id, h.is_paid INTO v_holiday_id, v_holiday_paid
  FROM public.holidays h
  WHERE h.holiday_calendar_id = public.resolve_policy('holiday_calendar', p_employee_id, p_ist_date)
    AND h.holiday_date = p_ist_date
    AND h.is_active
    AND (h.applies_to_department_ids IS NULL OR e.department_id = ANY (h.applies_to_department_ids))
  LIMIT 1;
  v_is_holiday := v_holiday_id IS NOT NULL;

  SELECT * INTO v_slot FROM public.roster_slots rs
   WHERE rs.employee_id = p_employee_id AND rs.slot_date = p_ist_date
     AND rs.is_published AND rs.deleted_at IS NULL
   LIMIT 1;

  v_is_woff := COALESCE(v_slot.is_weekly_off,
                 public.is_weekly_off(
                   public.resolve_policy('weekly_off_rule', p_employee_id, p_ist_date),
                   p_ist_date, p_employee_id));

  -- 5/6. punches -> boundaries (first scan = check-in, LAST scan = check-out)
  SELECT count(*),
         min(punched_at), max(punched_at),
         (array_agg(id ORDER BY punched_at))[1],
         (array_agg(id ORDER BY punched_at DESC))[1],
         COALESCE(bool_or(is_offline_replay), false),
         COALESCE(bool_or(needs_review), false),
         COALESCE(bool_or(match_confidence IS NOT NULL
                          AND match_confidence < pol.min_confidence_for_auto_accept), false),
         COALESCE(bool_or(duplicate_of_punch_id IS NOT NULL), false)
    INTO v_count, v_first, v_last, v_first_id, v_last_id,
         v_offline, v_needs_review, v_low_conf, v_dup
  FROM public.attendance_punches
  WHERE employee_id = p_employee_id
    AND effective_date = p_ist_date
    AND is_voided = false;

  IF v_count = 1 THEN
    v_last := NULL; v_last_id := NULL;
    v_flags := v_flags || 'single_punch_only'::text;
  END IF;

  -- 7. breaks (§7.4: explicit pairs, or INTERIOR undetermined gaps ≥ policy min)
  SELECT COALESCE(sum(g.gap_minutes), 0), count(*)
    INTO v_break, v_break_ct
  FROM (
    SELECT util.minutes_between(p.punched_at, lead(p.punched_at) OVER w) AS gap_minutes,
           p.direction,
           lead(p.direction) OVER w AS next_direction,
           row_number() OVER w      AS rn,
           count(*)   OVER ()       AS n
    FROM public.attendance_punches p
    WHERE p.employee_id = p_employee_id
      AND p.effective_date = p_ist_date
      AND p.is_voided = false
    WINDOW w AS (ORDER BY p.punched_at)
  ) g
  WHERE ( (g.direction = 'break_start' AND g.next_direction = 'break_end')
          OR (e.punch_mode = 'multi_punch'
              AND g.direction = 'undetermined' AND g.next_direction = 'undetermined'
              AND g.rn >= 2 AND g.rn <= g.n - 2) )   -- interior: neither first nor last punch
    AND g.gap_minutes >= pol.min_break_minutes_to_count;

  IF v_break = 0 AND pol.auto_deduct_break AND v_count >= 2 THEN
    v_break := sh.unpaid_break_minutes;
    v_break_ct := 0;
  END IF;
  v_break := COALESCE(v_break, 0);

  -- 8. worked minutes --------------------------------------------------------
  v_span    := util.minutes_between(v_first, v_last);
  v_worked  := GREATEST(0, v_span - v_break);
  v_payable := LEAST(v_worked, COALESCE(pol.max_payable_minutes_per_day, 720));
  IF v_span > 960 THEN v_flags := v_flags || 'span_over_16h'::text; END IF;
  IF v_count >= 1 AND v_last IS NULL THEN v_flags := v_flags || 'no_out_punch'::text; END IF;

  -- 9. punctuality (measured from SHIFT START; grace decides whether it
  --    counts, never reduces the count) — zero on non-working days ----------
  IF NOT v_is_holiday AND NOT v_is_woff AND v_first IS NOT NULL THEN
    v_late  := util.minutes_between(v_shift_start, v_first);
    v_early := util.minutes_between(v_last, v_shift_end);
    IF v_shift_start IS NOT NULL AND v_first < v_shift_start - interval '4 hours' THEN
      v_flags := v_flags || 'punch_outside_shift'::text;
    END IF;
  END IF;

  -- 10. overtime / extra work ------------------------------------------------
  IF v_is_holiday OR v_is_woff THEN
    v_extra := v_payable;
  ELSIF pol.overtime_enabled AND e.is_ot_eligible AND v_desig_ot AND sh.id IS NOT NULL THEN
    v_ot := v_payable - v_shift_mins - sh.ot_threshold_minutes;
    IF v_ot < pol.overtime_min_minutes THEN
      v_ot := 0;
    ELSE
      v_ot := LEAST((v_ot / GREATEST(pol.overtime_rounding_minutes, 1))
                      * GREATEST(pol.overtime_rounding_minutes, 1),
                    pol.max_overtime_minutes_per_day);
    END IF;
  END IF;

  -- 11. status decision table (§7.2, first match wins) ----------------------
  IF e.employment_status = 'suspended' THEN
    v_suspended := p_ist_date >= COALESCE(
      (SELECT max(ele.effective_date)
         FROM public.employee_lifecycle_events ele
        WHERE ele.employee_id = e.id AND ele.event_type = 'suspended'),
      p_ist_date);
  END IF;

  SELECT ar.id, ar.requested_status INTO v_reg_id, v_reg_status
  FROM public.attendance_regularizations ar
   WHERE ar.employee_id = p_employee_id AND ar.ist_date = p_ist_date
     AND ar.status = 'applied' AND ar.requested_status IN ('on_duty', 'work_from_home')
   ORDER BY ar.applied_at DESC NULLS LAST
   LIMIT 1;

  SELECT ar.id INTO v_applied_reg_id
  FROM public.attendance_regularizations ar
   WHERE ar.employee_id = p_employee_id AND ar.ist_date = p_ist_date
     AND ar.status = 'applied'
   ORDER BY ar.applied_at DESC NULLS LAST
   LIMIT 1;
  IF v_applied_reg_id IS NOT NULL THEN
    v_source := 'regularized';   -- fixture 11
  END IF;

  IF v_suspended THEN
    v_status := 'suspended'; v_fraction := 0.5;   -- default per suspension order
  ELSIF v_leave_request_id IS NOT NULL AND v_leave_day_value = 1.0 THEN
    v_status := 'on_leave';  v_fraction := CASE WHEN v_leave_is_paid THEN 1.0 ELSE 0.0 END;
    IF v_count > 0 THEN v_flags := v_flags || 'worked_on_leave'::text; END IF;
  ELSIF v_leave_request_id IS NOT NULL AND v_leave_day_value = 0.5 THEN
    v_status := 'on_leave_half';
    v_fraction := (CASE WHEN v_leave_is_paid THEN 0.5 ELSE 0.0 END)
                + (CASE WHEN v_payable >= v_half THEN 0.5 ELSE 0.0 END);
  ELSIF v_reg_id IS NOT NULL THEN
    v_status := v_reg_status; v_fraction := 1.0;
  ELSIF v_is_holiday AND v_payable >= pol.comp_off_min_minutes THEN
    v_status := 'holiday_worked'; v_fraction := 1.0;
  ELSIF v_is_holiday THEN
    v_status := 'holiday'; v_fraction := CASE WHEN COALESCE(v_holiday_paid, true) THEN 1.0 ELSE 0.0 END;
  ELSIF v_is_woff AND v_payable >= pol.comp_off_min_minutes THEN
    v_status := 'weekly_off_worked'; v_fraction := 1.0;
  ELSIF v_is_woff THEN
    v_status := 'weekly_off'; v_fraction := 1.0;
  ELSIF v_count = 0 THEN
    IF p_ist_date >= util.ist_today()
       OR now() < util.ist_instant(p_ist_date + 1, '00:00')
                  + make_interval(hours => pol.absent_marking_delay_hours) THEN
      v_status := 'pending'; v_fraction := 0.0;
    ELSE
      v_status := 'absent';  v_fraction := 0.0;
    END IF;
  ELSIF v_count = 1 THEN
    v_status := CASE pol.single_punch_treatment
                  WHEN 'absent' THEN 'absent'::public.attendance_status
                  WHEN 'present_flag_review' THEN 'present'::public.attendance_status
                  ELSE 'half_day'::public.attendance_status END;
    v_fraction := CASE v_status WHEN 'absent' THEN 0.0
                                WHEN 'present' THEN 1.0 ELSE 0.5 END;
  ELSIF v_payable < v_absent_below THEN
    v_status := 'absent';   v_fraction := 0.0;
  ELSIF v_payable < v_half THEN
    v_status := 'half_day'; v_fraction := 0.5;
  ELSE
    v_status := 'present';  v_fraction := 1.0;
  END IF;

  -- 12. remaining anomaly flags ---------------------------------------------
  IF v_offline      THEN v_flags := v_flags || 'offline_replay'::text;      END IF;
  IF v_needs_review THEN v_flags := v_flags || 'needs_review_punch'::text;  END IF;
  IF v_low_conf     THEN v_flags := v_flags || 'low_confidence_match'::text; END IF;
  IF v_dup          THEN v_flags := v_flags || 'duplicate_suspected'::text; END IF;
  IF v_ot > 0 AND pol.overtime_requires_approval THEN
    v_flags := v_flags || 'ot_without_approval'::text;
  END IF;

  -- 13. upsert, preserving overrides ----------------------------------------
  INSERT INTO public.attendance_days AS ad (
    employee_id, ist_date, status, status_source, shift_id, shift_start_at, shift_end_at,
    shift_duration_minutes, attendance_policy_id, weekly_off_rule_id, holiday_id, roster_slot_id,
    first_in_at, last_out_at, first_in_punch_id, last_out_punch_id, punch_count,
    gross_span_minutes, break_minutes, break_count, total_worked_minutes, payable_worked_minutes,
    is_late, late_minutes, is_early_exit, early_exit_minutes,
    overtime_minutes, extra_work_minutes, day_fraction_paid,
    leave_type_id, leave_request_id, leave_day_fraction,
    is_holiday, is_weekly_off, location_id, department_id, designation_id, manager_id,
    regularization_id, anomaly_flags, computed_at, computed_version, computed_by)
  VALUES (
    p_employee_id, p_ist_date, v_status, v_source, v_shift_id, v_shift_start, v_shift_end,
    v_shift_mins, pol.id,
    public.resolve_policy('weekly_off_rule', p_employee_id, p_ist_date),
    v_holiday_id, v_slot.id,
    v_first, v_last, v_first_id, v_last_id, v_count,
    v_span, v_break, v_break_ct, v_worked, v_payable,
    (v_late > v_grace_in), v_late, (v_early > v_grace_out), v_early,
    v_ot, v_extra, v_fraction,
    v_leave_type_id, v_leave_request_id, COALESCE(v_leave_day_value, 0),
    v_is_holiday, v_is_woff, e.location_id, e.department_id, e.designation_id,
    e.reporting_manager_id,
    v_applied_reg_id, v_flags, now(), ENGINE_VERSION,
    COALESCE(current_setting('app.compute_source', true), 'engine'))
  ON CONFLICT (employee_id, ist_date) DO UPDATE SET
    status                 = CASE WHEN ad.manual_override_status THEN ad.status ELSE EXCLUDED.status END,
    status_source          = CASE WHEN ad.manual_override_status THEN ad.status_source ELSE EXCLUDED.status_source END,
    first_in_at            = CASE WHEN ad.manual_override_times THEN ad.first_in_at ELSE EXCLUDED.first_in_at END,
    last_out_at            = CASE WHEN ad.manual_override_times THEN ad.last_out_at ELSE EXCLUDED.last_out_at END,
    shift_id               = EXCLUDED.shift_id,
    shift_start_at         = EXCLUDED.shift_start_at,
    shift_end_at           = EXCLUDED.shift_end_at,
    shift_duration_minutes = EXCLUDED.shift_duration_minutes,
    attendance_policy_id   = EXCLUDED.attendance_policy_id,
    weekly_off_rule_id     = EXCLUDED.weekly_off_rule_id,
    holiday_id             = EXCLUDED.holiday_id,
    roster_slot_id         = EXCLUDED.roster_slot_id,
    first_in_punch_id      = EXCLUDED.first_in_punch_id,
    last_out_punch_id      = EXCLUDED.last_out_punch_id,
    punch_count            = EXCLUDED.punch_count,
    gross_span_minutes     = EXCLUDED.gross_span_minutes,
    break_minutes          = EXCLUDED.break_minutes,
    break_count            = EXCLUDED.break_count,
    total_worked_minutes   = EXCLUDED.total_worked_minutes,
    payable_worked_minutes = EXCLUDED.payable_worked_minutes,
    is_late                = EXCLUDED.is_late,
    late_minutes           = EXCLUDED.late_minutes,
    is_early_exit          = EXCLUDED.is_early_exit,
    early_exit_minutes     = EXCLUDED.early_exit_minutes,
    overtime_minutes       = EXCLUDED.overtime_minutes,
    extra_work_minutes     = EXCLUDED.extra_work_minutes,
    day_fraction_paid      = CASE WHEN ad.manual_override_status THEN ad.day_fraction_paid ELSE EXCLUDED.day_fraction_paid END,
    leave_type_id          = EXCLUDED.leave_type_id,
    leave_request_id       = EXCLUDED.leave_request_id,
    leave_day_fraction     = EXCLUDED.leave_day_fraction,
    is_holiday             = EXCLUDED.is_holiday,
    is_weekly_off          = EXCLUDED.is_weekly_off,
    location_id            = EXCLUDED.location_id,
    department_id          = EXCLUDED.department_id,
    designation_id         = EXCLUDED.designation_id,
    manager_id             = EXCLUDED.manager_id,
    regularization_id      = EXCLUDED.regularization_id,
    anomaly_flags          = EXCLUDED.anomaly_flags,
    computed_at            = now(),
    computed_version       = EXCLUDED.computed_version,
    computed_by            = EXCLUDED.computed_by
  RETURNING * INTO v_row;

  -- 14. side effects (each idempotent) ---------------------------------------
  PERFORM public.sync_comp_off_for_day(v_row.id);
  PERFORM public.sync_late_deduction(p_employee_id, p_ist_date);

  RETURN v_row;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. sync_comp_off_for_day (§8.5) — idempotent comp-off crediting,
--    keyed on earned_from_attendance_day_id so recompute never double-credits.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_comp_off_for_day(p_attendance_day_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  ad                public.attendance_days;
  v_min             integer := 240;
  v_full            integer := 480;
  v_expiry          integer := 90;
  v_days            numeric(6,3);
  v_existing_id     uuid;
  v_existing_status text;
BEGIN
  IF to_regclass('public.comp_off_ledger') IS NULL THEN RETURN; END IF;  -- 019 not applied yet

  SELECT * INTO ad FROM public.attendance_days WHERE id = p_attendance_day_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF ad.attendance_policy_id IS NOT NULL THEN
    SELECT ap.comp_off_min_minutes, ap.comp_off_full_day_minutes, ap.comp_off_expiry_days
      INTO v_min, v_full, v_expiry
    FROM public.attendance_policies ap WHERE ap.id = ad.attendance_policy_id;
  END IF;

  SELECT col.id, col.status INTO v_existing_id, v_existing_status
  FROM public.comp_off_ledger col
  WHERE col.earned_from_attendance_day_id = ad.id
    AND col.entry_type = 'earned'
  LIMIT 1;

  IF ad.status IN ('weekly_off_worked', 'holiday_worked') AND ad.extra_work_minutes >= v_min THEN
    v_days := CASE WHEN ad.extra_work_minutes >= v_full THEN 1.0 ELSE 0.5 END;
    IF v_existing_id IS NULL THEN
      INSERT INTO public.comp_off_ledger
        (employee_id, entry_type, days, earned_on_date, earned_from_attendance_day_id,
         earned_minutes, earn_source, expires_on, status, days_remaining, reason, recorded_at)
      VALUES
        (ad.employee_id, 'earned', v_days, ad.ist_date, ad.id,
         ad.extra_work_minutes, ad.status::text, ad.ist_date + v_expiry,
         'pending_approval', v_days,
         format('Worked %s minutes on a %s',
                ad.extra_work_minutes,
                CASE WHEN ad.status = 'holiday_worked' THEN 'holiday' ELSE 'weekly off' END),
         now());
    ELSIF v_existing_status IN ('pending_approval', 'cancelled') THEN
      -- Re-credit / resize before approval; approved or consumed credits are
      -- owned by the approval + consumption flows, never resized by the engine.
      UPDATE public.comp_off_ledger
         SET days           = v_days,
             days_remaining = v_days,
             earned_minutes = ad.extra_work_minutes,
             earn_source    = ad.status::text,
             expires_on     = ad.ist_date + v_expiry,
             status         = 'pending_approval'
       WHERE id = v_existing_id;
    END IF;
  ELSE
    -- Recomputed to a non-working-off status: cancel (never delete) an
    -- unconsumed credit.
    IF v_existing_id IS NOT NULL AND v_existing_status IN ('pending_approval', 'available') THEN
      UPDATE public.comp_off_ledger
         SET status = 'cancelled', days_remaining = 0
       WHERE id = v_existing_id;
    END IF;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. sync_late_deduction (§8.4) — the "Late Deduction Leaves" KPI, reversible.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_late_deduction(p_employee_id uuid, p_ist_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  pol          public.attendance_policies;
  v_pol_id     uuid;
  v_start      date;
  v_end        date;
  v_late_count integer := 0;
  v_due        integer := 0;
  v_have       integer := 0;
  v_leave_year integer;
  v_nth        integer;
  v_ord        text;
  v_day_id     uuid;
  r            record;
BEGIN
  IF to_regclass('public.leave_ledger') IS NULL THEN RETURN; END IF;  -- 019 not applied yet

  v_pol_id := public.resolve_policy('attendance_policy', p_employee_id, p_ist_date);
  IF v_pol_id IS NULL THEN RETURN; END IF;
  SELECT * INTO pol FROM public.attendance_policies ap WHERE ap.id = v_pol_id;
  IF pol.late_deduction_leave_type_id IS NULL
     OR COALESCE(pol.max_late_days_before_deduction, 0) <= 0
     OR COALESCE(pol.late_deduction_leave_days, 0) <= 0 THEN
    RETURN;
  END IF;

  -- Reset period: calendar month (default) or the covering pay period.
  IF pol.late_deduction_reset_period = 'pay_period' THEN
    SELECT pp.start_date, pp.end_date INTO v_start, v_end
    FROM public.pay_periods pp
    JOIN public.employees e ON e.id = p_employee_id
    WHERE pp.company_id = e.company_id
      AND p_ist_date BETWEEN pp.start_date AND pp.end_date
    ORDER BY pp.start_date DESC
    LIMIT 1;
  END IF;
  IF v_start IS NULL THEN
    v_start := date_trunc('month', p_ist_date)::date;
    v_end   := (date_trunc('month', p_ist_date) + interval '1 month - 1 day')::date;
  END IF;

  SELECT count(*) INTO v_late_count
  FROM public.attendance_days ad
  WHERE ad.employee_id = p_employee_id
    AND ad.ist_date BETWEEN v_start AND v_end
    AND ad.is_late;

  v_due := v_late_count / pol.max_late_days_before_deduction;

  -- Deductions already standing (net of reversals) for this period bucket.
  SELECT count(*) INTO v_have
  FROM public.leave_ledger d
  WHERE d.employee_id = p_employee_id
    AND d.leave_type_id = pol.late_deduction_leave_type_id
    AND d.entry_type = 'late_deduction'
    AND d.effective_date BETWEEN v_start AND v_end
    AND NOT EXISTS (
      SELECT 1 FROM public.leave_ledger rv
      WHERE rv.reverses_id = d.id AND rv.entry_type = 'availed_reversal');

  -- Leave year = financial year start year (company FY starts April, §14).
  v_leave_year := CASE WHEN EXTRACT(MONTH FROM p_ist_date) >= 4
                       THEN EXTRACT(YEAR FROM p_ist_date)::integer
                       ELSE EXTRACT(YEAR FROM p_ist_date)::integer - 1 END;

  WHILE v_have < v_due LOOP
    v_have := v_have + 1;
    v_nth  := v_have * pol.max_late_days_before_deduction;
    v_ord  := v_nth || CASE WHEN v_nth % 100 IN (11, 12, 13) THEN 'th'
                            WHEN v_nth % 10 = 1 THEN 'st'
                            WHEN v_nth % 10 = 2 THEN 'nd'
                            WHEN v_nth % 10 = 3 THEN 'rd'
                            ELSE 'th' END;
    -- The nth late day of the period is the one that crossed the bucket.
    SELECT ad.id INTO v_day_id
    FROM public.attendance_days ad
    WHERE ad.employee_id = p_employee_id
      AND ad.ist_date BETWEEN v_start AND v_end
      AND ad.is_late
    ORDER BY ad.ist_date
    OFFSET v_nth - 1 LIMIT 1;

    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, source_id, attendance_day_id, recorded_at, recorded_by)
    VALUES
      (p_employee_id, pol.late_deduction_leave_type_id, v_leave_year, 'late_deduction',
       -pol.late_deduction_leave_days, p_ist_date,
       format('%s late arrival in %s', v_ord, to_char(p_ist_date, 'FMMonth YYYY')),
       'attendance_days', v_day_id, v_day_id, now(), NULL);

    IF v_day_id IS NOT NULL THEN
      UPDATE public.attendance_days
         SET late_deduction_leave_days = pol.late_deduction_leave_days
       WHERE id = v_day_id;
    END IF;
  END LOOP;

  -- A regularization removed a late day and the count dropped below the
  -- bucket: reverse the newest standing deduction(s) with compensating entries.
  WHILE v_have > v_due LOOP
    SELECT d.id, d.days, d.description, d.attendance_day_id INTO r
    FROM public.leave_ledger d
    WHERE d.employee_id = p_employee_id
      AND d.leave_type_id = pol.late_deduction_leave_type_id
      AND d.entry_type = 'late_deduction'
      AND d.effective_date BETWEEN v_start AND v_end
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_ledger rv
        WHERE rv.reverses_id = d.id AND rv.entry_type = 'availed_reversal')
    ORDER BY d.recorded_at DESC
    LIMIT 1;
    EXIT WHEN r.id IS NULL;

    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, source_id, attendance_day_id, reverses_id,
       recorded_at, recorded_by)
    VALUES
      (p_employee_id, pol.late_deduction_leave_type_id, v_leave_year, 'availed_reversal',
       -r.days, p_ist_date,
       'Reversal: ' || r.description, 'attendance_days', r.attendance_day_id,
       r.attendance_day_id, r.id, now(), NULL);

    IF r.attendance_day_id IS NOT NULL THEN
      UPDATE public.attendance_days
         SET late_deduction_leave_days = 0
       WHERE id = r.attendance_day_id;
    END IF;
    v_have := v_have - 1;
  END LOOP;

  IF to_regprocedure('public.recompute_leave_balance(uuid,uuid,integer)') IS NOT NULL THEN
    PERFORM public.recompute_leave_balance(p_employee_id, pol.late_deduction_leave_type_id, v_leave_year);
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Enqueue machinery (§7.5)
-- -----------------------------------------------------------------------------

-- §7.5 verbatim: punch insert/void → priority-3 job, deduped by uq_arq__pending.
CREATE OR REPLACE FUNCTION public.enqueue_attendance_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.attendance_recompute_queue
    (employee_id, ist_date, reason, source_table, source_id, enqueued_by, priority)
  VALUES (NEW.employee_id, NEW.effective_date,
          CASE WHEN TG_OP = 'INSERT' THEN 'punch_inserted' ELSE 'punch_voided' END,
          TG_TABLE_NAME, NEW.id, app.ctx_actor_id(), 3)
  ON CONFLICT (employee_id, ist_date) WHERE processed_at IS NULL DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_punches__enqueue ON public.attendance_punches;
CREATE TRIGGER trg_attendance_punches__enqueue
  AFTER INSERT OR UPDATE OF is_voided ON public.attendance_punches
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_attendance_recompute();

-- Shared single-key enqueue used by the non-punch sources.
CREATE OR REPLACE FUNCTION public.enqueue_recompute(
  p_employee_id  uuid,
  p_ist_date     date,
  p_reason       text,
  p_source_table text DEFAULT NULL,
  p_source_id    uuid DEFAULT NULL,
  p_priority     smallint DEFAULT 5)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_employee_id IS NULL OR p_ist_date IS NULL THEN RETURN; END IF;
  INSERT INTO public.attendance_recompute_queue
    (employee_id, ist_date, reason, source_table, source_id, enqueued_by, priority)
  VALUES (p_employee_id, p_ist_date, p_reason, p_source_table, p_source_id,
          app.ctx_actor_id(), p_priority)
  ON CONFLICT (employee_id, ist_date) WHERE processed_at IS NULL DO NOTHING;
END;
$$;

-- roster_slots → 'roster_changed' (old AND new key on moves).
CREATE OR REPLACE FUNCTION public.roster_slots_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.enqueue_recompute(NEW.employee_id, NEW.slot_date, 'roster_changed',
                                     TG_TABLE_NAME, NEW.id);
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND (OLD.slot_date IS DISTINCT FROM NEW.slot_date
                               OR OLD.employee_id IS DISTINCT FROM NEW.employee_id)) THEN
    PERFORM public.enqueue_recompute(OLD.employee_id, OLD.slot_date, 'roster_changed',
                                     TG_TABLE_NAME, OLD.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_roster_slots__enqueue ON public.roster_slots;
CREATE TRIGGER trg_roster_slots__enqueue
  AFTER INSERT OR UPDATE OR DELETE ON public.roster_slots
  FOR EACH ROW EXECUTE FUNCTION public.roster_slots_enqueue_recompute();

-- holidays → 'holiday_changed': fan out to every employee in employment on the
-- date. Future dates are skipped — their rows are not materialised (fixture 10).
CREATE OR REPLACE FUNCTION public.holidays_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_dates date[] := '{}';
  v_src   uuid;
  v_date  date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_src := OLD.id;
    v_dates := v_dates || OLD.holiday_date;
  ELSE
    v_src := NEW.id;
    v_dates := v_dates || NEW.holiday_date;
    IF TG_OP = 'UPDATE' AND OLD.holiday_date IS DISTINCT FROM NEW.holiday_date THEN
      v_dates := v_dates || OLD.holiday_date;
    END IF;
  END IF;

  FOREACH v_date IN ARRAY v_dates LOOP
    CONTINUE WHEN v_date > util.ist_today();
    INSERT INTO public.attendance_recompute_queue
      (employee_id, ist_date, reason, source_table, source_id, enqueued_by)
    SELECT e.id, v_date, 'holiday_changed', TG_TABLE_NAME, v_src, app.ctx_actor_id()
    FROM public.employees e
    WHERE e.deleted_at IS NULL
      AND NOT e.exclude_from_attendance
      AND e.date_of_join IS NOT NULL AND e.date_of_join <= v_date
      AND (e.last_working_day IS NULL OR e.last_working_day >= v_date)
    ON CONFLICT (employee_id, ist_date) WHERE processed_at IS NULL DO NOTHING;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_holidays__enqueue ON public.holidays;
CREATE TRIGGER trg_holidays__enqueue
  AFTER INSERT OR UPDATE OR DELETE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION public.holidays_enqueue_recompute();

-- shift_assignments → 'shift_changed' over the affected (past-only) window,
-- lookback bounded to 92 days; older corrections use recompute_attendance_range.
CREATE OR REPLACE FUNCTION public.shift_assignments_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_emp  uuid;
  v_src  uuid;
  v_from date;
  v_to   date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_emp := OLD.employee_id; v_src := OLD.id;
    v_from := OLD.effective_from;
    v_to   := COALESCE(OLD.effective_to, util.ist_today());
  ELSIF TG_OP = 'UPDATE' THEN
    v_emp := NEW.employee_id; v_src := NEW.id;
    v_from := LEAST(NEW.effective_from, OLD.effective_from);
    v_to   := GREATEST(COALESCE(NEW.effective_to, util.ist_today()),
                       COALESCE(OLD.effective_to, util.ist_today()));
  ELSE
    v_emp := NEW.employee_id; v_src := NEW.id;
    v_from := NEW.effective_from;
    v_to   := COALESCE(NEW.effective_to, util.ist_today());
  END IF;

  v_from := GREATEST(v_from, util.ist_today() - 92);
  v_to   := LEAST(v_to, util.ist_today());
  IF v_from > v_to THEN RETURN NULL; END IF;

  INSERT INTO public.attendance_recompute_queue
    (employee_id, ist_date, reason, source_table, source_id, enqueued_by)
  SELECT v_emp, d::date, 'shift_changed', TG_TABLE_NAME, v_src, app.ctx_actor_id()
  FROM generate_series(v_from, v_to, interval '1 day') d
  ON CONFLICT (employee_id, ist_date) WHERE processed_at IS NULL DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_shift_assignments__enqueue ON public.shift_assignments;
CREATE TRIGGER trg_shift_assignments__enqueue
  AFTER INSERT OR UPDATE OR DELETE ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION public.shift_assignments_enqueue_recompute();

-- policy_assignments → fan-out to affected employees × (past-only) date range.
CREATE OR REPLACE FUNCTION public.policy_assignments_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r      record;
  v_from date;
  v_to   date;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;

  -- Only kinds the day engine reads; leave_policy / pay_period do not reshape
  -- attendance_days rows.
  IF r.assignment_kind NOT IN ('attendance_policy', 'weekly_off_rule',
                               'holiday_calendar', 'shift') THEN
    RETURN NULL;
  END IF;

  v_from := r.effective_from;
  v_to   := COALESCE(r.effective_to, util.ist_today());
  IF TG_OP = 'UPDATE' THEN
    v_from := LEAST(v_from, OLD.effective_from);
    v_to   := GREATEST(v_to, COALESCE(OLD.effective_to, util.ist_today()));
  END IF;
  v_from := GREATEST(v_from, util.ist_today() - 92);
  v_to   := LEAST(v_to, util.ist_today());
  IF v_from > v_to THEN RETURN NULL; END IF;

  INSERT INTO public.attendance_recompute_queue
    (employee_id, ist_date, reason, source_table, source_id, enqueued_by)
  SELECT e.id, d::date,
         CASE WHEN r.assignment_kind = 'shift' THEN 'shift_changed' ELSE 'policy_changed' END,
         TG_TABLE_NAME, r.id, app.ctx_actor_id()
  FROM public.employees e
  CROSS JOIN generate_series(v_from, v_to, interval '1 day') d
  WHERE e.deleted_at IS NULL
    AND NOT e.exclude_from_attendance
    AND e.date_of_join IS NOT NULL AND e.date_of_join <= d::date
    AND (e.last_working_day IS NULL OR e.last_working_day >= d::date)
    AND CASE r.scope
          WHEN 'employee'        THEN e.id              = r.employee_id
          WHEN 'designation'     THEN e.designation_id  = r.designation_id
          WHEN 'grade'           THEN e.grade_id        = r.grade_id
          WHEN 'section'         THEN e.section_id      = r.section_id
          WHEN 'department'      THEN e.department_id   = r.department_id
          WHEN 'employment_type' THEN e.employment_type = r.employment_type
          WHEN 'location'        THEN e.location_id     = r.location_id
          WHEN 'company'         THEN e.company_id      = r.company_id
        END
  ON CONFLICT (employee_id, ist_date) WHERE processed_at IS NULL DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_policy_assignments__enqueue ON public.policy_assignments;
CREATE TRIGGER trg_policy_assignments__enqueue
  AFTER INSERT OR UPDATE OR DELETE ON public.policy_assignments
  FOR EACH ROW EXECUTE FUNCTION public.policy_assignments_enqueue_recompute();

-- attendance_regularizations → 'regularization_applied' when status flips to
-- applied (the apply flow inserts the system_regularization punches first).
CREATE OR REPLACE FUNCTION public.attendance_regularizations_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'applied' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.enqueue_recompute(NEW.employee_id, NEW.ist_date,
                                     'regularization_applied', TG_TABLE_NAME, NEW.id, 3::smallint);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_regularizations__enqueue ON public.attendance_regularizations;
CREATE TRIGGER trg_attendance_regularizations__enqueue
  AFTER UPDATE OF status ON public.attendance_regularizations
  FOR EACH ROW EXECUTE FUNCTION public.attendance_regularizations_enqueue_recompute();

-- NOTE: the matching enqueue trigger on leave_request_days (reasons
-- leave_approved / leave_cancelled) is created in migration 019 with the table.

-- -----------------------------------------------------------------------------
-- 6. drain_attendance_recompute_queue (§7.5 verbatim; safely concurrent via
--    FOR UPDATE SKIP LOCKED; a per-item EXCEPTION block so one bad day cannot
--    stall the queue)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drain_attendance_recompute_queue(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r      record;
  v_done integer := 0;
  v_err  integer := 0;
  v_run  uuid;
  v_t0   timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.attendance_recompute_runs (run_kind, engine_version, started_at, status)
  VALUES ('queue_drain', 1, now(), 'running') RETURNING id INTO v_run;

  FOR r IN
    UPDATE public.attendance_recompute_queue q
       SET claimed_at = now(), claimed_by = 'cron', run_id = v_run
     WHERE q.id IN (
       SELECT id FROM public.attendance_recompute_queue
        WHERE processed_at IS NULL AND claimed_at IS NULL
        ORDER BY priority, enqueued_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED)
    RETURNING q.id, q.employee_id, q.ist_date, q.reason
  LOOP
    BEGIN
      PERFORM public.compute_attendance_day(r.employee_id, r.ist_date, r.reason);
      UPDATE public.attendance_recompute_queue
         SET processed_at = now() WHERE id = r.id;
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_err := v_err + 1;
      UPDATE public.attendance_recompute_queue
         SET claimed_at = NULL, attempts = attempts + 1, last_error = SQLERRM
       WHERE id = r.id;
    END;
  END LOOP;

  UPDATE public.attendance_recompute_runs
     SET finished_at = now(), days_written = v_done, errors = v_err,
         days_targeted = v_done + v_err,
         status = 'succeeded',
         duration_ms = (EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::integer
   WHERE id = v_run;
  RETURN v_done;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. recompute_attendance_range (§7.5) — the only supported way to reprocess
--    history. Super-admin gated (service-role/cron callers have no auth.uid()).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.recompute_attendance_range(
  p_from         date,
  p_to           date,
  p_employee_ids uuid[] DEFAULT NULL,
  p_reason       text   DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run      uuid;
  v_emp      uuid;
  v_d        date;
  v_to       date;
  v_targeted integer := 0;
  v_written  integer := 0;
  v_locked   integer := 0;
  v_errors   integer := 0;
  v_err      jsonb := '[]'::jsonb;
  v_t0       timestamptz := clock_timestamp();
BEGIN
  IF auth.uid() IS NOT NULL AND NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'recompute_attendance_range is super-admin only'
      USING errcode = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'invalid recompute range: % .. %', p_from, p_to;
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'a reason (>= 10 chars) is required for a range recompute';
  END IF;
  v_to := LEAST(p_to, util.ist_today());   -- future rows are never materialised

  INSERT INTO public.attendance_recompute_runs
    (run_kind, requested_by, reason, from_date, to_date, employee_filter,
     engine_version, started_at, status)
  VALUES
    ('range_backfill', app.ctx_actor_id(), p_reason, p_from, v_to,
     CASE WHEN p_employee_ids IS NULL THEN NULL
          ELSE jsonb_build_object('employee_ids', to_jsonb(p_employee_ids)) END,
     1, now(), 'running')
  RETURNING id INTO v_run;

  FOR v_emp IN
    SELECT e.id FROM public.employees e
    WHERE e.deleted_at IS NULL
      AND NOT e.exclude_from_attendance
      AND (p_employee_ids IS NULL OR e.id = ANY (p_employee_ids))
  LOOP
    v_d := p_from;
    WHILE v_d <= v_to LOOP
      v_targeted := v_targeted + 1;
      BEGIN
        PERFORM public.compute_attendance_day(v_emp, v_d, p_reason, true);
        v_written := v_written + 1;
      EXCEPTION
        WHEN SQLSTATE '55006' THEN   -- attendance_locked (hard lock)
          v_locked := v_locked + 1;
        WHEN OTHERS THEN
          v_errors := v_errors + 1;
          IF jsonb_array_length(v_err) < 50 THEN
            v_err := v_err || jsonb_build_object(
              'employee_id', v_emp, 'ist_date', v_d, 'error', SQLERRM);
          END IF;
      END;
      v_d := v_d + 1;
    END LOOP;
  END LOOP;

  UPDATE public.attendance_recompute_runs
     SET finished_at         = now(),
         days_targeted       = v_targeted,
         days_written        = v_written,
         days_skipped_locked = v_locked,
         errors              = v_errors,
         error_detail        = CASE WHEN v_errors > 0 THEN v_err END,
         status              = CASE WHEN v_errors = 0 THEN 'succeeded'::public.job_run_status
                                    ELSE 'failed'::public.job_run_status END,
         duration_ms         = (EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::integer
   WHERE id = v_run;
  RETURN v_run;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. mark_absent_days (§8.9, 04:00 IST) — flips yesterday's pending/missing
--    rows to absent once absent_marking_delay_hours has passed. The
--    NO_SHOW_ALERT notification rows are written by the notification sweep
--    (027/041) reading newly-absent days; nothing here blocks on it.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_absent_days()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_yesterday date := util.ist_today() - 1;
  v_run       uuid;
  r           record;
  v_done      integer := 0;
  v_errors    integer := 0;
  v_t0        timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.attendance_recompute_runs
    (run_kind, reason, from_date, to_date, engine_version, started_at, status)
  VALUES ('nightly', 'mark_absent_days: 04:00 IST no-show sweep',
          v_yesterday, v_yesterday, 1, now(), 'running')
  RETURNING id INTO v_run;

  FOR r IN
    SELECT e.id FROM public.employees e
    WHERE e.deleted_at IS NULL
      AND NOT e.exclude_from_attendance
      AND e.date_of_join IS NOT NULL AND e.date_of_join <= v_yesterday
      AND (e.last_working_day IS NULL OR e.last_working_day >= v_yesterday)
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_days ad
        WHERE ad.employee_id = e.id
          AND ad.ist_date = v_yesterday
          AND ad.status <> 'pending')
  LOOP
    BEGIN
      PERFORM public.compute_attendance_day(r.id, v_yesterday, 'mark_absent_days');
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
    END;
  END LOOP;

  UPDATE public.attendance_recompute_runs
     SET finished_at   = now(),
         days_targeted = v_done + v_errors,
         days_written  = v_done,
         errors        = v_errors,
         status        = CASE WHEN v_errors = 0 THEN 'succeeded'::public.job_run_status
                              ELSE 'failed'::public.job_run_status END,
         duration_ms   = (EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::integer
   WHERE id = v_run;
  RETURN v_done;
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants — engine writes are service/cron territory; nothing is callable
--    by anon, and only the super-admin-gated range recompute is exposed to
--    authenticated (the gate is inside the function).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_fn text;
  v_role text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.upsert_attendance_day(uuid, date, public.attendance_status, numeric, integer)',
    'public.compute_attendance_day(uuid, date, text, boolean)',
    'public.sync_comp_off_for_day(uuid)',
    'public.sync_late_deduction(uuid, date)',
    'public.enqueue_recompute(uuid, date, text, text, uuid, smallint)',
    'public.drain_attendance_recompute_queue(integer)',
    'public.recompute_attendance_range(date, date, uuid[], text)',
    'public.mark_absent_days()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', v_fn, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.recompute_attendance_range(date, date, uuid[], text)
      TO authenticated;   -- internally gated to super_admin
  END IF;
END $$;

COMMIT;
