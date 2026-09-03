-- ============================================================================
-- The recompute queue gives up on a day it can never compute.
--
-- ── WHAT WAS HAPPENING ──────────────────────────────────────────────────────
-- Fourteen rows for one employee sat unprocessed with 43,338 attempts each and
-- the same error every time:
--
--   employee_not_found: 1c6b6089-cfcd-442a-a5d2-94a15aa5df64
--
-- That employee is soft-deleted, and `compute_attendance_day` selects
-- `WHERE deleted_at IS NULL`, so it raises and always will. The drain's exception
-- handler cleared `claimed_at` and incremented `attempts`, and the claim predicate
-- had no ceiling — so pg_cron picked the same fourteen rows up again the next
-- minute, and had done for about thirty days.
--
-- ── THE PART THAT IS WORSE THAN WASTED WORK ─────────────────────────────────
-- `uq_arq__pending` is UNIQUE on (employee_id, ist_date) WHERE processed_at IS NULL,
-- and `enqueue_recompute` inserts ON CONFLICT DO NOTHING. A row left pending for
-- ever therefore SWALLOWS every future enqueue for that same employee and date. Had
-- that employee been restored, those days could never have been recomputed: each
-- enqueue would have quietly matched the dead row and done nothing, with no error
-- and nothing on any screen to explain it.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- A twenty-attempt ceiling on the claim, and a row that exhausts it is stamped
-- `processed_at` — which releases the dedup slot — while keeping `attempts` and
-- `last_error` as the record of why it stopped. Twenty attempts is twenty minutes
-- at one drain a minute: generous for a lock or a deploy, immediate for a permanent
-- failure.
--
-- Generated from `pg_get_functiondef` of the deployed function. Three edits, each
-- asserted unique before it was made; nothing else in the body changed.
-- ============================================================================

SELECT set_config('app.reason',
  'the recompute queue stops retrying a day it can never compute, and releases the dedup slot so a later enqueue for the same day is not silently swallowed',
  true);

CREATE OR REPLACE FUNCTION public.drain_attendance_recompute_queue(p_limit integer DEFAULT 500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r      record;
  v_done integer := 0;
  v_err  integer := 0;
  v_run  uuid;
  v_t0   timestamptz := clock_timestamp();
  /*
    ── HOW MANY TIMES A DAY IS RETRIED BEFORE IT IS GIVEN UP ON ──────────────
    pg_cron drains this every minute, so twenty attempts is twenty minutes of
    retrying: generous for anything transient — a lock, a deploy, a momentary
    timeout — and immediate for anything permanent.

    Fourteen rows reached 43,338 attempts before this existed. That is thirty days
    of calling `compute_attendance_day` on a soft-deleted employee, once a minute,
    for an error that could never resolve.
  */
  MAX_ATTEMPTS constant integer := 20;
BEGIN
  INSERT INTO public.attendance_recompute_runs (run_kind, engine_version, started_at, status)
  VALUES ('queue_drain', 1, now(), 'running') RETURNING id INTO v_run;

  FOR r IN
    UPDATE public.attendance_recompute_queue q
       SET claimed_at = now(), claimed_by = 'cron', run_id = v_run
     WHERE q.id IN (
       SELECT id FROM public.attendance_recompute_queue
        WHERE processed_at IS NULL AND claimed_at IS NULL
          AND attempts < MAX_ATTEMPTS
        ORDER BY priority, enqueued_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED)
    RETURNING q.id, q.employee_id, q.ist_date, q.reason
  LOOP
    BEGIN
      PERFORM public.compute_attendance_day(r.employee_id, r.ist_date, r.reason);
      UPDATE public.attendance_recompute_queue
         SET processed_at = now() WHERE id = r.id;
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_err := v_err + 1;
      /*
        ── ABANDONING A ROW MUST FREE ITS DEDUP SLOT ───────────────────────────
        `uq_arq__pending` is UNIQUE on (employee_id, ist_date) WHERE processed_at IS
        NULL, and `enqueue_recompute` inserts with ON CONFLICT DO NOTHING. So a row
        left pending for ever does more than waste a minute of work every minute: it
        SILENTLY SWALLOWS every future enqueue for that same employee and date. If
        the employee behind these fourteen rows were ever restored, their attendance
        for those days could never be recomputed — every enqueue would be a no-op,
        with nothing anywhere to show why.

        So a row that has exhausted its attempts is stamped `processed_at`, which
        releases the slot, and keeps `attempts` and `last_error` as the record of
        what happened and why it stopped. "Processed" here means "the queue is
        finished with it", not "it succeeded" — the error is right there on the row,
        and `attendance_recompute_runs` counted it as an error every time.
      */
      UPDATE public.attendance_recompute_queue
         SET claimed_at = NULL,
             attempts   = attempts + 1,
             last_error = SQLERRM,
             processed_at = CASE WHEN attempts + 1 >= MAX_ATTEMPTS THEN now() ELSE NULL END
       WHERE id = r.id;
    END;
  END LOOP;

  UPDATE public.attendance_recompute_runs
     SET finished_at = now(), days_written = v_done, errors = v_err,
         days_targeted = v_done + v_err,
         status = 'succeeded',
         duration_ms = (EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::integer
   WHERE id = v_run;
  RETURN v_done;
END;
$function$
;

-- ---------------------------------------------------------------------------
-- Retire the fourteen rows that were already past any sane ceiling
-- ---------------------------------------------------------------------------
/*
  Stamped, not deleted. `last_error` and `attempts` stay on the row, so what happened
  is still legible — and the dedup slot is freed, so if that employee is ever restored
  an enqueue for those dates will insert a fresh row and actually run.
*/
UPDATE public.attendance_recompute_queue
   SET processed_at = now()
 WHERE processed_at IS NULL
   AND attempts >= 20;

SELECT count(*) AS still_pending,
       coalesce(max(attempts), 0) AS worst_attempts
  FROM public.attendance_recompute_queue
 WHERE processed_at IS NULL;
