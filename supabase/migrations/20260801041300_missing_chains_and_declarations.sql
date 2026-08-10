-- =============================================================================
-- 20260801041300 — the four request types that cannot be raised at all
-- =============================================================================
--
-- `create_approval_request` (029 §5) refuses in two distinct ways, and four of
-- the eighteen seeded request types hit one or the other every single time:
--
--   RAISE 'no approval chain matches request type % for employee %'
--     when no active chain matches AND `request_types.default_approval_chain_id`
--     is NULL. 045 §3 seeded chains for eleven types. ASSET_REQUEST, COMP_OFF,
--     IT_DECLARATION and ADVANCE_REQUEST were not among them, and nothing since
--     has added one.
--
--   nothing at all to point `approval_requests.detail_id` at
--     because `detail_id` is NOT NULL and the type's `detail_table` names a
--     relation that does not exist. `ck_request_types__detail_table` (029 §1)
--     whitelists sixteen table NAMES; two of those names — the two created
--     below — were never backed by a table.
--
-- So the three gaps are not the same gap, and this file keeps them apart:
--
--   (a) ASSET_REQUEST   → `asset_allocations` EXISTS. Chain only.
--   (b) COMP_OFF        → `comp_off_ledger` EXISTS. Chain only.
--   (c) IT_DECLARATION  → `income_tax_declarations` MISSING. Table + chain.
--       ADVANCE_REQUEST → `advance_requests`         MISSING. Table + chain.
--
-- WHY NO LEVEL IS `finance`, THOUGH TWO OF THESE ARE MONEY
--
-- `resolve_approver_kind('finance')` requires membership of a department coded
-- `FIN` together with a manager/admin role. Migration 040600 established, and
-- acted on, the fact that `FIN` is inactive with zero staff on this deployment:
-- a `finance` level therefore falls through `resolve_approvers`' ladder to
-- hr_admin and then super_admin. It would read as a finance stage in the seed
-- and behave as an admin stage at runtime. Naming a level what it actually
-- resolves to beats leaving a label that lies, so the money levels below are
-- `hr_admin`.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT FIX
--
-- ASSET_REQUEST has two blockers beyond the missing chain, both recorded in
-- `src/features/apply/pages/AssetRequest.page.tsx`: `asset_allocations.asset_id`
-- is NOT NULL (a request must name a specific unit, and an employee cannot read
-- the catalogue), and `allocation_number` is NOT NULL/UNIQUE with no generating
-- trigger. Seeding the chain removes the FIRST of the three. The screen stays
-- honest about the other two until a follow-up gives Stores a request row that
-- does not have to name a unit. Fixing one gap and saying so beats fixing one
-- gap and implying three.
--
-- AUDIT TRIGGERS ARE ATTACHED HERE, not in 038 (`audit_triggers_attach.sql`),
-- in that file's style and with its naming. 038 is another author's file and
-- renumbering or editing it would rewrite history for every environment that
-- has already applied it; `audit.log_changes()` does not care which migration
-- attached it.
-- =============================================================================

BEGIN;

-- `settings` is not touched here, but `request_types` and `approval_chains`
-- both carry audit triggers (038 §15). A seed that lands in the audit log with
-- no provenance is a seed nobody can explain later. 'migration' is the only
-- actor_source an applied migration may claim.
SELECT set_config('app.reason', 'migration 041300: approval chains for ASSET_REQUEST/COMP_OFF/IT_DECLARATION/ADVANCE_REQUEST, and the two detail tables the last two point at', true);
SELECT set_config('app.source', 'migration', true);

-- =============================================================================
-- (a) ASSET_REQUEST — the chain
-- =============================================================================
--
-- Level 1 the reporting manager: whether this person needs a second uniform set
-- or a laptop is a question about their work, and their manager is the only one
-- who can answer it. Level 2 hr_admin: Stores holds the asset register and the
-- budget, and an allocation changes both.
--
-- No amount bands. `assets.purchase_cost_paise` is a property of the UNIT, not
-- of the request, and `create_approval_request` is called with `p_amount` NULL
-- from the asset screen — a banded chain would then match only the band whose
-- `amount_from` is NULL and the bands would be decoration.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-ASSET', 'Asset request — manager then HR',
       'Level 1 the employee''s reporting manager (does this person need it); level 2 hr_admin, who holds the asset register. No amount bands: cost belongs to the unit, not to the request.',
       120,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       100::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'ASSET_REQUEST' AND rt.deleted_at IS NULL
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
WHERE ac.code = 'AC-ASSET' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- =============================================================================
-- (b) COMP_OFF — the chain, and what comp-off ALREADY does without one
-- =============================================================================
--
-- READ FIRST, BECAUSE THE ANSWER CHANGES THE CHAIN.
--
-- Comp-off is not applied for. `sync_comp_off_for_day` (018 §3) runs inside
-- `compute_attendance_day` and CREDITS the ledger itself whenever the day's
-- status is `weekly_off_worked` or `holiday_worked` and `extra_work_minutes`
-- clears `attendance_policies.comp_off_min_minutes` — half a day below
-- `comp_off_full_day_minutes`, a full day above. It is keyed on
-- `earned_from_attendance_day_id` (unique index `uq_col__earned_per_day`) so a
-- recompute resizes the credit instead of doubling it, and a day that recomputes
-- to an ordinary status cancels an unconsumed credit rather than deleting it.
-- Spending is the other end, also automatic: `consume_comp_off` (019 §8) walks
-- the credits FIFO by expiry when a comp-off LEAVE REQUEST is approved, which is
-- why the employee-facing screen `/me/comp-off` sends people to the leave form
-- and never offers a "claim" button.
--
-- SO WHAT IS LEFT FOR AN APPROVAL? Exactly one thing, and it is currently
-- stranded: the engine writes the credit with `status = 'pending_approval'`,
-- and NO function anywhere moves it to 'available'. `consume_comp_off` spends
-- only 'available'/'partially_used' rows. Every auto-detected credit on this
-- deployment is therefore unspendable, and the gap is not "no way to ask for
-- comp-off" but "no way to confirm the comp-off the engine already saw".
--
-- ONE LEVEL, THE REPORTING MANAGER, AND NOTHING ELSE. The only question is
-- whether the extra work on that weekly off or holiday was real and was asked
-- for; the manager who was there is the whole of the evidence. No hr_admin
-- level: no money moves, no statutory record changes, and a second signature
-- from someone who cannot know the answer is a queue, not a control.
--
-- This chain does not by itself flip `pending_approval` to 'available' —
-- `act_on_approval` never writes back to a detail table (the same limit
-- 040500 had to close for claims). That writer is a separate, deliberate
-- follow-up; without a chain it could not even be reached.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-COMPOFF', 'Comp-off — reporting manager',
       'Single level. The credit is detected by the attendance engine (018 §3) and lands as `pending_approval`; the manager who was there confirms the extra work happened. No HR level: no money moves and no statutory record changes.',
       130,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       100::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'COMP_OFF' AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, 1, 'reporting_manager', false, true
FROM public.approval_chains ac
WHERE ac.code = 'AC-COMPOFF' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- =============================================================================
-- (c1) income_tax_declarations — the table
-- =============================================================================
--
-- The name already existed in two places and behind neither of them was a
-- relation: `ck_request_types__detail_table` (029 §1) and the 045 §2 seed row.
-- `src/features/apply/pages/IncomeTax.page.tsx` routes the REGIME ELECTION
-- through `PROFILE_CHANGE`/`employee_change_requests` precisely because this
-- table was missing — that path stays valid and untouched; what it cannot carry
-- is the investment declaration itself, which is what this table is.
--
-- SHAPE DECISIONS
--
--  * One row per employee per financial year, enforced by a PARTIAL unique
--    index that ignores cancelled/rejected/withdrawn rows. A plain UNIQUE would
--    mean a rejected declaration permanently blocks the re-declaration it is
--    asking for.
--  * Every declared figure is integer paise (`bigint`, `_paise` suffix), the
--    same convention as 020–024. Tax declarations are the exact place where a
--    float would eventually be off by a rupee and nobody could say which rupee.
--  * `total_deductions_paise` is GENERATED ALWAYS ... STORED. The amount that
--    goes to `create_approval_request(p_amount => ...)` and onto the approver's
--    screen must not be added up in a browser; a stored generated column makes
--    the sum a property of the row and removes the possibility of the form and
--    the database disagreeing about it. `other_income_paise` and the previous
--    employer figures are deliberately OUTSIDE the sum: they increase taxable
--    income, they are not deductions, and adding them would flatter the total.
--    `hra_rent_paid_paise` is outside it for the SAME reason and it is the one
--    that would have mattered most. Rent paid is not a deduction under any
--    section: the deduction is the section 10(13A) EXEMPTION, which is the least
--    of (HRA received, rent − 10% of salary, 50/40% of salary) and cannot be
--    derived from this row at all — it needs the salary structure. Summing gross
--    rent into a column named `total_deductions_paise` would have put a number
--    on the approver's screen that is larger than any deduction the employee is
--    entitled to, on the row where that number is the whole decision. The rent
--    figure is still declared and still stored; it is just not claimed to be a
--    deduction. Computing the exemption is a follow-up that needs payroll.
--  * `regime` uses the same vocabulary as `employee_statutory.tax_regime`
--    (`ck_es__regime`, 009 §6) — 'old' / 'new'. An employee must not be able to
--    read a different word for the same fact off two screens.
--  * Section columns rather than a lines table: the sections of the Act are a
--    fixed vocabulary and a column that does not exist cannot be mis-keyed.
--    Adding a section later is an ALTER; inventing one at run time is not
--    possible, which is the point.

CREATE TABLE IF NOT EXISTS public.income_tax_declarations (
  id                              uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id                     uuid        NOT NULL,
  financial_year                  text        NOT NULL DEFAULT util.financial_year(util.ist_today()),
  regime                          text        NOT NULL DEFAULT 'new',
  -- Chapter VI-A and house-property deductions, all integer paise.
  sec_80c_paise                   bigint      NOT NULL DEFAULT 0,
  sec_80ccd_1b_paise              bigint      NOT NULL DEFAULT 0,
  sec_80d_paise                   bigint      NOT NULL DEFAULT 0,
  sec_80dd_paise                  bigint      NOT NULL DEFAULT 0,
  sec_80ddb_paise                 bigint      NOT NULL DEFAULT 0,
  sec_80e_paise                   bigint      NOT NULL DEFAULT 0,
  sec_80eeb_paise                 bigint      NOT NULL DEFAULT 0,
  sec_80g_paise                   bigint      NOT NULL DEFAULT 0,
  sec_80tta_paise                 bigint      NOT NULL DEFAULT 0,
  sec_24b_paise                   bigint      NOT NULL DEFAULT 0,
  hra_rent_paid_paise             bigint      NOT NULL DEFAULT 0,
  hra_landlord_pan                text        NULL,
  -- Additions to taxable income. NOT part of total_deductions_paise.
  other_income_paise              bigint      NOT NULL DEFAULT 0,
  previous_employer_income_paise  bigint      NOT NULL DEFAULT 0,
  previous_employer_tds_paise     bigint      NOT NULL DEFAULT 0,
  total_deductions_paise          bigint      NOT NULL GENERATED ALWAYS AS (
    sec_80c_paise + sec_80ccd_1b_paise + sec_80d_paise + sec_80dd_paise
    + sec_80ddb_paise + sec_80e_paise + sec_80eeb_paise + sec_80g_paise
    + sec_80tta_paise + sec_24b_paise + hra_rent_paid_paise) STORED,
  proof_document_ids              uuid[]      NOT NULL DEFAULT '{}',
  declaration_note                text        NULL,
  status                          public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id             uuid        NULL,
  submitted_at                    timestamptz NULL,
  decided_by                      uuid        NULL,
  decided_at                      timestamptz NULL,
  decided_comment                 text        NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NULL,
  CONSTRAINT pk_income_tax_declarations PRIMARY KEY (id),
  CONSTRAINT fk_itd__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_itd__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_itd__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_itd__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_itd__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.income_tax_declarations IS
  'Employee investment/deduction declaration for one financial year — the detail row `IT_DECLARATION` points at. Amounts are DECLARED, not verified; payroll reads them only after the request is approved.';
COMMENT ON COLUMN public.income_tax_declarations.total_deductions_paise IS
  'Generated sum of the Chapter VI-A and house-property sections. Generated so the approver''s figure and the stored figure cannot diverge; excludes other/previous-employer income, which are additions to taxable income, not deductions.';
COMMENT ON COLUMN public.income_tax_declarations.proof_document_ids IS
  'Documents supporting the declaration. Postgres cannot put a foreign key on an array element, so `trg_itd__proofs` is the foreign key — and it also checks the document belongs to the same employee.';
COMMENT ON COLUMN public.income_tax_declarations.regime IS
  'Same vocabulary as employee_statutory.tax_regime (ck_es__regime, 009 §6): old / new.';

-- Policy constraints, added separately and guarded.
--
-- `CREATE TABLE IF NOT EXISTS` is a no-op when an earlier, aborted attempt left
-- a table of this name behind — and a table that exists WITHOUT these checks
-- silently accepts a negative deduction. Adding them as guarded ALTERs makes an
-- already-present table converge on this file's intent instead of on whatever
-- the earlier attempt happened to create. `duplicate_object` is the only
-- exception swallowed; anything else still fails the migration.
DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__regime CHECK (regime IN ('old','new'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- '2026-27'. Identical to ck_bi__fy (024 §3) so the two tables sort together.
DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__financial_year CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__amounts_nonneg CHECK (
      sec_80c_paise >= 0 AND sec_80ccd_1b_paise >= 0 AND sec_80d_paise >= 0
      AND sec_80dd_paise >= 0 AND sec_80ddb_paise >= 0 AND sec_80e_paise >= 0
      AND sec_80eeb_paise >= 0 AND sec_80g_paise >= 0 AND sec_80tta_paise >= 0
      AND sec_24b_paise >= 0 AND hra_rent_paid_paise >= 0
      AND other_income_paise >= 0 AND previous_employer_income_paise >= 0
      AND previous_employer_tds_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The PAN format the Income Tax Department issues; the same shape the payroll
-- masking rules already assume for `employee_statutory.pan`.
DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__landlord_pan CHECK (
      hra_landlord_pan IS NULL OR hra_landlord_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Rent above ₹1,00,000 a year requires the landlord's PAN. Enforcing it here
-- rather than in the form means a direct PostgREST call cannot skip it — the
-- rule belongs to the company, not to the author of one screen.
DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__landlord_pan_required CHECK (
      hra_rent_paid_paise <= 10000000 OR hra_landlord_pan IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `array_position` is STABLE, so a NULL-element check cannot live in a CHECK
-- (Postgres requires IMMUTABLE there); `cardinality` can, and the NULL check is
-- done by the trigger below. Twenty is a ceiling on accident, not on intent.
DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__proofs_bounded CHECK (cardinality(proof_document_ids) <= 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.income_tax_declarations
    ADD CONSTRAINT ck_itd__decided_fields CHECK (
      status NOT IN ('approved','rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_itd__employee ON public.income_tax_declarations (employee_id);
CREATE INDEX IF NOT EXISTS idx_itd__status   ON public.income_tax_declarations (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_itd__approval ON public.income_tax_declarations (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- One live declaration per employee per year; a cancelled, rejected or withdrawn
-- one must not block the corrected re-declaration it is asking for.
CREATE UNIQUE INDEX IF NOT EXISTS uq_itd__employee_year
  ON public.income_tax_declarations (employee_id, financial_year)
  WHERE status NOT IN ('cancelled','rejected','withdrawn');

/*
  The foreign key an array cannot have.

  A bare uuid in `proof_document_ids` would otherwise let a declaration cite a
  document that does not exist, or — worse and quietly — someone else's Form 16.
  SECURITY DEFINER because `documents` is read through its own RLS and the
  employee filing the declaration is not entitled to see every row this must
  check; the trigger discloses nothing, it only refuses.

  23514 (not 23503): `WRITE_CODE_KIND` in `src/shared/api/write.ts` maps it to
  `conflict`, which `isRuleRejection` renders to the user verbatim. The message
  is written for the person who attached the wrong file.
*/
CREATE OR REPLACE FUNCTION public.itd_check_proof_documents()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id      uuid;
  v_missing integer;
BEGIN
  IF NEW.proof_document_ids IS NULL OR cardinality(NEW.proof_document_ids) = 0 THEN
    RETURN NEW;
  END IF;

  FOREACH v_id IN ARRAY NEW.proof_document_ids LOOP
    IF v_id IS NULL THEN
      RAISE EXCEPTION
        'One of the attached proofs has no document reference. Remove it and attach the file again.'
        USING errcode = '23514';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_missing
  FROM unnest(NEW.proof_document_ids) AS p(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.documents d
     WHERE d.id = p.id
       AND d.employee_id = NEW.employee_id
       AND d.deleted_at IS NULL);

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      '% of the attached proofs are not documents filed against this employee. Upload the proof first, then attach it.',
      v_missing
      USING errcode = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_itd__proofs ON public.income_tax_declarations;
CREATE TRIGGER trg_itd__proofs
  BEFORE INSERT OR UPDATE OF proof_document_ids, employee_id ON public.income_tax_declarations
  FOR EACH ROW EXECUTE FUNCTION public.itd_check_proof_documents();

DROP TRIGGER IF EXISTS trg_itd__stamp ON public.income_tax_declarations;
CREATE TRIGGER trg_itd__stamp
  BEFORE INSERT ON public.income_tax_declarations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_itd__touch ON public.income_tax_declarations;
CREATE TRIGGER trg_itd__touch
  BEFORE UPDATE ON public.income_tax_declarations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.income_tax_declarations ENABLE ROW LEVEL SECURITY;

/*
  RLS. Note what is NOT here: there is no manager policy.

  A declaration lists what a person insures, what they owe on a house, what they
  pay in rent and to whom, and what they give to charity. The chain for this type
  is hr_admin ONLY (below) — the reporting manager has no part to play in it, and
  a read policy exists to serve a job someone has, not to complete a pattern.
  `bonus_incentives` (024 §3) sets the same precedent from the other direction:
  the policy follows who needs the row, not the shape of the table.

  The predicates are written as plain `app.*` calls rather than in the hoisted
  `(SELECT app.*())` form because this file sorts BEFORE 20260806120000 and
  20260807091000: on a rebuild those helpers do not exist yet, and those two
  migrations rewrite exactly these shapes when they run.
*/
DROP POLICY IF EXISTS itd__self__select ON public.income_tax_declarations;
CREATE POLICY itd__self__select ON public.income_tax_declarations
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS itd__self__insert ON public.income_tax_declarations;
CREATE POLICY itd__self__insert ON public.income_tax_declarations
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

-- Editable while it is still the employee's to edit; once it is in front of HR
-- the only self-transitions left are the ones that take it off the queue.
DROP POLICY IF EXISTS itd__self__update ON public.income_tax_declarations;
CREATE POLICY itd__self__update ON public.income_tax_declarations
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

DROP POLICY IF EXISTS itd__admin__select ON public.income_tax_declarations;
CREATE POLICY itd__admin__select ON public.income_tax_declarations
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS itd__admin__insert ON public.income_tax_declarations;
CREATE POLICY itd__admin__insert ON public.income_tax_declarations
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS itd__admin__update ON public.income_tax_declarations;
CREATE POLICY itd__admin__update ON public.income_tax_declarations
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- No DELETE for anyone holding a JWT: a declaration that was submitted is
-- evidence of what was claimed, and 'cancelled'/'withdrawn' already say
-- "not in force" without erasing it.
GRANT SELECT, INSERT, UPDATE ON public.income_tax_declarations TO authenticated;
REVOKE DELETE ON public.income_tax_declarations FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.income_tax_declarations TO service_role;
  END IF;
END $$;

-- =============================================================================
-- (c2) advance_requests — the table
-- =============================================================================
--
-- `reimbursement_claims.advance_adjusted_paise` has existed since 024 and there
-- has never been an advance to adjust against. This is that row.
--
-- SHAPE DECISIONS
--
--  * NO request number is minted here. `asset_allocations.allocation_number`
--    is the cautionary case: NOT NULL, UNIQUE, no generator, so nothing can
--    file one. The reference for an advance is `approval_requests.request_number`,
--    minted server-side by `create_approval_request` from
--    `seq_approval_request_number`. One reference, one minter.
--  * `monthly_instalment_paise` is generated, by integer ceiling division, for
--    the same reason the claim total is a trigger and not a form field: a
--    repayment figure computed in a browser is a repayment figure the browser's
--    author decided. The final instalment absorbs the remainder — with a ceiling
--    the last month is the SMALLEST, never a surprise extra month.
--  * `requested_on` defaults to `util.ist_today()`, never `CURRENT_DATE`: this
--    database runs in UTC and a request filed at 09:00 IST on the 1st would
--    otherwise be dated the 31st, which is the kind of off-by-one that is only
--    ever found in a payroll dispute.

CREATE TABLE IF NOT EXISTS public.advance_requests (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id               uuid        NOT NULL,
  amount_paise              bigint      NOT NULL,
  reason                    text        NOT NULL,
  repayment_months          integer     NOT NULL DEFAULT 1,
  monthly_instalment_paise  bigint      NOT NULL GENERATED ALWAYS AS
                                          ((amount_paise + repayment_months - 1) / repayment_months) STORED,
  requested_on              date        NOT NULL DEFAULT util.ist_today(),
  needed_by_date            date        NULL,
  recovery_starts_on        date        NULL,
  status                    public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id       uuid        NULL,
  submitted_at              timestamptz NULL,
  decided_by                uuid        NULL,
  decided_at                timestamptz NULL,
  decided_comment           text        NULL,
  approved_amount_paise     bigint      NULL,
  recovered_paise           bigint      NOT NULL DEFAULT 0,
  paid_via_payroll_run_id   uuid        NULL,
  paid_via_payslip_id       uuid        NULL,
  disbursed_on              date        NULL,
  payment_reference         text        NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NULL,
  CONSTRAINT pk_advance_requests PRIMARY KEY (id),
  CONSTRAINT fk_adv__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_adv__approval_request_id
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_adv__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_adv__paid_via_payroll_run_id
    FOREIGN KEY (paid_via_payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  CONSTRAINT fk_adv__paid_via_payslip_id
    FOREIGN KEY (paid_via_payslip_id) REFERENCES public.payslips(id) ON DELETE SET NULL,
  CONSTRAINT fk_adv__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_adv__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.advance_requests IS
  'Salary advance asked for by an employee — the detail row `ADVANCE_REQUEST` points at. Recovered through payroll; `reimbursement_claims.advance_adjusted_paise` (024) is the other place an advance is netted off.';
COMMENT ON COLUMN public.advance_requests.monthly_instalment_paise IS
  'Generated: integer ceiling of amount_paise / repayment_months. Ceiling, not floor, so the LAST instalment is the smallest and the schedule never grows an extra month.';
COMMENT ON COLUMN public.advance_requests.approved_amount_paise IS
  'What was actually sanctioned, when it differs from what was asked. NULL until decided; capped at amount_paise by ck_adv__approved_le_requested.';

-- Policy constraints — guarded for the reason given on the declaration table:
-- a table left behind by an aborted attempt must still converge on these rules.
DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__amount_positive CHECK (amount_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1..24. A zero would make the generated instalment a division by zero, and a
-- 36-month advance is a loan — a different instrument with different consent.
DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__repayment_months CHECK (repayment_months BETWEEN 1 AND 24);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ten characters, matching the `deletion_reason` bar used across 007–029: "urgent"
-- tells an approver nothing, and this is the only field the decision rests on.
DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__reason_present CHECK (length(btrim(reason)) >= 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__approved_le_requested CHECK (
      approved_amount_paise IS NULL
      OR (approved_amount_paise > 0 AND approved_amount_paise <= amount_paise));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Recovery can never exceed what was handed over, so the outstanding balance
-- (amount − recovered) can never go negative and be read as a credit.
DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__recovered_le_amount CHECK (
      recovered_paise >= 0
      AND recovered_paise <= COALESCE(approved_amount_paise, amount_paise));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The same sentinel-date guard 024 uses: '9999-12-31' as a stand-in for "open"
-- breaks every date comparison downstream.
DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__no_sentinel_dates CHECK (
      requested_on <= DATE '2100-01-01'
      AND (needed_by_date IS NULL OR needed_by_date <= DATE '2100-01-01')
      AND (recovery_starts_on IS NULL OR recovery_starts_on <= DATE '2100-01-01')
      AND (disbursed_on IS NULL OR disbursed_on <= DATE '2100-01-01'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.advance_requests
    ADD CONSTRAINT ck_adv__decided_fields CHECK (
      status NOT IN ('approved','rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_adv__employee     ON public.advance_requests (employee_id);
CREATE INDEX IF NOT EXISTS idx_adv__status       ON public.advance_requests (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_adv__approval     ON public.advance_requests (approval_request_id)
  WHERE approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_adv__payroll_run  ON public.advance_requests (paid_via_payroll_run_id)
  WHERE paid_via_payroll_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_adv__payslip      ON public.advance_requests (paid_via_payslip_id)
  WHERE paid_via_payslip_id IS NOT NULL;
-- Recovery still running: the index payroll needs every month.
CREATE INDEX IF NOT EXISTS idx_adv__outstanding  ON public.advance_requests (employee_id)
  WHERE status IN ('approved','applied') AND disbursed_on IS NOT NULL;

DROP TRIGGER IF EXISTS trg_adv__stamp ON public.advance_requests;
CREATE TRIGGER trg_adv__stamp
  BEFORE INSERT ON public.advance_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_adv__touch ON public.advance_requests;
CREATE TRIGGER trg_adv__touch
  BEFORE UPDATE ON public.advance_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;

-- Self / manager / scoped admin, exactly as 024 §1 does for claims. The manager
-- policy IS here — unlike the declaration table — because level 1 of AC-ADVANCE
-- is the reporting manager, who cannot decide a row they cannot read.
DROP POLICY IF EXISTS adv__self__select ON public.advance_requests;
CREATE POLICY adv__self__select ON public.advance_requests
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS adv__self__insert ON public.advance_requests;
CREATE POLICY adv__self__insert ON public.advance_requests
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

DROP POLICY IF EXISTS adv__self__update ON public.advance_requests;
CREATE POLICY adv__self__update ON public.advance_requests
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- Read only: decisions go through `act_on_approval`, never through a direct
-- UPDATE by the approver.
DROP POLICY IF EXISTS adv__manager__select ON public.advance_requests;
CREATE POLICY adv__manager__select ON public.advance_requests
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

DROP POLICY IF EXISTS adv__admin__select ON public.advance_requests;
CREATE POLICY adv__admin__select ON public.advance_requests
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS adv__admin__insert ON public.advance_requests;
CREATE POLICY adv__admin__insert ON public.advance_requests
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS adv__admin__update ON public.advance_requests;
CREATE POLICY adv__admin__update ON public.advance_requests
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- A disbursed advance is a money record. It is cancelled, never deleted.
GRANT SELECT, INSERT, UPDATE ON public.advance_requests TO authenticated;
REVOKE DELETE ON public.advance_requests FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.advance_requests TO service_role;
  END IF;
END $$;

-- =============================================================================
-- (c3) The two chains for the two new tables
-- =============================================================================
--
-- AC-ITDECL is ONE level, hr_admin. A tax declaration is checked against proof
-- and against the Act, and the reporting manager can do neither; routing it past
-- them would also hand them the employee's rent, insurance and charity figures
-- for no purpose. This mirrors AC-PROFILE (045 §3), the chain the regime
-- election already rides on today.
--
-- AC-ADVANCE is TWO. Level 1 the reporting manager, who knows the person and
-- whether the need is real. Level 2 hr_admin, because the money comes out of
-- payroll and goes back through it — see the header for why this level is not
-- called `finance`. No amount bands: a small advance and a large one are decided
-- by the same two people, and 040600 recorded what bands actually did to claims
-- (₹9,999 signed off by one manager and nobody who handles money).

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-ITDECL', 'IT declaration — HR admin',
       'Single level, hr_admin. Checked against proofs and the Act; the reporting manager can do neither and has no business seeing the figures.',
       140,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       100::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'IT_DECLARATION' AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, 1, 'hr_admin', false, true
FROM public.approval_chains ac
WHERE ac.code = 'AC-ITDECL' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-ADVANCE', 'Salary advance — manager then HR',
       'Level 1 the employee''s reporting manager (is the need real); level 2 hr_admin, because the money leaves payroll and is recovered through it. No amount bands.',
       150,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       100::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'ADVANCE_REQUEST' AND rt.deleted_at IS NULL
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
WHERE ac.code = 'AC-ADVANCE' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- =============================================================================
-- (d) Point the four request types at their new default chain
-- =============================================================================
--
-- Not decoration. `create_approval_request` first looks for a matching active
-- chain and only then falls back to `default_approval_chain_id`; leaving the
-- pointer NULL means any future selector change on these chains silently
-- reinstates 'no approval chain matches request type %'. 045 §3 ends with the
-- same UPDATE for the eleven types it seeded — this is that statement, narrowed
-- to the four codes this file is responsible for so it cannot re-point anyone
-- else's type.

UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.request_type_id = rt.id
   AND ac.code IN ('AC-ASSET','AC-COMPOFF','AC-ITDECL','AC-ADVANCE')
   AND ac.is_default AND ac.is_active AND ac.deleted_at IS NULL
   AND rt.deleted_at IS NULL
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

-- =============================================================================
-- (e) Audit triggers for the two new tables
-- =============================================================================
--
-- Same function, same naming and same one-trigger-per-table shape as 038 §10,
-- which attaches these to `reimbursement_claims` and `bonus_incentives`. A
-- declaration and an advance are both money records and belong in the log for
-- the same reason those two do.
--
-- NEITHER TABLE goes into `audit.reason_required_tables`. That list forces an
-- `app.reason` of at least N characters on every write, and both of these are
-- written by the EMPLOYEE from a self-service form that has no reason box —
-- adding them would turn "declare your investments" into a 42501-shaped dead
-- end. The tables that carry that requirement are the ones an administrator
-- edits about somebody else.

DROP TRIGGER IF EXISTS trg_income_tax_declarations__audit ON public.income_tax_declarations;
CREATE TRIGGER trg_income_tax_declarations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.income_tax_declarations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_advance_requests__audit ON public.advance_requests;
CREATE TRIGGER trg_advance_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.advance_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

COMMIT;
