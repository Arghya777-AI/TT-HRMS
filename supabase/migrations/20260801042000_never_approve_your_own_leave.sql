-- =============================================================================
-- 20260801042000 — a request nobody decided is not approved
-- =============================================================================
--
-- REPORTED AS "still leave is approving", and then, on being told that a manager
-- with no manager routes to the admin pool: "but manager can also apply for
-- leave.." Both sentences are about the same hole.
--
-- ── WHAT HAPPENS TODAY TO A MANAGER'S OWN LEAVE ──────────────────────────────
--
-- `resolve_approvers` never removes the SUBJECT from the set it returns. So for
-- somebody with no reporting manager who is themselves an administrator:
--
--   level 1  reporting_manager  → nobody → ladder → hr_admin → {the applicant}
--   level 2  hr_admin           → {the applicant}
--
-- `advance_approval` drops the subject only when the level resolved to MORE
-- people than just them:
--
--     IF COALESCE(array_length(v_ids, 1), 0) > 1 THEN
--       v_ids := array_remove(v_ids, v_req.subject_employee_id);
--
-- With exactly one id — theirs — that does not fire. The next branch then reads:
--
--     IF v_level.skip_if_same_as_previous AND v_ids <@ ARRAY[subject, last_actor]
--       … CONTINUE;
--
-- and `skip_if_same_as_previous` is `true` on every level 045 seeds. Both levels
-- are skipped, the loop runs out, and the function's last statement is
--
--     -- No actionable level remains: fully approved.
--     UPDATE public.approval_requests SET status = 'approved' …
--
-- So the leave is APPROVED with no human decision, no approver, and no
-- `approval_actions` row anybody signed. Worse, it is approved only on the
-- workflow side: `decideApproval`'s step 2 — the thing that writes
-- `leave_requests.status` and the ledger — runs when a person clicks Approve, and
-- nobody clicked. The employee's own screen keeps saying Pending while the
-- approval request says Approved, and no balance ever moves.
--
-- ── TWO CHANGES, AND WHY BOTH ────────────────────────────────────────────────
--
-- §1 THE SUBJECT IS NEVER AN APPROVER. Removing them inside `resolve_approvers`
-- — at every rung of the fallback ladder, not just the first — means a level that
-- collapses onto the applicant comes back EMPTY, so the ladder keeps walking and
-- finds the other administrators. On this deployment that is four people instead
-- of a silent self-approval. `act_on_approval` has always refused self-approval;
-- this makes the resolver agree with it.
--
-- §2 A SKIPPED-EVERYTHING CHAIN NO LONGER APPROVES. Even with §1, a company whose
-- only administrator is the applicant resolves to nobody at every level. That is
-- a configuration gap, and the honest outcome is a request sitting unrouted where
-- somebody can see it — not an approval nobody granted. The guard is narrow: it
-- fires only when NO human has acted on the request at any level
-- (`first_action_at IS NULL`). A chain where somebody approved level 1 and level
-- 2 legitimately skips still settles exactly as before.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
--
-- It does not give anybody a reporting manager. 79 of 81 employees still have
-- none, so most leave still lands on the admin pool — which is correct, just
-- coarse. The admin console's own screen lists who is missing one.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042000: the subject of a request can never be its approver, and a chain that skipped every level does not self-approve', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. resolve_approvers — the subject is never in the set
-- -----------------------------------------------------------------------------
--
-- Body copied from 029 with one addition: `v_ids := array_remove(v_ids,
-- p_subject_employee_id)` after each resolution, so the emptiness the ladder
-- tests for accounts for the exclusion. Everything else — the delegation
-- expansion, the STABLE/DEFINER markers, the return shape — is unchanged.

CREATE OR REPLACE FUNCTION public.resolve_approvers(
  p_chain_level_id uuid,
  p_subject_employee_id uuid,
  p_request_type_id uuid DEFAULT NULL,
  p_expand_delegations boolean DEFAULT true)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_level public.approval_chain_levels%ROWTYPE;
  v_ids   uuid[];
BEGIN
  SELECT * INTO v_level FROM public.approval_chain_levels WHERE id = p_chain_level_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval chain level % not found', p_chain_level_id;
  END IF;

  v_ids := public.resolve_approver_kind(
    v_level.approver_kind, v_level.role, v_level.specific_employee_id, p_subject_employee_id);
  -- Nobody approves their own request. Stated HERE so the ladder below sees an
  -- empty set and keeps walking, rather than stopping on a level that resolved
  -- to the one person who cannot act on it.
  v_ids := array_remove(v_ids, p_subject_employee_id);

  -- Fallback ladder: an unresolvable mandatory level lands with HR admins,
  -- then super-admins, so no request can strand ownerless.
  IF COALESCE(array_length(v_ids, 1), 0) = 0 AND NOT v_level.is_optional THEN
    v_ids := array_remove(
      public.resolve_approver_kind('hr_admin', NULL, NULL, p_subject_employee_id),
      p_subject_employee_id);
    IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
      v_ids := array_remove(
        public.resolve_approver_kind('super_admin', NULL, NULL, p_subject_employee_id),
        p_subject_employee_id);
    END IF;
  END IF;

  -- Delegation expansion (depth 1, approvals scope, active, date-covered,
  -- request-type-covered). The delegator stays in the set — they may still act.
  IF p_expand_delegations AND COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    v_ids := ARRAY(
      SELECT DISTINCT u FROM (
        SELECT unnest(v_ids) AS u
        UNION
        SELECT e2.id
        FROM public.delegations dl
        JOIN public.employees del ON del.profile_id = dl.delegator_profile_id
                                 AND del.id = ANY (v_ids)
        JOIN public.employees e2  ON e2.profile_id = dl.delegate_profile_id
                                 AND e2.deleted_at IS NULL
        WHERE dl.is_active
          AND dl.scope IN ('approvals','approvals_and_team_view')
          AND CURRENT_DATE BETWEEN dl.from_date AND COALESCE(dl.to_date, CURRENT_DATE)
          AND (dl.request_type_ids IS NULL
            OR p_request_type_id IS NULL
            OR p_request_type_id = ANY (dl.request_type_ids))
      ) s WHERE u IS NOT NULL);
    -- A delegation could hand the request back to the subject; it must not.
    v_ids := array_remove(v_ids, p_subject_employee_id);
  END IF;

  RETURN COALESCE(v_ids, '{}');
END;
$$;

COMMENT ON FUNCTION public.resolve_approvers(uuid, uuid, uuid, boolean) IS
  'Who may act on one level of one request, never including the subject — at any rung of the fallback ladder or through a delegation. Before 042000 a level that resolved to only the applicant was skipped, and a chain of such levels approved itself.';

-- -----------------------------------------------------------------------------
-- 2. advance_approval — no decision, no approval
-- -----------------------------------------------------------------------------
--
-- Body copied from 029; the only change is the final UPDATE, which now refuses
-- to settle a request that nobody has acted on. `first_action_at` is stamped by
-- `act_on_approval` on the first human decision, so its being NULL at the end of
-- the loop means every level was skipped or unresolvable.

CREATE OR REPLACE FUNCTION public.advance_approval(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req        public.approval_requests%ROWTYPE;
  v_level      public.approval_chain_levels%ROWTYPE;
  v_ids        uuid[];
  v_last_actor uuid;   -- employee id of the most recent human actor
  v_last_level integer;
BEGIN
  SELECT * INTO v_req FROM public.approval_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request % not found', p_request_id;
  END IF;
  IF v_req.status NOT IN ('pending','in_progress','escalated') THEN
    RETURN;   -- already decided; nothing to advance
  END IF;

  SELECT e.id INTO v_last_actor
  FROM public.approval_actions a
  JOIN public.employees e ON e.profile_id = a.actor_id
  WHERE a.approval_request_id = p_request_id AND a.actor_id IS NOT NULL
  ORDER BY a.acted_at DESC LIMIT 1;

  FOR v_level IN
    SELECT * FROM public.approval_chain_levels
    WHERE approval_chain_id = v_req.approval_chain_id
      AND level > v_req.current_level
    ORDER BY level
  LOOP
    v_last_level := v_level.level;

    -- notify-only levels never hold the request
    IF v_level.notify_only THEN
      CONTINUE;
    END IF;

    v_ids := public.resolve_approvers(v_level.id, v_req.subject_employee_id, v_req.request_type_id);

    -- Belt and braces: resolve_approvers excludes the subject since 042000, so
    -- this can no longer fire for that reason. Kept because a delegation chain
    -- or a hand-edited set could still contain them.
    IF COALESCE(array_length(v_ids, 1), 0) > 1 THEN
      v_ids := array_remove(v_ids, v_req.subject_employee_id);
    END IF;

    -- skip_if_same_as_previous: the level collapses onto the actor who just
    -- approved — skip it rather than ask someone to approve their own work.
    IF v_level.skip_if_same_as_previous
       AND COALESCE(array_length(v_ids, 1), 0) > 0
       AND v_ids <@ ARRAY[v_req.subject_employee_id, v_last_actor]::uuid[]
    THEN
      INSERT INTO public.approval_actions
        (approval_request_id, level, actor_id, action, comment)
      VALUES
        (p_request_id, v_level.level, NULL, 'skip_level',
         'level skipped: approver identical to requester/previous approver');
      CONTINUE;
    END IF;

    IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
      IF v_level.is_optional THEN
        CONTINUE;   -- optional level with nobody to ask
      END IF;
      -- resolve_approvers already fell back to hr_admin/super_admin; an empty
      -- set here means the instance has nobody who may act — leave the level in
      -- place so the console surfaces it.
    END IF;

    UPDATE public.approval_requests
    SET current_level        = v_level.level,
        current_approver_ids = v_ids,
        status               = CASE WHEN first_action_at IS NULL THEN 'pending'
                                    ELSE 'in_progress' END::public.approval_status
    WHERE id = p_request_id;
    RETURN;
  END LOOP;

  /*
    NO ACTIONABLE LEVEL REMAINS — AND THAT IS TWO DIFFERENT SITUATIONS.

    If somebody has acted (`first_action_at IS NOT NULL`), the chain has run its
    course and the request is approved. That is the ordinary path and it is
    unchanged.

    If NOBODY has acted, every level was skipped or resolved to nobody, and
    approving would be inventing a decision. Before 042000 that is exactly what
    happened to a manager's own leave: two levels collapsing onto the applicant
    were both skipped and the request came out Approved with no approver and no
    signed action. It now stays pending, parked on the last level with nobody
    holding it, and says so in the trail — a state an administrator can find and
    fix by assigning a reporting manager.
  */
  IF v_req.first_action_at IS NULL THEN
    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, action, comment)
    VALUES
      (p_request_id, COALESCE(v_last_level, v_req.current_level), NULL, 'skip_level',
       'not routed: every level resolved to nobody who may act on it, so this request '
       || 'is waiting for an approver rather than approved. Assign a reporting manager '
       || 'or an administrator who is not the requester.');

    UPDATE public.approval_requests
    SET current_level        = COALESCE(v_last_level, current_level),
        current_approver_ids = '{}',
        status               = 'pending'
    WHERE id = p_request_id;
    RETURN;
  END IF;

  UPDATE public.approval_requests
  SET status               = 'approved',
      decided_at           = now(),
      decided_by           = COALESCE(app.ctx_actor_id(), decided_by),
      current_approver_ids = '{}'
  WHERE id = p_request_id;
END;
$$;

COMMENT ON FUNCTION public.advance_approval(uuid) IS
  'Move a request to its next actionable level, or settle it. A request on which no human has acted is never settled as approved — before 042000 a chain whose every level collapsed onto the applicant approved itself.';

COMMIT;
