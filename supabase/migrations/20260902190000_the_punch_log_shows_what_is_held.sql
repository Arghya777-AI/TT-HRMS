-- ============================================================================
-- STEP 7/8 (part 1): the punch log says whether a punch is waiting on somebody.
--
-- `requires_approval` and `approved_at` are on `attendance_punches` but were not on
-- the view every screen reads, so nothing could show a held punch or list one for an
-- administrator to decide.
--
-- ── APPENDED, WHICH IS THE ONLY SAFE EDIT TO A LIVE VIEW ────────────────────
-- CREATE OR REPLACE VIEW may add columns at the END and may not reorder or retype the
-- ones already there. Both new columns go last, so every existing consumer — every
-- `select` by name, every zod schema that ignores unknown keys — is unaffected. Nothing
-- in the database depends on this view, checked before editing.
--
-- The view keeps its own scoping: `o.employee_id IN (app.visible_employee_ids())` is
-- inline in its WHERE, so an administrator sees their scope and an employee sees only
-- themselves. That is deliberately left as it was — an employee SHOULD see that their
-- own off-hours punch is waiting, and nobody else's.
--
-- Generated from `pg_get_viewdef` and diffed: two lines replaced by four, nothing else.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_attendance_punch_detail AS
 WITH ordered AS (
         SELECT p.id,
            p.employee_id,
            p.punched_at,
            p.ist_date,
            p.ist_time,
            p.business_date,
            p.effective_date,
            p.direction,
            p.source,
            p.kiosk_device_id,
            p.operator_id,
            p.face_match_log_id,
            p.match_confidence,
            p.match_distance,
            p.webauthn_credential_id,
            p.swipe_card_id,
            p.photo_path,
            p.lat,
            p.lng,
            p.location_accuracy_m,
            p.geofence_ok,
            p.requires_approval,
            p.approved_at,
            p.ip,
            p.user_agent,
            p.device_id,
            p.is_offline_replay,
            p.queued_at,
            p.device_clock_skew_seconds,
            p.needs_review,
            p.is_voided,
            p.voided_by,
            p.voided_at,
            p.void_reason,
            p.duplicate_of_punch_id,
            p.operator_note,
            p.reason,
            p.approval_request_id,
            p.recorded_at,
            p.recorded_by,
            p.request_id,
            p.idempotency_key,
            row_number() OVER w AS rn_asc,
            row_number() OVER w_desc AS rn_desc,
            count(*) OVER (PARTITION BY p.employee_id, p.effective_date) AS day_punch_count
           FROM attendance_punches p
          WHERE NOT p.is_voided
          WINDOW w AS (PARTITION BY p.employee_id, p.effective_date ORDER BY p.punched_at), w_desc AS (PARTITION BY p.employee_id, p.effective_date ORDER BY p.punched_at DESC)
        )
 SELECT o.id,
    o.employee_id,
    er.employee_code,
    er.display_name,
    o.punched_at,
    o.ist_date,
    o.ist_time,
    o.effective_date,
    to_char(util.ist_ts(o.punched_at), 'HH24:MI:SS'::text) AS ist_time_display,
    o.direction,
        CASE
            WHEN o.rn_asc = 1 THEN 'IN'::text
            WHEN o.rn_desc = 1 AND o.day_punch_count > 1 THEN 'OUT'::text
            ELSE 'SCAN'::text
        END AS derived_direction,
    o.source,
        CASE o.source
            WHEN 'kiosk_face'::punch_source THEN 'Kiosk — Face'::text
            WHEN 'kiosk_fingerprint'::punch_source THEN 'Kiosk — Fingerprint'::text
            WHEN 'kiosk_card'::punch_source THEN 'Kiosk — Card'::text
            WHEN 'kiosk_manual'::punch_source THEN 'Kiosk — Manual (operator)'::text
            WHEN 'web'::punch_source THEN 'Web'::text
            WHEN 'mobile'::punch_source THEN 'Mobile'::text
            WHEN 'biometric_device'::punch_source THEN 'Biometric device'::text
            WHEN 'manual_admin'::punch_source THEN 'Manual (admin)'::text
            WHEN 'import'::punch_source THEN 'Import'::text
            WHEN 'system_regularization'::punch_source THEN 'Regularization'::text
            ELSE NULL::text
        END AS source_label,
    o.kiosk_device_id,
    kd.label AS device_label,
    o.operator_id,
    oper.display_name AS operator_name,
    o.match_confidence,
        CASE
            WHEN o.match_confidence IS NULL THEN NULL::text
            WHEN o.match_confidence >= 0.80 THEN 'high'::text
            WHEN o.match_confidence >= 0.62 THEN 'medium'::text
            ELSE 'low'::text
        END AS confidence_badge,
    o.photo_path,
    o.lat,
    o.lng,
    o.geofence_ok,
    o.is_offline_replay,
    o.needs_review,
    o.is_voided,
    o.voided_at,
    o.void_reason,
    o.reason,
    o.operator_note,
    o.recorded_at,
    o.location_accuracy_m,
    host(o.ip) AS ip_address,
    o.requires_approval,
    o.approved_at
   FROM ordered o
     LEFT JOIN v_employee_ref er ON er.id = o.employee_id
     LEFT JOIN kiosk_devices kd ON kd.id = o.kiosk_device_id
     LEFT JOIN kiosk_operators ko ON ko.id = o.operator_id
     LEFT JOIN employees oper ON oper.id = ko.employee_id
  WHERE (o.employee_id IN ( SELECT app.visible_employee_ids() AS visible_employee_ids));
