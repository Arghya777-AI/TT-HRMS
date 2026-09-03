-- ============================================================================
-- An off-hours punch carries its proof.
--
-- ── WHAT THE VENUE ASKED FOR ────────────────────────────────────────────────
-- "So here, in punch-in, you are giving this reason, right? Can we give one small
--  screenshot or something for records, evidence?" — "Mandatory, yes, yes, yes.
--  They should attach. And while checking out also, it's mandatory. Because
--  someone will check in and the meeting would have been over long back. They
--  might check out by 10 o'clock or 12 o'clock. I don't want to pay so much and I
--  don't want to keep on verifying all that. So it's better they attach
--  screenshots for check-in and check out."
--
-- So: a web or phone punch taken OUTSIDE the shift window needs a picture as well
-- as a reason, on the way in and on the way out. A gate punch needs neither — the
-- camera at the door already saw who it was, and that flow is untouched.
--
-- ── WHY A `documents` ROW AND NOT `attendance_punches.photo_path` ───────────
-- `photo_path` exists and is unused: 0 of 1,381 live punches carry one. It is a bare
-- storage path, and a bare path has none of the three things this evidence needs:
--
--   * `document-access` writes `document_access_log` BEFORE it mints a URL, so a
--     proof photo cannot be looked at without a record of who looked. For evidence
--     that decides whether overtime gets paid, that trail is the point.
--   * `DocumentOpenButtons` and the approval panel already render a document id, so
--     an administrator gets a working View/Download with no new screen.
--   * Retention has somewhere to live. HR asked for these to be removable once a
--     decision is made ("once it is approved, the evidence should go off"); a
--     document row can be archived and audited, a loose object in a bucket cannot.
--
-- `photo_path` is left exactly as it is — untouched, still unused, still available
-- for the kiosk capture it was built for.
--
-- ── NOTHING HERE REFUSES A PUNCH ────────────────────────────────────────────
-- No CHECK constraint ties a proof to an off-hours punch, deliberately. The venue
-- has already lost attendance to a hard gate: employees hit the reason requirement,
-- decided the app was broken and stopped punching altogether — "they thought okay,
-- it's not working, so let's attend like that only." A punch is a fact about
-- somebody's day; a missing screenshot must never erase it.
--
-- The form makes the photo mandatory, and the server RECORDS AND FLAGS a punch that
-- arrives without one, so a failed upload on bad signal costs a review rather than
-- a day's attendance. Both are enforced above this migration; the schema's job is
-- only to give the proof somewhere to live.
-- ============================================================================

SELECT set_config('app.reason',
  'an off-hours web or phone punch can carry a proof photo, stored as a document so every view of it is logged',
  true);

-- ---------------------------------------------------------------------------
-- 1. The document type
-- ---------------------------------------------------------------------------
/*
  Every flag is load-bearing against `documents__self__insert` (migration 040200),
  which is what lets the employee's own browser write the row:

    employee_uploadable    the employee takes the picture, not HR
    visible_to_employee    else they cannot see back what they submitted
    requires_esign         false — a photograph is evidence, not an agreement
    requires_acknowledgement false, for the same reason
    requires_approval      FALSE. The punch is what gets approved, by somebody
                           looking at the picture and the hours together. Sending
                           the photo itself to a second document queue would put
                           the same decision in two places.
    is_sensitive           true: it is a photograph of where somebody was, and it
                           should not sit in the general document browser.
*/
INSERT INTO public.document_types
  (code, name, description, category, sub_category,
   allowed_mime_types, max_file_size_mb, storage_bucket,
   employee_uploadable, visible_to_employee, visible_to_manager,
   requires_expiry, requires_approval, requires_esign, requires_acknowledgement,
   is_sensitive, is_required_for_onboarding, is_active, sort_order)
VALUES
  ('ATTENDANCE_PROOF', 'Attendance Proof',
   'A photograph or screenshot supporting a punch taken outside shift hours — the meeting invitation, the call window, or the place of work.',
   /*
     `ck_document_types__category` permits ten categories and 'attendance' is not one
     of them — checked against the live constraint after it refused this row. The
     receipt type (EXPENSE_RECEIPT) sits under 'compliance' for the same reason: it
     is evidence held for audit rather than a personnel record.
   */
   'compliance', 'attendance_proof',
   ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf'],
   10, 'documents',
   true,  true,  true,
   false, false, false, false,
   true,  false, true, 320)
/*
  `uq_document_types__code` is PARTIAL (`WHERE deleted_at IS NULL`), so a bare
  `ON CONFLICT (code)` infers no index and raises 42P10. The predicate has to be
  restated for Postgres to match it.
*/
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO UPDATE
   SET is_active           = true,
       employee_uploadable = true,
       visible_to_employee = true,
       allowed_mime_types  = EXCLUDED.allowed_mime_types,
       max_file_size_mb    = EXCLUDED.max_file_size_mb;

-- ---------------------------------------------------------------------------
-- 2. Somewhere on the punch to hang it
-- ---------------------------------------------------------------------------
/*
  On the partitioned parent, so every existing and future monthly partition gets it.
  Nullable and with no default: the overwhelming majority of punches are gate scans
  and will never carry one.

  NOT VALID is unnecessary here — there is nothing to re-validate on a new nullable
  column — but the FK is worth stating: an id pointing at a document that has been
  purged would make the admin queue show a broken open button, and ON DELETE SET NULL
  turns that into an honest "no proof attached" instead.
*/
ALTER TABLE public.attendance_punches
  ADD COLUMN IF NOT EXISTS proof_document_id uuid
    REFERENCES public.documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.attendance_punches.proof_document_id IS
  'Proof photo for a punch taken outside the shift window, as a documents row so every view is logged by document-access. NULL on a gate punch and on any in-window punch. Never enforced by a constraint: a missing screenshot must not erase somebody''s attendance.';

/*
  The admin queue filters on exactly this: off-hours punches still awaiting a
  decision, newest first. Partial, so it indexes the handful that are open rather
  than all 1,381 punches.
*/
CREATE INDEX IF NOT EXISTS ix_ap__awaiting_approval
  ON public.attendance_punches (punched_at DESC)
  WHERE requires_approval AND approved_at IS NULL;
