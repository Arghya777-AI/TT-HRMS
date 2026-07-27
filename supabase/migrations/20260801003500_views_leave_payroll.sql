-- =============================================================================
-- Migration 035 — leave & payroll views (§9.3)
-- Source: docs/plan/04-data-model.md §9.2/§9.3; base columns from 019/020/021/022.
--
-- Security:
--   * Leave views run security_invoker=true — leave_balances / leave_ledger /
--     comp_off_ledger / leave_request_days carry scope-read RLS (019).
--   * Payroll views are owner-executed (security_barrier) with explicit
--     predicates: payslips are release-gated (public.payroll_run_is_released,
--     022) and salary revisions are P6 (self + scoped admin, 021). The view
--     predicates reproduce those policies EXACTLY — no wider, no narrower.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. v_leave_balance_current — per employee × type for the CURRENT leave year
--    (§9.2 Leave Balance / Leave Balance (spendable))
-- -----------------------------------------------------------------------------

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
  lb.available_days,                 -- generated column: THE Leave Balance
  lb.available_after_pending,        -- generated column: the spendable balance
  COALESCE(exp30.expiring_soon_days, 0) AS expiring_soon_days,
  exp30.nearest_expiry,
  lb.last_recomputed_at
FROM public.leave_balances lb
JOIN public.leave_types lt ON lt.id = lb.leave_type_id
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
  '§9.3: per employee × type, current leave year. available_days / available_after_pending come straight from the generated columns — never recomputed in a widget.';

-- -----------------------------------------------------------------------------
-- 2. v_leave_ledger_statement — human-readable ledger with running balance
-- -----------------------------------------------------------------------------

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
  ll.balance_after,              -- running balance stamped at insert (019)
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
JOIN public.leave_types lt ON lt.id = ll.leave_type_id;

-- -----------------------------------------------------------------------------
-- 3. v_leave_calendar — team leave calendar for the roster board (§9.3)
-- -----------------------------------------------------------------------------

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
LEFT JOIN public.v_employee_ref er ON er.id = lr.employee_id
WHERE lr.status IN ('pending','approved','partially_approved','cancellation_pending')
  AND lrd.is_counted;

-- -----------------------------------------------------------------------------
-- 4. v_comp_off_balance — available comp-off with nearest expiry (§9.3)
-- -----------------------------------------------------------------------------

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
WHERE col.entry_type = 'earned'
  AND col.status IN ('available','partially_used')
  AND (col.expires_on IS NULL OR col.expires_on >= util.ist_today())
GROUP BY col.employee_id;

-- -----------------------------------------------------------------------------
-- 5. v_payslip_detail — payslip header + lines with labels, calc_basis, YTD
--    (§9.3). Owner-executed; predicate = exactly the 022 policies:
--    self AND run released, OR scoped admin. Draft payroll is never visible.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_payslip_detail
WITH (security_barrier = true) AS
SELECT
  ps.id                AS payslip_id,
  ps.payslip_number,
  ps.employee_id,
  er.employee_code,
  er.display_name,
  er.department_name,
  er.designation_name,
  ps.payroll_run_id,
  pr.run_number,
  pr.status            AS run_status,
  ps.pay_period_id,
  pp.code              AS pay_period_code,
  pp.name              AS pay_period_name,
  ps.period_start, ps.period_end, ps.pay_date, ps.period_days,
  ps.paid_days,        -- THE definition (§9.2): SUM(day_fraction_paid)
  ps.lop_days, ps.present_days, ps.weekly_off_days, ps.holiday_days,
  ps.leave_days_paid, ps.leave_days_unpaid,
  ps.overtime_minutes, ps.extra_work_minutes, ps.late_deduction_days,
  ps.gross_earnings_paise, ps.total_deductions_paise, ps.net_pay_paise,
  ps.net_pay_words,
  ps.employer_contributions_paise, ps.total_ctc_for_period_paise,
  ps.ytd_gross_paise, ps.ytd_deductions_paise, ps.ytd_net_paise, ps.ytd_tds_paise,
  ps.payment_mode, ps.payment_status, ps.payment_reference, ps.paid_on,
  ps.is_reversed, ps.reversed_by_payslip_id,
  ps.pdf_document_id, ps.viewed_at,
  pl.id                AS line_id,
  pl.salary_component_id,
  sc.code              AS component_code,
  pl.label,
  pl.line_kind,
  pl.sequence,
  pl.full_month_amount_paise,
  pl.amount_paise,
  pl.calc_kind,
  pl.calc_basis,       -- THE proof (§3.8)
  pl.ytd_amount_paise,
  pl.is_prorated,
  pl.is_arrear,
  pl.arrear_for_period_id
FROM public.payslips ps
JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
JOIN public.pay_periods  pp ON pp.id = ps.pay_period_id
LEFT JOIN public.payslip_lines pl ON pl.payslip_id = ps.id
LEFT JOIN public.salary_components sc ON sc.id = pl.salary_component_id
LEFT JOIN public.v_employee_ref er ON er.id = ps.employee_id
WHERE (ps.employee_id = app.current_employee_id()
         AND public.payroll_run_is_released(ps.payroll_run_id))
   OR (app.is_admin() AND app.admin_scope_covers(ps.employee_id));

COMMENT ON VIEW public.v_payslip_detail IS
  '§9.3: one row per payslip line, header columns repeated. Self access only once the run is released (mirrors payslips__self__select, 022); admins scoped. Money in integer paise.';

-- -----------------------------------------------------------------------------
-- 6. v_employee_current_salary — latest approved revision + component lines
--    + A/B/C buckets + CTC (§9.2 Monthly CTC). Owner-executed; P6 predicate.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_employee_current_salary
WITH (security_barrier = true) AS
WITH current_rev AS (
  SELECT DISTINCT ON (r.employee_id) r.*
  FROM public.employee_salary_revisions r
  WHERE r.status = 'approved'
    AND r.effective_from <= util.ist_today()
    AND (r.effective_to IS NULL OR r.effective_to >= util.ist_today())
  ORDER BY r.employee_id, r.effective_from DESC, r.revision_number DESC
)
SELECT
  r.employee_id,
  r.id                 AS revision_id,
  r.revision_number,
  r.revision_kind,
  r.effective_from,
  r.salary_structure_id,
  ss.code              AS salary_structure_code,
  r.monthly_gross_paise,
  r.monthly_employer_contribution_paise,
  r.monthly_ctc_paise,          -- §9.2: monthly_gross + monthly_employer_contribution
  r.annual_ctc_paise,
  r.ctc_at_join_paise,
  l.id                 AS line_id,
  l.salary_component_id,
  sc.code              AS component_code,
  sc.name              AS component_name,
  sc.line_kind,
  sc.ctc_bucket,                -- A = gross earnings, B = variable, C = employer
  l.monthly_amount_paise,
  l.annual_amount_paise,
  l.sequence,
  SUM(l.monthly_amount_paise) FILTER (WHERE sc.ctc_bucket = 'A')
    OVER (PARTITION BY r.id)   AS bucket_a_monthly_paise,
  SUM(l.monthly_amount_paise) FILTER (WHERE sc.ctc_bucket = 'B')
    OVER (PARTITION BY r.id)   AS bucket_b_monthly_paise,
  SUM(l.monthly_amount_paise) FILTER (WHERE sc.ctc_bucket = 'C')
    OVER (PARTITION BY r.id)   AS bucket_c_monthly_paise
FROM current_rev r
LEFT JOIN public.salary_structures ss ON ss.id = r.salary_structure_id
LEFT JOIN public.employee_salary_revision_lines l ON l.revision_id = r.id
LEFT JOIN public.salary_components sc ON sc.id = l.salary_component_id
WHERE r.employee_id = app.current_employee_id()
   OR (app.is_admin() AND app.admin_scope_covers(r.employee_id));

COMMENT ON VIEW public.v_employee_current_salary IS
  '§9.3: the revision in force today (approved, effective-dated) with its component lines and A/B/C bucket totals. CTC = A + C, defined in data.';

-- -----------------------------------------------------------------------------
-- 7. v_salary_revisions — revision history for the CTC timeline chart (§9.3)
--    increment_amount / increment_pct / months_since_previous are the stored
--    generated/trigger-set columns of 021 — never recomputed here.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_salary_revisions
WITH (security_barrier = true) AS
SELECT
  r.id                 AS revision_id,
  r.employee_id,
  r.revision_number,
  r.revision_kind,
  r.status,
  r.effective_from,
  r.effective_to,
  (r.status = 'approved'
     AND r.effective_from <= util.ist_today()
     AND (r.effective_to IS NULL OR r.effective_to >= util.ist_today())) AS is_current,
  r.monthly_gross_paise,
  r.monthly_employer_contribution_paise,
  r.monthly_ctc_paise,
  r.annual_ctc_paise,
  r.previous_monthly_ctc_paise,
  r.increment_amount_paise,
  r.increment_pct,               -- §9.2 CTC Revision %: already a percentage
  r.months_since_previous,       -- "Duration Between Revisions: 21 Months"
  -- §9.2 Months Since Last Revision, evaluated on the latest approved revision
  CASE WHEN r.status = 'approved'
        AND r.effective_from <= util.ist_today()
        AND (r.effective_to IS NULL OR r.effective_to >= util.ist_today())
       THEN date_part('month', age(util.ist_today(), r.effective_from))::integer
            + (date_part('year', age(util.ist_today(), r.effective_from))::integer * 12)
       ELSE NULL
  END AS months_since_last_revision,
  r.ctc_at_join_paise,
  r.salary_structure_id,
  r.approved_by, r.approved_at, r.notes
FROM public.employee_salary_revisions r
WHERE r.employee_id = app.current_employee_id()
   OR (app.is_admin() AND app.admin_scope_covers(r.employee_id));

-- -----------------------------------------------------------------------------
-- 8. v_payroll_variance — current run vs previous, per employee and per
--    component: the pre-approval sanity check (§9.3). Admin-only.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_payroll_variance
WITH (security_barrier = true) AS
WITH slips AS (
  SELECT ps.*, pp.start_date AS pp_start
  FROM public.payslips ps
  JOIN public.pay_periods pp ON pp.id = ps.pay_period_id
  WHERE NOT ps.is_reversed
),
paired AS (
  SELECT cur.id AS cur_payslip_id, prev.id AS prev_payslip_id,
         cur.payroll_run_id, cur.employee_id,
         cur.net_pay_paise      AS cur_net_paise,
         prev.net_pay_paise     AS prev_net_paise,
         cur.gross_earnings_paise  AS cur_gross_paise,
         prev.gross_earnings_paise AS prev_gross_paise
  FROM slips cur
  LEFT JOIN LATERAL (
    SELECT p2.*
    FROM slips p2
    WHERE p2.employee_id = cur.employee_id
      AND p2.pp_start < cur.pp_start
    ORDER BY p2.pp_start DESC
    LIMIT 1
  ) prev ON true
)
-- per-component rows
SELECT
  pd.payroll_run_id,
  pd.employee_id,
  er.employee_code,
  er.display_name,
  'component'::text          AS variance_grain,
  sc.id                      AS salary_component_id,
  COALESCE(sc.code, curl.label) AS component_code,
  curl.label,
  curl.line_kind,
  curl.amount_paise          AS current_amount_paise,
  prevl.amount_paise         AS previous_amount_paise,
  (curl.amount_paise - COALESCE(prevl.amount_paise, 0)) AS variance_paise,
  ROUND((curl.amount_paise - COALESCE(prevl.amount_paise, 0)) * 100.0
        / NULLIF(prevl.amount_paise, 0), 2)             AS variance_pct
FROM paired pd
JOIN public.payslip_lines curl ON curl.payslip_id = pd.cur_payslip_id
LEFT JOIN public.salary_components sc ON sc.id = curl.salary_component_id
LEFT JOIN public.payslip_lines prevl
       ON prevl.payslip_id = pd.prev_payslip_id
      AND (   (prevl.salary_component_id IS NOT DISTINCT FROM curl.salary_component_id
               AND prevl.salary_component_id IS NOT NULL)
           OR (prevl.salary_component_id IS NULL AND curl.salary_component_id IS NULL
               AND prevl.label = curl.label))
LEFT JOIN public.v_employee_ref er ON er.id = pd.employee_id
WHERE app.is_admin() AND app.admin_scope_covers(pd.employee_id)

UNION ALL

-- per-employee net rows
SELECT
  pd.payroll_run_id,
  pd.employee_id,
  er.employee_code,
  er.display_name,
  'net_pay'::text            AS variance_grain,
  NULL::uuid                 AS salary_component_id,
  'NET_PAY'                  AS component_code,
  'Net Pay'                  AS label,
  NULL::public.payslip_line_kind AS line_kind,
  pd.cur_net_paise           AS current_amount_paise,
  pd.prev_net_paise          AS previous_amount_paise,
  (pd.cur_net_paise - COALESCE(pd.prev_net_paise, 0)) AS variance_paise,
  ROUND((pd.cur_net_paise - COALESCE(pd.prev_net_paise, 0)) * 100.0
        / NULLIF(pd.prev_net_paise, 0), 2)            AS variance_pct
FROM paired pd
LEFT JOIN public.v_employee_ref er ON er.id = pd.employee_id
WHERE app.is_admin() AND app.admin_scope_covers(pd.employee_id);

COMMENT ON VIEW public.v_payroll_variance IS
  '§9.3: current run vs the employee''s previous payslip, per component plus a NET_PAY row. variance_pct NULL when there is no previous amount. Admin-scoped; the approval trigger (022) blocks >±10% without a reason.';

-- -----------------------------------------------------------------------------
-- 9. Grants
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.v_leave_balance_current, public.v_leave_ledger_statement,
  public.v_leave_calendar, public.v_comp_off_balance,
  public.v_payslip_detail, public.v_employee_current_salary,
  public.v_salary_revisions, public.v_payroll_variance
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.v_leave_balance_current, public.v_leave_ledger_statement,
      public.v_leave_calendar, public.v_comp_off_balance,
      public.v_payslip_detail, public.v_employee_current_salary,
      public.v_salary_revisions, public.v_payroll_variance
    FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON
      public.v_leave_balance_current, public.v_leave_ledger_statement,
      public.v_leave_calendar, public.v_comp_off_balance,
      public.v_payslip_detail, public.v_employee_current_salary,
      public.v_salary_revisions, public.v_payroll_variance
    TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON
      public.v_leave_balance_current, public.v_leave_ledger_statement,
      public.v_leave_calendar, public.v_comp_off_balance,
      public.v_payslip_detail, public.v_employee_current_salary,
      public.v_salary_revisions, public.v_payroll_variance
    TO service_role;
  END IF;
END $$;

COMMIT;
