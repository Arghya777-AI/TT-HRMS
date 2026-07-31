-- =============================================================================
-- 090 · vinodmaurya0410@gmail.com becomes a super admin
--
-- WHY A MIGRATION AND NOT THE ROLES SCREEN
-- ----------------------------------------
-- Being an admin here is TWO facts, and only one of them can be written from a
-- browser at all:
--
--   1. the ROLE — `user_roles.role`, written by `public.set_employee_role`
--      (migration 089). An admin can grant `admin`; nobody but a super_admin can
--      grant `super_admin`, which is the point of the lesser role.
--   2. the SCOPE — a `public.employee_role_assignments` row, which is what
--      `app.admin_scope_covers()` looks for. Migration 006 revokes INSERT on that
--      table from `authenticated` outright and leaves only
--      `era__super_admin_write` behind, so NO session — not even a super admin's —
--      can write it. The service role or a migration is the only pen.
--
-- Skipping (2) is a documented trap in this project, not a hypothetical:
-- DEMO-ACCOUNTS.md records that the HR admin could open every admin screen and
-- see nothing but herself, because the role existed and the scope row did not.
--
-- WHAT WAS ALREADY DONE OUTSIDE THIS FILE, so the file is honest about its job:
-- the employee record TT0017 and the login were created against the live project
-- through the app's own paths — a `public.employees` insert, then `auth/v1/signup`
-- with `employee_code` metadata so `handle_new_user()` (migration 065) linked the
-- profile — and `set_employee_role` granted `admin`. This migration supplies only
-- the two things those paths cannot reach.
--
-- WHY IT DOES NOT CREATE THE LOGIN ITSELF
-- ---------------------------------------
-- `auth.users` belongs to GoTrue. A hand-built row there is how you get an
-- account that authenticates today and cannot reset its password later, because
-- the columns GoTrue expects to be non-null-and-empty drift between versions.
-- So this migration GRANTS; it never mints an identity. With no matching profile
-- it raises a NOTICE and changes nothing, which is also what keeps `db reset` on
-- a fresh database from failing on a person who has not signed up there.
--
-- RE-RUNNABLE. Every write is guarded on its own absence.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 090: grant super_admin and the global admin scope to vinodmaurya0410@gmail.com', true);
SELECT set_config('app.source', 'migration', true);

DO $$
DECLARE
  v_email    text := 'vinodmaurya0410@gmail.com';
  v_profile  uuid;
  v_employee uuid;
  v_code     text;
BEGIN
  SELECT p.id INTO v_profile
    FROM public.profiles p
   WHERE lower(p.email) = v_email;

  IF v_profile IS NULL THEN
    RAISE NOTICE
      'No profile for % — nothing granted. Create the login first (the employee-account-create edge function, or Auth > Users in the dashboard), then re-run this migration.',
      v_email;
    RETURN;
  END IF;

  SELECT e.id, e.employee_code INTO v_employee, v_code
    FROM public.employees e
   WHERE e.profile_id = v_profile AND e.deleted_at IS NULL
   LIMIT 1;

  -- ---------------------------------------------------------------------------
  -- 1. The role
  -- ---------------------------------------------------------------------------
  /*
    `employee` is the floor and survives: a super admin still has their own leave
    and payslip. The live `admin` grant IS revoked, because that is exactly what
    `set_employee_role` does when it promotes somebody — one privileged role at a
    time. Leaving both would show as a leftover grant in `v_employee_roles.roles`,
    which that column exists to expose.
  */
  UPDATE public.user_roles
     SET revoked_at    = now(),
         revoke_reason = 'migration 090: superseded by the super_admin grant',
         updated_at    = now()
   WHERE user_id = v_profile
     AND revoked_at IS NULL
     AND role IN ('admin', 'manager');

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_profile AND role = 'super_admin' AND revoked_at IS NULL
  ) THEN
    INSERT INTO public.user_roles (user_id, role, granted_by, granted_at, granted_reason)
    VALUES (v_profile, 'super_admin', NULL, now(),
            'migration 090: platform owner account, granted out of band because only a super_admin may grant super_admin');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_profile AND role = 'employee' AND revoked_at IS NULL
  ) THEN
    INSERT INTO public.user_roles (user_id, role, granted_by, granted_at, granted_reason)
    VALUES (v_profile, 'employee', NULL, now(), 'baseline staff role');
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. The scope
  -- ---------------------------------------------------------------------------
  /*
    `app.admin_scope_covers()` short-circuits on `app.is_super_admin()`, so while
    the grant above stands this row changes nothing. It is written anyway, for the
    day the role is stepped down to plain `admin`: that demotion is one UPDATE on
    `user_roles`, and without this row it would silently produce the
    every-screen-but-no-data state DEMO-ACCOUNTS.md describes. The CHECK
    `ck_era__role` admits only manager/admin, so `admin` is the correct — and only
    — value here.

    effective_from is util.ist_today() rather than the column DEFAULT: between
    00:00 and 05:29 IST the UTC calendar day is yesterday, and migration 070
    settled that authority windows are compared on the IST civil day.
  */
  IF NOT EXISTS (
    SELECT 1 FROM public.employee_role_assignments
     WHERE profile_id = v_profile
       AND role = 'admin'
       AND scope_kind = 'global'
       AND effective_to IS NULL
  ) THEN
    INSERT INTO public.employee_role_assignments
      (profile_id, role, scope_kind, effective_from)
    VALUES (v_profile, 'admin', 'global', util.ist_today());
  END IF;

  -- ---------------------------------------------------------------------------
  -- 3. Make the account usable, once
  -- ---------------------------------------------------------------------------
  /*
    The signup that created this login sent a confirmation mail, and an
    unconfirmed account cannot sign in. Confirming it here is not a shortcut past
    a security control: `employee-account-create` passes `email_confirm: true` for
    every account it mints, because in this deployment an admin hands the
    credential over rather than mailing it. Same decision, same authority.

    Guarded on IS NULL so a re-run never re-stamps a date that is already true.

    `email_confirmed_at` ONLY. `auth.users.confirmed_at` is a generated column
    (LEAST of the email and phone confirmations) and assigning to it aborts the
    statement — it follows from this write, it is not a second write.
  */
  UPDATE auth.users
     SET email_confirmed_at = now()
   WHERE id = v_profile
     AND email_confirmed_at IS NULL;

  /*
    The initial password was chosen by whoever provisioned the account, not by its
    owner, so the owner must replace it — `guards.tsx` sends a profile with
    `must_change_password` into the first-run flow, which clears the flag when the
    person completes it.

    `last_login_at IS NULL` is what makes this idempotent in the way that matters:
    re-running this migration after the owner has signed in and set their own
    password must NOT throw them back into the wizard.
  */
  UPDATE public.profiles
     SET must_change_password = true
   WHERE id = v_profile
     AND last_login_at IS NULL
     AND must_change_password = false;

  RAISE NOTICE 'super_admin + global admin scope granted to % (profile %, employee %)',
    v_email, v_profile, COALESCE(v_code, 'none linked');

  IF v_employee IS NULL THEN
    RAISE NOTICE
      'That profile has no employees row. The role is real, but `app.current_employee_id()` resolves to NULL, so the self-service screens will be empty until one is linked.';
  END IF;
END $$;

COMMIT;
