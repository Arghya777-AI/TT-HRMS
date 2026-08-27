-- =============================================================================
-- 20260827140000 — putting back the leave types nobody asked me to remove
-- =============================================================================
--
-- REPORTED, and correct:
--
--   "why you removed paternity, maternity, week-off these leave"
--
-- ── WHAT I GOT WRONG ────────────────────────────────────────────────────────
--
-- The request named three types: bereavement, casual, leave without pay.
-- 20260827100000 deactivated EIGHT, by writing `WHERE code NOT IN ('SL','EL')`
-- and arguing in its own header that matching by EXCLUSION was safer than naming
-- the three, because it would "catch a bereavement type whatever it was called".
--
-- That argument was wrong, and it was wrong in a way worth writing down: it
-- assumed everything outside the two named types was junk. It was not. The set
-- also held MATERNITY and PATERNITY leave — statutory entitlements under the
-- Maternity Benefit Act, not venue preferences — plus Week-off and On Duty, which
-- nobody had mentioned in any conversation. Exclusion is the right instrument when
-- you know the complement is uninteresting. Here the complement was the part that
-- mattered, and naming the three would have been both narrower and correct.
--
-- I also asserted the types had "been switched off months ago" by 20260801038600,
-- and read their reappearance as somebody re-creating them. That was false.
-- 038600 sets `annual_quota_days`, `accrual_frequency`,
-- `accrual_days_per_period`, `carry_forward_allowed` and `max_carry_forward_days`
-- — it never touches `is_active`. Every one of those types was still active and
-- offered, and 20260827100000 is what removed them. Checking that file before
-- describing what it did would have cost one minute.
--
-- ── WHAT COMES BACK, AND WHAT STAYS OFF ─────────────────────────────────────
--
--   BACK   ML  Maternity Leave    statutory; never discussed
--          PL  Paternity Leave    statutory; never discussed
--          MRL Week-off           the venue's own; asked for by name today
--          OD  On Duty            engine-written; never discussed
--
--   OFF    BL  Bereavement Leave  asked for
--          LWP Leave Without Pay  asked for
--          CO  Compensatory Off   asked for earlier: "comp-off hide from everywhere"
--
-- CASUAL LEAVE IS NOT IN EITHER LIST, because it is not there to switch: 20260801039600
-- merged it into Week-off and soft-deleted the row. It is still SEEN on
-- /me/leave, which is a separate defect fixed in 20260827150000 — the balances
-- view never filtered deleted types, so a stale -0.5 balance kept rendering a card
-- for a type that no longer exists.
--
-- ── WHAT THESE TYPES CAN AND CANNOT DO ──────────────────────────────────────
--
-- They come back OFFERED but not ACCRUING: 038600 left them at
-- `annual_quota_days = 0` and `accrual_frequency = 'none'`, so they hold no days
-- until somebody grants them. For maternity and paternity that is close to how
-- they actually work — granted against an event, not earned monthly — but an
-- employee applying today would be refused for insufficient balance. That is a
-- pre-existing condition of 038600 and not something this migration invents; it
-- is named here so it is not discovered later as a surprise. The balance button
-- added today (`/admin/leave/adjustments`) is how days get granted.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 140000: restoring maternity, paternity, week-off and on-duty leave — migration 100000 deactivated them by exclusion when only bereavement, casual and leave-without-pay had been asked for', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Back on
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.leave_types
   SET is_active = true
 WHERE code IN ('ML', 'PL', 'MRL', 'OD')
   AND deleted_at IS NULL
   AND NOT is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Still off, and only these three
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Restated rather than assumed. If a later migration or a hand edit switched one
-- of them back on, the venue's stated rule is what should win, and saying it twice
-- costs nothing.

UPDATE public.leave_types
   SET is_active = false
 WHERE code IN ('BL', 'LWP', 'CO')
   AND deleted_at IS NULL
   AND is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Report every type and refuse to look right if the two lists disagree
-- ─────────────────────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_should_be_on  text[] := ARRAY['SL','EL','ML','PL','MRL','OD'];
  v_should_be_off text[] := ARRAY['BL','LWP','CO'];
  v_wrongly_off   text;
  v_wrongly_on    text;
BEGIN
  SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
    INTO v_wrongly_off
    FROM public.leave_types
   WHERE deleted_at IS NULL AND code = ANY(v_should_be_on) AND NOT is_active;

  SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
    INTO v_wrongly_on
    FROM public.leave_types
   WHERE deleted_at IS NULL AND code = ANY(v_should_be_off) AND is_active;

  IF v_wrongly_off IS NOT NULL THEN
    RAISE EXCEPTION 'these should be offered and are not: %', v_wrongly_off;
  END IF;
  IF v_wrongly_on IS NOT NULL THEN
    RAISE EXCEPTION 'these should not be offered and are: %', v_wrongly_on;
  END IF;

  RAISE NOTICE 'offered: %', (
    SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
      FROM public.leave_types WHERE deleted_at IS NULL AND is_active);
  RAISE NOTICE 'not offered: %', (
    SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
      FROM public.leave_types WHERE deleted_at IS NULL AND NOT is_active);
END $verify$;

COMMIT;
