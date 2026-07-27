-- =============================================================================
-- Migration 057 — make the scheduled jobs actually work.
--
-- The pg_cron registry (041) has been live since deploy, and cron.job_run_details
-- shows two silent-failure classes, both found while investigating why the
-- reporting-closure matview was empty:
--
--   1. `matview_refresh` and `team_hierarchy_refresh` run
--      `SELECT public.refresh_analytics('mv_…')` — a function 041's comments
--      attribute to migration 031, WHICH NEVER CREATED IT. The real entry point
--      is `analytics.refresh_matview(text)` (036). Every 15-minute run since
--      deploy has failed with "function does not exist", which is why
--      `mv_team_hierarchy` was empty and every manager saw a zero-person team
--      until a manual `analytics.refresh_all()`.
--   2. The pg_net notifier jobs build their URL as
--      `app.setting('edge_base_url') || '/cron-…'` — and no `edge_base_url`
--      settings row was ever seeded, so `url` is NULL and net.http_post's
--      insert into net.http_request_queue violates NOT NULL. Every reminder
--      job (probation, contracts, documents, comp-off, birthdays) has failed
--      since deploy.
--
-- This migration creates the missing wrapper — so the deployed schedules work
-- unchanged — and seeds the URL setting. The `cron_secret` Vault secret is NOT
-- written here (a committed migration must never carry a secret); it is
-- provisioned directly, and app.secret() returning NULL keeps the header NULL
-- (pg_net accepts a null header value; the receiving function rejects with 401,
-- which is at least VISIBLE, unlike the NULL-url insert failure).
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 057: repair cron jobs — missing refresh_analytics wrapper and edge_base_url setting', true);
SELECT set_config('app.source', 'migration', true);

-- 1. The wrapper 041's schedules were written against.
CREATE OR REPLACE FUNCTION public.refresh_analytics(p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM analytics.refresh_matview(p_name);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_analytics(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refresh_analytics(text) IS
  'Wrapper the pg_cron entries call (041). Delegates to analytics.refresh_matview; 041 documented this as created by 031, which never did — every scheduled refresh failed until 057.';

-- 2. The edge-function base URL the notifier jobs concatenate.
INSERT INTO public.settings (company_id, key, value, value_kind, scope, label, description, group_name, is_sensitive, is_editable_by_admin)
SELECT c.id,
       'edge_base_url',
       to_jsonb('https://xfoeudhwxlbkkwetncjb.supabase.co/functions/v1'::text),
       'string',
       'global',
       'Edge function base URL',
       'Base URL pg_cron jobs POST to (pg_net). Project-specific; migrations to another project must update it.',
       'system',
       false,
       false
  FROM public.companies c
 ORDER BY c.created_at
 LIMIT 1
ON CONFLICT DO NOTHING;

-- Belt and braces: if a row already existed with a NULL/blank value, fix it.
UPDATE public.settings
   SET value = to_jsonb('https://xfoeudhwxlbkkwetncjb.supabase.co/functions/v1'::text)
 WHERE key = 'edge_base_url'
   AND (value IS NULL OR value #>> '{}' = '');

COMMIT;
