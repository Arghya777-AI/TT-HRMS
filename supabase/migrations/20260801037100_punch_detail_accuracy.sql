-- =============================================================================
-- 076 · v_attendance_punch_detail — project location_accuracy_m
--
-- WHY THIS EXISTS
--
-- `attendance_punches.location_accuracy_m` has been WRITTEN since the kiosk and
-- web punch paths started sending coordinates (49 rows carry it today), but the
-- view every punch screen reads never projected it. So the number existed in the
-- table and was unreachable from the UI: the drill-down could say WHERE a punch
-- happened but not HOW SURE the device was, and "12.925761, 77.594600" reads as
-- surveyed truth when it may be a 2 km cell-tower guess.
--
-- A coordinate without its accuracy is the one presentation of location data
-- that is actively misleading, because the false precision is in the digits
-- themselves. Six decimal places look like millimetres.
--
-- THE COLUMN GOES LAST, AND THAT IS FORCED
--
-- `CREATE OR REPLACE VIEW` may only APPEND columns — renaming or reordering an
-- existing one fails with "cannot change name of view column". `location_accuracy_m`
-- therefore lands after `recorded_at` rather than beside `lat`/`lng` where it
-- belongs logically. Column order is not part of this view's contract: PostgREST
-- returns a JSON object and the Zod schema reads it by name.
--
-- WHAT IS PRESERVED, DELIBERATELY
--
--   * `security_barrier = true`, NOT security_invoker. This view is
--     OWNER-EXECUTED on purpose: managers hold no base policy on
--     attendance_punches, so the row scope is the `app.can_see_employee(...)`
--     predicate in the final WHERE. Recreating it as security_invoker would
--     leave managers seeing nothing at all. Migration 003400 says so at line 111
--     and this migration changes none of it.
--   * The `ordered` CTE keeps `p.*`, so the column was already flowing to the
--     outer query — this is a projection fix, not a data-path change.
--   * Grants survive `CREATE OR REPLACE` untouched.
--
-- NOT TOUCHED: `geofence_ok` stays in the view. The verdict is no longer drawn in
-- the UI (the client asked for the actual place instead of an inside/outside
-- badge), but dropping a column would be a breaking change to a published
-- contract for a purely cosmetic reason, and the flag is still written by the
-- punch functions and read by the abuse report.
-- =============================================================================

SELECT set_config('app.reason', 'migration', true);

CREATE OR REPLACE VIEW public.v_attendance_punch_detail
WITH (security_barrier = true) AS
WITH ordered AS (
  SELECT
    p.*,
    row_number() OVER w                          AS rn_asc,
    row_number() OVER w_desc                     AS rn_desc,
    count(*)    OVER (PARTITION BY p.employee_id, p.effective_date) AS day_punch_count
  FROM public.attendance_punches p
  WHERE NOT p.is_voided
  WINDOW w      AS (PARTITION BY p.employee_id, p.effective_date ORDER BY p.punched_at),
         w_desc AS (PARTITION BY p.employee_id, p.effective_date ORDER BY p.punched_at DESC)
)
SELECT
  o.id, o.employee_id,
  er.employee_code, er.display_name,
  o.punched_at,
  o.ist_date, o.ist_time, o.effective_date,
  to_char(util.ist_ts(o.punched_at), 'HH24:MI:SS') AS ist_time_display,
  o.direction,
  CASE
    WHEN o.rn_asc = 1                       THEN 'IN'
    WHEN o.rn_desc = 1 AND o.day_punch_count > 1 THEN 'OUT'
    ELSE 'SCAN'
  END AS derived_direction,
  o.source,
  CASE o.source
    WHEN 'kiosk_face'            THEN 'Kiosk — Face'
    WHEN 'kiosk_fingerprint'     THEN 'Kiosk — Fingerprint'
    WHEN 'kiosk_card'            THEN 'Kiosk — Card'
    WHEN 'kiosk_manual'          THEN 'Kiosk — Manual (operator)'
    WHEN 'web'                   THEN 'Web'
    WHEN 'mobile'                THEN 'Mobile'
    WHEN 'biometric_device'      THEN 'Biometric device'
    WHEN 'manual_admin'          THEN 'Manual (admin)'
    WHEN 'import'                THEN 'Import'
    WHEN 'system_regularization' THEN 'Regularization'
  END AS source_label,
  o.kiosk_device_id, kd.label AS device_label,
  o.operator_id, oper.display_name AS operator_name,
  o.match_confidence,
  CASE
    WHEN o.match_confidence IS NULL  THEN NULL
    WHEN o.match_confidence >= 0.80  THEN 'high'
    WHEN o.match_confidence >= 0.62  THEN 'medium'
    ELSE 'low'
  END AS confidence_badge,
  o.photo_path,        -- signed URL minted per request by the API, never stored
  o.lat, o.lng, o.geofence_ok,
  o.is_offline_replay, o.needs_review,
  o.is_voided, o.voided_at, o.void_reason,
  o.reason, o.operator_note, o.recorded_at,
  -- APPENDED (see header): metres of horizontal uncertainty the device itself
  -- reported. NULL means the punch carried no accuracy figure — which is not the
  -- same as "accurate", and the UI must not render it as a tight fix.
  o.location_accuracy_m
FROM ordered o
LEFT JOIN public.v_employee_ref er ON er.id = o.employee_id
LEFT JOIN public.kiosk_devices  kd ON kd.id = o.kiosk_device_id
LEFT JOIN public.kiosk_operators ko ON ko.id = o.operator_id
LEFT JOIN public.employees      oper ON oper.id = ko.employee_id
WHERE app.can_see_employee(o.employee_id);

COMMENT ON VIEW public.v_attendance_punch_detail IS
  '§9.3 per-punch drill-down. Derived direction: first punch of the business date = IN, last = OUT (when >1), middle = SCAN. Row scope = app.can_see_employee. Voided punches are excluded from direction derivation and from this view. location_accuracy_m is projected last (CREATE OR REPLACE VIEW can only append) and is NULL when the punch carried no accuracy reading.';
