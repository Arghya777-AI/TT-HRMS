-- =============================================================================
-- 20260801040800 — resignations: the detail table RESIGNATION already points at
-- =============================================================================
--
-- `request_types.code = 'RESIGNATION'` has existed since 045 §2 and names
-- `detail_table = 'resignations'`. Until now that name appeared TWICE AS A
-- STRING ONLY — in `ck_request_types__detail_table` (029 §1) and in that seed
-- row — and no migration created the table. `approval_requests.detail_id` is
-- NOT NULL, so a resignation had nowhere to point and could not be raised at
-- all. 045 §3 also seeded chains for eleven of the eighteen request types and
-- RESIGNATION was not one, so `create_approval_request` raised
-- `no approval chain matches request type RESIGNATION` even if a detail row had
-- existed. `src/features/apply/pages/Resignation.page.tsx` states both gaps in
-- its header and PROVES the second one at runtime by reading `approval_chains`
-- and finding it empty. This migration closes exactly those two gaps.
--
-- WHAT THIS TABLE CARRIES, AND WHY NOTHING MORE
--
-- The screen's own "what a migration has to add" list (`apply.resign.ready.*`
-- in `src/shared/i18n/keys/me-apply.ts`) is the specification, and only its
-- first two items belong to a schema migration:
--
--   item1 — "intended last working day, reason, notice served and any waiver
--            sought, with a self-insert policy and a server-minted reference"
--   item2 — "an approval chain for Resignation with its levels, so a manager
--            and HR are named rather than assumed"
--
--   item3 (clearance templates / clearance items) and item4 (exit interviews)
--   are DELIBERATELY NOT BUILT HERE. The page header says those tables exist in
--   no migration and shows `employees.exit_interview_done` as the single
--   boolean it is. Inventing a clearance checklist now would put a second,
--   unowned workflow next to the one this file is adding, and the screen that
--   would have to render it does not exist.
--
-- WHAT IS DELIBERATELY ABSENT FROM THE COLUMN LIST
--
--   * NO MONEY. No recovery, no encashment, no full-and-final figure — so no
--     `_paise` column appears below. Notice-shortfall recovery is
--     `shortfall × monthly_gross / days_in_month`, payroll arithmetic on a
--     salary figure, and the page refuses to compute it for that reason. A
--     column here would invite exactly the browser-side arithmetic the screen
--     was written to avoid. F&F is already recorded where payroll owns it:
--     `employees.full_and_final_settled_on`.
--   * NO `exit_type` / `last_working_day` MIRROR. Those live on `employees` and
--     are written by HR through `employee_lifecycle_events` — `event_type =
--     'resigned'` projected by `ele_status_projection` (011 §1) into
--     `employment_status = 'on_notice'` plus `employees.resignation_date`. This
--     table records what the EMPLOYEE asked for; the lifecycle stream records
--     what the COMPANY decided. `act_on_approval` never writes back to a detail
--     table (the note `claim-submit.api.ts` records), so an approved resignation
--     still becomes real only when HR files the lifecycle event — and two
--     columns claiming to hold the same fact would drift the moment it did.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 040800: resignations detail table and the AC-RESIGN approval chain', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
--
-- Shape follows `reimbursement_claims` (024) because a resignation travels the
-- identical route: employee raises a detail row, `create_approval_request`
-- mints the request against it, the row carries `approval_request_id` back so
-- the decision trail is reachable from the detail. Same columns, same names,
-- same triggers — a reviewer who knows one knows this one.

CREATE TABLE IF NOT EXISTS public.resignations (
  id                         uuid        NOT NULL DEFAULT gen_random_uuid(),
  resignation_number         text        NOT NULL,   -- RSG-2026-000012, minted below
  employee_id                uuid        NOT NULL,

  -- The civil day the employee filed, in IST. DEFAULT util.ist_today() and not
  -- CURRENT_DATE: the server runs in UTC, and between 18:30 and midnight UTC
  -- CURRENT_DATE is YESTERDAY in Bengaluru — which would silently buy the
  -- resigning employee an extra day of notice.
  submitted_on               date        NOT NULL DEFAULT util.ist_today(),

  -- SNAPSHOT, not a lookup. `employees.notice_period_days` is `NOT NULL DEFAULT
  -- 30` (008) and is the figure HR and payroll both read — but it is editable,
  -- and a resignation that has been in flight for three weeks must still be
  -- judged against the notice that applied on the day it was filed. Filled from
  -- the employee's record by trg_resign__notice when the client omits it, so the
  -- browser never has to assert it.
  notice_period_days         integer     NOT NULL,

  intended_last_working_day  date        NOT NULL,

  -- Notice actually offered. GENERATED, not written: the screen's own header
  -- says the earliest last working day is shown only because it is a calendar
  -- shift of a server-owned integer, and every business figure it refuses to
  -- compute in the browser it refuses for the same reason. date - date is
  -- integer and immutable, so this is a legal STORED expression and an approver
  -- can filter on "served less than their notice" without arithmetic anywhere
  -- else.
  notice_days_given          integer     GENERATED ALWAYS AS
                               (intended_last_working_day - submitted_on) STORED,

  -- "Any waiver sought" (apply.resign.ready.item1). A shorter-than-notice exit
  -- is a REQUEST, not a fact: the flag is what unlocks the short date under
  -- ck_resign__notice_or_waiver, and the reason is what the approver reads.
  is_notice_waiver_requested boolean     NOT NULL DEFAULT false,
  waiver_reason              text        NULL,

  -- Category for counting, free text for reading. One free-text column could
  -- hold both, but then nobody can answer "how many left for compensation this
  -- quarter" — the same argument 040400 made for splitting travel_purpose out
  -- of claim_lines.expense_head.
  reason_category            text        NOT NULL,
  reason                     text        NOT NULL,

  status                     public.approval_status NOT NULL DEFAULT 'pending',
  approval_request_id        uuid        NULL,
  decided_by                 uuid        NULL,
  decided_at                 timestamptz NULL,
  decided_comment            text        NULL,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        NULL,

  CONSTRAINT pk_resignations PRIMARY KEY (id),
  CONSTRAINT fk_resign__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  -- Real FK, not a deferred-sweep placeholder: unlike 024, `approval_requests`
  -- (029) already exists by the time this file runs.
  CONSTRAINT fk_resign__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_resign__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_resign__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_resign__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,

  CONSTRAINT uq_resign__number UNIQUE (resignation_number),

  -- Same domain as ck_employees__notice_days (008). Two tables holding the same
  -- quantity under different bounds is how a snapshot ends up unusable.
  CONSTRAINT ck_resign__notice_days CHECK (notice_period_days BETWEEN 0 AND 180),

  CONSTRAINT ck_resign__lwd_not_before_submission
    CHECK (intended_last_working_day >= submitted_on),

  -- The notice rule, enforced where it cannot be bypassed. The page computes
  -- `today + notice_period_days` for display; a direct PostgREST call could
  -- name tomorrow as the last working day and skip that screen entirely. A rule
  -- only the form enforces is the form author's rule, not the company's.
  -- Asking for a waiver is the sanctioned way to be short — it does not grant
  -- one, it just lets the request be filed for someone to decide.
  CONSTRAINT ck_resign__notice_or_waiver CHECK (
    is_notice_waiver_requested
    OR intended_last_working_day >= submitted_on + notice_period_days),

  CONSTRAINT ck_resign__waiver_reason CHECK (
    NOT is_notice_waiver_requested
    OR (waiver_reason IS NOT NULL AND btrim(waiver_reason) <> '')),

  CONSTRAINT ck_resign__reason_present CHECK (btrim(reason) <> ''),

  CONSTRAINT ck_resign__reason_category CHECK (reason_category IN
    ('better_opportunity','higher_studies','relocation','health','family',
     'compensation','work_environment','career_change','personal','other')),

  -- Matches the sentinel guard every dated table since 008 carries; keeps
  -- '9999-12-31'-style placeholder dates out of the notice arithmetic above.
  CONSTRAINT ck_resign__no_sentinel_dates CHECK (
    submitted_on <= DATE '2100-01-01'
    AND intended_last_working_day <= DATE '2100-01-01'),

  CONSTRAINT ck_resign__decided_fields CHECK (
    status NOT IN ('approved','rejected') OR decided_at IS NOT NULL)
);

COMMENT ON TABLE public.resignations IS
  'An employee''s own resignation: intended last working day, the notice that applied on the day they filed, the reason, and any waiver sought. The detail row `request_types.RESIGNATION` has named since 045 §2. It records what was ASKED FOR; the exit itself is recorded by HR as an employee_lifecycle_events row (event_type = ''resigned'').';

COMMENT ON COLUMN public.resignations.notice_period_days IS
  'Snapshot of employees.notice_period_days on the day of filing. Snapshotted because that column is editable and an in-flight resignation must be judged against the notice that applied when it was raised.';
COMMENT ON COLUMN public.resignations.notice_days_given IS
  'intended_last_working_day - submitted_on. Generated so the figure is the server''s, not a browser''s.';
COMMENT ON COLUMN public.resignations.is_notice_waiver_requested IS
  'The employee is asking to leave before their notice expires. Unlocks ck_resign__notice_or_waiver; it does not grant the waiver — the approvers do.';

CREATE INDEX IF NOT EXISTS idx_resign__employee ON public.resignations (employee_id);
CREATE INDEX IF NOT EXISTS idx_resign__status   ON public.resignations (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_resign__approval ON public.resignations (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- One live resignation per employee. Without this a double submit — the refresh
-- after a slow network, the classic cause — puts two resignations with two
-- different last working days in front of two approvers, and whichever is
-- approved second wins by accident. Withdrawn, rejected and cancelled rows are
-- outside the predicate, so someone who withdraws can genuinely file again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_resign__one_open
  ON public.resignations (employee_id)
  WHERE status IN ('draft','pending','in_progress');

-- -----------------------------------------------------------------------------
-- 2. The server-minted reference
-- -----------------------------------------------------------------------------
--
-- Copied from generate_claim_number() (024) down to the advisory lock, which is
-- what makes two concurrent submissions take different numbers instead of both
-- reading the same MAX. The year is the IST year via util.ist_date(now()): on
-- the night of 31 March a UTC-derived year would file next year's resignation
-- under this year's series.

CREATE OR REPLACE FUNCTION public.generate_resignation_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_year text := to_char(util.ist_date(now()), 'YYYY');
  v_next integer;
BEGIN
  IF NEW.resignation_number IS NULL OR btrim(NEW.resignation_number) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('resignations.resignation_number'));
    SELECT COALESCE(MAX(substring(r.resignation_number FROM '[0-9]+$')::integer), 0) + 1
      INTO v_next
      FROM public.resignations r
     WHERE r.resignation_number LIKE 'RSG-' || v_year || '-%';
    NEW.resignation_number := 'RSG-' || v_year || '-' || lpad(v_next::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_resign__number ON public.resignations;
CREATE TRIGGER trg_resign__number
  BEFORE INSERT ON public.resignations
  FOR EACH ROW EXECUTE FUNCTION public.generate_resignation_number();

-- -----------------------------------------------------------------------------
-- 3. The notice snapshot
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER so the figure comes off `employees` even though a plain
-- employee reads their own record through `v_my_employee` rather than the base
-- table. Nothing is disclosed: the value lands in the resigning employee's own
-- row and it is their own notice period, which the screen already shows them.
--
-- IT OVERWRITES, IT DOES NOT MERELY FILL A NULL. `ck_resign__notice_or_waiver`
-- is the only place the notice rule is enforced, and it compares the last
-- working day against THESE TWO COLUMNS. If a client may set either of them,
-- the client sets its own bar: `POST /resignations` with
-- `notice_period_days: 0` — or with `submitted_on` back-dated a year — passes
-- every CHECK on the table while serving no notice and requesting no waiver.
-- That is the exact bypass the constraint was written to close, so both columns
-- are server-owned for anyone who is not an administrator, and frozen on UPDATE
-- so the same edit cannot be made a second later. An admin filing on someone's
-- behalf with an agreed figure still keeps theirs — that decision is audited,
-- and `resign__admin__insert` already limits who may make it.

CREATE OR REPLACE FUNCTION public.resignations_stamp_notice()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_is_admin boolean := COALESCE(app.is_admin(), false);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The snapshot is the notice that applied on the DAY OF FILING. Only an
    -- administrator may restate it; for the employee it is not a field.
    IF NOT v_is_admin OR NEW.notice_period_days IS NULL THEN
      NEW.notice_period_days := OLD.notice_period_days;
    END IF;
    IF NOT v_is_admin OR NEW.submitted_on IS NULL THEN
      NEW.submitted_on := OLD.submitted_on;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_is_admin OR NEW.notice_period_days IS NULL THEN
    SELECT e.notice_period_days INTO NEW.notice_period_days
      FROM public.employees e
     WHERE e.id = NEW.employee_id AND e.deleted_at IS NULL;
  END IF;

  IF NOT v_is_admin OR NEW.submitted_on IS NULL THEN
    NEW.submitted_on := util.ist_today();
  END IF;

  RETURN NEW;
END;
$$;

-- Runs before the NOT NULL and the notice CHECK are tested — BEFORE triggers
-- fire ahead of constraint evaluation — so a client that omits the column gets
-- the server's number rather than an error telling it to guess one. Fires on
-- UPDATE too: a row that was legal on insert must not become short-notice by a
-- later edit while it is still the employee's to edit.
DROP TRIGGER IF EXISTS trg_resign__notice ON public.resignations;
CREATE TRIGGER trg_resign__notice
  BEFORE INSERT OR UPDATE ON public.resignations
  FOR EACH ROW EXECUTE FUNCTION public.resignations_stamp_notice();

-- -----------------------------------------------------------------------------
-- 4. Stamp / touch / audit
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_resign__stamp ON public.resignations;
CREATE TRIGGER trg_resign__stamp
  BEFORE INSERT ON public.resignations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_resign__touch ON public.resignations;
CREATE TRIGGER trg_resign__touch
  BEFORE UPDATE ON public.resignations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Attached here rather than by editing 038, in that file's one-trigger-per-table
-- style: 038 attaches audit.log_changes() to every audited table, and a table
-- carrying an exit decision belongs in that set as squarely as the salary and
-- lifecycle tables already listed there. Not added to
-- audit.reason_required_tables: that list is configuration and master data,
-- where an unexplained edit is the risk. A resignation carries its own reason
-- column, and demanding app.reason on top of it would only teach the screen to
-- send the same sentence twice.
DROP TRIGGER IF EXISTS trg_resignations__audit ON public.resignations;
CREATE TRIGGER trg_resignations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.resignations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------
--
-- A public table with RLS off is a table every authenticated user can read in
-- full; for this one that means every resignation on the deployment.

ALTER TABLE public.resignations ENABLE ROW LEVEL SECURITY;

-- Self: read own, file own, edit own while it is still theirs to edit.
DROP POLICY IF EXISTS resign__self__select ON public.resignations;
CREATE POLICY resign__self__select ON public.resignations
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS resign__self__insert ON public.resignations;
CREATE POLICY resign__self__insert ON public.resignations
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

-- The WITH CHECK admits 'withdrawn' and 'cancelled' that the USING clause does
-- not require, which is what lets an employee take it back:
-- `request_types.RESIGNATION` is seeded `allows_withdrawal = true` (045 §2), and
-- a screen offering a withdraw button the database refuses is worse than no
-- button. Once an approver has moved it past pending the employee is out of the
-- row entirely — the decision belongs to `act_on_approval`.
DROP POLICY IF EXISTS resign__self__update ON public.resignations;
CREATE POLICY resign__self__update ON public.resignations
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- Manager and scoped-admin READ, as ONE policy: `app.can_see_employee` is
-- already self OR is_manager_of OR (is_admin AND admin_scope_covers) — the same
-- three branches 024 spread over `rc__manager__select` + `rc__admin__select`.
--
-- IT IS NOT WRITTEN AS `employee_id IN (SELECT app.visible_employee_ids())`
-- HERE, THOUGH THAT IS WHERE IT ENDS UP. `app.visible_employee_ids()` is
-- created by 20260806120000, which sorts AFTER this file: on a full rebuild
-- (`supabase/tests/harness/validate.mjs` replays every migration in filename
-- order against an empty cluster) naming it here fails with `function
-- app.visible_employee_ids() does not exist` and takes the whole file down.
-- Writing the `can_see_employee` shape instead is not a concession: migration
-- 20260806120200 loops over `pg_policies` and rewrites EVERY SELECT policy
-- matching `^app\.can_see_employee\([a-z_]+\)$` into the hashed-probe form, so
-- this policy arrives at exactly `employee_id IN (SELECT
-- app.visible_employee_ids())` by the time the sweep has run — with no per-row
-- re-planning left behind, and without a forward reference in this file.
DROP POLICY IF EXISTS resign__team_and_admin__select ON public.resignations;
CREATE POLICY resign__team_and_admin__select ON public.resignations
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- Admin write stays on `is_admin() AND admin_scope_covers()`: the 120200 sweep
-- touched SELECT policies only, and a write predicate must be the narrow,
-- exact one — the read set includes an actor's REPORTEES, and a manager must
-- not be able to file or edit a resignation in a reportee's name.
DROP POLICY IF EXISTS resign__admin__insert ON public.resignations;
CREATE POLICY resign__admin__insert ON public.resignations
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS resign__admin__update ON public.resignations;
CREATE POLICY resign__admin__update ON public.resignations
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- No DELETE for anyone: a resignation that was filed and then withdrawn is a
-- fact about the year, and the audit trigger above cannot record a row that was
-- removed by the same statement the audit is derived from. Withdrawal is a
-- status, not an erasure.
GRANT SELECT, INSERT, UPDATE ON public.resignations TO authenticated;
REVOKE DELETE ON public.resignations FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.resignations TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. AC-RESIGN — reporting manager, then HR
-- -----------------------------------------------------------------------------
--
-- Level 1 the reporting manager: the person who has to cover the shift and who
-- knows whether the last working day is workable. Level 2 hr_admin: the exit
-- itself — `employee_lifecycle_events`, `employees.last_working_day`, F&F — is
-- HR's to file, and `ele__admin_insert` is `app.is_admin() AND
-- app.admin_scope_covers(...)`, so HR is the only party who can act on an
-- approval once it lands.
--
-- NOT `finance`, though an exit has money in it. `resolve_approver_kind
-- ('finance')` requires membership of a department coded FIN plus a
-- manager/admin role, and on this deployment FIN is inactive with zero staff —
-- departments were cut to Ground, Management, Restaurant and Coorg. The level
-- would fall through `resolve_approvers`' ladder to hr_admin and then
-- super_admin: a finance stage in the seed that behaves as an admin stage at
-- runtime. 040600 removed exactly that lie from the claims chain; this file
-- does not reintroduce it.
--
-- No amount or day bands. A resignation has no amount, and banding on notice
-- length would mean the calendar picking the approver rather than a person.
--
-- THE TRANSITIONAL CASE, STATED PLAINLY: most employees still have no
-- `reporting_manager_id`, so `resolve_approvers` falls back to hr_admin and
-- both levels resolve to the same administrators — two approvals from one pool,
-- which `act_on_approval` permits because its double-approval guard is per
-- level. Friction, not a defect, and it disappears as managers are filled in.
-- skip_if_same_as_previous = true, as in every chain since 045, so a manager
-- resigning is not handed their own request at level 1.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-RESIGN', 'Resignation — manager then HR',
       'Level 1 the employee''s reporting manager; level 2 HR. No bands: every resignation takes the same route. Not finance — the FIN department is empty on this deployment and the level would silently resolve to an administrator anyway.',
       75,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       100::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'RESIGNATION' AND rt.deleted_at IS NULL
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
WHERE ac.code = 'AC-RESIGN' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- `create_approval_request` falls back to `request_types
-- .default_approval_chain_id` when no chain matches on selectors. Leaving it
-- NULL is precisely the state that produced `no approval chain matches request
-- type RESIGNATION`, so it is set explicitly rather than left to the selector
-- match.
UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.code = 'AC-RESIGN'
   AND ac.deleted_at IS NULL
   AND rt.code = 'RESIGNATION'
   AND rt.deleted_at IS NULL
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

-- -----------------------------------------------------------------------------
-- 7. Refuse to commit a half-wired route
-- -----------------------------------------------------------------------------
--
-- Every insert above is guarded by ON CONFLICT DO NOTHING and every one of them
-- is a SELECT ... JOIN that produces no rows if the company code, the request
-- type or the seed is not where this file assumes. That combination fails
-- SILENTLY and looks exactly like success — and the failure would only surface
-- as the same `no approval chain matches` error a resigning employee hits. The
-- three facts the screen needs are therefore asserted, not hoped for. Re-runs
-- pass: the rows are already there.

DO $$
DECLARE
  v_levels integer;
  v_table  text;
  v_wired  boolean;
BEGIN
  SELECT count(*) INTO v_levels
    FROM public.approval_chain_levels l
    JOIN public.approval_chains ac ON ac.id = l.approval_chain_id
   WHERE ac.code = 'AC-RESIGN' AND ac.deleted_at IS NULL;

  IF v_levels < 2 THEN
    RAISE EXCEPTION 'AC-RESIGN has % level(s); expected reporting_manager then hr_admin', v_levels;
  END IF;

  SELECT rt.detail_table, rt.default_approval_chain_id IS NOT NULL
    INTO v_table, v_wired
    FROM public.request_types rt
   WHERE rt.code = 'RESIGNATION' AND rt.deleted_at IS NULL;

  IF v_table IS DISTINCT FROM 'resignations' THEN
    RAISE EXCEPTION 'request_types.RESIGNATION points at detail_table %, not the table this migration created', COALESCE(v_table, '<missing row>');
  END IF;

  IF NOT v_wired THEN
    RAISE EXCEPTION 'request_types.RESIGNATION still has no default_approval_chain_id';
  END IF;
END $$;

COMMIT;
