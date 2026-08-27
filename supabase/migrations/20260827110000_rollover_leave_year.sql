-- =============================================================================
-- 20260827110000 — the year end actually happens
-- =============================================================================
--
-- `/admin/leave/rollover` has shipped since it was built as a REVIEW screen with
-- a stated reason, quoted from its own header:
--
--   "migration 019 ships accrue_leave, expire_comp_off, recompute_leave_balance,
--    consume_comp_off, calc_leave_days and rebuild_leave_request_days — there is
--    no `rollover_leave_year`, and no edge function stands in for one"
--
-- Correct on every count. This is that function, named as the screen named it.
--
-- ── WHAT THE YEAR END MEANS HERE ────────────────────────────────────────────
--
-- The leave year is APRIL TO MARCH: `leave_year_of` (001900 line 42) returns the
-- calendar year for April onwards and the previous year before it, so FY 2026
-- runs 01-Apr-2026 to 31-Mar-2027 and the year end is 31 MARCH, not 31 December.
--
-- That matters for "reset sick leave to 0 at the end of year". Zeroing sick leave
-- on 31 December would zero it in the MIDDLE of leave year 2026 — the balance row
-- is keyed by `leave_year`, the next monthly accrual would credit the same year
-- again, and the ledger would show a lapse with a year still running around it.
-- 31 March is the only reading the schema can express coherently, so that is what
-- this does. If the venue means the calendar year, the leave year itself is what
-- needs changing, and that is a bigger conversation than a reset date.
--
-- ── WHAT IT DOES, PER EMPLOYEE, PER TYPE ────────────────────────────────────
--
-- Reads the closing `available_days` for the year being closed and writes, into
-- the append-only ledger:
--
--   carry_forward_out  (negative, closing year)  the amount that moves
--   carry_forward_in   (positive, opening year)  the same amount, arriving
--   lapse              (negative, closing year)  everything above the cap
--
-- so the closing year lands at exactly zero and the opening year starts at the
-- carried figure. For EARNED LEAVE with `max_carry_forward_days = 30` that is the
-- requested "above 30 → 30". For SICK LEAVE with `carry_forward_allowed = false`
-- the carry is zero and the whole balance lapses — the requested reset.
--
-- The rule is READ FROM `leave_types`, never written here. 20260827100000 sets the
-- numbers; this reads whatever they are. A venue that later decides 45 days
-- changes one column and does not touch this function.
--
-- ── WHY IT IS SQL AND NOT AN EDGE FUNCTION ──────────────────────────────────
--
-- Every reason the screen gave for the absence is a reason to do it in Postgres:
-- `leave_ledger` grants INSERT to `service_role` only and
-- `leave_ledger_guard_mutation()` refuses client mutation, so the writer must be
-- inside the database anyway. A definer function is the smallest thing that can
-- write those rows, and it can run in one transaction — which a per-employee HTTP
-- loop could not, and a half-finished year end is the worst possible state for a
-- leave balance to be in.
--
-- ── DRY RUN IS THE DEFAULT, AND IT IS A REAL DRY RUN ────────────────────────
--
-- `p_dry_run` defaults TRUE. A dry run writes no ledger rows and no balances; it
-- writes only the `leave_year_rollovers` record with `dry_run = true`, which is
-- exactly what the screen's history panel already renders. The numbers in that
-- record come from the same query the committing branch uses, so the preview and
-- the commit cannot disagree — which is the thing the screen's author refused to
-- guess at in a browser, and was right to refuse.
--
-- ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
--
--  * a non-administrator;
--  * a reason shorter than fifteen characters, which is the bar the manual
--    adjustment screen already sets for touching one person's balance — a year end
--    touches everybody's;
--  * closing a year that has not ended yet, unless dry run. Carrying a balance
--    forward in November means the remaining months accrue into a year that has
--    already been closed, and the second run would carry the balance twice;
--  * running twice for real. The second run would carry an already-carried
--    balance, and there is no way to tell that from a legitimate correction, so
--    it is refused by looking for a committed run over the same year and type.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 110000: rollover_leave_year — the year-end carry, cap and lapse the rollover screen has been describing without being able to perform', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.rollover_leave_year(
  p_from_leave_year integer,
  p_reason          text,
  p_dry_run         boolean DEFAULT true,
  p_leave_type_id   uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor        uuid := app.ctx_actor_id();
  v_to_year      integer := p_from_leave_year + 1;
  v_year_end     date;
  v_year_start   date;
  v_today        date := util.ist_date(now());
  v_type         record;
  v_row          record;
  v_run_id       uuid;
  v_company      uuid;
  v_processed    int;
  v_carried      numeric(12,3);
  v_lapsed       numeric(12,3);
  v_negative     int;
  v_types        jsonb := '[]'::jsonb;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can run the year-end rollover.'
      USING errcode = '42501';
  END IF;

  IF length(btrim(COALESCE(p_reason, ''))) < 15 THEN
    RAISE EXCEPTION
      'Say why this rollover is being run, in a sentence. It changes every employee''s balance and the ledger keeps the sentence forever.'
      USING errcode = '23514';
  END IF;

  IF p_from_leave_year < 2000 OR p_from_leave_year > 2099 THEN
    RAISE EXCEPTION 'Leave year % is outside the range the ledger accepts.', p_from_leave_year
      USING errcode = '23514';
  END IF;

  /* April basis: leave year Y runs 01-Apr-Y to 31-Mar-(Y+1). */
  v_year_start := make_date(p_from_leave_year, 4, 1);
  v_year_end   := make_date(p_from_leave_year + 1, 3, 31);

  IF NOT p_dry_run AND v_today <= v_year_end THEN
    RAISE EXCEPTION
      'Leave year % runs to %, which has not passed yet (today is %). Carrying a balance forward mid-year would let the remaining months accrue into a year already closed. Run it as a dry run until then.',
      p_from_leave_year, v_year_end, v_today
      USING errcode = '23514';
  END IF;

  SELECT id INTO v_company FROM public.companies
   WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company on record to attribute the rollover to.' USING errcode = 'P0002';
  END IF;

  -- ── One pass per leave type ──────────────────────────────────────────────
  FOR v_type IN
    SELECT lt.id, lt.code, lt.name,
           lt.carry_forward_allowed,
           COALESCE(lt.max_carry_forward_days, 0) AS cap
      FROM public.leave_types lt
     WHERE lt.deleted_at IS NULL
       AND (p_leave_type_id IS NULL OR lt.id = p_leave_type_id)
       /*
         INACTIVE TYPES ARE STILL ROLLED OVER, deliberately. Sick leave that was
         switched off in February still has a balance in February's ledger, and
         leaving it un-zeroed would carry it silently into the new year through
         `available_days` — the balance row does not care that the picker no
         longer offers the type.
       */
     ORDER BY lt.code
  LOOP
    /* Nothing carries when the type forbids it — that IS the sick-leave rule. */
    v_processed := 0; v_carried := 0; v_lapsed := 0; v_negative := 0;

    IF NOT p_dry_run THEN
      /* Refused rather than repeated: a second committed run would carry an
         already-carried balance, and nothing distinguishes that from a fix. */
      PERFORM 1 FROM public.leave_year_rollovers r
        WHERE r.from_leave_year = p_from_leave_year
          AND r.leave_type_id   = v_type.id
          AND r.dry_run = false
          AND r.status = 'succeeded';
      IF FOUND THEN
        RAISE EXCEPTION
          'Leave year % has already been rolled over for % — running it again would carry the same balance twice.',
          p_from_leave_year, v_type.name
          USING errcode = '23505';
      END IF;
    END IF;

    FOR v_row IN
      SELECT lb.employee_id,
             lb.available_days AS closing,
             LEAST(
               GREATEST(lb.available_days, 0),
               CASE WHEN v_type.carry_forward_allowed THEN v_type.cap ELSE 0 END
             ) AS carry
        FROM public.leave_balances lb
        JOIN public.employees e ON e.id = lb.employee_id
       WHERE lb.leave_type_id = v_type.id
         AND lb.leave_year    = p_from_leave_year
         AND e.deleted_at IS NULL
         /* An exited employee's closing balance is settled by full-and-final, not
            carried into a year they will not work. */
         AND e.employment_status <> 'exited'
         AND lb.available_days <> 0
    LOOP
      v_processed := v_processed + 1;
      v_carried   := v_carried + v_row.carry;
      v_lapsed    := v_lapsed + GREATEST(v_row.closing - v_row.carry, 0);

      /*
        A NEGATIVE CLOSING BALANCE IS LEFT ALONE, AND SAID OUT LOUD.

        Somebody who has taken more than they accrued closes the year in the red.
        There is nothing to carry and nothing to lapse, and the arithmetic above
        correctly writes no rows — but writing nothing and reporting nothing would
        leave a non-zero closing balance behind a run that claimed to close the
        year. Counted, reported, and left for a human: the choice between waiving
        the debt and recovering it in full-and-final is not one a year-end job
        should be making.
      */
      IF v_row.closing < 0 THEN
        v_negative := v_negative + 1;
        CONTINUE;
      END IF;

      CONTINUE WHEN p_dry_run;

      /*
        OUT OF THE CLOSING YEAR: THE CARRIED AMOUNT ONLY.

        This debited the whole closing balance at first, and the `lapse` below then
        debited the excess a second time — a 41-day balance closed the year at -52
        instead of 0. The two rows PARTITION the closing balance: what moves leaves
        as `carry_forward_out`, what does not leaves as `lapse`, and they sum to
        exactly the closing figure. The probe is what caught it; `db:validate` had
        already passed, because applying a function never runs it.
      */
      IF v_row.carry > 0 THEN
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
           description, source_table, reason, recorded_by)
        VALUES
          (v_row.employee_id, v_type.id, p_from_leave_year, 'carry_forward_out',
           -v_row.carry, v_year_end,
           format('Year-end close of %s for FY %s-%s', v_type.name,
                  p_from_leave_year, p_from_leave_year + 1),
           'leave_year_rollover', btrim(p_reason), v_actor);
      END IF;

      -- Into the opening year, the same amount arriving.
      IF v_row.carry > 0 THEN
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
           description, source_table, reason, recorded_by)
        VALUES
          (v_row.employee_id, v_type.id, v_to_year, 'carry_forward_in',
           v_row.carry, v_year_end + 1,
           format('Carried forward into FY %s-%s (limit %s days)',
                  v_to_year, v_to_year + 1, trim_scale(v_type.cap)),
           'leave_year_rollover', btrim(p_reason), v_actor);
      END IF;

      /*
        The excess is recorded as a LAPSE and not simply left out of the carry.
        "You had 41 days, 30 came across" is a fact an employee will ask about, and
        an eleven-day hole with no row explaining it is the kind of gap that gets
        read as a bug in the accrual.
      */
      IF v_row.closing - v_row.carry > 0 THEN
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
           description, source_table, reason, recorded_by)
        VALUES
          (v_row.employee_id, v_type.id, p_from_leave_year, 'lapse',
           -(v_row.closing - v_row.carry), v_year_end,
           CASE WHEN v_type.carry_forward_allowed
                THEN format('Above the %s-day carry-forward limit for %s', trim_scale(v_type.cap), v_type.name)
                ELSE format('%s does not carry forward', v_type.name)
           END,
           'leave_year_rollover', btrim(p_reason), v_actor);
      END IF;

      PERFORM public.recompute_leave_balance(v_row.employee_id, v_type.id, p_from_leave_year);
      PERFORM public.recompute_leave_balance(v_row.employee_id, v_type.id, v_to_year);
    END LOOP;

    IF v_negative > 0 THEN
      RAISE NOTICE '% employee(s) closed % in the red — left untouched, they need a decision',
        v_negative, v_type.code;
    END IF;

    INSERT INTO public.leave_year_rollovers
      (company_id, from_leave_year, to_leave_year, leave_type_id, run_by, status,
       employees_processed, days_carried, days_lapsed, days_encashed, dry_run, report)
    VALUES
      (v_company, p_from_leave_year, v_to_year, v_type.id, v_actor, 'succeeded',
       v_processed, v_carried, v_lapsed, 0, p_dry_run,
       jsonb_build_object(
         'leave_type', v_type.code,
         'carry_forward_allowed', v_type.carry_forward_allowed,
         'cap_days', v_type.cap,
         'year_end', v_year_end,
         'negative_balances_left_alone', v_negative,
         'reason', btrim(p_reason)))
    RETURNING id INTO v_run_id;

    v_types := v_types || jsonb_build_object(
      'run_id', v_run_id,
      'leave_type', v_type.code,
      'leave_type_name', v_type.name,
      'employees', v_processed,
      'days_carried', v_carried,
      'days_lapsed', v_lapsed,
      'negative_balances_left_alone', v_negative,
      'cap_days', CASE WHEN v_type.carry_forward_allowed THEN v_type.cap ELSE 0 END);
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'from_leave_year', p_from_leave_year,
    'to_leave_year', v_to_year,
    'year_end', v_year_end,
    'types', v_types);
END;
$$;

REVOKE ALL     ON FUNCTION public.rollover_leave_year(integer, text, boolean, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rollover_leave_year(integer, text, boolean, uuid) TO authenticated;

COMMENT ON FUNCTION public.rollover_leave_year(integer, text, boolean, uuid) IS
  'Close a leave year: carry each balance forward up to that type''s max_carry_forward_days, lapse the excess, and zero the closing year. April-to-March basis, so leave year Y ends 31-Mar-(Y+1). Administrator only; needs a reason of fifteen characters; dry run by default; refuses to commit before the year has ended or a second time for the same year and type. Reads the caps from leave_types and never writes them.';

COMMIT;
