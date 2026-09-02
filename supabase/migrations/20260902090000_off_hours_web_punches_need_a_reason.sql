-- ============================================================================
-- STEP 1 of the off-hours web punch feature: the columns. Nothing behaves
-- differently yet — this migration only makes the state expressible.
--
-- ── WHAT IS BEING BUILT, ACROSS THE WHOLE FEATURE ───────────────────────────
-- A web or phone punch taken OUTSIDE the employee's shift window must carry a
-- reason of at least 15 characters and be approved by an admin. Gate punches are
-- untouched: a guard and a fixed camera at a known gate already establish the
-- what, the where and the when, and asking a person at the door to type a
-- sentence would be absurd.
--
-- Inside the shift window nothing is asked, however many times somebody punches.
-- That is the venue's decision and it is the right one: the 9-to-1-then-7-to-9
-- day this feature exists for is unusual because of the HOURS, not because of the
-- number of scans, and prompting during normal work would train people to type
-- "worked" into every box.
--
-- Until an admin approves, the hours show on the DAY with a star but are excluded
-- from the monthly total. That is also the venue's decision, chosen over counting
-- them provisionally, so payroll only ever sees approved time.
--
-- ── WHY THE COLUMNS COME FIRST, ALONE ───────────────────────────────────────
-- This is a live attendance path. Adding nullable columns and one defaulted
-- integer changes no query plan, no existing read and no existing write: every
-- row gets `requires_approval = false` and `pending_approval_minutes = 0`, which
-- is exactly what is true of every punch taken so far. The engine, the punch
-- endpoint and the screens follow in their own migrations, each verifiable on its
-- own.
-- ============================================================================

-- ── attendance_punches ──────────────────────────────────────────────────────
ALTER TABLE public.attendance_punches
  ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by       uuid REFERENCES public.profiles (id);

COMMENT ON COLUMN public.attendance_punches.requires_approval IS
  'True when this punch was recorded from the web or a phone outside the shift window, so it carries a reason and needs an administrator''s decision. Gate punches are never marked.';
COMMENT ON COLUMN public.attendance_punches.approved_at IS
  'When an administrator accepted the reason. NULL while pending; the day''s hours are shown but held out of the monthly total until this is set.';

/*
  A punch that needs approving must SAY WHY, and 15 characters is the venue's
  floor. Enforced here rather than only in the endpoint, so no other write path —
  an import, a fix-up script, a future function — can create an unexplained one.

  Written to tolerate the existing rows: every one of them has
  `requires_approval = false`, so the constraint is satisfied without a backfill.
*/
ALTER TABLE public.attendance_punches
  DROP CONSTRAINT IF EXISTS ck_ap__approval_reason;
ALTER TABLE public.attendance_punches
  ADD CONSTRAINT ck_ap__approval_reason
  CHECK (requires_approval = false OR length(btrim(COALESCE(reason, ''))) >= 15);

/* Approved means BOTH facts, or neither. A timestamp with no approver is not an
   audit trail, and an approver with no timestamp cannot be ordered. */
ALTER TABLE public.attendance_punches
  DROP CONSTRAINT IF EXISTS ck_ap__approved_fields;
ALTER TABLE public.attendance_punches
  ADD CONSTRAINT ck_ap__approved_fields
  CHECK ((approved_at IS NULL) = (approved_by IS NULL));

/* Only a punch that needs approval can be approved. Otherwise a gate scan could
   be stamped as "approved", which would read as though somebody had reviewed it. */
ALTER TABLE public.attendance_punches
  DROP CONSTRAINT IF EXISTS ck_ap__approved_only_when_required;
ALTER TABLE public.attendance_punches
  ADD CONSTRAINT ck_ap__approved_only_when_required
  CHECK (approved_at IS NULL OR requires_approval);

/* The admin queue reads "pending, newest first" and nothing else, so the index is
   partial — it stays tiny however many punches the table holds. */
CREATE INDEX IF NOT EXISTS idx_ap__pending_approval
  ON public.attendance_punches (punched_at DESC)
  WHERE requires_approval AND approved_at IS NULL AND is_voided = false;

-- ── attendance_days ─────────────────────────────────────────────────────────
ALTER TABLE public.attendance_days
  ADD COLUMN IF NOT EXISTS pending_approval_minutes integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.attendance_days.pending_approval_minutes IS
  'Of total_worked_minutes, how many come from punches still awaiting approval. The day shows the full figure with a star; period summaries subtract this so a monthly total never includes unapproved time. Zero for every day with no off-hours web punch.';

ALTER TABLE public.attendance_days
  DROP CONSTRAINT IF EXISTS ck_ad__pending_within_worked;
ALTER TABLE public.attendance_days
  ADD CONSTRAINT ck_ad__pending_within_worked
  CHECK (pending_approval_minutes >= 0
         AND pending_approval_minutes <= COALESCE(total_worked_minutes, 0));
