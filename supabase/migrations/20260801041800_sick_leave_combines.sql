-- =============================================================================
-- 20260801041800 — Sick Leave can be combined again
-- =============================================================================
--
-- ASKED FOR, TWICE. "if employee want to take leave let's 5 days so he can
-- distribute leave in sick, earn, leave without pay like that" — sick leave named
-- explicitly in the distribution — and then, looking at the screen:
-- "when I selecting sick then why can't select other".
--
-- WHAT WAS STOPPING IT
--
-- 039700 added `leave_types.allows_combination` and set Sick Leave to false, so
-- `leave_requests_combination_guard` refuses any grouped application that mixes
-- it with another type. The screen mirrors that by switching the other rows off,
-- which is why one sick day plus two earned could not be filed even though both
-- balances covered it.
--
-- That migration's own header says how this should be undone: "the rule is a
-- property of the leave type and the next type that needs it should be a data
-- change, not a migration". It was right, and the reason a migration is needed
-- anyway is that the flag was never put on the Leave Type Master — so there was
-- no screen on which to make the data change. This file flips the flag; the same
-- commit adds the field to that screen, so the NEXT change really is a data
-- change.
--
-- WHAT DOES NOT CHANGE, AND IS WORTH KNOWING
--
--   * `requires_document_after_days = 2` still applies. A medical certificate is
--     still expected beyond two days of sick leave, whether or not the
--     application also carries earned leave.
--   * `requires_reason = true` (041600) still applies, so an application
--     containing sick leave still has to say why. The form already asks when any
--     chosen type demands it.
--   * THE DATES ARE STILL DEALT OUT, NOT SHARED. `leave_requests_no_overlap`
--     refuses two live requests whose ranges touch, so a mixed application
--     becomes one request per type over DISJOINT dates —
--     `splitAllocationsAcrossDates` decides which. One sick day plus two earned
--     across 11–13 August files sick on the 11th and earned on the 12th–13th, in
--     that order. It does not let the employee say the illness was on the 13th;
--     that needs two separate applications, and it is the honest limit of a
--     grouped one.
--
-- The guard itself is UNTOUCHED. It reads the column, so flipping the column is
-- the whole change — which is the point of having stored the rule as data.
-- =============================================================================

BEGIN;

-- `audit.reason_required_tables` includes leave_types, so the UPDATE needs a
-- reason before the audit trigger accepts it. A migration is no more exempt from
-- that than a screen is.
SELECT set_config('app.reason', 'migration 041800: Sick Leave may be combined with other leave types in one application, as asked for', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.leave_types
   SET allows_combination = true
 WHERE code = 'SL'
   AND deleted_at IS NULL
   AND allows_combination IS DISTINCT FROM true;

COMMIT;
