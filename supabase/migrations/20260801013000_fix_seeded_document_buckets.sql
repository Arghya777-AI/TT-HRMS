-- =============================================================================
-- Migration 062 — point the seeded documents at a storage bucket that EXISTS.
--
-- MY BUG, FIXED
-- -------------
-- Migration 060 seeded 64 documents with storage_bucket set to
-- 'company-documents' and 'employee-documents'. Neither bucket exists. I asserted
-- at the time that "no migration creates a storage bucket" — that was WRONG:
-- migration 039 (20260801003900_storage_buckets.sql) creates twelve of them:
--
--   employee-photos, face-enrolment-captures, kiosk-punch-photos, documents,
--   payslips, contracts, communications, brand, imports, exports, signatures,
--   archive
--
-- The correct bucket for employee and company document metadata is `documents`
-- (private, no mime restriction, with storage.objects policies already written in
-- 039 §2). Left uncorrected, every signed-URL call would fail on a bucket that
-- is not there — and the failure would look like a permissions problem rather
-- than a typo, which is the expensive kind of wrong.
--
-- Contract templates and payslips have their own dedicated buckets ('contracts',
-- 'payslips'); this migration only touches the rows 060 inserted, identified by
-- the bucket names that never existed, so it cannot disturb anything real.
--
-- The storage_path prefixes ('company/...', 'employee/<CODE>/...') are kept as
-- they are: they are folder conventions INSIDE the bucket, and 039's policies key
-- on storage.foldername(), so the shape still matches.
--
-- STILL TRUE AFTER THIS MIGRATION: no file bytes have been uploaded. These rows
-- describe documents that do not exist as objects. Lists, filters, expiry
-- tracking, version history and acknowledgements are fully live; a download will
-- 404 at the object layer rather than failing on a missing bucket. Making
-- downloads real means uploading actual PDFs, which is a separate task.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 062: correct seeded documents to the documents bucket created in 039', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.documents
   SET storage_bucket = 'documents'
 WHERE storage_bucket IN ('company-documents', 'employee-documents');

DO $check$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.documents d
   WHERE NOT EXISTS (SELECT 1 FROM storage.buckets b WHERE b.id = d.storage_bucket);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'seed 062: % document(s) still reference a bucket that does not exist', v_bad;
  END IF;
  RAISE NOTICE 'seed 062: every document now points at an existing bucket';
END
$check$;

COMMIT;
