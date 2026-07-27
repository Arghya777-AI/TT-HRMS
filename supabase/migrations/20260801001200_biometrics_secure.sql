-- ============================================================================
-- Migration 012 — Biometrics (secure schema) + public self-service surfaces
-- Source: docs/plan/04-data-model.md §3.4 (biometrics, lines 1194–1306),
--         §3.1 (secure.webauthn_challenges / kiosk secrets / api_keys),
--         §4.8 (kiosk hard rule), docs/build/spec-migrations.md row 012.
--
-- HARD BOUNDARY: every table in schema `secure` is reachable ONLY by edge
-- functions running with the service role. RLS is ENABLED with ZERO policies,
-- and ALL privileges are revoked from anon/authenticated. The schema is not
-- exposed to PostgREST (removed from db.schemas in config.toml, migration 001
-- revoked schema usage). No browser session can ever read a face descriptor.
--
-- Cross-file interfaces used (defined in earlier migrations):
--   util.ist_date(timestamptz)  — migration 002
--   app.ctx_actor_id(), app.current_employee_id(), app.is_admin(),
--   app.admin_scope_covers(uuid) — migration 005
--   public.approval_status enum — migration 003
--   public.profiles (004), public.employees (008)
--
-- FKs to public.kiosk_devices / public.kiosk_operators are ADDED IN
-- MIGRATION 013 (those tables are created there); the uuid columns are
-- created here so the secure schema is complete in one file.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Touch/stamp trigger functions (§1.3).
--    Canonically created in migration 004; guarded creation here so this file
--    never redefines them if 004 already provided public.tg_touch/tg_stamp.
-- ----------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public.tg_touch()') IS NULL THEN
    CREATE FUNCTION public.tg_touch()
    RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
    BEGIN
      NEW.updated_at := now();
      NEW.updated_by := app.ctx_actor_id();
      RETURN NEW;
    END;
    $fn$;
  END IF;

  IF to_regprocedure('public.tg_stamp()') IS NULL THEN
    CREATE FUNCTION public.tg_stamp()
    RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
    BEGIN
      IF NEW.created_by IS NULL THEN
        NEW.created_by := app.ctx_actor_id();
      END IF;
      RETURN NEW;
    END;
    $fn$;
  END IF;
END;
$guard$;

-- ============================================================================
-- 1. secure.biometric_consents  (§3.4)
--    Consent is a legal precondition under India's DPDP Act 2023 for
--    processing biometric data. A face template cannot exist without one.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.biometric_consents (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id           uuid        NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  modality              text        NOT NULL,
  consent_version       text        NOT NULL,
  consent_text_hash     text        NOT NULL,  -- SHA-256 of the exact text displayed
  purpose               text        NOT NULL DEFAULT 'attendance_identification',
  granted               boolean     NOT NULL,
  granted_at            timestamptz NOT NULL DEFAULT now(),
  granted_via           text        NOT NULL,
  signature_document_id uuid        NULL,      -- loose pointer; public.documents is created in migration 025
  witnessed_by          uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  ip                    inet        NULL,
  device_id             uuid        NULL,      -- FK to public.kiosk_devices added in migration 013
  withdrawn_at          timestamptz NULL,
  withdrawal_reason     text        NULL,
  alternative_method    text        NULL,      -- what the employee uses after withdrawal; never "cannot be paid"
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_biometric_consents__modality
    CHECK (modality IN ('face','fingerprint','both')),
  CONSTRAINT ck_biometric_consents__granted_via
    CHECK (granted_via IN ('kiosk','web','paper_form')),
  CONSTRAINT ck_biometric_consents__alternative_method
    CHECK (alternative_method IS NULL
           OR alternative_method IN ('swipe_card','manual_register','fingerprint'))
);

COMMENT ON TABLE secure.biometric_consents IS
  'DPDP Act 2023 consent records for biometric processing. Service-role only.';

CREATE INDEX IF NOT EXISTS idx_biometric_consents__employee_modality
  ON secure.biometric_consents (employee_id, modality);
CREATE UNIQUE INDEX IF NOT EXISTS uq_biometric_consents__active
  ON secure.biometric_consents (employee_id, modality)
  WHERE withdrawn_at IS NULL AND granted;
CREATE INDEX IF NOT EXISTS idx_biometric_consents__device
  ON secure.biometric_consents (device_id);

ALTER TABLE secure.biometric_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.biometric_consents FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. secure.face_templates  (§3.4)
--    The 128-float embedding. real[] (not jsonb) so distance is computable in
--    SQL and a future pgvector migration is a type change, not a re-encode.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.face_templates (
  id                        uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id               uuid         NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  descriptor                real[]       NOT NULL,
  descriptor_dim            integer      NOT NULL DEFAULT 128,
  model_name                text         NOT NULL DEFAULT 'face_recognition_model',
  model_version             text         NOT NULL DEFAULT 'v1-vladmandic-1.7',
  detector                  text         NOT NULL DEFAULT 'tiny_face_detector@416/0.5',
  sample_count              integer      NOT NULL DEFAULT 5,
  quality_score             numeric(6,4) NOT NULL,  -- enrolment rejected below 0.70 (edge function)
  intra_sample_max_distance numeric(6,4) NOT NULL,  -- > 0.35 = inconsistent capture, rejected (edge function)
  yaw                       numeric(6,2) NULL,
  pitch                     numeric(6,2) NULL,
  roll                      numeric(6,2) NULL,
  brightness                numeric(6,4) NULL,
  blur_score                numeric(6,4) NULL,
  version                   integer      NOT NULL DEFAULT 1,
  is_active                 boolean      NOT NULL DEFAULT true,
  enrolled_by               uuid         NOT NULL REFERENCES public.profiles(id),
  enrolled_at               timestamptz  NOT NULL DEFAULT now(),
  enrolled_device_id        uuid         NULL,      -- FK to public.kiosk_devices added in migration 013
  enrolment_photo_path      text         NULL,      -- face-enrolment-captures/<employee_id>/v<version>.jpg
  consent_id                uuid         NOT NULL REFERENCES secure.biometric_consents(id),
  approved_by               uuid         NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at               timestamptz  NULL,
  deactivated_at            timestamptz  NULL,
  deactivation_reason       text         NULL,
  purged_at                 timestamptz  NULL,      -- when set, descriptor is zeroed; row kept as evidence
  CONSTRAINT ck_face_templates__dim
    CHECK (array_length(descriptor, 1) = descriptor_dim),
  CONSTRAINT ck_face_templates__quality
    CHECK (quality_score >= 0 AND quality_score <= 1)
);

COMMENT ON TABLE secure.face_templates IS
  'Face embeddings for 1:N kiosk identification. Unreachable by any browser token; service-role only.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_face_templates__employee_active
  ON secure.face_templates (employee_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_face_templates__active
  ON secure.face_templates (is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_face_templates__employee
  ON secure.face_templates (employee_id);
CREATE INDEX IF NOT EXISTS idx_face_templates__consent
  ON secure.face_templates (consent_id);
CREATE INDEX IF NOT EXISTS idx_face_templates__enrolled_device
  ON secure.face_templates (enrolled_device_id);

ALTER TABLE secure.face_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.face_templates FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. secure.face_template_history  (§3.4)
--    Immutable archive of every prior template version. Retained 24 months
--    after employee exit, then purged by the biometric retention job with an
--    audit_log entry.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.face_template_history (
  id                   uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  face_template_id     uuid         NOT NULL REFERENCES secure.face_templates(id) ON DELETE CASCADE,
  employee_id          uuid         NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  version              integer      NOT NULL,
  descriptor           real[]       NOT NULL,
  quality_score        numeric(6,4) NOT NULL,
  model_version        text         NOT NULL,
  superseded_at        timestamptz  NOT NULL DEFAULT now(),
  superseded_by        uuid         NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  supersede_reason     text         NULL,
  enrolment_photo_path text         NULL,
  recorded_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_face_template_history__template
  ON secure.face_template_history (face_template_id);
CREATE INDEX IF NOT EXISTS idx_face_template_history__employee
  ON secure.face_template_history (employee_id);

ALTER TABLE secure.face_template_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.face_template_history FROM PUBLIC, anon, authenticated;

-- trg_face_templates__version: archive the OLD row on any UPDATE of descriptor
-- or on deactivation (§3.4).
CREATE OR REPLACE FUNCTION secure.tg_face_templates_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO secure.face_template_history
    (face_template_id, employee_id, version, descriptor, quality_score,
     model_version, superseded_at, superseded_by, supersede_reason,
     enrolment_photo_path)
  VALUES
    (OLD.id, OLD.employee_id, OLD.version, OLD.descriptor, OLD.quality_score,
     OLD.model_version, now(), app.ctx_actor_id(),
     CASE
       WHEN OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL
         THEN COALESCE(NEW.deactivation_reason, 'deactivated')
       ELSE 'descriptor_updated'
     END,
     OLD.enrolment_photo_path);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION secure.tg_face_templates_version() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_face_templates__version
  AFTER UPDATE ON secure.face_templates
  FOR EACH ROW
  WHEN (OLD.descriptor IS DISTINCT FROM NEW.descriptor
        OR (OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL))
  EXECUTE FUNCTION secure.tg_face_templates_version();

-- ============================================================================
-- 4. secure.face_match_log  (§3.4) — EVERY 1:N identification attempt,
--    matched or not. Partitioned monthly by attempted_at (§12.3/§12.4,
--    UTC month boundaries — deliberate; do not "fix").
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.face_match_log (
  id                     uuid          NOT NULL DEFAULT gen_random_uuid(),
  attempted_at           timestamptz   NOT NULL DEFAULT now(),
  ist_date               date          NOT NULL GENERATED ALWAYS AS (util.ist_date(attempted_at)) STORED,
  kiosk_device_id        uuid          NULL,   -- FK to public.kiosk_devices added in migration 013
  operator_id            uuid          NULL,   -- FK to public.kiosk_operators added in migration 013
  candidate_set_size     integer       NOT NULL,  -- the "N" in 1:N
  outcome                text          NOT NULL,
  matched_employee_id    uuid          NULL REFERENCES public.employees(id),
  best_distance          numeric(8,5)  NULL,
  best_confidence        numeric(8,5)  NULL,   -- 1 - (best_distance / max_distance)
  runner_up_employee_id  uuid          NULL REFERENCES public.employees(id),
  runner_up_distance     numeric(8,5)  NULL,
  margin                 numeric(8,5)  NULL,   -- runner_up_distance - best_distance; < 0.06 => ambiguous
  candidate_scores       jsonb         NULL,   -- top-5 [{employee_id, distance}]; nulled at 90 days by retention job
  threshold_used         numeric(8,5)  NOT NULL,  -- pinned at decision time; later changes cannot rewrite history
  model_version          text          NOT NULL,
  detector_score         numeric(6,4)  NULL,
  liveness_score         numeric(6,4)  NULL,
  capture_photo_path     text          NULL,   -- kiosk-punch-photos/<ist_date>/<id>.jpg
  latency_ms             integer       NULL,
  produced_punch_id      uuid          NULL,   -- loose pointer: attendance_punches (migration 016) is partitioned
                                               -- with PK (id, punched_at), so a single-column FK is not possible
  ip                     inet          NULL,
  app_version            text          NULL,
  error_detail           text          NULL,
  CONSTRAINT pk_face_match_log PRIMARY KEY (id, attempted_at),
  CONSTRAINT ck_face_match_log__outcome
    CHECK (outcome IN ('matched','no_match','ambiguous','no_face','multiple_faces',
                       'low_quality','liveness_failed','error','duplicate_suppressed'))
) PARTITION BY RANGE (attempted_at);

COMMENT ON TABLE secure.face_match_log IS
  'Every 1:N identification attempt, matched or not — what makes a disputed punch defensible. Service-role only.';

-- Monthly partitions (UTC boundaries), created RELATIVE TO THE APPLY DATE:
-- previous month through +6. Hard-coded absolute months were a latent deploy
-- bug — applying the stack in a month with no partition makes the very first
-- face match fail with "no partition of relation found for row", and any
-- backfill of earlier months fails too.
-- Naming matches public.ensure_monthly_partition / partition_maintenance
-- (migration 031): replace(<regclass>::text, '.', '_') || '_YYYY_MM', so the
-- maintenance job never double-creates.
DO $$
DECLARE
  v_month date := (date_trunc('month', now()) - interval '1 month')::date;
  v_name  text;
  i       integer;
BEGIN
  FOR i IN 0..7 LOOP
    v_name := 'secure_face_match_log_' || to_char(v_month, 'YYYY_MM');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = v_name AND n.nspname = 'secure'
    ) THEN
      EXECUTE format(
        'CREATE TABLE secure.%I PARTITION OF secure.face_match_log FOR VALUES FROM (%L) TO (%L)',
        v_name, v_month, (v_month + interval '1 month')::date);
    END IF;
    v_month := (v_month + interval '1 month')::date;
  END LOOP;
END $$;

-- Named indexes (§3.4 / §12.1); partitioned indexes propagate to partitions.
CREATE INDEX IF NOT EXISTS idx_fml__ist_date_outcome
  ON secure.face_match_log (ist_date, outcome);
CREATE INDEX IF NOT EXISTS idx_fml__employee_time
  ON secure.face_match_log (matched_employee_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_fml__device_time
  ON secure.face_match_log (kiosk_device_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_fml__punch
  ON secure.face_match_log (produced_punch_id);
CREATE INDEX IF NOT EXISTS idx_fml__operator
  ON secure.face_match_log (operator_id);

ALTER TABLE secure.face_match_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.secure_face_match_log_2026_08 ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.secure_face_match_log_2026_09 ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.secure_face_match_log_2026_10 ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.secure_face_match_log_2026_11 ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.secure_face_match_log_2026_12 ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.secure_face_match_log_2027_01 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.face_match_log FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. secure.webauthn_challenges  (§3.1)
--    Server-issued WebAuthn challenges; single-use; reaped by cron every 15m.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.webauthn_challenges (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lookup      text        NOT NULL,  -- profile_id (registration) / lowercased email (login) / kiosk:<device_id> (attendance)
  challenge   text        NOT NULL,  -- base64url, 32 random bytes
  purpose     text        NOT NULL,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '3 minutes'),
  consumed_at timestamptz NULL,      -- single-use; a consumed challenge is never re-verifiable
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_webauthn_challenges__purpose
    CHECK (purpose IN ('register','login','attendance'))
);

CREATE INDEX IF NOT EXISTS idx_wac__lookup_live
  ON secure.webauthn_challenges (lookup) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wac__expires
  ON secure.webauthn_challenges (expires_at);

ALTER TABLE secure.webauthn_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.webauthn_challenges FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 6. secure.kiosk_nonces  (§4.8)
--    Replay cache for HMAC-signed kiosk requests; 10-minute TTL; a nonce seen
--    twice within its TTL is a replay and the request is rejected.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.kiosk_nonces (
  device_id  uuid        NOT NULL,   -- FK to public.kiosk_devices added in migration 013
  nonce      text        NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT pk_kiosk_nonces PRIMARY KEY (device_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_kiosk_nonces__expires
  ON secure.kiosk_nonces (expires_at);

ALTER TABLE secure.kiosk_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.kiosk_nonces FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 7. secure.kiosk_device_secrets  (§3.1)
--    HMAC shared secrets, Argon2id-hashed. Kept out of public.kiosk_devices so
--    even an admin-readable device row never exposes the secret.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.kiosk_device_secrets (
  device_id            uuid        NOT NULL PRIMARY KEY,  -- FK to public.kiosk_devices added in migration 013
  secret_hash          text        NOT NULL,              -- Argon2id
  secret_rotated_at    timestamptz NULL,
  previous_secret_hash text        NULL,
  rotation_grace_until timestamptz NULL
);

ALTER TABLE secure.kiosk_device_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.kiosk_device_secrets FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 8. secure.kiosk_operator_secrets  (§3.1)
--    Guard PINs (6-digit, Argon2id) for fast operator switching. Same
--    rotation shape as device secrets; lockout counters live server-side.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.kiosk_operator_secrets (
  operator_id          uuid        NOT NULL PRIMARY KEY,  -- FK to public.kiosk_operators added in migration 013
  pin_hash             text        NOT NULL,              -- Argon2id
  pin_rotated_at       timestamptz NULL,
  previous_pin_hash    text        NULL,
  rotation_grace_until timestamptz NULL,
  failed_attempts      integer     NOT NULL DEFAULT 0,
  locked_until         timestamptz NULL
);

ALTER TABLE secure.kiosk_operator_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.kiosk_operator_secrets FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 9. secure.api_keys  (§3.1)
--    Machine credentials for the kiosk, the biometric device bridge, and any
--    future integration. Managed by the admin-api-keys edge function only.
-- ============================================================================
CREATE TABLE IF NOT EXISTS secure.api_keys (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name               text        NOT NULL,
  key_prefix         text        NOT NULL,   -- first 8 chars, shown in admin UI for identification
  key_hash           text        NOT NULL,   -- Argon2id of the full key; full key displayed exactly once
  scopes             text[]      NOT NULL DEFAULT '{}',
  kiosk_device_id    uuid        NULL,       -- FK to public.kiosk_devices added in migration 013
  rate_limit_per_min integer     NOT NULL DEFAULT 120,
  expires_at         timestamptz NULL,
  last_used_at       timestamptz NULL,
  revoked_at         timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys__key_prefix
  ON secure.api_keys (key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys__device
  ON secure.api_keys (kiosk_device_id);

CREATE OR REPLACE TRIGGER trg_api_keys__touch
  BEFORE UPDATE ON secure.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch();
CREATE OR REPLACE TRIGGER trg_api_keys__stamp
  BEFORE INSERT ON secure.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp();

ALTER TABLE secure.api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.api_keys FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 10. public.face_enrolment_requests  (§3.4)
--     Employee-initiated self-enrolment awaiting HR approval. The descriptor
--     is computed server-side in the face-enrol edge function; the browser
--     never computes or uploads a descriptor.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.face_enrolment_requests (
  id                    uuid                   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id           uuid                   NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  requested_at          timestamptz            NOT NULL DEFAULT now(),
  requested_via         text                   NOT NULL,
  capture_path          text                   NOT NULL,  -- private bucket face-enrolment-captures
  quality_score         numeric(6,4)           NULL,
  status                public.approval_status NOT NULL DEFAULT 'pending',
  reviewed_by           uuid                   NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at           timestamptz            NULL,
  review_comment        text                   NULL,
  resulting_template_id uuid                   NULL,  -- loose, non-FK pointer to secure.face_templates (deliberate: grants no visibility)
  created_at            timestamptz            NOT NULL DEFAULT now(),
  created_by            uuid                   NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            timestamptz            NOT NULL DEFAULT now(),
  updated_by            uuid                   NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_face_enrolment_requests__via CHECK (requested_via IN ('web','kiosk')),
  CONSTRAINT ck_face_enrolment_requests__quality
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1))
);

CREATE INDEX IF NOT EXISTS idx_face_enrolment_requests__employee
  ON public.face_enrolment_requests (employee_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_face_enrolment_requests__pending
  ON public.face_enrolment_requests (status) WHERE status = 'pending';

CREATE OR REPLACE TRIGGER trg_face_enrolment_requests__touch
  BEFORE UPDATE ON public.face_enrolment_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch();
CREATE OR REPLACE TRIGGER trg_face_enrolment_requests__stamp
  BEFORE INSERT ON public.face_enrolment_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp();
-- Audit trigger (audit.log_changes) is attached in migration 038 with the
-- other 69 attach statements.

ALTER TABLE public.face_enrolment_requests ENABLE ROW LEVEL SECURITY;

-- P1: self insert/read. status/reviewed_* are not client-settable at insert;
-- decisions happen through the approvals RPC / admin update.
DROP POLICY IF EXISTS face_enrolment_requests__self_select ON public.face_enrolment_requests;
CREATE POLICY face_enrolment_requests__self_select ON public.face_enrolment_requests
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS face_enrolment_requests__self_insert ON public.face_enrolment_requests;
CREATE POLICY face_enrolment_requests__self_insert ON public.face_enrolment_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = app.current_employee_id()
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND resulting_template_id IS NULL
  );

-- P8: admin all (scoped).
DROP POLICY IF EXISTS face_enrolment_requests__admin_select ON public.face_enrolment_requests;
CREATE POLICY face_enrolment_requests__admin_select ON public.face_enrolment_requests
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS face_enrolment_requests__admin_insert ON public.face_enrolment_requests;
CREATE POLICY face_enrolment_requests__admin_insert ON public.face_enrolment_requests
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS face_enrolment_requests__admin_update ON public.face_enrolment_requests;
CREATE POLICY face_enrolment_requests__admin_update ON public.face_enrolment_requests
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

REVOKE ALL ON TABLE public.face_enrolment_requests FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.face_enrolment_requests TO authenticated;

-- ============================================================================
-- 11. public.v_my_biometric_status  (§3.4 / §9)
--     SECURITY DEFINER view (default view semantics: runs as owner, bypassing
--     the zero-policy RLS on secure.*): the employee's OWN consent status +
--     enrolment flags — never the descriptor. Enables self-service withdrawal
--     without exposing the secure schema.
-- ============================================================================
CREATE OR REPLACE VIEW public.v_my_biometric_status
WITH (security_barrier = true) AS
SELECT
  bc.modality,
  bc.granted,
  bc.granted_at,
  bc.withdrawn_at,
  (ft.id IS NOT NULL)  AS face_template_active,
  ft.version           AS face_template_version,
  ft.enrolled_at       AS face_enrolled_at
FROM secure.biometric_consents bc
LEFT JOIN secure.face_templates ft
  ON ft.employee_id = bc.employee_id
 AND ft.is_active
 AND bc.modality IN ('face','both')
WHERE bc.employee_id = app.current_employee_id();

REVOKE ALL ON TABLE public.v_my_biometric_status FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.v_my_biometric_status TO authenticated;

-- ============================================================================
-- 12. public.v_face_match_audit  (§3.4)
--     SECURITY DEFINER view restricted by app.is_admin(): everything except
--     candidate_scores (those are super-admin-only, via
--     rpc.reveal_face_match_candidates(id, reason) — migration 032).
-- ============================================================================
CREATE OR REPLACE VIEW public.v_face_match_audit
WITH (security_barrier = true) AS
SELECT
  fml.id,
  fml.attempted_at,
  fml.ist_date,
  fml.kiosk_device_id,
  fml.operator_id,
  fml.candidate_set_size,
  fml.outcome,
  fml.matched_employee_id,
  fml.best_distance,
  fml.best_confidence,
  fml.runner_up_employee_id,
  fml.runner_up_distance,
  fml.margin,
  fml.threshold_used,
  fml.model_version,
  fml.detector_score,
  fml.liveness_score,
  fml.capture_photo_path,
  fml.latency_ms,
  fml.produced_punch_id,
  fml.ip,
  fml.app_version,
  fml.error_detail
FROM secure.face_match_log fml
WHERE app.is_admin();

REVOKE ALL ON TABLE public.v_face_match_audit FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.v_face_match_audit TO authenticated;

-- ============================================================================
-- 13. Belt-and-braces: zero-grant sweep for the whole secure schema, and an
--     explicit grant to the service role where that role exists (hosted
--     Supabase; the vanilla validation harness may not define it).
-- ============================================================================
REVOKE ALL ON ALL TABLES IN SCHEMA secure FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA secure TO service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA secure TO service_role;
  END IF;
END;
$$;

COMMIT;
