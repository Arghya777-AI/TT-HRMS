-- =============================================================================
-- 080 · Show the IP behind a web punch, and let an admin choose the punch model
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. WHY THE IP MATTERS, AND ONLY FOR A WEB PUNCH
--
-- A gate punch says where it happened by naming the device: "Main Gate", "Phone 2".
-- A WEB punch has no device — the Gate column is an em dash — so the only provenance
-- it carries is the coordinate it volunteered and the IP it arrived from. The IP was
-- being recorded on `attendance_punches.ip` all along and no view exposed it, so the
-- one punch type that most needs corroboration was the one showing least.
--
-- It is projected for EVERY punch rather than only web ones: a view that hid a column
-- based on another column's value would be a filter pretending to be a schema, and the
-- UI can decide where it is worth showing. `inet` casts to text so PostgREST returns a
-- plain string rather than a driver-specific shape.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. WHY THE DURATION LOOKED WRONG, WHICH IS NOT A BUG IN THE SPAN
--
-- A day with scans at 07:36, 07:38, 14:18, 22:12 and 22:15 reported five minutes
-- worked. The span is computed correctly — `min(punched_at)` to `max(punched_at)`, which
-- is 14h39m — but `employees.punch_mode` was `multi_punch` for everybody, and in that
-- model every INTERIOR gap of at least `min_break_minutes_to_count` is an unpaid break.
-- The two interior gaps were 400 and 474 minutes, so 879 − 874 = 5. The engine did
-- exactly what it was told.
--
-- Both models are legitimate and the venue has to pick:
--
--   single_punch  the day is first scan → last scan. Interior scans are noise: a guard
--                 tapping the gate at lunch does not shorten the shift. Only an EXPLICIT
--                 break pair (break_start/break_end) is deducted, plus the shift's fixed
--                 unpaid break if the policy sets one.
--   multi_punch   scans are in/out pairs and the gaps between them are unpaid. Right for
--                 staff who genuinely clock out and back in.
--
-- The enum already held both values. What was missing was any way for an admin to choose,
-- which is what `set_punch_mode` below provides.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE SETTER IS ADMIN-ONLY, DELIBERATELY UNLIKE THE FACE-LOGIN SWITCH
--
-- `set_face_login_enabled` lets the subject flip their own, because it governs their own
-- credential. This one decides how their hours are COUNTED and therefore what they are
-- paid. An employee must never be able to set it, and neither should their manager —
-- payroll consequences belong to HR. So: admin within scope, or nothing.
-- =============================================================================

SELECT set_config('app.reason', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. `ip` on the punch detail view (appended — CREATE OR REPLACE cannot reorder)
-- -----------------------------------------------------------------------------

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
  o.photo_path,
  o.lat, o.lng, o.geofence_ok,
  o.is_offline_replay, o.needs_review,
  o.is_voided, o.voided_at, o.void_reason,
  o.reason, o.operator_note, o.recorded_at,
  o.location_accuracy_m,
  -- APPENDED: the address the punch arrived from. For a WEB punch this is the only
  -- provenance besides the coordinate, because there is no gate device to name.
  host(o.ip) AS ip_address
FROM ordered o
LEFT JOIN public.v_employee_ref er ON er.id = o.employee_id
LEFT JOIN public.kiosk_devices  kd ON kd.id = o.kiosk_device_id
LEFT JOIN public.kiosk_operators ko ON ko.id = o.operator_id
LEFT JOIN public.employees      oper ON oper.id = ko.employee_id
WHERE app.can_see_employee(o.employee_id);

COMMENT ON VIEW public.v_attendance_punch_detail IS
  '§9.3 per-punch drill-down. Derived direction: first punch of the business date = IN, last = OUT (when >1), middle = SCAN. Row scope = app.can_see_employee. Voided punches are excluded. location_accuracy_m and ip_address are projected last (CREATE OR REPLACE VIEW can only append); ip_address is the source address, which for a web punch is its only provenance besides the coordinate.';

-- -----------------------------------------------------------------------------
-- 2. Who may read the punch model, and who may change it
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_punch_mode_access
WITH (security_barrier = true) AS
SELECT
  e.id            AS employee_id,
  e.employee_code,
  e.display_name,
  e.punch_mode::text AS punch_mode,
  d.name          AS department_name,
  -- Decided by the database so the UI never re-derives an authority rule. Note this is
  -- NARROWER than the face-login switch: admin only, never self, never the manager.
  (app.is_admin() AND app.admin_scope_covers(e.id)) AS can_manage
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
WHERE e.deleted_at IS NULL
  AND (
    e.id = app.current_employee_id()
    OR app.is_manager_of(e.id)
    OR (app.is_admin() AND app.admin_scope_covers(e.id))
  );

COMMENT ON VIEW public.v_punch_mode_access IS
  'How each employee''s hours are counted. Readable by self, their manager and a scoped admin — an employee is entitled to know how their day is measured — but can_manage is TRUE for a scoped admin only, because the setting decides pay.';

GRANT SELECT ON public.v_punch_mode_access TO authenticated;

CREATE OR REPLACE FUNCTION public.set_punch_mode(
  p_employee_id uuid,
  p_mode        text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_new punch_mode;
BEGIN
  IF p_employee_id IS NULL OR p_mode IS NULL THEN
    RAISE EXCEPTION 'set_punch_mode needs an employee id and a mode' USING ERRCODE = '22023';
  END IF;
  IF p_mode NOT IN ('single_punch', 'multi_punch') THEN
    RAISE EXCEPTION 'punch mode must be single_punch or multi_punch' USING ERRCODE = '22023';
  END IF;

  -- ADMIN ONLY. Not the subject, not the manager — see the header. Fails closed.
  IF NOT (app.is_admin() AND app.admin_scope_covers(p_employee_id)) THEN
    RAISE EXCEPTION 'Only an admin may change how an employee''s hours are counted'
      USING ERRCODE = '42501';
  END IF;

  v_new := p_mode::punch_mode;

  PERFORM set_config(
    'app.reason',
    format('punch model set to %s by admin — changes how worked hours are counted', p_mode),
    true
  );

  UPDATE public.employees SET punch_mode = v_new
   WHERE id = p_employee_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such employee' USING ERRCODE = 'P0002';
  END IF;

  /*
    The setting only takes effect through `compute_attendance_day`, so days already
    computed keep their old figures until something recomputes them. Deliberately NOT
    recomputed here: a silent rewrite of historical attendance — and therefore of pay —
    triggered by a dropdown is exactly the kind of change that must be asked for
    explicitly. `recompute_attendance_range` is the deliberate way to do it, and the UI
    says so.
  */
  RETURN p_mode;
END;
$$;

COMMENT ON FUNCTION public.set_punch_mode(uuid, text) IS
  'Choose how an employee''s hours are counted: single_punch (first scan to last scan) or multi_punch (in/out pairs, interior gaps unpaid). Admin-within-scope only — it decides pay. Does NOT recompute history; call recompute_attendance_range for that.';

REVOKE ALL ON FUNCTION public.set_punch_mode(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_punch_mode(uuid, text) TO authenticated;
