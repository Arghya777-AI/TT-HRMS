-- =============================================================================
-- 20260827130000 — thirty is the ceiling at every moment, not once a month
-- =============================================================================
--
-- ASKED FOR, after seeing the numbers:
--
--   "maximum earn leave is 30.. so if anytime it is above 30 reset it to 30 and
--    keep everything automatic so admin don't have to click anywhere to make
--    changes because they may forget"
--
-- ── WHAT WAS ALREADY TRUE, AND WHY IT WAS NOT ENOUGH ────────────────────────
--
-- 20260827100000 set `leave_types.max_balance_days = 30` for earned leave, and
-- `accrue_leave` (001900 line 1321) honours it — it sums the ledger after
-- crediting and lapses anything above the ceiling. So the cap was real.
--
-- It was real ONCE A MONTH. The accrual runs at 17:30 on the last day of the
-- month, and that is the only moment anything looked at the ceiling. Every other
-- way a balance grows was unbounded in between:
--
--   * an administrator crediting days through `adjust_leave_balance`
--     (`credit_adjustment`) — the exact button added today;
--   * an opening balance being granted (`opening_balance`);
--   * a cancelled or rejected leave request giving days back
--     (`availed_reversal`);
--   * a year-end carry arriving (`carry_forward_in`);
--   * comp-off being credited (`comp_off_credit`).
--
-- A balance could sit at 38 for four weeks and nobody would be told. "If ANYTIME
-- it is above 30" is a different rule from "at month end", and this is the one
-- that was asked for.
--
-- ── WHERE THE RULE GOES, AND WHY NOT ON THE BALANCE ─────────────────────────
--
-- Not on `leave_balances`. `available_days` is a GENERATED column over the
-- component columns, and the whole table is DERIVED — `recompute_leave_balance`
-- rebuilds it from `leave_ledger` whenever anything changes. A trigger that
-- patched the balance would be overwritten by the next recompute, silently, and
-- the ledger and the balance would then disagree about how many days somebody has.
-- The probe for the rollover caught precisely this shape of mistake.
--
-- So the rule goes on `leave_ledger`, which is the source of truth, and it
-- expresses the cap the only way the ledger can: by APPENDING a `lapse` for the
-- excess. The balance then follows from arithmetic, as it always did.
--
-- ── WHY IT CANNOT LOOP ──────────────────────────────────────────────────────
--
-- The trigger's own correction is an INSERT into the table it fires on. It
-- terminates because it only ever looks at rows that ADD days:
-- `new_rows WHERE days > 0`. The lapse it writes is negative, so the recursive
-- firing sees an empty set and does nothing — one extra level, then stop. Relying
-- on the arithmetic converging (excess reaches zero) would also terminate, but a
-- filter that cannot recurse is better than a loop that happens not to.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- It does not refuse the credit. An administrator granting five days to somebody
-- already at 28 gets the grant recorded in full and a two-day lapse recorded
-- beside it, rather than an error. Both facts are true and both belong in the
-- ledger: they asked for five, the ceiling took two. Refusing would have thrown
-- away the record of what was intended.
--
-- It reads the ceiling from `leave_types.max_balance_days` and never writes it.
-- Types with no ceiling (sick leave has none) are untouched, so this is one rule
-- serving whatever the masters say — 30 today, 45 if the venue decides so, with no
-- change here.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 130000: the earned-leave ceiling of 30 days now binds the moment a balance crosses it, not only at the monthly accrual — a credit, an opening balance, a reversal or a carry could each leave a balance above the cap for weeks', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The standing rule
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.leave_ledger_enforce_balance_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r       record;
  v_sum   numeric(12,3);
  v_excess numeric(12,3);
BEGIN
  /*
    ONLY THE ROWS THAT ADD DAYS. This is both the correctness filter and the
    recursion guard: the `lapse` written below is negative, so it cannot bring us
    back here. See the header.
  */
  FOR r IN
    SELECT DISTINCT nr.employee_id, nr.leave_type_id, nr.leave_year,
                    lt.max_balance_days AS cap, lt.name AS type_name
      FROM new_rows nr
      JOIN public.leave_types lt ON lt.id = nr.leave_type_id
     WHERE nr.days > 0
       AND lt.max_balance_days IS NOT NULL
  LOOP
    /* Summed from the LEDGER, not read from `leave_balances`: the balance row may
       not have been recomputed yet this statement, and the ledger is what the
       recompute itself reads. */
    SELECT COALESCE(SUM(ll.days), 0) INTO v_sum
      FROM public.leave_ledger ll
     WHERE ll.employee_id   = r.employee_id
       AND ll.leave_type_id = r.leave_type_id
       AND ll.leave_year    = r.leave_year;

    v_excess := v_sum - r.cap;
    CONTINUE WHEN v_excess <= 0;

    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, recorded_by)
    VALUES
      (r.employee_id, r.leave_type_id, r.leave_year, 'lapse', -v_excess,
       util.ist_date(now()),
       format('Balance capped at %s days', trim_scale(r.cap)),
       'balance_cap', app.ctx_actor_id());
  END LOOP;

  RETURN NULL;
END;
$$;

/*
  NAMED TO SORT AFTER `trg_leave_ledger__recompute`, which is not required for
  correctness — this sums the ledger, not the balance — but keeps the order a
  reader would expect: credit lands, balance is rebuilt, ceiling is applied,
  balance is rebuilt again.
*/
DROP TRIGGER IF EXISTS trg_leave_ledger__then_cap ON public.leave_ledger;
CREATE TRIGGER trg_leave_ledger__then_cap
  AFTER INSERT ON public.leave_ledger
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.leave_ledger_enforce_balance_cap();

COMMENT ON FUNCTION public.leave_ledger_enforce_balance_cap() IS
  'Keeps every balance at or below its type''s max_balance_days at all times, by appending a lapse for the excess whenever a credit takes it over. Reads the ceiling from leave_types; types with no ceiling are untouched. Cannot recurse: it only inspects inserted rows with days > 0, and its own correction is negative.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Bring today's balances under the ceiling, once
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The trigger only sees FUTURE credits. Every earned-leave balance in the venue is
-- already above 30 — 47 of 47, holding 1,593 days between them, of which 183 are
-- above the ceiling. Waiting for the 31 August accrual to trim them would mean the
-- rule the venue just stated is untrue for four more days, and would hide the
-- correction inside a routine job. Done here, deliberately, where it is recorded.

DO $catch_up$
DECLARE
  r        record;
  v_before int := 0;
  v_days   numeric(12,3) := 0;
BEGIN
  FOR r IN
    SELECT lb.employee_id, lb.leave_type_id, lb.leave_year,
           lb.available_days - lt.max_balance_days AS excess,
           lt.max_balance_days AS cap
      FROM public.leave_balances lb
      JOIN public.leave_types lt ON lt.id = lb.leave_type_id
      JOIN public.employees e    ON e.id  = lb.employee_id
     WHERE lt.max_balance_days IS NOT NULL
       AND lb.available_days > lt.max_balance_days
       AND e.deleted_at IS NULL
       AND e.employment_status <> 'exited'
  LOOP
    v_before := v_before + 1;
    v_days   := v_days + r.excess;

    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, recorded_by)
    VALUES
      (r.employee_id, r.leave_type_id, r.leave_year, 'lapse', -r.excess,
       util.ist_date(now()),
       format('Balance capped at %s days', trim_scale(r.cap)),
       'balance_cap', app.ctx_actor_id());
  END LOOP;

  RAISE NOTICE 'brought % balance(s) under the ceiling, lapsing % day(s)', v_before, v_days;
END $catch_up$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Refuse to report success while anything is still over
-- ─────────────────────────────────────────────────────────────────────────────

DO $verify$
DECLARE v_over int; v_worst numeric;
BEGIN
  SELECT count(*), COALESCE(max(lb.available_days - lt.max_balance_days), 0)
    INTO v_over, v_worst
    FROM public.leave_balances lb
    JOIN public.leave_types lt ON lt.id = lb.leave_type_id
    JOIN public.employees e    ON e.id  = lb.employee_id
   WHERE lt.max_balance_days IS NOT NULL
     AND lb.available_days > lt.max_balance_days
     AND e.deleted_at IS NULL
     AND e.employment_status <> 'exited';

  IF v_over > 0 THEN
    RAISE EXCEPTION
      '% balance(s) are still above their ceiling, the worst by % days — the cap did not hold',
      v_over, v_worst;
  END IF;

  RAISE NOTICE 'every balance is at or below its ceiling';
END $verify$;

COMMIT;
