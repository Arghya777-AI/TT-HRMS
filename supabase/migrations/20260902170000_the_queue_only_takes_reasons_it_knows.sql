-- ============================================================================
-- A BUG I SHIPPED, and the constraint that caught it.
--
-- ── WHAT WAS BROKEN ────────────────────────────────────────────────────────
-- `attendance_recompute_queue.reason` is constrained to a fixed list. The
-- leave-to-attendance trigger added in 20260902060000 built its reason as
-- `'leave_' || NEW.status`, and only two of those strings are on the list:
--
--   leave_approved            allowed
--   leave_cancelled           allowed
--   leave_rejected            NOT ALLOWED
--   leave_withdrawn           NOT ALLOWED
--   leave_partially_approved  NOT ALLOWED
--
-- The trigger fires when the answer to "does this leave count" FLIPS, so rejecting
-- or withdrawing an already-approved leave enqueued `leave_rejected`, hit the check
-- constraint, and rolled the whole status change back. An administrator could approve
-- leave and then could not undo it — verified against production before this fix, and
-- the reason `cancelled` appeared to work is only that it happens to be on the list.
--
-- The constraint did its job. My trigger built a value from an enum without checking
-- what the column accepted.
--
-- ── THE FIX IS TO MAP, NOT TO WIDEN ────────────────────────────────────────
-- The queue's reason says WHY a day needs recomputing, and there are only two answers
-- a leave decision can give: this leave now counts, or it no longer does. Adding five
-- more strings would grow the vocabulary without adding meaning, and the next status
-- somebody adds to the enum would break it again the same way.
--
-- ── AND TWO GENUINELY NEW CAUSES ARE ADDED ─────────────────────────────────
-- An off-hours punch being approved or rejected is a new reason for a day to change,
-- and worth naming in a column an auditor reads. Those two are added to the list
-- rather than folded into `manual`, which would say nothing.
-- ============================================================================

ALTER TABLE public.attendance_recompute_queue DROP CONSTRAINT IF EXISTS ck_arq__reason;
ALTER TABLE public.attendance_recompute_queue
  ADD CONSTRAINT ck_arq__reason CHECK (reason = ANY (ARRAY[
    'punch_inserted', 'punch_voided',
    'leave_approved', 'leave_cancelled',
    'holiday_changed', 'roster_changed', 'shift_changed', 'policy_changed',
    'regularization_applied',
    -- New: an administrator decided an off-hours web punch.
    'off_hours_approved', 'off_hours_rejected',
    'manual', 'backfill'
  ]));

/*
  The leave trigger now maps to the two reasons that exist, instead of building a string
  from an enum it never checked against the column.
*/
CREATE OR REPLACE FUNCTION public.leave_requests_enqueue_recompute()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now_counts  boolean;
  v_was_counts  boolean;
  v_reason      text;
  r             record;
  v_inline      integer := 0;
BEGIN
  v_now_counts := NEW.status IN ('approved', 'partially_approved');
  v_was_counts := TG_OP = 'UPDATE'
                  AND OLD.status IN ('approved', 'partially_approved');

  IF v_now_counts IS NOT DISTINCT FROM v_was_counts THEN
    RETURN NULL;
  END IF;

  /*
    Two answers, not five. `'leave_' || NEW.status` produced `leave_rejected` and
    `leave_withdrawn`, neither of which `ck_arq__reason` accepts — so rejecting an
    approved leave failed the constraint and rolled the decision back.
  */
  v_reason := CASE WHEN v_now_counts THEN 'leave_approved' ELSE 'leave_cancelled' END;

  FOR r IN
    SELECT lrd.leave_date,
           EXISTS (SELECT 1 FROM public.attendance_days ad
                    WHERE ad.employee_id = NEW.employee_id
                      AND ad.ist_date = lrd.leave_date) AS already_computed
      FROM public.leave_request_days lrd
     WHERE lrd.leave_request_id = NEW.id
     ORDER BY lrd.leave_date
  LOOP
    PERFORM public.enqueue_recompute(
      NEW.employee_id, r.leave_date, v_reason, TG_TABLE_NAME, NEW.id, 3::smallint);

    IF r.already_computed AND v_inline < 31 THEN
      v_inline := v_inline + 1;
      BEGIN
        PERFORM public.compute_attendance_day(
          NEW.employee_id, r.leave_date, v_reason, true);
      EXCEPTION WHEN OTHERS THEN
        -- The row is queued; a compute fault must not make leave undecidable.
        NULL;
      END;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
