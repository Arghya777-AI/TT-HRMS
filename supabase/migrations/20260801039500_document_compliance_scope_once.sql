-- ============================================================================
-- 20260801039500_document_compliance_scope_once.sql
--
-- THE COMPLIANCE TILE SAT ON "COUNTING…" BECAUSE THE VIEW TOOK SIX SECONDS.
--
-- Reported as a dashboard tile that never resolves. It was not stuck: counting
-- `v_document_compliance` took 6.4 seconds wall-clock for 390 rows, and on a page
-- of twelve tiles that reads as hung.
--
-- `EXPLAIN ANALYZE` named the cause exactly:
--
--   Index Scan on employees e_1  (actual time=101.860..101.860 rows=0 loops=26)
--     Filter: ((id = app.current_employee_id()) OR app.is_manager_of(id)
--              OR (app.has_role('admin') AND app.is_active_user()
--                  AND app.admin_scope_covers(id)))
--     Rows Removed by Filter: 78
--     Buffers: shared hit=23169
--
-- 26 loops × 78 employees = 2,028 evaluations of `app.can_see_employee()`, each of
-- which runs a recursive CTE over reporting lines (`app.reportee_ids`) plus two
-- EXISTS subqueries. Execution time 2,649 ms inside the planner, 6.4 s over the
-- wire, and 23,237 buffer hits for a view that returns 390 rows.
--
-- WHY IT RAN 2,028 TIMES. The scope filter was the OUTER `WHERE
-- app.can_see_employee(r.employee_id)`, applied AFTER the `required` CTE had
-- already produced one row per (employee × required document type). Postgres
-- cannot hoist it: the predicate takes the row's own id, so it is evaluated per
-- output row rather than per employee.
--
-- THE FIX IS TO SCOPE THE EMPLOYEES BEFORE THE FAN-OUT, not to make the predicate
-- cheaper: one evaluation per employee (78) instead of one per pair (2,028).
--
-- IT TOOK TWO ATTEMPTS, AND THE FIRST ONE IS THE LESSON. Simply moving
-- `can_see_employee` into the `required` CTE changed nothing — the re-run plan was
-- byte-identical, still `loops=26`, still 23,237 buffers. Since PG12 a plain CTE is
-- INLINED, so the planner flattened it and pushed the predicate back above the join.
-- `AS MATERIALIZED` on a `visible_employees` CTE is what actually makes it a fence.
--
-- Measured on the live project, same 390 rows before and after:
--
--   before   6.45 s wall / 2,649 ms execution / 23,237 buffers / loops=26
--   after    0.26 s wall
--
-- A 24× improvement, and the tile resolves instead of reading "Counting…".
--
-- Nothing about WHO can see WHAT changes. The predicate is identical and still
-- `app.can_see_employee()`; it simply runs at the level it was always meant to.
-- The column list, the `compliance_status` CASE arms and its 60-day
-- expiring-soon window are byte-identical to the deployed definition.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_document_compliance AS
-- `MATERIALIZED` is load-bearing and not a style choice. Since PG12 a plain CTE is
-- INLINED, and the first attempt at this fix — moving `can_see_employee` into the CTE —
-- produced a byte-identical plan: the planner flattened the CTE and pushed the predicate
-- straight back above the fan-out, still `loops=26`. MATERIALIZED is the only way to make
-- the scope filter a fence that runs once per employee before any join multiplies the rows.
WITH visible_employees AS MATERIALIZED (
  SELECT e_1.id, e_1.employment_type, e_1.department_id
  FROM public.employees e_1
  WHERE e_1.deleted_at IS NULL
    AND e_1.employment_status = ANY (ARRAY['active'::public.employment_status,
                                           'confirmed'::public.employment_status,
                                           'on_probation'::public.employment_status,
                                           'on_notice'::public.employment_status])
    AND app.can_see_employee(e_1.id)
),
required AS (
  SELECT v.id AS employee_id,
         dt_1.id AS document_type_id
  FROM visible_employees v
  JOIN public.document_types dt_1
    ON dt_1.deleted_at IS NULL
   AND dt_1.is_active
   AND (dt_1.is_required_for_onboarding
        OR (dt_1.required_for_employment_types IS NOT NULL
            AND v.employment_type = ANY (dt_1.required_for_employment_types))
        OR (dt_1.required_for_department_ids IS NOT NULL
            AND v.department_id = ANY (dt_1.required_for_department_ids)))
)
SELECT r.employee_id,
       e.employee_code,
       e.display_name,
       e.department_id,
       d.name AS department_name,
       r.document_type_id,
       dt.code AS document_type_code,
       dt.name AS document_type_name,
       dt.requires_expiry,
       doc.id AS document_id,
       doc.status AS document_status,
       doc.expiry_date,
       CASE
         WHEN doc.id IS NULL THEN 'missing'::text
         WHEN doc.expiry_date IS NOT NULL AND doc.expiry_date < util.ist_today() THEN 'expired'::text
         WHEN doc.expiry_date IS NOT NULL AND doc.expiry_date <= (util.ist_today() + 60) THEN 'expiring_soon'::text
         ELSE 'valid'::text
       END AS compliance_status
FROM required r
JOIN public.employees e ON e.id = r.employee_id
LEFT JOIN public.departments d ON d.id = e.department_id
JOIN public.document_types dt ON dt.id = r.document_type_id
LEFT JOIN LATERAL (
  SELECT dd.id, dd.status, dd.expiry_date
  FROM public.documents dd
  WHERE dd.employee_id = r.employee_id
    AND dd.document_type_id = r.document_type_id
    AND dd.deleted_at IS NULL
    AND dd.status = ANY (ARRAY['approved'::public.document_status,
                               'pending_review'::public.document_status])
  ORDER BY COALESCE(dd.expiry_date, '2099-12-31'::date) DESC, dd.uploaded_at DESC
  LIMIT 1
) doc ON true;

COMMENT ON VIEW public.v_document_compliance IS
  'One row per (employee × required document type) with the server''s compliance verdict. '
  'The caller-scope predicate runs in a MATERIALIZED visible_employees CTE (migration '
  '039500) so it is evaluated once per employee rather than once per employee-type pair. It '
  'was in the outer WHERE, which made a 390-row view take 6.4s and left the dashboard tile '
  'reading "Counting…". MATERIALIZED is load-bearing: a plain CTE is inlined and the '
  'predicate migrates straight back above the fan-out. Now 0.26s.';

COMMIT;
