-- =============================================================================
-- Migration 065 — correct migration 064's actor_source value.
--
-- MY BUG, ONE MIGRATION OLD
-- -------------------------
-- 064 gave `handle_new_user()` its own audit context so that linking an employee
-- record could satisfy the mandatory-reason check. The reason was right; the
-- SOURCE was not:
--
--     PERFORM set_config('app.source', 'system', true);   -- ← invalid
--
-- `audit.write_row` casts that value to `public.actor_source`, whose members are
--
--     web_employee | web_manager | web_admin | kiosk | edge_function
--     cron | import | ai_agent | service_role | migration
--
-- There is no 'system'. So the cast raised, and instead of fixing account
-- creation, 064 moved the failure from "no reason" to "invalid enum" — and made
-- it worse, because the bad source affected EVERY audited write in the trigger,
-- not just the employees UPDATE. The symptom was identical from outside
-- ("Database error creating new user"), which is exactly why an opaque error at
-- a trust boundary is expensive.
--
-- `service_role` is the truthful member: the account is being created through the
-- Auth admin API by the service role, not by a person in a browser. `auth/v1/signup`
-- reaches this same trigger, and `service_role` slightly overstates that case —
-- but the alternative, leaving `web_employee` to be inferred by default, would
-- attribute the write to a browser session that does not exist. Naming the
-- machine is the lesser inaccuracy, and the reason string distinguishes them.
--
-- VERIFIED BEFORE WRITING THIS, so it is not a third guess:
--   * `auth/v1/signup` WITHOUT employee_code metadata SUCCEEDS — no employees
--     UPDATE, so no reason is demanded.
--   * `auth/v1/signup` WITH employee_code metadata FAILS with "Database error
--     saving new user" — it runs the UPDATE.
--   * The only trigger on public.employees is trg_employees__audit, so
--     audit.write_row is the sole raiser.
--   * public.employees IS in audit.reason_required_tables (applies_to defaults
--     to 'update_delete', so an UPDATE needs the reason and an INSERT does not).
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 065: correct the actor_source set by handle_new_user (system is not a member of actor_source)', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_full_name text := COALESCE(
                        NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
                        split_part(NEW.email, '@', 1));
  v_code      text := NULLIF(btrim(NEW.raw_user_meta_data ->> 'employee_code'), '');
BEGIN
  -- This trigger runs in GoTrue's connection, which carries no request context.
  -- `public.employees` requires an audit reason for UPDATE (audit.write_row →
  -- 22023), so without a reason the employee-linking step below aborts the whole
  -- auth.users insert and GoTrue answers "Database error creating new user".
  --
  -- `app.source` MUST be a member of public.actor_source — 'system' is not one,
  -- and supplying it raised an invalid-enum error for every audited write here
  -- (migration 064's bug, fixed in 065). 'service_role' is the honest member for
  -- an account minted through the Auth admin API.
  PERFORM set_config('app.reason',
                     'account created via auth signup; linking the employee record',
                     true);
  PERFORM set_config('app.source', 'service_role', true);

  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, lower(NEW.email), v_full_name)
  ON CONFLICT (id) DO NOTHING;

  -- The FIRST user in a fresh database becomes super_admin (audited, reasoned).
  -- No hard-coded email — the reference repo's pattern is explicitly rejected.
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    INSERT INTO public.user_roles (user_id, role, granted_by, granted_reason)
    VALUES (NEW.id, 'super_admin', NULL, 'bootstrap: first user');
  END IF;

  -- Everyone gets the employee tier.
  INSERT INTO public.user_roles (user_id, role, granted_reason)
  VALUES (NEW.id, 'employee', 'default: account created via auth signup')
  ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING;

  -- Link a pre-created employees row by employee_code (employees is built in 008).
  IF v_code IS NOT NULL AND to_regclass('public.employees') IS NOT NULL THEN
    UPDATE public.employees
       SET profile_id = NEW.id
     WHERE employee_code = v_code
       AND profile_id IS NULL
       AND deleted_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

COMMIT;
