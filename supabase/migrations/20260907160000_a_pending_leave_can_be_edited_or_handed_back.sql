/*
  A PENDING LEAVE CAN BE EDITED OR HANDED BACK TOO.

  The four administrator actions on a leave — approve, reject, edit the dates, hand it back —
  were split unevenly. Approve and reject applied to a PENDING request; edit and hand-back
  refused anything that was not already approved:

      This request is pending, not approved — reopen it before editing.

  So an administrator reading an application with the wrong dates on it had one move: reject
  it, and ask the employee to type the whole thing again. And an application that plainly
  needed the employee to reconsider had to be rejected rather than returned.

  ── WHERE A HANDED-BACK LEAVE LANDS, AND WHY IT DIFFERS ─────────────────────────────────────
  An APPROVED leave handed back goes to `pending`: the decision is undone, the application
  still stands, and it waits for a fresh decision. That is unchanged.

  A PENDING leave has no decision to undo. Handing it back means giving up the application
  itself, so it goes to `draft` — off the approver's desk and wholly in the employee's hands to
  change, resubmit or abandon. Two different verbs, two different destinations.

  ── THE TRIGGER THAT HAD TO LEARN A THIRD WORD ──────────────────────────────────────────────
  `trg_leave_requests__settle_approval` fired only on 'withdrawn' and 'cancelled', so a request
  going to 'draft' would have left a live `approval_requests` row and a live notification
  pointing at an application nobody could act on. Adding 'draft' to its WHEN clause reuses that
  function verbatim rather than restating its three careful steps — the approval action, the
  request update, and the approver's notification closed rather than deleted.

  Inserts do not fire it: the trigger is AFTER UPDATE OF status, and every new leave is
  INSERTed as a draft.

  ── ONE ORDERING SUBTLETY, STATED BECAUSE IT IS NOT VISIBLE ─────────────────────────────────
  Handing a pending leave back takes TWO statements. `settle_approval_for_detail` reads
  NEW.approval_request_id to find the item to settle, so clearing that column in the same
  update would make it return early and orphan a live approval. It must nonetheless be cleared
  afterwards, because `trg_leave_requests__raise_approval` fires only when a pending row has NO
  approval request — leaving the settled one attached would mean the employee resubmits and the
  request sits pending forever with nobody assigned to it.

  Nothing about the approved paths changes. The locks and payroll checks are skipped only for a
  pending request, which by definition has never been applied to attendance or carried into a
  run, so neither check has anything to say about it.
*/

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. 'draft' settles the approval, the same way 'withdrawn' and 'cancelled' already do.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_leave_requests__settle_approval ON public.leave_requests;
CREATE TRIGGER trg_leave_requests__settle_approval
AFTER UPDATE OF status ON public.leave_requests
FOR EACH ROW
WHEN (
  new.approval_request_id IS NOT NULL
  AND (new.status)::text = ANY (ARRAY['withdrawn'::text, 'cancelled'::text, 'draft'::text])
  AND old.status IS DISTINCT FROM new.status
)
EXECUTE FUNCTION settle_approval_for_detail();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The two actions, now accepting a pending request.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_send_leave_back(
  p_request_id uuid,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  r        public.leave_requests%ROWTYPE;
  v_actor  uuid := app.ctx_actor_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_locked record;
  v_paid   record;
  v_target public.leave_request_status;
  d        date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the acting administrator' USING errcode = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION
      'Say why it is going back — the employee reads this and has to act on it.'
      USING errcode = '23514';
  END IF;

  SELECT * INTO r FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request % not found', p_request_id USING errcode = 'P0002';
  END IF;
  IF NOT (app.is_admin() AND app.admin_scope_covers(r.employee_id)) THEN
    RAISE EXCEPTION 'Only an administrator may hand a leave back.' USING errcode = '42501';
  END IF;
  /*
    PENDING IS ACCEPTED TOO, and it lands somewhere different.

    An approved leave goes back to `pending`: the decision is undone but the application still
    stands, waiting for a fresh one. A leave that is ALREADY pending has no decision to undo —
    handing it back means giving up the application itself, so it goes to `draft`, off the
    approver's desk and wholly in the employee's hands.
  */
  IF r.status NOT IN ('approved','partially_approved','pending') THEN
    RAISE EXCEPTION
      'This request is % — only an approved or pending leave can be handed back.', r.status
      USING errcode = '23514';
  END IF;
  v_target := CASE WHEN r.status = 'pending' THEN 'draft' ELSE 'pending' END;

  /*
    A pending leave has never been applied to attendance or payroll — nothing of it is in a
    locked period or a settled run, so neither check has anything to say about it. Running them
    anyway would refuse to hand back a perfectly ordinary application because some unrelated
    past month happened to be sealed.
  */
  IF r.status <> 'pending' THEN
  SELECT al.from_date, al.to_date, al.reason INTO v_locked
    FROM public.attendance_locks al
    JOIN public.employees e ON e.id = r.employee_id
   WHERE al.unlocked_at IS NULL AND al.lock_kind = 'hard'
     AND daterange(al.from_date, al.to_date, '[]') && daterange(r.from_date, r.to_date, '[]')
     AND (al.scope = 'company'
          OR (al.scope = 'employee'   AND al.employee_id   = r.employee_id)
          OR (al.scope = 'department' AND al.department_id = e.department_id)
          OR (al.scope = 'location'   AND al.location_id   = e.location_id))
   ORDER BY al.locked_at DESC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Attendance for % to % is locked (%). Unlock the period before reopening this leave.',
      v_locked.from_date, v_locked.to_date, v_locked.reason USING errcode = '42501';
  END IF;

  SELECT d2.ist_date INTO v_paid FROM public.attendance_days d2
   WHERE d2.employee_id = r.employee_id
     AND d2.ist_date BETWEEN r.from_date AND r.to_date
     AND d2.payroll_run_id IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'This leave is already carried into a payroll run (% is settled). Reverse the payroll first.',
      v_paid.ist_date USING errcode = '42501';
  END IF;
  END IF;

  /*
    Back to pending. The trigger reverses the debit and resets the day rows, and
    `leave_requests__self_update` admits the owner on a pending row — so the employee can
    change it or withdraw it exactly as they could before it was approved.

    The decision fields are cleared: leaving the old approver's name and timestamp on a
    request that is no longer approved would read, months later, as though they had approved
    whatever it eventually became.
  */
  UPDATE public.leave_requests
     SET status              = v_target,
         decided_by          = NULL,
         decided_at          = NULL,
         decision_comment    = v_reason,
         cancelled_by        = NULL,
         cancelled_at        = NULL,
         cancellation_reason = NULL
   WHERE id = r.id;

  /*
    TWO STATEMENTS, AND THE ORDER IS THE POINT.

    `trg_leave_requests__settle_approval` reads NEW.approval_request_id to take the item off
    the approver's desk, so clearing that column in the SAME update would make the trigger
    return early and leave a live approval pointing at a draft.

    It must then be cleared, because `trg_leave_requests__raise_approval` fires only when a
    pending row has NO approval request. Leaving the settled one attached would mean the
    employee resubmits and the request sits pending forever with nobody assigned to it.
  */
  IF v_target = 'draft' THEN
    UPDATE public.leave_requests SET approval_request_id = NULL WHERE id = r.id;
  END IF;

  FOR d IN SELECT generate_series(r.from_date, r.to_date, interval '1 day')::date LOOP
    PERFORM public.compute_attendance_day(r.employee_id, d, 'leave handed back to the employee');
  END LOOP;

  RETURN jsonb_build_object(
    'leave_request_id', r.id,
    'request_number',   r.request_number,
    'employee_id',      r.employee_id,
    'status',           v_target::text);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_edit_leave_dates(
  p_request_id uuid,
  p_from       date,
  p_to         date,
  p_portion    text,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  r         public.leave_requests%ROWTYPE;
  lt        public.leave_types%ROWTYPE;
  v_actor   uuid := app.ctx_actor_id();
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_locked  record;
  v_paid    record;
  v_total   numeric;
  v_avail   numeric;
  v_old_from date;
  v_old_to   date;
  v_was_pending boolean;
  d         date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the acting administrator' USING errcode = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Changing a leave''s dates needs a reason of at least 10 characters.'
      USING errcode = '23514';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'The last day cannot be before the first.' USING errcode = '23514';
  END IF;

  SELECT * INTO r FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request % not found', p_request_id USING errcode = 'P0002';
  END IF;
  IF NOT (app.is_admin() AND app.admin_scope_covers(r.employee_id)) THEN
    RAISE EXCEPTION 'Only an administrator may change a leave''s dates.' USING errcode = '42501';
  END IF;
  /*
    PENDING IS EDITABLE TOO. An administrator reading an application that asks for the wrong
    dates should be able to correct it and then approve it, rather than rejecting it and asking
    the employee to file the whole thing again.
  */
  IF r.status NOT IN ('approved','partially_approved','pending') THEN
    RAISE EXCEPTION 'This request is % — only an approved or pending leave can be edited.',
      r.status USING errcode = '23514';
  END IF;
  v_was_pending := (r.status = 'pending');

  SELECT * INTO lt FROM public.leave_types WHERE id = r.leave_type_id;
  IF lt.is_comp_off THEN
    RAISE EXCEPTION
      'Comp-off is booked against specific earned credits. Cancel it and re-apply for other dates.'
      USING errcode = '23514';
  END IF;

  v_old_from := r.from_date;
  v_old_to   := r.to_date;

  /*
    Locks and payroll over BOTH ranges. Moving a leave OUT of a locked week changes that week
    as much as moving one in, and a check on the new dates alone would let a settled period be
    quietly emptied.
  */
  SELECT al.from_date, al.to_date, al.reason INTO v_locked
    FROM public.attendance_locks al
    JOIN public.employees e ON e.id = r.employee_id
   WHERE al.unlocked_at IS NULL AND al.lock_kind = 'hard'
     AND (daterange(al.from_date, al.to_date, '[]') && daterange(v_old_from, v_old_to, '[]')
       OR daterange(al.from_date, al.to_date, '[]') && daterange(p_from, p_to, '[]'))
     AND (al.scope = 'company'
          OR (al.scope = 'employee'   AND al.employee_id   = r.employee_id)
          OR (al.scope = 'department' AND al.department_id = e.department_id)
          OR (al.scope = 'location'   AND al.location_id   = e.location_id))
   ORDER BY al.locked_at DESC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Attendance for % to % is locked (%). Unlock the period before changing these dates.',
      v_locked.from_date, v_locked.to_date, v_locked.reason USING errcode = '42501';
  END IF;

  SELECT d2.ist_date INTO v_paid FROM public.attendance_days d2
   WHERE d2.employee_id = r.employee_id
     AND (d2.ist_date BETWEEN v_old_from AND v_old_to OR d2.ist_date BETWEEN p_from AND p_to)
     AND d2.payroll_run_id IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'These dates touch a settled payroll run (%). Reverse the payroll first.', v_paid.ist_date
      USING errcode = '42501';
  END IF;

  /*
    Un-apply: the trigger reverses the debit and clears `ledger_applied_at`. Skipped when the
    request was already pending — there is no `availed` debit to reverse, and writing
    status='pending' onto a pending row is a no-op that would still fire every status trigger.
  */
  IF NOT v_was_pending THEN
    UPDATE public.leave_requests SET status = 'pending' WHERE id = r.id;
  END IF;

  /*
    Rebuild the day rows for the new range. The day rows carry the request's OWN status: an
    approved request's re-apply sums 'approved' rows, and a pending one must not be handed
    'approved' days it has not been granted yet.
  */
  v_total := public.rebuild_leave_request_days(
               r.id, r.employee_id, r.leave_type_id, p_from, p_to,
               p_portion::public.leave_day_portion,
               CASE WHEN v_was_pending THEN 'pending' ELSE 'approved' END
                 ::public.leave_request_status);

  /*
    The balance check nothing else performs. `leave_requests_submit_guard` fires only when a
    DRAFT becomes pending, so an edit stretching two days to ten would otherwise pass every
    balance rule in the system and simply overdraw.
  */
  IF lt.is_paid AND NOT lt.is_system_managed THEN
    SELECT COALESCE(available_days, 0) INTO v_avail
      FROM public.leave_balances
     WHERE employee_id = r.employee_id AND leave_type_id = r.leave_type_id
     ORDER BY leave_year DESC LIMIT 1;
    IF v_total > COALESCE(v_avail, 0)
       + (CASE WHEN lt.allow_negative_balance THEN COALESCE(lt.max_negative_days, 0) ELSE 0 END) THEN
      RAISE EXCEPTION
        'That is % day(s); % has % available. The change was not applied.',
        v_total, lt.code, COALESCE(v_avail, 0) USING errcode = '23514';
    END IF;
  END IF;

  UPDATE public.leave_requests
     SET from_date        = p_from,
         to_date          = p_to,
         portion          = p_portion::public.leave_day_portion,
         total_days       = v_total,
         paid_days        = GREATEST(v_total - COALESCE(unpaid_days, 0), 0),
         approved_days    = NULL,
         decision_comment = v_reason,
         /*
           A pending request has not been decided, and stamping this administrator as its
           decider because they corrected a date would read, later, as an approval they never
           gave.
         */
         decided_by       = CASE WHEN v_was_pending THEN NULL ELSE v_actor END,
         decided_at       = CASE WHEN v_was_pending THEN NULL ELSE now() END
   WHERE id = r.id;

  -- Re-apply at the new size, through the same code an ordinary approval uses. A request that
  -- arrived pending stays pending: editing it is not deciding it.
  IF NOT v_was_pending THEN
    UPDATE public.leave_requests SET status = 'approved' WHERE id = r.id;
  END IF;

  -- Every day that changed meaning: the ones released and the ones taken.
  FOR d IN
    SELECT generate_series(LEAST(v_old_from, p_from), GREATEST(v_old_to, p_to), interval '1 day')::date
  LOOP
    PERFORM public.compute_attendance_day(r.employee_id, d, 'leave dates changed');
  END LOOP;

  RETURN jsonb_build_object(
    'leave_request_id', r.id,
    'request_number',   r.request_number,
    'employee_id',      r.employee_id,
    'from_date',        p_from,
    'to_date',          p_to,
    'total_days',       v_total,
    'status',           CASE WHEN v_was_pending THEN 'pending' ELSE 'approved' END);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_send_leave_back(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_send_leave_back(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_edit_leave_dates(uuid, date, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_edit_leave_dates(uuid, date, date, text, text) TO authenticated;
