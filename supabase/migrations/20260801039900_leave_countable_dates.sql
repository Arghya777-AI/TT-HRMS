-- ============================================================================
-- 20260801039900_leave_countable_dates.sql
--
-- WHICH DATES IN A RANGE WOULD ACTUALLY COST THIS EMPLOYEE LEAVE.
--
-- The apply screen needs a from–to range and has to show what it counts, because
-- "3 days" over a Saturday–Monday is not three days of leave for somebody whose
-- weekly off is Sunday. Until now the screen had a single start date and sent
-- `to_date = from_date`, which meant a three-day allocation filed one-day requests.
-- That is the bug this exists to fix.
--
-- ── WHY A SERVER FUNCTION AND NOT BROWSER ARITHMETIC ─────────────────────────
-- `calc_leave_days(p_leave_request_id)` is the authority, but it takes an EXISTING
-- request — it cannot answer about a range somebody is still typing. The options
-- were:
--
--   * evaluate the weekly-off rule in the browser — a second implementation of
--     `is_weekly_off`, which handles alternate-Saturday and roster-driven rules, and
--     would disagree with the engine the first time a rule changed;
--   * call `is_weekly_off` once per date — correct but a round trip per day;
--   * ask once, here.
--
-- This uses the SAME `public.is_weekly_off(rule, date, employee)` the attendance
-- engine uses and the same `holidays` rows the calendar shows, so the screen and the
-- engine cannot disagree about which dates count.
--
-- IT IS ADVISORY, NOT AUTHORITATIVE, and the naming says so — it answers "what would
-- count", while `calc_leave_days` still stamps `total_days` on the real request at
-- submit. A screen that treated this as the final answer would be trusting a preview
-- over the record.
--
-- SECURITY. `SECURITY DEFINER` because `is_weekly_off` and the holiday calendar read
-- rows an employee cannot select directly, but the employee argument is checked
-- against `app.can_see_employee` first — so this cannot be used to enumerate
-- somebody else's rota.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.leave_countable_dates(
  p_employee_id uuid,
  p_from        date,
  p_to          date
)
RETURNS TABLE (
  leave_date   date,
  is_weekly_off boolean,
  is_holiday    boolean,
  holiday_name  text,
  would_count   boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rule     uuid;
  v_calendar uuid;
BEGIN
  IF NOT app.can_see_employee(p_employee_id) THEN
    RAISE EXCEPTION 'not permitted: that employee is outside your scope'
      USING errcode = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'the range must start on or before it ends' USING errcode = '22023';
  END IF;
  -- A guard rather than a preference: this is called on every keystroke of a date field,
  -- and a five-year range would evaluate the rota 1,800 times for a screen nobody is
  -- reading yet.
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'a leave range longer than a year cannot be previewed'
      USING errcode = '22023';
  END IF;

  SELECT e.weekly_off_rule_id, e.holiday_calendar_id
    INTO v_rule, v_calendar
  FROM public.employees e
  WHERE e.id = p_employee_id AND e.deleted_at IS NULL;

  RETURN QUERY
  WITH days AS (
    SELECT d::date AS the_date
    FROM generate_series(p_from, p_to, interval '1 day') AS d
  ), marked AS (
    SELECT dy.the_date,
           -- No rule assigned means no weekly off can be asserted. FALSE rather than
           -- NULL: the employee is treated as working, which is what the engine does.
           COALESCE(
             CASE WHEN v_rule IS NULL THEN false
                  ELSE public.is_weekly_off(v_rule, dy.the_date, p_employee_id)
             END, false) AS weekly_off,
           h.name AS hol_name
    FROM days dy
    LEFT JOIN public.holidays h
      ON h.holiday_calendar_id = v_calendar
     AND h.holiday_date = dy.the_date
     AND h.is_active
  )
  SELECT m.the_date,
         m.weekly_off,
         m.hol_name IS NOT NULL,
         m.hol_name,
         NOT m.weekly_off AND m.hol_name IS NULL
  FROM marked m
  ORDER BY m.the_date;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_countable_dates(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_countable_dates(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.leave_countable_dates(uuid, date, date) IS
  'Advisory preview of which dates in a range would cost leave, using the SAME '
  'public.is_weekly_off and holidays rows the attendance engine uses — so the apply screen '
  'and the engine cannot disagree. calc_leave_days still stamps total_days on the real '
  'request; this only answers "what would count" for a range being typed. Scoped by '
  'app.can_see_employee, so it cannot enumerate another employee''s rota.';

COMMIT;
