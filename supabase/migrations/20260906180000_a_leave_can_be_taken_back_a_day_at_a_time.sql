/*
  Cancel part of an approved leave — one day of three, or all three.

  ── WHY A SECOND FUNCTION AND NOT A FLAG ON THE FIRST ────────────────────────
  `admin_cancel_leave_request` takes the whole request back, and it does it by changing one
  status and letting `leave_requests_apply_ledger` reverse everything on the trigger. That is
  the right shape for "all of it" and the wrong shape for "the Tuesday": the trigger reverses
  by REQUEST, so it cannot release two days of a three-day booking.

  So this function does the day-level work explicitly, and then hands back to the existing
  machinery the moment the whole request is gone — if no approved day is left standing it
  cancels the request itself, and the trigger performs exactly the reversal it always did.
  Nothing reverses twice: `ledger_applied_at` is what the trigger keys on, and it is only
  cleared on that whole-request path.

  ── THE ARITHMETIC ───────────────────────────────────────────────────────────
  The debit written at approval was the SUM of `day_value` over counted, approved day rows.
  Releasing a day therefore releases exactly that day's `day_value` — a half day releases
  0.5 — and the reversal entry carries the released amount rather than a day count, so a
  half-day cancellation cannot quietly return a whole one.

  A day that was never counted (a holiday or a weekly off inside the range) releases nothing.
  It is still marked cancelled so the calendar stops showing it, but it never cost a balance
  and must not credit one.

  ── WHAT IT REFUSES ──────────────────────────────────────────────────────────
  The same three as the whole-request path, for the same reasons: not an administrator or out
  of scope; a hard attendance lock over any released day; a day already carried into payroll.
  Plus one of its own — a date that is not in this request, which means the caller is working
  from stale data and must not have a partial cancellation applied blind.
*/

CREATE OR REPLACE FUNCTION public.admin_cancel_leave_days(
  p_request_id uuid,
  p_dates      date[],
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  r          public.leave_requests%ROWTYPE;
  lt         public.leave_types%ROWTYPE;
  v_actor    uuid := app.ctx_actor_id();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_locked   record;
  v_paid     record;
  v_unknown  date;
  v_release  numeric := 0;
  v_left     numeric := 0;
  v_days_off int := 0;
  v_prior    public.leave_ledger%ROWTYPE;
  v_rev_id   uuid;
  v_still    numeric := 0;
  d          date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the acting administrator' USING errcode = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION
      'Cancelling leave needs a reason of at least 10 characters — the employee reads it.'
      USING errcode = '23514';
  END IF;
  IF p_dates IS NULL OR array_length(p_dates, 1) IS NULL THEN
    RAISE EXCEPTION 'No dates given — say which day or days to cancel.' USING errcode = '23514';
  END IF;

  SELECT * INTO r FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request % not found', p_request_id USING errcode = 'P0002';
  END IF;
  IF NOT (app.is_admin() AND app.admin_scope_covers(r.employee_id)) THEN
    RAISE EXCEPTION 'Only an administrator may cancel an approved leave.' USING errcode = '42501';
  END IF;
  IF r.status NOT IN ('approved', 'partially_approved') THEN
    RAISE EXCEPTION 'This request is %, not approved — there is nothing to cancel.', r.status
      USING errcode = '23514';
  END IF;

  -- Every named date must belong to this request, or the caller is on stale data.
  SELECT x INTO v_unknown FROM unnest(p_dates) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.leave_request_days ld
                      WHERE ld.leave_request_id = r.id AND ld.leave_date = x)
   LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION '% is not a day of request %.', v_unknown, r.request_number
      USING errcode = '23514';
  END IF;

  -- A hard lock over any released day.
  SELECT al.from_date, al.to_date, al.reason INTO v_locked
    FROM public.attendance_locks al
    JOIN public.employees e ON e.id = r.employee_id
   WHERE al.unlocked_at IS NULL AND al.lock_kind = 'hard'
     AND EXISTS (SELECT 1 FROM unnest(p_dates) AS x WHERE x BETWEEN al.from_date AND al.to_date)
     AND (al.scope = 'company'
          OR (al.scope = 'employee'   AND al.employee_id   = r.employee_id)
          OR (al.scope = 'department' AND al.department_id = e.department_id)
          OR (al.scope = 'location'   AND al.location_id   = e.location_id))
   ORDER BY al.locked_at DESC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Attendance for % to % is locked (%). Unlock the period before cancelling these days.',
      v_locked.from_date, v_locked.to_date, v_locked.reason USING errcode = '42501';
  END IF;

  -- Already paid.
  SELECT d2.ist_date INTO v_paid
    FROM public.attendance_days d2
   WHERE d2.employee_id = r.employee_id
     AND d2.ist_date = ANY(p_dates)
     AND d2.payroll_run_id IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Leave on % is already carried into a payroll run. Reverse the payroll first.',
      v_paid.ist_date USING errcode = '42501';
  END IF;

  /*
    What these days actually cost. Only counted, still-approved rows — asking twice for the
    same day releases it once, and a holiday inside the range releases nothing.
  */
  SELECT COALESCE(sum(ld.day_value), 0), count(*)
    INTO v_release, v_days_off
    FROM public.leave_request_days ld
   WHERE ld.leave_request_id = r.id
     AND ld.leave_date = ANY(p_dates)
     AND ld.status = 'approved';

  UPDATE public.leave_request_days ld
     SET status = 'cancelled'
   WHERE ld.leave_request_id = r.id
     AND ld.leave_date = ANY(p_dates)
     AND ld.status = 'approved';

  SELECT COALESCE(sum(ld.day_value), 0) INTO v_left
    FROM public.leave_request_days ld
   WHERE ld.leave_request_id = r.id AND ld.is_counted AND ld.status = 'approved';

  IF v_left = 0 THEN
    /*
      Nothing left standing, so this is a whole-request cancellation after all. Hand it to the
      status trigger, which reverses every un-reversed debit and restores comp-off exactly as
      it does for `admin_cancel_leave_request`. No partial entry is written here — that would
      be reversed a second time.
    */
    UPDATE public.leave_requests
       SET status              = 'cancelled',
           cancelled_by        = v_actor,
           cancelled_at        = now(),
           cancellation_reason = v_reason
     WHERE id = r.id;
  ELSE
    SELECT * INTO lt FROM public.leave_types WHERE id = r.leave_type_id;
    /*
      A partial release. Comp-off is deliberately NOT restored a day at a time: a credit is
      consumed as a unit against a specific earned day, and splitting one would need a rule the
      venue has not set. A comp-off booking is cancelled whole or not at all.
    */
    IF lt.is_comp_off THEN
      RAISE EXCEPTION
        'Comp-off is booked as a whole. Cancel the entire request rather than single days.'
        USING errcode = '23514';
    END IF;

    /*
      ── DOUBLE ENTRY, NOT A PARTIAL CREDIT ──────────────────────────────────
      Writing a +1 reversal against a -3 debit and leaving the debit un-reversed is what a
      first draft of this did, and it over-credited by a whole day: the original -3 still
      looked outstanding, so when the last two days were cancelled the status trigger — which
      reverses every un-reversed `availed` row — returned another 3. Four days back from a
      three-day booking.

      So a partial cancellation closes the old debit COMPLETELY and opens a new one for what
      is left. The ledger then reads -3, +3, -2: the request currently costs two days, one row
      says so, and the trigger has exactly one thing to reverse if the rest is cancelled later.
    */
    IF lt.is_paid AND NOT lt.is_system_managed THEN
      FOR v_prior IN
        SELECT * FROM public.leave_ledger ll
         WHERE ll.leave_request_id = r.id
           AND ll.entry_type = 'availed'
           AND ll.reversed_by_id IS NULL
      LOOP
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
           description, source_table, source_id, leave_request_id, reverses_id, recorded_by)
        VALUES
          (v_prior.employee_id, v_prior.leave_type_id, v_prior.leave_year,
           'availed_reversal', -v_prior.days, util.ist_today(),
           format('Re-stated: %s cancelled %s day(s) of %s',
                  r.request_number, v_release, r.request_number),
           'leave_requests', r.id, r.id, v_prior.id, v_actor)
        RETURNING id INTO v_rev_id;
        UPDATE public.leave_ledger SET reversed_by_id = v_rev_id WHERE id = v_prior.id;
      END LOOP;

      -- And the debit for what is still booked.
      v_still := GREATEST(v_left - COALESCE(r.unpaid_days, 0), 0);
      IF v_still > 0 THEN
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
           description, source_table, source_id, leave_request_id, recorded_by)
        VALUES
          (r.employee_id, r.leave_type_id, public.leave_year_of(r.from_date),
           'availed', -v_still, r.from_date,
           format('%s availed %s day(s) after cancelling %s',
                  r.request_number, v_still,
                  (SELECT string_agg(to_char(x, 'DD-Mon'), ', ' ORDER BY x) FROM unnest(p_dates) AS x)),
           'leave_requests', r.id, r.id, v_actor);
      END IF;
    END IF;

    UPDATE public.leave_requests
       SET approved_days = v_left,
           total_days    = v_left,
           paid_days     = GREATEST(0, LEAST(paid_days - v_release, v_left)),
           unpaid_days   = LEAST(COALESCE(unpaid_days, 0),
                                 GREATEST(0, v_left - GREATEST(0, LEAST(paid_days - v_release, v_left))))
     WHERE id = r.id;
  END IF;

  -- The released days are working days again.
  FOREACH d IN ARRAY p_dates LOOP
    PERFORM public.compute_attendance_day(r.employee_id, d, 'leave day cancelled');
  END LOOP;

  RETURN jsonb_build_object(
    'leave_request_id', r.id,
    'request_number',   r.request_number,
    'employee_id',      r.employee_id,
    'days_cancelled',   v_days_off,
    'days_released',    v_release,
    'days_remaining',   v_left,
    'status',           CASE WHEN v_left = 0 THEN 'cancelled' ELSE r.status::text END);
END;
$function$;

COMMENT ON FUNCTION public.admin_cancel_leave_days(uuid, date[], text) IS
  'Cancel named days of an approved leave. Releases each day''s day_value, and hands the '
  'whole request to the status trigger once no approved day is left. Administrators only.';

REVOKE ALL ON FUNCTION public.admin_cancel_leave_days(uuid, date[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_leave_days(uuid, date[], text) TO authenticated;
