-- =============================================================================
-- 085 · One implementation of "which day does a scan right now belong to"
--
-- REPORTED BUG: at 00:37 the punch card offered "Punch out" on a day the employee had
-- not punched into. Two causes, one of them here.
--
-- The client was deciding the current business date for itself by looking at the LATEST
-- punch it could see, across a two-day window. Just after midnight the latest punch is
-- last night's, so the card adopted YESTERDAY as the current day, counted yesterday's
-- scans, and offered the next direction in yesterday's sequence.
--
-- "Use today" is the obvious fix and it is wrong here. `set_punch_business_date` already
-- back-dates an early-morning scan to the previous day when that day's shift crosses
-- midnight — and this venue really has such shifts (EVT 16:00–01:30, SEC-N 19:00–07:00,
-- with an employee on SEC-N by default). For that person a 00:37 scan genuinely belongs
-- to yesterday, and "always today" would tell a security guard mid-shift that they are
-- about to punch IN.
--
-- So the rule is neither "the latest punch's day" nor "today" — it is exactly what the
-- INSERT trigger will decide. Rather than write that rule a second time in TypeScript,
-- where it would drift the first time a cutover changed, it moves into one function that
-- the trigger now calls and the client can ask. The client's label and the stored
-- `business_date` cannot disagree, because there is only one rule left.
-- =============================================================================

SELECT set_config('app.reason', 'migration 085: single source of truth for punch business date', true);

-- -----------------------------------------------------------------------------
-- 1. The rule, once
-- -----------------------------------------------------------------------------

/*
  Lifted verbatim out of `set_punch_business_date` (migration 20260801001600 §6.4) — the
  behaviour is deliberately unchanged, only its location.

  STABLE, not IMMUTABLE: it reads shift assignments, and it defaults to `now()`.

  SECURITY DEFINER because `resolve_shift_for_date` walks `shift_assignments` and `shifts`,
  which an employee cannot read for a colleague. The visibility check below is what keeps
  that from becoming a way to probe other people's rosters.
*/
CREATE OR REPLACE FUNCTION public.punch_business_date(
  p_employee_id uuid,
  p_at          timestamptz DEFAULT now()
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ist_date   date := util.ist_date(p_at);
  v_ist_time   time := util.ist_time(p_at);
  v_prev_shift uuid;
  v_crosses    boolean;
  v_cutover    time;
BEGIN
  IF p_employee_id IS NULL THEN
    RETURN v_ist_date;
  END IF;

  /*
    Yesterday's shift, not today's: the question is whether a scan this early is the tail
    of a shift that started before midnight. Today's shift says nothing about that.
  */
  v_prev_shift := public.resolve_shift_for_date(p_employee_id, v_ist_date - 1);
  IF v_prev_shift IS NOT NULL THEN
    SELECT s.crosses_midnight, s.day_cutover_time
      INTO v_crosses, v_cutover
      FROM public.shifts s
     WHERE s.id = v_prev_shift;

    /*
      The cutover, NOT the shift's end time. SEC-N runs to 07:00 but cuts over at 05:00,
      so its 06:00 out-scan is filed under the new day. That is the deployed configuration
      and this function reports it faithfully rather than improving on it — if it should
      change, `shifts.day_cutover_time` is the one place to change it, and both the
      trigger and the card follow.
    */
    IF COALESCE(v_crosses, false) AND v_ist_time < COALESCE(v_cutover, TIME '05:00') THEN
      RETURN v_ist_date - 1;
    END IF;
  END IF;

  RETURN v_ist_date;
END;
$$;

COMMENT ON FUNCTION public.punch_business_date(uuid, timestamptz) IS
  'The business date a scan at p_at belongs to for this employee: the IST date, or the previous one when the previous day''s shift crosses midnight and the time is before its cutover. The single implementation of that rule — set_punch_business_date calls it on INSERT and the self-punch card asks it which day to count.';

-- -----------------------------------------------------------------------------
-- 2. The trigger becomes a caller
-- -----------------------------------------------------------------------------

/*
  An explicit `business_date` still wins — regularisation and import set it deliberately
  and must not be recomputed.
*/
CREATE OR REPLACE FUNCTION public.set_punch_business_date()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.business_date IS NOT NULL THEN
    RETURN NEW;  -- explicitly attributed (regularization/import) — respect it
  END IF;
  NEW.business_date := public.punch_business_date(NEW.employee_id, NEW.punched_at);
  RETURN NEW;
END;
$$;

/*
  NOTE ON WHAT THIS CHANGES IN STORED DATA: nothing for a day shift, but the trigger now
  writes `business_date` explicitly on EVERY insert, where before it left the column NULL
  unless the night rule applied. `effective_date` is
  `COALESCE(business_date, util.ist_date(punched_at))`, so the stored effective date is
  identical either way — the column simply stops being NULL. Any code that reads
  `business_date` to mean "was deliberately attributed" would be misled, so it was
  checked: only `set_punch_business_date` itself tested it for NULL.
*/

-- -----------------------------------------------------------------------------
-- 3. A safe wrapper for the browser
-- -----------------------------------------------------------------------------

/*
  The definer function above must not be callable for an arbitrary employee id — it would
  answer "does this person work nights", which is roster information. This wrapper is what
  `authenticated` gets, and it refuses for anybody the caller cannot already see.

  Defaulting to the caller's own employee id makes the common call argument-free.
*/
CREATE OR REPLACE FUNCTION public.my_punch_business_date(
  p_employee_id uuid DEFAULT NULL
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid := COALESCE(p_employee_id, app.current_employee_id());
BEGIN
  IF v_id IS NULL THEN
    RETURN util.ist_date(now());   -- no employee row (kiosk-only login): plain IST date
  END IF;
  IF NOT app.can_see_employee(v_id) THEN
    RAISE EXCEPTION 'Not permitted to read that employee' USING ERRCODE = '42501';
  END IF;
  RETURN public.punch_business_date(v_id, now());
END;
$$;

COMMENT ON FUNCTION public.my_punch_business_date(uuid) IS
  'Which business date a scan made right now would be filed under. Defaults to the caller''s own employee; any other id requires app.can_see_employee. The self-punch card uses it so its label always agrees with what the INSERT trigger will store.';

REVOKE ALL ON FUNCTION public.punch_business_date(uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.my_punch_business_date(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.my_punch_business_date(uuid) TO authenticated;
