-- =============================================================================
-- Migration 034 — attendance views & metric functions (§9)
-- Source: docs/plan/04-data-model.md §9.2 (metric dictionary — every formula
--         transcribed exactly), §9.3 catalogue rows; base columns from 016/017.
--
-- Rule (§9.1): every number displayed anywhere comes from a named column of a
-- named view here. late_pct is computed ONCE (fn_late_pct), already a
-- percentage, clamped to [0,100], NULL when the denominator is 0 — the
-- 1,700.00% defect is structurally impossible.
--
-- View security:
--   * Views reading only attendance_days / reference masters run
--     security_invoker=true — the caller's own RLS (017) filters rows.
--   * v_attendance_punch_detail, v_attendance_today_board and
--     v_exception_queue are owner-executed (security_barrier) with explicit
--     app.* predicates: managers have no base policy on attendance_punches
--     (016: "Managers read v_team_punches (034), not the base") and the
--     board/queue join tables the client cannot read directly.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Metric helpers — one definition each (§9.1, spec-roadmap fn_late_pct)
-- -----------------------------------------------------------------------------

-- late_pct = late_days * 100 / working_days, ROUND 2, clamped [0,100],
-- NULL when the denominator is 0 (the UI renders '—').
CREATE OR REPLACE FUNCTION public.fn_late_pct(p_late_days integer, p_working_days integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(100, GREATEST(0,
           ROUND(p_late_days * 100.0 / NULLIF(p_working_days, 0), 2)));
$$;

COMMENT ON FUNCTION public.fn_late_pct(integer, integer) IS
  '§9.2 Late Arrival %: late_days*100/working_days, rounded 2, clamped [0,100]; NULL when working_days = 0. 17 late of 17 working days = 100.00, never 1,700.00.';

-- minutes → "H:MM" display text (worked_hm / late_hm columns).
CREATE OR REPLACE FUNCTION public.fn_minutes_hm(p_minutes integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_minutes IS NULL THEN NULL
              ELSE (p_minutes / 60)::text || ':' || lpad((p_minutes % 60)::text, 2, '0')
         END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.fn_late_pct(integer, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.fn_minutes_hm(integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.fn_late_pct(integer, integer), public.fn_minutes_hm(integer) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.fn_late_pct(integer, integer), public.fn_minutes_hm(integer) TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. v_attendance_day_enriched — attendance_days + labels (§9.3)
--    security_invoker: RLS on attendance_days (self/team/scoped-admin) applies.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_attendance_day_enriched
WITH (security_invoker = true) AS
SELECT
  ad.id, ad.employee_id,
  er.employee_code, er.display_name, er.photo_path,
  ad.ist_date,
  ad.status, ad.status_source,
  d.name  AS department_name,
  er.section_name,
  dg.name AS designation_name,
  l.name  AS location_name,
  ad.shift_id, sh.code AS shift_code, sh.display_label AS shift_display_label,
  ad.shift_start_at, ad.shift_end_at, ad.shift_duration_minutes,
  ad.manager_id, mgr.display_name AS manager_name,
  ad.holiday_id, h.name AS holiday_name,
  ad.leave_type_id, lt.code AS leave_type_code, lt.name AS leave_type_name,
  ad.leave_request_id, ad.leave_day_fraction,
  ad.first_in_at, ad.last_out_at,
  to_char(util.ist_ts(ad.first_in_at), 'HH24:MI') AS first_in_hm,
  to_char(util.ist_ts(ad.last_out_at), 'HH24:MI') AS last_out_hm,
  ad.punch_count,
  ad.gross_span_minutes, ad.break_minutes, ad.break_count,
  ad.total_worked_minutes, ad.payable_worked_minutes,
  public.fn_minutes_hm(ad.total_worked_minutes) AS worked_hm,
  ad.is_late, ad.late_minutes,
  public.fn_minutes_hm(ad.late_minutes) AS late_hm,
  ad.is_early_exit, ad.early_exit_minutes,
  ad.overtime_minutes, ad.approved_overtime_minutes, ad.extra_work_minutes,
  ad.day_fraction_paid, ad.late_deduction_leave_days,
  ad.is_holiday, ad.is_weekly_off, ad.is_working_day,
  ad.manual_override_status, ad.manual_override_times, ad.manual_override_reason,
  (ad.regularization_id IS NOT NULL) AS is_regularized,
  ad.regularization_id,
  ad.anomaly_flags,
  (cardinality(ad.anomaly_flags) > 0) AS has_anomalies,
  ad.is_locked, ad.computed_at, ad.computed_version
FROM public.attendance_days ad
LEFT JOIN public.v_employee_ref er ON er.id = ad.employee_id
LEFT JOIN public.departments  d   ON d.id  = ad.department_id
LEFT JOIN public.designations dg  ON dg.id = ad.designation_id
LEFT JOIN public.locations    l   ON l.id  = ad.location_id
LEFT JOIN public.shifts       sh  ON sh.id = ad.shift_id
LEFT JOIN public.v_employee_ref mgr ON mgr.id = ad.manager_id
LEFT JOIN public.holidays     h   ON h.id  = ad.holiday_id
LEFT JOIN public.leave_types  lt  ON lt.id = ad.leave_type_id;

-- -----------------------------------------------------------------------------
-- 2. v_attendance_punch_detail — per-punch drill-down ("View Punches", §9.3)
--    Owner-executed: managers have no base policy on attendance_punches; the
--    row predicate is app.can_see_employee (self / team / scoped admin).
--    Direction derived over the non-voided punches of one business date:
--    first = IN, last = OUT, middle = SCAN.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_attendance_punch_detail
WITH (security_barrier = true) AS
WITH ordered AS (
  SELECT
    p.*,
    row_number() OVER w                          AS rn_asc,
    row_number() OVER w_desc                     AS rn_desc,
    count(*)    OVER (PARTITION BY p.employee_id, p.effective_date) AS day_punch_count
  FROM public.attendance_punches p
  WHERE NOT p.is_voided
  WINDOW w      AS (PARTITION BY p.employee_id, p.effective_date ORDER BY p.punched_at),
         w_desc AS (PARTITION BY p.employee_id, p.effective_date ORDER BY p.punched_at DESC)
)
SELECT
  o.id, o.employee_id,
  er.employee_code, er.display_name,
  o.punched_at,
  o.ist_date, o.ist_time, o.effective_date,
  to_char(util.ist_ts(o.punched_at), 'HH24:MI:SS') AS ist_time_display,
  o.direction,
  CASE
    WHEN o.rn_asc = 1                       THEN 'IN'
    WHEN o.rn_desc = 1 AND o.day_punch_count > 1 THEN 'OUT'
    ELSE 'SCAN'
  END AS derived_direction,
  o.source,
  CASE o.source
    WHEN 'kiosk_face'            THEN 'Kiosk — Face'
    WHEN 'kiosk_fingerprint'     THEN 'Kiosk — Fingerprint'
    WHEN 'kiosk_card'            THEN 'Kiosk — Card'
    WHEN 'kiosk_manual'          THEN 'Kiosk — Manual (operator)'
    WHEN 'web'                   THEN 'Web'
    WHEN 'mobile'                THEN 'Mobile'
    WHEN 'biometric_device'      THEN 'Biometric device'
    WHEN 'manual_admin'          THEN 'Manual (admin)'
    WHEN 'import'                THEN 'Import'
    WHEN 'system_regularization' THEN 'Regularization'
  END AS source_label,
  o.kiosk_device_id, kd.label AS device_label,
  o.operator_id, oper.display_name AS operator_name,
  o.match_confidence,
  CASE
    WHEN o.match_confidence IS NULL  THEN NULL
    WHEN o.match_confidence >= 0.80  THEN 'high'
    WHEN o.match_confidence >= 0.62  THEN 'medium'
    ELSE 'low'
  END AS confidence_badge,
  o.photo_path,        -- signed URL minted per request by the API, never stored
  o.lat, o.lng, o.geofence_ok,
  o.is_offline_replay, o.needs_review,
  o.is_voided, o.voided_at, o.void_reason,
  o.reason, o.operator_note, o.recorded_at
FROM ordered o
LEFT JOIN public.v_employee_ref er ON er.id = o.employee_id
LEFT JOIN public.kiosk_devices  kd ON kd.id = o.kiosk_device_id
LEFT JOIN public.kiosk_operators ko ON ko.id = o.operator_id
LEFT JOIN public.employees      oper ON oper.id = ko.employee_id
WHERE app.can_see_employee(o.employee_id);

COMMENT ON VIEW public.v_attendance_punch_detail IS
  '§9.3 per-punch drill-down. Derived direction: first punch of the business date = IN, last = OUT (when >1), middle = SCAN. Row scope = app.can_see_employee. Voided punches are excluded from direction derivation and from this view.';

-- -----------------------------------------------------------------------------
-- 3. f_attendance_period_summary — EVERY §9.2 metric for an arbitrary
--    (employee, from, to). Function-backed so widget and payslip share one
--    query. SECURITY INVOKER: the caller's RLS on attendance_days decides
--    whose rows aggregate.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f_attendance_period_summary(
  p_from date,
  p_to   date,
  p_employee_id uuid DEFAULT NULL)
RETURNS TABLE (
  employee_id                        uuid,
  from_date                          date,
  to_date                            date,
  total_days                         integer,
  present_days                       integer,
  half_days                          integer,
  absent_days                        integer,
  pending_days                       integer,
  weekly_off_days                    integer,
  holiday_days                       integer,
  leave_days                         numeric,
  comp_off_days                      integer,
  paid_days                          numeric,
  working_days                       integer,
  late_days                          integer,
  late_minutes                       integer,
  early_exit_days                    integer,
  early_exit_minutes                 integer,
  overtime_minutes                   integer,
  approved_overtime_minutes          integer,
  extra_work_minutes                 integer,
  total_worked_minutes               integer,
  avg_worked_minutes_per_present_day numeric,
  avg_worked_minutes_per_working_day numeric,
  late_pct                           numeric,
  attendance_pct                     numeric,
  late_deduction_leave_days          numeric,
  break_minutes                      integer,
  break_count                        integer,
  avg_breaks_per_present_day         numeric)
LANGUAGE sql STABLE AS $$
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
    COALESCE(SUM(ad.total_worked_minutes), 0)::integer                AS total_worked_minutes,
    ROUND(SUM(ad.total_worked_minutes)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2)
                                                                      AS avg_worked_minutes_per_present_day,
    ROUND(SUM(ad.total_worked_minutes)::numeric
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
$$;

COMMENT ON FUNCTION public.f_attendance_period_summary(date, date, uuid) IS
  '§9.2 metric dictionary, one implementation. Inclusive period. Unprocessed (pending) days are surfaced separately, never folded into Absents. Paid Days = SUM(day_fraction_paid) — the one definition shared by dashboard card, details modal and payslip.';

-- Convenience month-to-date wrapper so PostgREST widgets have a named relation.
CREATE OR REPLACE VIEW public.v_attendance_period_summary
WITH (security_invoker = true) AS
SELECT * FROM public.f_attendance_period_summary(
  date_trunc('month', util.ist_today())::date, util.ist_today());

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.f_attendance_period_summary(date, date, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.f_attendance_period_summary(date, date, uuid) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.f_attendance_period_summary(date, date, uuid) TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. v_attendance_today_board — the manager/admin live board (§9.2/§9.3).
--    Owner-executed: one row per IN-SCOPE employee (self / team / admin scope)
--    even before the engine has materialised today's attendance_days row,
--    plus web-punch counts the caller could not read from the base table.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_attendance_today_board
WITH (security_barrier = true) AS
SELECT
  e.id AS employee_id,
  e.employee_code, e.display_name, e.photo_path,
  e.department_id, d.name AS department_name,
  util.ist_today() AS ist_date,
  ad.id AS attendance_day_id,
  COALESCE(ad.status, 'pending'::public.attendance_status) AS status,
  COALESCE(ad.shift_id, e.shift_id) AS shift_id,
  sh.code AS shift_code, sh.display_label AS shift_display_label,
  ad.shift_start_at,
  (ad.shift_start_at
     + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10)))
    AS expected_by,
  ad.first_in_at,
  to_char(util.ist_ts(ad.first_in_at), 'HH24:MI') AS first_in_hm,
  ad.last_out_at,
  to_char(util.ist_ts(ad.last_out_at), 'HH24:MI') AS last_out_hm,
  COALESCE(ad.punch_count, 0)         AS punch_count,
  COALESCE(ad.total_worked_minutes, 0) AS worked_minutes,
  public.fn_minutes_hm(COALESCE(ad.total_worked_minutes, 0)) AS worked_hm,
  COALESCE(ad.is_late, false)         AS is_late,
  COALESCE(ad.late_minutes, 0)        AS late_minutes,
  COALESCE(wp.web_punch_count, 0)     AS web_punch_count,
  -- §9.2 board metrics, each a named boolean:
  (COALESCE(ad.status, 'pending') IN
     ('present','half_day','weekly_off_worked','holiday_worked','on_duty','work_from_home')
   AND COALESCE(ad.punch_count, 0) > 0)                                       AS attended,
  (COALESCE(ad.status, 'pending') IN
     ('weekly_off','holiday','on_leave','on_leave_half','comp_off_availed'))  AS off_today,
  (COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0
   AND ad.shift_start_at IS NOT NULL
   AND now() <  ad.shift_start_at
     + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10))) AS yet_to_reach,
  (COALESCE(ad.is_late, false))                                               AS late_in,
  (COALESCE(ad.punch_count, 0) > 0 AND NOT COALESCE(ad.is_late, false))       AS on_time,
  (COALESCE(ad.is_working_day, true) AND COALESCE(ad.punch_count, 0) = 0
   AND ad.shift_start_at IS NOT NULL
   AND now() >= ad.shift_start_at
     + make_interval(mins => COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10))) AS overdue
FROM public.employees e
LEFT JOIN public.attendance_days ad
       ON ad.employee_id = e.id AND ad.ist_date = util.ist_today()
LEFT JOIN public.shifts sh  ON sh.id = COALESCE(ad.shift_id, e.shift_id)
LEFT JOIN public.attendance_policies pol
       ON pol.id = COALESCE(ad.attendance_policy_id, e.attendance_policy_id)
LEFT JOIN public.departments d ON d.id = e.department_id
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS web_punch_count
  FROM public.attendance_punches p
  WHERE p.employee_id = e.id
    AND p.effective_date = util.ist_today()
    AND NOT p.is_voided
    AND p.source IN ('web','mobile')
) wp ON true
WHERE e.deleted_at IS NULL
  AND e.employment_status IN ('active','confirmed','on_probation','on_notice')
  AND NOT e.exclude_from_attendance
  AND app.can_see_employee(e.id);

COMMENT ON VIEW public.v_attendance_today_board IS
  '§9.3 live board: one row per in-scope employee today. "Yet to Reach" flips to "overdue" (the honest version) once shift start + grace has passed.';

-- -----------------------------------------------------------------------------
-- 5. v_attendance_hour_buckets — hours-worked distribution (§9.3)
--    Buckets: <4 / 4–5 / 5–6 / 6–7 / 7–8 / ≥8, counts AND percentages
--    computed in the view (per date; a range sums the counts).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_attendance_hour_buckets
WITH (security_invoker = true) AS
WITH bucketed AS (
  SELECT
    ad.ist_date,
    CASE
      WHEN ad.total_worked_minutes < 240 THEN '<4'
      WHEN ad.total_worked_minutes < 300 THEN '4–5'
      WHEN ad.total_worked_minutes < 360 THEN '5–6'
      WHEN ad.total_worked_minutes < 420 THEN '6–7'
      WHEN ad.total_worked_minutes < 480 THEN '7–8'
      ELSE '≥8'
    END AS bucket,
    CASE
      WHEN ad.total_worked_minutes < 240 THEN 1
      WHEN ad.total_worked_minutes < 300 THEN 2
      WHEN ad.total_worked_minutes < 360 THEN 3
      WHEN ad.total_worked_minutes < 420 THEN 4
      WHEN ad.total_worked_minutes < 480 THEN 5
      ELSE 6
    END AS bucket_sort
  FROM public.attendance_days ad
  WHERE ad.punch_count > 0
)
SELECT
  b.ist_date,
  b.bucket,
  b.bucket_sort,
  count(*)::integer AS day_count,
  ROUND(count(*) * 100.0 / SUM(count(*)) OVER (PARTITION BY b.ist_date), 2) AS pct_of_date
FROM bucketed b
GROUP BY b.ist_date, b.bucket, b.bucket_sort;

-- -----------------------------------------------------------------------------
-- 6. v_attendance_late_trend — per-date late/on-time/absent counts (§9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_attendance_late_trend
WITH (security_invoker = true) AS
SELECT
  ad.ist_date,
  COUNT(*) FILTER (WHERE ad.is_working_day)::integer                        AS working_count,
  COUNT(*) FILTER (WHERE ad.is_late)::integer                               AS late_count,
  COUNT(*) FILTER (WHERE ad.punch_count > 0 AND NOT ad.is_late)::integer    AS on_time_count,
  COUNT(*) FILTER (WHERE ad.status = 'absent')::integer                     AS absent_count,
  COUNT(*) FILTER (WHERE ad.status = 'pending')::integer                    AS pending_count,
  public.fn_late_pct(
    COUNT(*) FILTER (WHERE ad.is_late)::integer,
    COUNT(*) FILTER (WHERE ad.is_working_day)::integer)                     AS late_pct
FROM public.attendance_days ad
GROUP BY ad.ist_date;

-- -----------------------------------------------------------------------------
-- 7. v_attendance_in_trend — first-in minutes since IST midnight (§9.3).
--    Replaces the screenshotted "11.3H" that meant 11:18.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_attendance_in_trend
WITH (security_invoker = true) AS
SELECT
  ad.employee_id,
  ad.ist_date,
  (EXTRACT(HOUR   FROM util.ist_time(ad.first_in_at))::integer * 60
 + EXTRACT(MINUTE FROM util.ist_time(ad.first_in_at))::integer)  AS first_in_minutes,
  to_char(util.ist_ts(ad.first_in_at), 'HH24:MI')                AS first_in_hm,
  ad.is_late,
  ad.late_minutes
FROM public.attendance_days ad
WHERE ad.first_in_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 8. v_break_trend — per-date break analytics with has_break_data (§9.3):
--    the UI says "no break scans" instead of plotting zeros.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_break_trend
WITH (security_invoker = true) AS
SELECT
  ad.ist_date,
  COUNT(*) FILTER (WHERE ad.punch_count > 0)::integer AS present_count,
  COALESCE(SUM(ad.break_minutes), 0)::integer         AS total_break_minutes,
  COALESCE(SUM(ad.break_count), 0)::integer           AS total_break_count,
  ROUND(SUM(ad.break_minutes)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2) AS avg_break_minutes,
  ROUND(SUM(ad.break_count)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE ad.punch_count > 0), 0), 2) AS avg_breaks_per_present_day,
  bool_or(ad.break_count > 0)                         AS has_break_data
FROM public.attendance_days ad
GROUP BY ad.ist_date;

-- -----------------------------------------------------------------------------
-- 9. v_exception_queue — the admin's morning list (§9.3). Owner-executed,
--    admin-gated: it unions surfaces the client role cannot (and must not)
--    read directly. Every branch carries the same column shape.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_exception_queue
WITH (security_barrier = true) AS
SELECT * FROM (
  -- 9.1 punches flagged for review
  SELECT
    'punch_needs_review'::text            AS exception_kind,
    'warning'::text                       AS severity,
    'attendance_punches'::text            AS entity_table,
    p.id                                  AS entity_id,
    p.employee_id,
    p.effective_date                      AS ist_date,
    'Punch at ' || to_char(util.ist_ts(p.punched_at), 'DD Mon HH24:MI')
      || ' needs review (' || p.source::text || ')' AS description,
    p.recorded_at                         AS occurred_at
  FROM public.attendance_punches p
  WHERE p.needs_review AND NOT p.is_voided

  UNION ALL
  -- 9.2 attendance days with anomaly flags (unlocked only)
  SELECT
    'attendance_anomaly', 'warning', 'attendance_days', ad.id,
    ad.employee_id, ad.ist_date,
    'Anomalies: ' || array_to_string(ad.anomaly_flags, ', '),
    ad.computed_at
  FROM public.attendance_days ad
  WHERE cardinality(ad.anomaly_flags) > 0 AND NOT ad.is_locked

  UNION ALL
  -- 9.3 overtime awaiting approval
  SELECT
    'unapproved_overtime', 'info', 'attendance_days', ad.id,
    ad.employee_id, ad.ist_date,
    'Overtime ' || public.fn_minutes_hm(ad.overtime_minutes)
      || ' recorded, ' || public.fn_minutes_hm(ad.approved_overtime_minutes) || ' approved',
    ad.computed_at
  FROM public.attendance_days ad
  WHERE ad.overtime_minutes > ad.approved_overtime_minutes AND NOT ad.is_locked

  UNION ALL
  -- 9.4 payable employees without an active bank account
  SELECT
    'missing_bank_account', 'critical', 'employees', e.id,
    e.id, util.ist_today(),
    'No active bank account on file (payment mode: bank transfer)',
    e.updated_at
  FROM public.employees e
  WHERE e.deleted_at IS NULL
    AND e.employment_status IN ('active','confirmed','on_probation','on_notice')
    AND NOT e.exclude_from_payroll
    AND e.payment_mode = 'bank_transfer'
    AND NOT EXISTS (
      SELECT 1 FROM public.employee_bank_accounts b
      WHERE b.employee_id = e.id AND b.is_active)

  UNION ALL
  -- 9.5 expired documents
  SELECT
    'document_expired', 'warning', 'documents', doc.id,
    doc.employee_id, doc.expiry_date,
    'Document "' || doc.title || '" expired on ' || to_char(doc.expiry_date, 'DD Mon YYYY'),
    doc.updated_at
  FROM public.documents doc
  WHERE doc.deleted_at IS NULL
    AND doc.expiry_date IS NOT NULL
    AND doc.expiry_date < util.ist_today()
    AND doc.status NOT IN ('superseded','archived','rejected')

  UNION ALL
  -- 9.6 unresolved SLA breaches
  SELECT
    'sla_breach', 'critical', 'sla_breaches', sb.id,
    sb.approver_id, util.ist_date(sb.breached_at),
    'Approval level ' || sb.level || ' overdue by '
      || COALESCE(round(sb.hours_overdue, 1)::text, '?') || ' h',
    sb.breached_at
  FROM public.sla_breaches sb
  WHERE sb.resolved_at IS NULL

  UNION ALL
  -- 9.7 kiosk offline (active device silent for 15+ minutes)
  SELECT
    'kiosk_offline', 'critical', 'kiosk_devices', kd.id,
    NULL::uuid, util.ist_today(),
    'Kiosk ' || kd.device_code || ' (' || kd.label || ') last seen '
      || COALESCE(to_char(util.ist_ts(kd.last_seen_at), 'DD Mon HH24:MI'), 'never'),
    COALESCE(kd.last_seen_at, kd.enrolled_at)
  FROM public.kiosk_devices kd
  WHERE kd.is_active AND kd.revoked_at IS NULL AND kd.deleted_at IS NULL
    AND (kd.last_seen_at IS NULL OR kd.last_seen_at < now() - interval '15 minutes')

  UNION ALL
  -- 9.8 negative net pay in a live run
  SELECT
    'negative_net_pay', 'critical', 'payslips', ps.id,
    ps.employee_id, ps.period_end,
    'Net pay is negative: ' || (ps.net_pay_paise / 100.0)::text || ' INR',
    ps.updated_at
  FROM public.payslips ps
  JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
  WHERE ps.net_pay_paise < 0
    AND pr.status NOT IN ('cancelled','closed')
) q
WHERE app.is_admin()
  AND (q.employee_id IS NULL OR app.admin_scope_covers(q.employee_id));

COMMENT ON VIEW public.v_exception_queue IS
  '§9.3 union of every open exception — punches needing review, anomaly days, unapproved OT, missing bank accounts, expired documents, SLA breaches, kiosk offline, negative net pay. Admin-scoped.';

-- -----------------------------------------------------------------------------
-- 10. Grants
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.v_attendance_day_enriched, public.v_attendance_punch_detail,
  public.v_attendance_period_summary, public.v_attendance_today_board,
  public.v_attendance_hour_buckets, public.v_attendance_late_trend,
  public.v_attendance_in_trend, public.v_break_trend, public.v_exception_queue
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.v_attendance_day_enriched, public.v_attendance_punch_detail,
      public.v_attendance_period_summary, public.v_attendance_today_board,
      public.v_attendance_hour_buckets, public.v_attendance_late_trend,
      public.v_attendance_in_trend, public.v_break_trend, public.v_exception_queue
    FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON
      public.v_attendance_day_enriched, public.v_attendance_punch_detail,
      public.v_attendance_period_summary, public.v_attendance_today_board,
      public.v_attendance_hour_buckets, public.v_attendance_late_trend,
      public.v_attendance_in_trend, public.v_break_trend, public.v_exception_queue
    TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON
      public.v_attendance_day_enriched, public.v_attendance_punch_detail,
      public.v_attendance_period_summary, public.v_attendance_today_board,
      public.v_attendance_hour_buckets, public.v_attendance_late_trend,
      public.v_attendance_in_trend, public.v_break_trend, public.v_exception_queue
    TO service_role;
  END IF;
END $$;

COMMIT;
