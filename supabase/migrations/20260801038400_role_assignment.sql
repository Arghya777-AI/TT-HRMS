-- =============================================================================
-- 089 · HR can say who is an admin, a manager or a normal user
--
-- REPORTED, two things that turn out to be the same thing:
--
--   "HR/admin can make somebody an admin, a manager, or a normal user. They should
--    have that option to select, right? Based on that, their access should be
--    updated."
--   "If they are managers, then at least they should have one reporting under them."
--
-- NEITHER WAS POSSIBLE, and the second explains a bug reported separately. There is
-- no grant_role / set_role function anywhere in the migrations — `user_roles` was
-- only ever written by the seed. The live consequence:
--
--   employee_code  roles                  reportees
--   TT0001         employee               9     <-- runs a team, not a manager
--   TT0003         employee               1     <-- runs a team, not a manager
--   TT0009         employee               1     <-- runs a team, not a manager
--
-- NOBODY held the `manager` role. That is why the assistant told ravi.kumar "as an
-- employee your access is limited to your own records" when asked for his team
-- roster — it was answering correctly about a role he did not have. The org chart
-- said he managed someone; `user_roles` said he was staff; nothing reconciled them.
--
-- So this migration does three things: gives HR the function to set a role, makes the
-- manager role impossible to hold without a reportee, and fixes the three rows above.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 089: role assignment with the manager-needs-a-reportee rule', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The rule, as a function both the guard and the UI can ask
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.has_reportees(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees r
     WHERE r.reporting_manager_id = p_employee_id AND r.deleted_at IS NULL
  );
$$;

COMMENT ON FUNCTION app.has_reportees(uuid) IS
  'Does anybody report to this employee? The manager role is meaningless without this, so both the role guard and the assignment screen ask it here rather than each counting rows their own way.';

-- -----------------------------------------------------------------------------
-- 2. A manager cannot exist without a team
-- -----------------------------------------------------------------------------

/*
  A TRIGGER, not just a check inside the setter, because the setter is not the only
  way a row can arrive — the seed writes here, an import could, and a future screen
  might. The rule is about the data, so it lives on the table.

  Only `manager` is constrained. `admin` is an HR function and has nothing to do with
  the org chart — this venue's HR person may well have no reportees, and the user was
  explicit that HR and admin are the same role. `super_admin` likewise.

  A REVOKE is never blocked. Removing a role must always be possible: the one thing
  worse than a manager with no team is being unable to take the role away.
*/
CREATE OR REPLACE FUNCTION public.user_roles_manager_needs_team()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_employee uuid;
BEGIN
  IF NEW.role <> 'manager' OR NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT e.id INTO v_employee
    FROM public.employees e
   WHERE e.profile_id = NEW.user_id AND e.deleted_at IS NULL
   LIMIT 1;

  -- No employee row at all: there is no org chart to check against, so there is
  -- nothing this rule can say. Let the other constraints handle it.
  IF v_employee IS NULL THEN RETURN NEW; END IF;

  IF NOT app.has_reportees(v_employee) THEN
    RAISE EXCEPTION
      'A manager needs at least one person reporting to them. Set someone''s reporting manager to this employee first, then grant the role.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_roles__manager_needs_team ON public.user_roles;
CREATE TRIGGER trg_user_roles__manager_needs_team
BEFORE INSERT OR UPDATE OF role, revoked_at ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.user_roles_manager_needs_team();

-- -----------------------------------------------------------------------------
-- 3. Fix the three people who were running teams as "employee"
-- -----------------------------------------------------------------------------

/*
  Runs BEFORE the setter is defined and AFTER the guard, deliberately: every row
  inserted here has reportees, so it proves the guard admits the legitimate case.

  `employee` is NOT removed. Everyone keeps it — a manager is still staff, with their
  own leave and payslip, and `app.has_cap` unions across roles.
*/
INSERT INTO public.user_roles (user_id, role, granted_by, granted_at, granted_reason)
SELECT e.profile_id,
       'manager',
       NULL,
       now(),
       'migration 089: already had direct reportees but no manager role'
  FROM public.employees e
 WHERE e.deleted_at IS NULL
   AND e.profile_id IS NOT NULL
   AND app.has_reportees(e.id)
   AND NOT EXISTS (
     SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = e.profile_id AND ur.role = 'manager' AND ur.revoked_at IS NULL
   );

-- -----------------------------------------------------------------------------
-- 4. The function HR calls
-- -----------------------------------------------------------------------------

/*
  ONE CALL SETS THE WHOLE PICTURE. `p_role` is what this person should BE, and the
  function makes that true: it grants that role and revokes any other privileged role
  in the same statement. Granting without revoking is how somebody demoted from admin
  to manager keeps admin — the commonest way a role system leaks.

  `employee` is the floor and is never revoked: a manager and an admin are both still
  staff with their own leave and payslip.

  WHO MAY CALL IT. A scoped admin, for anybody their scope covers — except that
  granting or revoking `super_admin` requires being a super_admin. An admin who could
  make themselves super_admin is not a lesser role.

  AND NOBODY MAY DEMOTE THEMSELVES. Not paternalism: an admin who accidentally
  removes their own admin role may leave a deployment with nobody able to grant it
  back. Another admin can always do it.
*/
CREATE OR REPLACE FUNCTION public.set_employee_role(
  p_employee_id uuid,
  p_role        text,             -- 'employee' | 'manager' | 'admin' | 'super_admin'
  p_reason      text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_profile uuid;
  v_actor   uuid := app.ctx_actor_id();
  v_name    text;
BEGIN
  IF p_role NOT IN ('employee', 'manager', 'admin', 'super_admin') THEN
    RAISE EXCEPTION 'Role must be employee, manager, admin or super_admin' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Changing somebody''s role needs a reason of at least 10 characters'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (app.is_admin() AND app.admin_scope_covers(p_employee_id)) THEN
    RAISE EXCEPTION 'Only an admin may set roles' USING ERRCODE = '42501';
  END IF;
  -- `app.is_super_admin()`, not a capability: there is no `platform.super_admin` row
  -- in role_capabilities, so a has_cap test here would be false for everybody and
  -- super_admin could never be granted at all.
  IF p_role = 'super_admin' AND NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin may grant super admin' USING ERRCODE = '42501';
  END IF;

  SELECT e.profile_id, e.display_name INTO v_profile, v_name
    FROM public.employees e WHERE e.id = p_employee_id AND e.deleted_at IS NULL;

  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'That employee has no login yet, so there is no role to set'
      USING ERRCODE = '22023';
  END IF;
  IF v_profile = v_actor THEN
    RAISE EXCEPTION 'You cannot change your own role. Ask another admin.' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.reason', format('role set to %s: %s', p_role, btrim(p_reason)), true);

  -- Revoke every privileged role that is not the one being granted. `employee` is
  -- the floor and survives.
  UPDATE public.user_roles
     SET revoked_at = now(), revoked_by = v_actor, revoke_reason = btrim(p_reason), updated_at = now()
   WHERE user_id = v_profile
     AND revoked_at IS NULL
     AND role <> 'employee'
     AND role::text <> p_role;

  -- Grant the target role if it is not already held. The manager guard above still
  -- applies, so this refuses for a manager with no team.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_profile AND role::text = p_role AND revoked_at IS NULL
  ) THEN
    INSERT INTO public.user_roles (user_id, role, granted_by, granted_at, granted_reason)
    VALUES (v_profile, p_role::public.app_role, v_actor, now(), btrim(p_reason));
  END IF;

  -- Everyone keeps `employee`.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_profile AND role = 'employee' AND revoked_at IS NULL
  ) THEN
    INSERT INTO public.user_roles (user_id, role, granted_by, granted_at, granted_reason)
    VALUES (v_profile, 'employee', v_actor, now(), 'baseline staff role');
  END IF;

  /*
    Tell them. A role change silently alters what somebody can see the next time they
    sign in, and being newly responsible for other people's data is exactly the thing
    a person should be told about rather than discover.
  */
  BEGIN
    INSERT INTO public.notifications
      (profile_id, employee_id, event_code, channel, status, priority, title, body, deep_link)
    VALUES (v_profile, p_employee_id, 'role.changed',
            'in_app'::public.notification_channel, 'queued'::public.notification_status, 'high',
            'Your access level changed',
            format('You are now recorded as %s. Sign out and back in for it to take effect everywhere.', p_role),
            '/me');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN p_role;
END;
$$;

COMMENT ON FUNCTION public.set_employee_role(uuid, text, text) IS
  'Set what an employee IS: grants the named role and revokes any other privileged role in the same statement, so a demotion cannot leave the old role behind. employee is the floor and is never revoked. Admin-within-scope only, super_admin requires super_admin, nobody may change their own, a 10-character reason is required, and the manager role still needs a reportee.';

REVOKE ALL ON FUNCTION public.set_employee_role(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_employee_role(uuid, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. What the screen reads
-- -----------------------------------------------------------------------------

/*
  `effective_role` is the HIGHEST role held, because that is what governs access and
  therefore what a person managing roles needs to see. The raw list is there too, so a
  leftover grant is visible rather than hidden behind the maximum.

  `manager_without_team` and `team_without_manager_role` are the two mismatches
  between the org chart and the role table. They are REPORTED, not auto-corrected: a
  role is somebody's access and it should not change because a reorganisation moved a
  reportee. Migration 089 fixed the three that existed; from here HR decides.
*/
CREATE OR REPLACE VIEW public.v_employee_roles
WITH (security_barrier = true) AS
SELECT
  e.id                                   AS employee_id,
  e.employee_code,
  e.display_name,
  d.name                                 AS department_name,
  g.name                                 AS designation,
  e.profile_id,
  (SELECT count(*) FROM public.employees r
    WHERE r.reporting_manager_id = e.id AND r.deleted_at IS NULL)::integer AS reportee_count,
  COALESCE((SELECT array_agg(ur.role::text ORDER BY ur.role::text)
              FROM public.user_roles ur
             WHERE ur.user_id = e.profile_id AND ur.revoked_at IS NULL), ARRAY[]::text[]) AS roles,
  CASE
    WHEN EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.profile_id
                  AND ur.role = 'super_admin' AND ur.revoked_at IS NULL) THEN 'super_admin'
    WHEN EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.profile_id
                  AND ur.role = 'admin' AND ur.revoked_at IS NULL) THEN 'admin'
    WHEN EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.profile_id
                  AND ur.role = 'manager' AND ur.revoked_at IS NULL) THEN 'manager'
    WHEN e.profile_id IS NULL THEN 'no_login'
    ELSE 'employee'
  END                                    AS effective_role,
  -- The two ways the org chart and the role table can disagree.
  (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.profile_id
            AND ur.role = 'manager' AND ur.revoked_at IS NULL)
   AND NOT app.has_reportees(e.id))      AS manager_without_team,
  (app.has_reportees(e.id)
   AND e.profile_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.profile_id
                    AND ur.role IN ('manager','admin','super_admin') AND ur.revoked_at IS NULL))
                                         AS team_without_manager_role,
  (app.is_admin() AND app.admin_scope_covers(e.id)) AS can_manage
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
LEFT JOIN public.designations g ON g.id = e.designation_id
WHERE e.deleted_at IS NULL
  AND (app.is_manager_of(e.id) OR (app.is_admin() AND app.admin_scope_covers(e.id)));

COMMENT ON VIEW public.v_employee_roles IS
  'Who holds which role, with their reportee count and the two mismatches between the org chart and the role table (a manager with no team, a team lead with no manager role). can_manage is admin-only.';

GRANT SELECT ON public.v_employee_roles TO authenticated;

COMMIT;
