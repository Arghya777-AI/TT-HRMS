-- =============================================================================
-- 077 · v_team_punches — project lat, lng and location_accuracy_m
--
-- WHY
--
-- A manager opening a reportee's punch list could see the time, the gate and the
-- method, but not WHERE the scan happened — while the admin punch log, reading a
-- different view over the same table, could. Same underlying rows, two different
-- answers to "where was this person", depending on which screen you opened.
--
-- That asymmetry is the wrong way round for the manager use case: the person most
-- likely to be asked "was my punch recorded from the right place?" by an employee
-- is their own manager, and they were the one screen that could not answer.
--
-- WHAT IS PRESERVED
--
--   * `security_barrier = true`, matching the existing view. The row predicate —
--     self OR manager-of OR admin-with-scope — is unchanged and is what confines
--     a manager to their own reportees. This migration adds three columns to the
--     projection and touches no part of the WHERE clause.
--   * Columns are APPENDED. `CREATE OR REPLACE VIEW` cannot reorder or rename an
--     existing column, so lat/lng/accuracy land after `recorded_at` rather than
--     beside the gate. Order is not part of the contract — PostgREST returns an
--     object and Zod reads it by name.
--
-- ACCURACY TRAVELS WITH THE COORDINATE, ALWAYS. Projecting lat and lng without
-- location_accuracy_m would let a manager read six decimal places as a precise
-- position when the reading may have been a kilometres-wide network estimate. The
-- client type (`PunchLocationColumns`) makes the accuracy field REQUIRED for
-- exactly this reason, so a view that exposed only the coordinate pair would fail
-- to compile against the component that renders it.
-- =============================================================================

SELECT set_config('app.reason', 'migration', true);

CREATE OR REPLACE VIEW public.v_team_punches
WITH (security_barrier = true) AS
SELECT
  p.id,
  p.employee_id,
  e.employee_code,
  e.display_name,
  e.photo_path AS employee_photo_path,
  d.name AS department_name,
  p.punched_at,
  p.ist_date,
  p.ist_time,
  to_char(p.ist_time::interval, 'HH24:MI'::text) AS ist_time_hm,
  p.effective_date,
  p.direction,
  p.source,
  p.kiosk_device_id,
  k.label AS device_label,
  p.needs_review,
  p.is_voided,
  p.void_reason,
  p.voided_at,
  p.recorded_at,
  -- APPENDED (see header). The three travel together, by design.
  p.lat,
  p.lng,
  p.location_accuracy_m
FROM public.attendance_punches p
  JOIN public.employees e ON e.id = p.employee_id
  LEFT JOIN public.departments d ON d.id = e.department_id
  LEFT JOIN public.kiosk_devices k ON k.id = p.kiosk_device_id
WHERE e.deleted_at IS NULL
  AND (
    p.employee_id = app.current_employee_id()
    OR app.is_manager_of(p.employee_id)
    OR (app.is_admin() AND app.admin_scope_covers(p.employee_id))
  );

COMMENT ON VIEW public.v_team_punches IS
  'Reportee punch list for the team screens. Row scope: self OR manager-of OR admin-within-scope. lat/lng/location_accuracy_m are projected last (CREATE OR REPLACE VIEW can only append); accuracy is NULL when the device reported none, which is not the same as an accurate fix.';
