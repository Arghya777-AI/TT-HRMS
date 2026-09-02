-- ============================================================================
-- STEP 4 (part 2): the append-only guard learns about approval.
--
-- ── WHAT THE GUARD DOES, AND WHY IT REFUSED ─────────────────────────────────
-- `attendance_punches` is append-only: `attendance_punches_append_only` blocks every
-- UPDATE unless `app.allow_punch_void` is on, and even then permits ONLY the four
-- void columns. That is a good rule and the reason a punch cannot be quietly edited
-- after the fact.
--
-- It also blocked stamping `approved_at`, which is the one other legitimate change a
-- punch can undergo. Discovered by the approve path failing against it — the guard was
-- doing exactly its job.
--
-- ── TWO GATES, NOT ONE WIDER GATE ───────────────────────────────────────────
-- The obvious fix is to add `approved_at` / `approved_by` to the existing void list.
-- That would mean any code holding `allow_punch_void` could also approve, and anything
-- approving could also void — one setting granting two unrelated powers, which is how
-- an escape hatch becomes a hole.
--
-- So approval gets its own: `app.allow_punch_approval`. Each gate permits only its own
-- columns, and a caller that sets one cannot touch the other's. Everything else about
-- a punch stays immutable, and DELETE is still refused outright.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.attendance_punches_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_void_cols    text[] := ARRAY['is_voided','voided_by','voided_at','void_reason'];
  /* The only other change a stored punch may undergo: an administrator's decision. */
  v_approve_cols text[] := ARRAY['approved_at','approved_by'];
  /*
    GENERATED ALWAYS columns are NULL in NEW inside a BEFORE trigger while OLD holds the
    stored value, so leaving them in the diff made it unsatisfiable. They cannot be written
    by anyone, so ignoring them here removes noise and no protection. Keep this list in step
    with the table: ist_date, ist_time and effective_date are generated as of migration 089.
  */
  v_generated    text[] := ARRAY['ist_date','ist_time','effective_date'];
  v_void_on      boolean := coalesce(current_setting('app.allow_punch_void', true), '') = 'on';
  v_approve_on   boolean := coalesce(current_setting('app.allow_punch_approval', true), '') = 'on';
  v_allowed      text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance_punches is append-only (void instead of delete)'
      USING errcode = '0A000';
  END IF;

  IF NOT v_void_on AND NOT v_approve_on THEN
    RAISE EXCEPTION 'attendance_punches is append-only (voids and approvals go through their own functions)'
      USING errcode = '0A000';
  END IF;

  /*
    Each gate opens ONLY its own columns. A caller holding `allow_punch_void` cannot
    stamp an approval, and a caller holding `allow_punch_approval` cannot void.
  */
  v_allowed := v_generated
             || (CASE WHEN v_void_on    THEN v_void_cols    ELSE ARRAY[]::text[] END)
             || (CASE WHEN v_approve_on THEN v_approve_cols ELSE ARRAY[]::text[] END);

  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'this update may change only: %', array_to_string(v_allowed, ', ')
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

/* The decision function opens the gate it needs, and only for its own statement. */
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
    -- Approving stamps a decision. The punch was always in the day's worked minutes;
    -- this is what stops it being held OUT of the monthly total.
    PERFORM set_config('app.allow_punch_approval', 'on', true);
    UPDATE public.attendance_punches
       SET approved_at = now(), approved_by = v_actor
     WHERE id = p_punch_id
    RETURNING * INTO v_row;
    PERFORM set_config('app.allow_punch_approval', 'off', true);
  ELSE
    /*
      Rejecting VOIDS it, so the hours leave the day as well as the month — the honest
      outcome of "these hours were not worked". Not a delete: the void columns keep who
      refused it and why.
    */
    PERFORM set_config('app.allow_punch_void', 'on', true);
    UPDATE public.attendance_punches
       SET is_voided = true, voided_by = v_actor, voided_at = now(),
           void_reason = btrim(p_reason)
     WHERE id = p_punch_id
    RETURNING * INTO v_row;
    PERFORM set_config('app.allow_punch_void', 'off', true);
  END IF;

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
    -- The decision is recorded and the day is queued; a punch must never become
    -- undecidable because a recompute failed.
    NULL;
  END;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.decide_off_hours_punch(uuid, boolean, text) TO authenticated;
