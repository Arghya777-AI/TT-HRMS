-- ============================================================================
-- Week-off has no monthly ceiling. The balance is the ceiling.
--
-- ── WHAT WAS REFUSED ────────────────────────────────────────────────────────
--   "Week-off allows at most 3.00 day(s) in a month. You already have 3.000
--    day(s) in September 2026 and this request adds 3.000."
--
-- `max_days_per_month` was seeded as 3 on EVERY active type in migration 041600,
-- deliberately, to line up with the manager-notification rule ("if employee is
-- applying for 3 or more then manager should be notified"). That number is sensible
-- for Earned and Sick Leave.
--
-- It is wrong for a WEEKLY entitlement. There are four or five weeks in a month, so
-- the fourth week-off of the month was always going to be refused — and the employee
-- had 5 days of balance sitting there while being told they had reached a limit.
--
-- Cleared to NULL, which `max_days_per_month IS NULL OR max_days_per_month > 0`
-- permits and the column's own comment defines as "no ceiling". The guard in
-- `trg_leave_requests__submit_rules` reads `IF lt.max_days_per_month IS NOT NULL`,
-- so with NULL it never runs.
--
-- Nothing is uncapped by this. The BALANCE still binds — `available_after_pending`
-- is checked on every request — and that is the right ceiling for a weekly off:
-- somebody can take the offs they have accrued and no more.
--
-- The apply screen needs no change: its "· max 3/month" label already renders only
-- when the value is non-null.
--
-- ── STILL 3 ON MATERNITY AND PATERNITY, WHICH IS ALSO WRONG ─────────────────
-- Same seed, same problem, and worse in kind: statutory maternity leave in India is
-- 26 weeks, so a three-day monthly cap makes it unusable no matter how many days HR
-- grants. Not changed here because it is a policy number and nobody has asked, but it
-- will refuse the first real maternity leave this venue processes.
-- ============================================================================

UPDATE public.leave_types
   SET max_days_per_month = NULL
 WHERE code = 'MRL'
   AND deleted_at IS NULL;

-- Verify: MRL unlimited per month, the others unchanged.
SELECT code, name, max_days_per_month, max_times_in_service
  FROM public.leave_types
 WHERE deleted_at IS NULL AND is_active
 ORDER BY code;
