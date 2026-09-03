-- ============================================================================
-- What a month — or a year — of reimbursement adds up to.
--
-- ── WHY THIS DID NOT EXIST ──────────────────────────────────────────────────
-- Asked for: "How can the admin check which reimbursements have been processed,
-- which are done, and which are pending? There should be a reimbursement page to
-- understand everything, with month/year filtering, so they can view the totals."
--
-- Checked before building, and the answer was nowhere: `/admin/payroll/reimbursements`
-- shows each claim's own amount and adds nothing up — its own header says "not one
-- amount is added up here" — and it cannot be filtered by month at all, only by
-- status band, claim type and payroll run. There is no view over
-- `reimbursement_claims`, no exportable report subject, and no analytics KPI. The
-- only way to get the number was to read the rows and add them by hand.
--
-- ── "THIS MONTH" IS THREE DIFFERENT NUMBERS, AND THE DATA PROVES IT ─────────
-- A claim carries three dates that could each define its month, and the venue's own
-- three claims disagree: CLM-2026-000003 covers 26-30 AUGUST and was filed on
-- 2 SEPTEMBER. So for September 2026:
--
--     by expense period   6,148        what was spent in the month
--     by filing date     12,118        what landed on HR's desk in the month
--     by payment date         0        what actually left the bank
--
-- All three are correct answers to different questions, so the basis is a PARAMETER
-- rather than a decision buried in a WHERE clause. `period` is the default because
-- it answers "what did this month cost", which is the budget question; `paid`
-- answers the cash question and is what an accountant reconciles.
--
-- ── SUMMED BY POSTGRES, NOT BY THE BROWSER ──────────────────────────────────
-- House rule, and it earns its keep here: a tile must be the cardinality and total
-- of exactly the row set its table shows. Adding paise in JavaScript over a page of
-- 500 rows would make the total depend on the page size — which is how a tile and
-- its own detail screen start disagreeing.
--
-- SECURITY INVOKER, so `rc__admin__select` scopes it: an administrator sees their
-- own scope's money and nobody else's, and the same predicate serves the summary and
-- the table.
-- ============================================================================

SELECT set_config('app.reason',
  'a period summary for reimbursement claims: totals and status counts over a month or a year, on a choice of date basis',
  true);

/*
  Which date decides the period. A domain, not a bare text column, so a typo is a
  refusal rather than an empty result set — the worst failure here would be a total
  that silently reads zero because the basis was misspelled.
*/
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public' AND t.typname = 'claim_period_basis') THEN
    CREATE TYPE public.claim_period_basis AS ENUM ('period', 'filed', 'paid');
  END IF;
END
$do$;

COMMENT ON TYPE public.claim_period_basis IS
  'Which of a claim''s three dates places it in a month: period = when the money was spent (period_to), filed = when it was submitted (created_at), paid = when it was paid out (paid_on).';

/*
  DROPPED FIRST. `CREATE OR REPLACE FUNCTION` cannot change a return type, and adding
  `undated_count` to the OUT parameters changes the row type — 42P13. Idempotent, so the
  migration re-runs cleanly.
*/
DROP FUNCTION IF EXISTS public.reimbursement_period_summary(date, date, public.claim_period_basis);

CREATE OR REPLACE FUNCTION public.reimbursement_period_summary(
  p_from  date,
  p_to    date,
  p_basis public.claim_period_basis DEFAULT 'period')
RETURNS TABLE (
  claims            integer,
  employees         integer,
  claimed_paise     bigint,
  approved_paise    bigint,
  /* Approved money on claims that have actually been paid — the cash-out figure. */
  paid_paise        bigint,
  /* Approved and NOT yet paid: what the venue still owes. The number that matters. */
  outstanding_paise bigint,
  advance_paise     bigint,
  pending_count     integer,
  approved_count    integer,
  paid_count        integer,
  rejected_count    integer,
  /* Approved, unpaid, and attached to no payroll run — money nothing will pay. */
  unrouted_count    integer,
  /*
    Claims carrying NO expense period, which the `period` basis therefore cannot place in a
    month. Counted and surfaced rather than silently dropped: a total that quietly omits rows
    is the worst kind of wrong. Zero today; `period_to` is nullable and nothing forces it.
  */
  undated_count     integer)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- rc__admin__select decides whose money this is
SET search_path TO ''
AS $fn$
  WITH scoped AS (
    SELECT rc.*
      FROM public.reimbursement_claims rc
     WHERE CASE p_basis
             /*
               STRICT on `period_to`, deliberately, and matching the table exactly.

               An earlier draft coalesced to the filing date so an undated claim still landed
               in a month. That reads well until the table has to do the same thing: the
               client's `Filter` union has no `or`, so the register could not express the
               fallback and would have disagreed with this total. A tile that contradicts the
               list under it is worse than a tile that admits an exclusion — so both are
               strict, and `undated_count` below reports what strictness leaves out.
             */
             WHEN 'period' THEN rc.period_to
             WHEN 'filed'  THEN rc.created_at::date
             WHEN 'paid'   THEN rc.paid_on
           END BETWEEN p_from AND p_to
       /* On the paid basis an unpaid claim has no date and belongs in no month. */
       AND (p_basis <> 'paid' OR rc.paid_on IS NOT NULL)
       /* A draft is not a claim yet; nobody has asked for anything. */
       AND rc.status <> 'draft'
  )
  SELECT
    count(*)::integer,
    count(DISTINCT employee_id)::integer,
    COALESCE(sum(total_claimed_paise), 0)::bigint,
    COALESCE(sum(total_approved_paise), 0)::bigint,
    COALESCE(sum(total_approved_paise) FILTER (WHERE paid_on IS NOT NULL), 0)::bigint,
    COALESCE(sum(total_approved_paise) FILTER (
      WHERE paid_on IS NULL
        AND status IN ('approved', 'auto_approved', 'applied')), 0)::bigint,
    COALESCE(sum(advance_adjusted_paise), 0)::bigint,
    count(*) FILTER (WHERE status IN ('pending', 'in_progress', 'escalated'))::integer,
    count(*) FILTER (WHERE status IN ('approved', 'auto_approved', 'applied'))::integer,
    count(*) FILTER (WHERE paid_on IS NOT NULL)::integer,
    count(*) FILTER (WHERE status IN ('rejected', 'cancelled', 'withdrawn', 'expired', 'failed'))::integer,
    count(*) FILTER (
      WHERE paid_on IS NULL
        AND paid_via_payroll_run_id IS NULL
        AND status IN ('approved', 'auto_approved', 'applied'))::integer,
    /*
      Counted over the WHOLE table, not over `scoped` — a claim with no period is by
      definition not in any period, so it could never appear in the scoped set. This is the
      one figure on the summary that deliberately ignores the filter.
    */
    (SELECT count(*) FROM public.reimbursement_claims u
      WHERE u.period_to IS NULL AND u.status <> 'draft')::integer
  FROM scoped;
$fn$;

REVOKE ALL ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) FROM anon;
GRANT EXECUTE ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) TO authenticated;

COMMENT ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) IS
  'Totals and status counts for reimbursement claims in a period. SECURITY INVOKER so RLS scopes it. outstanding_paise is approved-and-unpaid — what the venue still owes.';

/*
  ── AND THE SAME PERIOD, BROKEN DOWN BY CLAIM TYPE ─────────────────────────
  "For what purpose" at the level a total can answer it. The per-claim purpose lives
  on `claim_lines.description`, which the table shows row by row; this is the shape
  of the month.
*/
CREATE OR REPLACE FUNCTION public.reimbursement_period_by_type(
  p_from  date,
  p_to    date,
  p_basis public.claim_period_basis DEFAULT 'period')
RETURNS TABLE (
  claim_type     text,
  claims         integer,
  claimed_paise  bigint,
  approved_paise bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $fn$
  SELECT rc.claim_type,
         count(*)::integer,
         COALESCE(sum(rc.total_claimed_paise), 0)::bigint,
         COALESCE(sum(rc.total_approved_paise), 0)::bigint
    FROM public.reimbursement_claims rc
   WHERE CASE p_basis
           WHEN 'period' THEN rc.period_to
           WHEN 'filed'  THEN rc.created_at::date
           WHEN 'paid'   THEN rc.paid_on
         END BETWEEN p_from AND p_to
     AND (p_basis <> 'paid' OR rc.paid_on IS NOT NULL)
     AND rc.status <> 'draft'
   GROUP BY rc.claim_type
   ORDER BY 3 DESC;
$fn$;

REVOKE ALL ON FUNCTION public.reimbursement_period_by_type(date, date, public.claim_period_basis) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reimbursement_period_by_type(date, date, public.claim_period_basis) FROM anon;
GRANT EXECUTE ON FUNCTION public.reimbursement_period_by_type(date, date, public.claim_period_basis) TO authenticated;
