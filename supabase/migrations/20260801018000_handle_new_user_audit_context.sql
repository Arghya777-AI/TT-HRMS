-- =============================================================================
-- Migration 064 — let an employee actually be given a login.
--
-- THE BUG
-- -------
-- Eight of fifteen staff had no portal login, and `employee-account-create`
-- could not give them one. Every call failed with GoTrue's opaque
--
--     createUser: Database error creating new user
--
-- which is what GoTrue reports when a trigger on `auth.users` raises.
--
-- The trigger is `public.handle_new_user()` (migration 004 §8.1). Its last step
-- links the pre-existing HR record to the new login:
--
--     UPDATE public.employees SET profile_id = NEW.id WHERE employee_code = …
--
-- and `public.employees` is listed in `audit.reason_required_tables` (038 §57)
-- with the default `applies_to = 'update_delete'`. So that UPDATE fires
-- `audit.write_row`, which RAISES 22023 unless `app.reason` is set to at least
-- ten characters IN THE SAME TRANSACTION.
--
-- It never can be. The trigger runs inside GoTrue's OWN connection, not inside
-- the edge function's transaction, so no amount of `set_config` in
-- `employee-account-create` reaches it. The requirement was unsatisfiable and
-- the failure was total: not a race, not an edge case — no employee login could
-- ever be created through the admin API.
--
-- HOW IT HID FOR SO LONG
-- ----------------------
-- Plain `auth/v1/signup` SUCCEEDS on this project, which is why the fault looked
-- like a credentials or platform problem for a while. Signup carries no
-- `employee_code` in `raw_user_meta_data`, so `v_code` is NULL, the UPDATE is
-- skipped, and nothing touches `public.employees`. Only the ADMIN path — the one
-- that links an employee — passes the code, and only that path fails. The seven
-- profiles that already exist were created before this became reachable.
--
-- THE FIX
-- -------
-- The trigger states its own reason. This is not a workaround: the reason is
-- genuinely known and genuinely true — an account was created and the employee
-- record is being linked to it. `set_config(..., true)` is transaction-scoped, so
-- it applies to exactly this trigger's work and nothing else, and the audit row
-- it produces now carries an honest reason instead of failing.
--
-- `app.source` is set to 'system' for the same reason: the actor is the platform
-- creating an account, not a person clicking in a browser. `audit.write_row`
-- defaults it to 'web_employee' otherwise, which would be a lie in the audit
-- trail.
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- --------------------------------
--   * `audit.reason_required_tables` keeps `public.employees`. Weakening the
--     audit requirement to make one caller work would trade a real control for
--     convenience; the caller should supply a reason, and now it does.
--   * The bootstrap branch (first user becomes super_admin) is untouched.
--   * The function keeps `SECURITY DEFINER SET search_path = ''`; `set_config`
--     and `current_setting` live in pg_catalog and resolve regardless.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 064: give handle_new_user its own audit context so employee logins can be created', true);
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
  -- 22023), so without this the employee-linking step below aborts the whole
  -- auth.users insert and GoTrue answers "Database error creating new user".
  -- The reason is stated here because it is genuinely known at this point.
  PERFORM set_config('app.reason',
                     'account created via auth signup; linking the employee record',
                     true);
  PERFORM set_config('app.source', 'system', true);

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

COMMENT ON FUNCTION public.handle_new_user() IS
  'Creates the profiles row, grants the employee tier (super_admin for the first user only) and links the employees row by employee_code. Sets its own app.reason/app.source because it executes in GoTrue''s connection, where no request context exists and public.employees demands an audit reason for UPDATE — without that, creating any employee login fails with "Database error creating new user" (migration 064).';

-- The login-identity domain must be one Supabase Auth accepts. `.invalid`
-- (RFC 2606) was chosen in migration 063 precisely because it can never be
-- mistaken for a mailbox — but GoTrue rejects it outright with
-- `email_address_invalid`, so no account could be created with it either.
-- The seven existing logins all use @tamarindtree.co, so synthesised identities
-- now match that convention. They remain LOGIN IDENTITIES: mail to them is not
-- guaranteed to be deliverable, which is why these accounts get a printed
-- temporary password and are recovered by an admin reset, not by email.
UPDATE public.settings
   SET value = to_jsonb('tamarindtree.co'::text),
       description = 'Used to mint a login identity <employee_code>@<domain> for staff with no '
         || 'work or personal email. Must be a domain Supabase Auth accepts — a .invalid '
         || 'domain is rejected with email_address_invalid. These are login identities, not '
         || 'guaranteed mailboxes: such accounts get a printed temporary password and are '
         || 'recovered by an admin reset rather than by email.'
 WHERE key = 'security.login_email_domain';

COMMIT;
