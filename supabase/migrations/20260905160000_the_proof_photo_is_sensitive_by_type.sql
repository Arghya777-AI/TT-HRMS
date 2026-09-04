/*
  The off-hours proof photo: confidential by TYPE, because it cannot be by row.

  ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
  `attendanceProof.api.ts` uploaded its `documents` row with `is_confidential: true`,
  reasoning that a photograph of where somebody was should not sit in the general
  document browser beside their PAN card. The reasoning was right and the mechanism
  was wrong: `documents__self__insert` requires `is_confidential = false`, so EVERY
  proof upload was refused with 42501 — after the bytes had been written to storage
  and were then cleaned up by the client's catch block.

  Probed against the live policy as the employee, one flag the only difference:

      is_confidential = true    ->  REFUSED [42501]  row-level security
      is_confidential = false   ->  ACCEPTED

  The visible symptom was somebody starting at 8 am unable to punch at all, with a
  failure that looked like a bad connection rather than a rule. And the policy is
  right to forbid it: an employee who could mark their own upload confidential could
  hide the photograph from the very people who have to review it.

  ── SO THE FLAG MOVES TO WHERE IT ALWAYS BELONGED ────────────────────────────
  `document_types.is_sensitive` is what actually keeps a class of document out of the
  general browser, and ATTENDANCE_PROOF has carried it since it was created. That is
  now the ONLY thing doing that job, so it must not be able to drift: the original
  upsert's DO UPDATE re-asserted `is_active`, `employee_uploadable` and
  `visible_to_employee` but NOT `is_sensitive`, which means a row edited by hand or
  seeded differently would keep the wrong value through every later re-run.

  Nothing here changes the client — that is one word in one file. This makes the
  server side of the same decision explicit and self-healing.
*/
UPDATE public.document_types
   SET is_sensitive = true
 WHERE code = 'ATTENDANCE_PROOF'
   AND is_sensitive IS DISTINCT FROM true;

/*
  And the same for the receipt type, which reached the identical arrangement by the
  identical route: evidence held for audit, kept out of the personnel browser by its
  type rather than by whatever the uploading client claimed on the row.
*/
UPDATE public.document_types
   SET is_sensitive = true
 WHERE code = 'EXPENSE_RECEIPT'
   AND is_sensitive IS DISTINCT FROM true;

DO $check$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(code, ', ') INTO v_bad
    FROM public.document_types
   WHERE code IN ('ATTENDANCE_PROOF', 'EXPENSE_RECEIPT')
     AND (is_sensitive IS DISTINCT FROM true OR is_active IS DISTINCT FROM true
          OR employee_uploadable IS DISTINCT FROM true);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these types cannot accept an employee upload and keep it out of the browser: %', v_bad;
  END IF;
  RAISE NOTICE 'ATTENDANCE_PROOF and EXPENSE_RECEIPT: sensitive by type, uploadable by the employee';
END
$check$;
