-- =============================================================================
-- Migration 037 — governance, compliance & AI-context views (§9.3)
-- Source: docs/plan/04-data-model.md §9.2/§9.3; base columns from
--         006/012/013/016/017/025/028/029/030.
--
-- Security:
--   * v_approval_inbox / v_approval_sla / v_policy_acknowledgement_status /
--     v_asset_custody / v_audit_trail_employee run security_invoker=true —
--     their base tables carry the right RLS (029/025/028/006).
--   * v_kiosk_health and v_enrolment_coverage read secure.* (zero-grant
--     schema) and are therefore owner-executed with an app.is_admin() gate —
--     the same pattern 012 established for v_face_match_audit.
--   * v_my_data_access is owner-executed: data_access_log RLS is admin-only
--     (006), yet §4.4 grants every employee sight of accesses to THEIR data.
--   * v_ai_context_* are owner-executed and are the ONLY relations the AI
--     agent may read in each scope (§9.3); their predicates pin the scope.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. v_kiosk_health — per device per day (§9.2 Kiosk Success Rate / p95)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_kiosk_health
WITH (security_barrier = true) AS
SELECT
  kd.id            AS kiosk_device_id,
  kd.device_code,
  kd.label,
  fml.ist_date,
  COUNT(*)::integer                                              AS total_attempts,
  COUNT(*) FILTER (WHERE fml.outcome = 'matched')::integer       AS matched,
  COUNT(*) FILTER (WHERE fml.outcome = 'no_match')::integer      AS no_match,
  COUNT(*) FILTER (WHERE fml.outcome = 'ambiguous')::integer     AS ambiguous,
  COUNT(*) FILTER (WHERE fml.outcome = 'liveness_failed')::integer AS liveness_failures,
  COUNT(*) FILTER (WHERE fml.outcome IN
    ('no_face','multiple_faces','low_quality'))::integer         AS capture_failures,
  COUNT(*) FILTER (WHERE fml.outcome = 'error')::integer         AS errors,
  COUNT(*) FILTER (WHERE fml.outcome = 'duplicate_suppressed')::integer AS duplicates_suppressed,
  -- §9.2: matched * 100.0 / NULLIF(total_attempts, 0)
  ROUND(COUNT(*) FILTER (WHERE fml.outcome = 'matched') * 100.0
        / NULLIF(COUNT(*), 0), 2)                                AS match_success_pct,
  percentile_disc(0.5)  WITHIN GROUP (ORDER BY fml.latency_ms)   AS p50_latency_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY fml.latency_ms)   AS p95_latency_ms,
  COALESCE(pr.offline_replays, 0)                                AS offline_replays,
  kd.last_seen_at,
  kd.clock_skew_seconds,
  kd.is_active,
  kd.app_version
FROM secure.face_match_log fml
JOIN public.kiosk_devices kd ON kd.id = fml.kiosk_device_id
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS offline_replays
  FROM public.attendance_punches p
  WHERE p.kiosk_device_id = kd.id
    AND p.effective_date = fml.ist_date
    AND p.is_offline_replay
    AND NOT p.is_voided
) pr ON true
WHERE app.is_admin()
GROUP BY kd.id, kd.device_code, kd.label, fml.ist_date, pr.offline_replays,
         kd.last_seen_at, kd.clock_skew_seconds, kd.is_active, kd.app_version;

COMMENT ON VIEW public.v_kiosk_health IS
  '§9.3: per device per day over secure.face_match_log (owner-executed, admin-gated). Candidate scores are NOT here — super-admins use reveal_face_match_candidates (032).';

-- -----------------------------------------------------------------------------
-- 2. v_enrolment_coverage — the operational gap list (§9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_enrolment_coverage
WITH (security_barrier = true) AS
SELECT
  e.id AS employee_id,
  e.employee_code,
  e.display_name,
  e.department_id,
  d.name AS department_name,
  e.date_of_join,
  (bc.id IS NOT NULL)                        AS has_active_consent,
  bc.granted_at                              AS consent_granted_at,
  (wd.id IS NOT NULL)                        AS consent_withdrawn,
  (ft.id IS NOT NULL)                        AS has_active_template,
  e.face_enrolled_at,
  CASE
    WHEN wd.id IS NOT NULL                   THEN 'consent_withdrawn'
    WHEN bc.id IS NULL                       THEN 'no_consent'
    WHEN ft.id IS NULL                       THEN 'consented_not_enrolled'
  END AS gap_kind
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
LEFT JOIN LATERAL (
  SELECT c.id, c.granted_at
  FROM secure.biometric_consents c
  WHERE c.employee_id = e.id
    AND c.modality IN ('face','both')
    AND c.granted
    AND c.withdrawn_at IS NULL
  ORDER BY c.granted_at DESC
  LIMIT 1
) bc ON true
LEFT JOIN LATERAL (
  SELECT c.id
  FROM secure.biometric_consents c
  WHERE c.employee_id = e.id
    AND c.modality IN ('face','both')
    AND c.withdrawn_at IS NOT NULL
  ORDER BY c.withdrawn_at DESC
  LIMIT 1
) wd ON (bc.id IS NULL)
LEFT JOIN secure.face_templates ft
       ON ft.employee_id = e.id AND ft.is_active
WHERE e.deleted_at IS NULL
  AND e.employment_status IN ('active','confirmed','on_probation','on_notice')
  AND NOT e.exclude_from_attendance
  AND (bc.id IS NULL OR ft.id IS NULL)
  AND app.is_admin();

COMMENT ON VIEW public.v_enrolment_coverage IS
  '§9.3: employees without an active face template or consent, by department. A withdrawn consent is a distinct gap_kind — those employees use the alternative punch method, never a nag.';

-- -----------------------------------------------------------------------------
-- 3. v_approval_inbox — pending approvals for the current actor (§9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_approval_inbox
WITH (security_invoker = true) AS
SELECT
  ar.id             AS approval_request_id,
  ar.request_number,
  ar.request_type_id,
  rt.code           AS request_type_code,
  rt.name           AS request_type_name,
  rt.icon,
  ar.title,
  ar.summary,
  ar.amount,
  ar.days,
  ar.priority,
  ar.status,
  ar.current_level,
  ar.total_levels,
  ar.subject_employee_id,
  er.employee_code  AS subject_employee_code,
  er.display_name   AS subject_display_name,
  er.photo_path     AS subject_photo_path,
  er.department_name AS subject_department_name,
  ar.submitted_at,
  ar.sla_due_at,
  ROUND(EXTRACT(EPOCH FROM (ar.sla_due_at - now())) / 3600.0, 1) AS sla_remaining_hours,
  (now() > ar.sla_due_at)                                        AS is_overdue,
  ROUND(EXTRACT(EPOCH FROM (now() - ar.submitted_at)) / 3600.0, 1) AS age_hours,
  ar.escalated_at
FROM public.approval_requests ar
JOIN public.request_types rt ON rt.id = ar.request_type_id
LEFT JOIN public.v_employee_ref er ON er.id = ar.subject_employee_id
WHERE ar.status IN ('pending','in_progress','escalated')
  AND app.current_employee_id() = ANY (ar.current_approver_ids);

COMMENT ON VIEW public.v_approval_inbox IS
  '§9.3: the actor''s pending queue with SLA countdown. Uses the materialised current_approver_ids array (GIN idx_ar__approver_pending).';

-- -----------------------------------------------------------------------------
-- 4. v_approval_sla — per approver per request type (§9.2 on_time_pct)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_approval_sla
WITH (security_invoker = true) AS
SELECT
  er.id             AS approver_employee_id,
  er.employee_code  AS approver_employee_code,
  er.display_name   AS approver_display_name,
  rt.id             AS request_type_id,
  rt.code           AS request_type_code,
  rt.name           AS request_type_name,
  COUNT(*)::integer AS decided,
  COUNT(*) FILTER (WHERE aa.acted_at <= ar.sla_due_at)::integer AS on_time,
  COUNT(*) FILTER (WHERE aa.acted_at >  ar.sla_due_at)::integer AS breached,
  -- §9.2 Approval SLA Compliance %: on_time * 100.0 / NULLIF(decided, 0)
  ROUND(COUNT(*) FILTER (WHERE aa.acted_at <= ar.sla_due_at) * 100.0
        / NULLIF(COUNT(*), 0), 2)                               AS on_time_pct,
  -- mean of the exact decision-latency series
  ROUND(AVG(EXTRACT(EPOCH FROM (aa.acted_at - ar.submitted_at)) / 3600.0), 2)
                                                                AS avg_hours_to_decide
FROM public.approval_actions aa
JOIN public.approval_requests ar ON ar.id = aa.approval_request_id
JOIN public.request_types rt     ON rt.id = ar.request_type_id
JOIN public.v_employee_ref er    ON er.profile_id = aa.actor_id
WHERE aa.action IN ('approve','reject')
GROUP BY er.id, er.employee_code, er.display_name, rt.id, rt.code, rt.name;

-- -----------------------------------------------------------------------------
-- 5. v_document_compliance — required doc types missing / expired / expiring
--    in 60 days, per employee (§9.3). Owner-executed; scope = can_see_employee
--    (self, team, scoped admin).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_document_compliance
WITH (security_barrier = true) AS
WITH required AS (
  SELECT e.id AS employee_id, dt.id AS document_type_id
  FROM public.employees e
  JOIN public.document_types dt
    ON dt.deleted_at IS NULL AND dt.is_active
   AND (   dt.is_required_for_onboarding
        OR (dt.required_for_employment_types IS NOT NULL
            AND e.employment_type = ANY (dt.required_for_employment_types))
        OR (dt.required_for_department_ids IS NOT NULL
            AND e.department_id = ANY (dt.required_for_department_ids)))
  WHERE e.deleted_at IS NULL
    AND e.employment_status IN ('active','confirmed','on_probation','on_notice')
)
SELECT
  r.employee_id,
  e.employee_code,
  e.display_name,
  e.department_id,
  d.name  AS department_name,
  r.document_type_id,
  dt.code AS document_type_code,
  dt.name AS document_type_name,
  dt.requires_expiry,
  doc.id  AS document_id,
  doc.status AS document_status,
  doc.expiry_date,
  CASE
    WHEN doc.id IS NULL                                    THEN 'missing'
    WHEN doc.expiry_date IS NOT NULL
     AND doc.expiry_date <  util.ist_today()               THEN 'expired'
    WHEN doc.expiry_date IS NOT NULL
     AND doc.expiry_date <= util.ist_today() + 60          THEN 'expiring_soon'
    ELSE 'valid'
  END AS compliance_status
FROM required r
JOIN public.employees e       ON e.id = r.employee_id
LEFT JOIN public.departments d ON d.id = e.department_id
JOIN public.document_types dt ON dt.id = r.document_type_id
LEFT JOIN LATERAL (
  SELECT dd.id, dd.status, dd.expiry_date
  FROM public.documents dd
  WHERE dd.employee_id = r.employee_id
    AND dd.document_type_id = r.document_type_id
    AND dd.deleted_at IS NULL
    AND dd.status IN ('approved','pending_review')
  ORDER BY COALESCE(dd.expiry_date, DATE '2099-12-31') DESC, dd.uploaded_at DESC
  LIMIT 1
) doc ON true
WHERE app.can_see_employee(r.employee_id);

-- -----------------------------------------------------------------------------
-- 6. v_policy_acknowledgement_status — per document (§9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_policy_acknowledgement_status
WITH (security_invoker = true) AS
SELECT
  d.id    AS document_id,
  d.title AS document_title,
  dt.code AS document_type_code,
  dt.name AS document_type_name,
  COUNT(da.id)::integer                                                     AS assigned,
  COUNT(da.id) FILTER (WHERE da.first_opened_at IS NOT NULL)::integer       AS opened,
  COUNT(da.id) FILTER (WHERE da.status = 'acknowledged')::integer           AS acknowledged,
  COUNT(da.id) FILTER (WHERE da.status = 'waived')::integer                 AS waived,
  COUNT(da.id) FILTER (WHERE da.status NOT IN ('acknowledged','waived')
                         AND da.due_on IS NOT NULL
                         AND da.due_on < util.ist_today())::integer         AS overdue,
  ROUND(COUNT(da.id) FILTER (WHERE da.status = 'acknowledged') * 100.0
        / NULLIF(COUNT(da.id), 0), 2)                                       AS acknowledged_pct,
  MIN(da.due_on) FILTER (WHERE da.status NOT IN ('acknowledged','waived'))  AS earliest_open_due_on
FROM public.documents d
JOIN public.document_types dt ON dt.id = d.document_type_id
LEFT JOIN public.document_acknowledgements da ON da.document_id = d.id
WHERE d.requires_acknowledgement
  AND d.deleted_at IS NULL
GROUP BY d.id, d.title, dt.code, dt.name;

-- -----------------------------------------------------------------------------
-- 7. v_asset_custody — current allocations with age and expected return (§9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_asset_custody
WITH (security_invoker = true) AS
SELECT
  aa.id AS allocation_id,
  aa.allocation_number,
  aa.asset_id,
  a.asset_tag,
  a.name AS asset_name,
  ac.name AS asset_category_name,
  a.serial_number,
  a.condition,
  aa.employee_id,
  er.employee_code,
  er.display_name,
  er.department_name,
  aa.quantity,
  aa.status,
  aa.allocated_at,
  (util.ist_today() - util.ist_date(aa.allocated_at))         AS days_in_custody,
  aa.acknowledged_at,
  aa.expected_return_date,
  (aa.expected_return_date IS NOT NULL
   AND aa.expected_return_date < util.ist_today())            AS is_return_overdue,
  aa.recall_requested_at
FROM public.asset_allocations aa
JOIN public.assets a ON a.id = aa.asset_id
LEFT JOIN public.asset_categories ac ON ac.id = a.asset_category_id
LEFT JOIN public.v_employee_ref er ON er.id = aa.employee_id
WHERE aa.status IN ('allocated','acknowledged','return_requested');

-- -----------------------------------------------------------------------------
-- 8. v_audit_trail_employee — everything ever done to one employee (§9.3)
--    security_invoker: audit_log RLS (admin-only, 006) decides visibility.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_audit_trail_employee
WITH (security_invoker = true) AS
SELECT
  al.id,
  al.subject_employee_id,
  er.employee_code   AS subject_employee_code,
  er.display_name    AS subject_display_name,
  al.occurred_at,
  al.ist_timestamp,
  to_char(al.ist_timestamp, 'DD Mon YYYY HH24:MI:SS') AS occurred_at_ist,
  al.actor_id,
  COALESCE(p.full_name, al.actor_email, 'system')     AS actor_name,
  al.actor_role,
  al.actor_source,
  al.action,
  al.entity_table,
  al.entity_id,
  al.entity_label,
  al.field_name,
  al.old_value,
  al.new_value,
  al.is_redacted,
  al.reason,
  al.approval_request_id,
  al.request_id
FROM public.audit_log al
LEFT JOIN public.profiles p ON p.id = al.actor_id
LEFT JOIN public.v_employee_ref er ON er.id = al.subject_employee_id
WHERE al.subject_employee_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 9. v_my_data_access — who read MY sensitive fields, when and why (§4.4/§9.3)
--    Owner-executed: base RLS is admin-only, but the subject has a statutory
--    right to see accesses to their own data.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_my_data_access
WITH (security_barrier = true) AS
SELECT
  dal.id,
  dal.accessed_at,
  to_char(util.ist_ts(dal.accessed_at), 'DD Mon YYYY HH24:MI') AS accessed_at_ist,
  COALESCE(p.full_name, 'system')  AS accessed_by,
  dal.actor_role,
  dal.actor_source,
  dal.entity_table,
  dal.fields,
  dal.access_kind,
  dal.purpose,
  dal.record_count
FROM public.data_access_log dal
LEFT JOIN public.profiles p ON p.id = dal.actor_id
WHERE dal.subject_employee_id = app.current_employee_id();

COMMENT ON VIEW public.v_my_data_access IS
  '§4.7: transparency surface — every reveal/export/report touching the caller''s own data, with the actor''s name and written purpose.';

-- -----------------------------------------------------------------------------
-- 10. v_ai_context_employee_self — the ONLY self-scope surface the AI agent
--     may read (§9.3): pre-joined, pre-labelled, one row for the caller.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_ai_context_employee_self
WITH (security_barrier = true) AS
SELECT
  e.id AS employee_id,
  e.employee_code,
  e.display_name,
  d.name  AS department_name,
  dg.name AS designation_name,
  e.employment_status,
  e.date_of_join,
  today.status                 AS today_status,
  to_char(util.ist_ts(today.first_in_at), 'HH24:MI') AS today_first_in,
  to_char(util.ist_ts(today.last_out_at), 'HH24:MI') AS today_last_out,
  today.total_worked_minutes   AS today_worked_minutes,
  mtd.paid_days                AS mtd_paid_days,
  mtd.present_days             AS mtd_present_days,
  mtd.late_days                AS mtd_late_days,
  mtd.late_pct                 AS mtd_late_pct,
  mtd.leave_days               AS mtd_leave_days,
  mtd.total_worked_minutes     AS mtd_worked_minutes,
  mtd.overtime_minutes         AS mtd_overtime_minutes,
  mtd.pending_days             AS mtd_pending_days,
  lv.balances                  AS leave_balances,
  co.available_days            AS comp_off_available_days,
  co.nearest_expiry            AS comp_off_nearest_expiry,
  slip.payslip_number          AS latest_payslip_number,
  slip.pay_period_name         AS latest_payslip_period,
  slip.net_pay_paise           AS latest_payslip_net_paise,
  appr.open_requests           AS my_open_requests
FROM public.employees e
LEFT JOIN public.departments  d  ON d.id  = e.department_id
LEFT JOIN public.designations dg ON dg.id = e.designation_id
LEFT JOIN public.attendance_days today
       ON today.employee_id = e.id AND today.ist_date = util.ist_today()
LEFT JOIN LATERAL (
  SELECT * FROM public.f_attendance_period_summary(
    date_trunc('month', util.ist_today())::date, util.ist_today(), e.id)
) mtd ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(lt.code, jsonb_build_object(
           'name', lt.name,
           'available', lb.available_days,
           'available_after_pending', lb.available_after_pending,
           'pending', lb.pending_days)) AS balances
  FROM public.leave_balances lb
  JOIN public.leave_types lt ON lt.id = lb.leave_type_id
  WHERE lb.employee_id = e.id
    AND lb.leave_year = public.leave_year_of(util.ist_today())
) lv ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(COALESCE(col.days_remaining, col.days)), 0) AS available_days,
         MIN(col.expires_on) AS nearest_expiry
  FROM public.comp_off_ledger col
  WHERE col.employee_id = e.id
    AND col.entry_type = 'earned'
    AND col.status IN ('available','partially_used')
    AND (col.expires_on IS NULL OR col.expires_on >= util.ist_today())
) co ON true
LEFT JOIN LATERAL (
  SELECT ps.payslip_number, pp.name AS pay_period_name, ps.net_pay_paise
  FROM public.payslips ps
  JOIN public.pay_periods pp ON pp.id = ps.pay_period_id
  WHERE ps.employee_id = e.id
    AND NOT ps.is_reversed
    AND public.payroll_run_is_released(ps.payroll_run_id)
  ORDER BY ps.period_start DESC
  LIMIT 1
) slip ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS open_requests
  FROM public.approval_requests ar
  WHERE ar.subject_employee_id = e.id
    AND ar.status IN ('pending','in_progress','escalated')
) appr ON true
WHERE e.id = app.current_employee_id()
  AND e.deleted_at IS NULL;

COMMENT ON VIEW public.v_ai_context_employee_self IS
  '§9.3: the only attendance/leave/salary surface the AI agent reads in self scope. Payslip figures appear only after the run is released — same rule as the payslip UI.';

-- -----------------------------------------------------------------------------
-- 11. v_ai_context_team — manager scope for the agent (§9.3). One row per
--     visible reportee; NO salary, NO bank, NO statutory columns.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_ai_context_team
WITH (security_barrier = true) AS
SELECT
  e.id AS employee_id,
  e.employee_code,
  e.display_name,
  d.name  AS department_name,
  dg.name AS designation_name,
  e.employment_status,
  e.date_of_join,
  today.status                AS today_status,
  today.is_late               AS today_is_late,
  to_char(util.ist_ts(today.first_in_at), 'HH24:MI') AS today_first_in,
  mtd.paid_days               AS mtd_paid_days,
  mtd.present_days            AS mtd_present_days,
  mtd.absent_days             AS mtd_absent_days,
  mtd.pending_days            AS mtd_pending_days,
  mtd.late_days               AS mtd_late_days,
  mtd.late_pct                AS mtd_late_pct,
  mtd.leave_days              AS mtd_leave_days,
  mtd.overtime_minutes        AS mtd_overtime_minutes,
  lv.total_available_days     AS leave_available_days_total,
  appr.open_requests          AS open_requests
FROM public.employees e
LEFT JOIN public.departments  d  ON d.id  = e.department_id
LEFT JOIN public.designations dg ON dg.id = e.designation_id
LEFT JOIN public.attendance_days today
       ON today.employee_id = e.id AND today.ist_date = util.ist_today()
LEFT JOIN LATERAL (
  SELECT * FROM public.f_attendance_period_summary(
    date_trunc('month', util.ist_today())::date, util.ist_today(), e.id)
) mtd ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(lb.available_days), 0) AS total_available_days
  FROM public.leave_balances lb
  WHERE lb.employee_id = e.id
    AND lb.leave_year = public.leave_year_of(util.ist_today())
) lv ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS open_requests
  FROM public.approval_requests ar
  WHERE ar.subject_employee_id = e.id
    AND ar.status IN ('pending','in_progress','escalated')
) appr ON true
WHERE e.deleted_at IS NULL
  AND (app.is_manager_of(e.id)
       OR (app.is_admin() AND app.admin_scope_covers(e.id)));

COMMENT ON VIEW public.v_ai_context_team IS
  '§9.3: AI agent team scope — the manager allowlist philosophy applies: attendance/leave aggregates only, never salary, bank, Aadhaar/PAN or documents.';

-- -----------------------------------------------------------------------------
-- 12. v_ai_context_org — admin scope for the agent (§9.3). Department-level
--     aggregates for today + this month; cost figures from the matview.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_ai_context_org
WITH (security_barrier = true) AS
SELECT
  d.id   AS department_id,
  d.code AS department_code,
  d.name AS department_name,
  hc.headcount,
  today.present_today,
  today.late_today,
  today.absent_today,
  today.on_leave_today,
  today.pending_today,
  appr.open_approvals,
  cost.total_cost_paise      AS last_period_cost_paise,
  cost.employee_count        AS last_period_paid_employees,
  cost.pay_period_code       AS last_period_code
FROM public.departments d
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS headcount
  FROM public.employees e
  WHERE e.department_id = d.id
    AND e.deleted_at IS NULL
    AND e.employment_status IN ('active','confirmed','on_probation','on_notice')
) hc ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE ad.status IN
      ('present','weekly_off_worked','holiday_worked','on_duty','work_from_home'))::integer AS present_today,
    COUNT(*) FILTER (WHERE ad.is_late)::integer                    AS late_today,
    COUNT(*) FILTER (WHERE ad.status = 'absent')::integer          AS absent_today,
    COUNT(*) FILTER (WHERE ad.status IN
      ('on_leave','on_leave_half','comp_off_availed'))::integer    AS on_leave_today,
    COUNT(*) FILTER (WHERE ad.status = 'pending')::integer         AS pending_today
  FROM public.attendance_days ad
  WHERE ad.department_id = d.id AND ad.ist_date = util.ist_today()
) today ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS open_approvals
  FROM public.approval_requests ar
  JOIN public.employees se ON se.id = ar.subject_employee_id
  WHERE se.department_id = d.id
    AND ar.status IN ('pending','in_progress','escalated')
) appr ON true
LEFT JOIN LATERAL (
  SELECT m.total_cost_paise, m.employee_count, m.pay_period_code
  FROM analytics.mv_payroll_cost_monthly m
  WHERE m.department_id = d.id
  ORDER BY m.year DESC, m.month DESC
  LIMIT 1
) cost ON true
WHERE d.deleted_at IS NULL
  AND app.is_admin();

COMMENT ON VIEW public.v_ai_context_org IS
  '§9.3: AI agent org scope — department aggregates only; person-level answers go through v_ai_context_team/self so scope rules hold.';

-- -----------------------------------------------------------------------------
-- 13. Grants
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.v_kiosk_health, public.v_enrolment_coverage,
  public.v_approval_inbox, public.v_approval_sla,
  public.v_document_compliance, public.v_policy_acknowledgement_status,
  public.v_asset_custody, public.v_audit_trail_employee, public.v_my_data_access,
  public.v_ai_context_employee_self, public.v_ai_context_team, public.v_ai_context_org
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.v_kiosk_health, public.v_enrolment_coverage,
      public.v_approval_inbox, public.v_approval_sla,
      public.v_document_compliance, public.v_policy_acknowledgement_status,
      public.v_asset_custody, public.v_audit_trail_employee, public.v_my_data_access,
      public.v_ai_context_employee_self, public.v_ai_context_team, public.v_ai_context_org
    FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON
      public.v_kiosk_health, public.v_enrolment_coverage,
      public.v_approval_inbox, public.v_approval_sla,
      public.v_document_compliance, public.v_policy_acknowledgement_status,
      public.v_asset_custody, public.v_audit_trail_employee, public.v_my_data_access,
      public.v_ai_context_employee_self, public.v_ai_context_team, public.v_ai_context_org
    TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON
      public.v_kiosk_health, public.v_enrolment_coverage,
      public.v_approval_inbox, public.v_approval_sla,
      public.v_document_compliance, public.v_policy_acknowledgement_status,
      public.v_asset_custody, public.v_audit_trail_employee, public.v_my_data_access,
      public.v_ai_context_employee_self, public.v_ai_context_team, public.v_ai_context_org
    TO service_role;
  END IF;
END $$;

COMMIT;
