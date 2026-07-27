-- =============================================================================
-- Migration 067 — pin storage_path on employee-supplied documents.
--
-- THE HOLE
-- --------
-- Migration 20260801014000 added `documents__self__insert` so an employee can
-- file their own document. It pins a great deal — subject_kind, employee_id,
-- company_id, uploaded_by, status, virus_scan_status, current_version,
-- is_system_generated, is_confidential, requires_acknowledgement, reviewed_by,
-- reviewed_at, esign_request_id, generated_from_template_id, archived_at, and the
-- document type's visibility — and it DOES pin `storage_bucket = 'documents'` —
-- but it does NOT pin `storage_path`.
--
-- So an employee could insert a row against their OWN employee_id whose
-- storage_path points into ANOTHER employee's folder:
--
--     employee/<someone-else-uuid>/PAN/card.pdf
--
-- WHY THAT MATTERS, precisely (not overstated):
--   * The OBJECT layer is already safe for writes. Migration 039's
--     `documents__own_write` on storage.objects requires
--     (storage.foldername(name))[2] = app.current_employee_id()::text, so the
--     employee cannot upload a file into another person's folder.
--   * But READS do not go through an RLS policy at all. 039's own comment says
--     reads happen "via the document-access edge function (5-min signed URL +
--     document_access_log)", and there is no `authenticated` SELECT policy on the
--     documents bucket. Any reader that authorises from the DOCUMENTS ROW — which
--     is the natural implementation, since that row carries employee_id — would
--     mint a signed URL for whatever storage_path the row names.
--   * The row would pass every other check, because it genuinely belongs to the
--     requesting employee. Only the path is a lie.
--
-- That is a cross-employee disclosure vector for exactly the documents an HRMS
-- exists to protect: PAN, Aadhaar, bank proof, medical certificates.
--
-- THE FIX
-- -------
-- Mirror the object layer's rule in the metadata layer, so the two cannot
-- disagree: the bucket must be `documents`, and the second path segment must be
-- the employee's own id. `storagePathFor()` in
-- src/features/profile/api/documents.api.ts already builds
-- `employee/<employee_id>/…`, and its own comment records that it "puts the
-- employee id in the second position", so this pins the convention the client
-- already follows rather than inventing one.
--
-- Deliberately NOT done: no attempt to constrain the rest of the path. The file
-- name is the employee's own, and the object layer governs what may actually be
-- written there. Pinning the owner segment is the whole security question.
--
-- This REPLACES the policy rather than adding a second one: multiple permissive
-- INSERT policies are OR-ed, so adding one would not close anything.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 067: pin storage_bucket and the owner segment of storage_path on employee-supplied documents', true);
SELECT set_config('app.source', 'migration', true);

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
    -- ── NEW in 067: the storage location must be the employee's OWN folder ──
    -- Same rule as storage.objects.documents__own_write (migration 039), so a
    -- metadata row can never name a path the object layer would refuse.
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
    )
  );

COMMENT ON POLICY documents__self__insert ON public.documents IS
  'Employee-supplied file, parked in pending_review for /admin/documents/pending. Status, reviewer, scan state, confidentiality, versioning and entity are pinned to literals; the type must be employee-visible and neither e-signed nor acknowledgement-bearing; and storage_bucket/storage_path are pinned to the employee''s OWN folder (migration 067) so a metadata row cannot name another employee''s file — reads authorise from this row, not from the path.';

COMMIT;
