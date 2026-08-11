-- =============================================================================
-- 20260801041700 — an opening balance an administrator can set, and Earned
--                  Leave starting at 32.5 days
-- =============================================================================
--
-- ASKED FOR: "earn leave should be available at initially that should be 32.5
-- (make editable for admin)".
--
-- ── WHY THIS IS NOT A NUMBER TYPED INTO A SEED ───────────────────────────────
--
-- 32.5 could have been one UPDATE against `leave_ledger` and this file would be
-- ten lines long. It would also be a number nobody could change afterwards
-- without another migration, which is the half of the request that matters:
-- "make editable for admin". So the number lives on the leave TYPE, beside every
-- other rule an administrator already edits on the Leave Type Master, and the
-- ledger is filled from it.
--
-- ── THE LEDGER IS APPEND-ONLY, SO "EDITABLE" MEANS TRUE-UP, NOT OVERWRITE ────
--
-- `leave_ledger` refuses UPDATE and DELETE outright
-- (`leave_ledger_guard_mutation`), and rightly: a balance that can be rewritten
-- is a balance nobody can audit. So when the number changes from 32.5 to 40,
-- nothing is edited — a `credit_adjustment` of 7.5 is APPENDED, with a reason
-- naming the change. `recompute_leave_balance` folds opening + accrued +
-- adjusted into `entitlement_days`, so the employee sees 40 and the ledger still
-- shows how it got there.
--
-- The same mechanism handles the first grant: no opening row yet means insert
-- one. This is why the function is called grant_opening_balances and not
-- set_opening_balance — it makes the world match the rule, whatever state the
-- world is in, and it can be run twice with no effect the second time.
--
-- ── WHO GETS IT ─────────────────────────────────────────────────────────────
--
-- The same employees `accrue_leave` credits: active, on probation, confirmed, on
-- notice, on long leave, with a real join date that is not in the future. An
-- opening balance for somebody who has not started is a balance they can spend
-- before their first day.
--
-- ── WHY EARNED LEAVE CAN HOLD 32.5 ──────────────────────────────────────────
--
-- `max_balance_days` is NULL for EL (004300 seeds no ceiling), so `accrue_leave`
-- writes no `lapse` row against it. Had a ceiling been set below 32.5, the next
-- monthly run would have quietly lapsed the difference — which is the failure
-- this note exists to rule out, not to describe.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 041700: leave_types.opening_balance_days, Earned Leave opening balance of 32.5 days, and the true-up that keeps the ledger matching it', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The rule, on the type
-- -----------------------------------------------------------------------------

ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS opening_balance_days numeric(6,2) NULL;

/*
  Half days only. The whole leave engine works in 0.5 steps — `ck_lrd__day_value`
  admits 0, 0.5 and 1, and `adjust_leave_balance` refuses anything else — so a
  32.3 typed here would be a balance no request could ever spend exactly.
*/
DO $$ BEGIN
  ALTER TABLE public.leave_types
    ADD CONSTRAINT ck_lt__opening_balance_days CHECK (
      opening_balance_days IS NULL
      OR (opening_balance_days >= 0
          AND (opening_balance_days * 2) = floor(opening_balance_days * 2)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.leave_types.opening_balance_days IS
  'What an employee starts the leave year with for this type, filed as an opening_balance ledger entry by grant_opening_balances(). NULL means no opening balance. Editing it appends an adjustment rather than rewriting history — see migration 041700.';

UPDATE public.leave_types
   SET opening_balance_days = 32.5
 WHERE code = 'EL'
   AND deleted_at IS NULL
   AND opening_balance_days IS DISTINCT FROM 32.5;

-- -----------------------------------------------------------------------------
-- 2. The true-up
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER because `leave_ledger` has no INSERT policy for anybody: rows
-- arrive only through definer functions and service-role jobs (019 §"P5 read; no
-- client insert/update/delete policy at all"). That is the same door
-- `accrue_leave` and `adjust_leave_balance` come through.
--
-- Returns the number of ledger rows written, so a caller can tell "already
-- correct" from "granted to 81 people" — the two look identical from outside.

CREATE OR REPLACE FUNCTION public.grant_opening_balances(
  p_leave_type_id uuid    DEFAULT NULL,
  p_leave_year    integer DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year    integer := COALESCE(p_leave_year, public.leave_year_of(util.ist_today()));
  v_today   date    := util.ist_today();
  lt        record;
  e         record;
  v_target  numeric;
  v_have    numeric;
  v_delta   numeric;
  v_written integer := 0;
BEGIN
  FOR lt IN
    SELECT id, code, name, opening_balance_days
      FROM public.leave_types
     WHERE deleted_at IS NULL
       AND is_active
       AND opening_balance_days IS NOT NULL
       AND (p_leave_type_id IS NULL OR id = p_leave_type_id)
  LOOP
    v_target := lt.opening_balance_days;

    FOR e IN
      SELECT id
        FROM public.employees
       WHERE deleted_at IS NULL
         AND employment_status IN
             ('active','on_probation','confirmed','on_notice','on_long_leave')
         AND date_of_join IS NOT NULL
         AND date_of_join <= v_today
    LOOP
      -- What the ledger already says the opening balance is, INCLUDING any
      -- earlier true-up. Reading only `opening_balance` would re-apply the whole
      -- difference every time the number changed.
      SELECT COALESCE(SUM(ll.days), 0)
        INTO v_have
        FROM public.leave_ledger ll
       WHERE ll.employee_id   = e.id
         AND ll.leave_type_id = lt.id
         AND ll.leave_year    = v_year
         AND ll.entry_type IN ('opening_balance','credit_adjustment','debit_adjustment')
         AND ll.reversed_by_id IS NULL;

      v_delta := v_target - v_have;
      CONTINUE WHEN v_delta = 0;

      IF v_have = 0 AND NOT EXISTS (
           SELECT 1 FROM public.leave_ledger ll2
            WHERE ll2.employee_id   = e.id
              AND ll2.leave_type_id = lt.id
              AND ll2.leave_year    = v_year
              AND ll2.entry_type    = 'opening_balance')
      THEN
        -- First grant. Dated the start of the leave year, not today: it is the
        -- balance they STARTED with, and a statement that shows it arriving in
        -- August reads as a windfall rather than an opening position.
        -- `description` states the CATEGORY and is NOT NULL (019 §5); `reason`
        -- carries the sentence. Same split 039300 uses.
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days,
           effective_date, description, source_table, reason)
        VALUES
          (e.id, lt.id, v_year, 'opening_balance', v_target,
           make_date(v_year, 4, 1), 'Opening balance set by policy', 'leave_types',
           'Opening balance for ' || lt.name || ' set by policy (' ||
             trim(to_char(v_target, 'FM999999.99')) || ' days)');
      ELSE
        -- The number changed. Append the difference; never touch the original.
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days,
           effective_date, description, source_table, reason)
        VALUES
          (e.id, lt.id, v_year,
           /*
             THE CAST IS LOAD-BEARING. A bare literal like 'opening_balance' is
             `unknown` and Postgres coerces it to the enum happily; a CASE over
             two string literals resolves to TEXT, and `entry_type` is
             `ledger_entry_type` — so without this the adjustment branch raises
             42804 "column entry_type is of type ledger_entry_type but expression
             is of type text". The first-grant branch above works and this one
             would not have, which is why it took a probe that actually edited
             the number to find it.
           */
           (CASE WHEN v_delta > 0 THEN 'credit_adjustment' ELSE 'debit_adjustment' END)
             ::public.ledger_entry_type,
           v_delta, v_today, 'Opening balance changed by policy', 'leave_types',
           'Opening balance for ' || lt.name || ' changed to ' ||
             trim(to_char(v_target, 'FM999999.99')) || ' days by policy');
      END IF;

      v_written := v_written + 1;
      PERFORM public.recompute_leave_balance(e.id, lt.id, v_year);
    END LOOP;
  END LOOP;

  RETURN v_written;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.grant_opening_balances(uuid, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.grant_opening_balances(uuid, integer) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.grant_opening_balances(uuid, integer) IS
  'Make the ledger match leave_types.opening_balance_days for every eligible employee: insert the opening_balance entry, or append an adjustment for the difference when the policy number has changed. Idempotent — running it twice writes nothing the second time.';

-- -----------------------------------------------------------------------------
-- 3. Editing the number is what applies it
-- -----------------------------------------------------------------------------
--
-- Without this, "editable by admin" would mean an admin can change a number that
-- does nothing until somebody with database access remembers to run a function.
-- The trigger is what makes the Leave Type Master field real.
--
-- Bounded by design: one type, and only the employees who accrue — on this
-- deployment about eighty rows. It fires only when the NUMBER changes, not on
-- every edit to the type, so renaming Earned Leave does not rewrite anyone's
-- ledger.
--
-- AFTER, and returning NULL: the row is already committed, and the ledger writes
-- must not be able to fail the administrator's edit — if one does, the whole
-- statement rolls back and the admin is told, which is the correct outcome for a
-- change that could not be applied.

CREATE OR REPLACE FUNCTION public.leave_types_apply_opening_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.opening_balance_days IS NOT NULL THEN
    PERFORM public.grant_opening_balances(NEW.id, NULL);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_types__opening_balance ON public.leave_types;
CREATE TRIGGER trg_leave_types__opening_balance
  AFTER UPDATE OF opening_balance_days ON public.leave_types
  FOR EACH ROW
  WHEN (NEW.opening_balance_days IS DISTINCT FROM OLD.opening_balance_days)
  EXECUTE FUNCTION public.leave_types_apply_opening_balance();

-- -----------------------------------------------------------------------------
-- 4. Grant it now
-- -----------------------------------------------------------------------------
--
-- The UPDATE in §1 ran BEFORE the trigger in §3 existed, which is deliberate:
-- creating a trigger and then relying on a statement that already ran is how a
-- migration ends up doing nothing on a re-run. This call is the explicit half.

SELECT public.grant_opening_balances();

COMMIT;
