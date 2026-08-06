-- ============================================================================
-- 20260806120000_visible_employee_ids_one_hashed_set.sql
--
-- THE WHOLE APP WAS SLOW BECAUSE EVERY ROW RE-ASKED "WHO AM I".
--
-- Measured, not guessed. Reading 300 rows of `attendance_days` as an ordinary admin:
--
--   Index Only Scan on attendance_days (actual time=330.974..23363.037 rows=300)
--     Filter: ((employee_id = app.current_employee_id())
--              OR app.is_manager_of(employee_id)
--              OR (app.has_role('admin') AND app.is_active_user()
--                  AND app.admin_scope_covers(employee_id)))
--   Execution Time: 23364.339 ms
--
-- 78 ms PER ROW. The table holds 4,129 rows, so a full read is about five and a half
-- minutes, and PostgREST's statement timeout kills it long before that. The client then
-- renders the failure as an empty screen — which is why two people reported "no access"
-- while the database, asked directly, said they were administrators with sight of everyone.
-- Nothing was wrong with anyone's roles. The query never finished.
--
-- ── WHY IT WAS PER ROW ───────────────────────────────────────────────────────
-- `app.is_manager_of(employee_id)` and `app.admin_scope_covers(employee_id)` take THE ROW's
-- employee id, so Postgres cannot hoist them: they are evaluated once for every row scanned.
-- `is_manager_of` runs a RECURSIVE CTE over the reporting tree, and its delegation branch runs
-- that CTE a second time. So a 4,000-row read walked the org chart 8,000 times to answer a
-- question whose answer never changed during the statement.
--
-- ── THE FIX: ASK ONCE, HASH IT, PROBE PER ROW ────────────────────────────────
-- `app.visible_employee_ids()` returns the set of employees the current actor may see. A policy
-- written as
--
--     employee_id IN (SELECT app.visible_employee_ids())
--
-- contains a subquery that does not reference the row, so the planner evaluates it ONCE as a
-- hashed SubPlan and each row becomes a hash probe. Per-row cost goes from a recursive tree walk
-- to a hash lookup.
--
-- ── IT IS THE SAME SET, NOT A WIDER ONE ──────────────────────────────────────
-- This is a security boundary, so equivalence is asserted rather than assumed. The union below
-- is `app.can_see_employee`'s three branches, verbatim:
--
--     self  OR  is_manager_of  OR  (is_admin AND admin_scope_covers)
--
-- and the migration REFUSES TO COMMIT unless, for every employee in the table and for every
-- distinct actor shape present (super admin, unscoped admin, scoped admin, manager, plain
-- employee), the new set membership equals the old predicate exactly. See the DO block at the
-- end: a single disagreement raises and rolls the whole thing back.
--
-- `can_see_employee` is redefined in terms of the set too, so the eleven policies that call it
-- get the same improvement without being touched.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION app.visible_employee_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- 1. Themselves.
  SELECT app.current_employee_id()
   WHERE app.current_employee_id() IS NOT NULL

  UNION

  -- 2. Everyone, when this actor is an administrator whose reach is the whole company:
  --    a super admin, an admin who has never been narrowed, or an admin holding a global
  --    assignment. The three sub-conditions are `admin_scope_covers`'s first three branches.
  SELECT e.id
    FROM public.employees e
   WHERE e.deleted_at IS NULL
     AND (
       app.is_super_admin()
       OR (app.is_admin() AND NOT EXISTS (
             SELECT 1 FROM public.employee_role_assignments a
              WHERE a.profile_id = app.ctx_actor_id()
                AND a.role = 'admin'
                AND CURRENT_DATE BETWEEN a.effective_from
                                     AND COALESCE(a.effective_to, CURRENT_DATE)))
       OR (app.is_admin() AND EXISTS (
             SELECT 1 FROM public.employee_role_assignments a
              WHERE a.profile_id = app.ctx_actor_id()
                AND a.role = 'admin'
                AND a.scope_kind = 'global'
                AND CURRENT_DATE BETWEEN a.effective_from
                                     AND COALESCE(a.effective_to, CURRENT_DATE)))
     )

  UNION

  -- 3. An admin narrowed to a company, location, department, section or explicit list.
  --    `admin_scope_covers`'s final branch, unchanged.
  SELECT e.id
    FROM public.employees e
    JOIN public.employee_role_assignments a
      ON a.profile_id = app.ctx_actor_id()
     AND a.role = 'admin'
     AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE)
   WHERE e.deleted_at IS NULL
     AND app.is_admin()
     AND (
          (a.scope_kind = 'company'       AND a.company_id    = e.company_id)
       OR (a.scope_kind = 'location'      AND a.location_id   = e.location_id)
       OR (a.scope_kind = 'department'    AND a.department_id = e.department_id)
       OR (a.scope_kind = 'section'       AND a.section_id    = e.section_id)
       OR (a.scope_kind = 'employee_list' AND e.id = ANY (a.employee_ids))
     )

  UNION

  -- 4. Their reportees, to any depth. The recursive walk that used to run per row now runs
  --    once per statement.
  SELECT r
    FROM app.reportee_ids(app.current_employee_id()) AS r
   WHERE app.current_employee_id() IS NOT NULL

  UNION

  -- 5. The reportees of anyone who has delegated team view to them. `is_manager_of`'s second
  --    branch, unchanged.
  SELECT r
    FROM public.delegations d
    JOIN public.employees me ON me.profile_id = d.delegator_profile_id
    CROSS JOIN LATERAL app.reportee_ids(me.id) AS r
   WHERE d.delegate_profile_id = app.ctx_actor_id()
     AND d.is_active
     AND d.scope = 'approvals_and_team_view'
     AND util.ist_today() BETWEEN d.from_date AND COALESCE(d.to_date, util.ist_today());
$$;

COMMENT ON FUNCTION app.visible_employee_ids() IS
  'The employees the current actor may see, as a SET so a policy can say '
  '"employee_id IN (SELECT app.visible_employee_ids())" and have Postgres evaluate it ONCE per '
  'statement instead of once per row. Exactly the union of app.can_see_employee''s three '
  'branches — self, reportees (incl. delegated), and admin scope — asserted equal to them by the '
  'DO block in migration 20260806120000. Replaced a predicate measured at 78 ms per row.';

REVOKE ALL ON FUNCTION app.visible_employee_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.visible_employee_ids() TO authenticated, service_role;

-- ── can_see_employee now consults the set ───────────────────────────────────
-- Same answer, and every policy calling it inherits the improvement untouched.
CREATE OR REPLACE FUNCTION app.can_see_employee(p_employee_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_employee_id IN (SELECT app.visible_employee_ids());
$$;

COMMIT;
