-- ============================================================================
-- 20260801039200_today_board_overtime.sql
--
-- THE LIVE BOARD COULD NOT SHOW OVERTIME.
--
-- `v_attendance_today_board` carried the shift, the expected-by time, both scan
-- times, the scan count, worked minutes and late-by — and no overtime, so the
-- one number a venue manager asks for at the end of a long banquet shift was the
-- one the board could not answer. `attendance_days` has held it all along
-- (`overtime_minutes`, and its approved and extra-work counterparts); the view
-- simply never selected them.
--
-- FOUR COLUMNS, NOT ONE, because they answer different questions and conflating
-- them is how an overtime figure becomes untrustworthy:
--
--   overtime_minutes           what the engine computed for a normal working day
--   approved_overtime_minutes  what a manager has actually signed off — this, not
--                              the raw figure, is what payroll pays
--   extra_work_minutes         time worked on a weekly off or a holiday, which is
--                              NOT overtime and is what earns comp-off instead
--   early_exit_minutes         the mirror of late_minutes, already on the view
--
-- A screen that showed `overtime_minutes` alone would tell a manager somebody is
-- owed two hours they have not approved, and would show zero against a Sunday
-- that earned a full comp-off day.
--
-- Regenerated from the live definition rather than retyped, so the 30 existing
-- columns, the grace-period COALESCE chain and the `app.can_see_employee` scope
-- predicate are byte-identical to what was deployed. Only the select list grows.
-- ============================================================================

BEGIN;

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
    ad.early_exit_minutes
   FROM employees e
     LEFT JOIN attendance_days ad ON ad.employee_id = e.id AND ad.ist_date = util.ist_today()
     LEFT JOIN shifts sh ON sh.id = COALESCE(ad.shift_id, e.shift_id)
     LEFT JOIN attendance_policies pol ON pol.id = COALESCE(ad.attendance_policy_id, e.attendance_policy_id)
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS web_punch_count
           FROM attendance_punches p
          WHERE p.employee_id = e.id AND p.effective_date = util.ist_today() AND NOT p.is_voided AND (p.source = ANY (ARRAY['web'::punch_source, 'mobile'::punch_source]))) wp ON true
  WHERE e.deleted_at IS NULL AND (e.employment_status = ANY (ARRAY['active'::employment_status, 'confirmed'::employment_status, 'on_probation'::employment_status, 'on_notice'::employment_status])) AND NOT e.exclude_from_attendance AND app.can_see_employee(e.id);

COMMENT ON VIEW public.v_attendance_today_board IS
  'Who is in right now, one row per employee on roll today. Carries overtime, approved '
  'overtime, extra work and early exit since migration 039200 — overtime is the number a '
  'manager asks for at the end of a shift and the board could not answer it.';

COMMIT;
