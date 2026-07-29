-- =============================================================================
-- 086 · Only the documents that need a human get one
--
-- REPORTED: a profile photograph sat in the vault as "Awaiting verification", and
-- HR was being asked to approve it. A photo is not a claim about anything — there
-- is nothing in it for HR to check, and putting it in the queue teaches people to
-- clear the queue without looking, which is how a real Aadhaar mismatch gets waved
-- through.
--
-- The mechanism for this ALREADY EXISTED and was simply never used:
-- `document_types.requires_approval`. Two things were wrong.
--
--   1. It was `false` on every single type, including Aadhaar, PAN and bank proof.
--      So the column expressed no policy at all.
--   2. The self-upload path ignored it anyway. `documents__self__insert` pinned
--      `status = 'pending_review'` as a literal, so an employee's upload was
--      queued whatever its type said. (The generator, document-generate, already
--      read the flag correctly — the two paths disagreed.)
--
-- This migration sets the flag to say something true, and makes the policy obey it.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 086: per-type document verification requirement, honoured by the self-upload policy', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Which types actually need HR eyes
-- -----------------------------------------------------------------------------

/*
  THE TEST APPLIED, so that adding a type later has an answer rather than a habit:
  does the file ASSERT SOMETHING the company would otherwise have to take on
  trust, and would being wrong about it matter?

    * An Aadhaar number, a PAN, a bank account, a degree, a previous employer's
      relieving letter, a police verification, a fitness certificate — yes. Each
      is a claim, each is used for something consequential (statutory filing,
      paying money to an account, a job requirement), and a forged or mistyped one
      causes real harm. These get verified.

    * A photograph, a specimen signature, a CV — no. A photo is not a claim; the
      worst case is a bad likeness, which the employee is the first to notice and
      can simply replace. Queueing these buries the ones above.

    * Anything the COMPANY issued — contracts, offer and appointment letters,
      increment letters, NDAs, warnings, Form 16, payslips, policies, SOPs — is
      not evidence submitted to us, it is our own output. HR approving our own
      letter is a rubber stamp. document-generate already reads this flag, so
      leaving them false is what keeps generated documents out of the queue.
*/
UPDATE public.document_types
   SET requires_approval = true, updated_at = now()
 WHERE deleted_at IS NULL
   AND code IN (
     'AADHAAR',             -- statutory identity
     'PAN',                 -- statutory identity, drives TDS
     'PASSPORT',            -- identity / right to work
     'BANK_PROOF',          -- money goes here; a wrong account is unrecoverable
     'CANCELLED_CHEQUE',    -- corroborates the account above
     'EDU_CERT',            -- a qualification claim
     'EXP_LETTER',          -- a claim about someone else's employment
     'RELIEVING_LETTER',    -- proof they are free to join
     'MEDICAL_CERT',        -- fitness, and food-handling roles depend on it
     'POLICE_VERIFICATION'  -- a background claim
   )
   AND requires_approval = false;

/*
  And explicitly NOT these. Stated as a write rather than left implicit so the
  intent survives someone later "tidying up" the flags: a photograph never needs
  approval, and neither does a signature specimen or a CV.
*/
UPDATE public.document_types
   SET requires_approval = false, updated_at = now()
 WHERE deleted_at IS NULL
   AND code IN ('PHOTO', 'SIGNATURE', 'RESUME')
   AND requires_approval = true;

-- -----------------------------------------------------------------------------
-- 2. The self-upload policy reads the flag instead of a literal
-- -----------------------------------------------------------------------------

/*
  `status` moves INSIDE the type check, because that is the only place the type's
  own flag is in scope. Everything else the policy pinned stays pinned — this
  changes which status is allowed, not who may insert or where the file lives.

  `reviewed_by` / `reviewed_at` stay NULL even on an auto-approved row, and that
  is deliberate: nobody reviewed it. The row says "approved, unreviewed", which is
  the truth. It is not backdated to look like a human decision.
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
        AND NOT dt.requires_esign
        AND NOT dt.requires_acknowledgement
        AND (NOT dt.requires_expiry OR documents.expiry_date IS NOT NULL)
        -- The status the type demands, and only that one. An employee cannot
        -- self-approve a type that requires review, and cannot park a photograph
        -- in a queue nobody needs to work.
        AND documents.status = (
          CASE WHEN dt.requires_approval THEN 'pending_review' ELSE 'approved' END
        )::public.document_status
    )
  );

COMMENT ON POLICY documents__self__insert ON public.documents IS
  'Employee-supplied file. The status is whatever the TYPE requires — pending_review when document_types.requires_approval, otherwise approved on arrival — so only documents that assert something a human must check reach /admin/documents/pending. Reviewer, scan state, confidentiality, versioning and entity remain pinned to literals, and storage_bucket/storage_path to the employee''s own folder (migration 067).';

-- -----------------------------------------------------------------------------
-- 3. Clear the queue of things that never needed to be in it
-- -----------------------------------------------------------------------------

/*
  Rows already parked under the old blanket rule. Only ever moves pending_review →
  approved, and only for types that do not require approval — a real pending
  Aadhaar is untouched. reviewed_by stays NULL for the same reason as above: this
  is a policy correction, not a review that happened.
*/
UPDATE public.documents d
   SET status = 'approved', updated_at = now()
  FROM public.document_types t
 WHERE t.id = d.document_type_id
   AND d.deleted_at IS NULL
   AND d.status = 'pending_review'
   AND NOT t.requires_approval;

COMMIT;
