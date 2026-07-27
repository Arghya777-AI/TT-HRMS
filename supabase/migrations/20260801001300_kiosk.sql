-- =============================================================================
-- Migration 013 — kiosk devices + operators
-- Source: docs/plan/04-data-model.md §3.4 kiosk tables (lines 611–681),
--         §4.8 (kiosk hard rule); spec-migrations §2 row 013.
--
-- The kiosk tablet is NOT a database user: it has no Supabase session, no
-- table access, and authenticates to the four kiosk edge functions with its
-- device secret (Argon2id hash in secure.kiosk_device_secrets, 012). These
-- public rows are the ADMIN's view of the fleet — hence P8/P9-only RLS and
-- zero grants to anon.
--
-- Deviation (documented): the doc's kiosk_operators column list includes
-- pin_hash, but its own note says the PIN lives in
-- secure.kiosk_operator_secrets. Secret material never sits in public —
-- pin_hash is therefore omitted here; 012 already owns it.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. kiosk_devices
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kiosk_devices (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  device_code          text NOT NULL,
  label                text NOT NULL,
  location_id          uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  device_kind          text NOT NULL DEFAULT 'tablet_camera',
  platform             text,
  is_active            boolean NOT NULL DEFAULT true,
  allowed_ip_cidrs     cidr[],
  allowed_geofence     jsonb,
  require_operator     boolean NOT NULL DEFAULT true,
  min_match_confidence numeric(9,4) NOT NULL DEFAULT 0.6200,
  max_offline_queue    integer NOT NULL DEFAULT 500,
  clock_skew_seconds   integer NOT NULL DEFAULT 0,
  last_seen_at         timestamptz,
  last_punch_at        timestamptz,
  app_version          text,
  enrolled_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at           timestamptz,
  deleted_by           uuid REFERENCES public.profiles(id),
  deletion_reason      text,
  CONSTRAINT ck_kiosk_devices__kind CHECK (device_kind IN
    ('tablet_camera','kiosk_pc','mobile_pwa','fingerprint_reader')),
  CONSTRAINT ck_kiosk_devices__confidence CHECK (min_match_confidence BETWEEN 0 AND 1),
  CONSTRAINT ck_kiosk_devices__geofence CHECK (
    allowed_geofence IS NULL OR (
      (allowed_geofence ? 'lat') AND (allowed_geofence ? 'lng') AND (allowed_geofence ? 'radius_m'))),
  CONSTRAINT ck_kiosk_devices__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_kiosk_devices__device_code ON public.kiosk_devices (device_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kiosk_devices__location ON public.kiosk_devices (location_id);

CREATE TRIGGER trg_kiosk_devices__stamp BEFORE INSERT ON public.kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_kiosk_devices__touch BEFORE UPDATE ON public.kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.kiosk_devices ENABLE ROW LEVEL SECURITY;

-- P8 admin read; P9 super-admin write (secret rotation and fleet changes).
DROP POLICY IF EXISTS kiosk_devices__admin_read ON public.kiosk_devices;
CREATE POLICY kiosk_devices__admin_read ON public.kiosk_devices
  FOR SELECT TO authenticated USING (app.is_admin());

DROP POLICY IF EXISTS kiosk_devices__super_admin_write ON public.kiosk_devices;
CREATE POLICY kiosk_devices__super_admin_write ON public.kiosk_devices
  FOR ALL TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 2. kiosk_operators — the guards (employee-role logins + a row here)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kiosk_operators (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_id       uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  kiosk_device_id   uuid REFERENCES public.kiosk_devices(id) ON DELETE CASCADE,
  can_enrol_faces   boolean NOT NULL DEFAULT false,
  can_manual_punch  boolean NOT NULL DEFAULT false,
  shift_window      text,
  is_active         boolean NOT NULL DEFAULT true,
  last_signed_in_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- NULL kiosk_device_id = authorised on all active devices; uniqueness treats
-- that as its own slot per the doc's coalesce trick.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kiosk_operators__profile_device
  ON public.kiosk_operators (profile_id, coalesce(kiosk_device_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_kiosk_operators__employee ON public.kiosk_operators (employee_id);
CREATE INDEX IF NOT EXISTS idx_kiosk_operators__device   ON public.kiosk_operators (kiosk_device_id);

CREATE TRIGGER trg_kiosk_operators__stamp BEFORE INSERT ON public.kiosk_operators
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_kiosk_operators__touch BEFORE UPDATE ON public.kiosk_operators
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.kiosk_operators ENABLE ROW LEVEL SECURITY;

-- P8 admin-all. The guard reads their own row only through the
-- kiosk-operator-auth edge function (service role) — no self policy here.
DROP POLICY IF EXISTS kiosk_operators__admin_all ON public.kiosk_operators;
CREATE POLICY kiosk_operators__admin_all ON public.kiosk_operators
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 3. Grants (admin surfaces read/write through RLS; kiosk itself gets nothing)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON public.kiosk_devices, public.kiosk_operators TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.kiosk_devices, public.kiosk_operators TO service_role;
  END IF;
END $$;

COMMIT;
