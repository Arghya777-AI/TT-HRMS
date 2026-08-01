-- ============================================================================
-- 20260801040000_leave_countable_dates_mirrors_the_engine.sql
--
-- 039900 SHIPPED A PREVIEW THAT WOULD HAVE LIED. This replaces it.
--
-- The apply screen needs to show which dates in a from–to range cost leave, and 039900
-- answered by reading `employees.weekly_off_rule_id` / `employees.holiday_calendar_id` and
-- treating any weekly off or holiday as free. Reading the engine it was supposed to mirror —
-- `rebuild_leave_request_days`, which is what actually stamps `total_days` — showed three
-- ways that answer diverges:
--
--   1. THE ROTA IS RESOLVED, NOT READ OFF THE EMPLOYEE.
--      `resolve_policy('weekly_off_rule', employee, date)` first, employee column only as the
--      fallback. Same for the holiday calendar. Per-employee policy overrides exist in this
--      system precisely so one person can be on a different rota, and 039900 ignored every
--      one of them.
--
--   2. HOLIDAYS ARE FILTERED. The engine counts a holiday only when it is active, NOT
--      optional, and applies to the employee's department and location
--      (`applies_to_department_ids` / `applies_to_location_ids`, NULL meaning everyone).
--      039900 accepted any active holiday on the calendar — so an optional holiday, or one
--      for another department, would have shown as a free day and then cost a day of balance.
--
--   3. WHETHER A FREE DAY IS FREE DEPENDS ON THE LEAVE TYPE. The engine's rule is:
--
--         holiday    → counts if (count_holiday_as_leave    OR sandwich_holidays)
--         weekly off → counts if (count_weekly_off_as_leave OR sandwich_holidays)
--         otherwise  → counts
--
--      A sandwich type counts the Sunday in the middle. 039900 took no leave type at all and
--      called every Sunday free, which is the WRONG direction of error: it under-states the
--      cost, so an employee would allocate what the screen showed and be refused by the
--      balance check for a number they never saw.
--
-- ── SO THIS FUNCTION IS THE ENGINE'S LOOP, READ-ONLY ─────────────────────────
-- Same `resolve_policy` calls, same holiday predicate, same `count_*_as_leave` / sandwich
-- logic, same `day_value` arithmetic, same 366-day span limit. It writes no
-- `leave_request_days` rows and stamps no `total_days` — that stays `calc_leave_days`' job on
-- a real request. If the engine's rules change, this must change with it, and the duplication
-- is deliberate: the alternative is creating a draft request to price a range somebody has not
-- decided on yet, which is what the old screen did and why a half-finished application left
-- rows behind.
--
-- ── `p_leave_type_id` IS NULLABLE, AND WHAT NULL MEANS IS STATED ─────────────
-- The calendar has to paint weekly offs BEFORE any leave type is chosen — that is the whole
-- point of showing them. With NULL, `would_count` is the plain reading (a weekly off or a
-- holiday is free) and `type_dependent` is returned TRUE on exactly those days, so the screen
-- can say the day is free "for most types" rather than promise it. Once a type is chosen the
-- answer is that type's, exactly.
--
-- SECURITY. `SECURITY DEFINER` because the rota, the policy resolver and the holiday calendar
-- are not selectable by an employee directly; `app.can_see_employee` is checked first, so it
-- cannot be used to enumerate somebody else's roster.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.leave_countable_dates(uuid, date, date);

CREATE OR REPLACE FUNCTION public.leave_countable_dates(
  p_employee_id   uuid,
  p_from          date,
  p_to            date,
  p_leave_type_id uuid DEFAULT NULL
)
RETURNS TABLE (
  leave_date     date,
  is_weekly_off  boolean,
  is_holiday     boolean,
  holiday_name   text,
  would_count    boolean,
  /** 1.000, 0.500 or 0.000 — the same figure the engine writes to `day_value`. */
  day_value      numeric,
  /** TRUE when a leave type's own rules decide this day and none was supplied. */
  type_dependent boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  e         public.employees%ROWTYPE;
  lt        public.leave_types%ROWTYPE;
  d         date;
  v_cal     uuid;
  v_rule    uuid;
  v_is_hol  boolean;
  v_hol     text;
  v_is_off  boolean;
  v_counted boolean;
BEGIN
  IF NOT app.can_see_employee(p_employee_id) THEN
    RAISE EXCEPTION 'not permitted: that employee is outside your scope'
      USING errcode = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'the range must start on or before it ends' USING errcode = '22023';
  END IF;
  -- The engine's own limit, refused here so a range it would reject is never previewed.
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'a leave range longer than 366 days cannot be previewed'
      USING errcode = '22023';
  END IF;

  SELECT * INTO e FROM public.employees WHERE id = p_employee_id AND deleted_at IS NULL;
  IF e.id IS NULL THEN
    RAISE EXCEPTION 'employee not found' USING errcode = 'P0002';
  END IF;

  IF p_leave_type_id IS NOT NULL THEN
    SELECT * INTO lt FROM public.leave_types WHERE id = p_leave_type_id;
    IF lt.id IS NULL THEN
      RAISE EXCEPTION 'leave type not found' USING errcode = 'P0002';
    END IF;
  END IF;

  d := p_from;
  WHILE d <= p_to LOOP
    -- Resolved, with the employee column as fallback — `rebuild_leave_request_days` verbatim.
    v_cal  := COALESCE(public.resolve_policy('holiday_calendar', p_employee_id, d),
                       e.holiday_calendar_id);
    v_rule := COALESCE(public.resolve_policy('weekly_off_rule', p_employee_id, d),
                       e.weekly_off_rule_id);

    SELECT h.name INTO v_hol
    FROM public.holidays h
    WHERE h.holiday_calendar_id = v_cal
      AND h.holiday_date = d
      AND h.is_active
      AND NOT h.is_optional
      AND (h.applies_to_department_ids IS NULL
           OR e.department_id = ANY (h.applies_to_department_ids))
      AND (h.applies_to_location_ids IS NULL
           OR e.location_id = ANY (h.applies_to_location_ids))
    LIMIT 1;
    v_is_hol := v_hol IS NOT NULL;

    -- No rule resolved means no weekly off can be asserted: the engine's `is_weekly_off`
    -- returns NULL for a NULL rule and the CASE below treats that as working.
    v_is_off := COALESCE(
      CASE WHEN v_rule IS NULL THEN false
           ELSE public.is_weekly_off(v_rule, d, p_employee_id) END, false);

    v_counted := CASE
                   WHEN v_is_hol THEN
                     CASE WHEN lt.id IS NULL THEN false
                          ELSE (lt.count_holiday_as_leave OR lt.sandwich_holidays) END
                   WHEN v_is_off THEN
                     CASE WHEN lt.id IS NULL THEN false
                          ELSE (lt.count_weekly_off_as_leave OR lt.sandwich_holidays) END
                   ELSE true
                 END;

    leave_date     := d;
    is_weekly_off  := v_is_off;
    is_holiday     := v_is_hol;
    holiday_name   := v_hol;
    would_count    := v_counted;
    -- Portion is deliberately not modelled: the engine only honours a half day when
    -- from = to, and the screen applies that itself. A full day here, zero when free.
    day_value      := CASE WHEN v_counted THEN 1.000 ELSE 0.000 END;
    type_dependent := lt.id IS NULL AND (v_is_hol OR v_is_off);
    RETURN NEXT;

    d := d + 1;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_countable_dates(uuid, date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_countable_dates(uuid, date, date, uuid) TO authenticated;

COMMENT ON FUNCTION public.leave_countable_dates(uuid, date, date, uuid) IS
  'Read-only mirror of rebuild_leave_request_days for a range nobody has committed to yet: '
  'resolve_policy for rota and calendar, the same active/non-optional/department/location '
  'holiday filter, and the same count_holiday_as_leave / count_weekly_off_as_leave / '
  'sandwich_holidays rules. Advisory — calc_leave_days still stamps total_days on the real '
  'request. p_leave_type_id NULL gives the plain reading and flags the affected days as '
  'type_dependent, for painting a calendar before a type is chosen. Scoped by '
  'app.can_see_employee.';

COMMIT;
