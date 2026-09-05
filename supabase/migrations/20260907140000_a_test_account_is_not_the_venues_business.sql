/*
  A TEST ACCOUNT IS NOT THE VENUE'S BUSINESS.

  Handover. Two accounts exist only to exercise the system and must stop appearing on
  administrators' screens: TT0013 Arghya Ghosh and TT0001 Arjun Nair.

  ── WHAT WAS ALREADY TRUE ───────────────────────────────────────────────────────────────────
  TT0001 is already invisible: soft-deleted on 31 Jul, and a sweep of all 32 views exposing
  `employee_id` returns zero rows for him. He has no attendance, no leave, no approvals. Only
  five inactive face templates remain, retired at the end of this migration.

  TT0013 is the live problem. He ALREADY carries `exclude_from_attendance` and
  `exclude_from_leave_tracking` — and still appears in six views, because nothing reads those
  flags. He shows on the org leave calendar (the 5 Sep popup lists him twice), in the day
  roster, and in three reporting views.

  ── WHY NOT SIMPLY FILTER ON THE EXCLUSION FLAGS ────────────────────────────────────────────
  Because they do not mean "test account". Three real managers carry them too — TT0002 Suraj
  Kumar, TT0017 Vinod Maurya, TT0019 Preethi Machani — and five of the six views are read by
  the employee's OWN screens as well as the console. Filtering on `exclude_from_attendance`
  would blank those three managers' own leave balances and attendance summaries. That is a
  regression for real people, dressed up as a fix.

  So the flag says what is actually meant: `is_test_account`.

  ── AND WHY THE READER IS PART OF THE PREDICATE ─────────────────────────────────────────────
  A test account whose own screens are empty cannot be used to test anything, and these two
  are kept precisely to go on testing with. `app.is_hidden_test_account` therefore hides the
  row from EVERYONE EXCEPT THE PERSON THEMSELF. Administrators stop seeing Arghya's history;
  Arghya signed in as Arghya still sees all of it.

  Nothing is deleted. Every attendance day, punch, leave request and ledger entry stays
  exactly where it is — clearing the flag brings the person back in full. `attendance_days`
  refuses deletion anyway (`trg_attendance_days__no_delete` → `audit.refuse_mutation`, which
  unlike the punch guard has no escape hatch), and defeating an audit guarantee on the eve of
  handover to tidy a screen would be the wrong trade.

  ── COST ────────────────────────────────────────────────────────────────────────────────────
  The predicate is a per-row STABLE call doing one primary-key lookup. At this venue's scale
  (6,640 attendance days, 46 leave request days, 822 ledger rows) that is not measurable, and
  every one of these views is read behind a date or employee filter. If either table grows by
  orders of magnitude, move the predicate into the joins instead.
*/

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The flag, and who carries it.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
/*
  `audit.log_changes()` refuses an UPDATE on `employees` without `app.reason` of at least ten
  characters, and it is right to: every change to a person's record carries a stated reason
  into the audit log. A migration is not exempt from that, so it says why.
*/
SELECT set_config('app.reason',
                  'Handover: test accounts hidden from administrator screens', false);

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS is_test_account boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.employees.is_test_account IS
  'Exists only to exercise the system. Hidden from every administrator screen; still fully '
  'visible to the account itself so it can go on being tested with. Not a soft delete: no row '
  'is removed and clearing the flag restores the person everywhere.';

UPDATE public.employees SET is_test_account = true
 WHERE employee_code IN ('TT0013', 'TT0001');

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The predicate. One definition, six callers.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.is_hidden_test_account(p_employee_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  /*
    SECURITY DEFINER because the views it guards are `security_invoker = true`: an ordinary
    reader must be able to evaluate "is this a test account" for a row they can otherwise see,
    without being granted a general read of `employees`.

    COALESCE to false: an employee_id with no matching row is not a test account, and a NULL
    here would make `NOT (...)` NULL and silently drop a legitimate row from every view.
  */
  SELECT COALESCE(
    (SELECT e.is_test_account AND e.id IS DISTINCT FROM app.current_employee_id()
       FROM public.employees e
      WHERE e.id = p_employee_id),
    false);
$function$;

GRANT EXECUTE ON FUNCTION app.is_hidden_test_account(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. The six views that still showed them. Bodies are the live definitions, predicate appended.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
/* Plain SET, not SET LOCAL: the view bodies below are the live definitions and carry
   unqualified table names, and SET LOCAL is a no-op outside an explicit transaction block. */
SET search_path = public, pg_catalog;

CREATE OR REPLACE VIEW public.v_attendance_day_enriched
WITH (security_invoker = true) AS
SELECT ad.id,
    ad.employee_id,
    er.employee_code,
    er.display_name,
    er.photo_path,
    ad.ist_date,
    ad.status,
    ad.status_source,
    d.name AS department_name,
    er.section_name,
    dg.name AS designation_name,
    l.name AS location_name,
    ad.shift_id,
    sh.code AS shift_code,
    sh.display_label AS shift_display_label,
    ad.shift_start_at,
    ad.shift_end_at,
    ad.shift_duration_minutes,
    ad.manager_id,
    mgr.display_name AS manager_name,
    ad.holiday_id,
    h.name AS holiday_name,
    ad.leave_type_id,
    lt.code AS leave_type_code,
    lt.name AS leave_type_name,
    ad.leave_request_id,
    ad.leave_day_fraction,
    ad.first_in_at,
    ad.last_out_at,
    to_char(util.ist_ts(ad.first_in_at), 'HH24:MI'::text) AS first_in_hm,
    to_char(util.ist_ts(ad.last_out_at), 'HH24:MI'::text) AS last_out_hm,
    ad.punch_count,
    ad.gross_span_minutes,
    ad.break_minutes,
    ad.break_count,
    ad.total_worked_minutes,
    ad.payable_worked_minutes,
    fn_minutes_hm(ad.total_worked_minutes) AS worked_hm,
    ad.is_late,
    ad.late_minutes,
    fn_minutes_hm(ad.late_minutes) AS late_hm,
    ad.is_early_exit,
    ad.early_exit_minutes,
    ad.overtime_minutes,
    ad.approved_overtime_minutes,
    ad.extra_work_minutes,
    ad.day_fraction_paid,
    ad.late_deduction_leave_days,
    ad.is_holiday,
    ad.is_weekly_off,
    ad.is_working_day,
    ad.manual_override_status,
    ad.manual_override_times,
    ad.manual_override_reason,
    ad.regularization_id IS NOT NULL AS is_regularized,
    ad.regularization_id,
    ad.anomaly_flags,
    cardinality(ad.anomaly_flags) > 0 AS has_anomalies,
    ad.is_locked,
    ad.computed_at,
    ad.computed_version
   FROM attendance_days ad
     LEFT JOIN v_employee_ref er ON er.id = ad.employee_id
     LEFT JOIN departments d ON d.id = ad.department_id
     LEFT JOIN designations dg ON dg.id = ad.designation_id
     LEFT JOIN locations l ON l.id = ad.location_id
     LEFT JOIN shifts sh ON sh.id = ad.shift_id
     LEFT JOIN v_employee_ref mgr ON mgr.id = ad.manager_id
     LEFT JOIN holidays h ON h.id = ad.holiday_id
     LEFT JOIN leave_types lt ON lt.id = ad.leave_type_id
  WHERE NOT app.is_hidden_test_account(ad.employee_id);

CREATE OR REPLACE VIEW public.v_attendance_in_trend
WITH (security_invoker = true) AS
SELECT employee_id,
    ist_date,
    EXTRACT(hour FROM util.ist_time(first_in_at))::integer * 60 + EXTRACT(minute FROM util.ist_time(first_in_at))::integer AS first_in_minutes,
    to_char(util.ist_ts(first_in_at), 'HH24:MI'::text) AS first_in_hm,
    is_late,
    late_minutes
   FROM attendance_days ad
  WHERE first_in_at IS NOT NULL
    AND NOT app.is_hidden_test_account(ad.employee_id);

CREATE OR REPLACE VIEW public.v_attendance_period_summary
WITH (security_invoker = true) AS
SELECT employee_id,
    from_date,
    to_date,
    total_days,
    present_days,
    half_days,
    absent_days,
    pending_days,
    weekly_off_days,
    holiday_days,
    leave_days,
    comp_off_days,
    paid_days,
    working_days,
    late_days,
    late_minutes,
    early_exit_days,
    early_exit_minutes,
    overtime_minutes,
    approved_overtime_minutes,
    extra_work_minutes,
    total_worked_minutes,
    avg_worked_minutes_per_present_day,
    avg_worked_minutes_per_working_day,
    late_pct,
    attendance_pct,
    late_deduction_leave_days,
    break_minutes,
    break_count,
    avg_breaks_per_present_day
   FROM f_attendance_period_summary(date_trunc('month'::text, util.ist_today()::timestamp with time zone)::date, util.ist_today()) f_attendance_period_summary(employee_id, from_date, to_date, total_days, present_days, half_days, absent_days, pending_days, weekly_off_days, holiday_days, leave_days, comp_off_days, paid_days, working_days, late_days, late_minutes, early_exit_days, early_exit_minutes, overtime_minutes, approved_overtime_minutes, extra_work_minutes, total_worked_minutes, avg_worked_minutes_per_present_day, avg_worked_minutes_per_working_day, late_pct, attendance_pct, late_deduction_leave_days, break_minutes, break_count, avg_breaks_per_present_day)
  WHERE NOT app.is_hidden_test_account(employee_id);

CREATE OR REPLACE VIEW public.v_leave_balance_current
WITH (security_invoker = true) AS
SELECT lb.employee_id,
    lb.leave_type_id,
    lt.code AS leave_type_code,
    lt.name AS leave_type_name,
    lt.colour_hex,
    lt.is_paid,
    lt.is_comp_off,
    lt.allow_half_day,
    lb.leave_year,
    lb.opening_days,
    lb.accrued_days,
    lb.carried_forward_days,
    lb.adjusted_days,
    lb.opening_days + lb.accrued_days + lb.carried_forward_days + lb.adjusted_days AS entitlement_days,
    lb.availed_days,
    lb.pending_days,
    lb.encashed_days,
    lb.lapsed_days,
    lb.available_days,
    lb.available_after_pending,
    COALESCE(exp30.expiring_soon_days, 0::numeric) AS expiring_soon_days,
    exp30.nearest_expiry,
    lb.last_recomputed_at,
    lt.is_active AS leave_type_active,
    COALESCE(acc.days_this_month, 0::numeric) AS accrued_this_month_days
   FROM leave_balances lb
     JOIN leave_types lt ON lt.id = lb.leave_type_id AND lt.deleted_at IS NULL
     JOIN employees e ON e.id = lb.employee_id AND e.deleted_at IS NULL
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(COALESCE(col.days_remaining, col.days)), 0::numeric) AS expiring_soon_days,
            min(col.expires_on) AS nearest_expiry
           FROM comp_off_ledger col
          WHERE lt.is_comp_off AND col.employee_id = lb.employee_id AND col.entry_type = 'earned'::text AND (col.status = ANY (ARRAY['available'::text, 'partially_used'::text])) AND col.expires_on IS NOT NULL AND col.expires_on >= util.ist_today() AND col.expires_on <= (util.ist_today() + 30)) exp30 ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(ll.days), 0::numeric) AS days_this_month
           FROM leave_ledger ll
          WHERE ll.employee_id = lb.employee_id AND ll.leave_type_id = lb.leave_type_id AND ll.leave_year = lb.leave_year AND (ll.entry_type = ANY (ARRAY['accrual'::ledger_entry_type, 'pro_rata_accrual'::ledger_entry_type])) AND ll.reversed_by_id IS NULL AND date_trunc('month'::text, ll.effective_date::timestamp without time zone) = date_trunc('month'::text, util.ist_today()::timestamp without time zone)) acc ON true
  WHERE lb.leave_year = leave_year_of(util.ist_today())
    AND NOT app.is_hidden_test_account(lb.employee_id);

CREATE OR REPLACE VIEW public.v_leave_calendar
WITH (security_invoker = true) AS
SELECT lrd.id AS leave_request_day_id,
    lr.id AS leave_request_id,
    lr.request_number,
    lr.employee_id,
    er.employee_code,
    er.display_name,
    er.photo_path,
    er.department_id,
    er.department_name,
    lrd.leave_date,
    lrd.portion,
    lrd.day_value,
    lr.leave_type_id,
    lt.code AS leave_type_code,
    lt.name AS leave_type_name,
    lt.colour_hex,
    lr.status
   FROM leave_request_days lrd
     JOIN leave_requests lr ON lr.id = lrd.leave_request_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN v_employee_ref er ON er.id = lr.employee_id
  WHERE (lr.status = ANY (ARRAY['pending'::leave_request_status, 'approved'::leave_request_status, 'partially_approved'::leave_request_status, 'cancellation_pending'::leave_request_status])) AND lrd.is_counted
    AND NOT app.is_hidden_test_account(lr.employee_id);

CREATE OR REPLACE VIEW public.v_leave_ledger_statement
WITH (security_invoker = true) AS
SELECT ll.id,
    ll.employee_id,
    ll.leave_type_id,
    lt.code AS leave_type_code,
    lt.name AS leave_type_name,
    ll.leave_year,
    ll.effective_date,
    ll.entry_type,
    ll.days,
    ll.balance_after,
    ll.description,
    ll.reason,
    ll.leave_request_id,
    ll.attendance_day_id,
    ll.comp_off_ledger_id,
    ll.payroll_run_id,
    ll.reversed_by_id IS NOT NULL AS is_reversed,
    ll.reverses_id IS NOT NULL AS is_reversal,
    ll.recorded_at,
    to_char(util.ist_ts(ll.recorded_at), 'DD Mon YYYY HH24:MI'::text) AS recorded_at_ist
   FROM leave_ledger ll
     JOIN leave_types lt ON lt.id = ll.leave_type_id
     JOIN employees e ON e.id = ll.employee_id AND e.deleted_at IS NULL
  WHERE NOT app.is_hidden_test_account(ll.employee_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. TT0001's five face templates, retired.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
/*
  `purged_at` is the schema's own retirement, and it is what the duplicate scan and the matcher
  filter on — a purged template cannot match anybody or block anybody's enrolment. The rows are
  not DELETEd: `descriptor` is NOT NULL so it cannot be blanked in place, and
  `secure.face_template_history` holds a foreign key to them. Marking is the supported path and
  it is reversible; shredding the bytes is a separate, explicit decision.
*/
UPDATE secure.face_templates
   SET is_active           = false,
       deactivated_at      = COALESCE(deactivated_at, now()),
       deactivation_reason = COALESCE(deactivation_reason, 'test account retired at handover'),
       purged_at           = COALESCE(purged_at, now())
 WHERE employee_id = (SELECT id FROM public.employees WHERE employee_code = 'TT0001')
   AND purged_at IS NULL;
