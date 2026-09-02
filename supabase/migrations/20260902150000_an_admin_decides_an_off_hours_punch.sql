-- ============================================================================
-- STEP 4: an administrator approves or rejects an off-hours punch.
--
-- ── WHY A FUNCTION AND NOT A POLICY ────────────────────────────────────────
-- `attendance_punches` has NO update policy of any kind — nobody can change a punch
-- through the API. Every write goes through a SECURITY DEFINER function that checks
-- its own authority, which is how `record_manual_punch` works, and adding an update
-- policy to let an admin tick a box would open the whole row to them: the instant,
-- the descriptor metadata, the geofence verdict, the match confidence.
--
-- So the decision is a function that changes exactly two things and nothing else.
--
-- ── WHAT APPROVING AND REJECTING EACH MEAN ──────────────────────────────────
-- APPROVE stamps `approved_at` / `approved_by`. The punch was always counted in the
-- day's worked minutes; approving is what stops it being HELD OUT of the monthly
-- total. Nothing about the punch itself changes.
--
-- REJECT voids it, with the reason recorded. The engine ignores voided punches, so
-- the hours leave the day as well as the month — which is the honest outcome of "these
-- hours were not worked". It is not a delete: `is_voided`, `voided_by`, `voided_at`
-- and `void_reason` all remain, so months later somebody can see the punch existed,
-- who refused it and why.
--
-- ── THE DAY IS RECOMPUTED, IN THE SAME TRANSACTION ──────────────────────────
-- Otherwise the decision would be recorded and the figures would not move until
-- something else happened to touch the day. Wrapped so a compute fault cannot make a
-- punch undecidable — the row is enqueued as well, and `attendance_queue_drain` runs
-- every minute, so the worst case is "correct within a minute".
--
-- ── A DECISION IS MADE ONCE ─────────────────────────────────────────────────
-- Re-deciding is refused rather than silently ignored. An admin who clicks approve on
-- a punch a colleague rejected a minute earlier must be told, not left believing they
-- released hours that are voided.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.decide_off_hours_punch(
  p_punch_id uuid,
  p_approve  boolean,
  p_reason   text
) RETURNS public.attendance_punches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_punch public.attendance_punches;
  v_row   public.attendance_punches;
  v_actor uuid := app.ctx_actor_id();
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can decide an off-hours punch.'
      USING errcode = '42501';
  END IF;

  /* Ten characters, matching every other reason this system records against a
     decision. A rejection especially: the employee is entitled to know why. */
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION
      'Say why, in a sentence. The employee sees this and an auditor reads it months from now.'
      USING errcode = '23514';
  END IF;

  SELECT * INTO v_punch FROM public.attendance_punches WHERE id = p_punch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such punch.' USING errcode = 'P0002';
  END IF;

  IF NOT app.admin_scope_covers(v_punch.employee_id) THEN
    RAISE EXCEPTION 'That employee is outside your administrative scope.'
      USING errcode = '42501';
  END IF;

  IF NOT v_punch.requires_approval THEN
    RAISE EXCEPTION 'That punch does not need approving — it was taken inside the shift window.'
      USING errcode = '23514';
  END IF;

  IF v_punch.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'That punch was already approved.' USING errcode = '23505';
  END IF;
  IF v_punch.is_voided THEN
    RAISE EXCEPTION 'That punch was already rejected.' USING errcode = '23505';
  END IF;

  PERFORM set_config('app.reason',
    (CASE WHEN p_approve THEN 'off-hours punch approved: ' ELSE 'off-hours punch rejected: ' END)
    || btrim(p_reason), true);

  IF p_approve THEN
    UPDATE public.attendance_punches
       SET approved_at = now(), approved_by = v_actor
     WHERE id = p_punch_id
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.attendance_punches
       SET is_voided = true, voided_by = v_actor, voided_at = now(),
           void_reason = btrim(p_reason)
     WHERE id = p_punch_id
    RETURNING * INTO v_row;
  END IF;

  -- Queued regardless, so a compute fault below cannot leave the figures stale.
  PERFORM public.enqueue_recompute(
    v_punch.employee_id, v_punch.effective_date,
    CASE WHEN p_approve THEN 'off_hours_approved' ELSE 'off_hours_rejected' END,
    'attendance_punches', p_punch_id, 2::smallint);

  BEGIN
    PERFORM public.compute_attendance_day(
      v_punch.employee_id, v_punch.effective_date,
      CASE WHEN p_approve THEN 'off_hours_approved' ELSE 'off_hours_rejected' END,
      true);
  EXCEPTION WHEN OTHERS THEN
    -- Swallowed on purpose: the decision is recorded and the row is queued. A punch
    -- must never become undecidable because a recompute failed.
    NULL;
  END;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) IS
  'Approve (stamps approved_at, releasing the hours into the monthly total) or reject (voids the punch, so the hours leave the day too) an off-hours web punch. Admin only, within scope, once. Recomputes the day in the same transaction and queues it as a fallback.';

REVOKE ALL ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) TO authenticated;
