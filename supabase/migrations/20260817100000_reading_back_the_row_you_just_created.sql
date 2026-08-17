-- =============================================================================
-- 20260817100000 — an administrator must be able to read back the row they wrote
--
-- DATED AFTER THE 6-7 AUGUST MIGRATIONS ON PURPOSE. Those create
-- `app.visible_employee_ids()` and rewrite the policies this file corrects, so a
-- number in the 0801 series would run BEFORE the function existed and fail.
-- =============================================================================
--
-- REPORTED FROM PRODUCTION: a super admin pressing "Create employee" is told
-- "You do not have permission to make this change." Nobody could create an
-- employee through the wizard at all.
--
-- ── WHAT IT LOOKED LIKE, AND WHY THAT WAS MISLEADING ────────────────────────
--
-- The error is SQLSTATE 42501, "new row violates row-level security policy for
-- table employees". That is the wording Postgres uses for a failed INSERT
-- `WITH CHECK`, so it reads as "you may not insert this". Every check of the
-- insert path came back clean:
--
--   * `employees__admin_insert` is `WITH CHECK (app.is_admin())`, permissive, to
--     `authenticated` — verified against the live catalogue, not the repo.
--   * `app.is_admin()` returns TRUE for the account, evaluated as `authenticated`
--     with the browser's own JWT claims.
--   * Every auth.users.id matches its profiles.id; every administrator is active.
--   * The column grants are satisfied (043800).
--
-- And an insert with those exact claims and that exact role SUCCEEDS — until
-- `RETURNING` is added, at which point it fails with the message above.
--
-- ── THE ACTUAL CAUSE ────────────────────────────────────────────────────────
--
-- `INSERT ... RETURNING` applies the table's SELECT policies to the row being
-- returned. PostgREST always returns (`?select=id,employee_code`), so every
-- creation from the browser is an INSERT with a RETURNING clause.
--
-- Migration 20260806120000 rewrote the read policies to a single set membership:
--
--     employees__admin_read   USING (id IN (SELECT app.visible_employee_ids()))
--     employees__manager_read USING (id IN (SELECT app.visible_employee_ids()))
--
-- and `app.visible_employee_ids()` is `SELECT e.id FROM public.employees e ...`.
-- It ENUMERATES EXISTING ROWS, and it is STABLE, so it sees the snapshot from the
-- start of the statement. The row being inserted is not in that snapshot and can
-- never be in that set. The read-back therefore always fails.
--
-- Before that migration the policy was `app.is_admin() AND app.admin_scope_covers(id)`,
-- whose first branch is `app.is_super_admin()` — a plain boolean that needs no
-- lookup, so a super admin could always read the row back. The hashed-set rewrite
-- was a performance change that quietly removed the only branch that worked on a
-- row which did not exist yet.
--
-- ── THE FIX, AND WHY IT IS SHAPED THIS WAY ──────────────────────────────────
--
-- The set membership stays: it is the fast path, and reverting it would undo the
-- work those migrations were written for. What is added is a second branch that
-- does not consult any snapshot:
--
--     OR (app.is_admin() AND created_by = app.ctx_actor_id())
--
-- `created_by` is stamped by `util.stamp_row()` in a BEFORE INSERT trigger, so it
-- is already on the row when the policy is evaluated — no subquery, no snapshot,
-- nothing that a row's own newness can defeat. It says exactly what is needed and
-- nothing wider: an administrator may read back a row they themselves just wrote.
--
-- It grants no access to anybody else's rows, and it cannot be used to widen
-- reads later: `created_by` is only ever the actor who inserted.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 044200 (20260817100000): let an administrator read back a row they just inserted, so INSERT ... RETURNING stops failing — creating an employee has been impossible since the read policies became set membership', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The employees read policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS employees__admin_read ON public.employees;
CREATE POLICY employees__admin_read ON public.employees
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT app.visible_employee_ids())
    /*
      The row that did not exist when the set was computed. See the header: this
      is what makes `INSERT ... RETURNING` work, and it is deliberately narrow —
      the actor's own insert, nothing else.
    */
    OR (app.is_admin() AND created_by = app.ctx_actor_id())
  );

/*
  The manager policy gets the same treatment. A manager does not create employees
  today, but `apply on behalf` and the onboarding flows write rows on other
  tables through the same shape, and leaving one of a matched pair unfixed is how
  this comes back wearing a different hat.
*/
DROP POLICY IF EXISTS employees__manager_read ON public.employees;
CREATE POLICY employees__manager_read ON public.employees
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT app.visible_employee_ids())
    OR (app.is_admin() AND created_by = app.ctx_actor_id())
  );

-- -----------------------------------------------------------------------------
-- 2. Prove it, here, rather than trusting the policy text
-- -----------------------------------------------------------------------------
--
-- The bug this fixes was invisible for eleven days because the read-back was
-- never exercised by anything that would fail loudly. This asserts the fix as the
-- browser experiences it: as `authenticated`, RLS applying, with RETURNING.

DO $verify$
DECLARE
  v_admin   uuid;
  v_company uuid;
  v_id      uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE 'no authenticated role here — assertion skipped';
    RETURN;
  END IF;

  SELECT p.id INTO v_admin
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.revoked_at IS NULL
   WHERE p.is_active AND ur.role IN ('admin','super_admin')
   ORDER BY p.created_at
   LIMIT 1;
  SELECT id INTO v_company FROM public.companies WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1;

  IF v_admin IS NULL OR v_company IS NULL THEN
    RAISE NOTICE 'no administrator or no company seeded — assertion skipped';
    RETURN;
  END IF;

  PERFORM set_config('app.actor_id', v_admin::text, true);

  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.employees
      (company_id, first_name, last_name, display_name, employment_status,
       employment_type, date_of_join, gender)
    VALUES (v_company, 'Migration', 'Selfcheck', 'Migration Selfcheck',
            'pre_joining', 'probation', util.ist_today(), 'male')
    RETURNING id INTO v_id;          -- <- the clause that was failing
    RAISE EXCEPTION 'UNDO_OK';       -- never keep the row
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'UNDO_OK' THEN
        RAISE EXCEPTION
          'migration 044200 (20260817100000) did not fix it: INSERT ... RETURNING still fails (% — %)',
          SQLSTATE, SQLERRM;
      END IF;
  END;
  RESET ROLE;

  RAISE NOTICE 'migration 044200 (20260817100000): an administrator can create an employee and read it back';
END $verify$;

COMMIT;
