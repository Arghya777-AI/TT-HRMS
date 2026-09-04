/*
  An approved leave can be edited, or handed back to the employee.

  ── ONE IDEA BEHIND BOTH ─────────────────────────────────────────────────────
  Cancelling was the only way out of an approval, and it is a blunt one. A leave booked for
  the wrong week does not need cancelling and re-filing — it needs its dates changed. A leave
  the employee should decide about does not need an administrator guessing — it needs handing
  back.

  Both are the same underlying move: UN-APPLY the approval, do the thing, and let the existing
  machinery re-apply it. Neither reimplements a ledger entry.

  ── THE TRIGGER LEARNS ONE MORE WORD ─────────────────────────────────────────
  `leave_requests_apply_ledger` already reverses on approved -> cancelled/rejected/withdrawn.
  It did NOT reverse on approved -> pending, and that gap is what made "send it back" unsafe:
  the request would sit pending while its debit stood, the employee could withdraw it, and the
  withdrawal would reverse nothing because OLD.status was no longer 'approved'. An orphaned
  debit, and a balance permanently short.

  So 'pending' joins that list. Un-approving reverses, whatever it is being un-approved TO.
  That is the whole change to the trigger, and it makes both functions below honest.

  ── EDITING IS UN-APPLY, REBUILD, RE-APPLY ───────────────────────────────────
  `admin_edit_leave_dates` sets the request pending (the trigger reverses), calls
  `rebuild_leave_request_days` for the new range, and sets it approved again (the trigger
  re-applies at the new size). Every ledger entry is written by the same code that writes them
  for an ordinary approval, so an edited leave and a freshly approved one are indistinguishable
  in the ledger — which is the point.

  It checks the balance ITSELF, because nothing else will: `leave_requests_submit_guard` only
  fires on a draft becoming pending, so an edit that stretches a two-day leave to ten would
  otherwise sail past every balance rule in the system.

  Locks and payroll are checked over the OLD range and the NEW one. Moving a leave OUT of a
  locked week is as much a change to that week as moving one in.
*/

-- ── 1. Un-approving reverses, whatever the destination ──────────────────────
CREATE OR REPLACE FUNCTION public.leave_requests_apply_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  lt       public.leave_types%ROWTYPE;
  r        record;
  v_days   numeric;
  v_debit  numeric;
  v_rev_id uuid;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;

  IF NEW.status IN ('approved','partially_approved') AND NEW.ledger_applied_at IS NULL THEN
    IF NEW.status = 'approved' THEN
      UPDATE public.leave_request_days SET status = 'approved' WHERE leave_request_id = NEW.id;
    END IF;
    SELECT COALESCE(SUM(day_value), 0) INTO v_days
      FROM public.leave_request_days
     WHERE leave_request_id = NEW.id AND is_counted AND status = 'approved';

    v_debit := GREATEST(v_days - COALESCE(NEW.unpaid_days, 0), 0);

    IF lt.is_comp_off THEN
      IF v_debit > 0 THEN
        PERFORM public.consume_comp_off(NEW.employee_id, v_debit, NEW.id, NEW.from_date);
      END IF;
    ELSIF lt.is_paid AND NOT lt.is_system_managed AND v_debit > 0 THEN
      INSERT INTO public.leave_ledger
        (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
         description, source_table, source_id, leave_request_id, recorded_by)
      VALUES
        (NEW.employee_id, NEW.leave_type_id, public.leave_year_of(NEW.from_date),
         'availed', -v_debit, NEW.from_date,
         format('%s availed %s to %s (%s)', lt.code,
                to_char(NEW.from_date, 'DD-Mon-YYYY'), to_char(NEW.to_date, 'DD-Mon-YYYY'),
                NEW.request_number),
         'leave_requests', NEW.id, NEW.id, app.ctx_actor_id());
    END IF;

    UPDATE public.leave_requests
       SET ledger_applied_at = now(),
           approved_days     = COALESCE(approved_days, v_days)
     WHERE id = NEW.id;

  /*
    UN-APPROVAL. 'pending' joins cancelled/rejected/withdrawn here: handing a leave back to
    the employee, or opening it for an edit, un-approves it, and an un-approved leave must not
    keep its debit. Without this the request sat pending while the balance stayed short, and a
    later withdrawal reversed nothing because OLD.status was no longer 'approved'.
  */
  ELSIF OLD.status IN ('approved','partially_approved')
        AND NEW.status IN ('cancelled','rejected','withdrawn','pending')
        AND NEW.ledger_applied_at IS NOT NULL THEN

    FOR r IN
      SELECT * FROM public.leave_ledger ll
       WHERE ll.leave_request_id = NEW.id
         AND ll.entry_type IN ('availed','comp_off_debit')
         AND ll.reversed_by_id IS NULL
    LOOP
      INSERT INTO public.leave_ledger
        (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
         description, source_table, source_id, leave_request_id, reverses_id, recorded_by)
      VALUES
        (r.employee_id, r.leave_type_id, r.leave_year, 'availed_reversal', -r.days,
         util.ist_today(),
         format('Reversal of %s — request %s %s', r.entry_type, NEW.request_number, NEW.status),
         'leave_requests', NEW.id, NEW.id, r.id, app.ctx_actor_id())
      RETURNING id INTO v_rev_id;
      UPDATE public.leave_ledger SET reversed_by_id = v_rev_id WHERE id = r.id;
    END LOOP;

    FOR r IN
      SELECT * FROM public.comp_off_ledger col
       WHERE col.availed_via_leave_request_id = NEW.id
         AND col.entry_type = 'availed'
         AND col.source_comp_off_id IS NOT NULL
    LOOP
      UPDATE public.comp_off_ledger c
         SET days_remaining = LEAST(COALESCE(c.days_remaining, 0) + ABS(r.days), c.days),
             status = CASE WHEN COALESCE(c.days_remaining, 0) + ABS(r.days) >= c.days
                           THEN 'available' ELSE 'partially_used' END
       WHERE c.id = r.source_comp_off_id
         AND c.status IN ('available','partially_used','used');
      IF FOUND THEN
        INSERT INTO public.comp_off_ledger
          (employee_id, entry_type, days, earned_on_date, expires_on,
           availed_via_leave_request_id, availed_on_date, status,
           source_comp_off_id, reason, recorded_by)
        VALUES
          (r.employee_id, 'adjusted', ABS(r.days), r.earned_on_date, r.expires_on,
           NEW.id, r.availed_on_date, 'available', r.source_comp_off_id,
           format('credit restored — request %s %s', NEW.request_number, NEW.status),
           app.ctx_actor_id());
      END IF;
    END LOOP;

    UPDATE public.leave_request_days SET status = NEW.status WHERE leave_request_id = NEW.id;
    UPDATE public.leave_requests SET ledger_applied_at = NULL WHERE id = NEW.id;
  END IF;

  RETURN NULL;
END;
$function$;

-- ── 2. Hand it back to the employee ─────────────────────────────────────────
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
  IF r.status NOT IN ('approved','partially_approved') THEN
    RAISE EXCEPTION 'This request is %, not approved — there is nothing to hand back.', r.status
      USING errcode = '23514';
  END IF;

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

  /*
    Back to pending. The trigger reverses the debit and resets the day rows, and
    `leave_requests__self_update` admits the owner on a pending row — so the employee can
    change it or withdraw it exactly as they could before it was approved.

    The decision fields are cleared: leaving the old approver's name and timestamp on a
    request that is no longer approved would read, months later, as though they had approved
    whatever it eventually became.
  */
  UPDATE public.leave_requests
     SET status              = 'pending',
         decided_by          = NULL,
         decided_at          = NULL,
         decision_comment    = v_reason,
         cancelled_by        = NULL,
         cancelled_at        = NULL,
         cancellation_reason = NULL
   WHERE id = r.id;

  FOR d IN SELECT generate_series(r.from_date, r.to_date, interval '1 day')::date LOOP
    PERFORM public.compute_attendance_day(r.employee_id, d, 'leave handed back to the employee');
  END LOOP;

  RETURN jsonb_build_object(
    'leave_request_id', r.id,
    'request_number',   r.request_number,
    'employee_id',      r.employee_id,
    'status',           'pending');
END;
$function$;

-- ── 3. Change the dates ─────────────────────────────────────────────────────
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
  d         date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the acting administrator' USING errcode = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Changing an approved leave needs a reason of at least 10 characters.'
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
    RAISE EXCEPTION 'Only an administrator may change an approved leave.' USING errcode = '42501';
  END IF;
  IF r.status NOT IN ('approved','partially_approved') THEN
    RAISE EXCEPTION 'This request is %, not approved — reopen it before editing.', r.status
      USING errcode = '23514';
  END IF;

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

  -- Un-apply: the trigger reverses the debit and clears `ledger_applied_at`.
  UPDATE public.leave_requests SET status = 'pending' WHERE id = r.id;

  -- Rebuild the day rows for the new range, already approved so the re-apply can sum them.
  v_total := public.rebuild_leave_request_days(
               r.id, r.employee_id, r.leave_type_id, p_from, p_to,
               p_portion::public.leave_day_portion, 'approved'::public.leave_request_status);

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
         decided_by       = v_actor,
         decided_at       = now()
   WHERE id = r.id;

  -- Re-apply at the new size, through the same code an ordinary approval uses.
  UPDATE public.leave_requests SET status = 'approved' WHERE id = r.id;

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
    'status',           'approved');
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_send_leave_back(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_send_leave_back(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_edit_leave_dates(uuid, date, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_edit_leave_dates(uuid, date, date, text, text) TO authenticated;
