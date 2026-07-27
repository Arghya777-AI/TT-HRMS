-- =============================================================================
-- Migration 056 — public.decide_regularization: the missing server half of the
-- regularisation queue.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 017 documents the whole design: "Approval creates NEW punches
-- (source='system_regularization') then flips status", the engine's decision
-- table already reads applied regularizations (both the on_duty/work_from_home
-- projection and the day link), and migration 018 enqueues a recompute when
-- status becomes 'applied'. Every consumer of an applied regularization exists —
-- but NOTHING IMPLEMENTED THE APPLY. `attendance_punches` INSERT is
-- service-role-only by design, so no client, admin or manager could ever create
-- the correction punches; the queue could be read but never actually decided.
--
-- This function is that missing half, shaped like the existing
-- `apply_change_request` / `act_on_approval` definers:
--
--   * SECURITY DEFINER, so it may insert the system punches the caller cannot;
--   * authorisation re-asserted INSIDE: an admin whose scope covers the
--     employee, or the employee's manager (spec-manager: correction requests
--     are a manager decision) — nobody else, including the requester;
--   * rejection requires a comment (ck_ar__rejection_comment made it a table
--     rule already; the function enforces a useful minimum instead of one char);
--   * approval inserts the punches with the decision reason on each (the
--     ck_ap__reason_required floor for system_regularization), stamps
--     created_punch_ids / applied_at, sets status='applied', and then computes
--     the day SYNCHRONOUSLY so the caller sees the corrected day in the same
--     round trip. The AFTER UPDATE enqueue-trigger still fires; the engine is
--     idempotent per (employee, date), so the queued recompute is a harmless
--     second pass.
--
-- The decision and the punches all land inside ONE transaction: either the
-- request is applied, its punches exist and the day is recomputed — or none of
-- it happened. No state where a request says 'applied' but the punches are
-- missing (exactly the divergence cron-integrity hunts for).
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 056: decide_regularization — approve/reject with system punch creation and synchronous day recompute', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.decide_regularization(
  p_regularization_id uuid,
  p_decision          text,   -- 'approve' | 'reject'
  p_comment           text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r           public.attendance_regularizations%ROWTYPE;
  v_actor     uuid := app.ctx_actor_id();
  v_comment   text := nullif(btrim(coalesce(p_comment, '')), '');
  v_punch_ids uuid[] := '{}';
  v_punch_id  uuid;
  v_reason    text;
  v_day       public.attendance_days;
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

  -- ---------------------------------------------------------------------------
  -- Reject: a decision the requester reads later, so the comment is the point.
  -- ---------------------------------------------------------------------------
  IF p_decision = 'reject' THEN
    IF v_comment IS NULL OR length(v_comment) < 10 THEN
      RAISE EXCEPTION 'rejecting needs a comment of at least 10 characters — the requester reads it'
        USING errcode = '23514';
    END IF;

    UPDATE public.attendance_regularizations
       SET status = 'rejected',
           decided_by = v_actor,
           decided_at = now(),
           decision_comment = v_comment
     WHERE id = r.id;

    RETURN jsonb_build_object(
      'regularization_id', r.id,
      'decision', 'rejected',
      'punch_ids', to_jsonb(v_punch_ids));
  END IF;

  -- ---------------------------------------------------------------------------
  -- Approve: create the correction punches, mark applied, recompute the day.
  -- ---------------------------------------------------------------------------
  -- The punch reason satisfies ck_ap__reason_required (>= 10 chars) and names
  -- the request, so the punch log reads as evidence on its own.
  v_reason := format('regularization %s approved%s',
                     r.id,
                     CASE WHEN v_comment IS NULL THEN '' ELSE ': ' || v_comment END);

  IF r.requested_first_in_at IS NOT NULL THEN
    INSERT INTO public.attendance_punches
      (employee_id, punched_at, direction, source, reason, recorded_by, approval_request_id)
    VALUES
      (r.employee_id, r.requested_first_in_at, 'in', 'system_regularization',
       v_reason, v_actor, r.approval_request_id)
    RETURNING id INTO v_punch_id;
    v_punch_ids := v_punch_ids || v_punch_id;
  END IF;

  IF r.requested_last_out_at IS NOT NULL THEN
    INSERT INTO public.attendance_punches
      (employee_id, punched_at, direction, source, reason, recorded_by, approval_request_id)
    VALUES
      (r.employee_id, r.requested_last_out_at, 'out', 'system_regularization',
       v_reason, v_actor, r.approval_request_id)
    RETURNING id INTO v_punch_id;
    v_punch_ids := v_punch_ids || v_punch_id;
  END IF;

  -- A pure status claim (on_duty / work_from_home) legitimately creates no
  -- punches: the engine's decision table reads requested_status off the applied
  -- request itself (migration 018 §11).
  IF array_length(v_punch_ids, 1) IS NULL
     AND r.requested_status IS NULL THEN
    RAISE EXCEPTION 'request % carries neither times nor a requested status — nothing to apply', r.id
      USING errcode = '23514';
  END IF;

  UPDATE public.attendance_regularizations
     SET status = 'applied',
         decided_by = v_actor,
         decided_at = now(),
         decision_comment = v_comment,
         applied_at = now(),
         created_punch_ids = CASE WHEN array_length(v_punch_ids, 1) IS NULL
                                  THEN NULL ELSE v_punch_ids END
   WHERE id = r.id;

  -- Synchronous recompute: the admin sees the corrected day in this round trip.
  -- The enqueue trigger's queued pass is a harmless idempotent repeat.
  v_day := public.compute_attendance_day(r.employee_id, r.ist_date, v_reason);

  RETURN jsonb_build_object(
    'regularization_id', r.id,
    'decision', 'applied',
    'punch_ids', to_jsonb(v_punch_ids),
    'day_status_after', v_day.status,
    'first_in_after', v_day.first_in_at,
    'last_out_after', v_day.last_out_at,
    'worked_minutes_after', v_day.total_worked_minutes);
END;
$$;

REVOKE ALL ON FUNCTION public.decide_regularization(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_regularization(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.decide_regularization(uuid, text, text) IS
  'Approve (create system_regularization punches + apply + synchronous recompute) or reject (comment mandatory) a pending regularization. Admin-with-scope or the employee''s manager; never the requester. One transaction: applied means the punches exist.';

COMMIT;
