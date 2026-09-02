-- ============================================================================
-- The balance is the only ceiling on how much leave somebody may take.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Migration 041600 seeded `max_days_per_month = 3` on every active type to line up
-- with a manager-notification rule. It then refused legitimate leave three times in
-- one week: a week-off with five days of balance unused, and it would have refused
-- the first real maternity leave outright — statutory maternity in India is 26 weeks,
-- which three days a month can never deliver.
--
-- Asked for: everything unlimited. So every cap on HOW MUCH LEAVE A PERSON MAY TAKE
-- is cleared, and the accrued balance — checked on every single request as
-- `available_after_pending` — becomes the only thing that limits them. Which is the
-- ceiling that actually means something: you take the leave you have.
--
-- ── WHAT IS CLEARED ─────────────────────────────────────────────────────────
--   max_days_per_month     3 on EL, ML, PL, SL  → NULL   the one that kept refusing
--   max_days_per_request   5 on MRL/PL, 182 ML  → NULL   the balance already bounds it
--   max_times_in_service   2 on ML              → NULL   a career limit nobody asked for
--   max_consecutive_days   already NULL everywhere
--
-- ── WHAT IS DELIBERATELY KEPT, AND WHY IT IS NOT A LIMIT ON ENTITLEMENT ─────
--   min_days_per_request   0.5   A FLOOR. Removing it permits a zero-day request,
--                                which is not leave.
--   max_backdated_days     2     How far into the past somebody may apply. A control
--                                on rewriting history, not on how much leave they get
--                                — clearing it would let anybody backdate a year.
--   min_notice_days        0     Already no restriction.
--   min_service_months     6 PL  Eligibility, not quantity: whether paternity leave
--                                applies to you yet.
--   max_carry_forward_days 30 EL Balance mechanics — how much survives a year end.
--                                Clearing it changes accrual and lapsing, not whether
--                                a request is allowed.
--
-- Those five are separate decisions. If the venue wants them gone too they can go,
-- but sweeping them in under "unlimited" would change things nobody was complaining
-- about.
-- ============================================================================

UPDATE public.leave_types
   SET max_days_per_month   = NULL,
       max_days_per_request = NULL,
       max_times_in_service = NULL,
       max_consecutive_days = NULL
 WHERE deleted_at IS NULL;

SELECT code, name, is_active,
       max_days_per_month, max_days_per_request, max_times_in_service,
       max_consecutive_days, min_days_per_request, max_backdated_days
  FROM public.leave_types
 WHERE deleted_at IS NULL
 ORDER BY is_active DESC, code;
