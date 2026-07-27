-- =============================================================================
-- Migration 025 — documents vault
-- Source: docs/plan/04-data-model.md §3.9 (lines 2210–2305); spec-migrations §2
--         row 025. Tables: document_types, documents, document_versions,
--         document_access_log, document_acknowledgements. RLS + virus gate.
--
-- Enum public.document_status already exists (migration 003) — not recreated.
-- Forward FKs deferred to 20260801004900_deferred_fks.sql:
--   document_types.template_id            -> contract_templates (026)
--   documents.generated_from_template_id  -> contract_templates (026)
--   documents.esign_request_id            -> e_sign_requests    (026)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. document_types (lookup, §1.7 shape)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.document_types (
  id                              uuid        NOT NULL DEFAULT gen_random_uuid(),
  code                            text        NOT NULL,
  name                            text        NOT NULL,
  description                     text        NULL,
  sort_order                      integer     NOT NULL DEFAULT 100,
  is_active                       boolean     NOT NULL DEFAULT true,
  category                        text        NOT NULL,
  sub_category                    text        NULL,
  is_required_for_onboarding      boolean     NOT NULL DEFAULT false,
  required_for_employment_types   public.employment_type[] NULL,
  required_for_department_ids     uuid[]      NULL,
  requires_expiry                 boolean     NOT NULL DEFAULT false,
  expiry_reminder_days            integer[]   NOT NULL DEFAULT '{60,30,14,7,1}',
  requires_approval               boolean     NOT NULL DEFAULT false,
  requires_acknowledgement        boolean     NOT NULL DEFAULT false,
  acknowledgement_deadline_days   integer     NULL,
  requires_esign                  boolean     NOT NULL DEFAULT false,
  retention_years                 integer     NOT NULL DEFAULT 8,
  retention_basis                 text        NOT NULL DEFAULT 'from_exit',
  allowed_mime_types              text[]      NOT NULL DEFAULT '{application/pdf,image/jpeg,image/png}',
  max_file_size_mb                integer     NOT NULL DEFAULT 10,
  storage_bucket                  text        NOT NULL DEFAULT 'documents',
  is_sensitive                    boolean     NOT NULL DEFAULT false,
  visible_to_employee             boolean     NOT NULL DEFAULT true,
  visible_to_manager              boolean     NOT NULL DEFAULT false,
  template_id                     uuid        NULL,  -- FK deferred (contract_templates, 026)
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NULL,
  deleted_at                      timestamptz NULL,
  deleted_by                      uuid        NULL,
  deletion_reason                 text        NULL,
  CONSTRAINT pk_document_types PRIMARY KEY (id),
  CONSTRAINT fk_document_types__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_types__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_types__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_document_types__category CHECK (category IN
    ('identity','employment','education','statutory','payroll','policy',
     'compliance','medical','exit','other')),
  CONSTRAINT ck_document_types__retention_basis CHECK (retention_basis IN
    ('from_upload','from_exit','from_expiry','indefinite')),
  CONSTRAINT ck_document_types__retention_years CHECK (retention_years >= 0),
  CONSTRAINT ck_document_types__max_file_size CHECK (max_file_size_mb > 0),
  CONSTRAINT ck_document_types__ack_deadline
    CHECK (acknowledgement_deadline_days IS NULL OR acknowledgement_deadline_days > 0),
  CONSTRAINT ck_document_types__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE public.document_types IS
  'Document type master. Codes: AADHAAR, PAN, PASSPORT, OFFER_LETTER, APPOINTMENT_LETTER, CONTRACT, RESUME, EDU_CERT, EXP_LETTER, RELIEVING_LETTER, PAYSLIP, FORM16, POLICY, SOP, MEDICAL_CERT, FSSAI_CERT, FIRE_SAFETY_CERT, POLICE_VERIFICATION, BANK_PROOF, CANCELLED_CHEQUE, PHOTO, SIGNATURE, NDA, INCREMENT_LETTER, WARNING_LETTER, EXIT_CLEARANCE.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_types__code
  ON public.document_types (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_types__category
  ON public.document_types (category, sort_order);
CREATE INDEX IF NOT EXISTS idx_document_types__template_id
  ON public.document_types (template_id);

DROP TRIGGER IF EXISTS trg_document_types__stamp ON public.document_types;
CREATE TRIGGER trg_document_types__stamp
  BEFORE INSERT ON public.document_types
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_document_types__touch ON public.document_types;
CREATE TRIGGER trg_document_types__touch
  BEFORE UPDATE ON public.document_types
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.document_types ENABLE ROW LEVEL SECURITY;

-- P7: reference data readable by everyone while active.
DROP POLICY IF EXISTS document_types__authenticated__select ON public.document_types;
CREATE POLICY document_types__authenticated__select ON public.document_types
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS document_types__admin__select ON public.document_types;
CREATE POLICY document_types__admin__select ON public.document_types
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- P8: admin write.
DROP POLICY IF EXISTS document_types__admin__insert ON public.document_types;
CREATE POLICY document_types__admin__insert ON public.document_types
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS document_types__admin__update ON public.document_types;
CREATE POLICY document_types__admin__update ON public.document_types
  FOR UPDATE TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.document_types TO authenticated;
REVOKE DELETE ON public.document_types FROM authenticated;

-- -----------------------------------------------------------------------------
-- 2. documents
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.documents (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  document_type_id            uuid        NOT NULL,
  company_id                  uuid        NOT NULL,
  subject_kind                text        NOT NULL DEFAULT 'employee',
  employee_id                 uuid        NULL,
  title                       text        NOT NULL,
  file_name                   text        NOT NULL,
  storage_bucket              text        NOT NULL,
  storage_path                text        NOT NULL,
  mime_type                   text        NOT NULL,
  file_size_bytes             bigint      NOT NULL,
  checksum_sha256             text        NOT NULL,
  page_count                  integer     NULL,
  current_version             integer     NOT NULL DEFAULT 1,
  status                      public.document_status NOT NULL DEFAULT 'approved',
  issue_date                  date        NULL,
  expiry_date                 date        NULL,
  uploaded_by                 uuid        NOT NULL,
  uploaded_at                 timestamptz NOT NULL DEFAULT now(),
  reviewed_by                 uuid        NULL,
  reviewed_at                 timestamptz NULL,
  review_comment              text        NULL,
  is_system_generated         boolean     NOT NULL DEFAULT false,
  generated_from_template_id  uuid        NULL,  -- FK deferred (contract_templates, 026)
  source_reference            jsonb       NULL,
  requires_acknowledgement    boolean     NOT NULL DEFAULT false,
  acknowledgement_due_on      date        NULL,
  esign_request_id            uuid        NULL,  -- FK deferred (e_sign_requests, 026)
  tags                        text[]      NOT NULL DEFAULT '{}',
  is_confidential             boolean     NOT NULL DEFAULT false,
  virus_scan_status           text        NOT NULL DEFAULT 'pending',
  retention_until             date        NULL,
  archived_at                 timestamptz NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  deleted_at                  timestamptz NULL,
  deleted_by                  uuid        NULL,
  deletion_reason             text        NULL,
  CONSTRAINT pk_documents PRIMARY KEY (id),
  CONSTRAINT fk_documents__document_type_id
    FOREIGN KEY (document_type_id) REFERENCES public.document_types(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents__uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents__reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_documents__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_documents__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_documents__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_documents__subject_kind CHECK (subject_kind IN
    ('employee','company','policy','asset','payroll_run','event','vendor')),
  CONSTRAINT ck_documents__employee_when_subject
    CHECK (subject_kind <> 'employee' OR employee_id IS NOT NULL),
  CONSTRAINT ck_documents__virus_scan_status CHECK (virus_scan_status IN
    ('pending','clean','infected','skipped')),
  CONSTRAINT ck_documents__checksum
    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_documents__file_size CHECK (file_size_bytes > 0),
  CONSTRAINT ck_documents__page_count CHECK (page_count IS NULL OR page_count > 0),
  CONSTRAINT ck_documents__current_version CHECK (current_version >= 1),
  -- §1.6: sentinel dates banned; open-ended = NULL.
  CONSTRAINT ck_documents__no_sentinel_dates CHECK (
    (issue_date              IS NULL OR issue_date              < DATE '2100-01-01') AND
    (expiry_date             IS NULL OR expiry_date             < DATE '2100-01-01') AND
    (acknowledgement_due_on  IS NULL OR acknowledgement_due_on  < DATE '2100-01-01') AND
    (retention_until         IS NULL OR retention_until         < DATE '2100-01-01')),
  CONSTRAINT ck_documents__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE public.documents IS
  'Document vault metadata. Files live in private storage buckets; access is only via short-lived signed URLs minted by the document-access edge function, which writes document_access_log first.';
COMMENT ON COLUMN public.documents.title IS 'Display title. Never the raw filename.';
COMMENT ON COLUMN public.documents.checksum_sha256 IS
  'Detects silent corruption and proves the file served equals the file signed.';
COMMENT ON COLUMN public.documents.virus_scan_status IS
  'pending | clean | infected | skipped. An infected file is quarantined and never served.';

CREATE INDEX IF NOT EXISTS idx_documents__employee_type
  ON public.documents (employee_id, document_type_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents__expiry
  ON public.documents (expiry_date) WHERE expiry_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents__status
  ON public.documents (status);
CREATE INDEX IF NOT EXISTS idx_documents__tags
  ON public.documents USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_documents__title_trgm
  ON public.documents USING gin (title extensions.gin_trgm_ops);
-- FK hygiene (§12.2): every FK column indexed.
CREATE INDEX IF NOT EXISTS idx_documents__document_type_id ON public.documents (document_type_id);
CREATE INDEX IF NOT EXISTS idx_documents__company_id       ON public.documents (company_id);
CREATE INDEX IF NOT EXISTS idx_documents__uploaded_by      ON public.documents (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_documents__esign_request_id ON public.documents (esign_request_id);
CREATE INDEX IF NOT EXISTS idx_documents__generated_from_template_id
  ON public.documents (generated_from_template_id);

DROP TRIGGER IF EXISTS trg_documents__stamp ON public.documents;
CREATE TRIGGER trg_documents__stamp
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_documents__touch ON public.documents;
CREATE TRIGGER trg_documents__touch
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Virus gate (§10, spec row 025): an infected file is quarantined — it can
-- never sit in a servable status. The scanner edge function marks a hit as
-- virus_scan_status='infected' + status='rejected' in the same write.
CREATE OR REPLACE FUNCTION public.documents_virus_gate()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.virus_scan_status = 'infected'
     AND NEW.status NOT IN ('rejected', 'archived') THEN
    RAISE EXCEPTION 'document % failed the virus scan and is quarantined: status must be rejected or archived, not %',
      NEW.id, NEW.status
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents__virus_gate ON public.documents;
CREATE TRIGGER trg_documents__virus_gate
  BEFORE INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_virus_gate();

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- P6-composite (§4.7): employee sees own documents where the TYPE says
-- visible_to_employee; manager sees reportees' where visible_to_manager;
-- admin sees all in scope (including soft-deleted, for the recycle bin).
-- Infected files are invisible to non-admins.
DROP POLICY IF EXISTS documents__self__select ON public.documents;
CREATE POLICY documents__self__select ON public.documents
  FOR SELECT TO authenticated
  USING (
    employee_id = app.current_employee_id()
    AND deleted_at IS NULL
    AND virus_scan_status <> 'infected'
    AND EXISTS (
      SELECT 1 FROM public.document_types dt
      WHERE dt.id = document_type_id AND dt.visible_to_employee));

DROP POLICY IF EXISTS documents__manager__select ON public.documents;
CREATE POLICY documents__manager__select ON public.documents
  FOR SELECT TO authenticated
  USING (
    employee_id IS NOT NULL
    AND app.is_manager_of(employee_id)
    AND deleted_at IS NULL
    AND virus_scan_status <> 'infected'
    AND EXISTS (
      SELECT 1 FROM public.document_types dt
      WHERE dt.id = document_type_id AND dt.visible_to_manager));

DROP POLICY IF EXISTS documents__admin__all ON public.documents;
CREATE POLICY documents__admin__all ON public.documents
  FOR ALL TO authenticated
  USING (app.is_admin() AND (employee_id IS NULL OR app.admin_scope_covers(employee_id)))
  WITH CHECK (app.is_admin() AND (employee_id IS NULL OR app.admin_scope_covers(employee_id)));

GRANT SELECT, INSERT, UPDATE ON public.documents TO authenticated;
REVOKE DELETE ON public.documents FROM authenticated;

-- -----------------------------------------------------------------------------
-- 3. document_versions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.document_versions (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  document_id      uuid        NOT NULL,
  version          integer     NOT NULL,
  storage_path     text        NOT NULL,
  file_name        text        NOT NULL,
  file_size_bytes  bigint      NOT NULL,
  checksum_sha256  text        NOT NULL,
  mime_type        text        NOT NULL,
  page_count       integer     NULL,
  replaced_reason  text        NULL,
  uploaded_by      uuid        NULL,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  is_current       boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NULL,
  CONSTRAINT pk_document_versions PRIMARY KEY (id),
  CONSTRAINT fk_document_versions__document_id
    FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_document_versions__uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_versions__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_versions__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_document_versions__version CHECK (version >= 1),
  CONSTRAINT ck_document_versions__checksum CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_document_versions__file_size CHECK (file_size_bytes > 0)
);

COMMENT ON TABLE public.document_versions IS
  'Replacing a document never overwrites storage — a new version object is written and the old one retained until the retention date.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_dv__document_version
  ON public.document_versions (document_id, version);
CREATE INDEX IF NOT EXISTS idx_document_versions__uploaded_by
  ON public.document_versions (uploaded_by);

DROP TRIGGER IF EXISTS trg_document_versions__stamp ON public.document_versions;
CREATE TRIGGER trg_document_versions__stamp
  BEFORE INSERT ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_document_versions__touch ON public.document_versions;
CREATE TRIGGER trg_document_versions__touch
  BEFORE UPDATE ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;

-- Inherits parent visibility: a version row is visible iff the parent
-- document row is visible to the querying user (documents RLS applies
-- inside the subquery).
DROP POLICY IF EXISTS document_versions__via_parent__select ON public.document_versions;
CREATE POLICY document_versions__via_parent__select ON public.document_versions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id));

DROP POLICY IF EXISTS document_versions__admin__insert ON public.document_versions;
CREATE POLICY document_versions__admin__insert ON public.document_versions
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

GRANT SELECT, INSERT ON public.document_versions TO authenticated;
REVOKE UPDATE, DELETE ON public.document_versions FROM authenticated;

-- -----------------------------------------------------------------------------
-- 4. document_access_log — append-only
-- -----------------------------------------------------------------------------
-- Every view, download, print and signed-URL mint. Written by the
-- document-access edge function (service role). Like public.data_access_log
-- (006), actor/subject columns carry no FK so a log row can never be mutated
-- or block a lawful hard delete; immutability is trigger-enforced.

CREATE TABLE IF NOT EXISTS public.document_access_log (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  document_id            uuid        NOT NULL,
  accessed_by            uuid        NOT NULL,
  accessed_by_role       public.app_role NULL,
  on_behalf_of           uuid        NULL,
  access_kind            text        NOT NULL,
  purpose                text        NULL,
  ip                     inet        NULL,
  user_agent             text        NULL,
  device_id              text        NULL,
  signed_url_expires_at  timestamptz NULL,
  bytes_served           bigint      NULL,
  request_id             uuid        NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_document_access_log PRIMARY KEY (id),
  CONSTRAINT ck_dal__access_kind CHECK (access_kind IN
    ('view','download','print','signed_url_minted','email_attachment','api')),
  CONSTRAINT ck_dal__bytes_served CHECK (bytes_served IS NULL OR bytes_served >= 0)
);

COMMENT ON TABLE public.document_access_log IS
  'Append-only. purpose is mandatory for is_sensitive document types — enforced by the document-access edge function, which is the only writer.';

CREATE INDEX IF NOT EXISTS idx_dal__document_time
  ON public.document_access_log (document_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_dal__actor_time
  ON public.document_access_log (accessed_by, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_dal__recorded_at_brin
  ON public.document_access_log USING brin (recorded_at);

DROP TRIGGER IF EXISTS trg_document_access_log__immutable ON public.document_access_log;
CREATE TRIGGER trg_document_access_log__immutable
  BEFORE UPDATE OR DELETE ON public.document_access_log
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.document_access_log ENABLE ROW LEVEL SECURITY;

-- Self read of one's own accesses; P8 admins audit access. No update/delete.
DROP POLICY IF EXISTS document_access_log__self__select ON public.document_access_log;
CREATE POLICY document_access_log__self__select ON public.document_access_log
  FOR SELECT TO authenticated
  USING (accessed_by = app.ctx_actor_id());

DROP POLICY IF EXISTS document_access_log__admin__select ON public.document_access_log;
CREATE POLICY document_access_log__admin__select ON public.document_access_log
  FOR SELECT TO authenticated
  USING (app.is_admin());

GRANT SELECT ON public.document_access_log TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.document_access_log FROM authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.document_access_log TO service_role;
    REVOKE UPDATE, DELETE ON public.document_access_log FROM service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. document_acknowledgements
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.document_acknowledgements (
  id                         uuid        NOT NULL DEFAULT gen_random_uuid(),
  document_id                uuid        NOT NULL,
  employee_id                uuid        NOT NULL,
  assigned_at                timestamptz NOT NULL DEFAULT now(),
  due_on                     date        NULL,
  first_opened_at            timestamptz NULL,
  open_count                 integer     NOT NULL DEFAULT 0,
  total_read_seconds         integer     NOT NULL DEFAULT 0,
  scroll_completion_pct      numeric(6,3) NOT NULL DEFAULT 0,
  acknowledged_at            timestamptz NULL,
  acknowledgement_text       text        NULL,
  acknowledgement_text_hash  text        NULL,
  signature_image_path       text        NULL,
  ip                         inet        NULL,
  user_agent                 text        NULL,
  device_id                  text        NULL,
  status                     text        NOT NULL DEFAULT 'assigned',
  waived_by                  uuid        NULL,
  waived_at                  timestamptz NULL,
  waived_reason              text        NULL,
  reminder_count             integer     NOT NULL DEFAULT 0,
  last_reminder_at           timestamptz NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        NULL,
  CONSTRAINT pk_document_acknowledgements PRIMARY KEY (id),
  CONSTRAINT fk_document_acknowledgements__document_id
    FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE RESTRICT,
  CONSTRAINT fk_document_acknowledgements__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_document_acknowledgements__waived_by
    FOREIGN KEY (waived_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_acknowledgements__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_acknowledgements__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_da__status CHECK (status IN
    ('assigned','opened','acknowledged','overdue','waived')),
  CONSTRAINT ck_da__scroll_pct CHECK (scroll_completion_pct BETWEEN 0 AND 100),
  CONSTRAINT ck_da__counters CHECK (
    open_count >= 0 AND total_read_seconds >= 0 AND reminder_count >= 0),
  CONSTRAINT ck_da__no_sentinel_dates CHECK (due_on IS NULL OR due_on < DATE '2100-01-01'),
  CONSTRAINT ck_da__waive_reason CHECK (
    status <> 'waived' OR (waived_by IS NOT NULL AND length(btrim(waived_reason)) >= 10)),
  CONSTRAINT ck_da__acknowledged_fields CHECK (
    status <> 'acknowledged' OR (acknowledged_at IS NOT NULL AND acknowledgement_text IS NOT NULL))
);

COMMENT ON COLUMN public.document_acknowledgements.acknowledgement_text IS
  'The exact sentence agreed to.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_da__document_employee
  ON public.document_acknowledgements (document_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_da__status_due
  ON public.document_acknowledgements (status, due_on);
CREATE INDEX IF NOT EXISTS idx_da__employee_id
  ON public.document_acknowledgements (employee_id);

DROP TRIGGER IF EXISTS trg_document_acknowledgements__stamp ON public.document_acknowledgements;
CREATE TRIGGER trg_document_acknowledgements__stamp
  BEFORE INSERT ON public.document_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_document_acknowledgements__touch ON public.document_acknowledgements;
CREATE TRIGGER trg_document_acknowledgements__touch
  BEFORE UPDATE ON public.document_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Informed-consent gate (§3.9 note): acknowledgement unlocks only at >=90%
-- scroll AND dwell time >= ceil(page_count * 8) seconds — "I read the 40-page
-- handbook in 4 seconds" cannot be recorded as informed consent.
CREATE OR REPLACE FUNCTION public.document_acknowledgements_ack_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_page_count integer;
BEGIN
  IF NEW.status = 'acknowledged'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT d.page_count INTO v_page_count
    FROM public.documents d WHERE d.id = NEW.document_id;

    IF coalesce(NEW.scroll_completion_pct, 0) < 90 THEN
      RAISE EXCEPTION 'acknowledgement requires >= 90%% scroll completion (got %)',
        NEW.scroll_completion_pct USING errcode = 'check_violation';
    END IF;
    IF coalesce(NEW.total_read_seconds, 0) < ceil(coalesce(v_page_count, 1) * 8) THEN
      RAISE EXCEPTION 'acknowledgement requires a dwell time of at least % seconds (got %)',
        ceil(coalesce(v_page_count, 1) * 8), NEW.total_read_seconds
        USING errcode = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_acknowledgements__ack_guard ON public.document_acknowledgements;
CREATE TRIGGER trg_document_acknowledgements__ack_guard
  BEFORE INSERT OR UPDATE ON public.document_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.document_acknowledgements_ack_guard();

ALTER TABLE public.document_acknowledgements ENABLE ROW LEVEL SECURITY;

-- P1 self read (the acknowledge action itself goes through a SECURITY DEFINER
-- RPC per §4.4); P5 manager read for team compliance; P8 admin all.
DROP POLICY IF EXISTS document_acknowledgements__self__select ON public.document_acknowledgements;
CREATE POLICY document_acknowledgements__self__select ON public.document_acknowledgements
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS document_acknowledgements__manager__select ON public.document_acknowledgements;
CREATE POLICY document_acknowledgements__manager__select ON public.document_acknowledgements
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS document_acknowledgements__admin__all ON public.document_acknowledgements;
CREATE POLICY document_acknowledgements__admin__all ON public.document_acknowledgements
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

GRANT SELECT, INSERT, UPDATE ON public.document_acknowledgements TO authenticated;
REVOKE DELETE ON public.document_acknowledgements FROM authenticated;

COMMIT;
