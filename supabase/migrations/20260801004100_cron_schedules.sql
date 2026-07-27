-- =============================================================================
-- 041 — CRON SCHEDULES (docs/plan/04-data-model.md §8.9, §9.4; 08-architecture §7)
-- =============================================================================
-- Registers every scheduled job twice:
--   1. public.cron_jobs — the registry the admin console reads (031).
--   2. cron.schedule    — the actual pg_cron entries (guarded: skipped on a
--      vanilla-Postgres validation harness without pg_cron).
--
-- The database timezone is UTC. EVERY schedule string below is written in UTC
-- with the IST intent recorded in schedule_human (IST = UTC+5:30, no DST).
--   e.g. 04:00 IST daily  ->  '30 22 * * *'
--
-- Targets:
--   sql_function  — the command calls the function directly.
--   edge_function — the command POSTs via pg_net with x-cron-secret, per
--                   08-architecture §7.1. Base URL and secret are resolved at
--                   RUN time through app.setting()/app.secret(), so this
--                   migration carries no project-specific values.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Runtime config helpers used inside cron command strings (08-arch §7.1).
--    Not part of the 002/005/006 helper contract; owned by this migration.
-- -----------------------------------------------------------------------------

-- app.setting: read a (global-scoped first) settings value as text.
CREATE OR REPLACE FUNCTION app.setting(p_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN (
    SELECT s.value #>> '{}'
    FROM public.settings s
    WHERE s.key = p_key
    ORDER BY (s.scope = 'global') DESC
    LIMIT 1
  );
EXCEPTION
  WHEN undefined_table THEN
    RETURN NULL;
END;
$$;

-- app.secret: read a named secret from Supabase Vault; NULL when unavailable
-- (vanilla harness, or the secret has not been provisioned yet).
CREATE OR REPLACE FUNCTION app.secret(p_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_val text;
BEGIN
  BEGIN
    EXECUTE 'SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds WHERE ds.name = $1 LIMIT 1'
      INTO v_val USING p_key;
  EXCEPTION WHEN OTHERS THEN
    v_val := NULL;
  END;
  RETURN v_val;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.setting(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.secret(text)  FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. cron_jobs registry rows (one per job; mirrors pg_cron for the admin UI)
-- -----------------------------------------------------------------------------

INSERT INTO public.cron_jobs
  (code, name, description, schedule_cron, schedule_human,
   target, target_name, payload, is_enabled, timeout_seconds,
   overlap_policy, alert_on_failure, alert_after_consecutive_failures)
VALUES
  ('attendance_queue_drain', 'Attendance queue drain',
   'Drains attendance_recompute_queue (§7.5).',
   '* * * * *', 'Every minute',
   'sql_function', 'public.drain_attendance_recompute_queue', NULL, true, 45,
   'skip', true, 2),

  ('kiosk_health_sweep', 'Kiosk health sweep',
   'last_seen_at older than 10 min => KIOSK_OFFLINE alert + system_health row; flags clock_skew_seconds > 120.',
   '*/5 * * * *', 'Every 5 minutes',
   'edge_function', 'cron-integrity', jsonb_build_object('tasks', 'kiosk_health'), true, 60,
   'skip', true, 2),

  ('approval_sla_sweep', 'Approval SLA sweep',
   'Writes sla_breaches, notifies, escalates per approval_chain_levels.escalate_to_kind.',
   '*/30 * * * *', 'Every 30 minutes',
   'sql_function', 'public.sla_sweep', NULL, true, 120,
   'skip', true, 2),

  ('mark_absent_days', 'Mark absent days',
   'For yesterday: compute_attendance_day for every active employee with no row or pending status, flipping to absent past the delay. Enqueues NO_SHOW_ALERT.',
   '30 22 * * *', 'Daily at 04:00 IST',
   'sql_function', 'public.mark_absent_days', NULL, true, 300,
   'skip', true, 2),

  ('missing_out_punch_sweep', 'Missing OUT-punch sweep',
   'Days with no_out_punch => PUNCH_MISSING_OUT to employee + manager with one-tap regularize deep link.',
   '30 16,21 * * *', 'Daily at 22:00 and 03:00 IST',
   'edge_function', 'cron-daily-attendance-close', jsonb_build_object('task', 'missing_out'), true, 180,
   'skip', true, 2),

  ('probation_due', 'Probation confirmations due',
   'confirmation_due_date in {30,15,7,0} days => notify manager + HR; overdue > 15 days escalates to department head.',
   '30 3 * * *', 'Daily at 09:00 IST',
   'edge_function', 'cron-expiry-reminders', jsonb_build_object('classes', 'probation'), true, 120,
   'skip', true, 2),

  ('contract_expiry', 'Contract expiry reminders',
   'employees.contract_end_date in {60,30,15,7} days => notify HR + manager.',
   '35 3 * * *', 'Daily at 09:05 IST',
   'edge_function', 'cron-expiry-reminders', jsonb_build_object('classes', 'contract'), true, 120,
   'skip', true, 2),

  ('document_expiry', 'Document expiry reminders',
   'documents.expiry_date, employee_identity_documents.expiry_date, employee_qualifications licence expiry vs document_types.expiry_reminder_days. Includes FSSAI and fire-safety certificates (venue-critical).',
   '40 3 * * *', 'Daily at 09:10 IST',
   'edge_function', 'cron-expiry-reminders',
   jsonb_build_object('classes', 'document,identity,licence,fssai,fire_safety,insurance'), true, 180,
   'skip', true, 2),

  ('comp_off_expiring', 'Comp-off expiring notices',
   'Notifies at -14/-7/-1 days before comp-off expiry (COMP_OFF_EXPIRING).',
   '45 3 * * *', 'Daily at 09:15 IST',
   'edge_function', 'cron-expiry-reminders', jsonb_build_object('classes', 'compoff'), true, 120,
   'skip', true, 2),

  ('leave_balance_lapsing', 'Leave balance lapsing notices',
   'Days that will lapse at FY end.',
   '50 3 1 1,2,3 *', '09:20 IST on the 1st of Jan/Feb/Mar',
   'edge_function', 'cron-expiry-reminders', jsonb_build_object('classes', 'leave_lapse'), true, 120,
   'skip', true, 2),

  ('birthday_anniversary', 'Birthday / anniversary greetings',
   'Uses date_of_birth_actual when present; day+month only.',
   '30 2 * * *', 'Daily at 08:00 IST',
   'edge_function', 'cron-expiry-reminders', jsonb_build_object('classes', 'celebration'), true, 120,
   'skip', false, 2),

  ('roster_publish_reminder', 'Roster publish reminder',
   'If next week''s roster is unpublished for any operational department.',
   '30 5 * * 3', 'Wednesdays at 11:00 IST',
   'edge_function', 'cron-expiry-reminders', jsonb_build_object('classes', 'roster'), true, 120,
   'skip', true, 2),

  ('audit_seal', 'Audit chain daily seal',
   'Writes an audit_seals row with the terminal hash for the previous IST day, emails it to the designated partner, verifies the chain (§5.6).',
   '45 20 * * *', 'Daily at 02:15 IST',
   'edge_function', 'cron-integrity', jsonb_build_object('tasks', 'seal,verify_chain'), true, 300,
   'skip', true, 2),

  ('balance_drift_check', 'Leave balance drift check',
   'Recomputes every leave balance and raises a system_health row for any mismatch (§8.2).',
   '15 21 * * *', 'Daily at 02:45 IST',
   'edge_function', 'cron-integrity', jsonb_build_object('tasks', 'balance_drift'), true, 180,
   'skip', true, 2),

  ('partition_maintenance', 'Partition maintenance',
   'Creates next-3-months partitions for attendance_punches, audit_log, secure.face_match_log. A missing partition breaks inserts.',
   '30 21 24 * *', 'Monthly: 03:00 IST on the 25th',
   'sql_function', 'public.partition_maintenance', NULL, true, 300,
   'skip', true, 2),

  ('retention_sweep', 'Retention sweep',
   'Nulls face_match_log.candidate_scores > 90 days, deletes kiosk punch photos past settings.kiosk.retain_punch_photos_days, archives audit partitions > 25 months, purges webauthn_challenges, expires signed URLs. Every deletion writes audit_log.',
   '0 22 * * *', 'Daily at 03:30 IST',
   'sql_function', 'public.retention_sweep', NULL, true, 600,
   'skip', true, 2),

  ('biometric_purge', 'Biometric purge (manual)',
   'Super-admin initiated: for exited employees past retention, overwrite descriptor with zeros, set purged_at, write audit_log action=purge_biometric and a data_access_log row. Never scheduled.',
   'manual', 'Manual (super-admin initiated only)',
   'edge_function', 'admin-biometric-purge', NULL, false, 300,
   'skip', true, 2),

  ('leave_accrual', 'Monthly leave accrual',
   'Runs accrue_leave for the month (§8.4). Daily UTC schedule with an IST first-of-month guard (19:30 UTC = 01:00 IST next day).',
   '30 19 * * *', 'Monthly at 01:00 IST on the 1st (daily UTC schedule + day guard)',
   'sql_function', 'public.accrue_leave', NULL, true, 300,
   'skip', true, 2),

  ('comp_off_expiry', 'Comp-off expiry',
   'Expires comp-off credits past expires_on; writes leave_ledger comp_off_expiry entries (§8.3).',
   '0 20 * * *', 'Daily at 01:30 IST',
   'sql_function', 'public.expire_comp_off', NULL, true, 120,
   'skip', true, 2),

  ('payroll_reminder', 'Payroll cutoff reminder',
   'Nudges HR to resolve exceptions before the lock. Fires only when today = attendance_cutoff_date - 2 (guard inside the command).',
   '30 3 * * *', 'Daily at 09:00 IST; delivers only on cutoff - 2',
   'edge_function', 'communication-send', jsonb_build_object('template', 'payroll_cutoff'), true, 60,
   'skip', true, 2),

  -- Analytics matview refreshes (§9.4 schedules; refresh_analytics lives in 031)
  ('matview_refresh', 'Refresh mv_attendance_monthly',
   'Concurrent refresh of analytics.mv_attendance_monthly (also refreshed on attendance lock / payroll compute).',
   '*/15 * * * *', 'Every 15 minutes',
   'sql_function', 'public.refresh_analytics', jsonb_build_object('matview', 'mv_attendance_monthly'), true, 240,
   'skip', true, 2),

  ('team_hierarchy_refresh', 'Refresh mv_team_hierarchy',
   'Concurrent refresh of analytics.mv_team_hierarchy (also refreshed on manager change).',
   '10 * * * *', 'Hourly at :10',
   'sql_function', 'public.refresh_analytics', jsonb_build_object('matview', 'mv_team_hierarchy'), true, 120,
   'skip', true, 2),

  ('payroll_cost_refresh', 'Refresh mv_payroll_cost_monthly',
   'Concurrent refresh of analytics.mv_payroll_cost_monthly (also refreshed after each payroll run).',
   '0 21 * * *', 'Daily at 02:30 IST',
   'sql_function', 'public.refresh_analytics', jsonb_build_object('matview', 'mv_payroll_cost_monthly'), true, 240,
   'skip', true, 2),

  ('headcount_snapshot', 'Refresh mv_headcount_daily',
   'Nightly refresh of analytics.mv_headcount_daily.',
   '30 20 * * *', 'Daily at 02:00 IST',
   'sql_function', 'public.refresh_analytics', jsonb_build_object('matview', 'mv_headcount_daily'), true, 180,
   'skip', true, 2)

ON CONFLICT (code) DO UPDATE SET
  name             = EXCLUDED.name,
  description      = EXCLUDED.description,
  schedule_cron    = EXCLUDED.schedule_cron,
  schedule_human   = EXCLUDED.schedule_human,
  target           = EXCLUDED.target,
  target_name      = EXCLUDED.target_name,
  payload          = EXCLUDED.payload,
  is_enabled       = EXCLUDED.is_enabled,
  timeout_seconds  = EXCLUDED.timeout_seconds,
  overlap_policy   = EXCLUDED.overlap_policy,
  alert_on_failure = EXCLUDED.alert_on_failure,
  alert_after_consecutive_failures = EXCLUDED.alert_after_consecutive_failures;

-- -----------------------------------------------------------------------------
-- 3. pg_cron entries (guarded; cron.schedule upserts by job name)
-- -----------------------------------------------------------------------------

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron unavailable — cron schedules skipped (vanilla Postgres harness)';
    RETURN;
  END IF;

  -- ── DB-function jobs ───────────────────────────────────────────────────────

  PERFORM cron.schedule('attendance_queue_drain', '* * * * *',
    $cmd$SELECT public.drain_attendance_recompute_queue();$cmd$);

  PERFORM cron.schedule('approval_sla_sweep', '*/30 * * * *',
    $cmd$SELECT public.sla_sweep();$cmd$);

  PERFORM cron.schedule('mark_absent_days', '30 22 * * *',
    $cmd$SELECT public.mark_absent_days();$cmd$);

  PERFORM cron.schedule('comp_off_expiry', '0 20 * * *',
    $cmd$SELECT public.expire_comp_off();$cmd$);

  -- 19:30 UTC = 01:00 IST the NEXT day; the guard fires the accrual only when
  -- that IST day is the 1st of the month.
  PERFORM cron.schedule('leave_accrual', '30 19 * * *',
    $cmd$SELECT public.accrue_leave(util.ist_today()) WHERE extract(day FROM util.ist_today()) = 1;$cmd$);

  -- 21:30 UTC on the 24th = 03:00 IST on the 25th.
  PERFORM cron.schedule('partition_maintenance', '30 21 24 * *',
    $cmd$SELECT public.partition_maintenance();$cmd$);

  PERFORM cron.schedule('retention_sweep', '0 22 * * *',
    $cmd$SELECT public.retention_sweep();$cmd$);

  PERFORM cron.schedule('matview_refresh', '*/15 * * * *',
    $cmd$SELECT public.refresh_analytics('mv_attendance_monthly');$cmd$);

  PERFORM cron.schedule('team_hierarchy_refresh', '10 * * * *',
    $cmd$SELECT public.refresh_analytics('mv_team_hierarchy');$cmd$);

  PERFORM cron.schedule('payroll_cost_refresh', '0 21 * * *',
    $cmd$SELECT public.refresh_analytics('mv_payroll_cost_monthly');$cmd$);

  PERFORM cron.schedule('headcount_snapshot', '30 20 * * *',
    $cmd$SELECT public.refresh_analytics('mv_headcount_daily');$cmd$);

  -- ── Edge-function jobs (pg_net POST with x-cron-secret, 08-arch §7.1) ──────

  PERFORM cron.schedule('kiosk_health_sweep', '*/5 * * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-integrity?tasks=kiosk_health',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','kiosk_health_sweep'),
      timeout_milliseconds := 60000);$cmd$);

  PERFORM cron.schedule('missing_out_punch_sweep', '30 16,21 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-daily-attendance-close?task=missing_out',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','missing_out_punch_sweep'),
      timeout_milliseconds := 180000);$cmd$);

  PERFORM cron.schedule('probation_due', '30 3 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=probation',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','probation_due'),
      timeout_milliseconds := 120000);$cmd$);

  PERFORM cron.schedule('contract_expiry', '35 3 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=contract',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','contract_expiry'),
      timeout_milliseconds := 120000);$cmd$);

  PERFORM cron.schedule('document_expiry', '40 3 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=document,identity,licence,fssai,fire_safety,insurance',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','document_expiry'),
      timeout_milliseconds := 180000);$cmd$);

  PERFORM cron.schedule('comp_off_expiring', '45 3 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=compoff',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','comp_off_expiring'),
      timeout_milliseconds := 120000);$cmd$);

  PERFORM cron.schedule('leave_balance_lapsing', '50 3 1 1,2,3 *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=leave_lapse',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','leave_balance_lapsing'),
      timeout_milliseconds := 120000);$cmd$);

  PERFORM cron.schedule('birthday_anniversary', '30 2 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=celebration',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','birthday_anniversary'),
      timeout_milliseconds := 120000);$cmd$);

  PERFORM cron.schedule('roster_publish_reminder', '30 5 * * 3',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-expiry-reminders?classes=roster',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','roster_publish_reminder'),
      timeout_milliseconds := 120000);$cmd$);

  PERFORM cron.schedule('audit_seal', '45 20 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-integrity?tasks=seal,verify_chain',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','audit_seal'),
      timeout_milliseconds := 300000);$cmd$);

  PERFORM cron.schedule('balance_drift_check', '15 21 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/cron-integrity?tasks=balance_drift',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','balance_drift_check'),
      timeout_milliseconds := 180000);$cmd$);

  -- Fires daily; delivers only when today (IST) = attendance cutoff - 2.
  PERFORM cron.schedule('payroll_reminder', '30 3 * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/communication-send',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','payroll_reminder','template','payroll_cutoff'),
      timeout_milliseconds := 60000)
    WHERE EXISTS (SELECT 1 FROM public.pay_periods pp
                  WHERE pp.attendance_cutoff_date - 2 = util.ist_today());$cmd$);

  -- biometric_purge: manual only (super-admin) — deliberately NOT scheduled.

  RAISE NOTICE 'pg_cron schedules registered';
END;
$do$;

COMMIT;
