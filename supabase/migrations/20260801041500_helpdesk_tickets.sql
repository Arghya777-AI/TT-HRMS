-- =============================================================================
-- 20260801041500 — helpdesk_tickets + helpdesk_messages: the queue E-14 has
--                  been describing since it was written
-- =============================================================================
--
-- WHAT WAS THERE
--
-- Nothing. `grep -rn helpdesk supabase/migrations/` returned no rows before this
-- file: no ticket table, no message table, no service-level clock. `/me/helpdesk`
-- has said so in as many words, and PostgREST agreed —
--
--     GET /rest/v1/helpdesk_tickets → 404 PGRST205
--       "Could not find the table 'public.helpdesk_tickets' in the schema cache"
--
-- spec-employee §5 E-14 asks for a ticket queue against HR, Payroll, Stores and
-- IT with a service-level clock per ticket. This is that.
--
-- ── WHY THIS IS NOT THE APPROVAL ENGINE ──────────────────────────────────────
--
-- The nearest deployed thing is `approval_requests`, and reusing it was
-- considered and rejected: an approval has an APPROVER and a DECISION, a ticket
-- has an ASSIGNEE and a CONVERSATION. An approval is finished when someone says
-- yes or no; a ticket is finished when the thing is fixed, which may be five
-- messages and two reassignments later, and may be REOPENED — a state the
-- approval engine has no room for (`act_on_approval` refuses a request that is
-- not pending). Modelling one as the other would mean either a chain with no
-- decision or a decision nobody made.
--
-- ── THE SLA CLOCK IS TWO CLOCKS ──────────────────────────────────────────────
--
-- "Time to first reply" and "time to close" are different promises and they are
-- broken separately: a desk that answers in ten minutes and fixes in a fortnight
-- is failing one and keeping the other. Both due-times are stamped ON INSERT
-- from settings, so a ticket carries the promise that applied on the day it was
-- raised — changing the setting later does not silently re-judge history, which
-- is the same reason `resignations.notice_period_days` is a snapshot.
--
-- `first_responded_at` is stamped by a TRIGGER on the first message from someone
-- who is not the requester. Nobody has to remember to mark it, and nobody can
-- claim a response that was never written.
--
-- ── WHO CAN SEE A TICKET ─────────────────────────────────────────────────────
--
-- The requester, the assignee, and administrators. NOT the reporting manager —
-- and that is the one place this table deliberately parts company with
-- `document_requests`, which does grant manager read. A help desk ticket may be
-- about pay, about a grievance, or about the manager; a queue whose contents the
-- subject's manager can read is a queue people stop using for the things that
-- matter most. If a desk needs team-wide visibility later, that is a membership
-- table and an explicit policy, not a default.
--
-- Internal notes (`helpdesk_messages.is_internal`) are the desk talking to
-- itself. RLS — not a WHERE clause in the browser — is what keeps them off the
-- requester's screen.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 041500: helpdesk_tickets and helpdesk_messages — the E-14 queue with its two SLA clocks', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Settings — the two promises
-- -----------------------------------------------------------------------------
--
-- group_name must be one of `ck_settings__group`'s eight; 'system' is where the
-- non-payroll, non-attendance operational knobs already live.

INSERT INTO public.settings
  (company_id, key, value, value_kind, scope, group_name, label, description,
   is_sensitive, is_editable_by_admin)
SELECT c.id, v.key, v.val::jsonb, 'number', 'company', 'system', v.label, v.descr, false, true
FROM public.companies c
CROSS JOIN (VALUES
    ('helpdesk.first_response_hours', '8',
     'Help desk — first reply (hours)',
     'How long the desk has to respond to a new ticket before it counts as breached. Stamped onto each ticket when it is raised, so changing this does not re-judge tickets already open.'),
    ('helpdesk.resolution_hours', '48',
     'Help desk — resolution (hours)',
     'How long the desk has to resolve a ticket. Stamped onto each ticket when it is raised.')
  ) AS v(key, val, label, descr)
WHERE c.deleted_at IS NULL
ON CONFLICT (company_id, key, scope,
             coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. helpdesk_tickets
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.helpdesk_tickets (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  ticket_number          text        NOT NULL,   -- HD-2026-000012, minted below
  employee_id            uuid        NOT NULL,   -- the requester
  -- The four desks §5 E-14 names. A closed list, because a desk with nobody
  -- behind it is a queue tickets go into and never come out of.
  desk                   text        NOT NULL,
  subject                text        NOT NULL,
  description            text        NOT NULL,
  priority               text        NOT NULL DEFAULT 'normal',
  status                 text        NOT NULL DEFAULT 'open',
  -- Whoever is actually working it. NULL means nobody has picked it up, which is
  -- a real and reportable state rather than an omission.
  assigned_to            uuid        NULL,
  -- The two promises, snapshotted at raise time. See the header.
  first_response_due_at  timestamptz NULL,
  resolution_due_at      timestamptz NULL,
  -- Stamped by trg_hdm__first_response on the first message from someone other
  -- than the requester. Never written by a client.
  first_responded_at     timestamptz NULL,
  resolved_at            timestamptz NULL,
  resolved_by            uuid        NULL,
  resolution_note        text        NULL,
  closed_at              timestamptz NULL,
  reopened_count         integer     NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NULL,
  CONSTRAINT pk_helpdesk_tickets PRIMARY KEY (id),
  CONSTRAINT uq_hdt__number UNIQUE (ticket_number),
  CONSTRAINT fk_hdt__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_hdt__assigned_to
    FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_hdt__resolved_by
    FOREIGN KEY (resolved_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_hdt__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_hdt__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_hdt__desk CHECK (desk IN ('hr','payroll','stores','it')),
  CONSTRAINT ck_hdt__priority CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT ck_hdt__status CHECK (status IN
    ('open','in_progress','waiting_on_requester','resolved','closed','cancelled')),
  CONSTRAINT ck_hdt__subject CHECK (length(btrim(subject)) BETWEEN 5 AND 200),
  CONSTRAINT ck_hdt__description CHECK (length(btrim(description)) >= 10),
  CONSTRAINT ck_hdt__reopened CHECK (reopened_count >= 0)
);

COMMENT ON TABLE public.helpdesk_tickets IS
  'E-14 ticket queue: an employee asking HR, Payroll, Stores or IT for help. Deliberately NOT an approval_request — a ticket has an assignee and a conversation, not an approver and a decision, and it can be reopened.';
COMMENT ON COLUMN public.helpdesk_tickets.first_response_due_at IS
  'Snapshot of settings helpdesk.first_response_hours at raise time. Snapshotted so that changing the promise does not silently re-judge tickets already open.';
COMMENT ON COLUMN public.helpdesk_tickets.first_responded_at IS
  'Stamped by trg_hdm__first_response on the first message from someone other than the requester. Never client-written: a response nobody wrote cannot be claimed.';

-- Resolution is one event: the note, the time and the person travel together.
DO $$ BEGIN
  ALTER TABLE public.helpdesk_tickets
    ADD CONSTRAINT ck_hdt__resolution_pair CHECK (
      (resolved_at IS NULL) = (resolved_by IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A terminal status must carry its timestamp, and a non-terminal one must not.
-- Without this a ticket can read 'resolved' with an empty clock, which makes
-- every "time to close" report quietly wrong.
DO $$ BEGIN
  ALTER TABLE public.helpdesk_tickets
    ADD CONSTRAINT ck_hdt__resolved_status CHECK (
      (status IN ('resolved','closed')) = (resolved_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.helpdesk_tickets
    ADD CONSTRAINT ck_hdt__closed_status CHECK (
      (status = 'closed') = (closed_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_hdt__employee
  ON public.helpdesk_tickets (employee_id, created_at DESC);
-- The desk's own queue. Partial: closed and cancelled tickets are the majority
-- within a month and none of them belong in this scan.
CREATE INDEX IF NOT EXISTS idx_hdt__open
  ON public.helpdesk_tickets (desk, priority, created_at)
  WHERE status IN ('open','in_progress','waiting_on_requester');
CREATE INDEX IF NOT EXISTS idx_hdt__assignee
  ON public.helpdesk_tickets (assigned_to)
  WHERE assigned_to IS NOT NULL;
-- Breach reporting: the two clocks, each only where it is still running.
CREATE INDEX IF NOT EXISTS idx_hdt__first_response_due
  ON public.helpdesk_tickets (first_response_due_at)
  WHERE first_responded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hdt__resolution_due
  ON public.helpdesk_tickets (resolution_due_at)
  WHERE resolved_at IS NULL;

-- -----------------------------------------------------------------------------
-- 3. helpdesk_messages — the conversation
-- -----------------------------------------------------------------------------
--
-- APPEND-ONLY. No UPDATE and no DELETE grant, and no audit trigger either: an
-- append-only log is its own audit trail, and 003800's rule is that such tables
-- do not carry `audit.log_changes()`.

CREATE TABLE IF NOT EXISTS public.helpdesk_messages (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  ticket_id         uuid        NOT NULL,
  -- Stamped from app.ctx_actor_id() by trg_hdm__author. A client-supplied author
  -- is a client that can put words in someone else's mouth.
  author_profile_id uuid        NOT NULL,
  body              text        NOT NULL,
  -- Desk-only note. RLS hides these from the requester; that is the whole point,
  -- so it is not a display flag the browser is trusted to honour.
  is_internal       boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_helpdesk_messages PRIMARY KEY (id),
  CONSTRAINT fk_hdm__ticket_id
    FOREIGN KEY (ticket_id) REFERENCES public.helpdesk_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_hdm__author_profile_id
    FOREIGN KEY (author_profile_id) REFERENCES public.profiles(id) ON DELETE RESTRICT,
  CONSTRAINT ck_hdm__body CHECK (length(btrim(body)) BETWEEN 1 AND 5000)
);

COMMENT ON TABLE public.helpdesk_messages IS
  'The conversation on a help desk ticket. Append-only: no UPDATE or DELETE grant to anyone, so a message cannot be edited after the fact.';

CREATE INDEX IF NOT EXISTS idx_hdm__ticket
  ON public.helpdesk_messages (ticket_id, created_at);

-- -----------------------------------------------------------------------------
-- 4. The server-minted reference
-- -----------------------------------------------------------------------------
--
-- Copied from generate_resignation_number() (040800) down to the advisory lock,
-- which is what makes two concurrent raises take different numbers instead of
-- both reading the same MAX. The year is the IST year: on the night of 31
-- December a UTC-derived year files next year's ticket under this year's series.

CREATE OR REPLACE FUNCTION public.generate_helpdesk_ticket_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_year text := to_char(util.ist_date(now()), 'YYYY');
  v_next integer;
BEGIN
  IF NEW.ticket_number IS NULL OR btrim(NEW.ticket_number) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('helpdesk_tickets.ticket_number'));
    SELECT COALESCE(MAX(substring(h.ticket_number FROM '[0-9]+$')::integer), 0) + 1
      INTO v_next
      FROM public.helpdesk_tickets h
     WHERE h.ticket_number LIKE 'HD-' || v_year || '-%';
    NEW.ticket_number := 'HD-' || v_year || '-' || lpad(v_next::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdt__number ON public.helpdesk_tickets;
CREATE TRIGGER trg_hdt__number
  BEFORE INSERT ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION public.generate_helpdesk_ticket_number();

-- -----------------------------------------------------------------------------
-- 5. The two clocks
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER because `settings` is not readable by a plain employee, and
-- an employee raising a ticket must not need to be. Nothing is disclosed: the
-- numbers land as two timestamps on their own ticket, which the screen shows
-- them anyway.
--
-- COALESCE down to hard-coded 8 and 48. A missing setting must not mean "no
-- promise at all" — that is the failure mode where deleting a row silently
-- removes the deadline and every ticket reports as on time forever.

CREATE OR REPLACE FUNCTION public.helpdesk_tickets_stamp_sla()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_company uuid;
  v_first   numeric;
  v_resolve numeric;
BEGIN
  SELECT e.company_id INTO v_company
    FROM public.employees e
   WHERE e.id = NEW.employee_id;

  SELECT (s.value #>> '{}')::numeric INTO v_first
    FROM public.settings s
   WHERE s.key = 'helpdesk.first_response_hours'
     AND (s.company_id = v_company OR s.company_id IS NULL)
   ORDER BY s.company_id NULLS LAST
   LIMIT 1;

  SELECT (s.value #>> '{}')::numeric INTO v_resolve
    FROM public.settings s
   WHERE s.key = 'helpdesk.resolution_hours'
     AND (s.company_id = v_company OR s.company_id IS NULL)
   ORDER BY s.company_id NULLS LAST
   LIMIT 1;

  NEW.first_response_due_at := NEW.created_at + (COALESCE(v_first, 8) * INTERVAL '1 hour');
  NEW.resolution_due_at     := NEW.created_at + (COALESCE(v_resolve, 48) * INTERVAL '1 hour');

  -- Clocks are the server's. A client that supplied its own gets it overwritten
  -- rather than politely ignored, because "politely ignored" is indistinguishable
  -- from "accepted" to whoever is reading the row later.
  NEW.first_responded_at := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdt__sla ON public.helpdesk_tickets;
CREATE TRIGGER trg_hdt__sla
  BEFORE INSERT ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION public.helpdesk_tickets_stamp_sla();

-- -----------------------------------------------------------------------------
-- 6. What a requester may change, and what only the desk may
-- -----------------------------------------------------------------------------
--
-- RLS grants the requester UPDATE on their own ticket, and RLS cannot restrict
-- WHICH COLUMNS an update touches. Without this guard the requester could assign
-- the ticket to themselves, mark it resolved, or move the deadline.
--
-- What they legitimately do is: cancel it, reopen a resolved one, and raise the
-- priority of their own problem. Everything else is the desk's.
--
-- SECURITY INVOKER (the default — deliberately not DEFINER): app.is_admin() must
-- answer for the actual caller.

CREATE OR REPLACE FUNCTION public.helpdesk_tickets_guard_update()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_is_desk boolean := app.is_admin()
                       OR (OLD.assigned_to IS NOT NULL AND OLD.assigned_to = app.ctx_actor_id());
BEGIN
  IF v_is_desk THEN
    -- Reopening is a countable event, and the count is what tells a desk it is
    -- closing tickets that were not fixed.
    IF OLD.status IN ('resolved','closed') AND NEW.status IN ('open','in_progress') THEN
      NEW.reopened_count := OLD.reopened_count + 1;
      NEW.resolved_at    := NULL;
      NEW.resolved_by    := NULL;
      NEW.closed_at      := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.desk                  IS DISTINCT FROM OLD.desk
     OR NEW.employee_id        IS DISTINCT FROM OLD.employee_id
     OR NEW.assigned_to        IS DISTINCT FROM OLD.assigned_to
     OR NEW.ticket_number      IS DISTINCT FROM OLD.ticket_number
     OR NEW.first_response_due_at IS DISTINCT FROM OLD.first_response_due_at
     OR NEW.resolution_due_at  IS DISTINCT FROM OLD.resolution_due_at
     OR NEW.first_responded_at IS DISTINCT FROM OLD.first_responded_at
     OR NEW.resolution_note    IS DISTINCT FROM OLD.resolution_note
  THEN
    RAISE EXCEPTION
      'Only the help desk can change that. You can add a message, raise the priority, reopen a ticket you are not happy with, or cancel it.'
      USING errcode = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('open','in_progress','waiting_on_requester')
       AND NEW.status = 'cancelled' THEN
      NULL;  -- withdrawing your own ticket
    ELSIF OLD.status = 'resolved' AND NEW.status = 'open' THEN
      -- Reopening: same counter as the desk path, and the resolution is undone
      -- rather than left standing next to an open ticket.
      NEW.reopened_count := OLD.reopened_count + 1;
      NEW.resolved_at    := NULL;
      NEW.resolved_by    := NULL;
      NEW.closed_at      := NULL;
    ELSE
      RAISE EXCEPTION
        'A ticket cannot go from % to % from here. You can cancel an open ticket, or reopen one that was resolved.',
        OLD.status, NEW.status
        USING errcode = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdt__guard ON public.helpdesk_tickets;
CREATE TRIGGER trg_hdt__guard
  BEFORE UPDATE ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION public.helpdesk_tickets_guard_update();

-- Requester-side inserts must not arrive pre-resolved or pre-assigned.
CREATE OR REPLACE FUNCTION public.helpdesk_tickets_guard_insert()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF app.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.assigned_to IS NOT NULL
     OR NEW.resolved_at IS NOT NULL
     OR NEW.resolved_by IS NOT NULL
     OR NEW.closed_at IS NOT NULL
     OR NEW.resolution_note IS NOT NULL
     OR NEW.reopened_count <> 0
     OR NEW.status <> 'open' THEN
    RAISE EXCEPTION
      'A new ticket starts open, unassigned and unresolved. The desk records the rest.'
      USING errcode = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdt__guard_insert ON public.helpdesk_tickets;
CREATE TRIGGER trg_hdt__guard_insert
  BEFORE INSERT ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION public.helpdesk_tickets_guard_insert();

DROP TRIGGER IF EXISTS trg_hdt__stamp ON public.helpdesk_tickets;
CREATE TRIGGER trg_hdt__stamp
  BEFORE INSERT ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_hdt__touch ON public.helpdesk_tickets;
CREATE TRIGGER trg_hdt__touch
  BEFORE UPDATE ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

DROP TRIGGER IF EXISTS trg_helpdesk_tickets__audit ON public.helpdesk_tickets;
CREATE TRIGGER trg_helpdesk_tickets__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.helpdesk_tickets
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 7. Message author, and the first-response clock
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.helpdesk_messages_stamp_author()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  -- Always the caller, never what was sent. An admin writing on the desk's
  -- behalf is still writing as themselves.
  NEW.author_profile_id := app.ctx_actor_id();
  IF NEW.author_profile_id IS NULL THEN
    RAISE EXCEPTION 'A message must have an author.' USING errcode = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdm__author ON public.helpdesk_messages;
CREATE TRIGGER trg_hdm__author
  BEFORE INSERT ON public.helpdesk_messages
  FOR EACH ROW EXECUTE FUNCTION public.helpdesk_messages_stamp_author();

/*
  The first reply stops the first clock.

  SECURITY DEFINER: the update lands on `helpdesk_tickets`, and the person
  writing the reply is a desk member who may not hold UPDATE on the requester's
  ticket through any policy. The write is narrow — one column, only when it is
  still NULL, only from a message that already passed its own RLS check.

  An internal note does NOT count: the promise is a reply to the requester, and a
  desk that could stop the clock by talking to itself would always meet it.
*/
CREATE OR REPLACE FUNCTION public.helpdesk_messages_mark_first_response()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_requester_profile uuid;
BEGIN
  IF NEW.is_internal THEN
    RETURN NEW;
  END IF;

  SELECT e.profile_id INTO v_requester_profile
    FROM public.helpdesk_tickets h
    JOIN public.employees e ON e.id = h.employee_id
   WHERE h.id = NEW.ticket_id;

  IF v_requester_profile IS NOT DISTINCT FROM NEW.author_profile_id THEN
    RETURN NEW;   -- the requester chasing their own ticket is not a response
  END IF;

  UPDATE public.helpdesk_tickets
     SET first_responded_at = NEW.created_at
   WHERE id = NEW.ticket_id
     AND first_responded_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdm__first_response ON public.helpdesk_messages;
CREATE TRIGGER trg_hdm__first_response
  AFTER INSERT ON public.helpdesk_messages
  FOR EACH ROW EXECUTE FUNCTION public.helpdesk_messages_mark_first_response();

-- -----------------------------------------------------------------------------
-- 8. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.helpdesk_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helpdesk_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hdt__self__select ON public.helpdesk_tickets;
CREATE POLICY hdt__self__select ON public.helpdesk_tickets
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS hdt__self__insert ON public.helpdesk_tickets;
CREATE POLICY hdt__self__insert ON public.helpdesk_tickets
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id() AND status = 'open');

-- Cancelling and reopening are the requester's; trg_hdt__guard decides which
-- transitions those are.
DROP POLICY IF EXISTS hdt__self__update ON public.helpdesk_tickets;
CREATE POLICY hdt__self__update ON public.helpdesk_tickets
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id())
  WITH CHECK (employee_id = app.current_employee_id());

-- The assignee, whoever they are. Not a role check: a ticket handed to one
-- person is that person's to read and work, and no membership table exists yet.
DROP POLICY IF EXISTS hdt__assignee__select ON public.helpdesk_tickets;
CREATE POLICY hdt__assignee__select ON public.helpdesk_tickets
  FOR SELECT TO authenticated
  USING (assigned_to = app.ctx_actor_id());

DROP POLICY IF EXISTS hdt__assignee__update ON public.helpdesk_tickets;
CREATE POLICY hdt__assignee__update ON public.helpdesk_tickets
  FOR UPDATE TO authenticated
  USING (assigned_to = app.ctx_actor_id())
  WITH CHECK (assigned_to = app.ctx_actor_id());

-- P8 admin, scoped. Administrators ARE the desk on this deployment.
DROP POLICY IF EXISTS hdt__admin__select ON public.helpdesk_tickets;
CREATE POLICY hdt__admin__select ON public.helpdesk_tickets
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS hdt__admin__insert ON public.helpdesk_tickets;
CREATE POLICY hdt__admin__insert ON public.helpdesk_tickets
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS hdt__admin__update ON public.helpdesk_tickets;
CREATE POLICY hdt__admin__update ON public.helpdesk_tickets
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

/*
  Messages inherit the ticket's visibility, plus one subtraction: an internal
  note is invisible to the requester. Written as EXISTS against the ticket rather
  than repeating the ownership rules, so the two can never drift apart.
*/
DROP POLICY IF EXISTS hdm__participant__select ON public.helpdesk_messages;
CREATE POLICY hdm__participant__select ON public.helpdesk_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.helpdesk_tickets h
       WHERE h.id = helpdesk_messages.ticket_id
         AND (
           (h.employee_id = app.current_employee_id() AND NOT helpdesk_messages.is_internal)
           OR h.assigned_to = app.ctx_actor_id()
           OR (app.is_admin() AND app.admin_scope_covers(h.employee_id))
         )
    )
  );

/*
  Who may write, and what they may write.

  The requester may reply on their own ticket while it is still live — and may
  NOT mark the message internal, which is the whole reason `is_internal` is
  tested here rather than left to the browser. A closed ticket takes no more
  messages: reopen it first, which is a recorded event.
*/
DROP POLICY IF EXISTS hdm__participant__insert ON public.helpdesk_messages;
CREATE POLICY hdm__participant__insert ON public.helpdesk_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.helpdesk_tickets h
       WHERE h.id = helpdesk_messages.ticket_id
         AND (
           (h.employee_id = app.current_employee_id()
             AND NOT helpdesk_messages.is_internal
             AND h.status NOT IN ('closed','cancelled'))
           OR h.assigned_to = app.ctx_actor_id()
           OR (app.is_admin() AND app.admin_scope_covers(h.employee_id))
         )
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.helpdesk_tickets TO authenticated;
REVOKE DELETE ON public.helpdesk_tickets FROM authenticated;
-- Append-only, enforced by the grant and not only by the absent policy.
GRANT SELECT, INSERT ON public.helpdesk_messages TO authenticated;
REVOKE UPDATE, DELETE ON public.helpdesk_messages FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.helpdesk_tickets TO service_role;
    GRANT SELECT, INSERT ON public.helpdesk_messages TO service_role;
  END IF;
END $$;

COMMIT;
