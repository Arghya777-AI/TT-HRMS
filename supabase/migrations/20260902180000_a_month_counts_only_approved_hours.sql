-- ============================================================================
-- STEP 5: a monthly total contains only approved hours.
--
-- `pending_approval_minutes` is the part of a day that came from a web punch taken
-- outside the shift window and not yet accepted by an administrator. The venue's
-- rule, chosen deliberately over counting it provisionally, is that the DAY shows the
-- full figure with a star and the MONTH shows only approved time.
--
-- ── SUBTRACTED, NOT ADDED AS A COLUMN ──────────────────────────────────────
-- Three views depend on this function — `v_attendance_period_summary`,
-- `v_ai_context_employee_self` and `v_ai_context_team`. Adding a fourth worked column
-- changes the return type, which CREATE OR REPLACE refuses; it would mean dropping and
-- recreating all three, on a live system, to add a number nobody asked for.
--
-- Changing what `total_worked_minutes` MEANS is also the requirement rather than a
-- workaround: this figure IS the monthly total, and the instruction was that
-- unapproved hours do not belong in it. Both averages follow from the same subtraction,
-- because an average taken over hours that are not counted describes a month that did
-- not happen.
--
-- ── NOTHING CHANGES TODAY ──────────────────────────────────────────────────
-- `pending_approval_minutes` is 0 on all 6,390 existing day rows, so every figure this
-- function returns is identical until somebody's off-hours punch is actually held.
-- Generated from `pg_get_functiondef` and diffed: three expressions replaced, nothing
-- else in the function touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.f_attendance_period_summary(p_from date, p_to date, p_employee_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(employee_id uuid, from_date date, to_date date, total_days integer, present_days integer, half_days integer, absent_days integer, pending_days integer, weekly_off_days integer, holiday_days integer, leave_days numeric, comp_off_days integer, paid_days numeric, working_days integer, late_days integer, late_minutes integer, early_exit_days integer, early_exit_minutes integer, overtime_minutes integer, approved_overtime_minutes integer, extra_work_minutes integer, total_worked_minutes integer, avg_worked_minutes_per_present_day numeric, avg_worked_minutes_per_working_day numeric, late_pct numeric, attendance_pct numeric, late_deduction_leave_days numeric, break_minutes integer, break_count integer, avg_breaks_per_present_day numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    ad.employee_id,
    p_from                                                            AS from_date,
    p_to                                                              AS to_date,
    (p_to - p_from) + 1                                               AS total_days,
    COUNT(*) FILTER (WHERE ad.status IN
      ('present','weekly_off_worked','holiday_worked','on_duty','work_from_home'))::integer
                                                                      AS present_days,
    COUNT(*) FILTER (WHERE ad.status = 'half_day')::integer           AS half_days,
    COUNT(*) FILTER (WHERE ad.status = 'absent')::integer             AS absent_days,
    COUNT(*) FILTER (WHERE ad.status = 'pending')::integer            AS pending_days,
    COUNT(*) FILTER (WHERE ad.is_weekly_off)::integer                 AS weekly_off_days,
    COUNT(*) FILTER (WHERE ad.is_holiday)::integer                    AS holiday_days,
    COALESCE(SUM(ad.leave_day_fraction), 0)                           AS leave_days,
    COUNT(*) FILTER (WHERE ad.status = 'comp_off_availed')::integer   AS comp_off_days,
    COALESCE(SUM(ad.day_fraction_paid), 0)                            AS paid_days,
    COUNT(*) FILTER (WHERE ad.is_working_day)::integer                AS working_days,
    COUNT(*) FILTER (WHERE ad.is_late)::integer                       AS late_days,
    COALESCE(SUM(ad.late_minutes) FILTER (WHERE ad.is_late), 0)::integer
                                                                      AS late_minutes,
    COUNT(*) FILTER (WHERE ad.is_early_exit)::integer                 AS early_exit_days,
    COALESCE(SUM(ad.early_exit_minutes) FILTER (WHERE ad.is_early_exit), 0)::integer
                                                                      AS early_exit_minutes,
    COALESCE(SUM(ad.overtime_minutes), 0)::integer                    AS overtime_minutes,
    COALESCE(SUM(ad.approved_overtime_minutes), 0)::integer           AS approved_overtime_minutes,
    COALESCE(SUM(ad.extra_work_minutes), 0)::integer                  AS extra_work_minutes,
    /*
      ── UNAPPROVED HOURS ARE NOT IN A MONTHLY TOTAL ──────────────────────────
      `pending_approval_minutes` is the part of a day that came from a web punch taken
      outside the shift window and not yet accepted by an administrator. The venue's rule,
      chosen over counting it provisionally, is that the DAY shows the full figure with a
      star and the MONTH shows only approved time — so payroll never sees hours nobody has
      agreed to.

      Subtracted here rather than exposed as a fourth column on purpose: three views depend
      on this function (`v_attendance_period_summary`, `v_ai_context_employee_self`,
      `v_ai_context_team`), and adding a column changes the return type, which cannot be done
      with CREATE OR REPLACE — it would mean dropping and recreating all three. Changing what
      the total MEANS is also what was asked for: this figure is the monthly total.

      The two averages follow from the same subtraction. An average worked over hours that are
      not counted would describe a month that did not happen.
    */
    COALESCE(SUM(ad.total_worked_minutes - ad.pending_approval_minutes), 0)::integer
                                                                      AS total_worked_minutes,
    ROUND(SUM(ad.total_worked_minutes - ad.pending_approval_minutes)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2)
                                                                      AS avg_worked_minutes_per_present_day,
    ROUND(SUM(ad.total_worked_minutes - ad.pending_approval_minutes)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ad.is_working_day), 0), 2)
                                                                      AS avg_worked_minutes_per_working_day,
    public.fn_late_pct(
      COUNT(*) FILTER (WHERE ad.is_late)::integer,
      COUNT(*) FILTER (WHERE ad.is_working_day)::integer)             AS late_pct,
    ROUND(COALESCE(SUM(ad.day_fraction_paid), 0) * 100.0
          / NULLIF((p_to - p_from) + 1, 0), 2)                        AS attendance_pct,
    COALESCE(SUM(ad.late_deduction_leave_days), 0)                    AS late_deduction_leave_days,
    COALESCE(SUM(ad.break_minutes), 0)::integer                       AS break_minutes,
    COALESCE(SUM(ad.break_count), 0)::integer                         AS break_count,
    ROUND(SUM(ad.break_count)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2)
                                                                      AS avg_breaks_per_present_day
  FROM public.attendance_days ad
  WHERE ad.ist_date BETWEEN p_from AND p_to
    AND (p_employee_id IS NULL OR ad.employee_id = p_employee_id)
  GROUP BY ad.employee_id;
$function$;
