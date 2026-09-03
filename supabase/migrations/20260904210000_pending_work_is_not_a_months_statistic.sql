-- ============================================================================
-- Work awaiting a decision belongs to nobody's month.
--
-- ── WHAT WENT WRONG ────────────────────────────────────────────────────────
-- Reported as "pending bills are not showing". They were not, and the totals were
-- right — the design was wrong.
--
-- The one pending claim, CLM-2026-000003 for 5,970, has an expense period ending
-- 30 AUGUST and was filed on 2 SEPTEMBER. The page opens on the current month
-- counted by expense period, so the claim sits in August by that basis and the
-- default view legitimately excluded it. Pending read 0 while a claim sat waiting
-- for somebody to approve it.
--
-- Every figure was correct and the screen was still useless for the thing an
-- administrator opens it to do.
--
-- ── THE RULE THIS ESTABLISHES ──────────────────────────────────────────────
-- A total is a question about a PERIOD: what did September cost. A queue is a
-- question about NOW: what is waiting on me. Filtering the second by the first
-- hides work, and it hides it silently — the count reads zero rather than saying
-- "not in this month".
--
-- So `pending_anywhere` ignores the period entirely, exactly as `undated_count`
-- already does, and the page reads its Pending tile from it. Nothing waiting for a
-- decision can be hidden by a date filter again.
-- ============================================================================

SELECT set_config('app.reason',
  'the reimbursement summary counts pending claims regardless of period: a claim awaiting a decision was invisible when its expense period fell in a different month from the one being viewed',
  true);

/*
  DROPPED FIRST: adding an OUT parameter changes the row type, and
  `CREATE OR REPLACE FUNCTION` cannot (42P13). Idempotent.
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
  paid_paise        bigint,
  outstanding_paise bigint,
  advance_paise     bigint,
  pending_count     integer,
  approved_count    integer,
  paid_count        integer,
  rejected_count    integer,
  unrouted_count    integer,
  undated_count     integer,
  /*
    ── THE TWO FIGURES THAT IGNORE THE PERIOD, AND WHY ──────────────────────
    A queue is not a period metric. These count every claim still awaiting a decision
    and the money in them, whatever month their expense period or filing date falls
    in, so nothing waiting on an administrator can be hidden by a date filter.

    `pending_count` above is deliberately kept as the in-period figure — a month's
    report still needs to say how much of THAT month is undecided. The page shows
    this one on its Pending tile and the other in the month's own breakdown.
  */
  pending_anywhere        integer,
  pending_anywhere_paise  bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $fn$
  WITH scoped AS (
    SELECT rc.*
      FROM public.reimbursement_claims rc
     WHERE CASE p_basis
             WHEN 'period' THEN rc.period_to
             WHEN 'filed'  THEN rc.created_at::date
             WHEN 'paid'   THEN rc.paid_on
           END BETWEEN p_from AND p_to
       AND (p_basis <> 'paid' OR rc.paid_on IS NOT NULL)
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
    (SELECT count(*) FROM public.reimbursement_claims u
      WHERE u.period_to IS NULL AND u.status <> 'draft')::integer,
    /* Unscoped, on purpose — see the note on the OUT parameters. */
    (SELECT count(*) FROM public.reimbursement_claims w
      WHERE w.status IN ('pending', 'in_progress', 'escalated'))::integer,
    (SELECT COALESCE(sum(w.total_claimed_paise), 0) FROM public.reimbursement_claims w
      WHERE w.status IN ('pending', 'in_progress', 'escalated'))::bigint
  FROM scoped;
$fn$;

REVOKE ALL ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) FROM anon;
GRANT EXECUTE ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) TO authenticated;

COMMENT ON FUNCTION public.reimbursement_period_summary(date, date, public.claim_period_basis) IS
  'Totals and status counts for reimbursement claims in a period. SECURITY INVOKER so RLS scopes it. pending_anywhere and undated_count deliberately ignore the period: a claim awaiting a decision is a queue, not a month''s statistic, and must not be hidden by a date filter.';
