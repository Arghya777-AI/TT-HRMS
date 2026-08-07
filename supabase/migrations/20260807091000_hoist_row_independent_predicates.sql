-- ============================================================================
-- 20260807091000_hoist_row_independent_predicates.sql
--
-- "Am I an admin?" was being asked once per ROW.
--
-- `system_health` holds 20,075 rows and its read policy is simply `app.is_admin()` — a question
-- with no reference to any row in it. Postgres evaluated it 20,075 times:
--
--   Seq Scan on system_health
--     Filter: (app.has_role('admin'::app_role) AND app.is_active_user())
--   Execution Time: 4258.305 ms
--
-- The filter shows why. `app.is_admin()` is a plain SQL function so it inlines, but the two it
-- calls — `has_role` and `is_active_user` — carry `SET search_path`, and a function with a SET
-- clause cannot be inlined. They stay opaque per-row calls, and no amount of STABLE marking
-- makes the planner collapse them.
--
-- Wrapping the call in a scalar subquery does. `(SELECT app.is_admin())` is an uncorrelated
-- subquery, so it becomes an InitPlan evaluated ONCE for the whole statement, and every row
-- after that compares against a constant.
--
-- ── IT CANNOT CHANGE AN ANSWER ───────────────────────────────────────────────
-- Only NO-ARGUMENT helpers are rewritten. `(SELECT f())` and `f()` are the same value for a
-- function that takes nothing and reads nothing but the session — there is no row for the
-- result to depend on. Anything taking an argument (`admin_scope_covers(employee_id)`,
-- `is_manager_of(employee_id)`) is left alone: those are genuinely per-row and were handled by
-- migrations 20260806120100 and 20260806120200 by moving the set into the policy instead.
--
-- ── WHY IT ALSO HELPS THE SELF-SERVICE POLICIES ──────────────────────────────
-- `(employee_id = app.current_employee_id())` reads as a column filter but the planner cannot
-- use an index for it while the right-hand side is an opaque function call it must re-evaluate.
-- As `(employee_id = (SELECT app.current_employee_id()))` the right side is a constant, which
-- makes the existing employee-id indexes usable.
--
-- ── THE LOOP CHECKS ITSELF ───────────────────────────────────────────────────
-- Each policy is rebuilt from its own current definition, and the substitution must change the
-- text. A policy already carrying `(SELECT` is skipped; a policy that matches nothing is left
-- exactly as it was and counted, so this can be re-run safely and cannot quietly do nothing.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r          record;
  v_qual     text;
  v_check    text;
  v_done     int := 0;
  v_skipped  int := 0;
  -- Only these. Every one takes no argument and reads only the session.
  v_fns      text[] := ARRAY[
    'is_admin', 'is_super_admin', 'is_active_user', 'current_employee_id', 'ctx_actor_id'
  ];
  v_fn       text;
BEGIN
  FOR r IN
    SELECT p.schemaname, p.tablename, p.policyname, p.cmd, p.qual, p.with_check,
           p.permissive, p.roles
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND (coalesce(p.qual, '') LIKE '%app.%' OR coalesce(p.with_check, '') LIKE '%app.%')
     ORDER BY p.tablename, p.policyname
  LOOP
    v_qual  := r.qual;
    v_check := r.with_check;

    FOREACH v_fn IN ARRAY v_fns LOOP
      -- `(?<!\(SELECT )` is not available here, so the already-wrapped form is protected by
      -- rewriting only calls NOT immediately preceded by "SELECT ".
      IF v_qual IS NOT NULL THEN
        v_qual := regexp_replace(v_qual,
          '([^ ]|^)app\.' || v_fn || '\(\)',
          '\1( SELECT app.' || v_fn || '())', 'g');
        v_qual := replace(v_qual, '( SELECT ( SELECT', '( SELECT');
      END IF;
      IF v_check IS NOT NULL THEN
        v_check := regexp_replace(v_check,
          '([^ ]|^)app\.' || v_fn || '\(\)',
          '\1( SELECT app.' || v_fn || '())', 'g');
        v_check := replace(v_check, '( SELECT ( SELECT', '( SELECT');
      END IF;
    END LOOP;

    -- Nothing to do, or it was already hoisted by an earlier run.
    IF v_qual IS NOT DISTINCT FROM r.qual AND v_check IS NOT DISTINCT FROM r.with_check THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s %s %s',
      r.policyname, r.schemaname, r.tablename,
      CASE WHEN r.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE r.cmd WHEN 'ALL' THEN 'ALL' ELSE r.cmd END,
      array_to_string(r.roles, ', '),
      CASE WHEN v_qual  IS NULL THEN '' ELSE 'USING (' || v_qual || ')' END,
      CASE WHEN v_check IS NULL THEN '' ELSE 'WITH CHECK (' || v_check || ')' END
    );
    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE 'policies hoisted: %, already fine or not applicable: %', v_done, v_skipped;
  IF v_done = 0 THEN
    RAISE EXCEPTION 'nothing was rewritten — the patterns matched no policy';
  END IF;
END $$;

COMMIT;
