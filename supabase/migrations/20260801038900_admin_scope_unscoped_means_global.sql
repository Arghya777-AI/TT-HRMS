-- ============================================================================
-- 20260801038900_admin_scope_unscoped_means_global.sql
--
-- AN ADMIN WITH NO SCOPE ROW COVERED NOBODY. THEY NOW COVER EVERYONE.
--
-- `app.admin_scope_covers(employee)` decided an administrator's reach from
-- `employee_role_assignments`: a `global` row, or a company/location/department/
-- section/employee_list row that matches the subject. What it never had was a
-- branch for the ordinary case of an admin with NO rows in that table at all —
-- and `EXISTS` over an empty set is false, so such an administrator covered
-- nobody.
--
-- That is the shape of every promotion the product actually performs. The Roles
-- & Permissions screen grants a role by inserting into `public.user_roles`; it
-- does not write `employee_role_assignments`, and nothing else does either. So a
-- freshly promoted admin got `app.is_admin() = true` and
-- `app.admin_scope_covers() = false` for every employee in the venue. The
-- consequences all read as "the screen is broken":
--
--   * `v_admin_employee` is `WHERE is_admin() AND admin_scope_covers(e.id)`, so
--     the Employee Directory returned ZERO rows.
--   * the face-enrolment console's employee picker is that same view — blank, so
--     there was nobody to select and the admin could not enrol anyone.
--   * `face_enrolment_requests`, and every other policy carrying the same
--     conjunct, refused writes for a subject the admin could not "cover".
--
-- Reported as: Sunil M (TT0016) was made an admin, saw blank where the employee
-- list belongs, and could not enrol other people. He has no
-- `employee_role_assignments` row; he began working only once he was ALSO made
-- super_admin, because `is_super_admin()` short-circuits the whole function.
-- Priya and Vinod were never affected — both happen to hold a `global` row — which
-- is why this looked like something specific to one person rather than the
-- default state of every future admin.
--
-- THE FIX IS THE MISSING BRANCH, NOT A WIDER GRANT. An empty scope set means
-- "this administrator has not been narrowed", not "this administrator has been
-- narrowed to nothing". Read that way the function is unchanged for everybody who
-- has a row: a location-scoped admin still sees exactly their location, and
-- deliberate narrowing keeps working. Only the un-narrowed case moves, from
-- nobody to everybody — which is also the product rule stated on 2026-07-31:
-- anything a super admin can see, an admin can see.
--
-- WHAT THIS DOES NOT TOUCH. Operations gated by `app.is_super_admin()` directly —
-- granting and revoking roles, purging biometric templates, hard-deleting an
-- employee — do not go through this function and still refuse a plain admin.
-- Widening those is a separate decision and is deliberately not taken here.
-- ============================================================================

CREATE OR REPLACE FUNCTION app.admin_scope_covers(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_super_admin()
      -- An admin who has never been narrowed. The NOT EXISTS is the whole point:
      -- it fires only when the administrator holds no live `admin` assignment at
      -- all, so it cannot widen somebody who has been scoped on purpose.
      OR (app.is_admin() AND NOT EXISTS (
            SELECT 1 FROM public.employee_role_assignments a
             WHERE a.profile_id = app.ctx_actor_id()
               AND a.role = 'admin'
               AND CURRENT_DATE BETWEEN a.effective_from
                                    AND COALESCE(a.effective_to, CURRENT_DATE)))
      OR EXISTS (SELECT 1 FROM public.employee_role_assignments a
                 WHERE a.profile_id = app.ctx_actor_id() AND a.role = 'admin'
                   AND a.scope_kind = 'global'
                   AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE))
      OR EXISTS (SELECT 1
                 FROM public.employee_role_assignments a
                 JOIN public.employees e ON e.id = p_employee_id
                 WHERE a.profile_id = app.ctx_actor_id() AND a.role = 'admin'
                   AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE)
                   AND (
                        (a.scope_kind = 'company'       AND a.company_id    = e.company_id)
                     OR (a.scope_kind = 'location'      AND a.location_id   = e.location_id)
                     OR (a.scope_kind = 'department'    AND a.department_id = e.department_id)
                     OR (a.scope_kind = 'section'       AND a.section_id    = e.section_id)
                     OR (a.scope_kind = 'employee_list' AND e.id = ANY(a.employee_ids))
                   ));
$$;

COMMENT ON FUNCTION app.admin_scope_covers(uuid) IS
  'Does the calling administrator''s scope cover this employee? Super admins cover everyone; '
  'an admin holding no live admin assignment is UNSCOPED and covers everyone (migration 038900 — '
  'an empty scope set previously covered nobody, so every promoted admin saw an empty directory); '
  'otherwise the global/company/location/department/section/employee_list rows decide.';
