-- =============================================================================
-- 20260827180000 — thirty is a year-end ceiling, not a daily one
-- =============================================================================
--
-- CORRECTED, after 20260827130000 read the earlier instruction too broadly:
--
--   "if earned leave is more than 30 then reset it to 30 at the end of year only"
--
-- 130000 was built from "maximum earn leave is 30.. so if anytime it is above 30
-- reset it to 30", and it took "anytime" literally: a trigger on `leave_ledger`
-- that lapsed the excess the instant any credit crossed the line. That is the
-- opposite of what the venue wants. It means somebody who accrues to 30 in
-- December earns nothing at all from January to March — every monthly accrual
-- arrives and is immediately taken away — and a manager crediting five days to
-- somebody at 28 sees three of them vanish on the spot.
--
-- ── WHAT A YEAR-END CEILING ACTUALLY IS ─────────────────────────────────────
--
-- The balance is allowed to grow past 30 DURING the leave year. At the year end
-- (31 March, April basis), at most 30 days carry into the next year and the rest
-- lapses. That is what `max_carry_forward_days` means and it is already set to 30;
-- `rollover_leave_year` reads it, and the scheduled job applies it every 1 April.
-- Nothing needs adding for the rule to work — only the daily enforcement removed.
--
-- ── THREE THINGS ENFORCED THE CEILING; TWO MUST GO ──────────────────────────
--
--   1. `trg_leave_ledger__then_cap`     (130000)  every credit      → DROPPED
--   2. `leave_types.max_balance_days`   (100000)  monthly accrual   → CLEARED
--   3. `leave_types.max_carry_forward_days`       the year end      → KEPT at 30
--
-- The second is easy to miss and would have left the rule half-reverted: it is not
-- read by the trigger at all but by `accrue_leave` (001900 line 1321), which sums
-- the ledger after crediting and lapses anything above the ceiling. Dropping the
-- trigger alone would have moved the cap from "every credit" to "every month end",
-- which is still not "at the end of year only".
--
-- ── THE 183 DAYS ARE GIVEN BACK ─────────────────────────────────────────────
--
-- 130000 did not only arm a rule, it applied one: 47 employees were trimmed to 30
-- and 183 days were lapsed with `source_table = 'balance_cap'`. Under the rule as
-- now stated those days were taken about seven months early. So every one of those
-- lapses is REVERSED — not deleted. `leave_ledger` is append-only and allows
-- exactly one update, `reversed_by_id`, which is the mechanism the schema provides
-- for precisely this: a credit is written pointing back at the lapse through
-- `reverses_id`, and the lapse is stamped with the id of the row that undid it.
-- Both remain readable, and an employee's statement shows the days going and
-- coming back rather than a balance that silently changed twice.
--
-- IF THE TRIM WAS WANTED AFTER ALL, this is how to take those days again:
--
--     UPDATE public.leave_types SET max_balance_days = 30 WHERE code = 'EL';
--     -- then re-apply 20260827130000's catch-up block.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 180000: the 30-day earned-leave ceiling binds at the year end only — the daily trigger and the monthly accrual cap are removed, and the 183 days they already took are given back', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The daily enforcement goes
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_leave_ledger__then_cap ON public.leave_ledger;
DROP FUNCTION IF EXISTS public.leave_ledger_enforce_balance_cap();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The monthly enforcement goes too
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `max_balance_days` is the in-year ceiling `accrue_leave` respects. NULL means the
-- balance may grow all year, which is the point.

UPDATE public.leave_types
   SET max_balance_days = NULL
 WHERE code = 'EL'
   AND deleted_at IS NULL
   AND max_balance_days IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The year-end ceiling stays, and is asserted rather than assumed
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.leave_types
   SET carry_forward_allowed  = true,
       max_carry_forward_days = 30
 WHERE code = 'EL'
   AND deleted_at IS NULL
   AND (NOT carry_forward_allowed OR max_carry_forward_days IS DISTINCT FROM 30);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Give back what the daily ceiling took
-- ─────────────────────────────────────────────────────────────────────────────

DO $give_back$
DECLARE
  r        record;
  v_new    uuid;
  v_rows   int := 0;
  v_days   numeric := 0;
BEGIN
  FOR r IN
    SELECT ll.id, ll.employee_id, ll.leave_type_id, ll.leave_year, ll.days, ll.effective_date
      FROM public.leave_ledger ll
     WHERE ll.entry_type    = 'lapse'
       AND ll.source_table  = 'balance_cap'
       AND ll.reversed_by_id IS NULL
     ORDER BY ll.recorded_at
  LOOP
    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, reverses_id, reason)
    VALUES
      (r.employee_id, r.leave_type_id, r.leave_year, 'credit_adjustment', -r.days,
       r.effective_date,
       'Reversal of a daily balance cap that no longer applies',
       'balance_cap_reversal', r.id,
       'The 30-day ceiling now binds at the year end only, so days taken by the daily cap are returned')
    RETURNING id INTO v_new;

    /* The one update `leave_ledger` permits. Both rows stay legible: the lapse
       says what was taken, the credit says why it came back. */
    UPDATE public.leave_ledger SET reversed_by_id = v_new WHERE id = r.id;

    PERFORM public.recompute_leave_balance(r.employee_id, r.leave_type_id, r.leave_year);
    v_rows := v_rows + 1;
    v_days := v_days + (-r.days);
  END LOOP;

  RAISE NOTICE 'returned % day(s) to % employee(s)', v_days, v_rows;
END $give_back$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Refuse to report success while anything still caps daily
-- ─────────────────────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_trigger int;
  v_inyear  int;
  v_left    int;
  v_el      record;
BEGIN
  SELECT count(*) INTO v_trigger FROM pg_trigger
   WHERE tgname = 'trg_leave_ledger__then_cap' AND NOT tgisinternal;
  IF v_trigger > 0 THEN
    RAISE EXCEPTION 'the daily cap trigger is still attached';
  END IF;

  SELECT count(*) INTO v_inyear FROM public.leave_types
   WHERE code = 'EL' AND deleted_at IS NULL AND max_balance_days IS NOT NULL;
  IF v_inyear > 0 THEN
    RAISE EXCEPTION 'earned leave still carries an in-year ceiling, so the accrual will keep trimming it';
  END IF;

  SELECT count(*) INTO v_left FROM public.leave_ledger
   WHERE entry_type = 'lapse' AND source_table = 'balance_cap' AND reversed_by_id IS NULL;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% daily-cap lapse(s) were not reversed', v_left;
  END IF;

  SELECT carry_forward_allowed, max_carry_forward_days, max_balance_days INTO v_el
    FROM public.leave_types WHERE code = 'EL' AND deleted_at IS NULL;

  RAISE NOTICE 'earned leave: in-year ceiling=% year-end carry=% (carry_forward=%)',
    COALESCE(v_el.max_balance_days::text, 'none'),
    v_el.max_carry_forward_days, v_el.carry_forward_allowed;
END $verify$;

COMMIT;
