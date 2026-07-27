-- =============================================================================
-- Migration 016 — attendance_punches: the immutable raw event log
-- Source: docs/plan/04-data-model.md §3.5 (lines 1325–1412), §6.3/§6.4 (IST
--         generated columns, night-shift attribution), §12.5 (partitioning);
--         spec-migrations §2 row 016.
--
-- THE system of record. Append-only: a mistaken punch is VOIDED (void columns
-- only, and only under app.allow_punch_void set by the void-punch edge
-- function), never edited, never deleted. The client has NO write path at all
-- — every row arrives through kiosk-punch / web-punch / admin-punch /
-- import-punches edge functions, service-role, after server-side verification.
--
-- Notes on the doc's DDL, applied here:
--   * effective_date recomputes util.ist_date(punched_at) instead of naming
--     ist_date (Postgres forbids a generated column referencing another).
--   * face_match_log_id / duplicate_of_punch_id / approval_request_id are
--     plain uuids (their targets are partitioned or created later); the
--     guarded 049 sweep attaches what can be attached.
--   * REVOKE DELETE from everyone including service_role; UPDATE stays
--     granted to service_role ONLY because the void path is an UPDATE of the
--     void columns — the BEFORE trigger enforces void-only column changes.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.attendance_punches (
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id               uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  punched_at                timestamptz NOT NULL,
  ist_date                  date NOT NULL GENERATED ALWAYS AS (util.ist_date(punched_at)) STORED,
  ist_time                  time NOT NULL GENERATED ALWAYS AS (util.ist_time(punched_at)) STORED,
  business_date             date,
  effective_date            date NOT NULL GENERATED ALWAYS AS (COALESCE(business_date, util.ist_date(punched_at))) STORED,
  direction                 public.punch_direction NOT NULL DEFAULT 'undetermined',
  source                    public.punch_source NOT NULL,
  kiosk_device_id           uuid REFERENCES public.kiosk_devices(id) ON DELETE RESTRICT,
  operator_id               uuid REFERENCES public.kiosk_operators(id) ON DELETE RESTRICT,
  face_match_log_id         uuid,   -- pointer into secure.face_match_log (partitioned; no FK possible)
  match_confidence          numeric(8,5),
  match_distance            numeric(8,5),
  webauthn_credential_id    uuid,   -- FK via deferred sweep when webauthn_credentials exists
  swipe_card_id             uuid REFERENCES public.employee_swipe_cards(id) ON DELETE SET NULL,
  photo_path                text,
  lat                       numeric(10,7),
  lng                       numeric(10,7),
  location_accuracy_m       numeric(8,2),
  geofence_ok               boolean,
  ip                        inet,
  user_agent                text,
  device_id                 text,
  is_offline_replay         boolean NOT NULL DEFAULT false,
  queued_at                 timestamptz,
  device_clock_skew_seconds integer,
  needs_review              boolean NOT NULL DEFAULT false,
  is_voided                 boolean NOT NULL DEFAULT false,
  voided_by                 uuid,
  voided_at                 timestamptz,
  void_reason               text,
  duplicate_of_punch_id     uuid,   -- self-pointer (no FK across partitions)
  operator_note             text,
  reason                    text,
  approval_request_id       uuid,   -- FK via deferred sweep (approval_requests in 029)
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  recorded_by               uuid,
  request_id                uuid,
  PRIMARY KEY (id, punched_at),
  CONSTRAINT ck_ap__kiosk_device CHECK (source::text NOT LIKE 'kiosk%' OR kiosk_device_id IS NOT NULL),
  CONSTRAINT ck_ap__face_match CHECK (source <> 'kiosk_face' OR face_match_log_id IS NOT NULL),
  CONSTRAINT ck_ap__reason_required CHECK (
    source NOT IN ('manual_admin','kiosk_manual','import','system_regularization')
    OR length(btrim(coalesce(reason, ''))) >= 10),
  CONSTRAINT ck_ap__void_fields CHECK (
    is_voided = false OR (voided_by IS NOT NULL AND voided_at IS NOT NULL
    AND length(btrim(coalesce(void_reason, ''))) >= 10)),
  CONSTRAINT ck_ap__not_future CHECK (punched_at <= now() + interval '5 minutes'),
  CONSTRAINT ck_ap__confidence_range CHECK (
    match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1))
) PARTITION BY RANGE (punched_at);

-- Monthly partitions: previous month → +3 months; partition_maintenance (031)
-- keeps 3 months of headroom thereafter.
DO $$
DECLARE
  v_month date := date_trunc('month', now())::date - interval '1 month';
  v_name  text;
  i       integer;
BEGIN
  FOR i IN 0..4 LOOP
    v_name := 'attendance_punches_' || to_char(v_month, 'YYYY_MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.attendance_punches FOR VALUES FROM (%L) TO (%L)',
        v_name, v_month, (v_month + interval '1 month')::date);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    END IF;
    v_month := (v_month + interval '1 month')::date;
  END LOOP;
END $$;

-- Indexes (§3.5 verbatim, named hot paths)
CREATE INDEX IF NOT EXISTS idx_attendance_punches__emp_date_live
  ON public.attendance_punches (employee_id, effective_date, punched_at)
  WHERE is_voided = false;
CREATE INDEX IF NOT EXISTS idx_attendance_punches__date_live
  ON public.attendance_punches (effective_date, employee_id)
  WHERE is_voided = false;
CREATE INDEX IF NOT EXISTS idx_attendance_punches__device_time
  ON public.attendance_punches (kiosk_device_id, punched_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_punches__emp_recent
  ON public.attendance_punches (employee_id, punched_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_punches__review
  ON public.attendance_punches (effective_date) WHERE needs_review AND NOT is_voided;
CREATE INDEX IF NOT EXISTS idx_attendance_punches__punched_brin
  ON public.attendance_punches USING brin (punched_at);

-- -----------------------------------------------------------------------------
-- Night-shift business-date attribution (§6.4, trg set_punch_business_date)
-- -----------------------------------------------------------------------------
-- A punch before the cutover belongs to the PREVIOUS business date exactly
-- when the previous date's resolved shift crosses midnight. Day-shift punches
-- keep business_date NULL (effective_date falls back to ist_date).
CREATE OR REPLACE FUNCTION public.set_punch_business_date()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ist_date date := util.ist_date(NEW.punched_at);
  v_ist_time time := util.ist_time(NEW.punched_at);
  v_prev_shift uuid;
  v_crosses boolean;
  v_cutover time;
BEGIN
  IF NEW.business_date IS NOT NULL THEN
    RETURN NEW;  -- explicitly attributed (regularization/import) — respect it
  END IF;
  v_prev_shift := public.resolve_shift_for_date(NEW.employee_id, v_ist_date - 1);
  IF v_prev_shift IS NOT NULL THEN
    SELECT s.crosses_midnight, s.day_cutover_time INTO v_crosses, v_cutover
    FROM public.shifts s WHERE s.id = v_prev_shift;
    IF COALESCE(v_crosses, false) AND v_ist_time < COALESCE(v_cutover, TIME '05:00') THEN
      NEW.business_date := v_ist_date - 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_attendance_punches__business_date
  BEFORE INSERT ON public.attendance_punches
  FOR EACH ROW EXECUTE FUNCTION public.set_punch_business_date();

-- -----------------------------------------------------------------------------
-- Append-only enforcement (§3.5 RLS/P10, §4.9)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_punches_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_void_cols text[] := ARRAY['is_voided','voided_by','voided_at','void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance_punches is append-only (void instead of delete)'
      USING errcode = '0A000';
  END IF;
  IF coalesce(current_setting('app.allow_punch_void', true), '') <> 'on' THEN
    RAISE EXCEPTION 'attendance_punches is append-only (voids go through the void-punch function)'
      USING errcode = '0A000';
  END IF;
  IF (to_jsonb(NEW) - v_void_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_void_cols) THEN
    RAISE EXCEPTION 'void may change only the void columns (%)', array_to_string(v_void_cols, ', ')
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_attendance_punches__append_only
  BEFORE UPDATE OR DELETE ON public.attendance_punches
  FOR EACH ROW EXECUTE FUNCTION public.attendance_punches_append_only();

-- -----------------------------------------------------------------------------
-- RLS (P10) + grants
-- -----------------------------------------------------------------------------

ALTER TABLE public.attendance_punches ENABLE ROW LEVEL SECURITY;

-- Employees see their own raw punches (the "View Punches" transparency
-- feature); admins see all. Managers read v_team_punches (034), not the base.
DROP POLICY IF EXISTS attendance_punches__self_read ON public.attendance_punches;
CREATE POLICY attendance_punches__self_read ON public.attendance_punches
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS attendance_punches__admin_read ON public.attendance_punches;
CREATE POLICY attendance_punches__admin_read ON public.attendance_punches
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

-- NO INSERT/UPDATE/DELETE policies for client roles — deliberately absent.

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.attendance_punches FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.attendance_punches TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- INSERT for the four ingest functions; UPDATE only for the void path
    -- (trigger-enforced void-only). DELETE for nobody, ever.
    GRANT SELECT, INSERT, UPDATE ON public.attendance_punches TO service_role;
  END IF;
END $$;

COMMIT;
