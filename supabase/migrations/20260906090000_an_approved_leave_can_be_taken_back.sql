/*
  An approved leave can be cancelled, and only an administrator may do it.

  ── WHY THIS WAS MISSING, AND WHY MOST OF IT ALREADY EXISTED ─────────────────
  Once a leave was approved there was no way back. `withdrawLeaveRequest` covers
  `draft|pending -> withdrawn` for the owner and stops there, so a week-off approved by
  mistake, or one the employee needed to move, could only be fixed by editing the database
  by hand — which is exactly what must not happen to a pay-affecting record.

  The hard half was already built and is untouched here. `leave_requests_apply_ledger`
  already reverses on `approved -> cancelled`: it writes an `availed_reversal` against every
  un-reversed debit, restores consumed comp-off credits unless they have expired, resets the
  per-day rows and clears `ledger_applied_at`. `leave_requests_enqueue_recompute` already
  re-derives the attendance days. The status enum already had `cancelled`, and
  `leave_requests__admin_all` already granted an administrator the row.

  So the transition was possible and merely undoable-by-accident. What was missing was a
  door with the guards on it, which is what this function is.

  ── WHAT IT REFUSES, AND WHY EACH ONE ────────────────────────────────────────
    · Not an administrator, or the employee outside their scope. The employee themselves
      cannot call this: taking back an approved absence is a decision somebody accountable
      makes, and an employee who wants their week-off moved asks for it.
    · A day inside a HARD attendance lock. Cancelling would rewrite a settled day.
    · A day already carried into a payroll run. The leave has been paid; reversing the
      ledger silently would put the balance and the payslip permanently out of step.
    · A request that is not approved. Nothing to take back, and the caller is looking at
      stale data — say so rather than writing.
    · A reason under ten characters. The employee reads this, and so does an auditor.
*/

CREATE OR REPLACE FUNCTION public.admin_cancel_leave_request(
  p_request_id uuid,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  r         public.leave_requests%ROWTYPE;
  v_actor   uuid := app.ctx_actor_id();
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_locked  record;
  v_paid    record;
  v_days    integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the acting administrator' USING errcode = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION
      'Cancelling an approved leave needs a reason of at least 10 characters — the employee reads it.'
      USING errcode = '23514';
  END IF;

  SELECT * INTO r FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request % not found', p_request_id USING errcode = 'P0002';
  END IF;

  -- Administrators only, and only inside their own scope.
  IF NOT (app.is_admin() AND app.admin_scope_covers(r.employee_id)) THEN
    RAISE EXCEPTION 'Only an administrator may cancel an approved leave.' USING errcode = '42501';
  END IF;

  IF r.status NOT IN ('approved', 'partially_approved') THEN
    RAISE EXCEPTION
      'This request is %, not approved — there is nothing to cancel.', r.status
      USING errcode = '23514';
  END IF;

  /*
    A hard lock means the period is settled. Reversing a leave inside it would change a day
    somebody has already signed off, so it is refused with the lock named rather than
    half-applied.
  */
  SELECT al.from_date, al.to_date, al.reason
    INTO v_locked
    FROM public.attendance_locks al
    JOIN public.employees e ON e.id = r.employee_id
   WHERE al.unlocked_at IS NULL
     AND al.lock_kind = 'hard'
     AND daterange(al.from_date, al.to_date, '[]') && daterange(r.from_date, r.to_date, '[]')
     AND (al.scope = 'company'
          OR (al.scope = 'employee'   AND al.employee_id   = r.employee_id)
          OR (al.scope = 'department' AND al.department_id = e.department_id)
          OR (al.scope = 'location'   AND al.location_id   = e.location_id))
   ORDER BY al.locked_at DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Attendance for % to % is locked (%). Unlock the period before cancelling this leave.',
      v_locked.from_date, v_locked.to_date, v_locked.reason
      USING errcode = '42501';
  END IF;

  /*
    Already paid. The ledger reversal would still run, so the balance would go up while the
    payslip that consumed it stayed as it was — the two would never agree again.
  */
  SELECT d.ist_date, d.payroll_run_id
    INTO v_paid
    FROM public.attendance_days d
   WHERE d.employee_id = r.employee_id
     AND d.ist_date BETWEEN r.from_date AND r.to_date
     AND d.payroll_run_id IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'This leave is already carried into a payroll run (% is settled). Reverse the payroll first.',
      v_paid.ist_date
      USING errcode = '42501';
  END IF;

  SELECT count(*) INTO v_days
    FROM public.leave_request_days
   WHERE leave_request_id = r.id;

  /*
    The one write. Everything else — the ledger reversal, the comp-off restoration, the day
    statuses, the attendance recompute — hangs off this status change on triggers that were
    already there, so this function does not reimplement any of it and cannot drift from it.
  */
  UPDATE public.leave_requests
     SET status              = 'cancelled',
         cancelled_by        = v_actor,
         cancelled_at        = now(),
         cancellation_reason = v_reason
   WHERE id = r.id;

  RETURN jsonb_build_object(
    'leave_request_id', r.id,
    'request_number',   r.request_number,
    'employee_id',      r.employee_id,
    'from_date',        r.from_date,
    'to_date',          r.to_date,
    'days_released',    v_days,
    'status',           'cancelled');
END;
$function$;

COMMENT ON FUNCTION public.admin_cancel_leave_request(uuid, text) IS
  'Cancel an approved leave. Administrators only, refused inside a hard attendance lock or '
  'once the days have reached a payroll run. The ledger reversal and attendance recompute '
  'ride on the existing status triggers.';

REVOKE ALL ON FUNCTION public.admin_cancel_leave_request(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_leave_request(uuid, text) TO authenticated;
