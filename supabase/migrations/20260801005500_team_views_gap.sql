-- =============================================================================
-- Migration 055 — create the two manager views the codebase already promised.
--
-- WHY THIS EXISTS
-- ---------------
-- Three migrations tell readers that managers read these views rather than the
-- base tables:
--
--   016 attendance_punches:      "Managers read v_team_punches (034), not the base."
--   034 views_attendance:        repeats the same instruction.
--   010 employee_custom_fields:  "v_team_custom_fields (037), never the base table."
--
-- Neither view was ever created. A probe of the live project returns 404 for
-- both. So the manager surface had no sanctioned way to read its team's punches
-- or custom fields, and any author following the comments would have written a
-- screen against a view that does not exist.
--
-- SECURITY POSTURE IS UNCHANGED. Both views copy the pattern of
-- v_team_employee_basic exactly: `security_barrier = true`, and an explicit
-- predicate of self OR app.is_manager_of(...) OR (admin AND scope). They expose
-- no column the caller could not already reach through a base table their RLS
-- policies admit, and they add no new privilege — they are the ALLOW-LIST, which
-- is the point: a manager gets the columns they need and nothing else.
--
-- Specifically NOT exposed on the punch view: `photo_path` (the gate capture),
-- `lat`/`lng`/`ip`/`user_agent` (device forensics), and the raw face-match
-- distances. A manager needs to know WHEN their reportee scanned, not to hold
-- their biometric telemetry — that belongs to the admin kiosk console and the
-- match-review screen.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 055: create v_team_punches and v_team_custom_fields, promised by 016/034/010 but never built', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. v_team_punches — a manager's window on their team's raw scans
-- -----------------------------------------------------------------------------
-- Voided punches are INCLUDED and flagged, never filtered out. The log is
-- append-only evidence: hiding a voided scan from a manager would let a
-- correction look like it never happened.
DROP VIEW IF EXISTS public.v_team_punches;
CREATE VIEW public.v_team_punches
WITH (security_barrier = true) AS
SELECT
  p.id,
  p.employee_id,
  e.employee_code,
  e.display_name,
  e.photo_path              AS employee_photo_path,
  d.name                    AS department_name,
  p.punched_at,
  p.ist_date,
  p.ist_time,
  -- Pre-rendered so no caller is tempted to format an instant themselves.
  to_char(p.ist_time, 'HH24:MI') AS ist_time_hm,
  p.effective_date,
  p.direction,
  p.source,
  p.kiosk_device_id,
  k.label                   AS device_label,
  p.needs_review,
  p.is_voided,
  p.void_reason,
  p.voided_at,
  -- The log's own insert time is recorded_at; punches have no created_at.
  p.recorded_at
FROM public.attendance_punches p
JOIN public.employees e ON e.id = p.employee_id
LEFT JOIN public.departments   d ON d.id = e.department_id
LEFT JOIN public.kiosk_devices k ON k.id = p.kiosk_device_id
WHERE e.deleted_at IS NULL
  AND (   p.employee_id = app.current_employee_id()
       OR app.is_manager_of(p.employee_id)
       OR (app.is_admin() AND app.admin_scope_covers(p.employee_id)) );

COMMENT ON VIEW public.v_team_punches IS
  'Manager/self allow-list over attendance_punches. Excludes capture photo, geo and device forensics by design. Voided rows are included and flagged — the log is evidence.';

GRANT SELECT ON public.v_team_punches TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. v_team_custom_fields — venue-specific fields for a manager's reportees
-- -----------------------------------------------------------------------------
-- Only definitions marked visible to managers are exposed. A field def that is
-- self-only (a private note an employee keeps) must not leak upward, so the
-- predicate is on the DEFINITION as well as the row.
DROP VIEW IF EXISTS public.v_team_custom_fields;
CREATE VIEW public.v_team_custom_fields
WITH (security_barrier = true) AS
SELECT
  v.id,
  v.employee_id,
  e.employee_code,
  e.display_name,
  v.field_def_id,
  f.code                AS field_code,
  f.label               AS field_label,
  f.field_type,
  f.section,
  v.value_text,
  v.value_number,
  v.value_date,
  v.value_boolean,
  v.updated_at
FROM public.employee_custom_field_values v
JOIN public.employee_custom_field_defs f ON f.id = v.field_def_id
JOIN public.employees e ON e.id = v.employee_id
WHERE e.deleted_at IS NULL
  AND f.is_active
  AND f.deleted_at IS NULL
  AND (
        -- Self sees all of their own fields, including the PII ones.
        v.employee_id = app.current_employee_id()
        -- A manager sees their reportees' NON-PII fields only. `is_pii` marks
        -- fields like a medical note or a personal identifier; a reporting line
        -- is not a reason to read them, and an admin console already can.
     OR (app.is_manager_of(v.employee_id) AND f.is_pii = false)
     OR (app.is_admin() AND app.admin_scope_covers(v.employee_id))
  );

COMMENT ON VIEW public.v_team_custom_fields IS
  'Manager/self allow-list over employee_custom_field_values, joined to its definition for the label and kind. Inactive definitions are hidden.';

GRANT SELECT ON public.v_team_custom_fields TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Assert both exist, so a future edit cannot quietly drop them again
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_team_punches') THEN
    v_missing := v_missing || 'v_team_punches'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_team_custom_fields') THEN
    v_missing := v_missing || 'v_team_custom_fields'::text;
  END IF;
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'migration 055 did not create: %', array_to_string(v_missing, ', ')
      USING errcode = '2F004';
  END IF;
  RAISE NOTICE 'migration 055: manager allow-list views present';
END $$;

COMMIT;
