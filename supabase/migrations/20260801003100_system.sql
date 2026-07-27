-- =============================================================================
-- Migration 031 — system domain
-- Source: docs/plan/04-data-model.md §3.16 (settings, feature_flags,
--         integrations, cron_jobs, job_runs, system_health, import_batches,
--         import_rows), §12.4 (partition maintenance), §9.4 (refresh
--         strategy); spec-migrations §2 row 031.
--
-- Also creates the two primitives the edge-function _shared layer depends on
-- (spec-architecture §4): public.idempotency_keys and app.rate_limit_take().
-- Both are service-role only — no client grants at all.
--
-- IST scheduling note (§3.16): the database timezone is UTC and every
-- pg_cron schedule string is written in UTC, with the IST intent recorded in
-- cron_jobs.schedule_human (04:00 IST = '30 22 * * *' UTC). IST has no DST.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. settings
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.settings (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  key                   text NOT NULL,
  value                 jsonb NOT NULL,
  value_kind            text NOT NULL DEFAULT 'string',
  scope                 text NOT NULL DEFAULT 'company',
  scope_id              uuid,
  label                 text,
  description           text,
  group_name            text,
  is_sensitive          boolean NOT NULL DEFAULT false,
  is_editable_by_admin  boolean NOT NULL DEFAULT true,
  validation            jsonb,
  default_value         jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_settings__value_kind CHECK (value_kind IN
    ('string','number','boolean','json','date','time','duration_minutes','money')),
  CONSTRAINT ck_settings__scope CHECK (scope IN ('global','company','location','department')),
  CONSTRAINT ck_settings__group CHECK (group_name IS NULL OR group_name IN
    ('attendance','payroll','leave','notifications','security','ai','branding','kiosk','system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_settings__key_scope
  ON public.settings (company_id, key, scope,
                      coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_settings__group ON public.settings (group_name);

CREATE TRIGGER trg_settings__stamp BEFORE INSERT ON public.settings
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_settings__touch BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- P7 read for non-sensitive; P8 write; P9 when is_editable_by_admin = false.
DROP POLICY IF EXISTS settings__read ON public.settings;
CREATE POLICY settings__read ON public.settings
  FOR SELECT TO authenticated
  USING (NOT is_sensitive OR app.is_admin());

DROP POLICY IF EXISTS settings__admin_write ON public.settings;
CREATE POLICY settings__admin_write ON public.settings
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND (is_editable_by_admin OR app.is_super_admin()))
  WITH CHECK (app.is_admin() AND (is_editable_by_admin OR app.is_super_admin()));

DROP POLICY IF EXISTS settings__super_admin_insert ON public.settings;
CREATE POLICY settings__super_admin_insert ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (app.is_super_admin());

-- Typed reader used by SQL callers (engine + jobs). STABLE, definer so it can
-- read sensitive rows the caller may not select directly.
CREATE OR REPLACE FUNCTION public.setting_value(p_key text, p_company_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.value
  FROM public.settings s
  WHERE s.key = p_key
    AND (p_company_id IS NULL OR s.company_id = p_company_id OR s.company_id IS NULL)
  ORDER BY (s.company_id IS NOT NULL) DESC, s.scope = 'company' DESC
  LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- 2. feature_flags
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feature_flags (
  id                         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key                        text NOT NULL,
  name                       text NOT NULL,
  description                text,
  is_enabled                 boolean NOT NULL DEFAULT false,
  rollout_pct                integer NOT NULL DEFAULT 0,
  enabled_for_profile_ids    uuid[],
  enabled_for_department_ids uuid[],
  enabled_for_roles          public.app_role[],
  kill_switch                boolean NOT NULL DEFAULT false,
  owner                      text,
  expires_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                 timestamptz,
  deleted_by                 uuid REFERENCES public.profiles(id),
  deletion_reason            text,
  CONSTRAINT ck_ff__rollout CHECK (rollout_pct BETWEEN 0 AND 100),
  -- Flags must die: an open-ended flag is a permanent branch.
  CONSTRAINT ck_ff__expires CHECK (expires_at IS NULL OR expires_at < TIMESTAMPTZ '2100-01-01'),
  CONSTRAINT ck_ff__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_flags__key
  ON public.feature_flags (key) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_feature_flags__stamp BEFORE INSERT ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_feature_flags__touch BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feature_flags__read ON public.feature_flags;
CREATE POLICY feature_flags__read ON public.feature_flags
  FOR SELECT TO authenticated USING (deleted_at IS NULL);

DROP POLICY IF EXISTS feature_flags__super_admin_write ON public.feature_flags;
CREATE POLICY feature_flags__super_admin_write ON public.feature_flags
  FOR ALL TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 3. integrations (config holds secret NAMES, never secret values)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.integrations (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code                 text NOT NULL,
  name                 text NOT NULL,
  kind                 text NOT NULL,
  is_enabled           boolean NOT NULL DEFAULT false,
  config               jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_url             text,
  webhook_secret_name  text,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  failure_count        integer NOT NULL DEFAULT 0,
  health_status        text NOT NULL DEFAULT 'unknown',
  rate_limit_per_min   integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at           timestamptz,
  deleted_by           uuid REFERENCES public.profiles(id),
  deletion_reason      text,
  CONSTRAINT ck_integrations__kind CHECK (kind IN
    ('email','sms','ai','biometric_device','banking','accounting','calendar','storage')),
  CONSTRAINT ck_integrations__health CHECK (health_status IN ('ok','degraded','down','unknown')),
  CONSTRAINT ck_integrations__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations__code
  ON public.integrations (code) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_integrations__stamp BEFORE INSERT ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_integrations__touch BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrations__admin_read ON public.integrations;
CREATE POLICY integrations__admin_read ON public.integrations
  FOR SELECT TO authenticated USING (app.is_admin() AND deleted_at IS NULL);

DROP POLICY IF EXISTS integrations__super_admin_write ON public.integrations;
CREATE POLICY integrations__super_admin_write ON public.integrations
  FOR ALL TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 4. cron_jobs + job_runs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cron_jobs (
  id                               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code                             text NOT NULL,
  name                             text NOT NULL,
  description                      text,
  schedule_cron                    text NOT NULL,
  schedule_human                   text NOT NULL,
  timezone                         text NOT NULL DEFAULT 'Asia/Kolkata',
  target                           text NOT NULL,
  target_name                      text NOT NULL,
  payload                          jsonb,
  is_enabled                       boolean NOT NULL DEFAULT true,
  timeout_seconds                  integer NOT NULL DEFAULT 300,
  overlap_policy                   text NOT NULL DEFAULT 'skip',
  alert_on_failure                 boolean NOT NULL DEFAULT true,
  alert_after_consecutive_failures integer NOT NULL DEFAULT 2,
  expected_max_duration_ms         integer,
  last_run_id                      uuid,
  next_run_at                      timestamptz,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  created_by                       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  updated_by                       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_cron_jobs__target CHECK (target IN ('sql_function','edge_function')),
  CONSTRAINT ck_cron_jobs__overlap CHECK (overlap_policy IN ('skip','queue','kill_previous'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cron_jobs__code ON public.cron_jobs (code);

CREATE TRIGGER trg_cron_jobs__stamp BEFORE INSERT ON public.cron_jobs
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_cron_jobs__touch BEFORE UPDATE ON public.cron_jobs
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.cron_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cron_jobs__admin_read ON public.cron_jobs;
CREATE POLICY cron_jobs__admin_read ON public.cron_jobs
  FOR SELECT TO authenticated USING (app.is_admin());

DROP POLICY IF EXISTS cron_jobs__super_admin_write ON public.cron_jobs;
CREATE POLICY cron_jobs__super_admin_write ON public.cron_jobs
  FOR ALL TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

CREATE TABLE IF NOT EXISTS public.job_runs (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cron_job_id       uuid REFERENCES public.cron_jobs(id) ON DELETE SET NULL,
  job_code          text NOT NULL,
  run_kind          text NOT NULL DEFAULT 'scheduled',
  triggered_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status            public.job_run_status NOT NULL DEFAULT 'running',
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       integer,
  records_processed integer,
  records_failed    integer,
  result            jsonb,
  error             text,
  error_stack       text,
  attempt           integer NOT NULL DEFAULT 1,
  lock_key          text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_job_runs__kind CHECK (run_kind IN ('scheduled','manual','retry','backfill'))
);

CREATE INDEX IF NOT EXISTS idx_job_runs__code_time ON public.job_runs (job_code, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs__failed ON public.job_runs (started_at DESC) WHERE status = 'failed';
-- Overlap guard: at most one running row per lock key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_runs__running_lock
  ON public.job_runs (lock_key) WHERE status = 'running' AND lock_key IS NOT NULL;

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_runs__admin_read ON public.job_runs;
CREATE POLICY job_runs__admin_read ON public.job_runs
  FOR SELECT TO authenticated USING (app.is_admin());

-- Double-run guard used by every cron entry point (§8.9 / spec-architecture §9).
CREATE OR REPLACE FUNCTION app.job_begin(p_job_code text, p_lock_key text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id  uuid;
  v_key text := COALESCE(p_lock_key, p_job_code);
BEGIN
  INSERT INTO public.job_runs (job_code, lock_key, cron_job_id)
  VALUES (p_job_code, v_key, (SELECT c.id FROM public.cron_jobs c WHERE c.code = p_job_code))
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  -- Another instance holds the lock; the caller returns 200 {"skipped":...}.
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app.job_end(
  p_run_id uuid,
  p_status public.job_run_status,
  p_records_processed integer DEFAULT NULL,
  p_records_failed integer DEFAULT NULL,
  p_result jsonb DEFAULT NULL,
  p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.job_runs
     SET status = p_status,
         finished_at = now(),
         duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
         records_processed = COALESCE(p_records_processed, records_processed),
         records_failed = COALESCE(p_records_failed, records_failed),
         result = COALESCE(p_result, result),
         error = COALESCE(p_error, error),
         lock_key = NULL          -- releases the partial unique index
   WHERE id = p_run_id;

  UPDATE public.cron_jobs c
     SET last_run_id = p_run_id
   WHERE c.id = (SELECT r.cron_job_id FROM public.job_runs r WHERE r.id = p_run_id);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. system_health
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.system_health (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  component       text NOT NULL,
  status          text NOT NULL DEFAULT 'unknown',
  metric_name     text,
  metric_value    numeric(16,4),
  threshold       numeric(16,4),
  detail          jsonb,
  message         text,
  alert_sent_at   timestamptz,
  acknowledged_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  CONSTRAINT ck_system_health__status CHECK (status IN ('ok','degraded','down','unknown'))
);

CREATE INDEX IF NOT EXISTS idx_system_health__component_time
  ON public.system_health (component, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_health__open
  ON public.system_health (checked_at DESC) WHERE resolved_at IS NULL AND status <> 'ok';

ALTER TABLE public.system_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_health__admin_read ON public.system_health;
CREATE POLICY system_health__admin_read ON public.system_health
  FOR SELECT TO authenticated USING (app.is_admin());

DROP POLICY IF EXISTS system_health__admin_ack ON public.system_health;
CREATE POLICY system_health__admin_ack ON public.system_health
  FOR UPDATE TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 6. import_batches / import_rows — the 1.0202E+11 defence
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_batches (
  id                 uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_kind        text NOT NULL,
  file_document_id   uuid,   -- FK via deferred sweep (documents in 025)
  original_file_name text,
  row_count          integer NOT NULL DEFAULT 0,
  valid_count        integer NOT NULL DEFAULT 0,
  invalid_count      integer NOT NULL DEFAULT 0,
  imported_count     integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'uploaded',
  dry_run            boolean NOT NULL DEFAULT true,
  mapping            jsonb,
  uploaded_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  validated_at       timestamptz,
  imported_at        timestamptz,
  rollback_at        timestamptz,
  error_summary      jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_import_batches__kind CHECK (import_kind IN
    ('employees','attendance','leave_balances','salary_structures','assets','holidays')),
  CONSTRAINT ck_import_batches__status CHECK (status IN
    ('uploaded','validating','validated','importing','completed','failed','rolled_back'))
);

CREATE INDEX IF NOT EXISTS idx_import_batches__status ON public.import_batches (status, created_at DESC);

CREATE TRIGGER trg_import_batches__stamp BEFORE INSERT ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_import_batches__touch BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_batches__admin_all ON public.import_batches;
CREATE POLICY import_batches__admin_all ON public.import_batches
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE TABLE IF NOT EXISTS public.import_rows (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id              uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  row_number            integer NOT NULL,
  -- `raw` holds every cell EXACTLY as read, as text (formatted-value reader) —
  -- never a numeric parse. This is what makes a mangled PF number disputable.
  raw                   jsonb NOT NULL,
  normalised            jsonb,
  errors                jsonb,
  status                text NOT NULL DEFAULT 'pending',
  created_entity_table  text,
  created_entity_id     uuid,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_import_rows__status CHECK (status IN ('pending','valid','invalid','imported','skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_import_rows__batch_row ON public.import_rows (batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_import_rows__status ON public.import_rows (batch_id, status);

ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_rows__admin_all ON public.import_rows;
CREATE POLICY import_rows__admin_all ON public.import_rows
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 7. Edge-function primitives: idempotency + rate limiting
-- -----------------------------------------------------------------------------

-- Every mutating edge function claims a key before doing work and stores its
-- response under it, so a client retry replays instead of double-writing
-- (spec-architecture §4 lifecycle step 8).
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key           text NOT NULL PRIMARY KEY,
  request_hash  text NOT NULL,
  fn_name       text NOT NULL,
  actor_id      uuid,
  status_code   integer,
  response      jsonb,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys__expiry ON public.idempotency_keys (expires_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
-- Zero policies: service_role only (it bypasses RLS). No client may read
-- another caller's stored response.

-- Token bucket, evaluated in the database so all edge instances share it.
CREATE TABLE IF NOT EXISTS app.rate_limit_buckets (
  bucket      text NOT NULL,
  key         text NOT NULL,
  tokens      numeric(12,4) NOT NULL,
  refilled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_rate_limit_buckets PRIMARY KEY (bucket, key)
);

-- Returns true when a token was taken (request allowed), false when throttled.
CREATE OR REPLACE FUNCTION app.rate_limit_take(
  p_bucket text,
  p_key text,
  p_capacity integer,
  p_refill_per_minute numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tokens numeric;
  v_now    timestamptz := clock_timestamp();
BEGIN
  INSERT INTO app.rate_limit_buckets (bucket, key, tokens, refilled_at)
  VALUES (p_bucket, p_key, p_capacity, v_now)
  ON CONFLICT (bucket, key) DO UPDATE
    SET tokens = LEAST(
          p_capacity,
          app.rate_limit_buckets.tokens
            + EXTRACT(EPOCH FROM (v_now - app.rate_limit_buckets.refilled_at)) / 60.0
              * p_refill_per_minute),
        refilled_at = v_now
  RETURNING tokens INTO v_tokens;

  IF v_tokens < 1 THEN
    RETURN false;
  END IF;

  UPDATE app.rate_limit_buckets
     SET tokens = tokens - 1
   WHERE bucket = p_bucket AND key = p_key;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.rate_limit_take(text, text, integer, numeric) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 8. Maintenance: partitions, retention, analytics refresh
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_monthly_partition(p_table regclass, p_month date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := replace(p_table::text, '.', '_') || '_' || to_char(v_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                   v_name, p_table::text, v_start, v_end);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
    EXECUTE format('ANALYZE %I', v_name);
  END IF;
  RETURN v_name;
END;
$$;

-- Keeps three months of headroom on every partitioned table (§8.9, 03:00 on the 25th).
CREATE OR REPLACE FUNCTION public.partition_maintenance()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_created integer := 0;
  v_tbl     text;
  v_month   date;
  i         integer;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['public.attendance_punches', 'public.audit_log', 'secure.face_match_log'] LOOP
    IF to_regclass(v_tbl) IS NULL THEN CONTINUE; END IF;
    FOR i IN 0..3 LOOP
      v_month := (date_trunc('month', now()) + make_interval(months => i))::date;
      PERFORM public.ensure_monthly_partition(to_regclass(v_tbl), v_month);
      v_created := v_created + 1;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$;

-- Refreshes every analytics matview that exists (§9.4). Concurrent where a
-- unique index allows it; the caller runs it after the nightly close.
CREATE OR REPLACE FUNCTION public.refresh_analytics()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count integer := 0;
  mv      record;
BEGIN
  FOR mv IN
    SELECT n.nspname AS schema_name, c.relname AS view_name,
           EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique) AS has_unique
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'm' AND n.nspname = 'analytics'
  LOOP
    IF mv.has_unique THEN
      EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I.%I', mv.schema_name, mv.view_name);
    ELSE
      EXECUTE format('REFRESH MATERIALIZED VIEW %I.%I', mv.schema_name, mv.view_name);
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Retention sweep (§8.9, 03:30 IST): the parts that are pure SQL. Object-store
-- deletions (punch photos, exports) are done by the cron edge function.
CREATE OR REPLACE FUNCTION public.retention_sweep()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_scores integer := 0;
  v_challenges integer := 0;
  v_idem integer := 0;
BEGIN
  IF to_regclass('secure.face_match_log') IS NOT NULL THEN
    UPDATE secure.face_match_log
       SET candidate_scores = NULL
     WHERE attempted_at < now() - interval '90 days'
       AND candidate_scores IS NOT NULL;
    GET DIAGNOSTICS v_scores = ROW_COUNT;
  END IF;

  IF to_regclass('secure.webauthn_challenges') IS NOT NULL THEN
    DELETE FROM secure.webauthn_challenges WHERE expires_at < now() - interval '1 day';
    GET DIAGNOSTICS v_challenges = ROW_COUNT;
  END IF;

  DELETE FROM public.idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS v_idem = ROW_COUNT;

  RETURN jsonb_build_object(
    'face_scores_nulled', v_scores,
    'challenges_purged', v_challenges,
    'idempotency_keys_purged', v_idem);
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.settings, public.feature_flags, public.integrations,
                    public.cron_jobs, public.job_runs, public.system_health,
                    public.import_batches, public.import_rows TO authenticated;
    GRANT INSERT, UPDATE ON public.settings, public.feature_flags, public.integrations,
                            public.cron_jobs, public.system_health,
                            public.import_batches, public.import_rows TO authenticated;
    GRANT EXECUTE ON FUNCTION public.setting_value(text, uuid) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings, public.feature_flags,
      public.integrations, public.cron_jobs, public.job_runs, public.system_health,
      public.import_batches, public.import_rows, public.idempotency_keys TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.rate_limit_buckets TO service_role;
    GRANT USAGE ON SCHEMA app TO service_role;
    GRANT EXECUTE ON FUNCTION
      public.setting_value(text, uuid),
      app.job_begin(text, text),
      app.job_end(uuid, public.job_run_status, integer, integer, jsonb, text),
      app.rate_limit_take(text, text, integer, numeric),
      public.ensure_monthly_partition(regclass, date),
      public.partition_maintenance(),
      public.refresh_analytics(),
      public.retention_sweep()
      TO service_role;
  END IF;
END $$;

COMMIT;
