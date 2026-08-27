-- ==========================================================================
-- A pre-joining employee can have a punch recorded by hand.
--
-- `record_manual_punch` refused `pre_joining` alongside `exited`, and it was the
-- wrong company for it. `pre_joining` is the Add Employee wizard's DEFAULT and the
-- column's (migration 008), so it is the state every employee added through the app
-- STARTS in -- not an edge case somebody chose.
--
-- What that produced in production: four employees who could not punch anywhere.
-- Their faces matched at the gate at 0.85-0.92 confidence against a 0.62 threshold
-- and every punch was refused, logged in `secure.face_match_log` as
-- `employment_status=pre_joining`. Zero punches were ever written for them. From the
-- outside it read as a broken camera.
--
-- The venue's decision, and the same reasoning that already admitted `absconding` and
-- `on_long_leave` to the punch paths: somebody who turns up is a fact HR needs. A
-- paperwork discrepancy reconciles far better from a recorded scan than from a
-- missing one -- refusing the punch never prevented the shift, it only lost the
-- evidence that it happened. `kiosk-punch` and `attendance-self-punch` were changed
-- to match; this function was the last gate still closed, which meant the one
-- correction route was shut for exactly the people who needed it.
--
-- `retired` takes the freed slot. It was never checked here, so a manual punch could
-- be recorded against somebody retired -- the same class of mistake in the other
-- direction. `exited` and `retired` are decisions somebody made; `pre_joining` is a
-- default nobody set, and that is the whole distinction this function now draws.
--
-- APPLIED BY HAND FIRST. This was run in the SQL Editor against the live database on
-- 2026-08-27 and verified with `pg_get_functiondef` (pre_joining absent, SECURITY
-- DEFINER intact, one overload). The statement below is the same text, so the file
-- records what is already deployed rather than proposing it. `CREATE OR REPLACE` is
-- idempotent; re-running it is a no-op.
--
-- Everything else about the function is UNCHANGED from what pg_get_functiondef
-- returned: the admin check, the reason-length rule, the direction whitelist, the
-- hard-lock check, the partition-window message, the always-on review flag, and the
-- deliberate absence of a recompute enqueue.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.record_manual_punch(p_employee_id uuid, p_punched_at timestamp with time zone, p_reason text, p_direction text DEFAULT 'undetermined'::text, p_note text DEFAULT NULL::text)
 RETURNS attendance_punches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
DECLARE
  v_emp    public.employees%ROWTYPE;
  v_date   date;
  v_locked record;
  v_row    public.attendance_punches%ROWTYPE;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can record a manual punch.'
      USING errcode = '42501';
  END IF;

  /* `ck_ap__reason_required` says the same thing; saying it here gets the person
     a sentence instead of a constraint name. */
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION
      'Say why the camera was not used, in a sentence. An auditor reads this months from now.'
      USING errcode = '23514';
  END IF;

  IF p_direction NOT IN ('in', 'out', 'undetermined') THEN
    RAISE EXCEPTION 'Unknown direction %.', p_direction USING errcode = '22023';
  END IF;

  SELECT * INTO v_emp FROM public.employees
   WHERE id = p_employee_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such employee.' USING errcode = 'P0002';
  END IF;

  /* `pre_joining` was refused here alongside `exited`, and it was the wrong company
     for it. It is the Add Employee wizard's DEFAULT and the column's, so it is the
     state every employee added through the app starts in -- not an edge case. The two
     punch paths (kiosk-punch, attendance-self-punch) now accept it; an admin adding a
     punch by hand was the last gate that did not, which left the one correction route
     closed for exactly the people who needed it.

     `exited` and `retired` stay refused: those are decisions somebody made, not a
     default nobody set. */
  IF v_emp.employment_status IN ('exited', 'retired') THEN
    RAISE EXCEPTION
      'That person is not employed on this date (%), so a scan for them would be attendance nobody worked.',
      v_emp.employment_status
      USING errcode = '23514';
  END IF;

  /* `ck_ap__not_future` allows five minutes of clock skew; beyond that a future
     punch is somebody typing the wrong date, and it would sit in the day's
     calculation until a human noticed. */
  IF p_punched_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'That time is in the future. A punch records something that has happened.'
      USING errcode = '23514';
  END IF;

  v_date := util.ist_date(p_punched_at);

  -- ── 1. A finalised period is not reopened by a form ────────────────────────
  SELECT al.lock_kind, al.reason, al.from_date, al.to_date
    INTO v_locked
    FROM public.attendance_locks al
   WHERE al.unlocked_at IS NULL
     AND al.lock_kind = 'hard'
     AND v_date BETWEEN al.from_date AND al.to_date
     AND (al.scope = 'company'
          OR (al.scope = 'employee'   AND al.employee_id   = p_employee_id)
          OR (al.scope = 'department' AND al.department_id = v_emp.department_id)
          OR (al.scope = 'location'   AND al.location_id   = v_emp.location_id))
   ORDER BY al.locked_at DESC
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Attendance for % is locked (% to %): %. Recording a punch would change a day that has already been settled — ask whoever locked it.',
      v_date, v_locked.from_date, v_locked.to_date, v_locked.reason
      USING errcode = '42501';
  END IF;

  -- ── 2. The insert ─────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.attendance_punches
      (employee_id, punched_at, direction, source, reason, operator_note,
       recorded_by, needs_review)
    VALUES
      (p_employee_id, p_punched_at, p_direction::public.punch_direction, 'manual_admin',
       btrim(p_reason),
       CASE WHEN btrim(COALESCE(p_note, '')) = '' THEN NULL ELSE btrim(p_note) END,
       app.ctx_actor_id(),
       /*
         FLAGGED FOR REVIEW, always. A punch nobody's face was seen for is exactly
         the row an auditor should find first, and the flag costs nothing to carry.
       */
       true)
    RETURNING * INTO v_row;
  EXCEPTION
    WHEN check_violation THEN
      RAISE;
    WHEN OTHERS THEN
      /*
         The partition case. `attendance_punches` is partitioned monthly from last
         month to +3 (031's maintenance job), and an insert outside that raises
         23514 "no partition of relation found" — accurate, and meaningless to
         somebody at a gate.
      */
      IF SQLERRM LIKE '%no partition of relation%' THEN
        RAISE EXCEPTION
          'There is no storage for a punch dated %. The punch log keeps the last month and the next three; anything older is corrected through a regularisation request instead.',
          v_date
          USING errcode = '23514';
      END IF;
      RAISE;
  END;

  /*
    No recompute is queued here. `trg_attendance_punches__enqueue` already fires on
    INSERT and writes the priority-3 job, deduped by `uq_arq__pending`. Queuing a
    second one from this function would be a second definition of when a day is
    dirty, and the two would drift.
  */
  RETURN v_row;
END;
$$;
