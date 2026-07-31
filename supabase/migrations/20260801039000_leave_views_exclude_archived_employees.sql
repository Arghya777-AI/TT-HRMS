-- ============================================================================
-- 20260801039000_leave_views_exclude_archived_employees.sql
--
-- THE LEAVE SCREENS WERE MOSTLY SHOWING PEOPLE WHO NO LONGER EXIST.
--
-- Measured on the live project before this migration:
--
--   v_leave_calendar        8 rows,   7 for archived employees
--   v_leave_balance_current 103 rows, 84 for archived employees
--   comp_off_ledger         6 rows,   3 for archived employees
--
-- Every one of them belongs to a soft-deleted demo employee — TT0001 and
-- TT0003..TT0012, TT0014, archived with `deletion_reason = 'cleanup: keeping only
-- 4 venue admins'`. Their `leave_balances` (seven rows each, one per leave type),
-- their `leave_requests` and their `comp_off_ledger` credits all outlived them,
-- because none of these views ever looked at `employees`.
--
-- WHY THEY LEAKED, VIEW BY VIEW.
--
--   * `v_leave_calendar` joined `v_employee_ref` with a LEFT JOIN. `v_employee_ref`
--     does filter `deleted_at IS NULL`, so an archived person's leave day survived
--     the join with every identity column NULL — and the org calendar rendered it
--     as "unknown person" while still counting them into the day's headcount. The
--     grid's numerator was therefore unscoped while its denominator came from the
--     directory, so the two could not agree.
--   * `v_leave_balance_current`, `v_leave_ledger_statement` and
--     `v_comp_off_balance` never referenced `employees` AT ALL. Identity was
--     stitched in the browser from a 500-row label map, so an archived — or merely
--     501st — employee rendered as a blank name beside real numbers.
--
-- THE FIX IS AN INNER JOIN ON A LIVE EMPLOYEE, in every one of them. A leave row
-- whose employee is archived is history, not a screen row: it stays in its table,
-- fully auditable, and simply stops appearing in the balances, the ledger, the
-- calendar and the comp-off tiles. Nothing is deleted here.
--
-- IT ALSO CLOSES THE SCOPE HOLE, which matters more than the tidiness. These views
-- are `security_invoker`, so joining `employees` subjects them to the employee
-- policies: self, manager-of, and scoped-admin. Before this, leave balances and
-- ledger rows had no employee-scope predicate of any kind — a location-scoped
-- admin could read leave figures for employees their directory would never show
-- them. Self and manager access are unaffected: `employees__self_read` and
-- `app.is_manager_of()` both admit the rows their owners already see.
-- ============================================================================

BEGIN;

-- 1 ─ v_leave_balance_current ────────────────────────────────────────────────
-- Column list unchanged; only the employees join is new.
CREATE OR REPLACE VIEW public.v_leave_balance_current
WITH (security_invoker = true) AS
SELECT
  lb.employee_id,
  lb.leave_type_id,
  lt.code            AS leave_type_code,
  lt.name            AS leave_type_name,
  lt.colour_hex,
  lt.is_paid,
  lt.is_comp_off,
  lt.allow_half_day,
  lb.leave_year,
  lb.opening_days,
  lb.accrued_days,
  lb.carried_forward_days,
  lb.adjusted_days,
  (lb.opening_days + lb.accrued_days + lb.carried_forward_days + lb.adjusted_days)
                     AS entitlement_days,
  lb.availed_days,
  lb.pending_days,
  lb.encashed_days,
  lb.lapsed_days,
  lb.available_days,
  lb.available_after_pending,
  COALESCE(exp30.expiring_soon_days, 0) AS expiring_soon_days,
  exp30.nearest_expiry,
  lb.last_recomputed_at
FROM public.leave_balances lb
JOIN public.leave_types lt ON lt.id = lb.leave_type_id
JOIN public.employees   e  ON e.id = lb.employee_id AND e.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(COALESCE(col.days_remaining, col.days)), 0) AS expiring_soon_days,
    MIN(col.expires_on)                                      AS nearest_expiry
  FROM public.comp_off_ledger col
  WHERE lt.is_comp_off
    AND col.employee_id = lb.employee_id
    AND col.entry_type = 'earned'
    AND col.status IN ('available','partially_used')
    AND col.expires_on IS NOT NULL
    AND col.expires_on BETWEEN util.ist_today() AND util.ist_today() + 30
) exp30 ON true
WHERE lb.leave_year = public.leave_year_of(util.ist_today());

COMMENT ON VIEW public.v_leave_balance_current IS
  '§9.3: per employee × type, current leave year. available_days / available_after_pending come '
  'straight from the generated columns — never recomputed in a widget. Archived employees are '
  'excluded (migration 039000): their balances are history, not screen rows.';

-- 2 ─ v_leave_ledger_statement ───────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_leave_ledger_statement
WITH (security_invoker = true) AS
SELECT
  ll.id,
  ll.employee_id,
  ll.leave_type_id,
  lt.code  AS leave_type_code,
  lt.name  AS leave_type_name,
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
  (ll.reversed_by_id IS NOT NULL) AS is_reversed,
  ll.reverses_id IS NOT NULL      AS is_reversal,
  ll.recorded_at,
  to_char(util.ist_ts(ll.recorded_at), 'DD Mon YYYY HH24:MI') AS recorded_at_ist
FROM public.leave_ledger ll
JOIN public.leave_types lt ON lt.id = ll.leave_type_id
JOIN public.employees   e  ON e.id = ll.employee_id AND e.deleted_at IS NULL;

-- 3 ─ v_leave_calendar ───────────────────────────────────────────────────────
-- The LEFT JOIN becomes an INNER JOIN. That is the whole change: `v_employee_ref`
-- already excludes archived and non-active employees, so inner-joining it makes the
-- calendar's rows and the directory's count agree by construction.
CREATE OR REPLACE VIEW public.v_leave_calendar
WITH (security_invoker = true) AS
SELECT
  lrd.id            AS leave_request_day_id,
  lr.id             AS leave_request_id,
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
  lt.code           AS leave_type_code,
  lt.name           AS leave_type_name,
  lt.colour_hex,
  lr.status
FROM public.leave_request_days lrd
JOIN public.leave_requests lr ON lr.id = lrd.leave_request_id
JOIN public.leave_types    lt ON lt.id = lr.leave_type_id
JOIN public.v_employee_ref er ON er.id = lr.employee_id
WHERE lr.status IN ('pending','approved','partially_approved','cancellation_pending')
  AND lrd.is_counted;

COMMENT ON VIEW public.v_leave_calendar IS
  'Leave days for the calendar boards. INNER JOIN on v_employee_ref (migration 039000) — a '
  'LEFT JOIN put archived employees on the grid as "unknown person" and counted them into the '
  'day headcount, so the numerator was unscoped while the denominator was the directory.';

-- 4 ─ v_comp_off_balance ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_comp_off_balance
WITH (security_invoker = true) AS
SELECT
  col.employee_id,
  COALESCE(SUM(COALESCE(col.days_remaining, col.days)), 0) AS available_days,
  MIN(col.expires_on)                                      AS nearest_expiry,
  COALESCE(SUM(COALESCE(col.days_remaining, col.days))
    FILTER (WHERE col.expires_on IS NOT NULL
              AND col.expires_on <= util.ist_today() + 30), 0) AS expiring_within_30_days,
  COUNT(*)::integer                                        AS open_credits
FROM public.comp_off_ledger col
JOIN public.employees e ON e.id = col.employee_id AND e.deleted_at IS NULL
WHERE col.entry_type = 'earned'
  AND col.status IN ('available','partially_used')
  AND (col.expires_on IS NULL OR col.expires_on >= util.ist_today())
GROUP BY col.employee_id;

COMMIT;
