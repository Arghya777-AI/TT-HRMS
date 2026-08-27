-- =============================================================================
-- 20260827120000 — the year end runs itself, or it does not happen
-- =============================================================================
--
-- 20260827110000 gave the venue a working year-end close and a button to press.
-- That is not what was asked for:
--
--   "reset sick leave to 0 at the end of year"
--
-- A reset that only happens when somebody remembers to press a button in March is
-- a reset that will not happen. So it gets a schedule.
--
-- ── WHY A SECOND ENTRY POINT AND NOT A GRANT ────────────────────────────────
--
-- `public.rollover_leave_year` gates on `app.is_admin()`, and a cron has no JWT:
-- `app.ctx_actor_id()` is NULL, `app.has_role()` finds no row, and the function
-- would refuse itself every 1 April. Granting EXECUTE to `service_role` does not
-- help, because the refusal is inside the body, not in the grant.
--
-- `accrue_leave` shows the pattern this codebase already uses for scheduled work:
-- NO permission check in the body, and `GRANT EXECUTE ... TO service_role` as the
-- only gate — the grant IS the permission. So the work moves into
-- `app.rollover_leave_year_run`, which is granted to nobody and lives in a schema
-- PostgREST does not expose, and two thin wrappers call it:
--
--   public.rollover_leave_year(...)     authenticated, admin-checked  — the button
--   public.rollover_leave_year_cron()   service_role only             — the schedule
--
-- The arithmetic exists once. A second copy of "carry up to the cap, lapse the
-- rest" would be a second answer to what a year end is, and the two would drift.
--
-- ── WHY IT COMMITS RATHER THAN PREVIEWING AND WAITING ───────────────────────
--
-- Because there is no decision in it. "Carry up to the type''s own limit, lapse
-- the rest, zero the closing year" is policy already written down in
-- `leave_types`; a human reviewing the dry run would be reading a subtraction, not
-- exercising judgement. The one genuinely ambiguous case — an employee who closes
-- the year in the RED — is already excluded: those are counted, reported and left
-- untouched for somebody to decide about.
--
-- It is safe to fire repeatedly, which is what makes an unattended commit
-- defensible: the function refuses a year that has not ended, and refuses a second
-- committed run over the same year and type. A retry after a failure does the
-- remaining work and nothing twice.
--
-- ── THE SCHEDULE ────────────────────────────────────────────────────────────
--
-- Daily at 17:30 IST, doing work only on 1 APRIL — the same shape as the accrual
-- job (20260817110000), and for the same reason: a daily fire with a date guard
-- inside survives a missed day, where a once-a-year cron entry silently does not
-- run until the next year. The leave year closed is the one that ended yesterday.
--
-- REGISTERED ENABLED, deliberately. A disabled job would reproduce exactly the
-- problem this migration exists to fix. To stop it: Admin → System → Cron, or
-- `UPDATE public.cron_jobs SET is_enabled = false WHERE code = ''leave-year-rollover''`.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 120000: the year-end close gets a schedule, because a reset nobody presses is not a reset', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The work, once, reachable by neither role directly
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.rollover_leave_year_run(
  p_from_leave_year integer,
  p_reason          text,
  p_dry_run         boolean DEFAULT true,
  p_leave_type_id   uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $run$
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
$run$;

REVOKE ALL ON FUNCTION app.rollover_leave_year_run(integer, text, boolean, uuid) FROM PUBLIC;

COMMENT ON FUNCTION app.rollover_leave_year_run(integer, text, boolean, uuid) IS
  'The year-end close itself, with NO permission check — the callers carry that. Not granted to any role and not in an exposed schema, so it is reachable only from public.rollover_leave_year (admin) and public.rollover_leave_year_cron (service_role).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The button: an administrator, checked
-- ─────────────────────────────────────────────────────────────────────────────

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
AS $btn$
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can run the year-end rollover.'
      USING errcode = '42501';
  END IF;
  RETURN app.rollover_leave_year_run(p_from_leave_year, p_reason, p_dry_run, p_leave_type_id);
END;
$btn$;

REVOKE ALL     ON FUNCTION public.rollover_leave_year(integer, text, boolean, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rollover_leave_year(integer, text, boolean, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The schedule: service_role, and the grant is the gate
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rollover_leave_year_cron()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $cron$
DECLARE
  v_today date := util.ist_date(now());
  v_year  integer;
BEGIN
  /*
    THE DATE GUARD, not the cron expression, decides whether work happens. Fired
    daily; acts on 1 April only. A once-a-year cron entry that misses its slot
    waits a full year, and nobody notices until somebody asks why their sick leave
    carried over.
  */
  IF NOT (EXTRACT(MONTH FROM v_today) = 4 AND EXTRACT(DAY FROM v_today) = 1) THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'not 1 April', 'as_of', v_today);
  END IF;

  -- The year that ended yesterday, on the April basis.
  v_year := public.leave_year_of(v_today - 1);

  RETURN app.rollover_leave_year_run(
    v_year,
    format('scheduled year-end close of leave year %s, run by the leave-year-rollover job', v_year),
    false,
    NULL);
END;
$cron$;

REVOKE ALL     ON FUNCTION public.rollover_leave_year_cron() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rollover_leave_year_cron() TO service_role;

COMMENT ON FUNCTION public.rollover_leave_year_cron() IS
  'Scheduled year-end close. Fires daily and acts only on 1 April, closing the leave year that ended the previous day. service_role only — the grant is the permission, as with accrue_leave. Safe to re-run: the close refuses a year that has not ended and a second committed run.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Register it
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.cron_jobs
  (code, name, description, schedule_cron, schedule_human, target, target_name, is_enabled)
VALUES
  ('leave-year-rollover',
   'Year-end leave rollover',
   'Closes the leave year on 1 April: carries each balance forward up to its type''s max_carry_forward_days, lapses the excess, and zeroes the closing year. Earned leave carries at most 30 days; sick leave carries nothing, which is the requested reset to zero. Fires daily at 17:30 IST; the date guard means it only does work on 1 April.',
   '0 12 * * *',
   'Every day at 17:30 IST, acting only on 1 April',
   'sql_function',
   'public.rollover_leave_year_cron',
   true)
ON CONFLICT (code) DO UPDATE
   SET schedule_cron  = EXCLUDED.schedule_cron,
       schedule_human = EXCLUDED.schedule_human,
       description    = EXCLUDED.description,
       target         = EXCLUDED.target,
       target_name    = EXCLUDED.target_name,
       is_enabled     = EXCLUDED.is_enabled;

DO $verify$
DECLARE v_job record;
BEGIN
  SELECT code, is_enabled, schedule_human, target_name INTO v_job
    FROM public.cron_jobs WHERE code = 'leave-year-rollover';
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'the rollover job was not registered';
  END IF;
  RAISE NOTICE 'registered %: % → % (enabled=%)',
    v_job.code, v_job.schedule_human, v_job.target_name, v_job.is_enabled;
END $verify$;

COMMIT;
