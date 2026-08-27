-- =============================================================================
-- 20260827170000 — maternity leave appears for every employee
-- =============================================================================
--
-- ASKED FOR:
--
--   "at leave apply part add Maternity leave"
--
-- ── WHY IT WAS MISSING, WHICH WAS NOT A BUG ─────────────────────────────────
--
-- `leave_types.gender_restriction` for ML is seeded `'female'` (004300, whose own
-- comment cites the Maternity Benefit Act — 182 days, maximum 2 in service). Two
-- things read it:
--
--   * `isEligibleLeaveType` in the browser, which is why the apply form did not
--     list Maternity on a male employee's account;
--   * `leave_requests_submit_guard` (001900 line 881), which refuses the request
--     outright: "leave type ML is restricted to female employees".
--
-- The two agreed, which is the only reason this was not the punch-tick-box problem
-- again — a form offering something the server would refuse. Maternity was already
-- appearing for female employees.
--
-- ── WHAT CHANGES, AND WHAT IT MEANS ─────────────────────────────────────────
--
-- Confirmed decision: offer it to everyone. `gender_restriction` becomes NULL, so
-- the form lists Maternity for every employee AND the submit guard accepts a
-- request from any of them. Both halves move together — clearing it in one place
-- only would have produced exactly the divergence described above.
--
-- This is a POLICY change, not a display fix, and it is worth being blunt about:
-- a male employee can now be granted maternity leave. Some employers do this
-- deliberately, to cover adoption and surrogacy without maintaining a separate
-- type. If that is not the intent:
--
--     UPDATE public.leave_types SET gender_restriction = 'female' WHERE code = 'ML';
--
-- ── PATERNITY IS DELIBERATELY NOT TOUCHED ───────────────────────────────────
--
-- Because it needs nothing: PL is seeded with `gender_restriction = NULL` and has
-- always been offered to everybody. Checking that before "making them consistent"
-- is the discipline missing from 20260827100000, which removed five types nobody
-- had asked about, and from 20260827140000, which then restored one nobody had
-- asked for either. The instruction named maternity; only maternity changes.
--
-- The 182-day quota, the two-in-service cap and the accrual settings are all left
-- as they are. Nothing here grants anybody a day.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 170000: maternity leave is offered to every employee — gender_restriction cleared so the apply form lists it and the submit guard accepts it, both together', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.leave_types
   SET gender_restriction = NULL
 WHERE code = 'ML'
   AND deleted_at IS NULL
   AND gender_restriction IS NOT NULL;

DO $verify$
DECLARE
  v_ml      record;
  v_visible int;
  v_total   int;
BEGIN
  SELECT code, name, is_active, gender_restriction, annual_quota_days, max_times_in_service
    INTO v_ml
    FROM public.leave_types WHERE code = 'ML' AND deleted_at IS NULL;

  IF v_ml IS NULL THEN
    RAISE EXCEPTION 'there is no maternity leave type to open up';
  END IF;
  IF v_ml.gender_restriction IS NOT NULL THEN
    RAISE EXCEPTION 'maternity leave is still restricted to %', v_ml.gender_restriction;
  END IF;
  IF NOT v_ml.is_active THEN
    RAISE EXCEPTION 'maternity leave is unrestricted but not offered, so it still will not appear';
  END IF;

  SELECT count(*) INTO v_total FROM public.employees
   WHERE deleted_at IS NULL AND employment_status <> 'exited';

  /* What the apply form will now list it for — the whole point of the change. */
  SELECT count(*) INTO v_visible FROM public.employees e
   WHERE e.deleted_at IS NULL AND e.employment_status <> 'exited';

  RAISE NOTICE 'maternity leave: offered=% restriction=% quota=% max_in_service=%',
    v_ml.is_active, COALESCE(v_ml.gender_restriction::text, 'none'),
    v_ml.annual_quota_days, v_ml.max_times_in_service;
  RAISE NOTICE 'it now appears for % of % employed staff', v_visible, v_total;
END $verify$;

COMMIT;
