-- =============================================================================
-- 20260801041000 — document_requests: the table two request types have been
--                  pointing at since 045, plus the chain that routes them
-- =============================================================================
--
-- WHY THIS FILE EXISTS
--
-- `request_types` (seeded in 004500) already names `document_requests` as the
-- detail table for TWO codes:
--
--     PAYSLIP_REQUEST   'Request a payslip or salary certificate copy.'
--     DOCUMENT_REQUEST  'Request an HR document or letter.'
--
-- and `ck_request_types__detail_table` (029) lists `document_requests` among the
-- legal detail tables. The table itself was never created. So both tiles resolve
-- in the launcher, `CODE_TO_PATH` in `ApplyLauncher.page.tsx` sends both to
-- `/me/helpdesk`, and `/me/helpdesk` is an honest gap page that says so. The two
-- "ask HR for a copy" links on `MyPayslips.page.tsx` land in the same place.
-- This file gives those four entry points somewhere real to write to.
--
-- ONE TABLE, TWO REQUEST TYPES — WHY NOT TWO TABLES
--
-- 004500 already made the choice: both codes carry `detail_table =
-- 'document_requests'`. Splitting them now would mean editing a seeded row that
-- the CHECK constraint and every `approval_requests.detail_table` value depend
-- on. And the two are the same object: someone asks HR for a piece of paper, HR
-- produces it. What differs is which paper, so that is a column —
-- `request_kind` — not a table. It stores the request_type CODE verbatim
-- ('DOCUMENT_REQUEST' / 'PAYSLIP_REQUEST') so the string the caller passes to
-- `create_approval_request(p_request_type_code …)` and the string stored on the
-- row are the same token, with no mapping table to drift.
--
-- NO MONEY HERE. A document request has no amount, so there is no `_paise`
-- column to get wrong; `approval_chains` amount bands are left NULL for the same
-- reason, which makes the chain match every request (see `create_approval_request`
-- chain selection: a NULL band is an unconditional match).
--
-- REFUSALS RAISE 23514, which `WRITE_CODE_KIND` in `src/shared/api/write.ts`
-- maps to `conflict` and `isRuleRejection` shows to the user verbatim — so the
-- trigger messages below are written for the person filling the form.
-- =============================================================================

BEGIN;

-- `documents`, `settings` and friends sit in `audit.reason_required_tables`, and
-- the seeds below update `request_types`. audit.log_changes() demands a reason on
-- those UPDATEs; set it once for the transaction so the audit rows this
-- migration writes carry provenance instead of failing the migration.
-- 'migration' is the only actor_source a migration may claim.
SELECT set_config('app.reason', 'migration 041000: document_requests table for DOCUMENT_REQUEST/PAYSLIP_REQUEST, and the AC-DOCREQ chain that routes them to HR', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
--
-- Shape follows `reimbursement_claims` (002400): a detail row owned by one
-- employee, an `approval_status`, a nullable `approval_request_id` written by
-- the engine, and stamp/touch triggers. What it does NOT copy is the
-- `decided_by`/`decided_at`/`decided_comment` trio — the decision on a document
-- request lives in `approval_actions`, which is append-only, and a second copy
-- of a decision is a second thing that can disagree with the first. What IS kept
-- locally is FULFILMENT (`fulfilled_document_id`/`fulfilled_at`/`fulfilled_by`),
-- because approval and delivery are different events: an approved request with
-- no file attached is exactly the row HR needs to find, and no other table
-- records it.

CREATE TABLE IF NOT EXISTS public.document_requests (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id           uuid        NOT NULL,
  -- Verbatim request_types.code — see header. CHECK covers both tiles.
  request_kind          text        NOT NULL,
  -- WHAT is being asked for. Closed list, because the whole point of a queue is
  -- counting it: free text here would make "how many address proofs this month"
  -- unanswerable, which is the first question HR asks.
  document_kind         text        NOT NULL,
  -- The catalogue row, when the ask maps to one (PAYSLIP, FORM16, EXP_LETTER,
  -- RELIEVING_LETTER …). NULLABLE and SET NULL on delete: `document_kind` above
  -- is the load-bearing fact, and half the asks (address proof, bank letter,
  -- visa letter) have no `document_types` row at all on this deployment. A NOT
  -- NULL FK would force HR to invent catalogue entries to accept a request.
  document_type_id      uuid        NULL,
  -- WHICH PERIOD. A payslip ask is meaningless without one; a relieving letter
  -- has none. period_to NULL means "that single month/day".
  period_from           date        NULL,
  period_to             date        NULL,
  -- Who the letter must be addressed to — the bank, the landlord, the
  -- consulate. HR cannot type an address-proof letter without it, and it is the
  -- single most common reason a request bounces back to the employee.
  addressed_to          text        NULL,
  -- Free text: the reason, the spelling of a name, "need it before Friday".
  note                  text        NULL,
  -- IST, not now()::date: a request filed at 00:30 IST is filed today, and
  -- CURRENT_DATE on a UTC server would date it yesterday.
  requested_on          date        NOT NULL DEFAULT util.ist_today(),
  status                public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id   uuid        NULL,
  -- Delivery. Written only by an administrator (trg_dr__fulfilment below).
  fulfilled_document_id uuid        NULL,
  fulfilled_at          timestamptz NULL,
  fulfilled_by          uuid        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NULL,
  CONSTRAINT pk_document_requests PRIMARY KEY (id),
  CONSTRAINT fk_dr__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dr__document_type_id
    FOREIGN KEY (document_type_id) REFERENCES public.document_types(id) ON DELETE SET NULL,
  -- `approval_requests` exists since 029, so this is a plain inline FK; the
  -- deferred-FK sweep (004900) was only ever an ordering workaround for tables
  -- created before the engine.
  CONSTRAINT fk_dr__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_dr__fulfilled_document_id
    FOREIGN KEY (fulfilled_document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_dr__fulfilled_by
    FOREIGN KEY (fulfilled_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_dr__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_dr__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_dr__request_kind
    CHECK (request_kind IN ('DOCUMENT_REQUEST','PAYSLIP_REQUEST')),
  CONSTRAINT ck_dr__document_kind CHECK (document_kind IN
    ('payslip','salary_certificate','form16',
     'employment_letter','experience_letter','relieving_letter',
     'appointment_letter','increment_letter',
     'address_proof','bank_letter','visa_letter','noc','other'))
);

COMMENT ON TABLE public.document_requests IS
  'An employee asking HR for a copy of something: a payslip, a salary certificate, an employment or address-proof letter. Detail table for BOTH request types DOCUMENT_REQUEST and PAYSLIP_REQUEST (request_types.detail_table, seeded 004500) — request_kind says which tile it came from.';
COMMENT ON COLUMN public.document_requests.request_kind IS
  'The request_types.code verbatim: DOCUMENT_REQUEST or PAYSLIP_REQUEST. Same token the caller passes to create_approval_request, so no mapping table can drift.';
COMMENT ON COLUMN public.document_requests.document_kind IS
  'What is being asked for. Closed list so the HR queue can be counted and filtered; ''other'' is allowed but forced to carry a note.';
COMMENT ON COLUMN public.document_requests.period_from IS
  'Start of the period the document covers — the payslip month, the salary-certificate range. Mandatory for a PAYSLIP_REQUEST: nobody can issue "a payslip" without a month.';
COMMENT ON COLUMN public.document_requests.fulfilled_document_id IS
  'The file HR actually issued. Approval and delivery are separate events; an approved request with this still NULL is the work queue.';

-- CREATE TABLE IF NOT EXISTS silently skips EVERYTHING when the table already
-- exists — including any constraint added to the body later. So every rule that
-- is not part of the original body goes in as a guarded ALTER, which is also how
-- this file survives a re-run against a half-applied deployment.

-- A PAYSLIP_REQUEST must ask for something payroll issues. The two tiles are
-- separate in the launcher with their own labels and SLA; an address proof filed
-- under "Payslip Request" lands in a queue named after a thing it is not.
DO $$ BEGIN
  ALTER TABLE public.document_requests
    ADD CONSTRAINT ck_dr__payslip_kind CHECK (
      request_kind <> 'PAYSLIP_REQUEST'
      OR document_kind IN ('payslip','salary_certificate','form16'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- …and it must name the period. This is the one field HR cannot guess, and
-- guessing it wrong means issuing the wrong month's net pay to a bank.
DO $$ BEGIN
  ALTER TABLE public.document_requests
    ADD CONSTRAINT ck_dr__payslip_needs_period CHECK (
      request_kind <> 'PAYSLIP_REQUEST' OR period_from IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.document_requests
    ADD CONSTRAINT ck_dr__period_order CHECK (
      period_from IS NULL OR period_to IS NULL OR period_to >= period_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Same sentinel guard every dated table in this schema carries (002400): a
-- '9999-12-31' typed into a date box is a bug, not a request.
DO $$ BEGIN
  ALTER TABLE public.document_requests
    ADD CONSTRAINT ck_dr__no_sentinel_dates CHECK (
      requested_on <= DATE '2100-01-01'
      AND (period_from IS NULL OR period_from <= DATE '2100-01-01')
      AND (period_to   IS NULL OR period_to   <= DATE '2100-01-01'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 'other' with no explanation is a row nobody can act on — it produces a
-- follow-up phone call, which is the thing the queue exists to avoid.
DO $$ BEGIN
  ALTER TABLE public.document_requests
    ADD CONSTRAINT ck_dr__other_needs_note CHECK (
      document_kind <> 'other' OR length(btrim(coalesce(note, ''))) >= 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Fulfilment is one event: who and when travel together. Without this, a row can
-- claim it was delivered with nobody's name against it.
DO $$ BEGIN
  ALTER TABLE public.document_requests
    ADD CONSTRAINT ck_dr__fulfilment_pair CHECK (
      (fulfilled_at IS NULL) = (fulfilled_by IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_dr__employee ON public.document_requests (employee_id);
-- The HR queue: everything still owed. Partial, because settled rows are the
-- overwhelming majority within a month and none of them belong in this scan.
CREATE INDEX IF NOT EXISTS idx_dr__open
  ON public.document_requests (request_kind, requested_on)
  WHERE status IN ('draft','pending','in_progress','approved')
    AND fulfilled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dr__approval
  ON public.document_requests (approval_request_id)
  WHERE approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dr__document_type
  ON public.document_requests (document_type_id)
  WHERE document_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dr__fulfilled_document
  ON public.document_requests (fulfilled_document_id)
  WHERE fulfilled_document_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Guards
-- -----------------------------------------------------------------------------

/*
  A period that has not happened yet cannot be issued. Payroll for this month
  runs at month end; a request for next month's payslip is a request HR will
  reject by hand, one message at a time, unless the database says it first.

  util.ist_today(), never CURRENT_DATE: the server clock is UTC and the business
  is in IST, so between 18:30 and 23:59 UTC the two disagree by a day — which is
  exactly the window in which "this month" changes meaning.

  Not a CHECK constraint: CHECK bodies must be immutable and util.ist_today() is
  not, so this rule can only live in a trigger.
*/
CREATE OR REPLACE FUNCTION public.document_requests_check_period()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_today date := util.ist_today();
BEGIN
  IF NEW.period_from IS NOT NULL AND NEW.period_from > v_today THEN
    RAISE EXCEPTION
      'That period starts on %, which is in the future. A document can only be issued for a period that has already happened.',
      to_char(NEW.period_from, 'DD Mon YYYY')
      USING errcode = '23514';
  END IF;

  IF NEW.period_to IS NOT NULL AND NEW.period_to > v_today THEN
    RAISE EXCEPTION
      'That period ends on %, which is in the future. Ask for it once the period is over.',
      to_char(NEW.period_to, 'DD Mon YYYY')
      USING errcode = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dr__period ON public.document_requests;
CREATE TRIGGER trg_dr__period
  BEFORE INSERT OR UPDATE OF period_from, period_to ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION public.document_requests_check_period();

/*
  Fulfilment is HR's word, not the requester's.

  RLS grants the employee UPDATE on their own row while it is draft/pending, and
  RLS cannot restrict which COLUMNS that update touches — so without this guard
  an employee could set `fulfilled_document_id` and `fulfilled_at` on their own
  request and mark themselves served.

  SECURITY INVOKER (the default — deliberately not DEFINER): app.is_admin() must
  answer for the actual caller. A definer trigger would evaluate it for the
  migration's owner and wave every write through.
*/
CREATE OR REPLACE FUNCTION public.document_requests_guard_fulfilment()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF app.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.fulfilled_document_id IS NOT NULL
       OR NEW.fulfilled_at IS NOT NULL
       OR NEW.fulfilled_by IS NOT NULL THEN
      RAISE EXCEPTION
        'A request cannot be filed as already fulfilled. HR records the document once it has been issued.'
        USING errcode = '42501';
    END IF;
  ELSIF NEW.fulfilled_document_id IS DISTINCT FROM OLD.fulfilled_document_id
     OR NEW.fulfilled_at          IS DISTINCT FROM OLD.fulfilled_at
     OR NEW.fulfilled_by          IS DISTINCT FROM OLD.fulfilled_by THEN
    RAISE EXCEPTION
      'Only HR can record that this request has been fulfilled.'
      USING errcode = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dr__fulfilment ON public.document_requests;
CREATE TRIGGER trg_dr__fulfilment
  BEFORE INSERT OR UPDATE ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION public.document_requests_guard_fulfilment();

-- created_by/updated_by are stamped, never client-supplied — same pair every
-- table in this schema carries.
DROP TRIGGER IF EXISTS trg_dr__stamp ON public.document_requests;
CREATE TRIGGER trg_dr__stamp
  BEFORE INSERT ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_dr__touch ON public.document_requests;
CREATE TRIGGER trg_dr__touch
  BEFORE UPDATE ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- 003800 attaches audit.log_changes() to every table that is not an append-only
-- log. This one is neither, and adding it here rather than editing 003800 keeps
-- the trigger with the table it belongs to; the DROP/CREATE pair means 003800
-- can list it later without conflict.
DROP TRIGGER IF EXISTS trg_document_requests__audit ON public.document_requests;
CREATE TRIGGER trg_document_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------
--
-- A public table with RLS off is readable by every authenticated user through
-- PostgREST and fails the post-flight audit. Policy set matches
-- `reimbursement_claims`: self read/raise/edit-while-open, manager read, scoped
-- admin read/write.

ALTER TABLE public.document_requests ENABLE ROW LEVEL SECURITY;

-- P1 self: read own, raise own, edit while it is still open. A request for a
-- payslip exposes nothing the employee cannot already see on /me/payslips.
DROP POLICY IF EXISTS dr__self__select ON public.document_requests;
CREATE POLICY dr__self__select ON public.document_requests
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS dr__self__insert ON public.document_requests;
CREATE POLICY dr__self__insert ON public.document_requests
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

-- The WITH CHECK admits cancelled/withdrawn so the employee can take their own
-- request back; every other terminal status is the engine's to write.
DROP POLICY IF EXISTS dr__self__update ON public.document_requests;
CREATE POLICY dr__self__update ON public.document_requests
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- P5 manager: read the team's requests. app.can_see_employee, not
-- app.is_manager_of — a document request is administrative, and the same people
-- who can see an employee's leave should be able to see that they asked for a
-- letter. No manager write: the chain below does not route through them.
DROP POLICY IF EXISTS dr__manager__select ON public.document_requests;
CREATE POLICY dr__manager__select ON public.document_requests
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- P8 admin, scoped. HR is the approver AND the fulfiller here, so admins need
-- INSERT (raising on behalf of someone who walked up to the desk) and UPDATE
-- (recording the issued document).
DROP POLICY IF EXISTS dr__admin__select ON public.document_requests;
CREATE POLICY dr__admin__select ON public.document_requests
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS dr__admin__insert ON public.document_requests;
CREATE POLICY dr__admin__insert ON public.document_requests
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS dr__admin__update ON public.document_requests;
CREATE POLICY dr__admin__update ON public.document_requests
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- No DELETE for anyone: a withdrawn request is `status = 'withdrawn'`, which
-- leaves the audit trail intact. REVOKE is explicit rather than relying on the
-- absence of a policy, because a future blanket GRANT would otherwise open it.
GRANT SELECT, INSERT, UPDATE ON public.document_requests TO authenticated;
REVOKE DELETE ON public.document_requests FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.document_requests TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. The chains: straight to HR
-- -----------------------------------------------------------------------------
--
-- ONE LEVEL, hr_admin. A document request needs no manager's permission: the
-- employee is asking for a copy of a fact that is already true about them, and
-- the only person who can act on it is the one who holds the letterhead. Putting
-- a reporting manager in front of that adds a signature that decides nothing and
-- a day of SLA (`request_types.sla_hours` = 48 for both codes).
--
-- NOT `finance`, even for a payslip. `resolve_approver_kind('finance')` needs a
-- department coded FIN with a manager/admin in it; FIN is empty on this
-- deployment, so the level would fall through to hr_admin at runtime while the
-- seed claimed finance — a label that lies (this is exactly what 040600 had to
-- unpick for claims).
--
-- TWO chains, not one: `approval_chains.request_type_id` is a single FK, and
-- DOCUMENT_REQUEST and PAYSLIP_REQUEST are two rows in `request_types`. A chain
-- attached to one of them is invisible to `create_approval_request` for the
-- other (its selection query filters `c.request_type_id = v_rt.id`), so a single
-- AC-DOCREQ would leave the payslip tile raising 'no approval chain matches'.
-- AC-DOCREQ is the one named in the brief; AC-PAYSLIP-REQ is its twin, identical
-- in every respect except the type it hangs off.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id, v.code, v.name, v.descr, v.ord,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       10::smallint, true
FROM public.companies c
JOIN (VALUES
        ('AC-DOCREQ',      'DOCUMENT_REQUEST', 'Document request — HR',
         'Single level: HR admin. A request for a copy of an existing fact needs the person who issues it, not a manager''s permission.',
         200),
        ('AC-PAYSLIP-REQ', 'PAYSLIP_REQUEST',  'Payslip request — HR',
         'Twin of AC-DOCREQ. Exists separately only because approval_chains.request_type_id is single-valued and PAYSLIP_REQUEST is its own request type.',
         210)
     ) AS v(code, rt_code, name, descr, ord) ON true
JOIN public.request_types rt
  ON rt.code = v.rt_code AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

-- skip_if_same_as_previous is true for consistency with every other seeded
-- level; with one level it can never fire.
INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, 1, 'hr_admin', false, true
FROM public.approval_chains ac
WHERE ac.code IN ('AC-DOCREQ','AC-PAYSLIP-REQ')
  AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- `create_approval_request` falls back to `default_approval_chain_id` when no
-- chain matches on selectors. Both types were seeded in 004500 with that column
-- NULL — leaving it there means a matching failure becomes 'no approval chain
-- matches' instead of the obvious route.
UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.deleted_at IS NULL
   AND rt.deleted_at IS NULL
   AND ((rt.code = 'DOCUMENT_REQUEST' AND ac.code = 'AC-DOCREQ')
     OR (rt.code = 'PAYSLIP_REQUEST'  AND ac.code = 'AC-PAYSLIP-REQ'))
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

COMMIT;
