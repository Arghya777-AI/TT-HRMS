-- =============================================================================
-- 20260801041900 — the leave notification must not use ON CONFLICT
-- =============================================================================
--
-- THE BUG I SHIPPED IN 041600, AND WHAT IT COST
--
-- `leave_requests_raise_approval` ends by writing an in-app notification for each
-- resolved approver, and it deduplicated with
--
--     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
--
-- which raises, every single time:
--
--     42P10: there is no unique or exclusion constraint matching the
--            ON CONFLICT specification
--
-- `public.notifications` is `PARTITION BY RANGE (recorded_at)` (027 §…), and its
-- dedupe index is created per PARTITION — `uq_notifications_2026_q3__dedupe` and
-- siblings. ON CONFLICT infers against the relation it was handed, the PARENT,
-- where no such index exists and none CAN: a unique index on a partitioned table
-- must contain the partition key, and `(dedupe_key)` does not.
--
-- The notification insert sits OUTSIDE the exception handler that guards
-- `create_approval_request`, so the failure propagated: the UPDATE that moves a
-- leave request to 'pending' was refused, and the employee got "The server
-- refused this application" with nothing written. Reported as "why still
-- failing" after 041600 had been applied — and the diagnostic showed the
-- balances correct, the triggers installed, and `My requests` empty, which is
-- exactly this shape.
--
-- HOW IT SURVIVED: the same clause is written into `sla_sweep` (029), inside an
-- `EXECUTE format(...)` that only runs on a genuine SLA breach. It has evidently
-- never run there either, so the pattern looked established and I copied it.
-- Copying an untested line is how it becomes two untested lines.
--
-- THE FIX: `WHERE NOT EXISTS`, which reads the same index the planner would have
-- used and needs no inference. `dedupe_key` is still written — the per-partition
-- index still enforces uniqueness within a quarter, which is all it ever did.
--
-- `sla_sweep` is deliberately NOT touched here: it is 200 lines of another
-- concern and its copy of the bug deserves its own migration with its own test,
-- not a drive-by edit inside a fix for leave.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 041900: fix 42P10 — the leave notification cannot ON CONFLICT against a partitioned parent', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.leave_requests_raise_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_request_id uuid;
  lt           public.leave_types%ROWTYPE;
  e            public.employees%ROWTYPE;
  v_approver   uuid;
  v_title      text;
  v_body       text;
  v_dedupe     text;
BEGIN
  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;
  SELECT * INTO e  FROM public.employees   WHERE id = NEW.employee_id;

  BEGIN
    v_request_id := public.create_approval_request(
      p_request_type_code  => 'LEAVE',
      p_subject_employee_id=> NEW.employee_id,
      p_detail_id          => NEW.id,
      p_title              => COALESCE(lt.name, 'Leave') || ' · ' ||
                              to_char(NEW.from_date, 'DD Mon') ||
                              CASE WHEN NEW.to_date <> NEW.from_date
                                   THEN ' – ' || to_char(NEW.to_date, 'DD Mon') ELSE '' END,
      p_summary            => jsonb_build_object(
                                'summary',        NULLIF(btrim(COALESCE(NEW.reason, '')), ''),
                                'leave_type',     lt.name,
                                'leave_type_code',lt.code,
                                'from_date',      NEW.from_date,
                                'to_date',        NEW.to_date,
                                'total_days',     NEW.total_days,
                                'request_number', NEW.request_number),
      p_amount             => NULL,
      p_days               => NEW.total_days,
      p_priority           => 'normal',
      p_on_behalf_of       => NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'leave request % filed but no approval request could be raised: %',
      NEW.request_number, SQLERRM;
    RETURN NULL;
  END;

  UPDATE public.leave_requests
     SET approval_request_id = v_request_id
   WHERE id = NEW.id;

  v_title := COALESCE(e.display_name, 'An employee') || ' applied for ' ||
             trim(to_char(NEW.total_days, 'FM999999.99')) || ' day(s) of ' ||
             COALESCE(lt.name, 'leave');
  v_body  := COALESCE(e.display_name, 'An employee') || ' applied for ' ||
             trim(to_char(NEW.total_days, 'FM999999.99')) || ' day(s) of ' ||
             COALESCE(lt.name, 'leave') || ' (' ||
             to_char(NEW.from_date, 'DD Mon YYYY') || ' to ' ||
             to_char(NEW.to_date, 'DD Mon YYYY') || ').' ||
             CASE WHEN NULLIF(btrim(COALESCE(NEW.reason, '')), '') IS NULL
                  THEN '' ELSE ' Reason: ' || btrim(NEW.reason) END;

  /*
    WRAPPED, because a notification is not worth losing a leave application over.

    Everything above this point is the request itself; everything below is telling
    people about it. 041600 left the notification insert unguarded and a 42P10
    inside it refused the whole submission — the failure mode this handler now
    makes impossible. A warning in the Postgres log with nobody notified is bad;
    an employee unable to apply is worse.
  */
  BEGIN
    FOR v_approver IN
      SELECT unnest(ar.current_approver_ids)
        FROM public.approval_requests ar
       WHERE ar.id = v_request_id
    LOOP
      v_dedupe := 'LEAVE_APPLIED:' || NEW.id || ':' || v_approver;

      /*
        NOT `ON CONFLICT (dedupe_key)`. `notifications` is partitioned by
        `recorded_at` and its dedupe index lives on each PARTITION, so inference
        against the parent raises 42P10 every time. NOT EXISTS uses the same
        index without asking the planner to infer an arbiter.
      */
      INSERT INTO public.notifications
        (employee_id, profile_id, event_code, channel, title, body, deep_link,
         payload, priority, status, dedupe_key)
      SELECT ap.id, ap.profile_id, 'LEAVE_APPLIED', 'in_app',
             v_title, v_body, '/team/approvals',
             jsonb_build_object(
               'total_days',      NEW.total_days,
               'days',            trim(to_char(NEW.total_days, 'FM999999.99')),
               'leave_request_id',NEW.id,
               'approval_request_id', v_request_id,
               'employee_name',   COALESCE(e.display_name, 'An employee'),
               'leave_type_name', COALESCE(lt.name, 'leave'),
               'from_date',       to_char(NEW.from_date, 'DD Mon YYYY'),
               'to_date',         to_char(NEW.to_date, 'DD Mon YYYY')),
             CASE WHEN NEW.total_days >= 3 THEN 'high' ELSE 'normal' END,
             'queued',
             v_dedupe
        FROM public.employees ap
       WHERE ap.id = v_approver
         AND ap.profile_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.notifications n2 WHERE n2.dedupe_key = v_dedupe);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'leave request % filed but the approver was not notified: %',
      NEW.request_number, SQLERRM;
  END;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.leave_requests_raise_approval() IS
  'Raises the approval_requests row for a leave application and notifies the resolved approvers. Both halves are wrapped: neither a missing chain nor a failed notification may cost an employee their application.';

COMMIT;
