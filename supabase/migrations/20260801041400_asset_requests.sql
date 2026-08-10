-- =============================================================================
-- 20260801041400 — asset_requests: the row ASSET_REQUEST has never had
-- =============================================================================
--
-- WHAT 041300 DELIBERATELY LEFT OPEN
--
-- 041300 seeded `AC-ASSET` and then said, in its own header, that two blockers
-- remained and that it was not going to pretend otherwise:
--
--     `asset_allocations.asset_id` is NOT NULL (a request must name a specific
--     unit, and an employee cannot read the catalogue), and `allocation_number`
--     is NOT NULL/UNIQUE with no generating trigger. … The screen stays honest
--     about the other two until a follow-up gives Stores a request row that does
--     not have to name a unit.
--
-- This is that follow-up.
--
-- WHY NOT JUST RELAX asset_allocations
--
-- Because `asset_allocations` is not a request table and making it one would
-- break the thing it is good at. It is the register of WHO HOLDS WHAT: one row
-- per physical unit in someone's hands, with `allocated_on`, `returned_on`,
-- condition, and the acknowledgement trail. Every one of those columns is
-- meaningless for a request — nobody holds anything yet — and `asset_id` being
-- NOT NULL is precisely what makes the register answer "where is laptop
-- TT-LAP-014" without a WHERE clause that has to remember to skip the rows that
-- are only wishes. Nullable-asset_id would put wishes and possessions in one
-- table and make every existing query a little bit wrong.
--
-- A REQUEST IS A DIFFERENT OBJECT. It names a CATEGORY ('a laptop'), a reason,
-- and how soon; Stores answers it by allocating a unit, which is an
-- `asset_allocations` row. Two tables, one FK between them, each answering its
-- own question — the same split `document_requests.fulfilled_document_id` makes
-- between asking for a letter and the letter.
--
-- THE CATEGORY PICKER IS REAL, NOT INVENTED. `asset_categories` carries fifteen
-- seeded rows (004600 §4: Uniforms, Chef Knives, Walkie-Talkies, Laptops,
-- Safety Shoes …) and `asset_categories__authenticated__select` already lets
-- every signed-in employee read the active ones. So the employee picks from the
-- real register's own vocabulary. What they still cannot read is `assets` —
-- individual units, serial numbers, purchase cost — and they do not need to: the
-- one exception is the unit they already hold, which `assets__self__select`
-- grants and which `replaces_asset_id` below points at.
--
-- REFUSALS RAISE 23514 / 42501, which `WRITE_CODE_KIND` in
-- `src/shared/api/write.ts` maps to `conflict`/`forbidden` and `isRuleRejection`
-- shows verbatim — so the messages below are written for the person at the form.
-- =============================================================================

BEGIN;

-- `request_types` carries an audit trigger (038 §15) and sits behind
-- audit.log_changes(), which demands a reason on UPDATE. Set once for the
-- transaction; 'migration' is the only actor_source a migration may claim.
SELECT set_config('app.reason', 'migration 041400: asset_requests table, and repoint ASSET_REQUEST at it so a request need not name a specific unit', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
--
-- Shape follows `document_requests` (041000), which is the closest relative: a
-- detail row owned by one employee, an `approval_status`, a nullable
-- `approval_request_id` written by the engine, and a fulfilment trio that is
-- separate from the decision. No `decided_by`/`decided_at` — the decision lives
-- in `approval_actions`, which is append-only, and a second copy is a second
-- thing that can disagree with the first.

CREATE TABLE IF NOT EXISTS public.asset_requests (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id            uuid        NOT NULL,
  -- WHAT KIND, not which unit. This is the whole reason the table exists.
  asset_category_id      uuid        NOT NULL,
  -- How many. Bounded below by the CHECK: a request for 400 uniforms is a
  -- purchase order, and it should go through Stores as one rather than arrive
  -- here as an employee request nobody can approve.
  quantity               integer     NOT NULL DEFAULT 1,
  -- Why. Free text and mandatory: 'a laptop' with no reason is a row the
  -- approver has to phone about, which is the thing the queue exists to avoid.
  reason                 text        NOT NULL,
  -- When it is needed by, when that matters. NULL means 'no particular date' —
  -- not 'today', which would silently answer a question nobody asked.
  needed_by              date        NULL,
  -- A replacement for something already held (broken, lost, worn out) is a
  -- different conversation from a first issue: it usually needs no budget, and
  -- Stores wants the old unit back.
  is_replacement         boolean     NOT NULL DEFAULT false,
  -- The unit being replaced. `assets__self__select` lets an employee read
  -- exactly the units allocated to them, so this is the one asset id a requester
  -- can legitimately name. SET NULL on delete: the request survives the unit.
  replaces_asset_id      uuid        NULL,
  -- IST, not now()::date: a request filed at 00:30 IST belongs to today, and
  -- CURRENT_DATE on a UTC server would date it yesterday.
  requested_on           date        NOT NULL DEFAULT util.ist_today(),
  status                 public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id    uuid        NULL,
  -- Delivery. Written only by an administrator (trg_asr__fulfilment below).
  -- Points at the allocation Stores actually made — the request and the register
  -- stay separate objects with one link between them.
  fulfilled_allocation_id uuid       NULL,
  fulfilled_at           timestamptz NULL,
  fulfilled_by           uuid        NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NULL,
  CONSTRAINT pk_asset_requests PRIMARY KEY (id),
  CONSTRAINT fk_asr__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  -- RESTRICT, not CASCADE: deleting a category out from under an open request
  -- would delete the request, and a category with open requests against it is a
  -- category somebody should be told about rather than one that quietly takes
  -- rows with it.
  CONSTRAINT fk_asr__asset_category_id
    FOREIGN KEY (asset_category_id) REFERENCES public.asset_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asr__replaces_asset_id
    FOREIGN KEY (replaces_asset_id) REFERENCES public.assets(id) ON DELETE SET NULL,
  CONSTRAINT fk_asr__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_asr__fulfilled_allocation_id
    FOREIGN KEY (fulfilled_allocation_id) REFERENCES public.asset_allocations(id) ON DELETE SET NULL,
  CONSTRAINT fk_asr__fulfilled_by
    FOREIGN KEY (fulfilled_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asr__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asr__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_asr__quantity CHECK (quantity BETWEEN 1 AND 20),
  CONSTRAINT ck_asr__reason CHECK (length(btrim(reason)) >= 10)
);

COMMENT ON TABLE public.asset_requests IS
  'An employee asking Stores for an asset by CATEGORY — a laptop, a second uniform set, a replacement walkie-talkie. Detail table for request type ASSET_REQUEST since migration 041400. Deliberately NOT asset_allocations: that table is the register of who holds which physical unit, and a request names no unit.';
COMMENT ON COLUMN public.asset_requests.asset_category_id IS
  'The category asked for. Employees can read active asset_categories (002800 P7) but not individual assets, which is exactly why a request names a category and an allocation names a unit.';
COMMENT ON COLUMN public.asset_requests.replaces_asset_id IS
  'The unit being replaced, when this is a replacement. The only asset id a requester can legitimately name: assets__self__select grants read on units allocated to them and nothing else.';
COMMENT ON COLUMN public.asset_requests.fulfilled_allocation_id IS
  'The asset_allocations row Stores created to answer this request. Approval and delivery are separate events; an approved request with this still NULL is the Stores work queue.';

-- CREATE TABLE IF NOT EXISTS silently skips EVERYTHING when the table already
-- exists — including constraints added to the body later. So every rule that is
-- not part of the original body goes in as a guarded ALTER, which is also how
-- this file survives a re-run against a half-applied deployment.

-- A replacement names the thing it replaces, or says nothing. The reverse —
-- naming a unit while claiming this is a first issue — is a row whose two halves
-- disagree.
DO $$ BEGIN
  ALTER TABLE public.asset_requests
    ADD CONSTRAINT ck_asr__replacement_pair CHECK (
      is_replacement OR replaces_asset_id IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Same sentinel guard every dated table in this schema carries (002400): a
-- '9999-12-31' typed into a date box is a bug, not a deadline.
DO $$ BEGIN
  ALTER TABLE public.asset_requests
    ADD CONSTRAINT ck_asr__no_sentinel_dates CHECK (
      requested_on <= DATE '2100-01-01'
      AND (needed_by IS NULL OR needed_by <= DATE '2100-01-01'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Fulfilment is one event: who and when travel together. Without this a row can
-- claim it was delivered with nobody's name against it.
DO $$ BEGIN
  ALTER TABLE public.asset_requests
    ADD CONSTRAINT ck_asr__fulfilment_pair CHECK (
      (fulfilled_at IS NULL) = (fulfilled_by IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_asr__employee ON public.asset_requests (employee_id);
-- The Stores queue: everything still owed. Partial, because settled rows are the
-- overwhelming majority within a month and none of them belong in this scan.
CREATE INDEX IF NOT EXISTS idx_asr__open
  ON public.asset_requests (asset_category_id, requested_on)
  WHERE status IN ('draft','pending','in_progress','approved')
    AND fulfilled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asr__approval
  ON public.asset_requests (approval_request_id)
  WHERE approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asr__replaces
  ON public.asset_requests (replaces_asset_id)
  WHERE replaces_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asr__fulfilled_allocation
  ON public.asset_requests (fulfilled_allocation_id)
  WHERE fulfilled_allocation_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Guards
-- -----------------------------------------------------------------------------

/*
  A deadline in the past is a deadline nobody can meet, and it is almost always a
  mistyped year. Not a CHECK constraint: CHECK bodies must be immutable and
  util.ist_today() is not, so this rule can only live in a trigger.

  util.ist_today(), never CURRENT_DATE — the server clock is UTC and the business
  is in IST, so between 18:30 and 23:59 UTC the two disagree by a day.

  The replacement check is here rather than in a CHECK for a different reason: it
  reads another table. A unit can only be replaced by the person holding it, and
  `asset_allocations` is where that is recorded.
*/
CREATE OR REPLACE FUNCTION public.asset_requests_check_request()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_today date := util.ist_today();
BEGIN
  IF NEW.needed_by IS NOT NULL AND NEW.needed_by < v_today THEN
    RAISE EXCEPTION
      'That date (%) has already passed. Give a date on or after today, or leave it blank.',
      to_char(NEW.needed_by, 'DD Mon YYYY')
      USING errcode = '23514';
  END IF;

  /*
    `returned_at`, not `returned_on`, and no `deleted_at` — asset_allocations
    (002800) has neither of the column names the other detail tables use.

    The status list is copied EXACTLY from `v_asset_custody` (003700 §7), which
    is what the picker on the screen reads. Any other list would mean the form
    can offer a row the trigger then refuses: 'return_requested' looks like it
    should be excluded — the item is on its way back — but that is precisely the
    replacement case, somebody handing in a broken walkie-talkie and asking for
    another. Picker and refusal must agree, so they read the same three states.
  */
  IF NEW.replaces_asset_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.asset_allocations aa
        WHERE aa.asset_id    = NEW.replaces_asset_id
          AND aa.employee_id = NEW.employee_id
          AND aa.returned_at IS NULL
          AND aa.status IN ('allocated','acknowledged','return_requested'))
  THEN
    RAISE EXCEPTION
      'That item is not currently allocated to you, so it cannot be the one being replaced.'
      USING errcode = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_asr__check ON public.asset_requests;
CREATE TRIGGER trg_asr__check
  BEFORE INSERT OR UPDATE OF needed_by, replaces_asset_id, employee_id
  ON public.asset_requests
  FOR EACH ROW EXECUTE FUNCTION public.asset_requests_check_request();

/*
  Fulfilment is Stores' word, not the requester's.

  RLS grants the employee UPDATE on their own row while it is draft/pending, and
  RLS cannot restrict which COLUMNS that update touches — so without this guard
  an employee could point `fulfilled_allocation_id` at any allocation and mark
  themselves served.

  SECURITY INVOKER (the default — deliberately not DEFINER): app.is_admin() must
  answer for the actual caller. A definer trigger would evaluate it for the
  migration's owner and wave every write through.
*/
CREATE OR REPLACE FUNCTION public.asset_requests_guard_fulfilment()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF app.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.fulfilled_allocation_id IS NOT NULL
       OR NEW.fulfilled_at IS NOT NULL
       OR NEW.fulfilled_by IS NOT NULL THEN
      RAISE EXCEPTION
        'A request cannot be filed as already issued. Stores records the allocation once the item has been handed over.'
        USING errcode = '42501';
    END IF;
  ELSIF NEW.fulfilled_allocation_id IS DISTINCT FROM OLD.fulfilled_allocation_id
     OR NEW.fulfilled_at            IS DISTINCT FROM OLD.fulfilled_at
     OR NEW.fulfilled_by            IS DISTINCT FROM OLD.fulfilled_by THEN
    RAISE EXCEPTION
      'Only Stores can record that this request has been issued.'
      USING errcode = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_asr__fulfilment ON public.asset_requests;
CREATE TRIGGER trg_asr__fulfilment
  BEFORE INSERT OR UPDATE ON public.asset_requests
  FOR EACH ROW EXECUTE FUNCTION public.asset_requests_guard_fulfilment();

-- created_by/updated_by are stamped, never client-supplied — the same pair every
-- table in this schema carries.
DROP TRIGGER IF EXISTS trg_asr__stamp ON public.asset_requests;
CREATE TRIGGER trg_asr__stamp
  BEFORE INSERT ON public.asset_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_asr__touch ON public.asset_requests;
CREATE TRIGGER trg_asr__touch
  BEFORE UPDATE ON public.asset_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- 003800 attaches audit.log_changes() to every table that is not an append-only
-- log. This one is neither, and attaching it here keeps the trigger with the
-- table it belongs to.
DROP TRIGGER IF EXISTS trg_asset_requests__audit ON public.asset_requests;
CREATE TRIGGER trg_asset_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.asset_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------
--
-- A public table with RLS off is readable by every authenticated user through
-- PostgREST and fails the post-flight audit. Policy set matches
-- `document_requests`: self read/raise/edit-while-open, manager read, scoped
-- admin read/write.

ALTER TABLE public.asset_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asr__self__select ON public.asset_requests;
CREATE POLICY asr__self__select ON public.asset_requests
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS asr__self__insert ON public.asset_requests;
CREATE POLICY asr__self__insert ON public.asset_requests
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

-- The WITH CHECK admits cancelled/withdrawn so the employee can take their own
-- request back; every other terminal status is the engine's to write.
DROP POLICY IF EXISTS asr__self__update ON public.asset_requests;
CREATE POLICY asr__self__update ON public.asset_requests
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- P5 manager: read the team's requests. The manager is level 1 of AC-ASSET, so
-- this is not a courtesy — it is the row they are being asked to decide on.
DROP POLICY IF EXISTS asr__manager__select ON public.asset_requests;
CREATE POLICY asr__manager__select ON public.asset_requests
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- P8 admin, scoped. Stores is level 2 AND the fulfiller, so admins need INSERT
-- (raising for someone who walked up to the counter) and UPDATE (recording the
-- allocation).
DROP POLICY IF EXISTS asr__admin__select ON public.asset_requests;
CREATE POLICY asr__admin__select ON public.asset_requests
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS asr__admin__insert ON public.asset_requests;
CREATE POLICY asr__admin__insert ON public.asset_requests
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS asr__admin__update ON public.asset_requests;
CREATE POLICY asr__admin__update ON public.asset_requests
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- No DELETE for anyone: a withdrawn request is `status = 'withdrawn'`, which
-- leaves the audit trail intact. REVOKE is explicit rather than relying on the
-- absence of a policy, because a future blanket GRANT would otherwise open it.
GRANT SELECT, INSERT, UPDATE ON public.asset_requests TO authenticated;
REVOKE DELETE ON public.asset_requests FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.asset_requests TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Point ASSET_REQUEST at it
-- -----------------------------------------------------------------------------
--
-- `ck_request_types__detail_table` (029 §1) is a closed list of legal detail
-- tables and `asset_requests` is not on it, so the UPDATE below would fail
-- against the constraint. Widening it is the whole change: no existing value is
-- removed, so every row that satisfies the old constraint satisfies the new one
-- and the re-add cannot fail on live data.
--
-- The list is restated in full rather than patched, because a CHECK cannot be
-- extended in place — and a restatement that silently drops a name is a
-- constraint that starts rejecting rows it used to accept, which is why this
-- copy was diffed against 029 line for line before it was written.

ALTER TABLE public.request_types
  DROP CONSTRAINT IF EXISTS ck_request_types__detail_table;
ALTER TABLE public.request_types
  ADD CONSTRAINT ck_request_types__detail_table CHECK (detail_table IN
    ('leave_requests','attendance_regularizations','employee_change_requests',
     'reimbursement_claims','comp_off_ledger','asset_allocations','contracts',
     'employee_salary_revisions','resignations','travel_requisitions',
     'overtime_preapprovals','shift_swaps','web_punch_requests',
     'income_tax_declarations','document_requests','advance_requests',
     'asset_requests'));

-- `asset_allocations` STAYS in the list. It is still the detail table for
-- nothing right now, but removing a name from a closed list is how a future
-- migration that legitimately wants it discovers the constraint the hard way.

UPDATE public.request_types
   SET detail_table = 'asset_requests'
 WHERE code = 'ASSET_REQUEST'
   AND deleted_at IS NULL
   AND detail_table IS DISTINCT FROM 'asset_requests';

-- No `approval_requests` rows need repointing: ASSET_REQUEST has never been
-- raisable — `create_approval_request` would have had to insert an
-- `asset_allocations` row naming a unit, which is the blocker this file removes
-- — so there is no history pointing at the old table. If that assumption is ever
-- wrong, the query that proves it is:
--     SELECT count(*) FROM public.approval_requests
--      WHERE detail_table = 'asset_allocations';

COMMIT;
