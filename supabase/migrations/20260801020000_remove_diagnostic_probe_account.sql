-- =============================================================================
-- Migration 066 — remove the diagnostic account I created while debugging.
--
-- WHY THERE IS ONE TO REMOVE
-- --------------------------
-- `employee-account-create` failed for all eight staff with GoTrue's opaque
-- "Database error creating new user". Three hypotheses (a stale service key, a
-- rejected .invalid domain, the mandatory-reason check) each looked plausible
-- from the outside and each was wrong or incomplete. The decisive experiment was
-- to compare `auth/v1/signup` WITHOUT employee_code metadata against the same
-- call WITH it: the first succeeds, the second fails, which isolated the failure
-- to the `UPDATE public.employees` inside `handle_new_user()` and led to the real
-- fix (065 — an invalid `app.source` value, mine, from 064).
--
-- That experiment left one real auth user behind:
--
--     trigger.probe.delete.me@tamarindtree.co  (6ad01515-35dc-4436-a1f3-18624502800e)
--
-- It is not a person, it holds the `employee` role by default, and it is linked to
-- no employee record. Leaving it would put a fake staff member in the login list
-- and in any per-profile count, so it is deleted here rather than explained away.
--
-- The two later probes (probe2, probe3) never created a row — one failed on the
-- trigger and one on GoTrue's email rate limit — so there is nothing else to
-- clean up. Verified: exactly one profile matches '%probe%'.
--
-- WHY A MIGRATION AND NOT THE ADMIN API
-- -------------------------------------
-- Deleting an auth user needs the Auth admin API, whose key does not leave the
-- edge runtime; the copy in .secrets is stale. A migration runs as the database
-- owner and is auditable in a way an ad-hoc curl is not. The delete is
-- narrowed by BOTH id and email so it cannot match anything else, and it is a
-- no-op if the row is already gone.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 066: delete the diagnostic probe account created while debugging employee-account-create', true);
SELECT set_config('app.source', 'migration', true);

DO $cleanup$
DECLARE
  v_id      uuid := '6ad01515-35dc-4436-a1f3-18624502800e';
  v_email   text := 'trigger.probe.delete.me@tamarindtree.co';
  v_linked  integer;
BEGIN
  -- Refuse to delete if it somehow got linked to a real employee: that would
  -- mean the id is not what this migration thinks it is.
  SELECT count(*) INTO v_linked FROM public.employees WHERE profile_id = v_id;
  IF v_linked > 0 THEN
    RAISE EXCEPTION 'seed 066 aborted: % is linked to % employee row(s); not deleting', v_email, v_linked;
  END IF;

  DELETE FROM public.user_roles WHERE user_id = v_id;
  DELETE FROM auth.users WHERE id = v_id AND email = v_email;

  IF NOT FOUND THEN
    RAISE NOTICE 'seed 066: probe account already absent, nothing to do';
  ELSE
    RAISE NOTICE 'seed 066: probe account removed';
  END IF;
END
$cleanup$;

COMMIT;
