-- =============================================================================
-- Migration 064 — the two WRITE paths employee self-service was missing.
--
-- WHY THIS EXISTS
-- ---------------
-- Two screens were built read-only because the database had no way for an
-- employee to write the row, and shipping a button that returns 42501 is worse
-- than shipping no button. Both gaps were confirmed against the migrations, not
-- assumed:
--
--   1. /me/profile/custom — `employee_custom_field_defs` carries
--      `is_employee_editable` and `requires_approval` per field, and migration
--      010 says in a comment that employee edits "go through change requests
--      (011) — no self write policy here". That is right for
--      `requires_approval = true`, and wrong for `requires_approval = false`:
--      a field HR explicitly marked "the employee owns this, no approval
--      needed" (uniform size, shoe size, transport route, meal preference,
--      two-wheeler licence) had NO path to a value at all except an HR
--      keystroke. `authenticated` already holds `GRANT INSERT, UPDATE ON
--      public.employee_custom_field_values` (010 §3); only the policy was
--      absent, so this file adds exactly the policy and nothing else.
--
--      The `requires_approval = true` half needs nothing from this file: it
--      travels as an `employee_change_requests` row (011 §2 `ecr__self_insert`
--      + `ecr_insert_guard`, which demands `field_name = 'custom:<CODE>'` and
--      raises 22023 for any other convention) and is decided by
--      `public.decide_change_request` (migration 20260801012000), which stamps
--      the decision and calls `apply_change_request` in one transaction.
--
--   2. /me/profile/documents — migration 039 DOES create the private
--      `documents` bucket and DOES let an employee write into their own folder
--      (`documents__own_write`, `(storage.foldername(name))[2] =
--      app.current_employee_id()::text`). What was missing is the metadata
--      half: `public.documents` has `documents__self__select`,
--      `documents__manager__select` and `documents__admin__all` — no
--      self INSERT — so an employee could push bytes into storage that no row
--      in the vault ever pointed at. An orphan object is not a feature.
--      (Migration 20260801013000 settles which bucket that is: `documents`.)
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
--  * No self UPDATE or DELETE on `public.documents`. Once submitted, a
--    document is HR's to verify (`/admin/documents/pending` reads
--    `status = 'pending_review'`); an employee re-writing their own row after
--    review would defeat the queue. `documents` is also in
--    audit.reason_required_tables for UPDATE/DELETE.
--  * No self DELETE on `employee_custom_field_values`: migration 048 does
--    `REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM
--    authenticated` and this file does not re-grant it. A value can be
--    corrected, never silently vacated — `ck_ecfv__one_value` requires exactly
--    one populated column, so "empty" is not a state the row can hold anyway.
--  * No storage SELECT policy on the `documents` bucket. 039 routes every read
--    through a short-lived signed URL minted by the document-access edge
--    function, which writes `document_access_log` FIRST. Granting a direct
--    read here would put an employee's own downloads outside that log for the
--    sake of a convenience the screen does not need — the screen shows the
--    metadata and tells the employee HR can open the file.
--
-- SCHEMA FACTS THIS FILE WAS WRITTEN AGAINST (each verified in the migrations)
-- ---------------------------------------------------------------------------
--  * employee_custom_field_defs: is_employee_editable, requires_approval,
--    is_active, deleted_at, field_type public.custom_field_type. (010)
--  * employee_custom_field_values: uq_ecfv__employee_field on
--    (employee_id, field_def_id); trg_ecfv__validate already enforces the
--    typed-column match, the number min/max, the text regex and the
--    single_select option list, so this policy does not re-check any of them.
--  * documents: status public.document_status ∈ draft|pending_review|approved|
--    rejected|expired|superseded|archived; ck_documents__subject_kind ∈
--    employee|company|policy|asset|payroll_run|event|vendor;
--    ck_documents__employee_when_subject; virus_scan_status ∈
--    pending|clean|infected|skipped; uploaded_by → public.profiles(id) NOT
--    auth.users; checksum_sha256 ~ '^[0-9a-f]{64}$'; file_size_bytes > 0. (025)
--  * document_types: visible_to_employee, requires_esign,
--    requires_acknowledgement, requires_expiry, is_active, deleted_at. (025)
--  * audit.reason_required_tables holds 'public.documents' with the default
--    applies_to = 'update_delete', so an INSERT needs no app.reason. (006/038)
--  * employee_custom_field_values and employee_change_requests are NOT in
--    audit.reason_required_tables at all.
--
-- Idempotent: every statement is CREATE OR REPLACE / DROP POLICY IF EXISTS +
-- CREATE POLICY, so re-running is inert. No DDL on any table.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. app.current_employee_company_id() — the caller's legal entity
-- -----------------------------------------------------------------------------
-- `documents.company_id` is NOT NULL and FK-RESTRICTed to companies. The client
-- sends it, so the policy has to pin it to the caller's own entity or a
-- self-upload could be filed against another company. SECURITY DEFINER for the
-- same reason app.current_employee_id() is: a policy expression must not
-- depend on the caller's own RLS view of `employees`.
CREATE OR REPLACE FUNCTION app.current_employee_company_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.company_id
  FROM public.employees e
  WHERE e.profile_id = app.ctx_actor_id()
    AND e.deleted_at IS NULL
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.current_employee_company_id() IS
  'The company_id of the signed-in user''s employee row, for WITH CHECK clauses that must pin a client-supplied company_id.';

REVOKE ALL ON FUNCTION app.current_employee_company_id() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.current_employee_company_id() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION app.current_employee_company_id() TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. app.custom_field_is_self_writable(uuid) — the one predicate, once
-- -----------------------------------------------------------------------------
-- Used by the INSERT WITH CHECK and by both halves of the UPDATE policy, so
-- the three can never drift apart. Definer so that the def lookup does not
-- depend on the ecfd read policy (which is permissive here, but a policy
-- should not be load-bearing on another policy).
CREATE OR REPLACE FUNCTION app.custom_field_is_self_writable(p_field_def_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.employee_custom_field_defs d
    WHERE d.id = p_field_def_id
      AND d.is_active
      AND d.deleted_at IS NULL
      AND d.is_employee_editable
      AND NOT d.requires_approval
  );
$$;

COMMENT ON FUNCTION app.custom_field_is_self_writable(uuid) IS
  'True when a custom-field definition is one the employee owns outright: is_employee_editable AND NOT requires_approval. requires_approval fields travel as employee_change_requests instead (migration 011).';

REVOKE ALL ON FUNCTION app.custom_field_is_self_writable(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.custom_field_is_self_writable(uuid) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION app.custom_field_is_self_writable(uuid) TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. employee_custom_field_values — self write, narrowly
-- -----------------------------------------------------------------------------
-- Nothing about the VALUE is checked here on purpose: trg_ecfv__validate
-- (010) already refuses a value in the wrong typed column, a number outside
-- min/max, text failing validation_regex and a single_select value that is not
-- one of `options`' `o->>'value'`. Duplicating any of that in a policy would
-- create two rulebooks to keep in step.

DROP POLICY IF EXISTS ecfv__self_insert ON public.employee_custom_field_values;
CREATE POLICY ecfv__self_insert ON public.employee_custom_field_values
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = app.current_employee_id()
    AND app.custom_field_is_self_writable(field_def_id)
  );

DROP POLICY IF EXISTS ecfv__self_update ON public.employee_custom_field_values;
CREATE POLICY ecfv__self_update ON public.employee_custom_field_values
  FOR UPDATE TO authenticated
  USING (
    employee_id = app.current_employee_id()
    AND app.custom_field_is_self_writable(field_def_id)
  )
  WITH CHECK (
    employee_id = app.current_employee_id()
    AND app.custom_field_is_self_writable(field_def_id)
  );

COMMENT ON POLICY ecfv__self_insert ON public.employee_custom_field_values IS
  'An employee may set their own value for a field HR marked is_employee_editable with requires_approval = false. Everything else stays admin-only or travels as an employee_change_requests row.';

-- -----------------------------------------------------------------------------
-- 4. documents — self INSERT of an employee-supplied file, awaiting review
-- -----------------------------------------------------------------------------
-- Every column that decides authority, trust or routing is pinned to a literal
-- so the row an employee can create is exactly one shape: MY document, on MY
-- record, in MY entity, uploaded by ME, unscanned, unreviewed, and parked in
-- the queue HR already has a screen for. Nothing here can mint an approved
-- contract, an acknowledgement obligation or an e-sign instrument.
--
-- The type gate is `visible_to_employee AND NOT requires_esign AND NOT
-- requires_acknowledgement`: a type the employee cannot even see their own copy
-- of is not one they may file (POLICE_VERIFICATION), an e-signed instrument is
-- issued rather than uploaded (OFFER_LETTER, APPOINTMENT_LETTER, CONTRACT,
-- NDA), and a policy/SOP is published TO an employee, never BY one.
-- `requires_expiry` types must carry the expiry date, because a licence with no
-- valid-to is invisible to every expiry report in the build.

DROP POLICY IF EXISTS documents__self__insert ON public.documents;
CREATE POLICY documents__self__insert ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (
    subject_kind = 'employee'
    AND employee_id = app.current_employee_id()
    AND company_id  = app.current_employee_company_id()
    AND uploaded_by = app.ctx_actor_id()
    AND status = 'pending_review'
    AND virus_scan_status = 'pending'
    AND current_version = 1
    AND is_system_generated = false
    AND is_confidential = false
    AND requires_acknowledgement = false
    AND acknowledgement_due_on IS NULL
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND esign_request_id IS NULL
    AND generated_from_template_id IS NULL
    AND archived_at IS NULL
    AND retention_until IS NULL
    AND deleted_at IS NULL
    AND storage_bucket = 'documents'
    AND EXISTS (
      SELECT 1
      FROM public.document_types dt
      WHERE dt.id = document_type_id
        AND dt.is_active
        AND dt.deleted_at IS NULL
        AND dt.visible_to_employee
        AND NOT dt.requires_esign
        AND NOT dt.requires_acknowledgement
        AND (NOT dt.requires_expiry OR documents.expiry_date IS NOT NULL)
    )
  );

COMMENT ON POLICY documents__self__insert ON public.documents IS
  'Employee-supplied file, parked in pending_review for /admin/documents/pending. Status, reviewer, scan state, confidentiality, versioning and entity are all pinned to literals; the type must be employee-visible and neither e-signed nor acknowledgement-bearing.';

-- `authenticated` already holds SELECT, INSERT, UPDATE on public.documents
-- (025) and 048 leaves that intact, so no grant changes are needed. Stated
-- rather than re-granted, because a redundant GRANT here would hide the fact
-- that DELETE is revoked and must stay revoked.

COMMIT;
