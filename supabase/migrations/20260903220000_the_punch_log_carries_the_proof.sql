-- ============================================================================
-- The punch log carries the proof photograph's id.
--
-- Appended so the off-hours approval queue can show an administrator the picture
-- the employee attached. "If they have attached a document or not, nothing is
-- coming" was said of the approval screens; this is the punch-side half of it.
--
-- ── APPENDED, BECAUSE THAT IS THE ONLY THING PERMITTED ──────────────────────
-- `CREATE OR REPLACE VIEW` may only ADD columns to the END of the select list; it
-- refuses a reorder, a rename or a removal. So `proof_document_id` goes last in the
-- outer select — AND into the `ordered` CTE, which names its columns rather than
-- selecting *, so adding it in one place only would have compiled and returned
-- nothing.
--
-- Generated from `pg_get_viewdef` of the deployed view. The two anchors were taken
-- from the real bytes after a first attempt anchored on whitespace that a print
-- statement had added — it failed loudly rather than silently matching the wrong
-- line, which is why the anchors are asserted unique before either replacement.
--
-- Nothing else changed: `app.visible_employee_ids()` scoping, every join and every
-- existing column are byte-identical to what is live.
-- ============================================================================

SELECT set_config('app.reason',
  'the punch log exposes proof_document_id so the off-hours approval queue can show the attached photograph',
  true);

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
            p.proof_document_id,
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
    o.approved_at,
    o.proof_document_id
   FROM ordered o
     LEFT JOIN v_employee_ref er ON er.id = o.employee_id
     LEFT JOIN kiosk_devices kd ON kd.id = o.kiosk_device_id
     LEFT JOIN kiosk_operators ko ON ko.id = o.operator_id
     LEFT JOIN employees oper ON oper.id = ko.employee_id
  WHERE (o.employee_id IN ( SELECT app.visible_employee_ids() AS visible_employee_ids));