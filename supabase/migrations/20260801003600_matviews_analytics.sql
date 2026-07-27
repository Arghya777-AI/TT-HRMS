-- =============================================================================
-- Migration 036 — analytics materialized views (§9.3/§9.4, §12.1)
-- Source: docs/plan/04-data-model.md §9.3 (mv_team_hierarchy,
--         mv_attendance_monthly, mv_payroll_cost_monthly, mv_headcount_daily),
--         §9.4 refresh strategy, §12.1 (unique index on mv_attendance_monthly).
--
-- Rules honoured here:
--   * Every matview carries refreshed_at (constant per refresh) so the UI can
--     show "as of 09:15 IST" (§9.4).
--   * Every matview has a UNIQUE index on plain columns → REFRESH ...
--     CONCURRENTLY is always legal. Nullable dimension columns get a NOT NULL
--     *_key twin (zero-uuid sentinel FOR INDEXING ONLY — not a data value).
--   * Matviews live in analytics.* with ZERO client grants; clients read the
--     public.v_* wrappers, which are owner-executed and role-gated. Matviews
--     have no RLS, so a wrapper predicate is the ONLY gate — hence no direct
--     grants.
--   * Employee-facing personal numbers never come from a matview (§9.4);
--     these wrappers serve manager/admin analytics.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. analytics.mv_team_hierarchy — recursive reporting closure (§9.3)
--    (manager_employee_id, employee_id, depth, path, is_direct)
-- -----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_team_hierarchy AS
WITH RECURSIVE closure AS (
  SELECT e.reporting_manager_id            AS manager_employee_id,
         e.id                              AS employee_id,
         1                                 AS depth,
         ARRAY[e.reporting_manager_id, e.id] AS path
  FROM public.employees e
  WHERE e.reporting_manager_id IS NOT NULL
    AND e.deleted_at IS NULL

  UNION ALL

  SELECT c.manager_employee_id,
         e.id,
         c.depth + 1,
         c.path || e.id
  FROM closure c
  JOIN public.employees e
    ON e.reporting_manager_id = c.employee_id
   AND e.deleted_at IS NULL
  WHERE c.depth < 8                        -- same cap as app.reportee_ids (005)
    AND NOT e.id = ANY(c.path)             -- cycle guard
)
SELECT
  manager_employee_id,
  employee_id,
  depth,
  path,
  (depth = 1) AS is_direct,
  now()       AS refreshed_at
FROM closure;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_team_hierarchy__edge
  ON analytics.mv_team_hierarchy (manager_employee_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_mv_team_hierarchy__employee
  ON analytics.mv_team_hierarchy (employee_id);

-- -----------------------------------------------------------------------------
-- 2. analytics.mv_attendance_monthly — §9.2 metrics per (employee, pay period)
--    (monthly pay periods ↔ one (year, month) label each, from end_date)
-- -----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_attendance_monthly AS
SELECT
  ad.employee_id,
  pp.id                                           AS pay_period_id,
  pp.code                                         AS pay_period_code,
  EXTRACT(YEAR  FROM pp.end_date)::integer        AS year,
  EXTRACT(MONTH FROM pp.end_date)::integer        AS month,
  (pp.end_date - pp.start_date) + 1               AS total_days,
  COUNT(*)::integer                               AS days_recorded,
  COUNT(*) FILTER (WHERE ad.status IN
    ('present','weekly_off_worked','holiday_worked','on_duty','work_from_home'))::integer
                                                  AS present_days,
  COUNT(*) FILTER (WHERE ad.status = 'half_day')::integer          AS half_days,
  COUNT(*) FILTER (WHERE ad.status = 'absent')::integer            AS absent_days,
  COUNT(*) FILTER (WHERE ad.status = 'pending')::integer           AS pending_days,
  COUNT(*) FILTER (WHERE ad.is_weekly_off)::integer                AS weekly_off_days,
  COUNT(*) FILTER (WHERE ad.is_holiday)::integer                   AS holiday_days,
  COALESCE(SUM(ad.leave_day_fraction), 0)                          AS leave_days,
  COUNT(*) FILTER (WHERE ad.status = 'comp_off_availed')::integer  AS comp_off_days,
  COALESCE(SUM(ad.day_fraction_paid), 0)                           AS paid_days,
  COUNT(*) FILTER (WHERE ad.is_working_day)::integer               AS working_days,
  COUNT(*) FILTER (WHERE ad.is_late)::integer                      AS late_days,
  COALESCE(SUM(ad.late_minutes) FILTER (WHERE ad.is_late), 0)::integer AS late_minutes,
  COUNT(*) FILTER (WHERE ad.is_early_exit)::integer                AS early_exit_days,
  COALESCE(SUM(ad.early_exit_minutes) FILTER (WHERE ad.is_early_exit), 0)::integer
                                                  AS early_exit_minutes,
  COALESCE(SUM(ad.overtime_minutes), 0)::integer                   AS overtime_minutes,
  COALESCE(SUM(ad.approved_overtime_minutes), 0)::integer          AS approved_overtime_minutes,
  COALESCE(SUM(ad.extra_work_minutes), 0)::integer                 AS extra_work_minutes,
  COALESCE(SUM(ad.total_worked_minutes), 0)::integer               AS total_worked_minutes,
  ROUND(SUM(ad.total_worked_minutes)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2)
                                                  AS avg_worked_minutes_per_present_day,
  ROUND(SUM(ad.total_worked_minutes)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE ad.is_working_day), 0), 2)
                                                  AS avg_worked_minutes_per_working_day,
  public.fn_late_pct(
    COUNT(*) FILTER (WHERE ad.is_late)::integer,
    COUNT(*) FILTER (WHERE ad.is_working_day)::integer)            AS late_pct,
  ROUND(COALESCE(SUM(ad.day_fraction_paid), 0) * 100.0
        / NULLIF((pp.end_date - pp.start_date) + 1, 0), 2)         AS attendance_pct,
  COALESCE(SUM(ad.late_deduction_leave_days), 0)                   AS late_deduction_leave_days,
  COALESCE(SUM(ad.break_minutes), 0)::integer                      AS break_minutes,
  COALESCE(SUM(ad.break_count), 0)::integer                        AS break_count,
  ROUND(SUM(ad.break_count)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2)
                                                  AS avg_breaks_per_present_day,
  now() AS refreshed_at
FROM public.attendance_days ad
JOIN public.pay_periods pp
  ON ad.ist_date BETWEEN pp.start_date AND pp.end_date
GROUP BY ad.employee_id, pp.id, pp.code, pp.start_date, pp.end_date;

-- §12.1 named index: unique on (employee_id, pay_period_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_attendance_monthly__employee_period
  ON analytics.mv_attendance_monthly (employee_id, pay_period_id);
CREATE INDEX IF NOT EXISTS idx_mv_attendance_monthly__year_month
  ON analytics.mv_attendance_monthly (year, month);

-- -----------------------------------------------------------------------------
-- 3. analytics.mv_payroll_cost_monthly — month × department × cost centre (§9.3)
-- -----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_payroll_cost_monthly AS
WITH slip AS (
  SELECT
    ps.id, ps.employee_id, ps.pay_period_id,
    ps.gross_earnings_paise, ps.total_deductions_paise, ps.net_pay_paise,
    ps.employer_contributions_paise,
    e.department_id, e.cost_centre_id
  FROM public.payslips ps
  JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
  JOIN public.employees e ON e.id = ps.employee_id
  WHERE pr.status IN ('approved','disbursement_pending','paid','closed')
    AND NOT ps.is_reversed
),
ot AS (
  SELECT pl.payslip_id, SUM(pl.amount_paise) AS ot_paise
  FROM public.payslip_lines pl
  JOIN public.salary_components sc ON sc.id = pl.salary_component_id
  WHERE sc.code = 'OT'
  GROUP BY pl.payslip_id
)
SELECT
  EXTRACT(YEAR  FROM pp.end_date)::integer AS year,
  EXTRACT(MONTH FROM pp.end_date)::integer AS month,
  pp.id   AS pay_period_id,
  pp.code AS pay_period_code,
  s.department_id,
  COALESCE(s.department_id,  '00000000-0000-0000-0000-000000000000'::uuid) AS department_key,
  d.name  AS department_name,
  s.cost_centre_id,
  COALESCE(s.cost_centre_id, '00000000-0000-0000-0000-000000000000'::uuid) AS cost_centre_key,
  cc.name AS cost_centre_name,
  COUNT(DISTINCT s.employee_id)::integer          AS employee_count,
  COALESCE(SUM(s.gross_earnings_paise), 0)        AS gross_paise,
  COALESCE(SUM(s.total_deductions_paise), 0)      AS deductions_paise,
  COALESCE(SUM(s.net_pay_paise), 0)               AS net_paise,
  COALESCE(SUM(s.employer_contributions_paise), 0) AS employer_cost_paise,
  -- §9.2 Payroll Cost: SUM(gross_earnings + employer_contributions)
  COALESCE(SUM(s.gross_earnings_paise + s.employer_contributions_paise), 0)
                                                  AS total_cost_paise,
  -- §9.2 Cost per Employee
  (COALESCE(SUM(s.gross_earnings_paise + s.employer_contributions_paise), 0)
     / NULLIF(COUNT(DISTINCT s.employee_id), 0))  AS cost_per_employee_paise,
  COALESCE(SUM(o.ot_paise), 0)                    AS overtime_cost_paise,
  ROUND(COALESCE(SUM(o.ot_paise), 0) * 100.0
        / NULLIF(SUM(s.gross_earnings_paise + s.employer_contributions_paise), 0), 2)
                                                  AS overtime_share_pct,
  now() AS refreshed_at
FROM slip s
JOIN public.pay_periods pp ON pp.id = s.pay_period_id
LEFT JOIN ot o             ON o.payslip_id = s.id
LEFT JOIN public.departments  d  ON d.id  = s.department_id
LEFT JOIN public.cost_centres cc ON cc.id = s.cost_centre_id
GROUP BY pp.id, pp.code, pp.end_date, s.department_id, d.name, s.cost_centre_id, cc.name;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_payroll_cost_monthly__grain
  ON analytics.mv_payroll_cost_monthly (pay_period_id, department_key, cost_centre_key);
CREATE INDEX IF NOT EXISTS idx_mv_payroll_cost_monthly__year_month
  ON analytics.mv_payroll_cost_monthly (year, month);

-- -----------------------------------------------------------------------------
-- 4. analytics.mv_headcount_daily — date × department × employment type (§9.3)
--    §9.2 Headcount: date_of_join <= d AND (last_working_day IS NULL OR >= d)
-- -----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_headcount_daily AS
WITH bounds AS (
  SELECT COALESCE(MIN(e.date_of_join), util.ist_today()) AS from_date
  FROM public.employees e
  WHERE e.deleted_at IS NULL
),
days AS (
  SELECT d::date AS as_of_date
  FROM bounds b,
       generate_series(b.from_date, util.ist_today(), interval '1 day') AS d
)
SELECT
  dy.as_of_date,
  e.department_id,
  COALESCE(e.department_id, '00000000-0000-0000-0000-000000000000'::uuid) AS department_key,
  dep.name AS department_name,
  e.employment_type,
  COUNT(*) FILTER (WHERE e.date_of_join <= dy.as_of_date
                     AND (e.last_working_day IS NULL OR e.last_working_day >= dy.as_of_date))::integer
           AS headcount,
  COUNT(*) FILTER (WHERE e.date_of_join = dy.as_of_date)::integer      AS joiners,
  COUNT(*) FILTER (WHERE e.last_working_day = dy.as_of_date)::integer  AS exits,
  now() AS refreshed_at
FROM days dy
JOIN public.employees e
  ON e.deleted_at IS NULL
 AND e.date_of_join IS NOT NULL
 AND e.date_of_join <= dy.as_of_date
 AND (e.last_working_day IS NULL OR e.last_working_day >= dy.as_of_date)
LEFT JOIN public.departments dep ON dep.id = e.department_id
GROUP BY dy.as_of_date, e.department_id, dep.name, e.employment_type;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_headcount_daily__grain
  ON analytics.mv_headcount_daily (as_of_date, department_key, employment_type);

-- -----------------------------------------------------------------------------
-- 5. Zero client grants on the matviews (wrapper views are the only door)
-- -----------------------------------------------------------------------------

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON analytics.mv_team_hierarchy, analytics.mv_attendance_monthly, '
        || 'analytics.mv_payroll_cost_monthly, analytics.mv_headcount_daily FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA analytics TO service_role;
    GRANT SELECT ON analytics.mv_team_hierarchy, analytics.mv_attendance_monthly,
                    analytics.mv_payroll_cost_monthly, analytics.mv_headcount_daily
      TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. public.v_* wrappers — owner-executed, role-gated (matviews have no RLS)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_team_hierarchy
WITH (security_barrier = true) AS
SELECT th.manager_employee_id, th.employee_id, th.depth, th.path, th.is_direct,
       th.refreshed_at
FROM analytics.mv_team_hierarchy th
WHERE th.manager_employee_id = app.current_employee_id()
   OR th.employee_id = app.current_employee_id()
   OR app.is_admin();

CREATE OR REPLACE VIEW public.v_attendance_monthly_summary
WITH (security_barrier = true) AS
SELECT m.*
FROM analytics.mv_attendance_monthly m
WHERE app.can_see_employee(m.employee_id);

COMMENT ON VIEW public.v_attendance_monthly_summary IS
  '§9.3/§9.4: matview-backed monthly metrics. refreshed_at is shown as "as of HH:MM IST" — employee-facing personal numbers must use the live views instead.';

CREATE OR REPLACE VIEW public.v_payroll_cost_monthly
WITH (security_barrier = true) AS
SELECT m.*
FROM analytics.mv_payroll_cost_monthly m
WHERE app.is_admin();

CREATE OR REPLACE VIEW public.v_headcount_daily
WITH (security_barrier = true) AS
SELECT m.*
FROM analytics.mv_headcount_daily m
WHERE app.is_admin();

-- v_headcount_monthly — live over the matview (§9.3): monthly aggregation +
-- attrition (§9.2: exits*12*100/avg_headcount) + tenure buckets + probation.
CREATE OR REPLACE VIEW public.v_headcount_monthly
WITH (security_barrier = true) AS
WITH daily AS (
  -- collapse employment types first: one row per (date, department)
  SELECT
    m.as_of_date,
    m.department_id,
    m.department_key,
    max(m.department_name)   AS department_name,
    SUM(m.headcount)::integer AS headcount,
    SUM(m.joiners)::integer   AS joiners,
    SUM(m.exits)::integer     AS exits
  FROM analytics.mv_headcount_daily m
  GROUP BY m.as_of_date, m.department_id, m.department_key
),
monthly AS (
  SELECT
    EXTRACT(YEAR  FROM dl.as_of_date)::integer AS year,
    EXTRACT(MONTH FROM dl.as_of_date)::integer AS month,
    dl.department_id,
    max(dl.department_name) AS department_name,
    -- mean of the exact daily headcount series for the month
    ROUND(AVG(dl.headcount), 2) AS avg_headcount,
    SUM(dl.joiners)::integer    AS joiners,
    SUM(dl.exits)::integer      AS exits,
    LEAST((MIN(make_date(EXTRACT(YEAR FROM dl.as_of_date)::integer,
                         EXTRACT(MONTH FROM dl.as_of_date)::integer, 1))
             + interval '1 month' - interval '1 day')::date,
          util.ist_today())     AS month_end
  FROM daily dl
  GROUP BY 1, 2, dl.department_id, dl.department_key
)
SELECT
  mo.year,
  mo.month,
  mo.department_id,
  mo.department_name,
  mo.avg_headcount,
  mo.joiners,
  mo.exits,
  -- §9.2 Attrition % (annualised)
  ROUND(mo.exits * 12 * 100.0 / NULLIF(mo.avg_headcount, 0), 2) AS attrition_pct,
  hc.probation_count,
  hc.tenure_lt_1y,
  hc.tenure_1_3y,
  hc.tenure_3_5y,
  hc.tenure_ge_5y
FROM monthly mo
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE e.employment_status = 'on_probation')::integer AS probation_count,
    COUNT(*) FILTER (WHERE e.date_of_join > mo.month_end - interval '1 year')::integer AS tenure_lt_1y,
    COUNT(*) FILTER (WHERE e.date_of_join <= mo.month_end - interval '1 year'
                       AND e.date_of_join >  mo.month_end - interval '3 years')::integer AS tenure_1_3y,
    COUNT(*) FILTER (WHERE e.date_of_join <= mo.month_end - interval '3 years'
                       AND e.date_of_join >  mo.month_end - interval '5 years')::integer AS tenure_3_5y,
    COUNT(*) FILTER (WHERE e.date_of_join <= mo.month_end - interval '5 years')::integer AS tenure_ge_5y
  FROM public.employees e
  WHERE e.deleted_at IS NULL
    AND e.department_id IS NOT DISTINCT FROM mo.department_id
    AND e.date_of_join IS NOT NULL
    AND e.date_of_join <= mo.month_end
    AND (e.last_working_day IS NULL OR e.last_working_day >= mo.month_end)
) hc ON true
WHERE app.is_admin();

-- -----------------------------------------------------------------------------
-- 7. Refresh functions (§9.4): CONCURRENTLY, recorded in job_runs when the
--    031 registry exists (dynamic reference — this file must also run on a
--    harness where 031 has not been applied yet).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION analytics.refresh_matview(p_name text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_err     text;
BEGIN
  IF p_name NOT IN ('mv_team_hierarchy', 'mv_attendance_monthly',
                    'mv_payroll_cost_monthly', 'mv_headcount_daily') THEN
    RAISE EXCEPTION 'unknown analytics matview: %', p_name USING errcode = '22023';
  END IF;

  EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.%I', p_name);

  IF to_regclass('public.job_runs') IS NOT NULL THEN
    BEGIN
      EXECUTE format(
        'INSERT INTO public.job_runs (job_name, started_at, finished_at, status, detail)
         VALUES (%L, %L, clock_timestamp(), %L, %L::jsonb)',
        'refresh_analytics:' || p_name, v_started, 'succeeded',
        jsonb_build_object('matview', 'analytics.' || p_name)::text);
    EXCEPTION WHEN OTHERS THEN
      -- registry shape belongs to 031; never fail a refresh over bookkeeping
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RAISE NOTICE 'job_runs bookkeeping skipped: %', v_err;
    END;
  END IF;
END;
$$;

COMMENT ON FUNCTION analytics.refresh_matview(text) IS
  '§9.4: concurrent refresh of one analytics matview + job_runs bookkeeping. Called by public.refresh_analytics (031) / pg_cron (041) and by the attendance-lock & payroll hooks.';

CREATE OR REPLACE FUNCTION analytics.refresh_all()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM analytics.refresh_matview('mv_team_hierarchy');
  PERFORM analytics.refresh_matview('mv_attendance_monthly');
  PERFORM analytics.refresh_matview('mv_payroll_cost_monthly');
  PERFORM analytics.refresh_matview('mv_headcount_daily');
END;
$$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION analytics.refresh_matview(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION analytics.refresh_all() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION analytics.refresh_matview(text) FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON FUNCTION analytics.refresh_all() FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION analytics.refresh_matview(text) TO service_role;
    GRANT EXECUTE ON FUNCTION analytics.refresh_all() TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 8. Wrapper grants
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.v_team_hierarchy, public.v_attendance_monthly_summary,
  public.v_payroll_cost_monthly, public.v_headcount_daily, public.v_headcount_monthly
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.v_team_hierarchy, public.v_attendance_monthly_summary,
      public.v_payroll_cost_monthly, public.v_headcount_daily, public.v_headcount_monthly
    FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON
      public.v_team_hierarchy, public.v_attendance_monthly_summary,
      public.v_payroll_cost_monthly, public.v_headcount_daily, public.v_headcount_monthly
    TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON
      public.v_team_hierarchy, public.v_attendance_monthly_summary,
      public.v_payroll_cost_monthly, public.v_headcount_daily, public.v_headcount_monthly
    TO service_role;
  END IF;
END $$;

COMMIT;
