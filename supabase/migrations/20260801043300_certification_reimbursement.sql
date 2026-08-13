-- =============================================================================
-- 20260801043300 — certification reimbursement, from nothing
-- =============================================================================
--
-- REPORTED, on /me/apply/certification, and every line of it was true:
--
--   "There is no certification request type. HR has eighteen request types
--    configured and none of them is this one."
--   "There is no server record for a certification claim to be stored in."
--   "There is no approval route, so even a new request type would have nobody to
--    send it to."
--   "There is no approved catalogue of certifications, and no amount the venue
--    has committed to per certification."
--   "Expense claims recognise nine heads and none of them is training or
--    certification, so this cannot ride on a local claim either."
--
-- Unlike the tax declaration and the lifecycle events — where the backend existed
-- and the screen was wrong — this one is genuinely absent. All five pieces are
-- built here.
--
-- ── WHY A CATALOGUE, AND NOT JUST A FREE-TEXT CLAIM ─────────────────────────
--
-- Because "the venue has committed to fund this" is a decision made once, by
-- management, for a whole certification — not something to be re-argued every
-- time somebody asks. Without a catalogue the approver has no way to answer "are
-- we paying for this" except from memory, and two employees asking for the same
-- course get different answers.
--
-- The catalogue carries a CAP, not a price. What a course costs is between the
-- employee and the institute; what the venue will fund is the venue's decision,
-- and the claim records both so the difference is visible rather than absorbed.
--
-- ── WHY IT IS NOT A REIMBURSEMENT CLAIM ────────────────────────────────────
--
-- `reimbursement_claims` exists and is well-built, and `claim_type` permits nine
-- heads — conveyance, travel, food, medical, telephone, uniform, fuel, guest
-- hospitality, other. None is training. Filing a certification under "other"
-- would work exactly once, and then every training spend the venue has would be
-- invisible in a category shared with everything else nobody had a box for.
--
-- ── THE SERVICE COMMITMENT ─────────────────────────────────────────────────
--
-- `service_commitment_months` is on the CLAIM, not the catalogue: a venue funding
-- a ₹40,000 course usually asks for a period of service afterwards, and the
-- period is agreed per person at approval time. It is recorded, never enforced —
-- clawing money back from somebody who leaves is a decision with a conversation
-- attached, and no trigger should make it automatically.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043300: the certification reimbursement subsystem — catalogue, claim table, request type, approval chain and RLS. None of the five existed.', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The catalogue — what the venue has agreed to fund
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.certification_catalogue (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid        NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                    text        NOT NULL,
  name                    text        NOT NULL,
  issuing_body            text,
  category                text        NOT NULL DEFAULT 'professional',
  /*
    The CEILING the venue will fund, not the price of the course. A course that
    costs more is still claimable — the claim carries both figures so the shortfall
    is the employee's own decision, visible rather than silently absorbed.
  */
  funding_cap_paise       bigint      NOT NULL,
  /* Who it is offered to, in words. A department filter would be a second
     eligibility engine; this is guidance for the approver, who has the context. */
  eligibility_note        text,
  requires_pass           boolean     NOT NULL DEFAULT true,
  is_active               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_certcat__cap CHECK (funding_cap_paise > 0),
  CONSTRAINT ck_certcat__category CHECK (category IN
    ('professional', 'safety', 'hospitality', 'culinary', 'compliance', 'language', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_certcat__company_code
  ON public.certification_catalogue (company_id, code);
CREATE INDEX IF NOT EXISTS idx_certcat__active
  ON public.certification_catalogue (company_id) WHERE is_active;

/*
  DROPPED FIRST, all four of these. `CREATE TRIGGER` has no `IF NOT EXISTS`, so a
  second run of this file died on 42710 while every other statement in it was
  happily idempotent — and a migration that cannot be re-run is one you cannot
  safely resume after a half-finished paste into a SQL editor.
*/
DROP TRIGGER IF EXISTS trg_certcat__stamp ON public.certification_catalogue;
CREATE TRIGGER trg_certcat__stamp BEFORE INSERT ON public.certification_catalogue
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_certcat__touch ON public.certification_catalogue;
CREATE TRIGGER trg_certcat__touch BEFORE UPDATE ON public.certification_catalogue
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.certification_catalogue IS
  'Certifications the venue has agreed to fund, with a per-certification ceiling. The answer to "are we paying for this", decided once by management rather than re-argued per request.';

-- -----------------------------------------------------------------------------
-- 2. The claim
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.certification_claims (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id               uuid        NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  /*
    NULLABLE, deliberately. Somebody will always want a course nobody has listed,
    and refusing to record it would push the request back onto WhatsApp. A claim
    with no catalogue row is an ASK — the approver decides, and if they say yes
    often enough the catalogue gains a row.
  */
  catalogue_id              uuid        REFERENCES public.certification_catalogue(id) ON DELETE SET NULL,
  /* What they are actually doing, always stated, even when the catalogue names it. */
  certification_name        text        NOT NULL,
  issuing_body              text,
  /* What it costs, and what is being asked for — two numbers, because they differ
     whenever a cap bites or the employee is funding part of it themselves. */
  course_fee_paise          bigint      NOT NULL,
  amount_requested_paise    bigint      NOT NULL,
  amount_approved_paise     bigint      NULL,
  starts_on                 date        NULL,
  completes_on              date        NULL,
  reason                    text        NOT NULL,
  /* Recorded at approval, never enforced by a trigger — see the header. */
  service_commitment_months integer     NULL,
  proof_document_ids        uuid[]      NOT NULL DEFAULT '{}',
  status                    public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id       uuid        NULL REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  submitted_at              timestamptz NULL,
  decided_by                uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at                timestamptz NULL,
  decided_comment           text        NULL,
  /* Settled through payroll or a claim; recorded here so "did we actually pay"
     has an answer that is not a search through payslips. */
  reimbursed_on             date        NULL,
  reimbursement_reference   text        NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_certclaim__fee CHECK (course_fee_paise > 0),
  CONSTRAINT ck_certclaim__requested CHECK (amount_requested_paise > 0),
  /* You cannot ask for more than the course costs. The other direction is fine —
     asking for part of it is exactly what somebody self-funding the rest does. */
  CONSTRAINT ck_certclaim__not_more_than_fee CHECK (amount_requested_paise <= course_fee_paise),
  CONSTRAINT ck_certclaim__approved CHECK (
    amount_approved_paise IS NULL OR amount_approved_paise BETWEEN 0 AND amount_requested_paise),
  CONSTRAINT ck_certclaim__reason CHECK (length(btrim(reason)) >= 15),
  CONSTRAINT ck_certclaim__dates CHECK (
    starts_on IS NULL OR completes_on IS NULL OR completes_on >= starts_on),
  CONSTRAINT ck_certclaim__commitment CHECK (
    service_commitment_months IS NULL OR service_commitment_months BETWEEN 1 AND 60)
);

/*
  One open claim per employee per certification NAME. A second attempt at the same
  course after a rejection is fine; two live ones are somebody clicking twice.
*/
CREATE UNIQUE INDEX IF NOT EXISTS uq_certclaim__one_open
  ON public.certification_claims (employee_id, lower(btrim(certification_name)))
  WHERE status IN ('draft', 'pending', 'in_progress', 'escalated');

CREATE INDEX IF NOT EXISTS idx_certclaim__employee ON public.certification_claims (employee_id);
CREATE INDEX IF NOT EXISTS idx_certclaim__status   ON public.certification_claims (status);
CREATE INDEX IF NOT EXISTS idx_certclaim__approval ON public.certification_claims (approval_request_id);

DROP TRIGGER IF EXISTS trg_certclaim__stamp ON public.certification_claims;
CREATE TRIGGER trg_certclaim__stamp BEFORE INSERT ON public.certification_claims
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_certclaim__touch ON public.certification_claims;
CREATE TRIGGER trg_certclaim__touch BEFORE UPDATE ON public.certification_claims
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.certification_claims IS
  'A request for the venue to fund a certification. Carries the course fee AND the amount asked for, because a cap or self-funding makes them differ. catalogue_id is nullable on purpose: a course nobody has listed is an ask, not an error.';

-- -----------------------------------------------------------------------------
-- 3. The request type — and the CHECK that would have refused it
-- -----------------------------------------------------------------------------
--
-- `ck_request_types__detail_table` lists the sixteen tables a request type may
-- point at, and adding a seventeenth means replacing the constraint. Done the same
-- way 041400 did it for `asset_requests`.

ALTER TABLE public.request_types DROP CONSTRAINT IF EXISTS ck_request_types__detail_table;
ALTER TABLE public.request_types ADD CONSTRAINT ck_request_types__detail_table CHECK (
  detail_table IS NULL OR detail_table IN
    ('leave_requests','attendance_regularizations','employee_change_requests',
     'reimbursement_claims','comp_off_ledger','asset_allocations','contracts',
     'employee_salary_revisions','resignations','travel_requisitions',
     'overtime_preapprovals','shift_swaps','web_punch_requests',
     'income_tax_declarations','document_requests','advance_requests',
     'asset_requests','certification_claims'));

INSERT INTO public.request_types
  (company_id, code, name, description, sort_order, detail_table, sla_hours,
   escalation_hours, is_active, requires_attachment, icon)
SELECT co.id, 'CERTIFICATION', 'Certification Reimbursement',
       'Ask the venue to fund a professional certification.',
       170, 'certification_claims', 72, 120, true, true, 'graduation-cap'
  FROM public.companies co
 WHERE co.code = 'TT' AND co.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.request_types rt
      WHERE rt.company_id = co.id AND rt.code = 'CERTIFICATION');

-- -----------------------------------------------------------------------------
-- 4. The approval chain — manager, then HR
-- -----------------------------------------------------------------------------
--
-- Two levels, and both are doing real work: the reporting manager knows whether
-- the certification is any use in the job, and HR holds the training budget. The
-- amount is not banded — a venue funding a ₹5,000 food-safety card and a ₹60,000
-- diploma wants the same two people to look at both.

DO $$
DECLARE
  v_company uuid;
  v_type    uuid;
  v_chain   uuid;
BEGIN
  SELECT id INTO v_company FROM public.companies WHERE code = 'TT' AND deleted_at IS NULL;
  SELECT id INTO v_type FROM public.request_types
   WHERE company_id = v_company AND code = 'CERTIFICATION';
  IF v_type IS NULL THEN
    RAISE NOTICE 'CERTIFICATION request type absent — chain not created';
    RETURN;
  END IF;

  SELECT id INTO v_chain FROM public.approval_chains
   WHERE company_id = v_company AND code = 'AC-CERTIFICATION';

  IF v_chain IS NULL THEN
    INSERT INTO public.approval_chains
      (company_id, request_type_id, code, name, description, is_active, is_default)
    VALUES
      (v_company, v_type, 'AC-CERTIFICATION', 'Certification — manager then HR',
       'The manager judges whether it helps the job; HR holds the training budget.',
       true, true)
    RETURNING id INTO v_chain;

    /*
      `is_optional`, inverted — there is no `is_mandatory` column, and both levels
      are required, so both are NOT optional. `skip_if_same_as_previous` stops the
      same person signing twice when a manager is also the HR admin, which is the
      rule 042400 widened.
    */
    INSERT INTO public.approval_chain_levels
      (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous, sla_hours)
    VALUES
      (v_chain, 1, 'reporting_manager', false, true, 48),
      (v_chain, 2, 'hr_admin',          false, true, 72);

    RAISE NOTICE 'created AC-CERTIFICATION with two levels';
  END IF;

  UPDATE public.request_types
     SET default_approval_chain_id = v_chain
   WHERE id = v_type AND default_approval_chain_id IS DISTINCT FROM v_chain;
END $$;

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.certification_catalogue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certification_claims ENABLE ROW LEVEL SECURITY;

/* The catalogue is an offer to staff — everybody reads it, HR maintains it. */
DROP POLICY IF EXISTS certcat__read ON public.certification_catalogue;
CREATE POLICY certcat__read ON public.certification_catalogue
  FOR SELECT TO authenticated USING (is_active OR app.is_admin());

DROP POLICY IF EXISTS certcat__admin_write ON public.certification_catalogue;
CREATE POLICY certcat__admin_write ON public.certification_catalogue
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS certclaim__self_select ON public.certification_claims;
CREATE POLICY certclaim__self_select ON public.certification_claims
  FOR SELECT TO authenticated USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS certclaim__self_insert ON public.certification_claims;
CREATE POLICY certclaim__self_insert ON public.certification_claims
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id() AND status IN ('draft', 'pending'));

/* Edit or withdraw while it is undecided, exactly the leave window. */
DROP POLICY IF EXISTS certclaim__self_update ON public.certification_claims;
CREATE POLICY certclaim__self_update ON public.certification_claims
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id()
         AND status IN ('draft', 'pending', 'in_progress', 'escalated'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft', 'pending', 'withdrawn'));

/* A manager sees their own people's claims — they are level 1 of the chain. */
DROP POLICY IF EXISTS certclaim__manager_select ON public.certification_claims;
CREATE POLICY certclaim__manager_select ON public.certification_claims
  FOR SELECT TO authenticated USING (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS certclaim__admin_all ON public.certification_claims;
CREATE POLICY certclaim__admin_all ON public.certification_claims
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 6. Raise the approval on submit, and settle it on withdrawal
-- -----------------------------------------------------------------------------
--
-- The two generic triggers from 042100 and 042300. Attached here rather than
-- waiting for a future sweep, because a request type whose approval nobody raises
-- is the defect this codebase has already fixed three times.

DROP TRIGGER IF EXISTS trg_certclaim__raise_approval ON public.certification_claims;
CREATE TRIGGER trg_certclaim__raise_approval
  AFTER UPDATE OF status ON public.certification_claims
  FOR EACH ROW
  WHEN (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM NEW.status
        AND NEW.approval_request_id IS NULL)
  EXECUTE FUNCTION public.raise_approval_for_detail('CERTIFICATION');

DROP TRIGGER IF EXISTS trg_certclaim__settle_approval ON public.certification_claims;
CREATE TRIGGER trg_certclaim__settle_approval
  AFTER UPDATE OF status ON public.certification_claims
  FOR EACH ROW
  WHEN (NEW.approval_request_id IS NOT NULL
        AND NEW.status::text IN ('withdrawn', 'cancelled')
        AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.settle_approval_for_detail();

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.certification_catalogue, public.certification_claims TO authenticated;
    GRANT INSERT, UPDATE ON public.certification_catalogue, public.certification_claims TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.certification_catalogue, public.certification_claims TO service_role;
  END IF;
END $$;

COMMIT;
