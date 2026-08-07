-- ============================================================================
-- 20260807090000_views_probe_the_hashed_set_too.sql
--
-- The same per-row predicate problem as the policies, in the VIEWS — and partly my own doing.
--
-- Migration 20260806120000 rewrote `app.can_see_employee` to consult the cached set, which helps
-- anything that calls it ONCE and actively hurts anything that calls it per row: Postgres cannot
-- inline a function carrying a `SET` clause, so every call rebuilds the whole set. I fixed that
-- for policies by moving the subquery into the policy text, and missed that four views call it
-- directly in their own WHERE clause, where the same thing happens.
--
-- What that costs, measured on `v_attendance_today_board` reading 79 employees:
--
--   Index Scan using idx_employees__location on employees e
--     (actual time=118.064..3189.109 rows=79)
--     Filter: (... AND app.can_see_employee(id))
--
-- 3,189 ms to filter seventy-nine rows. `pg_stat_statements` shows this view at a 4,343 ms mean
-- over 300 calls — 1,303 seconds of database time — and `v_attendance_punch_detail`, which has
-- the same predicate, at 4,567 ms over 154 calls. Those two are the command centre and the
-- per-day attendance screens, which is exactly where the ten-second waits were reported.
--
-- The fix is the one that already worked for the policies: put the subquery where the planner
-- can see it does not depend on the row, so it is evaluated once and hashed.
--
--     app.can_see_employee(e.id)   ->   e.id IN (SELECT app.visible_employee_ids())
--
-- Equivalence is not re-argued here: `app.can_see_employee` IS `p_employee_id IN (SELECT
-- app.visible_employee_ids())` since 20260806120000, so this substitution is the function's own
-- body inlined by hand — the very thing Postgres refuses to do for us because of the SET clause.
--
-- WHY A LOOP THAT CHECKS ITSELF. Each view is rewritten by substituting into its own current
-- definition, and the substitution must change something: if the pattern is not found, the
-- migration raises rather than silently leaving a view slow while reporting success.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r        record;
  v_def    text;
  v_new    text;
  v_count  int := 0;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'v'                      -- plain views only; a matview needs a rebuild
       AND pg_get_viewdef(c.oid) LIKE '%can_see_employee%'
     ORDER BY c.relname
  LOOP
    v_def := pg_get_viewdef(r.oid);

    /*
      `app.can_see_employee(X)` becomes `X IN (SELECT app.visible_employee_ids())`.

      The capture is deliberately narrow — an optionally-qualified column reference and nothing
      else — because that is the only shape present, and a greedy pattern across a view
      definition could swallow a closing bracket that belongs to something else. Anything more
      complicated is left alone and reported below.
    */
    v_new := regexp_replace(
      v_def,
      'app\.can_see_employee\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*\)',
      '\1 IN ( SELECT app.visible_employee_ids())',
      'g');

    IF v_new = v_def THEN
      RAISE EXCEPTION 'view %: can_see_employee present but not in the expected shape — not rewritten', r.relname;
    END IF;

    EXECUTE format('CREATE OR REPLACE VIEW public.%I AS %s', r.relname, v_new);
    v_count := v_count + 1;
    RAISE NOTICE 'rewritten: %', r.relname;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'no views were rewritten — the pattern matched nothing';
  END IF;
  RAISE NOTICE 'views rewritten: %', v_count;
END $$;

COMMIT;
