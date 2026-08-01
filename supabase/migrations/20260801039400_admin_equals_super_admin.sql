-- ============================================================================
-- 20260801039400_admin_equals_super_admin.sql
--
-- ADMIN AND SUPER ADMIN NOW HAVE IDENTICAL POWERS, BY EXPLICIT INSTRUCTION.
--
-- Asked for repeatedly and unambiguously: "please make sure super admin and admin
-- have all the same powers. I don't want to segregate between super admin and
-- admin." A previous change gave every admin the `admin.super` navigation
-- capability so the two saw the same console, and noted at the time that a handful
-- of operations were still gated in Postgres by `app.is_super_admin()` directly and
-- would keep refusing a plain admin. This closes that gap at the source.
--
-- ONE FUNCTION, NOT TWENTY POLICIES. `app.is_super_admin()` is the single predicate
-- every super-admin-only rule consults, so redefining it propagates everywhere at
-- once — RLS policies, `app.admin_scope_covers()`, `adjust_leave_balance`, template
-- purge, role grants. Editing each policy would be twenty chances to miss one, and
-- the one missed would be found by an administrator hitting a refusal nobody could
-- explain.
--
-- `app.has_role('admin')` is already true for a super admin: `app.has_role()`
-- implements the hierarchy super_admin > admin > manager > employee, so this reads
-- "any active admin, by either name".
--
-- ── WHAT THIS NOW ALLOWS AN ORDINARY ADMIN TO DO ───────────────────────────────
-- Stated plainly, because it is a real widening and nobody should discover it by
-- accident:
--
--   * grant and revoke roles, including making somebody else an admin or a super
--     admin (`user_roles__super_admin_insert` / `__update`)
--   * purge biometric templates irreversibly (`biometric.template.purge`)
--   * hard-delete an employee and purge their data
--   * debit any leave balance, and adjust more than five days
--   * see and act on EVERY employee: `admin_scope_covers()` short-circuits on this
--     predicate, so a location-scoped admin is now effectively unscoped
--   * edit pay periods and other tier-S settings
--
-- The audit trail is unchanged and still records who did each of these: the
-- capability is wider, the accountability is not weaker. `app.is_active_user()` is
-- still required, so deactivating a profile still removes everything at once.
--
-- TO REVERSE THIS, restore the body to `app.has_role('super_admin') AND
-- app.is_active_user()`. Nothing else in this migration needs undoing.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION app.is_super_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  -- `has_role('admin')` is true for BOTH admin and super_admin (the role hierarchy
  -- in app.has_role), so this is "any active administrator, by either name".
  SELECT app.has_role('admin') AND app.is_active_user()
$$;

COMMENT ON FUNCTION app.is_super_admin() IS
  'Any ACTIVE administrator — admin and super_admin are deliberately equivalent since '
  'migration 039400, by product instruction. It is the single predicate every '
  'super-admin-only rule consults, so widening it here propagates to every policy at '
  'once. Reverse by restoring app.has_role(''super_admin'').';

COMMIT;
