/*
  A regularisation decided at the queue must close its approval request too.

  ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
  There are two doors onto the same decision and they did different things.

    · The approval inbox sets `approval_requests.status = 'approved'`. A trigger
      projects that onto the regularisation, a second trigger applies it, and the
      request closes because the admin closed it. This door worked.

    · The regularisation queue calls `decide_regularization()`, which wrote the
      punches and recomputed the day itself and NEVER TOUCHED `approval_requests`.
      The correction landed and the request stayed `pending` — forever.

  Employee 125's row is exactly that: decided and applied at 05:07:42 on 4 Sep,
  approval request still `pending` now. Two consequences, and the second is the
  complaint we were given:

    · the request sits in every approver's inbox with nothing left to decide;
    · the employee's own requests list still says PENDING, because that list reads
      `approval_requests`. The day was corrected hours ago. From where they sit,
      "the regularisation was approved and nothing updated" is a true report.

  And the queue door carried a second defect: it inserted its punches with no
  near-duplicate check, which is the bug that put a second 09:19 scan on
  Vishnuprasad's day and made a full shift read as 2 minutes and absent. That
  guard was added to `apply_approved_regularization` and never to this path,
  because at the time nobody noticed there were two paths.

  ── THE SHAPE OF THE FIX ─────────────────────────────────────────────────────
  Stop having two implementations. `decide_regularization` now records the
  decision and lets the SAME triggers do the work the inbox door uses, so the
  guard, the attendance-lock check and the recompute are shared rather than
  duplicated. Whichever door an admin walks through, the row ends up in the same
  state, and the approval request closes either way.

  Three parts, and part 1 has to exist before part 2 is safe.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A projection must never walk a row BACKWARDS.
--
--    Once part 2 closes the request, `trg_ar__apply_detail` fires and projects
--    'approved' back onto the regularisation — which by then is 'applied'.
--    Unguarded, that overwrites the terminal state with the earlier one and
--    re-arms `apply_on_approve`. 'applied' means "approved AND carried out"; it
--    supersedes 'approved' and must survive being told the earlier word.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_approval_to_detail()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tbl    text := NEW.detail_table;
  v_labels text[];
  v_target text;
  v_sets   text[];
  v_keep   text[];
  v_rows   integer;
BEGIN
  IF v_tbl IS NULL OR NEW.detail_id IS NULL THEN
    RETURN NULL;  -- a request type with no detail row: the trail IS the record
  END IF;

  IF to_regclass('public.' || v_tbl) IS NULL THEN
    UPDATE public.approval_requests
       SET apply_error = format('detail_table %L is not a table in this database', v_tbl)
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  SELECT array_agg(e.enumlabel::text)
    INTO v_labels
    FROM information_schema.columns c
    JOIN pg_catalog.pg_type ty ON ty.typname = c.udt_name
    JOIN pg_catalog.pg_enum e  ON e.enumtypid = ty.oid
   WHERE c.table_schema = 'public'
     AND c.table_name   = v_tbl
     AND c.column_name  = 'status';

  IF v_labels IS NULL THEN
    UPDATE public.approval_requests
       SET apply_error = format('%I has no enum status column to apply a decision to', v_tbl)
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  v_target := CASE
    WHEN NEW.status::text = ANY (v_labels)                      THEN NEW.status::text
    WHEN NEW.status = 'auto_approved'
         AND 'approved'  = ANY (v_labels)                       THEN 'approved'
    WHEN NEW.status IN ('withdrawn', 'expired', 'failed')
         AND 'cancelled' = ANY (v_labels)                       THEN 'cancelled'
    WHEN NEW.status = 'escalated'
         AND 'pending'   = ANY (v_labels)                       THEN 'pending'
    ELSE NULL
  END;

  IF v_target IS NULL THEN
    UPDATE public.approval_requests
       SET apply_error = format('%I cannot be told %L — its status accepts only: %s',
                                v_tbl, NEW.status::text, array_to_string(v_labels, ', '))
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  /*
    States that already say MORE than the target does, and must therefore be left
    alone. Only one pair exists today: a detail row that has been carried out is
    'applied', and being told 'approved' afterwards would lose that.
  */
  v_keep := CASE WHEN v_target = 'approved' AND 'applied' = ANY (v_labels)
                 THEN ARRAY['applied']
                 ELSE ARRAY[]::text[]
            END;

  v_sets := ARRAY[format('status = %L', v_target)];

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=v_tbl AND column_name='decided_by') THEN
    v_sets := v_sets || format('decided_by = %L', NEW.decided_by);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=v_tbl AND column_name='decided_at') THEN
    v_sets := v_sets || format('decided_at = %L', COALESCE(NEW.decided_at, now()));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=v_tbl AND column_name='decided_comment') THEN
    v_sets := v_sets || format('decided_comment = %L', NEW.decision_comment);
  END IF;

  EXECUTE format(
    'UPDATE public.%I SET %s WHERE id = %L AND status IS DISTINCT FROM %L
       AND status::text <> ALL (%L::text[])',
    v_tbl, array_to_string(v_sets, ', '), NEW.detail_id, v_target, v_keep);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  /*
    Zero rows means the row already said this (or already says something further
    along), or there is no such row. Only the last is an error.
  */
  IF v_rows = 0 THEN
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id = %L', v_tbl, NEW.detail_id)
       INTO v_rows;
    IF v_rows = 0 THEN
      UPDATE public.approval_requests
         SET apply_error = format('no %I row with id %s', v_tbl, NEW.detail_id)
       WHERE id = NEW.id;
      RETURN NULL;
    END IF;
  END IF;

  -- Does not touch `status`, so this cannot re-enter the trigger.
  UPDATE public.approval_requests
     SET applied_at = now(), apply_error = NULL
   WHERE id = NEW.id;

  RETURN NULL;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. A decided detail row closes the request that was raised for it.
--
--    The existing `settle_approval_for_detail` handles the subject WITHDRAWING —
--    it files a 'recall'/'cancel' action and is wrong for a decision. This is its
--    counterpart for the other outcome: somebody with authority said yes or no.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_approval_for_decided_detail()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_request public.approval_requests%ROWTYPE;
  v_status  public.approval_status;
  v_actor   uuid;
BEGIN
  IF NEW.approval_request_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_request
    FROM public.approval_requests
   WHERE id = NEW.approval_request_id
   FOR UPDATE;

  /*
    Only a request still on somebody's desk. When the INBOX door was used the
    request is already 'approved' before the detail row ever reaches 'applied',
    and this must not re-decide it — that is also what stops the two triggers
    calling each other in a circle.
  */
  IF NOT FOUND OR v_request.status NOT IN ('pending', 'in_progress', 'escalated') THEN
    RETURN NULL;
  END IF;

  v_status := CASE NEW.status::text
                WHEN 'rejected' THEN 'rejected'
                ELSE 'approved'          -- 'approved' and 'applied' both
              END::public.approval_status;

  -- The decision belongs to whoever made it, not to whoever's session is open.
  v_actor := COALESCE(NEW.decided_by, app.ctx_actor_id());

  INSERT INTO public.approval_actions
    (approval_request_id, level, actor_id, action, comment, acted_at)
  VALUES
    (v_request.id, v_request.current_level, v_actor,
     CASE WHEN v_status = 'rejected' THEN 'reject' ELSE 'approve' END::public.approval_action,
     COALESCE(NULLIF(btrim(COALESCE(NEW.decision_comment, '')), ''),
              'decided on the ' || TG_TABLE_NAME || ' queue'),
     COALESCE(NEW.decided_at, now()));

  UPDATE public.approval_requests
     SET status               = v_status,
         current_approver_ids = '{}',
         decided_at           = COALESCE(NEW.decided_at, now()),
         decided_by           = COALESCE(v_actor, decided_by),
         decision_comment     = COALESCE(NEW.decision_comment, decision_comment),
         first_action_at      = COALESCE(first_action_at, NEW.decided_at, now())
   WHERE id = v_request.id;

  /*
    Take the approver's "please decide this" notification off the feed. It is
    answered now, and leaving it there is how an inbox fills with work that no
    longer exists. Dismissed rather than deleted: somebody WAS told.
  */
  UPDATE public.notifications
     SET dismissed_at = now(),
         status = CASE WHEN status = 'queued' THEN 'cancelled'::public.notification_status
                       ELSE status END
   WHERE payload->>'approval_request_id' = v_request.id::text
     AND dismissed_at IS NULL
     AND status IN ('queued','sent','delivered','opened');

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_attendance_regularizations__settle_decision
  ON public.attendance_regularizations;
CREATE TRIGGER trg_attendance_regularizations__settle_decision
AFTER UPDATE OF status ON public.attendance_regularizations
FOR EACH ROW
WHEN (NEW.approval_request_id IS NOT NULL
      AND OLD.status IS DISTINCT FROM NEW.status
      AND NEW.status IN ('approved', 'applied', 'rejected'))
EXECUTE FUNCTION public.settle_approval_for_decided_detail();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. One apply implementation, not two.
--
--    `decide_regularization` keeps its authorisation — that is the part which
--    genuinely belongs to the queue door — and then RECORDS the decision instead
--    of carrying it out. `apply_on_approve` picks it up and calls
--    `apply_approved_regularization`, which is the copy that has the
--    near-duplicate guard and the attendance-lock check. The queue door
--    therefore stops being able to create the duplicate scan at all, rather than
--    having the same guard pasted into it to drift out of step again later.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.decide_regularization(
  p_regularization_id uuid,
  p_decision text,
  p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r         public.attendance_regularizations%ROWTYPE;
  v_after   public.attendance_regularizations%ROWTYPE;
  v_actor   uuid := app.ctx_actor_id();
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_day     public.attendance_days;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the deciding actor' USING errcode = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'p_decision must be approve or reject, not %', p_decision
      USING errcode = '22023';
  END IF;

  SELECT * INTO r
    FROM public.attendance_regularizations
   WHERE id = p_regularization_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'regularization % not found', p_regularization_id USING errcode = 'P0002';
  END IF;

  -- Authorisation, re-asserted inside the definer: admin-with-scope or the
  -- employee's manager. The requester cannot decide their own request even if
  -- they hold one of those roles for themselves.
  IF NOT (
       (app.is_admin() AND app.admin_scope_covers(r.employee_id))
    OR app.is_manager_of(r.employee_id)
  ) THEN
    RAISE EXCEPTION 'not allowed to decide this regularization' USING errcode = '42501';
  END IF;
  IF r.employee_id = app.current_employee_id() THEN
    RAISE EXCEPTION 'you cannot decide your own regularization' USING errcode = '42501';
  END IF;

  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'regularization is % — only a pending request can be decided', r.status
      USING errcode = '23514';
  END IF;

  -- ── Reject: a decision the requester reads later, so the comment is the point.
  IF p_decision = 'reject' THEN
    IF v_comment IS NULL OR length(v_comment) < 10 THEN
      RAISE EXCEPTION 'rejecting needs a comment of at least 10 characters — the requester reads it'
        USING errcode = '23514';
    END IF;

    -- The settle trigger closes the approval request off the back of this.
    UPDATE public.attendance_regularizations
       SET status           = 'rejected',
           decided_by       = v_actor,
           decided_at       = now(),
           decision_comment = v_comment
     WHERE id = r.id;

    RETURN jsonb_build_object(
      'regularization_id', r.id,
      'decision',          'rejected',
      'punch_ids',         to_jsonb('{}'::uuid[]));
  END IF;

  /*
    ── Approve ────────────────────────────────────────────────────────────────
    Record it and let the triggers run, IN THIS ORDER and all inside this
    statement's transaction:

      status := 'approved'
        → trg_..._apply_on_approve  → apply_approved_regularization()
             · refuses if the day sits under a hard attendance lock
             · skips a scan the day already has within the break floor
             · status := 'applied', and recomputes the day synchronously
        → trg_..._settle_decision   → closes the approval request

    So by the time this UPDATE returns, the day is recomputed and the request is
    off the approver's desk. Nothing here is deferred to a queue.
  */
  UPDATE public.attendance_regularizations
     SET status           = 'approved',
         decided_by       = v_actor,
         decided_at       = now(),
         decision_comment = v_comment
   WHERE id = r.id;

  SELECT * INTO v_after
    FROM public.attendance_regularizations
   WHERE id = r.id;

  /*
    'approved' but not 'applied' means the apply path found nothing to do AND
    nothing already in place — a request carrying neither times nor a requested
    status. It cannot be left half-decided, so this rolls the whole thing back.
  */
  IF v_after.status <> 'applied' THEN
    RAISE EXCEPTION 'request % carries neither times nor a requested status — nothing to apply', r.id
      USING errcode = '23514';
  END IF;

  SELECT * INTO v_day
    FROM public.attendance_days
   WHERE employee_id = r.employee_id AND ist_date = r.ist_date;

  RETURN jsonb_build_object(
    'regularization_id',    r.id,
    'decision',             'applied',
    'punch_ids',            to_jsonb(coalesce(v_after.created_punch_ids, '{}'::uuid[])),
    'day_status_after',     v_day.status,
    'first_in_after',       v_day.first_in_at,
    'last_out_after',       v_day.last_out_at,
    'worked_minutes_after', v_day.total_worked_minutes);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The rows the old behaviour already stranded.
--
--    Any regularisation that reached a decision while its approval request stayed
--    open. Employee 125 is one; this is written as a sweep because the queue door
--    has been live for two days and nobody counted the clicks.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair$
DECLARE
  v_row   record;
  v_fixed integer := 0;
BEGIN
  FOR v_row IN
    SELECT r.id, r.status, r.decided_by, r.decided_at, r.decision_comment,
           ar.id AS req_id, ar.current_level, e.employee_code
      FROM public.attendance_regularizations r
      JOIN public.approval_requests ar ON ar.id = r.approval_request_id
      JOIN public.employees e ON e.id = r.employee_id
     WHERE r.status IN ('approved', 'applied', 'rejected')
       AND ar.status IN ('pending', 'in_progress', 'escalated')
  LOOP
    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, action, comment, acted_at)
    VALUES
      (v_row.req_id, v_row.current_level, v_row.decided_by,
       CASE WHEN v_row.status::text = 'rejected' THEN 'reject' ELSE 'approve' END::public.approval_action,
       COALESCE(NULLIF(btrim(COALESCE(v_row.decision_comment, '')), ''),
                'decided on the regularisation queue; request closed retrospectively'),
       COALESCE(v_row.decided_at, now()));

    UPDATE public.approval_requests
       SET status               = CASE WHEN v_row.status::text = 'rejected'
                                       THEN 'rejected'::public.approval_status
                                       ELSE 'approved'::public.approval_status END,
           current_approver_ids = '{}',
           decided_at           = COALESCE(v_row.decided_at, now()),
           decided_by           = COALESCE(v_row.decided_by, decided_by),
           decision_comment     = COALESCE(v_row.decision_comment, decision_comment),
           first_action_at      = COALESCE(first_action_at, v_row.decided_at, now())
     WHERE id = v_row.req_id;

    UPDATE public.notifications
       SET dismissed_at = now(),
           status = CASE WHEN status = 'queued' THEN 'cancelled'::public.notification_status
                         ELSE status END
     WHERE payload->>'approval_request_id' = v_row.req_id::text
       AND dismissed_at IS NULL
       AND status IN ('queued','sent','delivered','opened');

    v_fixed := v_fixed + 1;
    RAISE NOTICE 'closed the stranded request for employee % (regularisation %)',
      v_row.employee_code, v_row.id;
  END LOOP;

  RAISE NOTICE 'stranded approval requests closed: %', v_fixed;
END
$repair$;
