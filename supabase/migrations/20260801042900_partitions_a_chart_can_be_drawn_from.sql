-- =============================================================================
-- 20260801042900 — the three partitions the charts could not honestly draw
-- =============================================================================
--
-- ASKED FOR: draw the three charts that were declined.
--
-- Each was declined for the same reason, found by reading this schema rather
-- than by looking at the screen: THE NUMBERS BEING CHARTED DO NOT PARTITION
-- ANYTHING. A stacked bar, a donut and a day-run all assert "these pieces are
-- the whole and none of them overlap", and in all three cases that was false.
-- Drawing them anyway would have put a confident picture of a wrong fact in
-- front of employees and managers.
--
-- So this migration supplies what was missing. The charts follow in the client;
-- what changes here is that they become true.
--
-- ── 1. THE TODAY BOARD OVERLAPS ITSELF, AND A TILE IS ALREADY WRONG ─────────
--
-- `v_attendance_today_board` exposes six booleans. `off_today` is a STATUS test
-- (weekly_off, holiday, on_leave, on_leave_half, comp_off_availed) while
-- `overdue` is
--
--     is_working_day AND punch_count = 0 AND shift_start_at IS NOT NULL
--     AND now() >= shift_start + grace
--
-- and `attendance_days.is_working_day` is GENERATED as
-- `NOT is_holiday AND NOT is_weekly_off AND status NOT IN ('not_yet_joined',
-- 'post_exit')`. Approved leave is not in that exclusion list, and the engine
-- writes `shift_start_at` on a leave day regardless.
--
-- So somebody on approved leave on an ordinary Tuesday is `off_today` AND, the
-- moment grace expires, `overdue`. That is not only a charting problem — the
-- OVERDUE TILE ON /team AND ON THE ADMIN CONSOLE HAS BEEN COUNTING PEOPLE ON
-- LEAVE AS MISSING, every day, since the board was written. A manager chasing
-- that list has been ringing people who filed leave weeks ago.
--
-- `board_state` is one exclusive value per person, in the order a human triages:
-- someone who scanned is IN whatever else is true of them; someone on leave is
-- OFF and cannot also be missing. The booleans are left exactly as they are so
-- nothing that reads them breaks; the tiles can move to `board_state` one at a
-- time, and the ones that do stop lying.
--
-- ── 2. A MONTH'S DAY TYPES ARE A CATALOGUE, NOT A PARTITION ────────────────
--
-- `f_attendance_period_summary` returns present_days, weekly_off_days,
-- holiday_days, leave_days, half_days, absent_days… and they overlap by design:
-- `present_days` counts weekly_off_worked and holiday_worked, while
-- `weekly_off_days` counts the is_weekly_off FLAG. A day somebody worked on
-- their weekly off is in both. `half_days` and `leave_days` overlap the same
-- way. Those columns answer "how many days had this property", which is a fine
-- question and not a division of the month.
--
-- `attendance_days.status` IS a partition — one enum value per day, by
-- construction. `f_attendance_status_mix` counts it, and a bar over the result
-- is a true division of the month because the database says so.
--
-- ── 3. A ROW'S DAY RUN CANNOT COME FROM THE FILTERED LIST ──────────────────
--
-- The team day query is SLICE-FILTERED — choose "late" and it returns only late
-- days — and capped at 1200 rows. A gap in a bar drawn from it would mean "no
-- record", "filtered out" or "truncated", and the reader cannot tell which. The
-- first is a fact about the employee; the other two are facts about the query.
--
-- `f_team_day_fractions` answers the narrow question a day-run needs: for these
-- employees, over this window, one row per day that HAS a record. Unfiltered,
-- and bounded by the employees asked for rather than by a row cap, so an absent
-- row means exactly one thing.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042900: an exclusive board_state, a true status partition for a month, and an unfiltered day series — so three charts can be drawn without asserting something false', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. board_state — exactly one bucket per person on the board
-- -----------------------------------------------------------------------------
--
-- Appended as the LAST column: `CREATE OR REPLACE VIEW` may add columns at the
-- end and may not reorder or retype the existing ones, so every column above is
-- reproduced verbatim from 039200. Changing one of them here would drop the
-- view, and dropping it would take every dependent policy and grant with it.

CREATE OR REPLACE VIEW public.v_attendance_today_board AS
SELECT e.id AS employee_id,
    e.employee_code,
    e.display_name,
    e.photo_path,
    e.department_id,
    d.name AS department_name,
    util.ist_today() AS ist_date,
    ad.id AS attendance_day_id,
    COALESCE(ad.status, 'pending'::attendance_status) AS status,
    COALESCE(ad.shift_id, e.shift_id) AS shift_id,
    sh.code AS shift_code,
    sh.display_label AS shift_display_label,
    ad.shift_start_at,
    ad.shift_start_at + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10)) AS expected_by,
    ad.first_in_at,
    to_char(util.ist_ts(ad.first_in_at), 'HH24:MI'::text) AS first_in_hm,
    ad.last_out_at,
    to_char(util.ist_ts(ad.last_out_at), 'HH24:MI'::text) AS last_out_hm,
    COALESCE(ad.punch_count, 0) AS punch_count,
    COALESCE(ad.total_worked_minutes, 0) AS worked_minutes,
    fn_minutes_hm(COALESCE(ad.total_worked_minutes, 0)) AS worked_hm,
    COALESCE(ad.is_late, false) AS is_late,
    COALESCE(ad.late_minutes, 0) AS late_minutes,
    COALESCE(wp.web_punch_count, 0) AS web_punch_count,
    (COALESCE(ad.status, 'pending'::attendance_status) = ANY (ARRAY['present'::attendance_status, 'half_day'::attendance_status, 'weekly_off_worked'::attendance_status, 'holiday_worked'::attendance_status, 'on_duty'::attendance_status, 'work_from_home'::attendance_status])) AND COALESCE(ad.punch_count, 0) > 0 AS attended,
    COALESCE(ad.status, 'pending'::attendance_status) = ANY (ARRAY['weekly_off'::attendance_status, 'holiday'::attendance_status, 'on_leave'::attendance_status, 'on_leave_half'::attendance_status, 'comp_off_availed'::attendance_status]) AS off_today,
    COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0 AND ad.shift_start_at IS NOT NULL AND now() < (ad.shift_start_at + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10))) AS yet_to_reach,
    COALESCE(ad.is_late, false) AS late_in,
    COALESCE(ad.punch_count, 0) > 0 AND NOT COALESCE(ad.is_late, false) AS on_time,
    COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0 AND ad.shift_start_at IS NOT NULL AND now() >= (ad.shift_start_at + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10))) AS overdue,
    ad.overtime_minutes,
    ad.approved_overtime_minutes,
    ad.extra_work_minutes,
    ad.early_exit_minutes,
    /*
      ONE bucket per person, first match wins, in the order a human triages a
      board. The order carries the judgements:

        · IN beats everything. Somebody who scanned is present whether they were
          late, whether it was their weekly off, whatever else is true.
        · OFF beats MISSING, and this is the fix. A person on approved leave was
          being counted as overdue; leave is a reason to be absent, not a
          failure to arrive.
        · NO_SHIFT is its own bucket rather than being folded into missing. No
          `shift_start_at` means nobody rostered them, which is a rota problem
          and not something to ring the employee about.
        · UNKNOWN is the honest remainder — a row the five rules above do not
          describe. Kept visible so that if it ever fills up, the gap in the
          rules is on screen rather than silently absorbed into another bucket.
    */
    CASE
      WHEN (COALESCE(ad.status, 'pending'::attendance_status) = ANY (ARRAY['present'::attendance_status, 'half_day'::attendance_status, 'weekly_off_worked'::attendance_status, 'holiday_worked'::attendance_status, 'on_duty'::attendance_status, 'work_from_home'::attendance_status]))
           AND COALESCE(ad.punch_count, 0) > 0
        THEN 'in'
      WHEN COALESCE(ad.status, 'pending'::attendance_status) = ANY (ARRAY['weekly_off'::attendance_status, 'holiday'::attendance_status, 'on_leave'::attendance_status, 'on_leave_half'::attendance_status, 'comp_off_availed'::attendance_status])
        THEN 'off'
      WHEN COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0 AND ad.shift_start_at IS NULL
        THEN 'no_shift'
      WHEN COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0
           AND now() < (ad.shift_start_at + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10)))
        THEN 'yet_to_reach'
      WHEN COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0
           AND now() >= (ad.shift_start_at + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10)))
        THEN 'missing'
      ELSE 'unknown'
    END AS board_state
   FROM employees e
     LEFT JOIN attendance_days ad ON ad.employee_id = e.id AND ad.ist_date = util.ist_today()
     LEFT JOIN shifts sh ON sh.id = COALESCE(ad.shift_id, e.shift_id)
     LEFT JOIN attendance_policies pol ON pol.id = COALESCE(ad.attendance_policy_id, e.attendance_policy_id)
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS web_punch_count
           FROM attendance_punches p
          WHERE p.employee_id = e.id AND p.effective_date = util.ist_today() AND NOT p.is_voided AND (p.source = ANY (ARRAY['web'::punch_source, 'mobile'::punch_source]))) wp ON true
  WHERE e.deleted_at IS NULL AND (e.employment_status = ANY (ARRAY['active'::employment_status, 'confirmed'::employment_status, 'on_probation'::employment_status, 'on_notice'::employment_status])) AND NOT e.exclude_from_attendance AND app.can_see_employee(e.id);

COMMENT ON COLUMN public.v_attendance_today_board.board_state IS
  'Exactly one of in | off | no_shift | yet_to_reach | missing | unknown. The six booleans beside it OVERLAP — a person on approved leave is both off_today and overdue, because is_working_day does not exclude leave — so only this column may be summed, counted into a chart, or trusted for "how many are missing".';

-- -----------------------------------------------------------------------------
-- 2. The month, divided by the one column that divides it
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f_attendance_status_mix(
  p_employee_id uuid,
  p_from        date,
  p_to          date
)
RETURNS TABLE (status text, days integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  /*
    SECURITY INVOKER, so `attendance_days`' own RLS decides whose days these are
    — the caller cannot read a month belonging to somebody they may not see, and
    this function grants nothing the tables do not already.

    COUNT of rows, not a SUM of fractions: the question is "how many days of the
    month were of each kind", and each day is exactly one kind. A half day is one
    day whose status is half_day, which is why the total always reconciles with
    the number of days that have a record.
  */
  SELECT ad.status::text AS status, count(*)::integer AS days
    FROM public.attendance_days ad
   WHERE ad.employee_id = p_employee_id
     AND ad.ist_date BETWEEN p_from AND p_to
   GROUP BY ad.status
   ORDER BY count(*) DESC, ad.status::text;
$$;

REVOKE EXECUTE ON FUNCTION public.f_attendance_status_mix(uuid, date, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.f_attendance_status_mix(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.f_attendance_status_mix(uuid, date, date) IS
  'One row per attendance status in the window, with the number of days. A TRUE partition of the days that have a record — unlike f_attendance_period_summary, whose present_days/weekly_off_days/leave_days deliberately overlap and must never be stacked.';

-- -----------------------------------------------------------------------------
-- 3. A day series a bar chart can trust
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f_team_day_fractions(
  p_employee_ids uuid[],
  p_from         date,
  p_to           date
)
RETURNS TABLE (
  employee_id       uuid,
  ist_date          date,
  status            text,
  day_fraction_paid numeric,
  worked_minutes    integer
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  /*
    NO SLICE, NO CAP. The team day list is filtered by whichever slice the screen
    is showing and capped at 1200 rows, so a missing day there might mean the
    person was not late rather than that nothing was recorded. A chart cannot
    tell those apart, and a gap that means three different things is worse than
    no chart.

    Bounded by the employees ASKED FOR instead: the caller passes the page of
    people it is drawing, so the result is proportional to what is on screen. RLS
    on `attendance_days` still decides which of them the caller may actually see,
    and an employee they may not see simply returns no rows.
  */
  SELECT ad.employee_id,
         ad.ist_date,
         ad.status::text,
         ad.day_fraction_paid,
         COALESCE(ad.total_worked_minutes, 0)::integer
    FROM public.attendance_days ad
   WHERE ad.employee_id = ANY (p_employee_ids)
     AND ad.ist_date BETWEEN p_from AND p_to
   ORDER BY ad.employee_id, ad.ist_date;
$$;

REVOKE EXECUTE ON FUNCTION public.f_team_day_fractions(uuid[], date, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.f_team_day_fractions(uuid[], date, date) TO authenticated;

COMMENT ON FUNCTION public.f_team_day_fractions(uuid[], date, date) IS
  'One row per employee per day that HAS an attendance record, unfiltered by any slice and uncapped, for the employees passed in. A date with no row means no record — the only reading a day-run chart can safely give a gap.';

COMMIT;
