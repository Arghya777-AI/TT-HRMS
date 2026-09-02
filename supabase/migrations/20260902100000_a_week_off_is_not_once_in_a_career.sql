-- ============================================================================
-- Week-off is not a once-in-a-career leave.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────
-- `leave_types.max_times_in_service` caps how many times an employee may EVER
-- take a leave type across their whole employment. It exists for genuinely
-- once-or-twice-in-a-career leaves — Maternity is set to 2, which is a real
-- policy someone chose.
--
-- Week-off (MRL) was set to 1. So the first approved week-off an employee ever
-- took permanently barred them from applying for another, and the apply screen
-- refused with "leave type MRL may be availed at most 1 time(s) in service".
--
-- Six employees had already hit it — 060, 063, 079, 085, 091, 092 — every one of
-- them simply because they had taken one week-off. The cap is not a policy on a
-- recurring weekly entitlement; it is the wrong field being set on the wrong type.
--
-- NULL means unlimited, which is what a week-off is. The per-month cap and the
-- balance still apply, so nothing is uncapped by this — only the career limit goes.
--
-- Maternity keeps its 2. That one is deliberate.
-- ============================================================================

UPDATE public.leave_types
   SET max_times_in_service = NULL
 WHERE code = 'MRL'
   AND deleted_at IS NULL;

/*
  ── THE NEXT CAP, LEFT ALONE ON PURPOSE ──────────────────────────────────────
  `max_days_per_month` is 3 on every active type, seeded that way deliberately in
  migration 041600 to line up with the manager-notification rule. For Week-off that
  will bite next: a weekly off is four or five days a month, and the balance on
  screen already reads "7 available", so the fourth week-off in one month is
  refused by a different guard with a different message.

  Not changed here, because it is a policy number somebody chose and raising it is
  the venue's call, not a defect fix. Reported instead.
*/

-- Verify: MRL unlimited, ML still capped at 2.
SELECT code, name, max_times_in_service, max_days_per_month
  FROM public.leave_types
 WHERE deleted_at IS NULL AND is_active
 ORDER BY code;
