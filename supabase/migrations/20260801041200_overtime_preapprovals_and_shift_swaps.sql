-- =============================================================================
-- 20260801041200 — the two detail tables the approvals engine already expects:
--                  overtime_preapprovals and shift_swaps
-- =============================================================================
--
-- WHY THIS FILE EXISTS
--
-- Both request types are fully wired and have been since day one, and both are
-- unusable, for the same reason: the DETAIL TABLE was never created.
--
--   * 002900 whitelists both names in `ck_request_types__detail_table`
--     ('overtime_preapprovals','shift_swaps' — line 58), so the engine was
--     always designed to carry them.
--   * 004500 seeds the request types `OT_PREAPPROVAL` (detail_table
--     'overtime_preapprovals', SLA 6h, escalation 12h) and `SHIFT_SWAP`
--     (detail_table 'shift_swaps', SLA 12h, escalation 24h).
--   * 004500 ALSO SEEDS BOTH APPROVAL CHAINS ALREADY — `AC-OT` and
--     `AC-SHIFT-SWAP` (lines 150–155), each with one level: level 1
--     `reporting_manager` (lines 188–189), each `skip_if_same_as_previous`.
--     `UPDATE request_types SET default_approval_chain_id` at the end of that
--     seed points both request types at them.
--
-- SO THIS MIGRATION CREATES NO CHAIN. Creating a second chain for either type
-- would give `create_approval_request` two candidates to pick between on
-- priority, and the seeded one is already correct: the person who owns the
-- roster and the overtime budget is the reporting manager. `finance` is
-- deliberately absent from both — `resolve_approver_kind('finance')` requires
-- membership of a department coded `FIN`, which on this deployment is empty, so
-- a finance level would silently fall through the `resolve_approvers` ladder to
-- hr_admin (the same trap 040600 unpicked for claims). Admins can still act on
-- any level: `act_on_approval` honours `v_is_admin` as an override.
--
-- Section 3 below re-asserts level 1 ONLY IF a chain somehow has no levels —
-- `create_approval_request` raises 'approval chain % has no levels' and refuses
-- the request outright, so a chain without levels is the same dead end as a
-- missing table. On this deployment it is a no-op.
--
-- NO MONEY COLUMNS ON EITHER TABLE, DELIBERATELY. Overtime is paid from
-- `attendance_days.approved_overtime_minutes` by `compute_payslip` (023) as the
-- `OT` component; a rupee figure stored on a pre-approval would be a second,
-- staler answer to "what is owed", and the screens would have to choose between
-- them. A pre-approval authorises TIME. Where a paise amount is ever needed it
-- belongs on the payslip line, in integer paise, as everywhere else.
--
-- REFUSALS RAISE 23514 / 42501. `WRITE_CODE_KIND` in `src/shared/api/write.ts`
-- maps those to `conflict` / `forbidden`, and `isRuleRejection` shows the
-- message verbatim — so the wording below is for the person on the floor, not
-- for a log line.
-- =============================================================================

BEGIN;

-- `approval_chain_levels` is audited (038 attaches audit.log_changes to it), and
-- audit rows carry the actor source. 'migration' is the only honest value here —
-- no human typed these rows.
SELECT set_config('app.reason', 'migration 041200: create overtime_preapprovals and shift_swaps, the detail tables AC-OT and AC-SHIFT-SWAP have always pointed at', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. overtime_preapprovals
-- -----------------------------------------------------------------------------
--
-- One row = "I expect to work N hours beyond my shift on this date, because X".
-- Raised BEFORE the hours are worked; that is the entire point of the request
-- type, and section 1c enforces it rather than trusting the form.

CREATE TABLE IF NOT EXISTS public.overtime_preapprovals (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id          uuid        NOT NULL,
  ot_date              date        NOT NULL,   -- IST calendar date the OT falls on
  -- The rostered shift the overtime EXTENDS. Nullable: a call-in on a weekly off
  -- extends no shift, and refusing that row would push the commonest banquet
  -- case (extra hands on a Saturday) outside the system entirely.
  shift_id             uuid        NULL,
  expected_hours       numeric(5,2) NOT NULL,
  approved_hours       numeric(5,2) NULL,      -- an approver may cut it back
  reason               text        NOT NULL,
  status               public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id  uuid        NULL,
  decided_by           uuid        NULL,
  decided_at           timestamptz NULL,
  decided_comment      text        NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NULL,
  CONSTRAINT pk_overtime_preapprovals PRIMARY KEY (id),
  CONSTRAINT fk_otp__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_otp__shift_id
    FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE RESTRICT,
  -- Plain FK, not the deferred sweep (049): `approval_requests` exists from
  -- 002900, which is long before this file.
  CONSTRAINT fk_otp__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_otp__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_otp__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_otp__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Upper bound of 12: `shifts.duration_minutes` tops out around a 9-hour day
  -- and the Karnataka S&E cap on spread-over is 12 hours. A request for 30
  -- hours is a typo, and a typo that reaches an approver gets approved.
  CONSTRAINT ck_otp__expected_hours CHECK (expected_hours > 0 AND expected_hours <= 12),
  CONSTRAINT ck_otp__approved_hours CHECK (
    approved_hours IS NULL OR (approved_hours >= 0 AND approved_hours <= expected_hours)),
  -- The reason is the only thing an approver at 11pm has to go on.
  CONSTRAINT ck_otp__reason CHECK (length(btrim(reason)) >= 5),
  CONSTRAINT ck_otp__no_sentinel_dates CHECK (ot_date <= DATE '2100-01-01'),
  CONSTRAINT ck_otp__decided_fields CHECK (
    status NOT IN ('approved','rejected')
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

COMMENT ON TABLE public.overtime_preapprovals IS
  'Overtime authorised BEFORE it is worked. Detail table for request type OT_PREAPPROVAL (chain AC-OT, seeded 004500). Carries hours, never money: payroll pays attendance_days.approved_overtime_minutes.';
COMMENT ON COLUMN public.overtime_preapprovals.expected_hours IS
  'Hours as the employee states them on the form. Attendance keeps MINUTES (attendance_days.overtime_minutes) and remains the payable truth — this column is the authorisation, not the measurement.';
COMMENT ON COLUMN public.overtime_preapprovals.shift_id IS
  'The rostered shift these hours extend. Null when the overtime extends nothing (a call-in on a weekly off).';

CREATE INDEX IF NOT EXISTS idx_otp__employee_date
  ON public.overtime_preapprovals (employee_id, ot_date DESC);
CREATE INDEX IF NOT EXISTS idx_otp__status
  ON public.overtime_preapprovals (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_otp__shift
  ON public.overtime_preapprovals (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_otp__approval
  ON public.overtime_preapprovals (approval_request_id) WHERE approval_request_id IS NOT NULL;

-- One LIVE pre-approval per employee per date. Two open requests for the same
-- night would route to the same manager twice and, once both are approved,
-- leave nobody able to say which one the paid minutes belong to. Rejected,
-- cancelled and withdrawn rows are excluded so a corrected re-submission is
-- possible the same day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_otp__employee_date_live
  ON public.overtime_preapprovals (employee_id, ot_date)
  WHERE status NOT IN ('rejected','cancelled','withdrawn','expired','failed');

/*
  Pre-approval means PRE. Without this the table happily accepts overtime
  "requested" for last Tuesday, which is not an authorisation — it is a
  retrospective claim wearing an authorisation's name, and the whole reason the
  request type has a 6-hour SLA is that it is supposed to be answered before the
  shift starts.

  util.ist_today(), never CURRENT_DATE: the server clock is UTC and a 10pm IST
  submission is already tomorrow in UTC, so CURRENT_DATE would reject the exact
  late-evening request this table exists for.

  BEFORE INSERT OR UPDATE OF ot_date, and on UPDATE only when the date ACTUALLY
  MOVES. `UPDATE OF ot_date` fires whenever the column is named in the statement,
  even when the value is identical — and PostgREST PATCH bodies routinely carry
  the whole row. Without the IS NOT DISTINCT FROM short-circuit below, an
  approver acting the morning after a night shift, or a requester withdrawing a
  request the next day, would be refused with a message telling them to raise an
  attendance regularization: the date is in the past by then, but nobody is
  trying to change it. Only a NEW past date is a defect.
*/
CREATE OR REPLACE FUNCTION public.overtime_preapprovals_check_date()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_today date := util.ist_today();
BEGIN
  -- The row is being updated but the date is not moving: nothing to police.
  IF TG_OP = 'UPDATE' AND NEW.ot_date IS NOT DISTINCT FROM OLD.ot_date THEN
    RETURN NEW;
  END IF;

  IF NEW.ot_date < v_today THEN
    RAISE EXCEPTION
      'Overtime for % is in the past, and overtime has to be approved before it is worked. If you have already worked the hours, raise an attendance regularization instead.',
      to_char(NEW.ot_date, 'DD Mon YYYY')
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_otp__check_date ON public.overtime_preapprovals;
CREATE TRIGGER trg_otp__check_date
  BEFORE INSERT OR UPDATE OF ot_date ON public.overtime_preapprovals
  FOR EACH ROW EXECUTE FUNCTION public.overtime_preapprovals_check_date();

DROP TRIGGER IF EXISTS trg_otp__stamp ON public.overtime_preapprovals;
CREATE TRIGGER trg_otp__stamp
  BEFORE INSERT ON public.overtime_preapprovals
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_otp__touch ON public.overtime_preapprovals;
CREATE TRIGGER trg_otp__touch
  BEFORE UPDATE ON public.overtime_preapprovals
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- A public table with RLS off is readable by every signed-in user through
-- PostgREST and fails the post-flight audit. Enabled before any policy exists,
-- so there is no window in which the table is open.
ALTER TABLE public.overtime_preapprovals ENABLE ROW LEVEL SECURITY;

-- P1 self: read own; raise own; edit while still yours to edit.
DROP POLICY IF EXISTS otp__self__select ON public.overtime_preapprovals;
CREATE POLICY otp__self__select ON public.overtime_preapprovals
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS otp__self__insert ON public.overtime_preapprovals;
CREATE POLICY otp__self__insert ON public.overtime_preapprovals
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

-- The WITH CHECK adds 'cancelled'/'withdrawn' to the USING set so a requester
-- can retract their own request but cannot walk it forward to 'approved' —
-- decisions belong to act_on_approval (002900), which is SECURITY DEFINER and
-- writes the approval_actions trail.
DROP POLICY IF EXISTS otp__self__update ON public.overtime_preapprovals;
CREATE POLICY otp__self__update ON public.overtime_preapprovals
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- P5 manager: team read. app.can_see_employee covers reporting line plus
-- delegated team view, which is exactly who AC-OT can route this to.
DROP POLICY IF EXISTS otp__manager__select ON public.overtime_preapprovals;
CREATE POLICY otp__manager__select ON public.overtime_preapprovals
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- P8 admin, scope-limited: an admin scoped to one location has no business
-- reading another location's rosters.
DROP POLICY IF EXISTS otp__admin__select ON public.overtime_preapprovals;
CREATE POLICY otp__admin__select ON public.overtime_preapprovals
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS otp__admin__insert ON public.overtime_preapprovals;
CREATE POLICY otp__admin__insert ON public.overtime_preapprovals
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS otp__admin__update ON public.overtime_preapprovals;
CREATE POLICY otp__admin__update ON public.overtime_preapprovals
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- No DELETE for anyone: a withdrawn overtime request is evidence of what was
-- asked for and refused, and status carries that without erasing the row.
GRANT SELECT, INSERT, UPDATE ON public.overtime_preapprovals TO authenticated;
REVOKE DELETE ON public.overtime_preapprovals FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.overtime_preapprovals TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. shift_swaps
-- -----------------------------------------------------------------------------
--
-- One row = "I take your Tuesday night, you take my Saturday morning", and it
-- needs THREE parties to agree: the requester (by raising it), the counterparty
-- (consent, recorded here) and the manager (approval, recorded on the approval
-- request). The counterparty's yes is stored on this table and not inferred
-- from silence — a swap nobody agreed to is a no-show with paperwork.
--
-- `roster_slots` has carried `swap_requested_with_employee_id` / `swap_status`
-- since 015 with nothing to write them. Those columns are the ROSTER's view of
-- a swap; this table is the REQUEST, and the slot ids below are how an apply
-- step will later find the two slots to rewrite. Both are nullable because a
-- swap is commonly agreed before the week's roster is published.

CREATE TABLE IF NOT EXISTS public.shift_swaps (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  requester_employee_id       uuid        NOT NULL,
  counterparty_employee_id    uuid        NOT NULL,
  requester_date              date        NOT NULL,
  requester_shift_id          uuid        NULL,
  requester_roster_slot_id    uuid        NULL,
  counterparty_date           date        NOT NULL,
  counterparty_shift_id       uuid        NULL,
  counterparty_roster_slot_id uuid        NULL,
  reason                      text        NULL,
  -- The counterparty's consent, as its own three-state fact. Not a boolean:
  -- 'pending' and 'declined' are different answers and only one of them means
  -- the requester should try someone else.
  consent_status              text        NOT NULL DEFAULT 'pending',
  consent_at                  timestamptz NULL,
  consent_by                  uuid        NULL,
  consent_comment             text        NULL,
  status                      public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id         uuid        NULL,
  decided_by                  uuid        NULL,
  decided_at                  timestamptz NULL,
  decided_comment             text        NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  CONSTRAINT pk_shift_swaps PRIMARY KEY (id),
  CONSTRAINT fk_ss__requester_employee_id
    FOREIGN KEY (requester_employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ss__counterparty_employee_id
    FOREIGN KEY (counterparty_employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ss__requester_shift_id
    FOREIGN KEY (requester_shift_id) REFERENCES public.shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ss__counterparty_shift_id
    FOREIGN KEY (counterparty_shift_id) REFERENCES public.shifts(id) ON DELETE RESTRICT,
  -- SET NULL, not CASCADE: republishing a week deletes and recreates slots, and
  -- an agreed swap must survive that rather than vanish with the draft.
  CONSTRAINT fk_ss__requester_roster_slot_id
    FOREIGN KEY (requester_roster_slot_id) REFERENCES public.roster_slots(id) ON DELETE SET NULL,
  CONSTRAINT fk_ss__counterparty_roster_slot_id
    FOREIGN KEY (counterparty_roster_slot_id) REFERENCES public.roster_slots(id) ON DELETE SET NULL,
  CONSTRAINT fk_ss__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_ss__consent_by
    FOREIGN KEY (consent_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_ss__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_ss__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_ss__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- A swap with yourself is a shift change, and it would let anyone self-approve
  -- a roster edit through a request type whose only level is their manager.
  CONSTRAINT ck_ss__distinct_employees
    CHECK (requester_employee_id <> counterparty_employee_id),
  CONSTRAINT ck_ss__consent_status
    CHECK (consent_status IN ('pending','accepted','declined')),
  -- An answer has an author and a time, or it is not an answer.
  CONSTRAINT ck_ss__consent_fields CHECK (
    consent_status = 'pending'
    OR (consent_at IS NOT NULL AND consent_by IS NOT NULL)),
  /*
    THE RULE THIS TABLE EXISTS FOR: a swap may not reach a manager, and may not
    be approved, until the other person has said yes. Without it the requester
    submits, the manager approves in the 12-hour SLA window, and the first the
    counterparty hears of their new Tuesday night is the roster.
    'draft' is the pre-consent state; the terminal negative states stay legal so
    a declined swap can be cancelled and closed.
  */
  CONSTRAINT ck_ss__consent_before_approval CHECK (
    status IN ('draft','cancelled','withdrawn','rejected','expired','failed')
    OR consent_status = 'accepted'),
  CONSTRAINT ck_ss__no_sentinel_dates CHECK (
    requester_date <= DATE '2100-01-01' AND counterparty_date <= DATE '2100-01-01'),
  CONSTRAINT ck_ss__decided_fields CHECK (
    status NOT IN ('approved','rejected')
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

COMMENT ON TABLE public.shift_swaps IS
  'A rostered shift traded between two employees. Detail table for request type SHIFT_SWAP (chain AC-SHIFT-SWAP, seeded 004500). Needs the counterparty''s consent (consent_status) before it may leave draft — see ck_ss__consent_before_approval.';
COMMENT ON COLUMN public.shift_swaps.consent_status IS
  'The counterparty''s own answer. Written only by them (or an admin) — trg_ss__consent_guard refuses anyone else, and refuses them any other column.';
COMMENT ON COLUMN public.shift_swaps.requester_roster_slot_id IS
  'The published roster_slots row being given away, when the week is already published. Null before publication; ON DELETE SET NULL so a republish does not take the agreed swap with it.';

CREATE INDEX IF NOT EXISTS idx_ss__requester
  ON public.shift_swaps (requester_employee_id, requester_date DESC);
CREATE INDEX IF NOT EXISTS idx_ss__counterparty
  ON public.shift_swaps (counterparty_employee_id, counterparty_date DESC);
-- The counterparty's "waiting on me" list is the screen that makes consent real.
CREATE INDEX IF NOT EXISTS idx_ss__consent_pending
  ON public.shift_swaps (counterparty_employee_id)
  WHERE consent_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ss__status
  ON public.shift_swaps (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_ss__approval
  ON public.shift_swaps (approval_request_id) WHERE approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ss__requester_slot
  ON public.shift_swaps (requester_roster_slot_id) WHERE requester_roster_slot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ss__counterparty_slot
  ON public.shift_swaps (counterparty_roster_slot_id) WHERE counterparty_roster_slot_id IS NOT NULL;

-- One live swap per requester per date, for the same reason as the OT index:
-- two approved swaps of one shift cannot both be applied to the roster.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ss__requester_date_live
  ON public.shift_swaps (requester_employee_id, requester_date)
  WHERE status NOT IN ('rejected','cancelled','withdrawn','expired','failed');

/*
  Column-level authority, which RLS cannot express. Two halves, and BOTH are
  load-bearing:

  (a) The counterparty must be able to UPDATE this row — that is how consent is
      recorded — but an UPDATE policy grants the WHOLE row. Without a guard the
      person being asked to cover a shift could rewrite the dates, swap in a
      different shift, or set status='approved' and skip the manager entirely.

  (b) The REQUESTER must NOT be able to write the consent columns. This is the
      half that decides whether the table means anything. ss__self__update lets
      the requester update their own row while it is draft/pending, and the
      consent columns are on that same row, so without this branch a requester
      could set consent_status='accepted' with a consent_by of their choosing,
      satisfy ck_ss__consent_before_approval, push status to 'pending' and have
      a manager approve a swap the other person never saw. Every other guard in
      this file would have passed. Consent that the asker can write is not
      consent.

  Identity is read from OLD, never NEW: who the two parties are is a fact of the
  stored row, and taking it from the submitted payload would let a caller talk
  their way out of the branch that governs them by rewriting the very columns
  being policed.

  The consent stamp is applied HERE rather than trusted from the client, so
  consent_at/consent_by cannot be backdated or attributed to someone who never
  clicked; and when the requester changes WHAT IS BEING SWAPPED after the other
  person agreed, the agreement is retracted rather than silently carried over to
  terms nobody accepted.

  SECURITY DEFINER because app.is_admin() reads user_roles, which is itself
  RLS-protected. STABLE helpers only; no writes to other tables, so no recursion.
*/
CREATE OR REPLACE FUNCTION public.shift_swaps_guard_consent()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_me    uuid    := app.current_employee_id();
  v_admin boolean := app.is_admin();
  -- What is being swapped. Consent is an answer to exactly this tuple.
  v_terms_changed boolean :=
    (NEW.requester_employee_id, NEW.counterparty_employee_id,
     NEW.requester_date, NEW.requester_shift_id, NEW.requester_roster_slot_id,
     NEW.counterparty_date, NEW.counterparty_shift_id, NEW.counterparty_roster_slot_id)
    IS DISTINCT FROM
    (OLD.requester_employee_id, OLD.counterparty_employee_id,
     OLD.requester_date, OLD.requester_shift_id, OLD.requester_roster_slot_id,
     OLD.counterparty_date, OLD.counterparty_shift_id, OLD.counterparty_roster_slot_id);
  v_consent_changed boolean :=
    (NEW.consent_status, NEW.consent_at, NEW.consent_by, NEW.consent_comment)
    IS DISTINCT FROM
    (OLD.consent_status, OLD.consent_at, OLD.consent_by, OLD.consent_comment);
BEGIN
  -- 1. THE COUNTERPARTY. Consent columns and nothing else.
  IF v_me IS NOT NULL AND v_me = OLD.counterparty_employee_id AND NOT v_admin THEN
    IF v_terms_changed
       OR (NEW.reason, NEW.status, NEW.approval_request_id,
           NEW.decided_by, NEW.decided_at, NEW.decided_comment)
          IS DISTINCT FROM
          (OLD.reason, OLD.status, OLD.approval_request_id,
           OLD.decided_by, OLD.decided_at, OLD.decided_comment)
    THEN
      RAISE EXCEPTION
        'You can accept or decline this swap, but only the person who asked for it can change what is being swapped.'
        USING errcode = '42501';
    END IF;

    -- The stamp is the server's, not the client's — including the case where
    -- the client tries to move consent_at/consent_by on their own.
    IF NEW.consent_status IS DISTINCT FROM OLD.consent_status THEN
      NEW.consent_at := now();
      NEW.consent_by := app.ctx_actor_id();
    ELSE
      NEW.consent_at := OLD.consent_at;
      NEW.consent_by := OLD.consent_by;
    END IF;

    RETURN NEW;
  END IF;

  -- 2. THE REQUESTER. Everything except the other person's answer.
  IF v_me IS NOT NULL AND v_me = OLD.requester_employee_id AND NOT v_admin THEN
    IF v_consent_changed THEN
      RAISE EXCEPTION
        'Only the person you asked can accept or decline this swap. You cannot record their answer for them.'
        USING errcode = '42501';
    END IF;

    -- Changing the terms retracts an answer given to the old ones.
    IF v_terms_changed AND OLD.consent_status <> 'pending' THEN
      IF NEW.status <> 'draft' THEN
        RAISE EXCEPTION
          'This swap has already been sent for approval. Withdraw it before changing what is being swapped, so the other person can agree to the new terms.'
          USING errcode = '23514';
      END IF;
      NEW.consent_status := 'pending';
      NEW.consent_at     := NULL;
      NEW.consent_by     := NULL;
    END IF;

    RETURN NEW;
  END IF;

  -- 3. ADMINS and the SECURITY DEFINER engine paths (no employee in context).
  -- An admin recording a consent given on paper should not have to hand-fill the
  -- stamp that ck_ss__consent_fields demands — but a value they DID supply is
  -- kept, because "the counterparty said yes on Tuesday" is better evidence than
  -- "an admin typed it today".
  IF NEW.consent_status <> 'pending' THEN
    IF NEW.consent_at IS NULL THEN
      NEW.consent_at := now();
    END IF;
    IF NEW.consent_by IS NULL THEN
      NEW.consent_by := app.ctx_actor_id();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ss__consent_guard ON public.shift_swaps;
CREATE TRIGGER trg_ss__consent_guard
  BEFORE UPDATE ON public.shift_swaps
  FOR EACH ROW EXECUTE FUNCTION public.shift_swaps_guard_consent();

DROP TRIGGER IF EXISTS trg_ss__stamp ON public.shift_swaps;
CREATE TRIGGER trg_ss__stamp
  BEFORE INSERT ON public.shift_swaps
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_ss__touch ON public.shift_swaps;
CREATE TRIGGER trg_ss__touch
  BEFORE UPDATE ON public.shift_swaps
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.shift_swaps ENABLE ROW LEVEL SECURITY;

-- P1 self: BOTH sides are "self" here. A person asked to cover a shift who
-- cannot read the request cannot consent to it.
DROP POLICY IF EXISTS ss__self__select ON public.shift_swaps;
CREATE POLICY ss__self__select ON public.shift_swaps
  FOR SELECT TO authenticated
  USING (requester_employee_id = app.current_employee_id()
      OR counterparty_employee_id = app.current_employee_id());

-- Only the requester raises it: `create_approval_request` makes the subject
-- employee the one whose manager decides, and letting A file a swap "from" B
-- would route B's roster change to A's manager.
--
-- 'draft' ONLY, unlike every other self-insert policy in this schema. A swap is
-- born unconsented (`consent_status = 'pending'` below), and
-- ck_ss__consent_before_approval forbids status='pending' while consent is not
-- 'accepted' — so admitting 'pending' here would advertise a path that the
-- CHECK rejects with a raw 23514 every single time. The requester reaches
-- 'pending' through ss__self__update, after the answer arrives.
DROP POLICY IF EXISTS ss__self__insert ON public.shift_swaps;
CREATE POLICY ss__self__insert ON public.shift_swaps
  FOR INSERT TO authenticated
  WITH CHECK (requester_employee_id = app.current_employee_id()
              AND status = 'draft'
              -- A swap cannot be born already consented to.
              AND consent_status = 'pending');

-- The requester's edit window. It reaches every column on the row, which is why
-- branch 2 of trg_ss__consent_guard exists: the consent columns sit here too,
-- and this policy alone would let the asker write their own answer.
DROP POLICY IF EXISTS ss__self__update ON public.shift_swaps;
CREATE POLICY ss__self__update ON public.shift_swaps
  FOR UPDATE TO authenticated
  USING (requester_employee_id = app.current_employee_id()
         AND status IN ('draft','pending'))
  WITH CHECK (requester_employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- The consent path. Wide on rows, narrow on columns — trg_ss__consent_guard is
-- what makes that true, and it is not optional to this policy.
DROP POLICY IF EXISTS ss__counterparty__update ON public.shift_swaps;
CREATE POLICY ss__counterparty__update ON public.shift_swaps
  FOR UPDATE TO authenticated
  USING (counterparty_employee_id = app.current_employee_id()
         AND status IN ('draft','pending'))
  WITH CHECK (counterparty_employee_id = app.current_employee_id());

-- P5 manager: either side's manager needs to see it, because AC-SHIFT-SWAP
-- routes to the requester's reporting manager but the swap moves both rosters.
DROP POLICY IF EXISTS ss__manager__select ON public.shift_swaps;
CREATE POLICY ss__manager__select ON public.shift_swaps
  FOR SELECT TO authenticated
  USING (app.can_see_employee(requester_employee_id)
      OR app.can_see_employee(counterparty_employee_id));

-- P8 admin. Scope covers the requester: that is the subject employee on the
-- approval request, so it is the scope the approvals inbox already applies.
DROP POLICY IF EXISTS ss__admin__select ON public.shift_swaps;
CREATE POLICY ss__admin__select ON public.shift_swaps
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(requester_employee_id));

DROP POLICY IF EXISTS ss__admin__insert ON public.shift_swaps;
CREATE POLICY ss__admin__insert ON public.shift_swaps
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(requester_employee_id));

DROP POLICY IF EXISTS ss__admin__update ON public.shift_swaps;
CREATE POLICY ss__admin__update ON public.shift_swaps
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(requester_employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(requester_employee_id));

GRANT SELECT, INSERT, UPDATE ON public.shift_swaps TO authenticated;
REVOKE DELETE ON public.shift_swaps FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.shift_swaps TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. The chains: verification, not creation
-- -----------------------------------------------------------------------------
--
-- AC-OT and AC-SHIFT-SWAP were both seeded by 004500 and both already carry
-- level 1 = 'reporting_manager'. NOTHING BELOW CREATES A CHAIN.
--
-- The one failure this repairs: `create_approval_request` counts the levels of
-- the selected chain and raises 'approval chain % has no levels' when the count
-- is zero, which is the same dead end for the user as the missing table this
-- migration just fixed. So if either chain has lost its levels, put level 1
-- back — reporting_manager, because the roster and the overtime budget are the
-- manager's, and explicitly NOT 'finance', which resolves to the empty FIN
-- department on this deployment (see 040600 §2).
--
-- On a healthy deployment the NOT EXISTS matches nothing and this is a no-op;
-- ON CONFLICT makes it safe to run twice regardless.

INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, 1, 'reporting_manager', false, true
FROM public.approval_chains ac
WHERE ac.code IN ('AC-OT','AC-SHIFT-SWAP')
  AND ac.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_chain_levels l
    WHERE l.approval_chain_id = ac.id)
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- Both request types must point at their default chain, or
-- `create_approval_request`'s fallback path has nothing to fall back to. 004500
-- already does this for every chain with is_default; re-asserted here narrowly
-- because these two are the ones this migration is bringing to life.
UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.request_type_id = rt.id
   AND ac.is_default
   AND ac.is_active
   AND ac.deleted_at IS NULL
   AND rt.code IN ('OT_PREAPPROVAL','SHIFT_SWAP')
   AND rt.deleted_at IS NULL
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

-- -----------------------------------------------------------------------------
-- 4. Audit triggers
-- -----------------------------------------------------------------------------
--
-- Attached here rather than in 038 so this migration is self-contained and 038
-- keeps its "one file, one pass over the schema as it stood" property. Same
-- shape as every entry in that file: AFTER INSERT OR UPDATE OR DELETE, one
-- explicit trigger per table, so both are greppable alongside the rest.
--
-- These belong in the audit set — a roster changed by consent and a night of
-- paid overtime are both things somebody will later need to reconstruct. Neither
-- goes in audit.reason_required_tables: an employee raising their own overtime
-- request should not be made to type a justification for the audit log on top of
-- the reason column the form already asks for.

DROP TRIGGER IF EXISTS trg_overtime_preapprovals__audit ON public.overtime_preapprovals;
CREATE TRIGGER trg_overtime_preapprovals__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.overtime_preapprovals
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_shift_swaps__audit ON public.shift_swaps;
CREATE TRIGGER trg_shift_swaps__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.shift_swaps
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

COMMIT;
