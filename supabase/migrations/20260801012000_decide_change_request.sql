-- =============================================================================
-- Migration 062 — public.decide_change_request: the missing server half of the
-- employee change-request (maker-checker) queue.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 011 §2 gives `employee_change_requests` a self-INSERT path
-- (`ecr__self_insert` + `GRANT SELECT, INSERT … TO authenticated`) and §3 gives
-- `apply_change_request` — which refuses anything whose status is not already
-- 'approved'. Nothing could put it there:
--
--   * `authenticated` holds SELECT + INSERT on the table and NO UPDATE
--     (011 §4; 048 re-asserts the client grant matrix and never adds one), so a
--     PATCH from an admin console is 42501 before RLS is even consulted;
--   * `act_on_approval` (029 §11) decides `approval_requests`, never the
--     `employee_change_requests` detail row behind it;
--   * so `apply_change_request` — a complete, correct, granted function — was
--     unreachable from any client. The employee could propose a field change,
--     and no one could ever accept it.
--
-- This function is that missing half, shaped exactly like `decide_regularization`
-- (056) and `apply_change_request` (011 §3):
--
--   * SECURITY DEFINER, so it can write the decision columns the caller has no
--     privilege on, then hand the row to `apply_change_request`;
--   * authorisation re-asserted INSIDE: an admin whose scope covers the subject
--     (`app.is_admin() AND app.admin_scope_covers()`), and never the subject
--     themselves — an admin editing their own record still needs a second pair
--     of eyes, which is the entire point of maker-checker;
--   * AN AUDIT REASON IS MANDATORY. `employee_change_requests` is not in
--     `audit.reason_required_tables`, so the audit trigger would happily record
--     a decision with an empty reason. This function refuses one: `app.reason`
--     (the `X-Reason` header, via `app.pgrst_pre_request`) must carry at least
--     10 characters, and the decision sentence written into `app.reason` for the
--     UPDATE names the request and quotes the decision, so `audit_log` reads as
--     evidence on its own;
--   * rejection ALSO demands a decision_comment of at least 10 characters,
--     because the employee reads that one on /me/profile/history;
--   * approval sets 'approved' and then calls `apply_change_request` in the SAME
--     transaction, so 'applied' and the new field value are one atomic fact.
--
-- TWO LIMITS IT ENFORCES RATHER THAN HIDES
-- ----------------------------------------
--  1. THE GOVERNING WORKFLOW WINS. When the employee raised the change through
--     the workflow engine (`approval_requests.detail_table =
--     'employee_change_requests'`, e.g. PROFILE_CHANGE / BANK_CHANGE), that
--     chain is the authorisation. AC-BANK-CHANGE has TWO levels (hr_admin then
--     finance, 045 §3), so letting HR apply the field here while the chain sat
--     at level 2 would forge an approval finance never gave. A request with an
--     OPEN governing chain is therefore refused here with the request number in
--     the message, and a chain that ended in anything other than approved can
--     never be applied.
--  2. `apply_change_request` CANNOT WRITE A SATELLITE KEYED ONLY ON
--     employee_id. It updates satellites with `WHERE id = $2 AND employee_id =
--     $3`, and `employee_statutory` has no `id` column at all — so a tax-regime
--     election arrives with `entity_id IS NULL` and there is nothing to update.
--     Handing such a row to the applier would mark it 'failed' with a message
--     about creating rows, which is not what happened. Instead this function
--     leaves it 'approved' with `applied_at IS NULL` and returns
--     `appliable=false`, and the console tells HR, in words, to record that one
--     field on the employee's record itself. An honest "approved, not yet
--     applied" beats a misleading "failed".
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 062: decide_change_request — approve (with apply) or reject a pending employee change request', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.decide_change_request(
  p_change_request_id uuid,
  p_decision          text,   -- 'approve' | 'reject'
  p_comment           text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r           public.employee_change_requests%ROWTYPE;
  v_after     public.employee_change_requests%ROWTYPE;
  v_gov       public.approval_requests%ROWTYPE;
  v_actor     uuid := app.ctx_actor_id();
  v_comment   text := nullif(btrim(coalesce(p_comment, '')), '');
  v_reason    text := nullif(btrim(coalesce(app.ctx('reason'), '')), '');
  v_appliable boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the deciding actor' USING errcode = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'p_decision must be approve or reject, not %', p_decision
      USING errcode = '22023';
  END IF;
  -- Every decision is audit-trailed with a reason, and the reason is the
  -- caller's own sentence — never one this function invented for them.
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'a decision needs an audit reason of at least 10 characters (send it as the X-Reason header)'
      USING errcode = '22023';
  END IF;

  SELECT * INTO r
  FROM public.employee_change_requests
  WHERE id = p_change_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'change request % not found', p_change_request_id USING errcode = 'P0002';
  END IF;

  IF NOT (app.is_admin() AND app.admin_scope_covers(r.employee_id)) THEN
    RAISE EXCEPTION 'not allowed to decide this change request' USING errcode = '42501';
  END IF;
  IF r.employee_id = app.current_employee_id() THEN
    RAISE EXCEPTION 'you cannot decide a change to your own record' USING errcode = '42501';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'change request is % — only a pending request can be decided', r.status
      USING errcode = '23514';
  END IF;

  -- The governing workflow instance, when the change was raised through one.
  SELECT * INTO v_gov
  FROM public.approval_requests
  WHERE detail_table = 'employee_change_requests'
    AND detail_id = r.id
  ORDER BY submitted_at DESC
  LIMIT 1;

  IF v_gov.id IS NOT NULL THEN
    IF v_gov.status IN ('draft', 'pending', 'in_progress', 'escalated') THEN
      RAISE EXCEPTION
        'change request % is governed by approval request % (%, level % of %) — decide that chain in the approval inbox first',
        r.id, v_gov.request_number, v_gov.status, v_gov.current_level, v_gov.total_levels
        USING errcode = '23514';
    END IF;
    IF p_decision = 'approve' AND v_gov.status NOT IN ('approved', 'auto_approved', 'applied') THEN
      RAISE EXCEPTION 'approval request % ended as % — this change cannot be applied',
        v_gov.request_number, v_gov.status USING errcode = '23514';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Reject: the comment is the point — the employee reads it on their own
  -- record history, so a one-word refusal is not acceptable.
  -- ---------------------------------------------------------------------------
  IF p_decision = 'reject' THEN
    IF v_comment IS NULL OR length(v_comment) < 10 THEN
      RAISE EXCEPTION 'rejecting needs a comment of at least 10 characters — the employee reads it'
        USING errcode = '23514';
    END IF;

    PERFORM set_config('app.reason',
      format('change request %s (%s) rejected: %s', r.id, r.field_label, v_comment), true);

    UPDATE public.employee_change_requests
       SET status = 'rejected',
           decided_by = v_actor,
           decided_at = now(),
           decision_comment = v_comment
     WHERE id = r.id;

    PERFORM set_config('app.reason', v_reason, true);

    RETURN jsonb_build_object(
      'change_request_id', r.id,
      'decision',          'rejected',
      'status',            'rejected',
      'field_label',       r.field_label,
      'entity_table',      r.entity_table,
      'appliable',         false,
      'applied',           false,
      'apply_error',       NULL);
  END IF;

  -- ---------------------------------------------------------------------------
  -- Approve: stamp the decision, then let 011 §3 hold the pen.
  -- ---------------------------------------------------------------------------
  -- What `apply_change_request` can actually write: an `employees` whitelist
  -- column, a custom-field value, or a satellite row named by entity_id.
  v_appliable := r.entity_table IN ('employees', 'employee_custom_field_values')
                 OR r.entity_id IS NOT NULL;

  PERFORM set_config('app.reason',
    format('change request %s (%s) approved: %s',
           r.id, r.field_label, coalesce(v_comment, v_reason)), true);

  UPDATE public.employee_change_requests
     SET status = 'approved',
         decided_by = v_actor,
         decided_at = now(),
         decision_comment = v_comment
   WHERE id = r.id;

  IF v_appliable THEN
    -- Same transaction: 'applied' and the new field value are one fact. The
    -- applier owns its own failure path — it records SQLERRM in apply_error and
    -- sets status='failed' rather than raising, so the row below is the truth.
    PERFORM public.apply_change_request(r.id);
  END IF;

  SELECT * INTO v_after FROM public.employee_change_requests WHERE id = r.id;

  PERFORM set_config('app.reason', v_reason, true);

  RETURN jsonb_build_object(
    'change_request_id', r.id,
    'decision',          'approved',
    'status',            v_after.status,
    'field_label',       r.field_label,
    'entity_table',      r.entity_table,
    'appliable',         v_appliable,
    'applied',           v_after.applied_at IS NOT NULL,
    'apply_error',       v_after.apply_error);
END;
$$;

REVOKE ALL ON FUNCTION public.decide_change_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_change_request(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.decide_change_request(uuid, text, text) IS
  'Approve (stamp + apply_change_request in one transaction) or reject (comment >= 10 chars) a pending employee_change_requests row. Admin-with-scope only, never the subject; X-Reason of >= 10 chars mandatory. Refuses while a governing approval_requests chain is still open, and returns appliable=false for a satellite keyed only on employee_id (employee_statutory) instead of marking it failed.';

COMMIT;
