-- =============================================================================
-- Migration 063 — the setting `employee-account-create` has been waiting for.
--
-- THE PROBLEM
-- -----------
-- Eight of fifteen employees cannot sign in at all, because only seven have a
-- profile. `employee-account-create` refuses to create the rest: Supabase Auth
-- needs an email address, six of those employees have neither work_email nor
-- personal_email, and the function correctly 422s with LOGIN_EMAIL_REQUIRED
-- rather than fabricating a domain. Its own header names the missing piece:
--
--     "Until a `security.login_email_domain` setting exists, this function
--      requires an address it can use and says so in the 422 rather than
--      fabricating a domain."
--
-- That was the right call by the author. This migration supplies the setting so
-- the fallback becomes a deliberate, configured decision instead of a guess.
--
-- WHY `.invalid` AND NOT tamarindtree.co
-- -------------------------------------
-- The venue does not own a mail domain yet. Minting logins at a real domain
-- would create identities that LOOK like mailboxes, and the first time someone
-- provisions real mail on that domain those synthetic addresses would collide
-- with actual people. `.invalid` is reserved by RFC 2606 §2 precisely so that a
-- name can never resolve: it is unambiguous to every reader and every mail
-- server that this is a LOGIN IDENTITY, not an address.
--
-- Consequences, stated plainly:
--   * A staff member whose login is <code>@staff.tamarindtree.invalid can never
--     receive a password-reset email. That is why `employee-account-create`
--     issues a printed temporary password with must_change_password = true, and
--     why an admin reset is the recovery path for these accounts.
--   * The moment the venue owns a domain, set this to it and put real addresses
--     on the employee records. Existing synthetic logins can then be migrated;
--     the employee_code stays the stable identity throughout.
--   * Anyone WITH a real work_email or personal_email keeps using it — the
--     function only falls back to this domain when there is nothing on record.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 063: configure the login-identity domain so staff without email can be given accounts', true);
SELECT set_config('app.source', 'migration', true);

INSERT INTO public.settings
  (company_id, key, value, value_kind, scope, label, description, group_name,
   is_sensitive, is_editable_by_admin)
SELECT c.id,
       'security.login_email_domain',
       to_jsonb('staff.tamarindtree.invalid'::text),
       'string',
       'global',
       'Login identity domain',
       'Used to mint a login identity <employee_code>@<domain> for staff with no '
         || 'work or personal email. RFC 2606 reserves .invalid so these can never be '
         || 'mistaken for mailboxes — such accounts cannot receive password-reset mail '
         || 'and are recovered by an admin reset. Change this to the real domain once '
         || 'the venue owns one.',
       'security',
       false,
       true
  FROM public.companies c
 ORDER BY c.created_at
 LIMIT 1
ON CONFLICT DO NOTHING;

COMMIT;
