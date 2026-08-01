-- ============================================================================
-- 20260801039800_leave_request_mentions.sql
--
-- MENTION PEERS ON A LEAVE APPLICATION (option A).
--
-- "Add an option to mention your peers (who you may want to mention)."
--
-- `leave_requests` holds ONE `handover_to_employee_id` — the person covering the
-- work — and nothing that names other colleagues. The alternative was to let people
-- type names into `handover_notes`, and it was rejected for the reason the feature
-- exists: a name in free text notifies nobody and nothing can act on it. A mention
-- that does not reach the person mentioned is decoration.
--
-- ── ONE ROW PER PERSON MENTIONED ─────────────────────────────────────────────
-- Not an array column on `leave_requests`. Rows give a unique constraint (mention
-- somebody twice and it is refused rather than silently duplicated), a foreign key
-- that keeps a mention pointing at a real employee, and an INSERT trigger that can
-- notify — none of which an array offers.
--
-- ── WHO MAY WRITE ONE ────────────────────────────────────────────────────────
-- The applicant, on their OWN request, while it is still theirs to change — the
-- same window `leave_requests__self_update` allows. And an admin in scope, because
-- an admin applying on somebody's behalf must be able to name the peers too.
--
-- Deliberately NOT the approver: adding names to somebody else's application after
-- the fact would put people on a record they were never told about by its author.
--
-- ── READ ─────────────────────────────────────────────────────────────────────
-- `app.can_see_employee(employee_id)` on the SUBJECT of the request, not on the
-- mentioned person. Being mentioned is a fact about the applicant's leave, so it is
-- visible to exactly the people who can see that leave: the applicant, their
-- manager, an admin in scope. A mentioned colleague sees the notification, which is
-- the point, and does not thereby gain sight of the whole request.
--
-- ── THE NOTIFICATION ─────────────────────────────────────────────────────────
-- Written by the trigger so it cannot be forgotten by a caller. It carries a
-- deep link to the request and is addressed to the mentioned employee's profile.
-- `event_code` is free text on this table, so no enum needs extending.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.leave_request_mentions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id  uuid NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  /** The colleague being mentioned. */
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  /** Optional line from the applicant about why this person is named. */
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES public.profiles(id),
  CONSTRAINT uq_lrm__request_employee UNIQUE (leave_request_id, employee_id)
);

COMMENT ON TABLE public.leave_request_mentions IS
  'Colleagues the applicant named on a leave application, one row each. Separate from '
  'leave_requests.handover_to_employee_id, which is the single person covering the work. Each '
  'mention notifies the person named — a mention that does not reach them is decoration.';

CREATE INDEX IF NOT EXISTS idx_lrm__request ON public.leave_request_mentions (leave_request_id);
CREATE INDEX IF NOT EXISTS idx_lrm__employee ON public.leave_request_mentions (employee_id);

ALTER TABLE public.leave_request_mentions ENABLE ROW LEVEL SECURITY;

-- Read: whoever can see the APPLICANT's leave.
DROP POLICY IF EXISTS lrm__scope_read ON public.leave_request_mentions;
CREATE POLICY lrm__scope_read ON public.leave_request_mentions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.id = leave_request_id
               AND app.can_see_employee(lr.employee_id))
  );

-- Write: the applicant while the request is still theirs, or an admin in scope.
DROP POLICY IF EXISTS lrm__self_write ON public.leave_request_mentions;
CREATE POLICY lrm__self_write ON public.leave_request_mentions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.id = leave_request_id
               AND lr.employee_id = app.current_employee_id()
               AND lr.status IN ('draft', 'pending'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.id = leave_request_id
               AND lr.employee_id = app.current_employee_id()
               AND lr.status IN ('draft', 'pending'))
  );

DROP POLICY IF EXISTS lrm__admin_write ON public.leave_request_mentions;
CREATE POLICY lrm__admin_write ON public.leave_request_mentions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.id = leave_request_id
               AND app.is_admin() AND app.admin_scope_covers(lr.employee_id))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.id = leave_request_id
               AND app.is_admin() AND app.admin_scope_covers(lr.employee_id))
  );

-- ── The notification ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.leave_request_mentions_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_profile   uuid;
  v_applicant text;
  v_number    text;
  v_from      date;
  v_to        date;
BEGIN
  SELECT e.profile_id INTO v_profile
  FROM public.employees e WHERE e.id = NEW.employee_id;

  -- Nobody to tell: a colleague with no portal login. The mention is still recorded,
  -- because the applicant named them and the approver should see that.
  IF v_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT er.display_name, lr.request_number, lr.from_date, lr.to_date
    INTO v_applicant, v_number, v_from, v_to
  FROM public.leave_requests lr
  JOIN public.v_employee_ref er ON er.id = lr.employee_id
  WHERE lr.id = NEW.leave_request_id;

  -- `notification_status` is queued|sending|sent|…; an in-app row starts QUEUED and the
  -- delivery pipeline moves it on. 'pending' is not a member of that enum.
  INSERT INTO public.notifications
    (employee_id, profile_id, event_code, title, body, deep_link, channel, status)
  VALUES
    (NEW.employee_id, v_profile, 'leave.mentioned',
     COALESCE(v_applicant, 'A colleague') || ' mentioned you on a leave request',
     COALESCE(v_applicant, 'A colleague') || ' named you on ' || COALESCE(v_number, 'a request')
       || ' for ' || COALESCE(v_from::text, '?') || ' to ' || COALESCE(v_to::text, '?')
       || COALESCE(' — ' || NEW.note, ''),
     '/me/notifications', 'in_app', 'queued');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lrm__notify ON public.leave_request_mentions;
CREATE TRIGGER trg_lrm__notify
  AFTER INSERT ON public.leave_request_mentions
  FOR EACH ROW EXECUTE FUNCTION public.leave_request_mentions_notify();

COMMENT ON FUNCTION public.leave_request_mentions_notify() IS
  'Notifies a mentioned colleague. In the trigger rather than the caller so a mention cannot '
  'be recorded without the person learning of it. A colleague with no portal login is recorded '
  'but not notified — there is nobody to tell, and dropping the mention would hide it from the '
  'approver too.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.leave_request_mentions TO authenticated;

COMMIT;
