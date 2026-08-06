-- ============================================================================
-- 20260806120200_every_scope_read_becomes_a_hashed_probe.sql
--
-- The same fix as 120100, applied to every remaining read policy that is a pure function of one
-- employee-id column. Twenty-four policies across twenty-one tables.
--
-- ── WHY A LOOP AND NOT TWENTY-FOUR HAND-WRITTEN STATEMENTS ───────────────────
-- The loop RE-CHECKS THE SHAPE of each policy before touching it, against the same three regexes
-- used to choose them. A hand-written list would encode my reading of each policy at the moment I
-- wrote it; this encodes the rule, so a policy that does not match — because someone has since
-- edited it, or because it carries an extra condition I did not account for — is skipped and
-- reported rather than flattened into something more permissive.
--
-- ── WHY `can_see_employee` IN A POLICY IS NOT ALREADY FIXED ──────────────────
-- Migration 120000 rewrote `app.can_see_employee` to consult the hashed set, and that helps every
-- caller that invokes it ONCE — an edge function, a SECURITY DEFINER routine. It does nothing for
-- a policy, and measurement shows why:
--
--   Filter: app.can_see_employee(employee_id)
--   Index Only Scan on leave_ledger (actual time=550.279..31163.502 rows=112)
--   Execution Time: 31175.332 ms                       -- 278 ms for each of 112 rows
--
-- Postgres cannot inline a function carrying a `SET` clause, and `can_see_employee` sets
-- `search_path`. So it stays an opaque per-row call and the set is rebuilt for every row —
-- which made that path SLOWER than before, not faster. The subquery has to be in the policy
-- text, where the planner can see it does not depend on the row:
--
--   Filter: (ANY (employee_id = (hashed SubPlan 1).col1))
--   SubPlan 1 -> rows=81 loops=1                       -- evaluated once
--
-- ── EQUIVALENCE ─────────────────────────────────────────────────────────────
-- `app.visible_employee_ids()` was proven equal to the predicate it replaces over 405
-- (actor, employee) comparisons in migration 20260806120000: 243 grants preserved, zero widened,
-- zero narrowed. Each policy here reduces to that same set membership on its own employee column,
-- so the proof carries. The counts are re-checked per table after this migration runs.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r        record;
  v_col    text;
  v_new    text;
  v_done   int := 0;
  v_skip   int := 0;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, roles, permissive
      FROM pg_policies
     WHERE schemaname = 'public'
       AND cmd = 'SELECT'
       AND (qual LIKE '%is_manager_of%'
            OR qual LIKE '%admin_scope_covers%'
            OR qual LIKE '%can_see_employee%')
     ORDER BY tablename, policyname
  LOOP
    -- The shape check. Only a predicate that is ENTIRELY one of these three forms is rewritten;
    -- anything else keeps its own logic and is counted as skipped.
    v_col := CASE
      WHEN r.qual ~ '^app\.can_see_employee\([a-z_]+\)$'
        THEN substring(r.qual from 'app\.can_see_employee\(([a-z_]+)\)')
      WHEN r.qual ~ '^app\.is_manager_of\([a-z_]+\)$'
        THEN substring(r.qual from 'app\.is_manager_of\(([a-z_]+)\)')
      WHEN r.qual ~ '^\(app\.is_admin\(\) AND app\.admin_scope_covers\([a-z_]+\)\)$'
        THEN substring(r.qual from 'admin_scope_covers\(([a-z_]+)\)')
      ELSE NULL
    END;

    IF v_col IS NULL THEN
      v_skip := v_skip + 1;
      RAISE NOTICE 'SKIPPED (unrecognised shape) %.% : %', r.tablename, r.policyname, r.qual;
      CONTINUE;
    END IF;

    -- The column must really exist on the table, or the rewrite would be nonsense.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = r.schemaname AND c.table_name = r.tablename
         AND c.column_name = v_col
    ) THEN
      v_skip := v_skip + 1;
      RAISE NOTICE 'SKIPPED (no such column %) %.%', v_col, r.tablename, r.policyname;
      CONTINUE;
    END IF;

    v_new := format(
      'CREATE POLICY %I ON %I.%I FOR SELECT TO %s USING (%I IN (SELECT app.visible_employee_ids()))',
      r.policyname, r.schemaname, r.tablename,
      array_to_string(r.roles, ', '),
      v_col);

    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE 'rewritten: %, skipped: %', v_done, v_skip;

  -- A migration that silently rewrote nothing would look like a success and change nothing.
  IF v_done = 0 THEN
    RAISE EXCEPTION 'no policies were rewritten — the shapes did not match anything';
  END IF;
END $$;

COMMIT;
