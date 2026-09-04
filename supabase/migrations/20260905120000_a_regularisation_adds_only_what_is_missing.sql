-- ============================================================================
-- A regularisation adds only the scans that are missing.
--
-- ── THE BUG, AND IT WAS MINE ────────────────────────────────────────────────
-- Vishnuprasad Palled (125) worked 2 September, scanned in at 09:19, and forgot to
-- scan out. He filed a `missed_out` regularisation for 09:22-17:34; it was
-- approved; and his day came out as ABSENT with TWO MINUTES worked.
--
-- `apply_approved_regularization` created BOTH punches from the requested times
-- without looking at what the day already had. So the day held three scans:
--
--     09:19:31  his own, at the gate
--     09:22:00  created — three minutes after the one above
--     17:34:00  created
--
-- The engine's break rule deducts the gaps at EVEN positions. With two scans those
-- are none; with three, position 2 is 09:22 -> 17:34, and his entire working day
-- was deducted as a break. 494 minutes of span, 492 deducted, 2 left, and a day
-- marked absent for somebody who was there for eight hours.
--
-- The engine is not at fault: its own comment states the assumption plainly — the
-- parity rule holds "if the punch list has no duplicate double-scans", which was
-- true of all 1,185 punches when it was written. My apply step then started
-- creating exactly those.
--
-- ── WHY NOT JUST HONOUR `regularization_kind` ───────────────────────────────
-- Because employees label it from a dropdown and get it wrong, and the data already
-- shows both mistakes:
--
--     125  said `missed_out`, HAD 1 scan   -> needed only the out   (created both)
--     117  said `missed_in`,  HAD 0 scans  -> needed BOTH           (kind says one)
--     128  said `missed_in`,  HAD 2 scans  -> needed both, far away (fine by luck)
--
-- Trusting the label would have fixed 125 and broken 117. So the rule is about the
-- DAY, not the dropdown: create a scan only where the day has none near that time.
--
-- ── THE RULE ────────────────────────────────────────────────────────────────
-- A requested time is skipped when a live scan already sits within
-- `min_break_minutes_to_count` of it — fifteen minutes on every policy here. That
-- is the same threshold the engine uses to decide a gap is even worth calling a
-- break, so anything inside it could never have been one, and the gate's own dwell
-- rule already refuses to write a re-scan within five minutes. A scan that close is
-- a duplicate by every definition this system already holds.
-- ============================================================================

SELECT set_config('app.reason',
  'a regularisation creates only the scans a day is missing: creating one three minutes from an existing scan made the punch count odd and the break rule deducted a whole working day',
  true);

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
  v_near      integer;
  v_skipped   text[] := '{}';
BEGIN
  SELECT * INTO r
    FROM public.attendance_regularizations
   WHERE id = p_regularization_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'regularization % not found', p_regularization_id USING errcode = 'P0002';
  END IF;

  IF r.status = 'applied' OR r.created_punch_ids IS NOT NULL THEN
    RETURN jsonb_build_object('regularization_id', r.id, 'decision', 'already_applied',
                              'punch_ids', to_jsonb(coalesce(r.created_punch_ids, '{}'::uuid[])));
  END IF;
  IF r.status <> 'approved' THEN
    RETURN jsonb_build_object('regularization_id', r.id, 'decision', 'not_approved',
                              'status', r.status::text);
  END IF;

  v_actor := coalesce(r.decided_by, app.ctx_actor_id());

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

  /*
    How close counts as the same scan. The policy's own break floor, because a gap
    smaller than that is one the engine would never call a break anyway.
  */
  SELECT COALESCE(ap.min_break_minutes_to_count, 15) INTO v_near
    FROM public.attendance_policies ap
   WHERE ap.id = public.resolve_policy('attendance_policy', r.employee_id, r.ist_date);
  v_near := COALESCE(v_near, 15);

  v_reason := format('regularization %s approved%s', r.id,
                     CASE WHEN nullif(btrim(coalesce(r.decision_comment, '')), '') IS NULL
                          THEN '' ELSE ': ' || btrim(r.decision_comment) END);

  -- ── The in-scan, unless the day already has one at about that time ────────
  IF r.requested_first_in_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.attendance_punches p
                WHERE p.employee_id = r.employee_id
                  AND p.effective_date = r.ist_date
                  AND p.is_voided = false
                  AND abs(extract(epoch FROM (p.punched_at - r.requested_first_in_at))) < v_near * 60)
    THEN
      v_skipped := v_skipped || 'in_already_present'::text;
    ELSE
      INSERT INTO public.attendance_punches
        (employee_id, punched_at, direction, source, reason, recorded_by, approval_request_id)
      VALUES (r.employee_id, r.requested_first_in_at, 'in', 'system_regularization',
              v_reason, v_actor, r.approval_request_id)
      RETURNING id INTO v_punch_id;
      v_punch_ids := v_punch_ids || v_punch_id;
    END IF;
  END IF;

  -- ── And the out-scan, on the same rule ────────────────────────────────────
  IF r.requested_last_out_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.attendance_punches p
                WHERE p.employee_id = r.employee_id
                  AND p.effective_date = r.ist_date
                  AND p.is_voided = false
                  AND abs(extract(epoch FROM (p.punched_at - r.requested_last_out_at))) < v_near * 60)
    THEN
      v_skipped := v_skipped || 'out_already_present'::text;
    ELSE
      INSERT INTO public.attendance_punches
        (employee_id, punched_at, direction, source, reason, recorded_by, approval_request_id)
      VALUES (r.employee_id, r.requested_last_out_at, 'out', 'system_regularization',
              v_reason, v_actor, r.approval_request_id)
      RETURNING id INTO v_punch_id;
      v_punch_ids := v_punch_ids || v_punch_id;
    END IF;
  END IF;

  /*
    Nothing created AND nothing skipped means there was nothing to apply. But nothing
    created BECAUSE both were already there is a SUCCESS — the day already said what
    the employee asked it to say — and it must still be marked applied, or the
    approval sits forever looking undone.
  */
  IF array_length(v_punch_ids, 1) IS NULL
     AND array_length(v_skipped, 1) IS NULL
     AND r.requested_status IS NULL THEN
    RETURN jsonb_build_object('regularization_id', r.id, 'decision', 'nothing_to_apply');
  END IF;

  UPDATE public.attendance_regularizations
     SET status            = 'applied',
         applied_at        = now(),
         created_punch_ids = CASE WHEN array_length(v_punch_ids, 1) IS NULL
                                  THEN NULL ELSE v_punch_ids END
   WHERE id = r.id;

  v_day := public.compute_attendance_day(r.employee_id, r.ist_date, v_reason);

  RETURN jsonb_build_object(
    'regularization_id',     r.id,
    'decision',              'applied',
    'punch_ids',             to_jsonb(v_punch_ids),
    'skipped',               to_jsonb(v_skipped),
    'day_status_after',      v_day.status,
    'worked_minutes_after',  v_day.total_worked_minutes,
    'overtime_minutes_after',v_day.overtime_minutes);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Repair the day this broke
-- ---------------------------------------------------------------------------
/*
  The spurious 09:22 scan is voided, not deleted — `attendance_punches` is append-only
  and its history is the point. `app.allow_punch_void` is the gate the append-only
  trigger opens for exactly this, and it opens ONLY the four void columns.

  Targeted by the two facts that identify it: created by a regularisation, and within
  the near-duplicate window of a scan that already existed. Written as a set so it
  repairs any other day the same defect reached, and it currently matches one row.
*/
DO $do$
DECLARE v record; n integer := 0; v_actor uuid;
BEGIN
  /*
    `ck_ap__void_fields` requires the four void columns to be consistent, so `voided_by`
    cannot be null. `app.ctx_actor_id()` is null when a migration runs as postgres with no
    session actor — the constraint caught it rather than storing a half-void — so the repair
    names the administrator who approved these regularisations in the first place.
  */
  SELECT decided_by INTO v_actor
    FROM public.attendance_regularizations
   WHERE decided_by IS NOT NULL
   ORDER BY decided_at DESC
   LIMIT 1;
  v_actor := COALESCE(app.ctx_actor_id(), v_actor);
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'no actor available to attribute the void to';
  END IF;

  PERFORM set_config('app.allow_punch_void', 'on', true);

  FOR v IN
    SELECT p.id, p.employee_id, p.effective_date, p.punched_at
      FROM public.attendance_punches p
     WHERE p.source = 'system_regularization'
       AND p.is_voided = false
       AND EXISTS (
         SELECT 1 FROM public.attendance_punches q
          WHERE q.employee_id = p.employee_id
            AND q.effective_date = p.effective_date
            AND q.id <> p.id
            AND q.is_voided = false
            AND q.source <> 'system_regularization'
            AND abs(extract(epoch FROM (q.punched_at - p.punched_at))) < 15 * 60)
  LOOP
    UPDATE public.attendance_punches
       SET is_voided = true,
           voided_at = now(),
           voided_by = v_actor,
           void_reason = 'duplicate of an existing scan; created by a regularisation before it checked'
     WHERE id = v.id;
    n := n + 1;
    RAISE NOTICE 'voided duplicate % for % on %', v.id, v.employee_id, v.effective_date;
  END LOOP;

  PERFORM set_config('app.allow_punch_void', 'off', true);
  RAISE NOTICE 'voided % duplicate scan(s)', n;
END
$do$;

/* Recompute every day a regularisation has touched, so the repair is visible. */
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT employee_id, ist_date
             FROM public.attendance_regularizations WHERE status = 'applied'
  LOOP
    PERFORM public.compute_attendance_day(r.employee_id, r.ist_date,
              'repair: a regularisation had created a scan duplicating an existing one');
  END LOOP;
END
$do$;
