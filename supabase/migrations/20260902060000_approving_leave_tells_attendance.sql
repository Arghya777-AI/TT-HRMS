-- ============================================================================
-- Approving leave now tells the attendance engine about it.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────
-- Every other input to `compute_attendance_day` has a trigger that enqueues a
-- recompute when it changes: punches, regularizations, holidays, policy
-- assignments, roster slots, shift assignments. LEAVE HAD NONE.
-- `trg_leave_requests__recompute` sounds like it does this and does not — it
-- recomputes the leave BALANCE.
--
-- So approving leave never told attendance to revisit the day. It appeared to work
-- when somebody applied a day ahead, because the day had not been computed yet and
-- the engine read the leave the first time it ran. Approve for TODAY, after the day
-- already has a row, and the row stayed `pending` and then `absent` — somebody on
-- approved leave marked absent, on the dashboard their manager reads.
--
-- Observed on 02 Sep 2026: five people with approved leave for that day, and two of
-- them (117, TT0022) still sitting at `pending` while the other three were correct
-- only because an unrelated recompute had happened to run after their approval.
--
-- ── WHAT FIRES, AND WHEN ────────────────────────────────────────────────────
-- Only when the answer to "does this leave count today" actually flips. Approving
-- fires it; so does cancelling, rejecting or withdrawing an approval, because the
-- day has to go back to being a working day. An edit that leaves the status alone
-- does not, and neither does draft -> pending.
--
-- ── ENQUEUE, AND ALSO COMPUTE THE STALE DAYS INLINE ─────────────────────────
-- The queue alone would be correct: `attendance_queue_drain` runs every minute. But
-- a minute is a minute, and the person approving is usually looking at the board
-- they expect to change. So days that ALREADY have an `attendance_days` row are
-- recomputed inline, in this transaction — and that set is exactly the bug: a date
-- with no row yet will be computed correctly whenever it is first computed.
--
-- Capped at 31 dates so approving a long sabbatical does not run hundreds of
-- computations inside the approval, and wrapped so that a failure NEVER blocks the
-- approval. If the inline pass fails the row is still queued, so the outcome
-- degrades to "correct within a minute" rather than "leave cannot be approved".
-- ============================================================================

CREATE OR REPLACE FUNCTION public.leave_requests_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now_counts  boolean;
  v_was_counts  boolean;
  r             record;
  v_inline      integer := 0;
BEGIN
  -- `partially_approved` counts: the approved dates carry day_value, the rest are 0.
  v_now_counts := NEW.status IN ('approved', 'partially_approved');
  v_was_counts := TG_OP = 'UPDATE'
                  AND OLD.status IN ('approved', 'partially_approved');

  -- Nothing to do unless the day's meaning changed.
  IF v_now_counts IS NOT DISTINCT FROM v_was_counts THEN
    RETURN NULL;
  END IF;

  FOR r IN
    SELECT lrd.leave_date,
           EXISTS (SELECT 1 FROM public.attendance_days ad
                    WHERE ad.employee_id = NEW.employee_id
                      AND ad.ist_date = lrd.leave_date) AS already_computed
      FROM public.leave_request_days lrd
     WHERE lrd.leave_request_id = NEW.id
     ORDER BY lrd.leave_date
  LOOP
    -- Always queued. Deduped by `uq_arq__pending`, so a re-approval costs nothing.
    PERFORM public.enqueue_recompute(
      NEW.employee_id, r.leave_date,
      'leave_' || NEW.status::text, TG_TABLE_NAME, NEW.id, 3::smallint);

    IF r.already_computed AND v_inline < 31 THEN
      v_inline := v_inline + 1;
      BEGIN
        PERFORM public.compute_attendance_day(
          NEW.employee_id, r.leave_date, 'leave_' || NEW.status::text, true);
      EXCEPTION WHEN OTHERS THEN
        -- Swallowed on purpose. The row is queued; a compute fault must not make
        -- leave unapprovable.
        NULL;
      END;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.leave_requests_enqueue_recompute() IS
  'Recomputes attendance for a leave request''s dates when its approval state flips. Inline for days already computed (capped at 31), queued always.';

DROP TRIGGER IF EXISTS trg_leave_requests__enqueue_attendance ON public.leave_requests;

CREATE TRIGGER trg_leave_requests__enqueue_attendance
  AFTER INSERT OR UPDATE OF status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_enqueue_recompute();
