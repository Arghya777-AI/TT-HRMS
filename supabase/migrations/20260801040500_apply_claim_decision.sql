-- =============================================================================
-- 20260801040500 — an approved claim actually becomes an approved claim
-- =============================================================================
--
-- THE DEFECT THIS CLOSES
--
-- `act_on_approval` (029) writes to exactly two tables: `approval_requests` and
-- `approval_actions`. Every write statement in it was read line by line to
-- confirm that — there is no `UPDATE public.reimbursement_claims` anywhere in
-- the file, no trigger, no cron, and no edge function that does it either.
--
-- So a claim could be approved by its manager, approved again by an admin, and
-- its OWN `status` stayed `'pending'` forever with `total_approved_paise` NULL.
-- Three consequences, all of them live today:
--
--   * `compute_payslip` (023, line 425) pays out only where
--     `status = 'approved' AND COALESCE(total_approved_paise,0) > 0`. Neither
--     condition could ever be true, so an approved claim was never payable.
--   * `rc__self__update` stays open while status is draft/pending — so a claim
--     that everyone had approved remained editable by the claimant, amount
--     included.
--   * a rejected claim was indistinguishable from a pending one on the
--     employee's own ledger.
--
-- The screens said so out loud rather than hiding it ("no deployed job applies a
-- settled approval to a claim"). This migration is what lets those notices go.
--
-- WHY A TRIGGER AND NOT AN RPC THE CLIENT CALLS
--
-- `decide_regularization` (056) and `decide_change_request` (120) are RPCs the
-- browser calls after the approval. That works, and it is forgettable: it lives
-- in one client path, and a decision taken through any OTHER path silently does
-- not apply. There are five such paths already — the two team/admin inboxes, the
-- reimbursements register, an ADMIN OVERRIDE, and `advance_approval` finishing a
-- chain on its own — plus `sla_sweep` escalations and auto-approval.
--
-- A trigger on the row whose status actually changed covers all of them, and
-- cannot be left out of a sixth. The client keeps its own apply step for leave;
-- claims need nothing from it.
--
-- IT IS ALSO WHY `apply_error` EXISTS. A claim row that has gone missing records
-- the failure on the request instead of aborting the approval — the approval is
-- the decision of record, and losing it because of a detail-table problem would
-- be the worse outcome.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 040500: apply a settled approval to its reimbursement claim', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. `hr_admin` must mean admin OR super_admin
-- -----------------------------------------------------------------------------
--
-- Reproduced verbatim from 029 with one branch changed, because CREATE OR
-- REPLACE has to restate the whole body. The diff is marked inline.
--
-- Why it matters here: 040600 makes `hr_admin` the second level of the claim
-- chain, and `resolve_approvers` also falls back to it when a level cannot be
-- resolved — which is EVERY claim from the 79 employees who currently have no
-- reporting manager. With the old literal `role = 'admin'`, three of this
-- deployment's five administrators (super_admin only) would never see those
-- requests in their inbox, while `act_on_approval` would still let them
-- override — authority without visibility, which is how a queue silently
-- becomes one person's problem.

CREATE OR REPLACE FUNCTION public.resolve_approver_kind(
  p_kind text,
  p_role public.app_role,
  p_specific_employee_id uuid,
  p_subject_employee_id uuid)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_subject public.employees%ROWTYPE;
  v_ids     uuid[] := '{}';
BEGIN
  SELECT * INTO v_subject FROM public.employees WHERE id = p_subject_employee_id;
  IF NOT FOUND THEN
    RETURN '{}';
  END IF;

  CASE p_kind
    WHEN 'reporting_manager' THEN
      v_ids := ARRAY(SELECT v_subject.reporting_manager_id WHERE v_subject.reporting_manager_id IS NOT NULL);
    WHEN 'dotted_line_manager' THEN
      v_ids := ARRAY(SELECT v_subject.dotted_line_manager_id WHERE v_subject.dotted_line_manager_id IS NOT NULL);
    WHEN 'skip_level_manager' THEN
      v_ids := ARRAY(
        SELECT m.reporting_manager_id FROM public.employees m
        WHERE m.id = v_subject.reporting_manager_id
          AND m.reporting_manager_id IS NOT NULL
          AND m.deleted_at IS NULL);
    WHEN 'department_head' THEN
      v_ids := ARRAY(
        SELECT d.head_employee_id FROM public.departments d
        WHERE d.id = v_subject.department_id
          AND d.head_employee_id IS NOT NULL
          AND d.deleted_at IS NULL);
    WHEN 'location_head' THEN
      -- locations carry no head column (§3.2); the location head is whoever
      -- holds a location-scoped admin assignment for the subject's location.
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.employee_role_assignments a
        JOIN public.employees e ON e.profile_id = a.profile_id AND e.deleted_at IS NULL
        WHERE a.role = 'admin'
          AND a.scope_kind = 'location'
          AND a.location_id = v_subject.location_id
          AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE));
    WHEN 'specific_employee' THEN
      v_ids := ARRAY(
        SELECT e.id FROM public.employees e
        WHERE e.id = p_specific_employee_id AND e.deleted_at IS NULL);
    WHEN 'role', 'any_of_role' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.user_roles ur
        JOIN public.employees e ON e.profile_id = ur.user_id AND e.deleted_at IS NULL
        WHERE ur.role = p_role AND ur.revoked_at IS NULL);
    WHEN 'hr_admin' THEN
      -- 040500: was `ur.role = 'admin'` literally. Since 039400 redefined
      -- app.is_super_admin() as has_role('admin'), the two roles are equivalent
      -- for every authority check — but NOT here, so a super-admin-only account
      -- could override an approval it was never shown. Widening puts the request
      -- in their inbox instead of leaving them to find it.
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.user_roles ur
        JOIN public.employees e ON e.profile_id = ur.user_id AND e.deleted_at IS NULL
        WHERE ur.role IN ('admin','super_admin') AND ur.revoked_at IS NULL);
    WHEN 'finance' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.employees e
        JOIN public.departments d ON d.id = e.department_id AND d.code = 'FIN' AND d.deleted_at IS NULL
        JOIN public.user_roles ur ON ur.user_id = e.profile_id AND ur.revoked_at IS NULL
        WHERE e.deleted_at IS NULL
          AND ur.role IN ('manager','admin','super_admin'));
    WHEN 'super_admin' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.user_roles ur
        JOIN public.employees e ON e.profile_id = ur.user_id AND e.deleted_at IS NULL
        WHERE ur.role = 'super_admin' AND ur.revoked_at IS NULL);
    ELSE
      v_ids := '{}';
  END CASE;

  RETURN COALESCE(v_ids, '{}');
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Apply the settled decision to the claim
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_claim_decision()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_found boolean;
BEGIN
  SELECT true INTO v_found
    FROM public.reimbursement_claims rc
   WHERE rc.id = NEW.detail_id;

  IF v_found IS NOT TRUE THEN
    -- Record and carry on. See the header: the approval is the decision of
    -- record and must not be lost because its detail row went missing.
    UPDATE public.approval_requests
       SET apply_error = format('no reimbursement_claims row with id %s', NEW.detail_id)
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  IF NEW.status = 'approved' THEN
    /*
      `total_approved_paise` takes the claimed figure. Partial approval is not
      offered anywhere — `request_types.allows_partial_approval` is false and
      unread — so approving means approving the amount on the bill. COALESCE
      keeps a figure an admin had already set by hand rather than overwriting it.
    */
    UPDATE public.reimbursement_claims
       SET status               = 'approved',
           total_approved_paise = COALESCE(total_approved_paise, total_claimed_paise),
           decided_by           = NEW.decided_by,
           decided_at           = COALESCE(NEW.decided_at, now()),
           decided_comment      = NEW.decision_comment
     WHERE id = NEW.detail_id;

  ELSIF NEW.status IN ('rejected', 'cancelled', 'withdrawn', 'expired') THEN
    -- Zero, not NULL: NULL reads as "nobody has decided an amount yet", which is
    -- exactly the state this is ending. The dashboard sums this column.
    UPDATE public.reimbursement_claims
       SET status               = NEW.status,
           total_approved_paise = 0,
           decided_by           = NEW.decided_by,
           decided_at           = COALESCE(NEW.decided_at, now()),
           decided_comment      = NEW.decision_comment
     WHERE id = NEW.detail_id;

  ELSE
    -- in_progress / escalated: the chain is still moving. Nothing to apply.
    RETURN NULL;
  END IF;

  -- Does not mention `status`, so this cannot re-fire the trigger below.
  UPDATE public.approval_requests
     SET applied_at = now(), apply_error = NULL
   WHERE id = NEW.id;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.apply_claim_decision() IS
  'Projects a settled approval_request onto its reimbursement_claims row. Fires from every decision path including admin override and auto-approval; records apply_error rather than aborting the approval when the claim row is missing.';

DROP TRIGGER IF EXISTS trg_ar__apply_claim ON public.approval_requests;
CREATE TRIGGER trg_ar__apply_claim
  AFTER UPDATE OF status ON public.approval_requests
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
        AND NEW.detail_table = 'reimbursement_claims')
  EXECUTE FUNCTION public.apply_claim_decision();

-- -----------------------------------------------------------------------------
-- 3. Catch up the claims already decided under the old behaviour
-- -----------------------------------------------------------------------------
--
-- Requests that reached a settled status before this trigger existed left their
-- claims sitting at `pending`. Without this, those claims stay unpayable forever
-- and the fix appears not to work for exactly the people who claimed first.

UPDATE public.reimbursement_claims rc
   SET status               = ar.status,
       total_approved_paise = CASE WHEN ar.status = 'approved'
                                   THEN COALESCE(rc.total_approved_paise, rc.total_claimed_paise)
                                   ELSE 0 END,
       decided_by           = ar.decided_by,
       decided_at           = COALESCE(ar.decided_at, ar.updated_at),
       decided_comment      = ar.decision_comment
  FROM public.approval_requests ar
 WHERE ar.detail_table = 'reimbursement_claims'
   AND ar.detail_id    = rc.id
   AND ar.status IN ('approved', 'rejected', 'cancelled', 'withdrawn', 'expired')
   AND rc.status IN ('draft', 'pending', 'in_progress', 'escalated');

UPDATE public.approval_requests ar
   SET applied_at = COALESCE(ar.applied_at, now())
 WHERE ar.detail_table = 'reimbursement_claims'
   AND ar.status IN ('approved', 'rejected', 'cancelled', 'withdrawn', 'expired')
   AND ar.applied_at IS NULL;

COMMIT;
