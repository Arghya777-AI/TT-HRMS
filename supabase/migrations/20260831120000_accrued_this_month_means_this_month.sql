-- =============================================================================
-- 20260831120000 — "Accrued this month" now means this month
-- =============================================================================
--
-- REPORTED, on /admin/leave/balances, against Sunil M:
--
--   "as you can see for sunil is it showing 8"
--
-- Sick Leave, column "Accrued this month": 8. His balance is 2 and the statement
-- says 2, so the balance was right — the LABEL was lying.
--
-- ── WHAT I GOT WRONG ────────────────────────────────────────────────────────
--
-- The venue asked to rename "Accrued" to "Accrued this month". I renamed the
-- header and shipped it without checking what `leave_balances.accrued_days` holds.
-- It is the YEAR-TO-DATE accrual: Sunil has eight monthly sick-leave rows of 1.0,
-- January through August, so the column reads 8. Renaming a cumulative figure does
-- not make it monthly — it turns a correct number into a false statement, which is
-- worse than the vague label it replaced.
--
-- ── WHAT "THIS MONTH" MEANS, TAKEN FROM THE DATA ────────────────────────────
--
-- One accrual row per month, dated the FIRST of the month it lands in: Sunil's
-- earned-leave credit reads "Monthly accrual for July 2026" with
-- `effective_date = 2026-08-01`, because `accrue_leave` runs at the end of July and
-- credits it forward. So "this month" is the accrual whose `effective_date` falls
-- in the current IST month — for August that gives Sunil 1.5 earned and 1.0 sick,
-- which is what a reader of that column expects.
--
-- Reversed rows are excluded, so an accrual that was undone stops counting. And
-- `leave_year` is matched against the balance row rather than recomputed, so the
-- two cannot disagree across the March boundary.
--
-- `accrued_days` STAYS, untouched and still year-to-date: it is what the
-- entitlement arithmetic uses and several screens read it. This ADDS a column
-- rather than redefining one, and `CREATE OR REPLACE VIEW` may only append, which
-- is why `accrued_this_month_days` is last.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 20260831120000: v_leave_balance_current gains accrued_this_month_days — the balances screen renamed accrued_days to "Accrued this month" and that column is year-to-date, so Sunil M read 8 against a balance of 2', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE VIEW public.v_leave_balance_current
WITH (security_invoker = true) AS
SELECT lb.employee_id,
    lb.leave_type_id,
    lt.code AS leave_type_code,
    lt.name AS leave_type_name,
    lt.colour_hex,
    lt.is_paid,
    lt.is_comp_off,
    lt.allow_half_day,
    lb.leave_year,
    lb.opening_days,
    lb.accrued_days,
    lb.carried_forward_days,
    lb.adjusted_days,
    lb.opening_days + lb.accrued_days + lb.carried_forward_days + lb.adjusted_days AS entitlement_days,
    lb.availed_days,
    lb.pending_days,
    lb.encashed_days,
    lb.lapsed_days,
    lb.available_days,
    lb.available_after_pending,
    COALESCE(exp30.expiring_soon_days, 0::numeric) AS expiring_soon_days,
    exp30.nearest_expiry,
    lb.last_recomputed_at,
    lt.is_active AS leave_type_active,
    COALESCE(acc.days_this_month, 0::numeric) AS accrued_this_month_days
   FROM leave_balances lb
     JOIN leave_types lt ON lt.id = lb.leave_type_id AND lt.deleted_at IS NULL
     JOIN employees e ON e.id = lb.employee_id AND e.deleted_at IS NULL
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(COALESCE(col.days_remaining, col.days)), 0::numeric) AS expiring_soon_days,
            min(col.expires_on) AS nearest_expiry
           FROM comp_off_ledger col
          WHERE lt.is_comp_off AND col.employee_id = lb.employee_id AND col.entry_type = 'earned'::text AND (col.status = ANY (ARRAY['available'::text, 'partially_used'::text])) AND col.expires_on IS NOT NULL AND col.expires_on >= util.ist_today() AND col.expires_on <= (util.ist_today() + 30)) exp30 ON true
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(ll.days), 0::numeric) AS days_this_month
           FROM leave_ledger ll
          WHERE ll.employee_id = lb.employee_id
            AND ll.leave_type_id = lb.leave_type_id
            AND ll.leave_year = lb.leave_year
            AND ll.entry_type = ANY (ARRAY['accrual'::ledger_entry_type, 'pro_rata_accrual'::ledger_entry_type])
            AND ll.reversed_by_id IS NULL
            AND date_trunc('month', ll.effective_date::timestamp) = date_trunc('month', util.ist_today()::timestamp)) acc ON true
  WHERE lb.leave_year = leave_year_of(util.ist_today());

COMMENT ON COLUMN public.v_leave_balance_current.accrued_this_month_days IS
  'Accrual credited in the CURRENT IST month only, read from leave_ledger. Distinct from accrued_days, which is the year-to-date total the entitlement arithmetic uses. Excludes reversed rows.';

DO $verify$
DECLARE v_bad int; v_sunil numeric;
BEGIN
  /* The point of the column: for anybody who accrued in more than one month it
     must be SMALLER than the year total. */
  SELECT count(*) INTO v_bad
    FROM public.v_leave_balance_current
   WHERE accrued_this_month_days > accrued_days;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% row(s) claim more accrued this month than all year', v_bad;
  END IF;
  RAISE NOTICE 'accrued_this_month_days never exceeds the year-to-date total';
END $verify$;

COMMIT;
