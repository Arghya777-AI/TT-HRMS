-- ============================================================================
-- An approved regularisation applies itself, whichever screen approved it.
--
-- ── WHAT WENT WRONG, REPORTED AS "I APPROVED IT AND NOTHING IS UPDATED" ─────
-- Two employees attended an 8 pm client meeting on 2 Sep 2026, could not punch for
-- it, and filed regularisations for 20:00–21:37 and 20:00–21:19 IST. HR approved
-- both. Their attendance did not move, and neither did their hours.
--
-- Nothing was broken in the engine and nothing was refused. There are simply TWO
-- routes to a decision and only one of them performs the effect:
--
--   /admin/regularisations  -> decide_regularization(), which creates the correction
--                              punches, sets status='applied', stamps applied_at and
--                              created_punch_ids, and recomputes the day. Correct.
--
--   /admin/approvals        -> act_on_approval() settles the approval_request and the
--                              generic settle path writes status='approved' onto the
--                              detail row. No punches. No applied_at. No recompute.
--
-- HR used the second one. So `attendance_regularizations` held status='approved',
-- decided_by and decided_at set, and applied_at NULL, created_punch_ids NULL —
-- verified on both live rows.
--
-- Two further things made it invisible rather than noisy:
--   * `attendance_regularizations_enqueue_recompute` fires only on status='applied',
--     so not even a recompute was queued.
--   * `compute_attendance_day` reads regularisations only WHERE status='applied',
--     and reads only `requested_status` from them — the requested TIMES exist to
--     become punches, and nothing had created any.
--
-- And the rows were stuck: decide_regularization() refuses anything not 'pending',
-- so the proper function could no longer be pointed at them either.
--
-- ── THE FIX: PUT THE EFFECT ON THE ROW, NOT ON A SCREEN ─────────────────────
-- A trigger on the detail row itself. Any route that marks a regularisation
-- 'approved' now applies it, including routes nobody has written yet. That is the
-- opposite of adding the missing call to one more screen, which would leave the
-- next screen to make the same mistake.
--
-- decide_regularization() is untouched and does NOT double-apply: it transitions
-- straight to 'applied', so the 'approved' trigger never sees its row.
-- ============================================================================

SELECT set_config('app.reason',
  'an approved attendance regularisation now applies itself whichever screen approved it; two live rows approved through the generic inbox created no punches and never reached the attendance day',
  true);

-- ---------------------------------------------------------------------------
-- 1. The apply step, callable and idempotent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_approved_regularization(p_regularization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  r           public.attendance_regularizations%ROWTYPE;
  v_punch_ids uuid[] := '{}';
  v_punch_id  uuid;
  v_reason    text;
  v_actor     uuid;
  v_day       public.attendance_days;
  v_locked    record;
BEGIN
  SELECT * INTO r
    FROM public.attendance_regularizations
   WHERE id = p_regularization_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'regularization % not found', p_regularization_id USING errcode = 'P0002';
  END IF;

  /*
    IDEMPOTENT, and it has to be: this is reachable from a trigger, from a backfill
    and by hand. Anything already applied returns its own answer rather than
    inserting a second pair of punches, which would widen the day's span with
    phantom scans nobody made.
  */
  IF r.status = 'applied' OR r.created_punch_ids IS NOT NULL THEN
    RETURN jsonb_build_object('regularization_id', r.id, 'decision', 'already_applied',
                              'punch_ids', to_jsonb(coalesce(r.created_punch_ids, '{}'::uuid[])));
  END IF;
  IF r.status <> 'approved' THEN
    RETURN jsonb_build_object('regularization_id', r.id, 'decision', 'not_approved',
                              'status', r.status::text);
  END IF;

  /*
    The approver is the actor to record, not whoever happens to be connected when a
    backfill runs. `decided_by` is already stamped by the route that approved it.
  */
  v_actor := coalesce(r.decided_by, app.ctx_actor_id());

  -- ── A finalised period is not reopened by an approval ────────────────────
  -- Same rule `record_manual_punch` enforces. Raising is deliberate: an approval
  -- that cannot take effect must fail where somebody can read it, because an
  -- approval with no effect is the entire defect this migration exists for.
  SELECT al.lock_kind, al.reason, al.from_date, al.to_date
    INTO v_locked
    FROM public.attendance_locks al
    JOIN public.employees e ON e.id = r.employee_id
   WHERE al.unlocked_at IS NULL
     AND al.lock_kind = 'hard'
     AND r.ist_date BETWEEN al.from_date AND al.to_date
     AND (al.scope = 'company'
          OR (al.scope = 'employee'   AND al.employee_id   = r.employee_id)
          OR (al.scope = 'department' AND al.department_id = e.department_id)
          OR (al.scope = 'location'   AND al.location_id   = e.location_id))
   ORDER BY al.locked_at DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Attendance for % is locked (% to %): %. Approving this regularisation would change a settled day.',
      r.ist_date, v_locked.from_date, v_locked.to_date, v_locked.reason
      USING errcode = '42501';
  END IF;

  -- `ck_ap__reason_required` wants >= 10 characters on a system_regularization punch.
  -- Naming the request makes the punch log readable as evidence on its own.
  v_reason := format('regularization %s approved%s', r.id,
                     CASE WHEN nullif(btrim(coalesce(r.decision_comment, '')), '') IS NULL
                          THEN '' ELSE ': ' || btrim(r.decision_comment) END);

  IF r.requested_first_in_at IS NOT NULL THEN
    INSERT INTO public.attendance_punches
      (employee_id, punched_at, direction, source, reason, recorded_by, approval_request_id)
    VALUES (r.employee_id, r.requested_first_in_at, 'in', 'system_regularization',
            v_reason, v_actor, r.approval_request_id)
    RETURNING id INTO v_punch_id;
    v_punch_ids := v_punch_ids || v_punch_id;
  END IF;

  IF r.requested_last_out_at IS NOT NULL THEN
    INSERT INTO public.attendance_punches
      (employee_id, punched_at, direction, source, reason, recorded_by, approval_request_id)
    VALUES (r.employee_id, r.requested_last_out_at, 'out', 'system_regularization',
            v_reason, v_actor, r.approval_request_id)
    RETURNING id INTO v_punch_id;
    v_punch_ids := v_punch_ids || v_punch_id;
  END IF;

  /*
    A pure status claim (on_duty / work_from_home) legitimately creates no punches —
    the engine reads `requested_status` off the applied row. A request with NEITHER
    times NOR a status has nothing to apply; it is left at 'approved' rather than
    raised, because raising here would roll back an approval somebody already made
    over a malformed row they cannot fix from the same screen.
  */
  IF array_length(v_punch_ids, 1) IS NULL AND r.requested_status IS NULL THEN
    RETURN jsonb_build_object('regularization_id', r.id, 'decision', 'nothing_to_apply');
  END IF;

  UPDATE public.attendance_regularizations
     SET status            = 'applied',
         applied_at        = now(),
         created_punch_ids = CASE WHEN array_length(v_punch_ids, 1) IS NULL
                                  THEN NULL ELSE v_punch_ids END
   WHERE id = r.id;

  -- Synchronous, so the approver sees the corrected day in the same round trip.
  -- The enqueue trigger's queued pass is a harmless idempotent repeat.
  v_day := public.compute_attendance_day(r.employee_id, r.ist_date, v_reason);

  RETURN jsonb_build_object(
    'regularization_id',     r.id,
    'decision',              'applied',
    'punch_ids',             to_jsonb(v_punch_ids),
    'day_status_after',      v_day.status,
    'worked_minutes_after',  v_day.total_worked_minutes,
    'overtime_minutes_after',v_day.overtime_minutes);
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_approved_regularization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_approved_regularization(uuid) FROM anon;
-- Reached through the trigger, not called from a browser. `authenticated` keeps no
-- grant: the two decision screens go through act_on_approval / decide_regularization.
REVOKE ALL ON FUNCTION public.apply_approved_regularization(uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. Any route that approves one, applies it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_regularizations_apply_on_approve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  -- Only the transition INTO 'approved', so re-saving an approved row is inert.
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    PERFORM public.apply_approved_regularization(NEW.id);
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_attendance_regularizations__apply_on_approve
  ON public.attendance_regularizations;

/*
  AFTER UPDATE, and ordered after the settle trigger by name: `__apply_on_approve`
  sorts after `__settle_approval`, and Postgres fires same-event triggers in name
  order. The apply reads its own row with FOR UPDATE, so it sees the committed
  status either way.
*/
CREATE TRIGGER trg_attendance_regularizations__apply_on_approve
AFTER UPDATE OF status ON public.attendance_regularizations
FOR EACH ROW
EXECUTE FUNCTION public.attendance_regularizations_apply_on_approve();

COMMENT ON FUNCTION public.apply_approved_regularization(uuid) IS
  'Turns an approved regularisation into real punches and recomputes the day. Idempotent. Reached from trg_attendance_regularizations__apply_on_approve so every approval route applies the effect, not just /admin/regularisations.';

-- ---------------------------------------------------------------------------
-- 3. Repair the rows approved through the inbox before this existed
-- ---------------------------------------------------------------------------
/*
  The trigger fires on the TRANSITION into 'approved', so rows already sitting there
  need the apply called by hand once. Two such rows existed on 3 Sep 2026 — the 8 pm
  meeting on 2 Sep for two people — and both are repaired by this block:

    Monalisa bhowmick   worked 489 -> 586 minutes, overtime 0 -> 75, punches 2 -> 4
    Deepesh Kumar Jain  worked   0 ->  79 minutes (the day was on_leave; the engine
                                  flags `worked_on_leave` and leaves the status alone)

  `apply_approved_regularization` is idempotent, so this block is safe to re-run and
  safe on a database where nothing is stuck.
*/
DO $do$
DECLARE r record; v jsonb;
BEGIN
  FOR r IN SELECT id FROM public.attendance_regularizations
            WHERE status = 'approved' AND applied_at IS NULL ORDER BY created_at
  LOOP
    v := public.apply_approved_regularization(r.id);
    RAISE NOTICE 'backfilled %: %', r.id, v->>'decision';
  END LOOP;
END
$do$;
