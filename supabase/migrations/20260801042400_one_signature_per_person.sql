-- =============================================================================
-- 20260801042400 — one signature per person, not one per level
-- =============================================================================
--
-- ASKED FOR: "if employee is requesting somethins and admin/super-admin is
-- accepting then only one times approve should be, not twice so for
-- admin/super-admin only in once request should be approved".
--
-- ── WHY IT WAS ASKING TWICE ─────────────────────────────────────────────────
--
-- Every seeded chain is two levels — reporting manager, then HR admin — and
-- `resolve_approvers` falls back to the admin pool for a level it cannot fill.
-- With 79 of 81 employees having no reporting manager, BOTH levels resolve to the
-- same five administrators. So an administrator approved at level 1, the request
-- advanced to level 2, and the identical request came back to them.
--
-- `skip_if_same_as_previous` exists for exactly this and did not fire, because it
-- tested whether the level resolved to NOBODY BUT the requester and the previous
-- actor:
--
--     v_ids <@ ARRAY[subject, last_actor]
--
-- With five administrators in `v_ids` that subset test is false, every time.
--
-- ── THE CHANGE, AND WHAT IT LEAVES ALONE ────────────────────────────────────
--
-- A level is now also skipped when the person who just acted is AMONG its
-- approvers. One administrator signing once settles the chain.
--
-- A real two-stage approval is untouched: a reporting manager approving at level
-- 1 is not in the HR pool at level 2, so HR is still asked. What stops is asking
-- ONE person twice because a fallback put them on both levels — which was never a
-- second opinion, only a second click.
--
-- The flag is still per level, so a chain that genuinely wants two different
-- administrators can turn `skip_if_same_as_previous` off on its second level and
-- get the old behaviour. 045 sets it TRUE on every level it seeds, which is the
-- schema saying plainly that nobody should be asked twice.
--
-- Body copied from 042000 with that one condition widened; everything else —
-- the subject exclusion, the no-decision-no-approval guard — is unchanged.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042400: a level whose approvers include the person who just approved is skipped, so one administrator signs once', true);
SELECT set_config('app.source', 'migration', true);

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

    /*
      ONE SIGNATURE PER PERSON, NOT ONE PER LEVEL.

      The test used to be `v_ids <@ ARRAY[subject, last_actor]` — skip only when
      the level resolves to NOBODY BUT those two. With an employee who has no
      reporting manager, level 1 falls back to the admin pool and level 2 IS the
      admin pool, so `v_ids` is all five administrators: not a subset, not
      skipped, and the same administrator who just approved is asked to approve
      the identical request a second time.

      Asked for directly: "if employee is requesting something and
      admin/super-admin is accepting then only one time approve should be, not
      twice".

      So the level is also skipped when the person who just acted is AMONG its
      approvers. A genuine two-stage chain is untouched — a manager approving at
      level 1 is not in the HR pool at level 2, so HR is still asked. What stops
      is asking one person twice because a fallback landed both levels on the same
      set.
    */
    IF v_level.skip_if_same_as_previous
       AND COALESCE(array_length(v_ids, 1), 0) > 0
       AND (
         v_ids <@ ARRAY[v_req.subject_employee_id, v_last_actor]::uuid[]
         OR (v_last_actor IS NOT NULL AND v_last_actor = ANY (v_ids))
       )
    THEN
      INSERT INTO public.approval_actions
        (approval_request_id, level, actor_id, action, comment)
      VALUES
        (p_request_id, v_level.level, NULL, 'skip_level',
         'level skipped: the person who just approved is among this level''s approvers');
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
  'Move a request to its next actionable level, or settle it. Skips a level whose approvers include the person who just acted (042400), never settles a request nobody acted on (042000).';

COMMIT;
