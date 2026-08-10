-- =============================================================================
-- 20260801040400 — reimbursement claims: the fields, the receipt and the window
-- =============================================================================
--
-- Part one of four that turn `reimbursement_claims` from a table nothing writes
-- into a working reimbursement portal. This file adds what a claim needs to
-- CARRY; 040500 makes an approval actually reach it; 040600 routes it manager →
-- admin; 040700 records the payment.
--
-- WHAT THIS ADDS, AND WHY EACH PIECE IS HERE
--
--  1. `travel_purpose` and `travel_mode` on `claim_lines`. Asked for directly:
--     the claim form is to offer the same two dropdowns the reference product
--     does. `claim_lines.expense_head` is free text and could have absorbed
--     them, but two facts crammed into one free-text column cannot be counted,
--     filtered or checked — and the whole point of the dashboard is counting.
--     Both are NULLABLE: a medical bill has no travel mode, and forcing one
--     would teach people to pick 'other' to get past the form.
--
--  2. An `EXPENSE_RECEIPT` document type. `claim_lines.receipt_document_id` has
--     existed since 002400 and nothing has ever written it, because there was
--     no type an employee was allowed to file under. Every flag below is
--     dictated by `documents__self__insert` (migration 040200): a type that
--     fails any one of those predicates produces the exact failure a joiner hit
--     with Aadhaar — the form offers it, they fill it in, and only then does the
--     database refuse.
--
--  3. A claim window (`claims.max_bill_age_days`, 180) and the two date guards
--     that enforce it. Both rules were previously BROWSER-ONLY — a direct
--     PostgREST call could file a bill dated next year, or one from 2019. A
--     rule that only the form enforces is a rule the form's author enforces,
--     not the company.
--
--  4. A trigger keeping `total_claimed_paise` equal to the sum of its lines.
--     Today that invariant holds only because the screen writes exactly one
--     line and copies the figure into both places. The moment a second line
--     exists — and multi-line is the obvious next ask — the claim total and the
--     lines silently disagree, and the total is what gets approved and paid.
--
-- REFUSALS RAISE 23514. `WRITE_CODE_KIND` in `src/shared/api/write.ts` maps that
-- to `conflict`, which `isRuleRejection` renders to the user verbatim — so the
-- messages below are written for the person who typed the date, not for a log.
-- =============================================================================

BEGIN;

-- `settings` is in `audit.reason_required_tables`. Its `applies_to` is
-- update_delete so an INSERT would pass without this, but a seed that lands in
-- the audit log with no provenance is a seed nobody can explain later.
SELECT set_config('app.reason', 'migration 040400: reimbursement claim fields, receipt type and claim window', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Travel purpose and mode
-- -----------------------------------------------------------------------------

ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS travel_purpose text NULL,
  ADD COLUMN IF NOT EXISTS travel_mode    text NULL;

COMMENT ON COLUMN public.claim_lines.travel_purpose IS
  'Why the journey happened — sales / support / management. Null for a claim with no journey (food, medical, telephone).';
COMMENT ON COLUMN public.claim_lines.travel_mode IS
  'How the journey was made. Null for a claim with no journey. `company_bike` / `company_car` are distinguished from the personal ones because a company vehicle changes what may be claimed.';

DO $$ BEGIN
  ALTER TABLE public.claim_lines
    ADD CONSTRAINT ck_claim_lines__travel_purpose CHECK (
      travel_purpose IS NULL OR travel_purpose IN ('sales','support','management'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.claim_lines
    ADD CONSTRAINT ck_claim_lines__travel_mode CHECK (
      travel_mode IS NULL OR travel_mode IN (
        'taxi','auto','bus','bike','car','company_bike','company_car','train','flight','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/*
  A line that says a receipt is required must carry one.

  NOT VALID deliberately: the constraint binds every row written or updated from
  now on, and does not retro-fail the handful of lines filed before a receipt
  could be attached at all. Validating it later is a one-line follow-up once
  those are settled; failing this migration on them would help nobody.
*/
DO $$ BEGIN
  ALTER TABLE public.claim_lines
    ADD CONSTRAINT ck_claim_lines__receipt_present CHECK (
      NOT is_receipt_required OR receipt_document_id IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 2. The receipt document type
-- -----------------------------------------------------------------------------

/*
  Every flag here is load-bearing against `documents__self__insert`:
    visible_to_employee   — else the employee cannot see their own receipt back
    employee_uploadable   — else the policy refuses the insert (040200)
    requires_esign        — a receipt is evidence, not an agreement
    requires_acknowledgement — nothing to acknowledge; it is their own file
    requires_approval     — false, so it lands `approved` rather than queueing
                            for review. The APPROVAL THAT MATTERS is the claim's,
                            by a manager who looks at the amount and the bill
                            together. A second queue on the file alone would be
                            cleared without looking, which is how a real mismatch
                            gets waved through.
    is_required_for_onboarding — false. A receipt belongs to one claim, not to
                            joining; marking it required would block every new
                            joiner on a bill they have not yet incurred.
*/
INSERT INTO public.document_types
  (code, name, description, sort_order, category,
   is_required_for_onboarding, requires_expiry, requires_approval,
   requires_acknowledgement, requires_esign,
   is_sensitive, visible_to_employee, visible_to_manager, employee_uploadable)
VALUES
  ('EXPENSE_RECEIPT', 'Expense Receipt',
   'Bill or invoice supporting a reimbursement claim. Filed by the employee against one claim line.',
   270, 'payroll',
   false, false, false,
   false, false,
   false, true, true, true)
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. The claim window
-- -----------------------------------------------------------------------------

INSERT INTO public.settings
  (company_id, key, value, value_kind, scope, group_name, label, description,
   is_sensitive, is_editable_by_admin)
SELECT c.id, 'claims.max_bill_age_days', '180'::jsonb, 'number', 'company', 'payroll',
       'Claim window (days)',
       'How far back a bill may be dated and still be claimable. 0 disables the check.',
       false, true
FROM public.companies c
WHERE c.deleted_at IS NULL
ON CONFLICT (company_id, key, scope,
             coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

/*
  Resolve the window for one claim line.

  Company-scoped, because two companies on one deployment can run different
  policies and a single global number would quietly apply one company's rule to
  the other. Falls back to any configured row, then to the seeded 180 — a
  missing setting must not mean "no window at all", which is the failure mode
  where a deleted row silently opens the gate.

  SECURITY DEFINER: `settings` is admin-read in places, and an employee filing
  their own claim must still be measured against the policy.
*/
CREATE OR REPLACE FUNCTION public.claim_window_days(p_claim_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT (s.value #>> '{}')::integer
       FROM public.settings s
       JOIN public.reimbursement_claims rc ON rc.id = p_claim_id
       JOIN public.employees e ON e.id = rc.employee_id
      WHERE s.key = 'claims.max_bill_age_days'
      ORDER BY (s.company_id = e.company_id) DESC, (s.scope = 'global') DESC
      LIMIT 1),
    180);
$$;

COMMENT ON FUNCTION public.claim_window_days(uuid) IS
  'Days back a bill may be dated for this claim''s company. Defaults to 180 when unset — a missing setting must not mean an unbounded window.';

CREATE OR REPLACE FUNCTION public.claim_lines_check_bill_date()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_today date;
  v_days  integer;
BEGIN
  IF NEW.line_date IS NULL THEN
    RETURN NEW;
  END IF;

  v_today := util.ist_today();

  IF NEW.line_date > v_today THEN
    RAISE EXCEPTION
      'That bill is dated %, which is in the future. Check the date on the bill.',
      to_char(NEW.line_date, 'DD Mon YYYY')
      USING errcode = '23514';
  END IF;

  v_days := public.claim_window_days(NEW.claim_id);

  IF v_days > 0 AND NEW.line_date < v_today - v_days THEN
    RAISE EXCEPTION
      'That bill is dated %. Claims are accepted only for bills dated within the last % days, so this one is outside the window — ask HR if it still needs to be paid.',
      to_char(NEW.line_date, 'DD Mon YYYY'), v_days
      USING errcode = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_lines__bill_date ON public.claim_lines;
CREATE TRIGGER trg_claim_lines__bill_date
  BEFORE INSERT OR UPDATE OF line_date ON public.claim_lines
  FOR EACH ROW EXECUTE FUNCTION public.claim_lines_check_bill_date();

-- -----------------------------------------------------------------------------
-- 4. The claim total follows its lines
-- -----------------------------------------------------------------------------

/*
  SECURITY DEFINER so the sum lands even though the claimant's own UPDATE policy
  on `reimbursement_claims` closes once the status moves past pending. The row it
  writes is derived, not asserted: it can only ever equal the sum of lines the
  caller was already allowed to write.

  No recursion — this touches `reimbursement_claims`, which has no trigger that
  writes back to `claim_lines`.
*/
CREATE OR REPLACE FUNCTION public.claim_lines_sync_claim_total()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_claim uuid := COALESCE(NEW.claim_id, OLD.claim_id);
BEGIN
  UPDATE public.reimbursement_claims rc
     SET total_claimed_paise = COALESCE(
           (SELECT sum(cl.amount_claimed_paise)
              FROM public.claim_lines cl
             WHERE cl.claim_id = v_claim), 0)
   WHERE rc.id = v_claim;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_lines__sync_total ON public.claim_lines;
CREATE TRIGGER trg_claim_lines__sync_total
  AFTER INSERT OR UPDATE OF amount_claimed_paise, claim_id OR DELETE ON public.claim_lines
  FOR EACH ROW EXECUTE FUNCTION public.claim_lines_sync_claim_total();

GRANT EXECUTE ON FUNCTION public.claim_window_days(uuid) TO authenticated;

COMMIT;
