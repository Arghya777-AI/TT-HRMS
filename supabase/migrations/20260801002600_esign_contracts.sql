-- =============================================================================
-- Migration 026 — e-sign engine + contracts
-- Source: docs/plan/04-data-model.md §3.9 e-sign tables (lines 2306–2318) and
--         §3.10 Contracts & e-Sign (lines 2322–2335); spec-migrations §2 row 026.
-- Tables: e_sign_requests, e_sign_signers, e_sign_events, contract_templates,
--         contracts, contract_clauses, contract_events, v_contract_signers.
--
-- Design notes:
--   * ONE signing engine (doc §3.10): contract_signers is a VIEW over
--     e_sign_signers, not a table.
--   * Signer access tokens are secret material — hashed at rest in
--     secure.esign_signer_tokens (zero-policy RLS), never in public. Mirrors
--     the kiosk secret split (012/013).
--   * e_sign_requests.contract_id and contracts.esign_request_id are mutually
--     referencing; the e_sign_requests-side FK is attached after contracts
--     exists (same transaction).
--   * app.is_esign_participant() is a new SECURITY DEFINER helper: request
--     and signer policies reference each other's tables, and expressing both
--     as plain subqueries would recurse RLS.
-- Forward FKs deferred to 20260801004900_deferred_fks.sql:
--   contracts.approval_request_id  -> approval_requests (029)
--   contract_clauses.ai_message_id -> ai_messages       (030)
-- Enums esign_status / signer_status already exist (003) — not recreated.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. e_sign_requests
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.e_sign_requests (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  request_number          text        NOT NULL,
  document_id             uuid        NULL,
  contract_id             uuid        NULL,  -- FK added below, after contracts exists
  subject_employee_id     uuid        NULL,
  title                   text        NOT NULL,
  message                 text        NULL,
  status                  public.esign_status NOT NULL DEFAULT 'draft',
  signing_order           text        NOT NULL DEFAULT 'sequential',
  expires_at              timestamptz NULL,
  reminder_schedule_days  integer[]   NOT NULL DEFAULT '{3,7,10}',
  completed_document_id   uuid        NULL,
  certificate_hash        text        NULL,
  sent_at                 timestamptz NULL,
  completed_at            timestamptz NULL,
  cancelled_by            uuid        NULL,
  cancelled_at            timestamptz NULL,
  cancelled_reason        text        NULL,
  legal_framework         text        NOT NULL DEFAULT 'IT Act 2000 s.10A (electronic record + audit trail)',
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        NULL,
  CONSTRAINT pk_e_sign_requests PRIMARY KEY (id),
  CONSTRAINT fk_e_sign_requests__document_id
    FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_e_sign_requests__subject_employee_id
    FOREIGN KEY (subject_employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_e_sign_requests__completed_document_id
    FOREIGN KEY (completed_document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_e_sign_requests__cancelled_by
    FOREIGN KEY (cancelled_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_e_sign_requests__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_e_sign_requests__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_e_sign_requests__signing_order
    CHECK (signing_order IN ('sequential','parallel')),
  CONSTRAINT ck_e_sign_requests__cancelled_reason CHECK (
    cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND length(btrim(cancelled_reason)) >= 10))
);

COMMENT ON COLUMN public.e_sign_requests.completed_document_id IS
  'The signed PDF with the certificate page.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_e_sign_requests__request_number
  ON public.e_sign_requests (request_number);
CREATE INDEX IF NOT EXISTS idx_e_sign_requests__document_id
  ON public.e_sign_requests (document_id);
CREATE INDEX IF NOT EXISTS idx_e_sign_requests__contract_id
  ON public.e_sign_requests (contract_id);
CREATE INDEX IF NOT EXISTS idx_e_sign_requests__subject_employee_id
  ON public.e_sign_requests (subject_employee_id);
CREATE INDEX IF NOT EXISTS idx_e_sign_requests__completed_document_id
  ON public.e_sign_requests (completed_document_id);
CREATE INDEX IF NOT EXISTS idx_e_sign_requests__status
  ON public.e_sign_requests (status) WHERE status IN ('sent','partially_signed');

DROP TRIGGER IF EXISTS trg_e_sign_requests__stamp ON public.e_sign_requests;
CREATE TRIGGER trg_e_sign_requests__stamp
  BEFORE INSERT ON public.e_sign_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_e_sign_requests__touch ON public.e_sign_requests;
CREATE TRIGGER trg_e_sign_requests__touch
  BEFORE UPDATE ON public.e_sign_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- -----------------------------------------------------------------------------
-- 2. e_sign_signers (+ token hashes in secure)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.e_sign_signers (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  esign_request_id          uuid        NOT NULL,
  signer_order              integer     NOT NULL DEFAULT 1,
  signer_kind               text        NOT NULL,
  employee_id               uuid        NULL,
  full_name                 text        NOT NULL,
  email                     text        NULL,
  mobile                    text        NULL,
  designation_snapshot      text        NULL,
  token_expires_at          timestamptz NULL,
  identity_check_kind       text        NOT NULL DEFAULT 'none',
  identity_check_value_hash text        NULL,
  identity_verified_at      timestamptz NULL,
  identity_attempts         integer     NOT NULL DEFAULT 0,
  status                    public.signer_status NOT NULL DEFAULT 'pending',
  notified_at               timestamptz NULL,
  viewed_at                 timestamptz NULL,
  signed_at                 timestamptz NULL,
  signature_image_path      text        NULL,
  signature_kind            text        NULL,
  declined_reason           text        NULL,
  ip                        inet        NULL,
  user_agent                text        NULL,
  geo                       jsonb       NULL,
  timezone                  text        NULL,
  pages_signed              integer[]   NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NULL,
  CONSTRAINT pk_e_sign_signers PRIMARY KEY (id),
  CONSTRAINT fk_e_sign_signers__esign_request_id
    FOREIGN KEY (esign_request_id) REFERENCES public.e_sign_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_e_sign_signers__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_e_sign_signers__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_e_sign_signers__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_e_sign_signers__signer_kind CHECK (signer_kind IN
    ('employee','manager','hr','authorised_signatory','witness','candidate','external')),
  CONSTRAINT ck_e_sign_signers__identity_check_kind CHECK (identity_check_kind IN
    ('otp_email','otp_sms','dob','id_last4','custom_question','none')),
  CONSTRAINT ck_e_sign_signers__signature_kind CHECK (signature_kind IS NULL OR
    signature_kind IN ('drawn','typed','uploaded','aadhaar_esign')),
  CONSTRAINT ck_e_sign_signers__signer_order CHECK (signer_order >= 1),
  CONSTRAINT ck_e_sign_signers__identity_attempts CHECK (identity_attempts >= 0),
  CONSTRAINT ck_e_sign_signers__email CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_e_sign_signers__mobile CHECK (mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$')
);

-- Non-unique on purpose: a delegated signer is re-issued as a new row at the
-- same signer_order; the esign-flow edge function owns order integrity.
CREATE INDEX IF NOT EXISTS idx_e_sign_signers__request_order
  ON public.e_sign_signers (esign_request_id, signer_order);
CREATE INDEX IF NOT EXISTS idx_e_sign_signers__employee_id
  ON public.e_sign_signers (employee_id);
CREATE INDEX IF NOT EXISTS idx_e_sign_signers__status
  ON public.e_sign_signers (status) WHERE status IN ('pending','notified','viewed');

DROP TRIGGER IF EXISTS trg_e_sign_signers__stamp ON public.e_sign_signers;
CREATE TRIGGER trg_e_sign_signers__stamp
  BEFORE INSERT ON public.e_sign_signers
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_e_sign_signers__touch ON public.e_sign_signers;
CREATE TRIGGER trg_e_sign_signers__touch
  BEFORE UPDATE ON public.e_sign_signers
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- The doc's access_token (unique, 32 random bytes, "hashed at rest in secure")
-- lives here — sha256 hash only, service-role reachable only. The public
-- /sign/:token route is served by the esign-flow edge function which hashes
-- the presented token and looks it up here.
CREATE TABLE IF NOT EXISTS secure.esign_signer_tokens (
  signer_id   uuid        NOT NULL,
  token_hash  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NULL,
  revoked_at  timestamptz NULL,
  CONSTRAINT pk_esign_signer_tokens PRIMARY KEY (signer_id),
  CONSTRAINT fk_esign_signer_tokens__signer_id
    FOREIGN KEY (signer_id) REFERENCES public.e_sign_signers(id) ON DELETE CASCADE,
  CONSTRAINT ck_esign_signer_tokens__hash CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_esign_signer_tokens__token_hash
  ON secure.esign_signer_tokens (token_hash);

ALTER TABLE secure.esign_signer_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.esign_signer_tokens FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. e_sign_events — append-only
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.e_sign_events (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  esign_request_id  uuid        NOT NULL,
  signer_id         uuid        NULL,
  event             text        NOT NULL,
  payload           jsonb       NULL,
  ip                inet        NULL,
  user_agent        text        NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by       uuid        NULL,
  CONSTRAINT pk_e_sign_events PRIMARY KEY (id),
  CONSTRAINT fk_e_sign_events__esign_request_id
    FOREIGN KEY (esign_request_id) REFERENCES public.e_sign_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_e_sign_events__signer_id
    FOREIGN KEY (signer_id) REFERENCES public.e_sign_signers(id) ON DELETE RESTRICT,
  CONSTRAINT ck_e_sign_events__event CHECK (event IN
    ('created','sent','delivered','bounced','opened','viewed_page','identity_passed',
     'identity_failed','signed','declined','reminded','expired','cancelled',
     'completed','certificate_generated'))
);

CREATE INDEX IF NOT EXISTS idx_e_sign_events__request_time
  ON public.e_sign_events (esign_request_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_e_sign_events__signer_id
  ON public.e_sign_events (signer_id);
CREATE INDEX IF NOT EXISTS idx_e_sign_events__recorded_at_brin
  ON public.e_sign_events USING brin (recorded_at);

DROP TRIGGER IF EXISTS trg_e_sign_events__immutable ON public.e_sign_events;
CREATE TRIGGER trg_e_sign_events__immutable
  BEFORE UPDATE OR DELETE ON public.e_sign_events
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

-- -----------------------------------------------------------------------------
-- 4. app.is_esign_participant — RLS helper (definer; breaks policy recursion)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.is_esign_participant(p_request_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.e_sign_requests r
    WHERE r.id = p_request_id
      AND r.subject_employee_id IS NOT NULL
      AND r.subject_employee_id = app.current_employee_id()
  ) OR EXISTS (
    SELECT 1 FROM public.e_sign_signers s
    WHERE s.esign_request_id = p_request_id
      AND s.employee_id IS NOT NULL
      AND s.employee_id = app.current_employee_id()
  );
$$;

REVOKE EXECUTE ON FUNCTION app.is_esign_participant(uuid) FROM PUBLIC;
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION app.is_esign_participant(uuid) TO %I', v_role);
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 5. RLS for the e-sign engine
-- -----------------------------------------------------------------------------
-- Anonymous signer access is ONLY through the /sign/:token route served by the
-- esign-flow edge function (service role, token-gated via secure.esign_signer_tokens).
-- authenticated users: P1 (own requests, as subject or signer), P5 manager
-- read, P8 admin all.

ALTER TABLE public.e_sign_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS e_sign_requests__self__select ON public.e_sign_requests;
CREATE POLICY e_sign_requests__self__select ON public.e_sign_requests
  FOR SELECT TO authenticated
  USING (app.is_esign_participant(id));

DROP POLICY IF EXISTS e_sign_requests__manager__select ON public.e_sign_requests;
CREATE POLICY e_sign_requests__manager__select ON public.e_sign_requests
  FOR SELECT TO authenticated
  USING (subject_employee_id IS NOT NULL AND app.is_manager_of(subject_employee_id));

DROP POLICY IF EXISTS e_sign_requests__admin__all ON public.e_sign_requests;
CREATE POLICY e_sign_requests__admin__all ON public.e_sign_requests
  FOR ALL TO authenticated
  USING (app.is_admin() AND (subject_employee_id IS NULL OR app.admin_scope_covers(subject_employee_id)))
  WITH CHECK (app.is_admin() AND (subject_employee_id IS NULL OR app.admin_scope_covers(subject_employee_id)));

ALTER TABLE public.e_sign_signers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS e_sign_signers__self__select ON public.e_sign_signers;
CREATE POLICY e_sign_signers__self__select ON public.e_sign_signers
  FOR SELECT TO authenticated
  USING (app.is_esign_participant(esign_request_id));

DROP POLICY IF EXISTS e_sign_signers__manager__select ON public.e_sign_signers;
CREATE POLICY e_sign_signers__manager__select ON public.e_sign_signers
  FOR SELECT TO authenticated
  USING (employee_id IS NOT NULL AND app.is_manager_of(employee_id));

DROP POLICY IF EXISTS e_sign_signers__admin__all ON public.e_sign_signers;
CREATE POLICY e_sign_signers__admin__all ON public.e_sign_signers
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

ALTER TABLE public.e_sign_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS e_sign_events__participant__select ON public.e_sign_events;
CREATE POLICY e_sign_events__participant__select ON public.e_sign_events
  FOR SELECT TO authenticated
  USING (app.is_esign_participant(esign_request_id));

DROP POLICY IF EXISTS e_sign_events__admin__select ON public.e_sign_events;
CREATE POLICY e_sign_events__admin__select ON public.e_sign_events
  FOR SELECT TO authenticated
  USING (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.e_sign_requests, public.e_sign_signers TO authenticated;
REVOKE DELETE ON public.e_sign_requests, public.e_sign_signers FROM authenticated;
GRANT SELECT ON public.e_sign_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.e_sign_events FROM authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.e_sign_events TO service_role;
    REVOKE UPDATE, DELETE ON public.e_sign_events FROM service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. contract_templates (lookup shape)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contract_templates (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id                  uuid        NOT NULL,
  code                        text        NOT NULL,
  name                        text        NOT NULL,
  description                 text        NULL,
  sort_order                  integer     NOT NULL DEFAULT 100,
  is_active                   boolean     NOT NULL DEFAULT true,
  contract_kind               text        NOT NULL,
  body_markdown               text        NOT NULL,
  variables                   jsonb       NULL,
  default_clause_ids          uuid[]      NULL,
  governing_law               text        NOT NULL DEFAULT 'Laws of India; courts at Bengaluru, Karnataka',
  jurisdiction                text        NOT NULL DEFAULT 'Bengaluru',
  requires_witness            boolean     NOT NULL DEFAULT false,
  signatory_designation_ids   uuid[]      NULL,
  version                     integer     NOT NULL DEFAULT 1,
  is_published                boolean     NOT NULL DEFAULT false,
  published_by                uuid        NULL,
  published_at                timestamptz NULL,
  approved_by_legal_at        timestamptz NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  deleted_at                  timestamptz NULL,
  deleted_by                  uuid        NULL,
  deletion_reason             text        NULL,
  CONSTRAINT pk_contract_templates PRIMARY KEY (id),
  CONSTRAINT fk_contract_templates__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contract_templates__published_by
    FOREIGN KEY (published_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_templates__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_templates__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_templates__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_contract_templates__contract_kind CHECK (contract_kind IN
    ('employment_permanent','employment_probation','fixed_term','internship',
     'consultant','retainer','casual_daily_wage','nda','non_compete','training_bond')),
  CONSTRAINT ck_contract_templates__version CHECK (version >= 1),
  CONSTRAINT ck_contract_templates__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE public.contract_templates IS
  'Indian-law templates only (Karnataka Shops & Commercial Establishments Act 1961, Code on Wages 2019, Payment of Gratuity Act 1972, DPDP Act 2023 biometric consent language). variables = [{token, label, required, source}] where source is a deterministic path like employee.display_name.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_templates__company_code
  ON public.contract_templates (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contract_templates__company_id
  ON public.contract_templates (company_id);

DROP TRIGGER IF EXISTS trg_contract_templates__stamp ON public.contract_templates;
CREATE TRIGGER trg_contract_templates__stamp
  BEFORE INSERT ON public.contract_templates
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_contract_templates__touch ON public.contract_templates;
CREATE TRIGGER trg_contract_templates__touch
  BEFORE UPDATE ON public.contract_templates
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.contract_templates ENABLE ROW LEVEL SECURITY;

-- P8 only (§4.4: employees and managers have no access to templates).
DROP POLICY IF EXISTS contract_templates__admin__all ON public.contract_templates;
CREATE POLICY contract_templates__admin__all ON public.contract_templates
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.contract_templates TO authenticated;
REVOKE DELETE ON public.contract_templates FROM authenticated;

-- -----------------------------------------------------------------------------
-- 7. contracts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contracts (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  contract_number             text        NOT NULL,
  contract_template_id        uuid        NULL,
  employee_id                 uuid        NULL,
  candidate_name              text        NULL,
  candidate_email             text        NULL,
  candidate_mobile            text        NULL,
  candidate_address           jsonb       NULL,
  candidate_id_kind           text        NULL,
  candidate_id_last4          text        NULL,
  contract_kind               text        NOT NULL,
  designation_id              uuid        NULL,
  department_id               uuid        NULL,
  location_id                 uuid        NULL,
  grade_id                    uuid        NULL,
  reporting_manager_id        uuid        NULL,
  start_date                  date        NULL,
  end_date                    date        NULL,
  probation_months            integer     NULL,
  notice_period_days          integer     NULL,
  monthly_ctc_paise           bigint      NULL,
  annual_ctc_paise            bigint      NULL,
  salary_structure_id         uuid        NULL,
  working_hours_text          text        NULL,
  weekly_off_text             text        NULL,
  variables                   jsonb       NULL,
  rendered_html               text        NULL,
  rendered_pdf_document_id    uuid        NULL,
  status                      text        NOT NULL DEFAULT 'draft',
  esign_request_id            uuid        NULL,
  approval_request_id         uuid        NULL,  -- FK deferred (approval_requests, 029)
  sent_at                     timestamptz NULL,
  signed_at                   timestamptz NULL,
  superseded_by_contract_id   uuid        NULL,
  linked_lifecycle_event_id   uuid        NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  deleted_at                  timestamptz NULL,
  deleted_by                  uuid        NULL,
  deletion_reason             text        NULL,
  CONSTRAINT pk_contracts PRIMARY KEY (id),
  CONSTRAINT fk_contracts__contract_template_id
    FOREIGN KEY (contract_template_id) REFERENCES public.contract_templates(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__designation_id
    FOREIGN KEY (designation_id) REFERENCES public.designations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__department_id
    FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__location_id
    FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__grade_id
    FOREIGN KEY (grade_id) REFERENCES public.grades(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__reporting_manager_id
    FOREIGN KEY (reporting_manager_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__salary_structure_id
    FOREIGN KEY (salary_structure_id) REFERENCES public.salary_structures(id) ON DELETE RESTRICT,
  CONSTRAINT fk_contracts__rendered_pdf_document_id
    FOREIGN KEY (rendered_pdf_document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_contracts__esign_request_id
    FOREIGN KEY (esign_request_id) REFERENCES public.e_sign_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_contracts__superseded_by_contract_id
    FOREIGN KEY (superseded_by_contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL,
  CONSTRAINT fk_contracts__linked_lifecycle_event_id
    FOREIGN KEY (linked_lifecycle_event_id) REFERENCES public.employee_lifecycle_events(id) ON DELETE SET NULL,
  CONSTRAINT fk_contracts__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contracts__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contracts__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_contracts__contract_kind CHECK (contract_kind IN
    ('employment_permanent','employment_probation','fixed_term','internship',
     'consultant','retainer','casual_daily_wage','nda','non_compete','training_bond')),
  CONSTRAINT ck_contracts__status CHECK (status IN
    ('draft','pending_internal_approval','approved_to_send','sent','partially_signed',
     'signed','declined','expired','cancelled','superseded')),
  CONSTRAINT ck_contracts__candidate_email
    CHECK (candidate_email IS NULL OR candidate_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_contracts__candidate_mobile
    CHECK (candidate_mobile IS NULL OR candidate_mobile ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT ck_contracts__candidate_id_last4
    CHECK (candidate_id_last4 IS NULL OR candidate_id_last4 ~ '^[A-Za-z0-9]{4}$'),
  CONSTRAINT ck_contracts__dates CHECK (
    (start_date IS NULL OR start_date < DATE '2100-01-01') AND
    (end_date   IS NULL OR (end_date < DATE '2100-01-01' AND (start_date IS NULL OR end_date >= start_date)))),
  CONSTRAINT ck_contracts__probation_months
    CHECK (probation_months IS NULL OR probation_months BETWEEN 0 AND 24),
  CONSTRAINT ck_contracts__notice_period_days
    CHECK (notice_period_days IS NULL OR notice_period_days BETWEEN 0 AND 365),
  CONSTRAINT ck_contracts__ctc_nonneg CHECK (
    (monthly_ctc_paise IS NULL OR monthly_ctc_paise >= 0) AND
    (annual_ctc_paise  IS NULL OR annual_ctc_paise  >= 0)),
  CONSTRAINT ck_contracts__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE public.contracts IS
  'contract_number format TT/CON/<year>/<seq>, e.g. TT/CON/2026/0042. employee_id nullable: a contract can precede the employee record; linked on acceptance.';
COMMENT ON COLUMN public.contracts.variables IS 'Resolved template variable values.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_contracts__contract_number
  ON public.contracts (contract_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contracts__employee_id            ON public.contracts (employee_id);
CREATE INDEX IF NOT EXISTS idx_contracts__contract_template_id   ON public.contracts (contract_template_id);
CREATE INDEX IF NOT EXISTS idx_contracts__designation_id         ON public.contracts (designation_id);
CREATE INDEX IF NOT EXISTS idx_contracts__department_id          ON public.contracts (department_id);
CREATE INDEX IF NOT EXISTS idx_contracts__location_id            ON public.contracts (location_id);
CREATE INDEX IF NOT EXISTS idx_contracts__grade_id               ON public.contracts (grade_id);
CREATE INDEX IF NOT EXISTS idx_contracts__reporting_manager_id   ON public.contracts (reporting_manager_id);
CREATE INDEX IF NOT EXISTS idx_contracts__salary_structure_id    ON public.contracts (salary_structure_id);
CREATE INDEX IF NOT EXISTS idx_contracts__rendered_pdf_document_id ON public.contracts (rendered_pdf_document_id);
CREATE INDEX IF NOT EXISTS idx_contracts__esign_request_id       ON public.contracts (esign_request_id);
CREATE INDEX IF NOT EXISTS idx_contracts__approval_request_id    ON public.contracts (approval_request_id);
CREATE INDEX IF NOT EXISTS idx_contracts__superseded_by          ON public.contracts (superseded_by_contract_id);
CREATE INDEX IF NOT EXISTS idx_contracts__lifecycle_event        ON public.contracts (linked_lifecycle_event_id);
CREATE INDEX IF NOT EXISTS idx_contracts__status
  ON public.contracts (status) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_contracts__stamp ON public.contracts;
CREATE TRIGGER trg_contracts__stamp
  BEFORE INSERT ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_contracts__touch ON public.contracts;
CREATE TRIGGER trg_contracts__touch
  BEFORE UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

-- P1: the employee's own signed contract, read-only after 'signed'.
DROP POLICY IF EXISTS contracts__self__select ON public.contracts;
CREATE POLICY contracts__self__select ON public.contracts
  FOR SELECT TO authenticated
  USING (
    employee_id IS NOT NULL
    AND employee_id = app.current_employee_id()
    AND status = 'signed'
    AND deleted_at IS NULL);

-- P8: HR admin full read/write.
DROP POLICY IF EXISTS contracts__admin__all ON public.contracts;
CREATE POLICY contracts__admin__all ON public.contracts
  FOR ALL TO authenticated
  USING (app.is_admin() AND (employee_id IS NULL OR app.admin_scope_covers(employee_id)))
  WITH CHECK (app.is_admin() AND (employee_id IS NULL OR app.admin_scope_covers(employee_id)));

GRANT SELECT, INSERT, UPDATE ON public.contracts TO authenticated;
REVOKE DELETE ON public.contracts FROM authenticated;

-- Close the mutual reference: e_sign_requests.contract_id -> contracts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.e_sign_requests'::regclass
      AND conname = 'fk_e_sign_requests__contract_id') THEN
    ALTER TABLE public.e_sign_requests
      ADD CONSTRAINT fk_e_sign_requests__contract_id
      FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 8. contract_clauses
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contract_clauses (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  contract_id           uuid        NULL,
  contract_template_id  uuid        NULL,
  sequence              integer     NOT NULL DEFAULT 1,
  heading               text        NOT NULL,
  body_markdown         text        NOT NULL,
  is_mandatory          boolean     NOT NULL DEFAULT false,
  is_ai_generated       boolean     NOT NULL DEFAULT false,
  ai_message_id         uuid        NULL,  -- FK deferred (ai_messages, 030)
  edited_by             uuid        NULL,
  edited_at             timestamptz NULL,
  clause_library_code   text        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NULL,
  CONSTRAINT pk_contract_clauses PRIMARY KEY (id),
  CONSTRAINT fk_contract_clauses__contract_id
    FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE,
  CONSTRAINT fk_contract_clauses__contract_template_id
    FOREIGN KEY (contract_template_id) REFERENCES public.contract_templates(id) ON DELETE CASCADE,
  CONSTRAINT fk_contract_clauses__edited_by
    FOREIGN KEY (edited_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_clauses__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_clauses__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Exactly one parent: a clause belongs to a contract OR a template.
  CONSTRAINT ck_contract_clauses__exactly_one_parent CHECK (
    (contract_id IS NULL) <> (contract_template_id IS NULL)),
  CONSTRAINT ck_contract_clauses__sequence CHECK (sequence >= 1),
  CONSTRAINT ck_contract_clauses__ai_traceable CHECK (
    NOT is_ai_generated OR ai_message_id IS NOT NULL)
);

COMMENT ON COLUMN public.contract_clauses.ai_message_id IS
  'Any AI-drafted clause is traceable to its prompt (-> ai_messages).';

-- Non-unique on purpose: clause reordering swaps sequence values one
-- statement at a time; a unique index would forbid the intermediate state.
CREATE INDEX IF NOT EXISTS idx_contract_clauses__contract_sequence
  ON public.contract_clauses (contract_id, sequence) WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contract_clauses__template_sequence
  ON public.contract_clauses (contract_template_id, sequence) WHERE contract_template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contract_clauses__ai_message_id
  ON public.contract_clauses (ai_message_id);

DROP TRIGGER IF EXISTS trg_contract_clauses__stamp ON public.contract_clauses;
CREATE TRIGGER trg_contract_clauses__stamp
  BEFORE INSERT ON public.contract_clauses
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_contract_clauses__touch ON public.contract_clauses;
CREATE TRIGGER trg_contract_clauses__touch
  BEFORE UPDATE ON public.contract_clauses
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.contract_clauses ENABLE ROW LEVEL SECURITY;

-- Inherits: employee sees clauses of a contract they can see (their own,
-- signed). Template clauses are admin-only.
DROP POLICY IF EXISTS contract_clauses__via_parent__select ON public.contract_clauses;
CREATE POLICY contract_clauses__via_parent__select ON public.contract_clauses
  FOR SELECT TO authenticated
  USING (contract_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.contracts c WHERE c.id = contract_id));

DROP POLICY IF EXISTS contract_clauses__admin__all ON public.contract_clauses;
CREATE POLICY contract_clauses__admin__all ON public.contract_clauses
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.contract_clauses TO authenticated;
REVOKE DELETE ON public.contract_clauses FROM authenticated;

-- -----------------------------------------------------------------------------
-- 9. contract_events — append-only lifecycle trail
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contract_events (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  contract_id  uuid        NOT NULL,
  event        text        NOT NULL,
  payload      jsonb       NULL,
  ip           inet        NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  recorded_by  uuid        NULL,
  CONSTRAINT pk_contract_events PRIMARY KEY (id),
  CONSTRAINT fk_contract_events__contract_id
    FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE RESTRICT,
  CONSTRAINT ck_contract_events__event CHECK (event IN
    ('created','ai_drafted','clause_edited','internal_approved','sent','signed_by',
     'declined','cancelled','superseded','linked_to_employee'))
);

CREATE INDEX IF NOT EXISTS idx_contract_events__contract_time
  ON public.contract_events (contract_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_contract_events__recorded_at_brin
  ON public.contract_events USING brin (recorded_at);

DROP TRIGGER IF EXISTS trg_contract_events__immutable ON public.contract_events;
CREATE TRIGGER trg_contract_events__immutable
  BEFORE UPDATE OR DELETE ON public.contract_events
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.contract_events ENABLE ROW LEVEL SECURITY;

-- Inherits parent visibility (employee: own signed contract); admin all.
DROP POLICY IF EXISTS contract_events__via_parent__select ON public.contract_events;
CREATE POLICY contract_events__via_parent__select ON public.contract_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = contract_id));

DROP POLICY IF EXISTS contract_events__admin__insert ON public.contract_events;
CREATE POLICY contract_events__admin__insert ON public.contract_events
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

GRANT SELECT, INSERT ON public.contract_events TO authenticated;
REVOKE UPDATE, DELETE ON public.contract_events FROM authenticated;

-- -----------------------------------------------------------------------------
-- 10. v_contract_signers — contract-specific projection of the ONE signing
--     engine (doc §3.10: a view, not a second signer table).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_contract_signers
WITH (security_invoker = true) AS
SELECT
  c.id                 AS contract_id,
  c.contract_number,
  s.id                 AS signer_id,
  s.esign_request_id,
  s.signer_order,
  s.signer_kind,
  s.employee_id,
  s.full_name,
  s.email,
  s.mobile,
  s.designation_snapshot,
  s.identity_check_kind,
  s.identity_verified_at,
  s.status,
  s.notified_at,
  s.viewed_at,
  s.signed_at,
  s.signature_kind,
  s.declined_reason,
  s.timezone,
  s.pages_signed
FROM public.contracts c
JOIN public.e_sign_signers s ON s.esign_request_id = c.esign_request_id
WHERE c.esign_request_id IS NOT NULL;

COMMENT ON VIEW public.v_contract_signers IS
  'contract_signers per doc §3.10: a security-invoker view over e_sign_signers (candidate -> HR -> authorised signatory -> witness ordering via signer_order). RLS of the underlying tables applies.';

GRANT SELECT ON public.v_contract_signers TO authenticated;

COMMIT;
