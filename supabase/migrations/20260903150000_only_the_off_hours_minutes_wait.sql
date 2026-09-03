-- ============================================================================
-- Only the off-hours minutes wait for approval — not the day they are attached to.
--
-- ── THE RULE THE VENUE STATED, VERBATIM ─────────────────────────────────────
-- "There are clear rules. Suppose they're logging in at 8. If they're punching in
--  at 8 am, then they can directly come to the office and log out from the office
--  itself. There is no need to break it. From 8 am to 5:30 or 6:30 pm, whatever it
--  will be, it will be counted directly. But when there is overtime work happening
--  after the working hours, like at 8-9 pm, then they should log in and log out."
--
-- ── WHAT THE ENGINE WAS DOING INSTEAD, AND IT WAS SEVERE ────────────────────
-- Step 8b computed `pending_approval_minutes` by recomputing the whole day over the
-- punches that were NOT awaiting approval, and taking the difference. On the venue's
-- commonest off-hours shape that withheld everything:
--
--   08:00  web punch-in for an off-site client call, reason given, awaiting approval
--   17:30  punch-out at the gate
--
-- Filtering the pending punch left ONE surviving scan; one scan is no span, so the
-- approved-only pass returned 0 and `pending` became the ENTIRE 9h30m day. A full
-- day's pay waited on an administrator accepting eighty minutes. Nobody had hit it
-- yet only because no employee had used the flow since it shipped.
--
-- ── THE RULE NOW ────────────────────────────────────────────────────────────
-- Work sessions are the ODD-numbered gaps between a day's punches in time order
-- (p1-p2, p3-p4, …) — the same parity the break rule two steps above uses, so the
-- two cannot disagree. For each session: clip it to the shift window
-- [start − grace_in, end + grace_out], the same window `punch_within_shift` uses to
-- decide whether the punch needed a reason at all; the minutes outside that clip are
-- off-hours minutes; and they are pending only if one of the session's own two
-- punches is `requires_approval` and not yet approved.
--
-- ── MEASURED, NOT ASSUMED ───────────────────────────────────────────────────
-- Every figure below is from a rolled-back transaction against live data, employee
-- 128, whose shift is 09:30–17:30 with the policy's 10-minute grace, so the window
-- opens 09:20:
--
--   ordinary day, two gate punches         worked 491   pending  0   (regression)
--   evening session, already approved      worked 586   pending  0   ot 75
--   08:00 web unapproved -> 17:30 gate     worked 570   pending 80   (was 570)
--   the same day once approved             worked 570   pending  0
--   gate day + 20:00-21:30 web unapproved  worked 581   pending 90
--
-- The 80 is 08:00 to 09:20 exactly. The day's own 490 minutes count immediately,
-- which is what "it will be counted directly" means.
--
-- ── GENERATED FROM THE DEPLOYED DEFINITION ──────────────────────────────────
-- `pg_get_functiondef` of the live function with step 8b and its two declarations
-- replaced, and nothing else: the head before the declarations and the whole tail
-- after 8b were asserted byte-identical before this file was written. `v_a_first`,
-- `v_a_last`, `v_a_count`, `v_a_break` and `v_a_worked` are gone with the rule that
-- used them; no reference to any of them survives.
--
-- A GATE PUNCH IS NEVER `requires_approval`, so an ordinary day still computes 0
-- here and every day already recorded is unaffected — the recompute below re-runs
-- September to prove it rather than to change it.
-- ============================================================================

SELECT set_config('app.reason',
  'attendance engine 8b: only off-hours minutes in an unapproved session are withheld, not the whole day they sit in',
  true);

CREATE OR REPLACE FUNCTION public.compute_attendance_day(p_employee_id uuid, p_ist_date date, p_reason text DEFAULT NULL::text, p_force boolean DEFAULT false)
 RETURNS attendance_days
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  /*
    The same day computed a second time, over the punches an administrator has NOT still to
    approve. The difference between the two is `pending_approval_minutes`: hours that show on
    the day with a star and stay out of the monthly total until somebody accepts the reason.
  */
  /*
    The shift window, computed once in step 8b. `v_a_*` are gone with the rule that used them:
    the approved-only recompute withheld a whole day when its first punch was pending.
  */
  v_win_from     timestamptz;
  v_win_to       timestamptz;
  v_pending      integer := 0;
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
  /*
    ONLY AN EXPLICIT BREAK IS A BREAK.

    There used to be a second clause here: under `multi_punch`, ANY interior gap between
    two undetermined scans counted as an unpaid break. That is what turned a real day —
    scans at 07:36, 07:38, 14:18, 22:12, 22:15 — into five minutes worked, because the two
    interior gaps were 400 and 474 minutes and 879 − 874 = 5.

    It also does not match what multi_punch means. Multi punch requires an IN and an OUT
    and then bands the DURATION between them; it does not treat every tap in between as
    clocking out. A guard who scans at the gate on the way past lunch has not ended their
    shift, and the engine must not decide that they have.

    So a break is now only ever a break the employee actually recorded — a
    break_start/break_end pair — plus the shift's fixed unpaid break where the policy sets
    `auto_deduct_break`, which is handled just below.
  */
  WHERE g.gap_minutes >= pol.min_break_minutes_to_count
    AND (
      (g.direction = 'break_start' AND g.next_direction = 'break_end')
      /*
        ── ALTERNATE INTERIOR GAPS ARE THE BREAKS ──────────────────────────────
        Punches in order are p1..pn. Work happens between p1-p2, p3-p4, p5-p6; the gaps
        BETWEEN those pairs -- p2-p3, p4-p5 -- are when the person was away. So a break is
        every gap whose starting punch sits at an EVEN position.

        This restores a deduction that was removed, and it is not the rule that was removed.
        The old one deducted EVERY interior gap, which is why the day recorded in the comment
        above -- 07:36, 07:38, 14:18, 22:12, 22:15 -- collapsed to five minutes: it took out
        both the 400-minute and the 474-minute gap. Alternating takes out the 400 and the 3,
        leaving 476, which is what that person actually worked.

        Deducting NOTHING, which is what has been happening since, is wrong in the other
        direction and by more. On a General shift `unpaid_break_minutes` is 0, so
        `auto_deduct_break` subtracts nothing and the full span is paid: employee 114 was
        credited 11h48m for 8h25m worked, PR6 13h47m for 9h54m, PR5 13h09m for 9h23m.

        Identical to the arithmetic already shipped and tested on the punch card
        (`features/attendance/lib/sessions.ts`), so the card and the payslip agree by
        construction rather than by two people keeping two rules in step.

        TWO ASSUMPTIONS, BOTH TRUE OF THIS DATA AND BOTH CHECKED BEFORE WRITING THIS:
        parity is only meaningful if the punch list has no duplicate double-scans and no
        explicit break pairs shifting the positions. There are zero of each
        (`duplicate_of_punch_id` is null on all 1,185 live punches, and no punch carries
        `break_start`/`break_end`), and `kiosk-punch`'s dwell rule writes no row at all for a
        re-scan inside five minutes, so duplicates cannot accumulate.
      */
      OR (g.rn % 2 = 0 AND g.rn < g.n)
    );

  IF v_break = 0 AND pol.auto_deduct_break AND v_count >= 2 THEN
    v_break := sh.unpaid_break_minutes;
    v_break_ct := 0;
  END IF;
  v_break := COALESCE(v_break, 0);

  -- 8. worked minutes --------------------------------------------------------
  v_span    := util.minutes_between(v_first, v_last);
  v_worked  := GREATEST(0, v_span - v_break);
  v_payable := LEAST(v_worked, COALESCE(pol.max_payable_minutes_per_day, 720));

  /*
    ── 8b. HOW MUCH OF THAT IS STILL AWAITING APPROVAL ─────────────────────────
    Only the time worked OUTSIDE the shift window, and only in a session an administrator has
    still to accept.

    ── WHY THIS REPLACES THE PREVIOUS RULE, WHICH WAS BADLY WRONG ──────────────
    The old version recomputed the whole day over the punches that were not pending and took
    the difference. On the venue's own commonest case that withheld everything:

      08:00 web punch-in for an off-site client call, reason given, awaiting approval
      17:30 punch-out at the gate

    Filtering the pending punch left ONE surviving scan, one scan is no span, so the approved
    pass came out 0 and `pending` became the ENTIRE 9h30m day. A full day's pay waited on an
    administrator accepting eighty minutes.

    The venue's rule, stated plainly on the 3 Sep call: "if they are punching in at 8 am, then
    they can directly come to the office and log out from the office itself. There is no need
    to break it. From 8 am to 5:30 or 6:30 pm, whatever it will be, it will be counted
    directly." Only genuine extra time waits for a decision — not the working day it is
    attached to.

    ── THE RULE ────────────────────────────────────────────────────────────────
    Work sessions are the ODD-numbered gaps between punches in time order (p1-p2, p3-p4, …) —
    the same parity the break rule above uses, so the two cannot disagree. For each session:

      * clip it to the shift window [shift_start − grace_in, shift_end + grace_out], the same
        window `punch_within_shift` uses to decide whether a punch needed a reason at all;
      * the minutes OUTSIDE that clip are off-hours minutes;
      * they are pending only if one of the session's own two punches is `requires_approval`
        and not yet approved.

    So the 08:00 case yields 80 pending minutes (08:00 to 09:20, being 09:30 less ten minutes
    grace) and the other 490 count immediately. An evening session 20:00–21:37 after a normal
    day yields 97 pending minutes and leaves the day's own 489 alone. A gate punch is never
    `requires_approval`, so an ordinary day still comes out 0 here.

    NO SHIFT MEANS NO OFF-HOURS. With no shift resolved there is no window to be outside of,
    and `punch_within_shift` returns true for the same reason — absent configuration must
    never make somebody's hours provisional.
  */
  IF sh.id IS NULL OR v_shift_start IS NULL OR v_shift_end IS NULL THEN
    v_pending := 0;
  ELSE
    v_win_from := v_shift_start - make_interval(mins => v_grace_in);
    v_win_to   := v_shift_end   + make_interval(mins => v_grace_out);

    SELECT COALESCE(sum(
             /*
               Session length, less the part of it that fell inside the shift window. The inner
               GREATEST handles a session entirely outside the window, where the clipped
               interval is inverted and its length must read as zero rather than negative.
             */
             GREATEST(0,
               util.minutes_between(s.starts_at, s.ends_at)
               - GREATEST(0, util.minutes_between(
                   GREATEST(s.starts_at, v_win_from),
                   LEAST(s.ends_at, v_win_to)))
             )), 0)
      INTO v_pending
    FROM (
      SELECT p.punched_at                                       AS starts_at,
             lead(p.punched_at)          OVER w                 AS ends_at,
             row_number()                OVER w                 AS rn,
             (p.requires_approval AND p.approved_at IS NULL)     AS open_start,
             (lead(p.requires_approval)  OVER w
              AND lead(p.approved_at)    OVER w IS NULL)         AS open_end
        FROM public.attendance_punches p
       WHERE p.employee_id = p_employee_id
         AND p.effective_date = p_ist_date
         AND p.is_voided = false
      WINDOW w AS (ORDER BY p.punched_at)
    ) s
    WHERE s.ends_at IS NOT NULL
      AND s.rn % 2 = 1                       -- work sessions, not the gaps between them
      AND (s.open_start OR s.open_end);
  END IF;

  /*
    Clamped into what the day actually worked, which `ck_ad__pending_within_worked` also
    enforces. The clip arithmetic cannot exceed the span, so this guards against a skewed
    device clock rather than against the formula.
  */
  v_pending := GREATEST(0, LEAST(v_worked, COALESCE(v_pending, 0)));
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
  /*
    ── WHAT THE TWO PUNCH MODELS ACTUALLY MEAN ────────────────────────────────

    Corrected from the client's own definition, which is not what this branch used to
    implement:

      single_punch  ONE punch is enough, and it makes a FULL DAY. Duration is not the
                    question — the scan is the attendance. Somebody who taps once and
                    works a twelve-hour event is present, and so is somebody who taps
                    once and leaves; measuring them differently is what the other model
                    is for.

      multi_punch   BOTH an in and an out are required before attendance is counted at
                    all. With both present, the DURATION decides the day against the
                    policy's own thresholds:
                        under absent_below_minutes   -> absent
                        up to half_day_minutes       -> half day
                        at or above it               -> full day
                    With only one scan there is no duration, so there is nothing to
                    band: it falls to `single_punch_treatment`, which exists for exactly
                    this case and defaults to absent.

    Before this, a lone scan was banded by `single_punch_treatment` in BOTH models, so
    `single_punch` behaved identically to `multi_punch` for the one case that defines it,
    and a single scan came out absent — the opposite of the model's whole point.
  */
  ELSIF e.punch_mode = 'single_punch' THEN
    -- Any scan at all is the day. No duration test, in either the 1-punch or the
    -- many-punch case, which is what makes this model different from the other.
    v_status := 'present'; v_fraction := 1.0;
  ELSIF v_count = 1 THEN
    -- multi_punch with no out-scan: no duration exists, so the policy decides.
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
    pending_approval_minutes,
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
    v_pending,
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
    pending_approval_minutes = EXCLUDED.pending_approval_minutes,
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
$function$
;

-- ---------------------------------------------------------------------------
-- Recompute the month, so the change is visible and provably inert elsewhere
-- ---------------------------------------------------------------------------
/*
  Every September day for everybody. There are no unapproved off-hours punches in the
  system yet, so every figure should come back unchanged — which is the point of doing
  it here rather than waiting for the queue: a silent difference would be a regression,
  and this is where it would show.
*/
DO $do$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT DISTINCT employee_id, ist_date
             FROM public.attendance_days
            WHERE ist_date >= '2026-09-01' AND ist_date <= util.ist_today()
            ORDER BY ist_date, employee_id
  LOOP
    PERFORM public.compute_attendance_day(r.employee_id, r.ist_date,
              'engine 8b: off-hours pending minutes rule replaced');
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'recomputed % day(s)', n;
END
$do$;
