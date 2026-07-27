-- =============================================================================
-- Migration 006 — audit engine
-- Source: docs/plan/04-data-model.md §3.14 (audit_log/audit_seals/
--         data_access_log/export_log DDL), §5.1–5.6 (engine, exact SQL);
--         spec-migrations §2 row 006.
--
-- One generic AFTER-row trigger writes ONE audit_log row PER CHANGED FIELD,
-- hash-chained (prev_hash/row_hash + audit.chain_state), with per-table
-- exclusion/redaction/mandatory-reason configuration. Insert-only forever:
-- no UPDATE/DELETE path for any role including super_admin.
--
-- Deviations from the plan doc, deliberate and small:
--   * write_row/verify_chain carry `SET timezone = 'UTC'` — the chain payload
--     serialises timestamptz::text, which is session-timezone-dependent;
--     pinning the function-local zone makes row_hash reproducible for
--     verify_chain regardless of who verifies.
--   * Partitions are created dynamically (previous month → +6 months for
--     audit_log; current quarter → +3 quarters for data_access_log) instead
--     of six hard-coded names, so the migration is correct whenever it is
--     applied. public.partition_maintenance (031) takes over from there.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Configuration tables (§5.2)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit.excluded_columns (
  entity_table text NOT NULL,
  column_name  text NOT NULL,
  note         text,
  PRIMARY KEY (entity_table, column_name)
);

INSERT INTO audit.excluded_columns (entity_table, column_name, note) VALUES
  ('*', 'updated_at',               'stamped by trigger; noise'),
  ('*', 'updated_by',               'stamped by trigger; noise'),
  ('*', 'search_tsv',               'derived'),
  ('*', 'computed_at',              'derived'),
  ('*', 'last_recomputed_at',       'derived'),
  ('*', 'ledger_high_water_mark',   'derived'),
  ('*', 'profile_completeness_pct', 'derived'),
  ('*', 'view_count',               'counter'),
  ('*', 'open_count',               'counter'),
  ('public.attendance_days', 'computed_version', 'engine bookkeeping'),
  ('public.notifications',   'retry_count',      'delivery bookkeeping'),
  ('public.assets',          'qr_payload',       'derived')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit.redacted_columns (
  entity_table text NOT NULL,
  column_name  text NOT NULL,
  mode         text NOT NULL DEFAULT 'hash',  -- 'hash' | 'mask_tail' | 'omit'
  PRIMARY KEY (entity_table, column_name),
  CONSTRAINT ck_redaction_mode CHECK (mode IN ('hash', 'mask_tail', 'omit'))
);

INSERT INTO audit.redacted_columns (entity_table, column_name, mode) VALUES
  ('public.employee_statutory',          'aadhaar_number',     'hash'),
  ('public.employee_statutory',          'pan',                'mask_tail'),
  ('public.employee_statutory',          'uan',                'mask_tail'),
  ('public.employee_bank_accounts',      'account_number',     'hash'),
  ('public.employee_identity_documents', 'document_number',    'mask_tail'),
  ('public.profiles',                    'phone',              'mask_tail'),
  ('public.e_sign_signers',              'identity_check_value_hash', 'hash'),
  ('secure.kiosk_operator_secrets',      'pin_hash',           'omit'),
  ('secure.face_templates',              'descriptor',         'omit'),
  ('secure.face_templates',              'descriptor_set',     'omit')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit.reason_required_tables (
  entity_table text PRIMARY KEY,
  min_length   integer NOT NULL DEFAULT 10,
  applies_to   text NOT NULL DEFAULT 'update_delete',  -- 'all' | 'update_delete' | 'delete'
  CONSTRAINT ck_reason_applies_to CHECK (applies_to IN ('all', 'update_delete', 'delete'))
);

INSERT INTO audit.reason_required_tables (entity_table) VALUES
  ('public.employees'),
  ('public.employee_salary_revisions'),
  ('public.employee_statutory'),
  ('public.employee_bank_accounts'),
  ('public.attendance_days'),
  ('public.attendance_locks'),
  ('public.attendance_policies'),
  ('public.statutory_settings'),
  ('public.payroll_runs'),
  ('public.user_roles'),
  ('public.leave_balances'),
  ('public.kiosk_devices'),
  ('public.settings'),
  ('public.holidays'),
  ('public.pay_periods'),
  ('public.leave_types'),
  ('public.documents')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit.chain_state (
  chain_id    text PRIMARY KEY DEFAULT 'global',
  last_seq    bigint NOT NULL DEFAULT 0,
  last_hash   text   NOT NULL DEFAULT repeat('0', 64),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO audit.chain_state (chain_id) VALUES ('global')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. public.audit_log — partitioned, hash-chained, append-only (§3.14)
-- -----------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.audit_log_seq;

CREATE TABLE IF NOT EXISTS public.audit_log (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  ist_timestamp       timestamp   NOT NULL GENERATED ALWAYS AS (util.ist_ts(occurred_at)) STORED,
  ist_date            date        NOT NULL GENERATED ALWAYS AS (util.ist_date(occurred_at)) STORED,
  seq                 bigint      NOT NULL DEFAULT nextval('public.audit_log_seq'),
  actor_id            uuid,
  actor_employee_id   uuid,
  actor_role          public.app_role,
  actor_email         text,
  actor_source        public.actor_source NOT NULL DEFAULT 'web_employee',
  on_behalf_of        uuid,
  impersonated_by     uuid,
  action              public.audit_action NOT NULL,
  entity_table        text        NOT NULL,
  entity_id           uuid,
  entity_label        text,
  subject_employee_id uuid,
  field_name          text,
  old_value           jsonb,
  new_value           jsonb,
  is_redacted         boolean     NOT NULL DEFAULT false,
  reason              text,
  source              text,
  request_id          uuid,
  transaction_id      bigint      DEFAULT txid_current(),
  ip                  inet,
  user_agent          text,
  device_id           text,
  session_id          text,
  approval_request_id uuid,
  prev_hash           text,
  row_hash            text        NOT NULL,
  chain_id            text        NOT NULL DEFAULT 'global',
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Partitions: previous month through +6 months (UTC month boundaries, §12.5).
DO $$
DECLARE
  v_month date := date_trunc('month', now())::date - interval '1 month';
  v_name  text;
  i       integer;
BEGIN
  FOR i IN 0..7 LOOP
    v_name := 'audit_log_' || to_char(v_month, 'YYYY_MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
        v_name, v_month, (v_month + interval '1 month')::date);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    END IF;
    v_month := (v_month + interval '1 month')::date;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_log__entity      ON public.audit_log (entity_table, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log__subject     ON public.audit_log (subject_employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log__actor       ON public.audit_log (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log__action_time ON public.audit_log (action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log__request     ON public.audit_log (request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log__field       ON public.audit_log (entity_table, field_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log__occurred_brin ON public.audit_log USING brin (occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log__search      ON public.audit_log USING gin
  (to_tsvector('simple', coalesce(entity_label,'') || ' ' || coalesce(reason,'') || ' ' || coalesce(field_name,'')));

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. audit_seals / data_access_log / export_log (§3.14)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_seals (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seal_date           date        NOT NULL UNIQUE,
  first_seq           bigint      NOT NULL,
  last_seq            bigint      NOT NULL,
  row_count           bigint      NOT NULL,
  terminal_hash       text        NOT NULL,
  sealed_at           timestamptz NOT NULL DEFAULT now(),
  sealed_by           text        NOT NULL DEFAULT 'cron:audit_seal',
  external_anchor     text,
  verified_at         timestamptz,
  verification_result text,
  CONSTRAINT ck_audit_seals__seq_order CHECK (last_seq >= first_seq)
);

ALTER TABLE public.audit_seals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.data_access_log (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  accessed_at         timestamptz NOT NULL DEFAULT now(),
  ist_date            date        NOT NULL GENERATED ALWAYS AS (util.ist_date(accessed_at)) STORED,
  actor_id            uuid,
  actor_role          public.app_role,
  actor_source        public.actor_source NOT NULL DEFAULT 'web_admin',
  on_behalf_of        uuid,
  entity_table        text        NOT NULL,
  entity_id           uuid,
  subject_employee_id uuid,
  fields              text[]      NOT NULL DEFAULT '{}',
  access_kind         text        NOT NULL,
  purpose             text        NOT NULL,
  record_count        integer,
  filter_summary      jsonb,
  ip                  inet,
  user_agent          text,
  device_id           text,
  request_id          uuid,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, accessed_at),
  CONSTRAINT ck_dalog__kind    CHECK (access_kind IN ('reveal', 'export', 'report', 'ai_query', 'bulk_view')),
  CONSTRAINT ck_dalog__purpose CHECK (length(btrim(purpose)) >= 10)
) PARTITION BY RANGE (accessed_at);

-- Quarterly partitions: current quarter → +3 quarters (§12.5).
DO $$
DECLARE
  v_q    date := date_trunc('quarter', now())::date;
  v_name text;
  i      integer;
BEGIN
  FOR i IN 0..3 LOOP
    v_name := 'data_access_log_' || to_char(v_q, 'YYYY') || '_q' || to_char(v_q, 'Q');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.data_access_log FOR VALUES FROM (%L) TO (%L)',
        v_name, v_q, (v_q + interval '3 months')::date);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    END IF;
    v_q := (v_q + interval '3 months')::date;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_dalog__subject_time ON public.data_access_log (subject_employee_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dalog__actor_time   ON public.data_access_log (actor_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dalog__fields       ON public.data_access_log USING gin (fields);

ALTER TABLE public.data_access_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.export_log (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  exported_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid,
  actor_role         public.app_role,
  export_kind        text        NOT NULL,
  subject            text        NOT NULL,
  filters            jsonb,
  columns            text[],
  row_count          integer,
  file_size_bytes    bigint,
  contains_pii       boolean     NOT NULL DEFAULT false,
  contains_salary    boolean     NOT NULL DEFAULT false,
  contains_biometric boolean     NOT NULL DEFAULT false,
  storage_path       text,
  checksum_sha256    text,
  purpose            text        NOT NULL,
  approved_by        uuid,
  ip                 inet,
  user_agent         text,
  request_id         uuid,
  CONSTRAINT ck_export_log__kind CHECK (export_kind IN
    ('csv', 'xlsx', 'pdf', 'bank_advice', 'audit_dump', 'api_bulk', 'ai_infographic_data')),
  CONSTRAINT ck_export_log__subject CHECK (subject IN
    ('employees', 'attendance', 'payroll', 'audit_log', 'documents', 'leave', 'assets', 'face_match_log')),
  CONSTRAINT ck_export_log__purpose CHECK (length(btrim(purpose)) >= 10),
  CONSTRAINT ck_export_log__approval CHECK (
    NOT (contains_salary OR coalesce(row_count, 0) > 500) OR approved_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_export_log__actor_time ON public.export_log (actor_id, exported_at DESC);

ALTER TABLE public.export_log ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 4. Immutability enforcement (§4.9, §3.14)
-- -----------------------------------------------------------------------------

-- Unconditional refusal — no bypass setting exists on purpose.
CREATE OR REPLACE FUNCTION audit.refuse_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted: append-only table',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING errcode = '0A000';  -- feature_not_supported (asserted by pgTAP)
END;
$$;

-- Void-tolerant refusal for ledger-style tables: corrections are recorded by
-- marking the row voided (is_voided/voided_at/voided_by/void_reason only);
-- everything else, and every DELETE, is refused.
CREATE OR REPLACE FUNCTION audit.refuse_mutation_except_void()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_void_cols text[] := ARRAY['is_voided', 'voided_at', 'voided_by', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on %.% is not permitted: append-only table (void instead)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING errcode = '0A000';
  END IF;
  IF (to_jsonb(NEW) - v_void_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_void_cols) THEN
    RAISE EXCEPTION 'UPDATE on %.% may only set void columns (%).',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, array_to_string(v_void_cols, ', ')
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log, public.audit_seals, public.data_access_log, public.export_log FROM %I', v_role);
    END IF;
  END LOOP;
END $$;

CREATE TRIGGER trg_audit_log__immutable
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

CREATE TRIGGER trg_data_access_log__immutable
  BEFORE UPDATE OR DELETE ON public.data_access_log
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

CREATE TRIGGER trg_export_log__immutable
  BEFORE UPDATE OR DELETE ON public.export_log
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

-- -----------------------------------------------------------------------------
-- 5. Engine functions (§5.3 exact SQL)
-- -----------------------------------------------------------------------------

-- Redaction of a single value
CREATE OR REPLACE FUNCTION audit.redact_value(p_val jsonb, p_mode text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_val IS NULL OR p_val = 'null'::jsonb THEN p_val
    WHEN p_mode = 'omit'      THEN jsonb_build_object('redacted', true)
    WHEN p_mode = 'mask_tail' THEN jsonb_build_object('redacted', true,
                                     'masked', util.mask_tail(p_val #>> '{}', 4))
    ELSE jsonb_build_object('redacted', true,
           'sha256', encode(extensions.digest(p_val #>> '{}', 'sha256'), 'hex'),
           'len', length(p_val #>> '{}'))
  END;
$$;

-- Redaction across a whole tuple (insert/delete summary rows)
CREATE OR REPLACE FUNCTION audit.redact_tuple(p_table text, p_tuple jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(jsonb_object_agg(k,
           CASE WHEN r.column_name IS NULL THEN p_tuple -> k
                ELSE audit.redact_value(p_tuple -> k, r.mode) END), '{}'::jsonb)
  FROM jsonb_object_keys(p_tuple) k
  LEFT JOIN audit.redacted_columns r
         ON r.entity_table = p_table AND r.column_name = k
  WHERE k NOT IN (SELECT column_name FROM audit.excluded_columns
                  WHERE entity_table IN ('*', p_table));
$$;

-- Human-readable entity label; extended per table as the product grows.
CREATE OR REPLACE FUNCTION audit.entity_label(p_table text, p_id uuid, p_tuple jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text;
BEGIN
  CASE p_table
    WHEN 'public.employees' THEN
      v := coalesce(p_tuple->>'employee_code','?') || ' — ' || coalesce(p_tuple->>'display_name','?');
    WHEN 'public.attendance_days' THEN
      SELECT e.employee_code || ' — ' || (p_tuple->>'ist_date') INTO v
      FROM public.employees e WHERE e.id = (p_tuple->>'employee_id')::uuid;
    WHEN 'public.payslips' THEN
      v := coalesce(p_tuple->>'payslip_number','?');
    WHEN 'public.leave_requests' THEN
      v := coalesce(p_tuple->>'request_number','?');
    ELSE
      v := coalesce(p_tuple->>'name', p_tuple->>'title', p_tuple->>'code',
                    p_tuple->>'request_number', p_id::text);
  END CASE;
  RETURN left(v, 200);
END;
$$;

-- The single writer: extends the hash chain and inserts.
-- timezone pinned to UTC so the ::text serialisation in the hash payload is
-- reproducible by verify_chain in any session.
CREATE OR REPLACE FUNCTION audit.write_row(
  p_action public.audit_action, p_table text, p_entity_id uuid, p_label text,
  p_subject uuid, p_field text, p_old jsonb, p_new jsonb, p_redacted boolean,
  p_reason text, p_actor uuid, p_actor_emp uuid, p_actor_email text,
  p_actor_role public.app_role, p_source public.actor_source,
  p_on_behalf uuid, p_impersonator uuid, p_approval uuid,
  p_request uuid, p_ip inet, p_ua text, p_device text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  v_seq       bigint;
  v_prev_hash text;
  v_now       timestamptz := clock_timestamp();
  v_payload   text;
  v_hash      text;
BEGIN
  -- Serialise chain extension. Transaction-scoped advisory lock: concurrent
  -- writers queue for microseconds; the chain stays strictly ordered.
  PERFORM pg_advisory_xact_lock(hashtext('audit_chain_global'));

  UPDATE audit.chain_state
     SET last_seq = last_seq + 1, updated_at = v_now
   WHERE chain_id = 'global'
  RETURNING last_seq, last_hash INTO v_seq, v_prev_hash;

  v_payload := concat_ws('|', v_prev_hash, v_seq::text, v_now::text,
                 coalesce(p_actor::text,''), p_action::text, p_table,
                 coalesce(p_entity_id::text,''), coalesce(p_field,''),
                 coalesce(p_old::text,''), coalesce(p_new::text,''),
                 coalesce(p_reason,''));
  v_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');

  INSERT INTO public.audit_log (
    occurred_at, seq, actor_id, actor_employee_id, actor_role, actor_email, actor_source,
    on_behalf_of, impersonated_by, action, entity_table, entity_id, entity_label,
    subject_employee_id, field_name, old_value, new_value, is_redacted, reason,
    source, request_id, ip, user_agent, device_id, approval_request_id,
    prev_hash, row_hash)
  VALUES (
    v_now, v_seq, p_actor, p_actor_emp, p_actor_role, p_actor_email, p_source,
    p_on_behalf, p_impersonator, p_action, p_table, p_entity_id, p_label,
    p_subject, p_field, p_old, p_new, p_redacted, p_reason,
    app.ctx('source_route'), p_request, p_ip, p_ua, p_device, p_approval,
    v_prev_hash, v_hash);

  UPDATE audit.chain_state SET last_hash = v_hash WHERE chain_id = 'global';
END;
$$;

-- The generic field-level diff trigger (§5.3 exact SQL).
CREATE OR REPLACE FUNCTION audit.log_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_table        text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_old          jsonb;
  v_new          jsonb;
  v_key          text;
  v_old_val      jsonb;
  v_new_val      jsonb;
  v_action       public.audit_action;
  v_entity_id    uuid;
  v_subject_id   uuid;
  v_label        text;
  v_actor_id     uuid := app.ctx_actor_id();
  v_actor_emp    uuid;
  v_actor_email  text;
  v_actor_role   public.app_role;
  v_source       public.actor_source;
  v_reason       text := nullif(btrim(coalesce(app.ctx('reason'), '')), '');
  v_request_id   uuid := nullif(app.ctx('request_id'), '')::uuid;
  v_ip           inet := nullif(app.ctx('ip'), '')::inet;
  v_ua           text := app.ctx('user_agent');
  v_device       text := app.ctx('device_id');
  v_on_behalf    uuid := nullif(app.ctx('on_behalf_of'), '')::uuid;
  v_impersonator uuid := nullif(app.ctx('impersonated_by'), '')::uuid;
  v_approval_id  uuid := nullif(app.ctx('approval_request_id'), '')::uuid;
  v_reason_cfg   audit.reason_required_tables%ROWTYPE;
  v_redact       audit.redacted_columns%ROWTYPE;
  v_changed      integer := 0;
BEGIN
  -- ── 1. Normalise OLD/NEW ────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW); v_old := '{}'::jsonb; v_action := 'insert';
  ELSIF TG_OP = 'UPDATE' THEN
    v_new := to_jsonb(NEW); v_old := to_jsonb(OLD);
    v_action := CASE
      WHEN (v_old ? 'deleted_at') AND v_old->>'deleted_at' IS NULL AND v_new->>'deleted_at' IS NOT NULL THEN 'soft_delete'
      WHEN (v_old ? 'deleted_at') AND v_old->>'deleted_at' IS NOT NULL AND v_new->>'deleted_at' IS NULL THEN 'restore'
      ELSE 'update'
    END;
  ELSE
    v_old := to_jsonb(OLD); v_new := '{}'::jsonb; v_action := 'hard_delete';
  END IF;

  v_entity_id  := COALESCE(v_new->>'id', v_old->>'id')::uuid;
  v_subject_id := COALESCE(v_new->>'employee_id', v_old->>'employee_id',
                           CASE WHEN TG_TABLE_NAME = 'employees'
                                THEN COALESCE(v_new->>'id', v_old->>'id') END)::uuid;

  -- ── 2. Mandatory reason ─────────────────────────────────────────────
  SELECT * INTO v_reason_cfg FROM audit.reason_required_tables WHERE entity_table = v_table;
  IF v_reason_cfg.entity_table IS NOT NULL THEN
    IF (v_reason_cfg.applies_to = 'all')
       OR (v_reason_cfg.applies_to = 'update_delete' AND TG_OP IN ('UPDATE','DELETE'))
       OR (v_reason_cfg.applies_to = 'delete' AND TG_OP = 'DELETE') THEN
      IF v_reason IS NULL OR length(v_reason) < v_reason_cfg.min_length THEN
        RAISE EXCEPTION
          'reason_required: % on % needs app.reason of at least % characters',
          TG_OP, v_table, v_reason_cfg.min_length USING errcode = '22023';
      END IF;
    END IF;
  END IF;

  -- ── 3. Actor identity, snapshotted ──────────────────────────────────
  SELECT p.email INTO v_actor_email FROM public.profiles p WHERE p.id = v_actor_id;
  SELECT e.id    INTO v_actor_emp   FROM public.employees e WHERE e.profile_id = v_actor_id AND e.deleted_at IS NULL;
  v_actor_role := CASE
    WHEN v_actor_id IS NULL THEN NULL
    WHEN app.has_role('super_admin') THEN 'super_admin'
    WHEN app.has_role('admin')       THEN 'admin'
    WHEN app.has_role('manager')     THEN 'manager'
    ELSE 'employee' END;
  v_source := COALESCE(nullif(app.ctx('source'), ''), 'web_employee')::public.actor_source;

  -- ── 4. Human label for the entity, resolved once ────────────────────
  v_label := audit.entity_label(v_table, v_entity_id, COALESCE(v_new, v_old));

  -- ── 5. Emit rows ────────────────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN
    FOR v_key IN
      SELECT k FROM (
        SELECT jsonb_object_keys(v_new) AS k
        UNION SELECT jsonb_object_keys(v_old)
      ) keys
      WHERE k NOT IN (SELECT column_name FROM audit.excluded_columns
                      WHERE entity_table IN ('*', v_table))
      ORDER BY k
    LOOP
      v_old_val := v_old -> v_key;
      v_new_val := v_new -> v_key;
      CONTINUE WHEN v_old_val IS NOT DISTINCT FROM v_new_val;

      SELECT * INTO v_redact FROM audit.redacted_columns
        WHERE entity_table = v_table AND column_name = v_key;
      IF v_redact.column_name IS NOT NULL THEN
        v_old_val := audit.redact_value(v_old_val, v_redact.mode);
        v_new_val := audit.redact_value(v_new_val, v_redact.mode);
      END IF;

      PERFORM audit.write_row(
        v_action, v_table, v_entity_id, v_label, v_subject_id, v_key,
        v_old_val, v_new_val, (v_redact.column_name IS NOT NULL),
        v_reason, v_actor_id, v_actor_emp, v_actor_email, v_actor_role, v_source,
        v_on_behalf, v_impersonator, v_approval_id, v_request_id, v_ip, v_ua, v_device);
      v_changed := v_changed + 1;
    END LOOP;

    -- A no-op UPDATE (touch with no field change) still leaves a trace.
    IF v_changed = 0 THEN
      PERFORM audit.write_row('update', v_table, v_entity_id, v_label, v_subject_id, NULL,
        NULL, NULL, false, COALESCE(v_reason, 'no field changed'),
        v_actor_id, v_actor_emp, v_actor_email, v_actor_role, v_source,
        v_on_behalf, v_impersonator, v_approval_id, v_request_id, v_ip, v_ua, v_device);
    END IF;

  ELSE
    -- INSERT / DELETE: one summary row carrying the whole tuple, redacted.
    PERFORM audit.write_row(
      v_action, v_table, v_entity_id, v_label, v_subject_id, NULL,
      CASE WHEN TG_OP = 'DELETE' THEN audit.redact_tuple(v_table, v_old) END,
      CASE WHEN TG_OP = 'INSERT' THEN audit.redact_tuple(v_table, v_new) END,
      EXISTS (SELECT 1 FROM audit.redacted_columns WHERE entity_table = v_table),
      v_reason, v_actor_id, v_actor_emp, v_actor_email, v_actor_role, v_source,
      v_on_behalf, v_impersonator, v_approval_id, v_request_id, v_ip, v_ua, v_device);
  END IF;

  RETURN NULL;  -- AFTER trigger
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Chain verification (§5.6)
-- -----------------------------------------------------------------------------

-- Re-walks the chain between two dates (inclusive, by occurred_at::date in
-- UTC) and returns the first row whose stored row_hash disagrees with
-- recomputation, or no row when the chain is intact. Also flags a broken
-- prev_hash linkage. timezone pinned to UTC to match write_row's payload.
CREATE OR REPLACE FUNCTION audit.verify_chain(p_from date, p_to date)
RETURNS TABLE (bad_seq bigint, occurred_at timestamptz, stored_hash text, computed_hash text, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  r          record;
  v_prev     text := NULL;
  v_payload  text;
  v_hash     text;
BEGIN
  FOR r IN
    SELECT a.seq, a.occurred_at, a.actor_id, a.action, a.entity_table, a.entity_id,
           a.field_name, a.old_value, a.new_value, a.reason, a.prev_hash, a.row_hash
    FROM public.audit_log a
    WHERE a.occurred_at >= p_from::timestamptz
      AND a.occurred_at <  (p_to + 1)::timestamptz
    ORDER BY a.seq
  LOOP
    IF v_prev IS NOT NULL AND r.prev_hash IS DISTINCT FROM v_prev THEN
      RETURN QUERY SELECT r.seq, r.occurred_at, r.prev_hash, v_prev,
        'prev_hash does not match preceding row_hash'::text;
      RETURN;
    END IF;

    v_payload := concat_ws('|', r.prev_hash, r.seq::text, r.occurred_at::text,
                   coalesce(r.actor_id::text,''), r.action::text, r.entity_table,
                   coalesce(r.entity_id::text,''), coalesce(r.field_name,''),
                   coalesce(r.old_value::text,''), coalesce(r.new_value::text,''),
                   coalesce(r.reason,''));
    v_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');

    IF v_hash <> r.row_hash THEN
      RETURN QUERY SELECT r.seq, r.occurred_at, r.row_hash, v_hash,
        'row_hash does not match recomputation'::text;
      RETURN;
    END IF;

    v_prev := r.row_hash;
  END LOOP;
  RETURN;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. RLS policies + grants
-- -----------------------------------------------------------------------------

-- Reads: admin/super_admin only (P8-read). Writes: none for any client role —
-- rows arrive exclusively through the SECURITY DEFINER writer above.
DROP POLICY IF EXISTS audit_log__admin_read ON public.audit_log;
CREATE POLICY audit_log__admin_read ON public.audit_log
  FOR SELECT TO authenticated USING (app.is_admin());

DROP POLICY IF EXISTS audit_seals__admin_read ON public.audit_seals;
CREATE POLICY audit_seals__admin_read ON public.audit_seals
  FOR SELECT TO authenticated USING (app.is_admin());

DROP POLICY IF EXISTS data_access_log__admin_read ON public.data_access_log;
CREATE POLICY data_access_log__admin_read ON public.data_access_log
  FOR SELECT TO authenticated USING (app.is_admin());

-- Export register: admins see all except audit-log exports (super_admin only).
DROP POLICY IF EXISTS export_log__admin_read ON public.export_log;
CREATE POLICY export_log__admin_read ON public.export_log
  FOR SELECT TO authenticated
  USING (app.is_admin() AND (subject <> 'audit_log' OR app.is_super_admin()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.audit_log, public.audit_seals,
                    public.data_access_log, public.export_log TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.audit_log, public.audit_seals,
                            public.data_access_log, public.export_log TO service_role;
    GRANT USAGE ON SEQUENCE public.audit_log_seq TO service_role;
  END IF;
END $$;

COMMIT;
