-- =============================================================================
-- 20260801041100 — travel_requisitions: the table the request type points at
-- =============================================================================
--
-- WHAT WAS BROKEN
--
-- `/me/apply/travel` (src/features/apply/pages/TravelRequisition.page.tsx) does
-- not offer a form. Its header states two facts and the screen proves the second
-- by reading the database rather than asserting it:
--
--   1. NO DETAIL ROW TO POINT AT. `request_types.detail_table` for
--      `TRAVEL_REQUISITION` is the string `'travel_requisitions'` (seeded by 045
--      §2, permitted by `ck_request_types__detail_table` in 029 §1) and no
--      migration ever created that table. `approval_requests.detail_id` is NOT
--      NULL, so `create_approval_request` needed a row with nowhere to live.
--   2. NO APPROVAL CHAIN. 045 §3 seeded chains for eleven of eighteen request
--      types; this was not one, so `default_approval_chain_id` stayed NULL and
--      `create_approval_request` raised `no approval chain matches request type
--      TRAVEL_REQUISITION`.
--
-- This file closes both: §1 creates the table, §4 seeds `AC-TRAVEL`.
--
-- THE SETTLEMENT THAT WAS UNREACHABLE
--
-- `public.reimbursement_claims` has carried `travel_requisition_id` and
-- `ck_rc__settlement_link` since 024 —
--     CHECK (claim_kind <> 'travel_requisition_settlement'
--            OR travel_requisition_id IS NOT NULL)
-- — so the `'travel_requisition_settlement'` half of `ck_rc__claim_kind` was
-- DEAD: no id existed that the column could hold, and every claim had to be
-- filed as a `'local_claim'`. `public.travel_requisitions.id` created here is
-- exactly what that column points at, so a settlement claim becomes possible for
-- the first time. §3 adds the foreign key 024's own header said it could not
-- add ("no travel_requisitions table exists anywhere in the §13 plan").
--
-- WHAT THIS DELIBERATELY DOES NOT INVENT
--
-- The screen names three things spec-employee §5 asks for that the schema cannot
-- hold, and inventing any of them here would be worse than leaving the gap
-- visible: `travel_policies.max_advance` (no such table), a per-grade
-- estimated-cost cap (no table holds one), and an L2-above-₹10,000 escalation
-- (an amount band on a chain — a policy number nobody has agreed). `AC-TRAVEL`
-- below therefore carries NO `amount_from` / `amount_to`: every trip takes the
-- same route until someone decides otherwise.
--
-- Money is integer paise in `_paise` columns, matching 020–024. Nothing here
-- stores rupees in `numeric`, where 0.1 + 0.2 is not 0.3.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 041100: create travel_requisitions and seed the AC-TRAVEL approval chain', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
--
-- Shaped on `reimbursement_claims` (024) on purpose: the two rows are read side
-- by side on the travel screen, and a requisition whose columns are named and
-- typed differently from the claim that settles it makes every join and every
-- report a translation exercise.

CREATE TABLE IF NOT EXISTS public.travel_requisitions (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  requisition_number     text        NOT NULL,   -- TRV-2026-000012
  employee_id            uuid        NOT NULL,
  -- Free text, not a location_id: the trip's destination is "Mysuru" or a
  -- client site, not one of this company's four `locations` rows. Forcing a FK
  -- would make the field unusable for the journeys people actually take.
  from_location          text        NOT NULL,
  to_location            text        NOT NULL,
  from_date              date        NOT NULL,
  to_date                date        NOT NULL,
  purpose                text        NOT NULL,   -- the sentence: "vendor tasting, Coorg"
  -- Same vocabulary as `ck_claim_lines__travel_purpose` and
  -- `ck_claim_lines__travel_mode` (040400) so a requisition and the claim that
  -- settles it can be counted together. Both NULLABLE: a category the requester
  -- cannot honestly pick is a category they will pick at random.
  travel_purpose         text        NULL,
  travel_mode            text        NULL,
  estimated_cost_paise   bigint      NOT NULL DEFAULT 0,
  advance_amount_paise   bigint      NOT NULL DEFAULT 0,
  currency               text        NOT NULL DEFAULT 'INR',
  status                 public.approval_status NOT NULL DEFAULT 'draft',
  -- Direct FK, no deferred sweep: 024 had to defer this class of reference
  -- because `approval_requests` did not exist until 029. It does now.
  approval_request_id    uuid        NULL,
  decided_by             uuid        NULL,
  decided_at             timestamptz NULL,
  decided_comment        text        NULL,
  notes                  text        NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NULL,
  CONSTRAINT pk_travel_requisitions PRIMARY KEY (id),
  CONSTRAINT fk_tr__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tr__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_tr__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_tr__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_tr__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_tr__requisition_number UNIQUE (requisition_number),
  -- A trip that ends before it starts is a typo, and it silently breaks any
  -- overlap or duration report built on these two columns later.
  CONSTRAINT ck_tr__dates CHECK (to_date >= from_date),
  -- Same sentinel guard as `ck_rc__no_sentinel_dates`: '9999-12-31' entered as
  -- "open ended" poisons every MAX() and every date arithmetic downstream.
  CONSTRAINT ck_tr__no_sentinel_dates CHECK (
    from_date <= DATE '2100-01-01' AND to_date <= DATE '2100-01-01'),
  -- Somebody has to have typed something. `length(btrim(...))` and not
  -- `<> ''` because a purpose of three spaces passes the second test.
  CONSTRAINT ck_tr__purpose_present CHECK (
    length(btrim(purpose)) >= 3
    AND length(btrim(from_location)) >= 1
    AND length(btrim(to_location)) >= 1),
  CONSTRAINT ck_tr__travel_purpose CHECK (
    travel_purpose IS NULL OR travel_purpose IN ('sales','support','management')),
  CONSTRAINT ck_tr__travel_mode CHECK (
    travel_mode IS NULL OR travel_mode IN (
      'taxi','auto','bus','bike','car','company_bike','company_car','train','flight','other')),
  CONSTRAINT ck_tr__amounts CHECK (
    estimated_cost_paise >= 0 AND advance_amount_paise >= 0),
  -- Arithmetic, NOT policy. This is not the missing `travel_policies.max_advance`
  -- cap wearing a disguise — it says only that a company cannot advance more
  -- than the trip is estimated to cost, which is the requester's own number on
  -- the same row. The real cap, when someone agrees one, belongs in `settings`
  -- where an admin can change it without a migration.
  CONSTRAINT ck_tr__advance_within_estimate CHECK (
    advance_amount_paise <= estimated_cost_paise),
  CONSTRAINT ck_tr__currency CHECK (currency ~ '^[A-Z]{3}$')
);

COMMENT ON TABLE public.travel_requisitions IS
  'Pre-approval for official travel: where, when, why, what it is expected to cost and how much is wanted up front. This is the detail table that request_types.detail_table has named for TRAVEL_REQUISITION since 045 and that no migration created until 041100. Settled afterwards by a reimbursement_claims row with claim_kind = ''travel_requisition_settlement'', whose travel_requisition_id points at this id.';

COMMENT ON COLUMN public.travel_requisitions.advance_amount_paise IS
  'Money asked for BEFORE the trip. Zero is the normal case. Settled against the eventual claim through reimbursement_claims.advance_adjusted_paise.';
COMMENT ON COLUMN public.travel_requisitions.estimated_cost_paise IS
  'The requester''s estimate, in paise. What the trip actually costs is the sum of the settlement claim''s lines — this column is never the amount paid.';

CREATE INDEX IF NOT EXISTS idx_tr__employee ON public.travel_requisitions (employee_id);
-- Partial, like `idx_rc__status`: the only status scan anyone runs is "what is
-- still open", and an index over settled history would be mostly dead pages.
CREATE INDEX IF NOT EXISTS idx_tr__status   ON public.travel_requisitions (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_tr__approval ON public.travel_requisitions (approval_request_id)
  WHERE approval_request_id IS NOT NULL;
-- "Who is travelling next week" — the one date question the roster asks.
CREATE INDEX IF NOT EXISTS idx_tr__dates    ON public.travel_requisitions (from_date, to_date);

-- -----------------------------------------------------------------------------
-- 2. Requisition number, stamps, audit
-- -----------------------------------------------------------------------------
--
-- TRV-<IST year>-<6 digits>, generated exactly like `generate_claim_number`
-- (024): same advisory lock, same year source. `util.ist_date(now())` and never
-- `now()::date`, because the server runs in UTC and a trip filed at 03:00 IST
-- on 1 January would otherwise be numbered for the previous year.

CREATE OR REPLACE FUNCTION public.generate_travel_requisition_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_year text := to_char(util.ist_date(now()), 'YYYY');
  v_next integer;
BEGIN
  IF NEW.requisition_number IS NULL OR btrim(NEW.requisition_number) = '' THEN
    -- Transaction-scoped advisory lock: two people filing at once would
    -- otherwise both read the same MAX and collide on
    -- `uq_tr__requisition_number`, turning a race into a user-visible error.
    PERFORM pg_advisory_xact_lock(hashtext('travel_requisitions.requisition_number'));
    SELECT COALESCE(MAX(substring(tr.requisition_number FROM '[0-9]+$')::integer), 0) + 1
      INTO v_next
      FROM public.travel_requisitions tr
     WHERE tr.requisition_number LIKE 'TRV-' || v_year || '-%';
    NEW.requisition_number := 'TRV-' || v_year || '-' || lpad(v_next::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tr__requisition_number ON public.travel_requisitions;
CREATE TRIGGER trg_tr__requisition_number
  BEFORE INSERT ON public.travel_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.generate_travel_requisition_number();

DROP TRIGGER IF EXISTS trg_tr__stamp ON public.travel_requisitions;
CREATE TRIGGER trg_tr__stamp
  BEFORE INSERT ON public.travel_requisitions
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_tr__touch ON public.travel_requisitions;
CREATE TRIGGER trg_tr__touch
  BEFORE UPDATE ON public.travel_requisitions
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Attached here rather than in 038 (`20260801003800_audit_triggers_attach.sql`)
-- for the only reason that matters: 038 has already run on this deployment, so
-- a table added to it now would never get its trigger. Same shape as
-- `trg_reimbursement_claims__audit` in 038 §10 — money moves through this row,
-- so who changed the estimate or the advance has to be answerable later.
DROP TRIGGER IF EXISTS trg_travel_requisitions__audit ON public.travel_requisitions;
CREATE TRIGGER trg_travel_requisitions__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.travel_requisitions
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 3. Row-level security
-- -----------------------------------------------------------------------------
--
-- Copied policy-for-policy from `reimbursement_claims` (024 §1) — self read /
-- raise / edit-while-open, manager read, scoped-admin read+write — because the
-- two tables answer the same question about the same person and a requisition
-- visible to someone the claim is not would be a leak nobody would look for.
--
-- Approving is NOT a write path here. No policy gives a MANAGER — the level-1
-- approver — UPDATE on this table: `tr__manager__select` is read-only, and a
-- manager who could UPDATE the row directly could approve by editing a column
-- and skip every level. Decisions go through `act_on_approval` (029), which is
-- SECURITY DEFINER and enforces the chain, and land on the row through
-- `apply_travel_decision` in §6.
--
-- `tr__admin__update` is the one exception and is deliberate: it is the same
-- grant `rc__admin__update` gives, HR needs it to correct a row it filed on
-- someone's behalf, and an admin (the level-2 kind) can already override any
-- approval through `act_on_approval`. It is not a back door that only exists
-- here — but it does mean "no approver can write this row" is true of L1 and
-- not of L2, which is worth stating rather than implying otherwise.

ALTER TABLE public.travel_requisitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tr__self__select ON public.travel_requisitions;
CREATE POLICY tr__self__select ON public.travel_requisitions
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS tr__self__insert ON public.travel_requisitions;
CREATE POLICY tr__self__insert ON public.travel_requisitions
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

-- The window closes when the chain SETTLES, not when it starts moving. A
-- requisition sits at 'pending' for the whole time the approval_request is
-- 'in_progress', so USING still matches and the requester can still edit the
-- estimate mid-chain — exactly as `rc__self__update` behaves for a claim, and
-- the reason §6 exists: only a settled decision written back onto `status`
-- takes the row out of ('draft','pending') and ends the edit window for good.
-- WITH CHECK admits 'cancelled'/'withdrawn' so the requester can pull their own
-- request back (`request_types.allows_withdrawal` is true for
-- TRAVEL_REQUISITION).
DROP POLICY IF EXISTS tr__self__update ON public.travel_requisitions;
CREATE POLICY tr__self__update ON public.travel_requisitions
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- `app.can_see_employee` and not `app.is_manager_of`: the same reach the manager
-- already has over this employee's claims and attendance, resolved through one
-- hashed visible-employee probe (20260806120000).
DROP POLICY IF EXISTS tr__manager__select ON public.travel_requisitions;
CREATE POLICY tr__manager__select ON public.travel_requisitions
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

DROP POLICY IF EXISTS tr__admin__select ON public.travel_requisitions;
CREATE POLICY tr__admin__select ON public.travel_requisitions
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

-- Admin insert exists because HR files travel for people who do not use the
-- portal — the same reason `rc__admin__insert` exists.
DROP POLICY IF EXISTS tr__admin__insert ON public.travel_requisitions;
CREATE POLICY tr__admin__insert ON public.travel_requisitions
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS tr__admin__update ON public.travel_requisitions;
CREATE POLICY tr__admin__update ON public.travel_requisitions
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- No DELETE for anyone: a requisition is evidence that money was authorised.
-- Cancellation is a status, and `ck_approval_chains__deletion_reason`-style soft
-- deletion is not offered here because nothing may erase an authorisation trail.
GRANT SELECT, INSERT, UPDATE ON public.travel_requisitions TO authenticated;
REVOKE DELETE ON public.travel_requisitions FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.travel_requisitions TO service_role;
  END IF;
END $$;

-- `anon` has to be revoked BY NAME, and this is not belt-and-braces.
-- 048 (`grants_final` §1) is where "anon touches nothing" is enforced, and it
-- does it with `REVOKE ALL ON ALL TABLES IN SCHEMA … FROM anon` — a snapshot of
-- the tables that existed when it ran, which was long before this file. Supabase
-- ships `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon` on schema
-- public, so a table created NOW is born with anon holding SELECT/INSERT/
-- UPDATE/DELETE on it — including the DELETE this section has just taken away
-- from `authenticated`. RLS would still refuse every row (no policy names anon),
-- but a privilege that only RLS is stopping is one RLS mistake away from being
-- real. 20260801037000 does exactly this for `geocode_cache` — the other public
-- table created after 048 — and asserts the result rather than trusting it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.travel_requisitions FROM anon;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_table_privilege('anon', 'public.travel_requisitions', 'SELECT') THEN
    RAISE EXCEPTION 'migration 041100: anon can read travel_requisitions — where and when every employee travels is not public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_table_privilege('authenticated', 'public.travel_requisitions', 'DELETE') THEN
    RAISE EXCEPTION 'migration 041100: authenticated still holds DELETE on travel_requisitions — an authorisation trail must not be erasable';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. The settlement link, finally enforceable
-- -----------------------------------------------------------------------------
--
-- `reimbursement_claims.travel_requisition_id` has been an unconstrained uuid
-- since 024 — its header explains why ("no travel_requisitions table exists
-- anywhere in the §13 plan"), and that is no longer true. Without the FK a
-- settlement claim can name a requisition that does not exist, and
-- `ck_rc__settlement_link` would happily pass on a typo.
--
-- NOT VALID for the same reason 040400 used it on `ck_claim_lines__receipt_present`:
-- it binds every row written from now on and does not retro-fail whatever is
-- already in the column. Every value there is expected to be NULL (the screen
-- renders the column and it is always empty), so `VALIDATE CONSTRAINT` is a
-- one-line follow-up once someone has confirmed that on the live database —
-- failing this migration on a stray uuid would help nobody.
--
-- ON DELETE RESTRICT, not CASCADE: deleting the authorisation under a settled
-- claim would leave the claim asserting an approval that no longer exists.

DO $$ BEGIN
  ALTER TABLE public.reimbursement_claims
    ADD CONSTRAINT fk_rc__travel_requisition_id
      FOREIGN KEY (travel_requisition_id)
      REFERENCES public.travel_requisitions(id) ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The other direction of the same join: "what has been claimed against this
-- requisition". Partial because the column is NULL on every local claim.
CREATE INDEX IF NOT EXISTS idx_rc__travel_requisition
  ON public.reimbursement_claims (travel_requisition_id)
  WHERE travel_requisition_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. AC-TRAVEL — reporting manager, then admin
-- -----------------------------------------------------------------------------
--
-- The same two levels 040600 settled on for claims, for the same two reasons:
--
--   L1 `reporting_manager` — the person who knows whether the trip needs to
--      happen. Where the employee has no `reporting_manager_id` (most of this
--      deployment today), `resolve_approvers` falls back to hr_admin rather
--      than to nobody, so the request is never stranded.
--   L2 `hr_admin` — the money sign-off. Since 040500 this resolves to
--      `ur.role IN ('admin','super_admin')`, so all five administrators SEE the
--      request rather than only being able to override it.
--
-- `finance` is deliberately NOT used, and this is not a style preference:
-- `resolve_approver_kind('finance')` requires membership of a department coded
-- `FIN`, and `FIN` has zero staff on this deployment (040600 §2). The level
-- would resolve to an empty set and fall through the ladder to hr_admin anyway
-- — a label that lies about who approved.
--
-- `skip_if_same_as_previous` is true so a manager filing their own travel does
-- not approve themselves at L1 and then again at L2.
--
-- No amount bands: see the header. The ₹10,000 escalation in spec-employee §5
-- is a number nobody has agreed, and encoding a guess here would make it policy.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-TRAVEL', 'Travel requisition — manager then admin',
       'Level 1 the employee''s reporting manager; level 2 an administrator (admin or super_admin). No amount bands: the same two people sign off a ₹500 auto fare and a ₹50,000 flight, until a cap is agreed and put in settings.',
       85,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       10::smallint, true
FROM public.companies c
JOIN public.request_types rt
  ON rt.code = 'TRAVEL_REQUISITION' AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, v.lvl, v.kind, false, true
FROM public.approval_chains ac
JOIN (VALUES
        (1, 'reporting_manager'),
        (2, 'hr_admin')
     ) AS v(lvl, kind) ON true
WHERE ac.code = 'AC-TRAVEL' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- `create_approval_request` falls back to `default_approval_chain_id` when no
-- chain matches on selectors. Leaving it NULL is precisely the failure the
-- screen reports, so it is set here rather than left to the 045 sweep (which has
-- already run and skipped this type).
UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.code = 'AC-TRAVEL'
   AND ac.deleted_at IS NULL
   AND rt.code = 'TRAVEL_REQUISITION'
   AND rt.deleted_at IS NULL
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

-- -----------------------------------------------------------------------------
-- 6. A settled approval actually settles the requisition
-- -----------------------------------------------------------------------------
--
-- Without this, §1 and §5 build a route that goes nowhere. `act_on_approval`
-- (029) writes to exactly two tables — `approval_requests` and
-- `approval_actions` — so a requisition approved by its manager and then by an
-- admin would keep `status = 'pending'` and `decided_at = NULL` forever. That is
-- not a cosmetic gap: `tr__self__update` matches while status is
-- ('draft','pending'), so the claimant would stay able to raise the estimated
-- cost and the advance on a trip everyone had already signed off, and the
-- settlement claim would cite an authorisation that never records being given.
-- The `decided_*` columns exist for this and would otherwise be decoration.
--
-- 040500 proved the shape for `reimbursement_claims` and the reasoning carries
-- over unchanged: a TRIGGER on the row whose status actually changed, not an RPC
-- the browser calls, because a decision can be taken through the team inbox, the
-- admin inbox, an admin override, `advance_approval` finishing a chain by
-- itself, or `sla_sweep` — and a client-side apply step silently does not run
-- for four of those five. `apply_error` rather than an exception for the same
-- reason: the approval is the decision of record and must not be lost because
-- its detail row went missing.
--
-- One deliberate difference from `apply_claim_decision`: 'auto_approved' is in
-- the terminal set here. `sla_sweep` sets exactly that value (029), not
-- 'approved'. TRAVEL_REQUISITION carries `auto_approve_after_hours = NULL` so it
-- cannot occur today, but a status this trigger does not recognise is a
-- requisition stuck at 'pending' with nobody looking, which is the bug this
-- section exists to close.

CREATE OR REPLACE FUNCTION public.apply_travel_decision()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_found boolean;
BEGIN
  SELECT true INTO v_found
    FROM public.travel_requisitions tr
   WHERE tr.id = NEW.detail_id;

  IF v_found IS NOT TRUE THEN
    UPDATE public.approval_requests
       SET apply_error = format('no travel_requisitions row with id %s', NEW.detail_id)
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  IF NEW.status IN ('approved','auto_approved','rejected','cancelled','withdrawn','expired') THEN
    -- `status` is the same `public.approval_status` on both rows, so the
    -- decision is copied rather than translated through a mapping nobody
    -- maintains. `approval_request_id` is filled in only if the caller had not
    -- already linked it: this trigger is the last place that knows the pairing,
    -- and a requisition that cannot name its own approval is unauditable.
    UPDATE public.travel_requisitions
       SET status              = NEW.status,
           approval_request_id = COALESCE(approval_request_id, NEW.id),
           decided_by          = NEW.decided_by,
           decided_at          = COALESCE(NEW.decided_at, now()),
           decided_comment     = NEW.decision_comment
     WHERE id = NEW.detail_id;
  ELSE
    -- in_progress / escalated: the chain is still moving. Nothing to apply, and
    -- the edit window stays open on purpose.
    RETURN NULL;
  END IF;

  -- Does not mention `status`, so this cannot re-fire the trigger below.
  UPDATE public.approval_requests
     SET applied_at = now(), apply_error = NULL
   WHERE id = NEW.id;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.apply_travel_decision() IS
  'Projects a settled approval_request onto its travel_requisitions row. Fires from every decision path including admin override, chain completion and sla_sweep auto-approval; records apply_error rather than aborting the approval when the requisition row is missing. Sibling of apply_claim_decision (040500).';

-- A SECOND trigger on approval_requests, not a widened `trg_ar__apply_claim`.
-- Each is guarded by its own `detail_table`, so neither can fire on the other's
-- rows, and replacing 040500's trigger from this file would make a claims bug
-- fixable only by editing a travel migration.
DROP TRIGGER IF EXISTS trg_ar__apply_travel ON public.approval_requests;
CREATE TRIGGER trg_ar__apply_travel
  AFTER UPDATE OF status ON public.approval_requests
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
        AND NEW.detail_table = 'travel_requisitions')
  EXECUTE FUNCTION public.apply_travel_decision();

-- No catch-up UPDATE of the kind 040500 §3 needed: this table is created in §1
-- of this same file, so no settled approval can already be pointing at a row in
-- it. `approval_requests.detail_table = 'travel_requisitions'` is empty by
-- construction — `create_approval_request` has never been able to succeed for
-- this type, which is the defect the header opens with.

-- -----------------------------------------------------------------------------
-- 7. Post-conditions
-- -----------------------------------------------------------------------------
--
-- Every seeding statement in §5 is a `SELECT … FROM companies JOIN
-- request_types … ON CONFLICT DO NOTHING`. If `companies.code = 'TT'` were
-- renamed, or the TRAVEL_REQUISITION request type soft-deleted or deactivated,
-- all three statements would touch ZERO rows, this migration would report
-- success, and `/me/apply/travel` would keep raising `no approval chain matches
-- request type TRAVEL_REQUISITION` — the exact error the file exists to fix,
-- now with a green migration in front of it. A silent no-op is the failure mode
-- of a conditional seed, so it is asserted instead of assumed.

DO $verify$
DECLARE
  v_chain_id uuid;
  v_levels   integer;
  v_finance  integer;
  v_wired    boolean;
BEGIN
  SELECT ac.id INTO v_chain_id
    FROM public.approval_chains ac
   WHERE ac.code = 'AC-TRAVEL' AND ac.deleted_at IS NULL AND ac.is_active;
  IF v_chain_id IS NULL THEN
    RAISE EXCEPTION 'migration 041100: AC-TRAVEL was not seeded — check that companies.code = ''TT'' and request_types.code = ''TRAVEL_REQUISITION'' both resolve';
  END IF;

  SELECT count(*) INTO v_levels
    FROM public.approval_chain_levels WHERE approval_chain_id = v_chain_id;
  IF v_levels = 0 THEN
    -- create_approval_request raises 'approval chain % has no levels' at the
    -- moment a person presses submit. Better to raise it here.
    RAISE EXCEPTION 'migration 041100: AC-TRAVEL has no levels';
  END IF;

  -- `finance` resolves through a department coded FIN, which has zero staff on
  -- this deployment: the level would fall through resolve_approvers' ladder to
  -- hr_admin and print a label that lies about who approved. See §5.
  SELECT count(*) INTO v_finance
    FROM public.approval_chain_levels
   WHERE approval_chain_id = v_chain_id
     AND (approver_kind = 'finance' OR escalate_to_kind = 'finance');
  IF v_finance > 0 THEN
    RAISE EXCEPTION 'migration 041100: AC-TRAVEL names approver_kind ''finance'' — the FIN department is empty and the level would resolve to nobody';
  END IF;

  SELECT (rt.default_approval_chain_id = v_chain_id) INTO v_wired
    FROM public.request_types rt
   WHERE rt.code = 'TRAVEL_REQUISITION' AND rt.deleted_at IS NULL;
  IF v_wired IS NOT TRUE THEN
    RAISE EXCEPTION 'migration 041100: request_types.default_approval_chain_id for TRAVEL_REQUISITION does not point at AC-TRAVEL — create_approval_request''s fallback path is still broken';
  END IF;

  IF to_regclass('public.travel_requisitions') IS NULL THEN
    RAISE EXCEPTION 'migration 041100: travel_requisitions does not exist';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.travel_requisitions'::regclass) THEN
    RAISE EXCEPTION 'migration 041100: RLS is not enabled on travel_requisitions';
  END IF;
END
$verify$;

COMMIT;
