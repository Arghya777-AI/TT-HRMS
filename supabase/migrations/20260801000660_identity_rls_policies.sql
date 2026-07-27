-- =============================================================================
-- Migration 006b — identity RLS policies (+ profiles.profile_confirmed_at)
-- Source: docs/plan/04-data-model.md §3.1, §4.3 patterns P1/P8/P9, §4.1
--         ("default deny — a table with RLS on and no matching policy returns
--         zero rows"); spec-employee E-01.3 (first-run gate).
--
-- Why this file exists: migration 004 enabled RLS on profiles, user_roles,
-- employee_role_assignments and sessions_audit and granted table privileges,
-- but created NO policies. Default-deny then makes those tables unreadable by
-- everyone — including a user reading their own profile — so the app cannot
-- resolve identity or roles at all. Migrations are forward-only and immutable,
-- so the gap is closed here rather than by editing 004.
--
-- Also adds profiles.profile_confirmed_at: the first-run wizard is gated on
-- `must_change_password OR profile_confirmed_at IS NULL`, and 004 shipped only
-- the former.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. profile_confirmed_at (first-run completion stamp)
-- -----------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_confirmed_at timestamptz;

COMMENT ON COLUMN public.profiles.profile_confirmed_at IS
  'Set when the employee completes the forced first-run flow (E-01.3). NULL '
  'means the /first-run wizard still gates every /me route.';

-- -----------------------------------------------------------------------------
-- 2. profiles — P1 self, P8 admin
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS profiles__self_read ON public.profiles;
CREATE POLICY profiles__self_read ON public.profiles
  FOR SELECT TO authenticated
  USING (id = app.ctx_actor_id());

DROP POLICY IF EXISTS profiles__admin_read ON public.profiles;
CREATE POLICY profiles__admin_read ON public.profiles
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- Self-service update. Column scope is enforced by the grant below: an
-- employee may never change their own login email (account-takeover vector) or
-- their own is_active / must_change_password flags.
DROP POLICY IF EXISTS profiles__self_update ON public.profiles;
CREATE POLICY profiles__self_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = app.ctx_actor_id())
  WITH CHECK (id = app.ctx_actor_id());

DROP POLICY IF EXISTS profiles__admin_update ON public.profiles;
CREATE POLICY profiles__admin_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

-- Row creation is handled by handle_new_user() (SECURITY DEFINER on the auth
-- trigger) and by the employee-account-create edge function. No client INSERT.

-- -----------------------------------------------------------------------------
-- 3. user_roles — self may SEE their roles; only super_admin may change them
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS user_roles__self_read ON public.user_roles;
CREATE POLICY user_roles__self_read ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = app.ctx_actor_id());

DROP POLICY IF EXISTS user_roles__admin_read ON public.user_roles;
CREATE POLICY user_roles__admin_read ON public.user_roles
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- Role grant/revoke is a step-up operation performed by an edge function; the
-- direct path is restricted to super_admin and audited with a mandatory reason
-- (user_roles is in audit.reason_required_tables).
DROP POLICY IF EXISTS user_roles__super_admin_insert ON public.user_roles;
CREATE POLICY user_roles__super_admin_insert ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (app.is_super_admin());

DROP POLICY IF EXISTS user_roles__super_admin_update ON public.user_roles;
CREATE POLICY user_roles__super_admin_update ON public.user_roles
  FOR UPDATE TO authenticated
  USING (app.is_super_admin())
  WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 4. employee_role_assignments — scoped admin grants
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS era__self_read ON public.employee_role_assignments;
CREATE POLICY era__self_read ON public.employee_role_assignments
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS era__admin_read ON public.employee_role_assignments;
CREATE POLICY era__admin_read ON public.employee_role_assignments
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS era__super_admin_write ON public.employee_role_assignments;
CREATE POLICY era__super_admin_write ON public.employee_role_assignments
  FOR ALL TO authenticated
  USING (app.is_super_admin())
  WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 5. sessions_audit — your own sign-in history; admins see all
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS sessions_audit__self_read ON public.sessions_audit;
CREATE POLICY sessions_audit__self_read ON public.sessions_audit
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS sessions_audit__admin_read ON public.sessions_audit;
CREATE POLICY sessions_audit__admin_read ON public.sessions_audit
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- Append-only: rows come from the auth hooks / edge functions (service role).

-- -----------------------------------------------------------------------------
-- 6. Column-scoped grants (the field-level half of the boundary)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- 004 granted UPDATE on every profiles column. Narrow it: the login email,
    -- activation state and the password/confirmation flags are HR/system-owned.
    REVOKE UPDATE ON public.profiles FROM authenticated;
    GRANT UPDATE (full_name, avatar_url, phone, locale, timezone)
      ON public.profiles TO authenticated;

    -- Roles are never written from the browser; the edge function holds the pen.
    REVOKE INSERT, UPDATE ON public.user_roles FROM authenticated;
    REVOKE INSERT, UPDATE ON public.employee_role_assignments FROM authenticated;
  END IF;
END $$;

COMMIT;
