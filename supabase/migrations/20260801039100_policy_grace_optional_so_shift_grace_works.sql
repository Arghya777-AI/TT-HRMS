-- ============================================================================
-- 20260801039100_policy_grace_optional_so_shift_grace_works.sql
--
-- THE PER-SHIFT GRACE PERIOD WAS DEAD CONFIGURATION.
--
-- The attendance engine decides grace with, in both 018 and 037600:
--
--     COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10)
--
-- That expression is written to mean "the policy may override the shift, and the
-- shift is the fallback". It cannot: `attendance_policies.grace_in_minutes` is
-- NOT NULL DEFAULT 10, so whenever a policy resolves for an employee — and one
-- resolves for every employee at this venue — the first branch always wins and
-- `sh.grace_in_minutes` is unreachable. The shift's grace only ever applied to
-- somebody with NO attendance policy at all.
--
-- The consequence, measured on the live project before this migration: the
-- General shift 'G' (09:30–18:30) carries `grace_in_minutes = 5`, and every
-- employee on the Office policy (AP-OFFICE, grace 15) was actually given 15
-- minutes. An administrator setting five minutes on the shift saw the number
-- saved, and nothing change. Reported exactly that way.
--
-- THE FIX IS TO LET THE POLICY BE SILENT. Dropping NOT NULL and the default on
-- the two policy columns makes the COALESCE mean what it says: leave a policy's
-- grace empty and the SHIFT decides, which is the per-shift control that was
-- asked for and which the engine was already written to honour. No engine change,
-- no recomputation, and nothing about the shift columns moves.
--
-- WHY THE DEFAULT GOES TOO, not just the NOT NULL. Leaving `DEFAULT 10` would
-- mean every newly created policy silently re-overrides every shift's grace, and
-- the next administrator would hit exactly this bug again. A policy that has not
-- been given a grace period should not be asserting one.
--
-- EXISTING VALUES ARE LEFT ALONE, DELIBERATELY. AP-OFFICE 15, AP-OPS 10 and
-- AP-SECURITY 5 stay as they are, because clearing them would change what counts
-- as late for 77 employees and their attendance history reads against that number.
-- Handing control to the shift is now a per-policy decision an administrator makes
-- by clearing the field, with a reason recorded, and the screens say so.
-- ============================================================================

BEGIN;

ALTER TABLE public.attendance_policies
  ALTER COLUMN grace_in_minutes  DROP NOT NULL,
  ALTER COLUMN grace_in_minutes  DROP DEFAULT,
  ALTER COLUMN grace_out_minutes DROP NOT NULL,
  ALTER COLUMN grace_out_minutes DROP DEFAULT;

COMMENT ON COLUMN public.attendance_policies.grace_in_minutes IS
  'Late-in grace for this policy, or NULL to use the SHIFT''s grace_in_minutes. '
  'Nullable since migration 039100: it was NOT NULL DEFAULT 10, which made the engine''s '
  'COALESCE(pol, sh, 10) unable ever to reach the shift, so per-shift grace was dead '
  'configuration for every employee with a policy.';

COMMENT ON COLUMN public.attendance_policies.grace_out_minutes IS
  'Early-out grace for this policy, or NULL to use the SHIFT''s grace_out_minutes. '
  'Nullable since migration 039100 — see grace_in_minutes.';

COMMIT;
