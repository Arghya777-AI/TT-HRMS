-- =============================================================================
-- 20260801044000 — recording a punch when the camera at the gate fails
-- =============================================================================
--
-- REPORTED, on /admin/attendance/punches/new, in red, above a form that validates
-- perfectly and then cannot save:
--
--   "This punch cannot be saved yet. Recording one needs a 'manual-punch' edge
--    function, and no such function is deployed: attendance_punches accepts no
--    writes from a browser session, void-punch only voids, and kiosk-punch
--    requires a paired device and a live face."
--
-- Every clause of that is true. The conclusion — that an EDGE FUNCTION is what is
-- missing — is not.
--
-- ── WHY THIS IS AN RPC AND NOT A FUNCTION DEPLOYMENT ────────────────────────
--
-- The edge functions in this product exist because they do something Postgres
-- cannot: call Resend, run a face model, read an object from storage, talk to
-- Anthropic. Recording a punch is none of that. It is one INSERT, guarded by
-- checks that are already CHECK constraints, on a table whose downstream work is
-- already automatic — `trg_attendance_punches__enqueue` queues the recompute the
-- moment the row lands.
--
-- A definer RPC does the whole job, ships as SQL, and can be run tonight. Waiting
-- for a deployment would leave the gate broken for no gain in safety.
--
-- ── WHAT THE FORM CANNOT ENFORCE AND THIS DOES ──────────────────────────────
--
--  1. THE PERIOD MUST NOT BE HARD-LOCKED. `attendance_locks` is how payroll says
--     "this month is finalised". A punch backdated into a locked period changes a
--     day that has already been paid, and the recompute would then disagree with
--     the payslip nobody can reissue. A SOFT lock is a warning and is allowed
--     through; a HARD lock is refused.
--  2. THE PARTITION MUST EXIST. `attendance_punches` is partitioned monthly from
--     last month to +3, so a punch backdated far enough lands nowhere and Postgres
--     raises a message about no partition being found — accurate and unreadable.
--     It is caught and said in words.
--  3. THE PERSON MUST BE REAL AND EMPLOYED. A mistyped code that happens to match
--     somebody files another person's attendance, which the form already warns
--     about — this is the half that cannot be talked out of.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- It does not decide whether the punch is an arrival or a departure. The engine
-- takes the FIRST scan of an IST day as arrival and the LAST as departure, and
-- recalculates from every scan each time one is added. `direction` is recorded as
-- provenance — what the admin believed — and never as an instruction.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 044000: record_manual_punch, so an admin can record a scan when the gate camera fails — the screen has had a validated form and no write path since it was built', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.record_manual_punch(
  p_employee_id uuid,
  p_punched_at  timestamptz,
  p_reason      text,
  p_direction   text DEFAULT 'undetermined',
  p_note        text DEFAULT NULL
)
RETURNS public.attendance_punches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

  IF v_emp.employment_status IN ('exited', 'pre_joining') THEN
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

REVOKE EXECUTE ON FUNCTION public.record_manual_punch(uuid, timestamptz, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_manual_punch(uuid, timestamptz, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.record_manual_punch(uuid, timestamptz, text, text, text) IS
  'Record a scan by employee code when the gate camera fails. Administrator only; requires a reason of ten characters or more; refuses a future time, a hard-locked period, an unemployed person, and a date with no partition. Always sets needs_review. The recompute is queued by the table''s own trigger, not here.';

COMMIT;
