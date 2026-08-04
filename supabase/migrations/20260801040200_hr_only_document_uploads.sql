-- =============================================================================
-- 097 · Aadhaar, PAN and bank proof are HR's to upload, not the employee's
--
-- REPORTED: "adhar, pan, bank-account/cancel-cheque/bank passbook should be
--            mandatory and it should be upload by HR/admin only".
--
-- The mandatory half already held: AADHAAR, PAN and BANK_PROOF were seeded
-- `is_required_for_onboarding = true`. BANK_PROOF is the umbrella a cancelled
-- cheque or a passbook page satisfies, so it stays the single bank requirement —
-- making CANCELLED_CHEQUE required too would demand two bank documents for one
-- fact.
--
-- THE PROBLEM THIS FIXES
-- ----------------------
-- Nothing in the schema said "only HR may upload this". The only flag standing
-- between an employee and an upload was `visible_to_employee`, which
-- `documents__self__insert` (migration 067) checks — and that flag's real job is
-- VISIBILITY: whether somebody can see their own document of that type.
--
-- Using it to block uploads therefore also blinds the employee to their own
-- Aadhaar, PAN and bank proof. That is the state this migration inherits (the
-- flags were flipped live to satisfy the instruction immediately) and the state
-- it corrects: two different questions deserve two different columns.
--
-- WHY THE ONBOARDING PACK MUST CHANGE TOO — the part that would otherwise be a
-- lockout. `submit_onboarding()` refuses while any row of
-- `v_my_onboarding_pack` is `is_required AND NOT is_done`, and that view's
-- document half admits every required type. Make these three required AND
-- un-uploadable without touching the view and every joiner is permanently unable
-- to finish onboarding — the same shape of trap as the first-run loop, arriving
-- through a different door.
--
-- So the view gains the same predicate: an item the employee cannot act on is not
-- on the employee's list. It is still on HR's — `v_onboarding_admin`'s
-- `outstanding_documents` counts `is_required_for_onboarding` alone and never
-- consulted the employee-facing flags, so HR's queue is unaffected. That is
-- exactly the division wanted: HR is accountable for these, the joiner is not
-- blocked by them.
--
-- The custom-field half of the same view already draws this distinction with
-- `is_employee_editable`. This migration extends the existing idea to documents
-- rather than inventing a second one.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 097: statutory and bank documents become HR-upload-only, via a dedicated flag instead of the visibility one', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The flag
-- -----------------------------------------------------------------------------
/*
  DEFAULT true: every existing type stays uploadable by its owner, which is what
  they were before this migration. Only the four named below opt out, so adding a
  column can never silently take a capability away from a type nobody reviewed.
*/
ALTER TABLE public.document_types
  ADD COLUMN IF NOT EXISTS employee_uploadable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.document_types.employee_uploadable IS
  'May the employee upload this type for themselves? Distinct from visible_to_employee, which is about SEEING a document — a statutory identifier can be HR-supplied and still visible to the person it belongs to. Checked by documents__self__insert and by the document half of v_my_onboarding_pack.';

-- -----------------------------------------------------------------------------
-- 2. The four that HR owns
-- -----------------------------------------------------------------------------
/*
  Visibility is RESTORED at the same time. An employee should be able to see the
  Aadhaar HR holds for them; they simply may not be the one to supply it. The live
  flag-flip that preceded this migration could not separate the two.
*/
UPDATE public.document_types
   SET employee_uploadable = false,
       visible_to_employee = true
 WHERE code IN ('AADHAAR', 'PAN', 'BANK_PROOF', 'CANCELLED_CHEQUE');

-- The three that must exist before onboarding can close. CANCELLED_CHEQUE is
-- deliberately absent: it is one way to satisfy BANK_PROOF, not a second demand.
UPDATE public.document_types
   SET is_required_for_onboarding = true
 WHERE code IN ('AADHAAR', 'PAN', 'BANK_PROOF');

-- -----------------------------------------------------------------------------
-- 3. The insert policy honours it
-- -----------------------------------------------------------------------------
/*
  Body identical to migration 067 apart from the one added conjunct. Repeated in
  full because CREATE POLICY has no ALTER that can append to WITH CHECK, and a
  policy that silently lost a clause here would be a hole in a self-service write
  path.
*/
DROP POLICY IF EXISTS documents__self__insert ON public.documents;
CREATE POLICY documents__self__insert ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (
    subject_kind = 'employee'
    AND employee_id = app.current_employee_id()
    AND company_id  = app.current_employee_company_id()
    AND uploaded_by = app.ctx_actor_id()
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
    AND (string_to_array(storage_path, '/'))[1] = 'employee'
    AND (string_to_array(storage_path, '/'))[2] = app.current_employee_id()::text
    AND array_length(string_to_array(storage_path, '/'), 1) >= 3
    AND EXISTS (
      SELECT 1
      FROM public.document_types dt
      WHERE dt.id = document_type_id
        AND dt.is_active
        AND dt.deleted_at IS NULL
        AND dt.visible_to_employee
        AND dt.employee_uploadable          -- the one clause this migration adds
        AND NOT dt.requires_esign
        AND NOT dt.requires_acknowledgement
        AND (NOT dt.requires_expiry OR documents.expiry_date IS NOT NULL)
        -- Kept from migration 20260801038100: the status the TYPE demands, and only
        -- that one. Rebased rather than copied from the older 021000 body, which
        -- hardcoded 'pending_review' — replacing it would have quietly undone the
        -- rule that an employee cannot park a photograph in a review queue.
        AND documents.status = (
          CASE WHEN dt.requires_approval THEN 'pending_review' ELSE 'approved' END
        )::public.document_status
    )
  );

COMMENT ON POLICY documents__self__insert ON public.documents IS
  'An employee may file their own document, pending review, into their own storage folder — and only of a type marked employee_uploadable. Statutory identifiers and bank proof are HR-supplied: the employee can see them but cannot be the source.';

-- -----------------------------------------------------------------------------
-- 4. The joiner's pack stops asking for what only HR can supply
-- -----------------------------------------------------------------------------
/*
  THE LOCKOUT THIS AVOIDS, spelled out because it is not obvious from the diff:
  `submit_onboarding()` raises `onboarding_incomplete` while ANY pack row is
  `is_required AND NOT is_done`. Aadhaar, PAN and bank proof are all required. If
  they stayed on the employee's pack while being un-uploadable by the employee,
  every joiner would be permanently unable to submit — no error a person could act
  on, just a form that refuses forever.

  Body identical to migration 092's §3 apart from the one added conjunct, for the
  same reason the policy above is repeated in full: a view is replaced wholesale,
  and a clause lost here changes what the database considers a complete joiner.

  HR still tracks all three. `v_onboarding_admin.outstanding_documents` counts
  `is_required_for_onboarding` and has never looked at the employee-facing flags,
  so the admin queue keeps showing them as owed — which is the point.
*/
CREATE OR REPLACE VIEW public.v_my_onboarding_pack
WITH (security_barrier = true) AS
WITH me AS (
  SELECT e.id, e.employment_type, e.department_id
    FROM public.employees e
   WHERE e.id = app.current_employee_id()
     AND e.deleted_at IS NULL
)
SELECT
  'field'::text                        AS kind,
  d.code,
  d.label,
  d.help_text,
  d.field_type::text                   AS field_type,
  d.options,
  d.is_required,
  d.section,
  d.sort_order,
  (v.id IS NOT NULL)                   AS is_done,
  NULL::uuid                           AS document_id
FROM me
JOIN public.employee_custom_field_defs d
  ON d.is_active
 AND d.deleted_at IS NULL
 AND d.show_in_onboarding
 AND d.is_employee_editable
 AND (d.applies_to_employment_types IS NULL
      OR me.employment_type = ANY (d.applies_to_employment_types))
 AND (d.applies_to_department_ids IS NULL
      OR me.department_id = ANY (d.applies_to_department_ids))
LEFT JOIN public.employee_custom_field_values v
  ON v.employee_id = me.id AND v.field_def_id = d.id
UNION ALL
SELECT
  'document'::text                     AS kind,
  t.code,
  t.name                               AS label,
  t.description                        AS help_text,
  'file'::text                         AS field_type,
  NULL::jsonb                          AS options,
  t.is_required_for_onboarding         AS is_required,
  COALESCE(t.category, 'Documents')    AS section,
  t.sort_order,
  EXISTS (
    SELECT 1 FROM public.documents ed
     WHERE ed.employee_id = me.id
       AND ed.document_type_id = t.id
       AND ed.deleted_at IS NULL
  )                                    AS is_done,
  (SELECT ed.id FROM public.documents ed
    WHERE ed.employee_id = me.id AND ed.document_type_id = t.id AND ed.deleted_at IS NULL
    ORDER BY ed.created_at DESC LIMIT 1) AS document_id
FROM me
JOIN public.document_types t
  ON t.is_active
 AND t.deleted_at IS NULL
 AND t.visible_to_employee
 AND t.employee_uploadable            -- ← 093: not the joiner's to supply, not on their list
 AND (t.is_required_for_onboarding
      OR t.code IN ('CANCELLED_CHEQUE'))
 AND (t.required_for_employment_types IS NULL
      OR me.employment_type = ANY (t.required_for_employment_types))
 AND (t.required_for_department_ids IS NULL
      OR me.department_id = ANY (t.required_for_department_ids));

COMMENT ON VIEW public.v_my_onboarding_pack IS
  'What the signed-in employee still owes at onboarding: HR-configured fields plus the documents they can actually supply themselves, each with is_required and is_done. Types marked employee_uploadable = false (Aadhaar, PAN, bank proof) are HR''s to file and are deliberately absent — they remain required on HR''s side via v_onboarding_admin. The same requirement set submit_onboarding enforces; the client never derives it.';

GRANT SELECT ON public.v_my_onboarding_pack TO authenticated;

COMMIT;
