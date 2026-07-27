-- =============================================================================
-- Migration 043 — seed: attendance policies, pay periods FY2026-27,
-- holiday calendar KA-2026 (19 rows), leave types (10).
-- Source: docs/plan/04-data-model.md §14.6–14.7; spec-migrations §6.7–6.10.
--
-- Order inside this file matters: leave types come first so AP-OPS can bind
-- late_deduction_leave_type_id → CL. SL.document_type_id (MEDICAL_CERT) is
-- wired in 045 after document_types are seeded.
-- Policy assignments (attendance policy / weekly-off / holiday calendar) are
-- seeded per §14.6 + Appendix B2 so resolve_policy() answers from day one.
-- =============================================================================

BEGIN;

-- Reason/source context for audit.log_changes(): tables in
-- audit.reason_required_tables demand a reason on UPDATE, and every audit row
-- this seed writes should say where it came from.
SELECT set_config('app.reason', 'seed 043: attendance policies, pay periods, holiday calendar and leave types', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Leave types (§14.7, 10 rows). sandwich_holidays = false for every type.
--    Probation staff accrue EL but cannot avail it; CL/SL from month 2.
-- -----------------------------------------------------------------------------
INSERT INTO public.leave_types
  (company_id, code, name, description, sort_order, is_paid,
   allow_half_day, annual_quota_days, accrual_frequency, accrual_days_per_period,
   accrual_start_after_months, availing_allowed_during_probation,
   carry_forward_allowed, max_carry_forward_days,
   encashment_allowed, max_consecutive_days, requires_document_after_days,
   gender_restriction, min_service_months, max_times_in_service,
   max_days_per_request, is_comp_off, is_system_managed, sandwich_holidays,
   colour_hex)
SELECT c.id, v.code, v.name, v.descr, v.ord, v.paid,
       v.half, v.quota, v.freq::public.accrual_frequency, v.per_period,
       v.start_after, v.avail_prob,
       v.cf, v.cf_max,
       v.encash, v.max_consec, v.doc_after,
       v.gender::public.gender, v.min_service, v.max_times,
       v.max_per_req, v.comp_off, v.system, false,
       v.colour
FROM public.companies c,
     (VALUES
        ('EL',  'Earned Leave',
         'Encashable on exit. Karnataka S&E alternative basis (1 per 20 worked days) available via accrual_on_working_days_basis.',
         10, true,  true,  18::numeric,  'monthly', 1.5::numeric,  0, false, true,  30::numeric, true,  NULL::numeric, NULL::numeric, NULL, 0, NULL::integer, NULL::numeric, false, false, '#CE8F6F'),
        ('CL',  'Casual Leave',
         'Maximum 3 consecutive days. Available from month 2 of service.',
         20, true,  true,  12::numeric,  'monthly', 1.0::numeric,  1, true,  false, NULL::numeric, false, 3::numeric,   NULL::numeric, NULL, 0, NULL::integer, NULL::numeric, false, false, '#B99665'),
        ('SL',  'Sick Leave',
         'Medical certificate required beyond 2 days. Available from month 2 of service.',
         30, true,  true,  12::numeric,  'monthly', 1.0::numeric,  1, true,  false, NULL::numeric, false, NULL::numeric, 2::numeric,   NULL, 0, NULL::integer, NULL::numeric, false, false, '#564147'),
        ('LWP', 'Leave Without Pay',
         'System-managed: applied by the engine when balances are exhausted.',
         40, false, true,  NULL::numeric, 'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, NULL, 0, NULL::integer, NULL::numeric, false, true,  '#121F38'),
        ('CO',  'Compensatory Off',
         'Earned via comp_off_ledger for extra/holiday work; 90-day expiry enforced by the ledger, not by carry-forward.',
         50, true,  true,  NULL::numeric, 'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, NULL, 0, NULL::integer, NULL::numeric, true,  true,  '#CE8F6F'),
        ('ML',  'Maternity Leave',
         'Maternity Benefit Act — 182 days, maximum 2 in service.',
         60, true,  false, 182::numeric, 'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, 'female', 0, 2, 182::numeric, false, false, '#B99665'),
        ('PL',  'Paternity Leave',
         'Company policy; 6 months'' service.',
         70, true,  false, 5::numeric,   'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, NULL, 6, NULL::integer, 5::numeric,   false, false, '#564147'),
        ('BL',  'Bereavement Leave',
         NULL,
         80, true,  false, 3::numeric,   'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, NULL, 0, NULL::integer, 3::numeric,   false, false, '#121F38'),
        ('MRL', 'Marriage Leave',
         'Once in service. Common in Indian hospitality.',
         90, true,  false, 5::numeric,   'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, NULL, 0, 1,             5::numeric,   false, false, '#CE8F6F'),
        ('OD',  'On Duty',
         'Off-site work; system-managed, no balance.',
        100, true,  true,  NULL::numeric, 'none',   NULL::numeric, 0, true,  false, NULL::numeric, false, NULL::numeric, NULL::numeric, NULL, 0, NULL::integer, NULL::numeric, false, true,  '#B99665')
     ) AS v(code, name, descr, ord, paid, half, quota, freq, per_period,
            start_after, avail_prob, cf, cf_max, encash, max_consec, doc_after,
            gender, min_service, max_times, max_per_req, comp_off, system, colour)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Attendance policies (§14.7, 3 rows). Unlisted thresholds keep the table
--    defaults from migration 014 (which encode §3.6).
-- -----------------------------------------------------------------------------

-- AP-OPS — Operations (shift staff)
INSERT INTO public.attendance_policies
  (company_id, code, name, description,
   grace_in_minutes, grace_out_minutes,
   max_late_days_before_deduction, late_deduction_leave_days,
   late_deduction_leave_type_id,
   overtime_enabled, overtime_requires_approval, overtime_multiplier,
   overtime_min_minutes, overtime_rounding_minutes, max_overtime_minutes_per_day,
   extra_work_compensation, comp_off_expiry_days, single_punch_treatment,
   regularization_window_days, max_regularizations_per_month,
   absent_marking_delay_hours)
SELECT c.id, 'AP-OPS', 'Operations (shift staff)',
       'Default policy for operational departments.',
       10, 10,
       3, 0.5,
       lt.id,
       true, true, 2.0,
       30, 15, 240,
       'comp_off', 90, 'half_day_flag_review',
       15, 3,
       6
FROM public.companies c
JOIN public.leave_types lt
  ON lt.company_id = c.id AND lt.code = 'CL' AND lt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- AP-OFFICE — Office (general shift). OT disabled (ot_eligible false at
-- designation level for managers; the policy switch backs it up).
INSERT INTO public.attendance_policies
  (company_id, code, name, description,
   grace_in_minutes, grace_out_minutes,
   max_late_days_before_deduction, late_deduction_leave_days,
   late_deduction_leave_type_id,
   overtime_enabled, extra_work_compensation,
   regularization_window_days, max_regularizations_per_month)
SELECT c.id, 'AP-OFFICE', 'Office (general shift)',
       'Admin, Sales, Finance, HR.',
       15, 15,
       4, 0.5,
       lt.id,
       false, 'comp_off',
       15, 2
FROM public.companies c
JOIN public.leave_types lt
  ON lt.company_id = c.id AND lt.code = 'CL' AND lt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- AP-SECURITY — Security (12-hour posts). Guards eat at post: no auto break
-- deduction. Night allowance flows via shifts.night_allowance_component_id
-- (NIGHT_ALLOW, wired in 044 once salary components exist).
INSERT INTO public.attendance_policies
  (company_id, code, name, description,
   grace_in_minutes, grace_out_minutes,
   max_late_days_before_deduction, late_deduction_leave_days,
   late_deduction_leave_type_id,
   overtime_enabled, overtime_requires_approval, overtime_multiplier,
   max_overtime_minutes_per_day, auto_deduct_break,
   extra_work_compensation, comp_off_expiry_days,
   regularization_window_days, max_regularizations_per_month)
SELECT c.id, 'AP-SECURITY', 'Security (12-hour posts)',
       'A relieving guard cannot be late: grace 5/5. Night allowance via NIGHT_ALLOW.',
       5, 5,
       2, 0.5,
       lt.id,
       true, true, 2.0,
       180, false,
       'comp_off', 90,
       15, 3
FROM public.companies c
JOIN public.leave_types lt
  ON lt.company_id = c.id AND lt.code = 'CL' AND lt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Pay periods FY 2026-27 (§14.7 / spec §6.8): monthly, 26th prev month →
--    25th, cutoff = end_date, pay date = last day of the period month,
--    month_days_basis = 'actual'. Codes 2026-04 … 2027-03.
--    Names read like 'July 2026 (26 Jun – 25 Jul)'.
-- -----------------------------------------------------------------------------
INSERT INTO public.pay_periods
  (company_id, code, name, period_kind, start_date, end_date,
   attendance_cutoff_date, pay_date, financial_year, month_days_basis)
SELECT
  c.id,
  to_char(m.month_start, 'YYYY-MM'),
  to_char(m.month_start, 'FMMonth YYYY')
    || ' (26 ' || to_char(m.month_start - INTERVAL '1 month', 'Mon')
    || ' – 25 ' || to_char(m.month_start, 'Mon') || ')',
  'monthly',
  (m.month_start - INTERVAL '1 month' + INTERVAL '25 days')::date,  -- 26th of previous month
  (m.month_start + INTERVAL '24 days')::date,                       -- 25th
  (m.month_start + INTERVAL '24 days')::date,
  (m.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,    -- last day of period month
  '2026-27',
  'actual'
FROM public.companies c,
     generate_series(DATE '2026-04-01', DATE '2027-03-01', INTERVAL '1 month') AS m(month_start)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Holiday calendar KA-2026 (§14.7): Karnataka, 2026, optional quota 2,
--    19 holidays. Rows marked (V) are lunar/notification-dependent — seeded
--    is_active = true with the reconciliation note in description (Appendix B7).
--    Where operational departments work: applies_to_department_ids excludes
--    BANQ, KITCH, HK, SEC, FO, GARD, MAINT, TRAN (i.e. the holiday applies to
--    SALES, MKTG, FIN, HR, PUR only), working_if_event_booked = true,
--    compensatory_off_if_worked = true, pay_multiplier_if_worked = 2.0.
--    Restricted holidays are the optional ones (quota 2).
-- -----------------------------------------------------------------------------
INSERT INTO public.holiday_calendars
  (company_id, code, name, description, sort_order, year, state, is_default,
   optional_holiday_quota)
SELECT c.id, 'KA-2026', 'Karnataka 2026',
       'Karnataka holiday calendar for 2026. Dates marked (V) in the seed are pending reconciliation against the Karnataka Government Gazette notification (Appendix B7).',
       10, 2026, 'Karnataka', true, 2
FROM public.companies c
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.holidays
  (holiday_calendar_id, holiday_date, name, holiday_type, is_optional,
   applies_to_department_ids, working_if_event_booked,
   compensatory_off_if_worked, pay_multiplier_if_worked, description)
SELECT
  hc.id, v.d, v.name, v.htype::public.holiday_type,
  (v.htype = 'restricted'),
  CASE WHEN v.ops_work THEN office.ids ELSE NULL END,
  v.ops_work,
  true,
  2.0,
  CASE WHEN v.variable
       THEN 'Lunar/notification-dependent date (V): reconcile against the Karnataka Government Gazette holiday notification for 2026 before go-live.'
       ELSE NULL END
FROM public.companies c
JOIN public.holiday_calendars hc
  ON hc.company_id = c.id AND hc.code = 'KA-2026' AND hc.deleted_at IS NULL
CROSS JOIN LATERAL (
  SELECT array_agg(d.id) AS ids
  FROM public.departments d
  WHERE d.company_id = c.id
    AND d.code IN ('SALES', 'MKTG', 'FIN', 'HR', 'PUR')
    AND d.deleted_at IS NULL
) AS office
JOIN (VALUES
        (DATE '2026-01-01', 'New Year''s Day',                  'company',    true,  false),
        (DATE '2026-01-14', 'Makara Sankranti',                 'state',      true,  false),
        (DATE '2026-01-26', 'Republic Day',                     'national',   false, false),
        (DATE '2026-02-15', 'Maha Shivaratri',                  'festival',   true,  true),
        (DATE '2026-03-04', 'Holi',                             'restricted', true,  true),
        (DATE '2026-03-19', 'Ugadi',                            'state',      false, true),
        (DATE '2026-03-20', 'Eid-ul-Fitr',                      'restricted', true,  true),
        (DATE '2026-04-03', 'Good Friday',                      'restricted', true,  false),
        (DATE '2026-04-14', 'Dr. B. R. Ambedkar Jayanti',       'state',      false, false),
        (DATE '2026-05-01', 'May Day / Labour Day',             'state',      true,  false),
        (DATE '2026-05-27', 'Bakrid / Eid-ul-Adha',             'restricted', true,  true),
        (DATE '2026-08-15', 'Independence Day',                 'national',   true,  false),
        (DATE '2026-09-14', 'Ganesh Chaturthi',                 'state',      true,  false),
        (DATE '2026-10-02', 'Gandhi Jayanti',                   'national',   true,  false),
        (DATE '2026-10-20', 'Vijayadashami / Ayudha Puja',      'state',      true,  true),
        (DATE '2026-11-01', 'Kannada Rajyotsava',               'state',      true,  false),
        (DATE '2026-11-08', 'Deepavali',                        'state',      true,  true),
        (DATE '2026-11-09', 'Balipadyami',                      'restricted', true,  true),
        (DATE '2026-12-25', 'Christmas',                        'national',   true,  false)
     ) AS v(d, name, htype, ops_work, variable) ON true
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (holiday_calendar_id, holiday_date, name) DO NOTHING;

-- Venue location defaults to the KA-2026 calendar.
UPDATE public.locations l
SET default_holiday_calendar_id = hc.id
FROM public.companies c
JOIN public.holiday_calendars hc
  ON hc.company_id = c.id AND hc.code = 'KA-2026' AND hc.deleted_at IS NULL
WHERE l.company_id = c.id
  AND c.code = 'TT' AND c.deleted_at IS NULL
  AND l.code = 'TTT-VENUE' AND l.deleted_at IS NULL
  AND l.default_holiday_calendar_id IS DISTINCT FROM hc.id;

-- -----------------------------------------------------------------------------
-- 5. Policy assignments (§14.6, Appendix B2) — narrowest-scope-wins resolution:
--    attendance_policy: company → AP-OPS; FIN/HR/SALES/MKTG/PUR → AP-OFFICE;
--                       SEC → AP-SECURITY.
--    weekly_off_rule:   company → WO-MIDWEEK-TUE (operational default);
--                       BANQ/KITCH/HK/SEC → WO-ROSTER;
--                       SALES/MKTG/PUR → WO-SUN; FIN/HR → WO-SUN-ALTSAT.
--    holiday_calendar:  company → KA-2026 (calendar year 2026).
-- -----------------------------------------------------------------------------

-- Company-wide defaults
INSERT INTO public.policy_assignments
  (assignment_kind, policy_id, scope, company_id, effective_from, reason)
SELECT v.kind, v.pid, 'company', c.id, v.eff, v.reason
FROM public.companies c
CROSS JOIN LATERAL (
  SELECT 'attendance_policy'::text AS kind,
         (SELECT ap.id FROM public.attendance_policies ap
           WHERE ap.company_id = c.id AND ap.code = 'AP-OPS' AND ap.deleted_at IS NULL) AS pid,
         DATE '2026-01-01' AS eff,
         'seed: operational default attendance policy'::text AS reason
  UNION ALL
  SELECT 'weekly_off_rule',
         (SELECT w.id FROM public.weekly_off_rules w
           WHERE w.company_id = c.id AND w.code = 'WO-MIDWEEK-TUE'),
         DATE '2026-01-01',
         'seed: operational default weekly off (Tuesday)'
  UNION ALL
  SELECT 'holiday_calendar',
         (SELECT hc.id FROM public.holiday_calendars hc
           WHERE hc.company_id = c.id AND hc.code = 'KA-2026' AND hc.deleted_at IS NULL),
         DATE '2026-01-01',
         'seed: Karnataka 2026 holiday calendar'
) AS v
WHERE c.code = 'TT' AND c.deleted_at IS NULL
  AND v.pid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.policy_assignments pa
    WHERE pa.assignment_kind = v.kind AND pa.scope = 'company'
      AND pa.company_id = c.id AND pa.policy_id = v.pid AND pa.deleted_at IS NULL);

-- Department overrides — attendance policies
INSERT INTO public.policy_assignments
  (assignment_kind, policy_id, scope, department_id, effective_from, reason)
SELECT 'attendance_policy', ap.id, 'department', d.id, DATE '2026-01-01',
       'seed: departmental attendance policy'
FROM public.companies c
JOIN (VALUES
        ('SEC',   'AP-SECURITY'),
        ('FIN',   'AP-OFFICE'),
        ('HR',    'AP-OFFICE'),
        ('SALES', 'AP-OFFICE'),
        ('MKTG',  'AP-OFFICE'),
        ('PUR',   'AP-OFFICE')
     ) AS v(dept_code, ap_code) ON true
JOIN public.departments d
  ON d.company_id = c.id AND d.code = v.dept_code AND d.deleted_at IS NULL
JOIN public.attendance_policies ap
  ON ap.company_id = c.id AND ap.code = v.ap_code AND ap.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.policy_assignments pa
    WHERE pa.assignment_kind = 'attendance_policy' AND pa.scope = 'department'
      AND pa.department_id = d.id AND pa.policy_id = ap.id AND pa.deleted_at IS NULL);

-- Department overrides — weekly-off rules
INSERT INTO public.policy_assignments
  (assignment_kind, policy_id, scope, department_id, effective_from, reason)
SELECT 'weekly_off_rule', w.id, 'department', d.id, DATE '2026-01-01',
       'seed: departmental weekly-off rule'
FROM public.companies c
JOIN (VALUES
        ('BANQ',  'WO-ROSTER'),
        ('KITCH', 'WO-ROSTER'),
        ('HK',    'WO-ROSTER'),
        ('SEC',   'WO-ROSTER'),
        ('SALES', 'WO-SUN'),
        ('MKTG',  'WO-SUN'),
        ('PUR',   'WO-SUN'),
        ('FIN',   'WO-SUN-ALTSAT'),
        ('HR',    'WO-SUN-ALTSAT')
     ) AS v(dept_code, wo_code) ON true
JOIN public.departments d
  ON d.company_id = c.id AND d.code = v.dept_code AND d.deleted_at IS NULL
JOIN public.weekly_off_rules w
  ON w.company_id = c.id AND w.code = v.wo_code
WHERE c.code = 'TT' AND c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.policy_assignments pa
    WHERE pa.assignment_kind = 'weekly_off_rule' AND pa.scope = 'department'
      AND pa.department_id = d.id AND pa.policy_id = w.id AND pa.deleted_at IS NULL);

COMMIT;
