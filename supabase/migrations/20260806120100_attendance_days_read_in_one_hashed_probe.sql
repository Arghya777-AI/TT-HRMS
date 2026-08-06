-- ============================================================================
-- 20260806120100_attendance_days_read_in_one_hashed_probe.sql
--
-- The three read policies on `attendance_days` become ONE that probes a hashed set.
--
-- WHY THE FUNCTION REWRITE IN 120000 IS NOT ENOUGH ON ITS OWN. `app.can_see_employee` now
-- consults `app.visible_employee_ids()`, but these three policies do not call it — they call
-- `app.is_manager_of(employee_id)` and `app.admin_scope_covers(employee_id)` directly, and a
-- set lookup buried inside a function that is itself invoked per row is still invoked per row.
-- The subquery has to appear in the POLICY, where the planner can see that it does not depend on
-- the row and evaluate it once.
--
-- Before (300 rows, ordinary admin):
--
--   Filter: ((employee_id = app.current_employee_id()) OR app.is_manager_of(employee_id)
--            OR (app.has_role('admin') AND app.is_active_user()
--                AND app.admin_scope_covers(employee_id)))
--   Execution Time: 23364.339 ms          -- 78 ms per row
--
-- Three permissive policies collapse into one because they were OR'd anyway: a permissive policy
-- set is a disjunction, and `visible_employee_ids` is precisely that disjunction, proven equal to
-- it over 405 (actor, employee) comparisons in migration 20260806120000 — 243 grants preserved,
-- zero widened, zero narrowed.
--
-- The names are retired rather than kept, because three policies that all say the same thing
-- would invite somebody to "fix" one of them and quietly change the answer.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS attendance_days__self_read    ON public.attendance_days;
DROP POLICY IF EXISTS attendance_days__manager_read ON public.attendance_days;
DROP POLICY IF EXISTS attendance_days__admin_read   ON public.attendance_days;

CREATE POLICY attendance_days__scope_read ON public.attendance_days
  FOR SELECT
  USING (employee_id IN (SELECT app.visible_employee_ids()));

COMMENT ON POLICY attendance_days__scope_read ON public.attendance_days IS
  'Self, reportees (including delegated) and admin scope, as one hashed set probe instead of a '
  'recursive tree walk per row. Replaced three OR-ed policies measured together at 78 ms per row, '
  'which made a full read of this table exceed the statement timeout — the client rendered that '
  'as "no access". Equivalence to the three it replaces is asserted in migration 20260806120000.';

COMMIT;
