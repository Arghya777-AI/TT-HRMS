-- =============================================================================
-- Migration 050 — role capabilities, punch idempotency, heartbeat audit fix
-- Source: docs/build/spec-architecture.md §6 (role_capabilities + app.has_cap,
--         cap format domain.object.action[.scope]), §4 (edge lifecycle steps
--         5 and 8); gaps reported by the edge `_shared` contract author.
--
-- Closes four real gaps found while building the edge layer:
--
--  1. `role_capabilities` + `app.has_cap()` did not exist, so lifecycle step 5
--     ("caps from the DB, never from the request") had to fall back to a
--     hard-coded matrix inside auth.ts. Authorisation belongs in the database.
--
--  2. `attendance_punches` had no `idempotency_key`, so a replayed kiosk punch
--     could only be caught by the generic idempotency store — which is a
--     24-hour cache, not an invariant. A partial unique index makes the double
--     punch structurally impossible.
--
--  3. The kiosk heartbeat (every 60 s per device) fired the full audit trigger
--     on `kiosk_devices`, which is also in `audit.reason_required_tables`.
--     That is ~1,400 hash-chained audit rows per device per day, each needing a
--     10-character reason, burying real configuration changes in noise.
--     Narrowing the trigger to `UPDATE OF <config columns>` means a heartbeat
--     never reaches the audit engine, while a genuine config change still does.
--
--  4. `kiosk_devices` gained `vault_secret_name` so device HMAC verification has
--     a defined place to look. `secure.kiosk_device_secrets.secret_hash` is
--     Argon2id — a one-way hash cannot produce an HMAC — so the raw shared
--     secret must live in Vault, with the hash retained for constant-time
--     presence checks and rotation bookkeeping.
-- =============================================================================

BEGIN;

-- kiosk_devices is in audit.reason_required_tables and §6 below back-fills a
-- column on it, so this transaction needs a reason of its own.
SELECT set_config('app.reason', 'migration 050: name the Vault entry holding each kiosk device HMAC secret', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. role_capabilities — authorisation as data
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.role_capabilities (
  role          public.app_role NOT NULL,
  capability    text            NOT NULL,
  description   text,
  -- true when the capability needs a fresh MFA step-up (aal2) as well as the
  -- role: role grants, payroll publish, audit export, biometric purge, …
  requires_step_up boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT pk_role_capabilities PRIMARY KEY (role, capability),
  -- Cap format is domain.object.action[.scope] (spec-architecture §6).
  CONSTRAINT ck_role_capabilities__format
    CHECK (capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$')
);

CREATE INDEX IF NOT EXISTS idx_role_capabilities__capability
  ON public.role_capabilities (capability);

CREATE TRIGGER trg_role_capabilities__stamp BEFORE INSERT ON public.role_capabilities
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_role_capabilities__touch BEFORE UPDATE ON public.role_capabilities
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.role_capabilities ENABLE ROW LEVEL SECURITY;

-- Readable by any authenticated user (the client needs it to shape navigation;
-- it is not sensitive — it says what a ROLE may do, not who holds the role).
DROP POLICY IF EXISTS role_capabilities__read ON public.role_capabilities;
CREATE POLICY role_capabilities__read ON public.role_capabilities
  FOR SELECT TO authenticated USING (true);

-- Changing the authorisation model is a super-admin act, audited with a reason.
DROP POLICY IF EXISTS role_capabilities__super_admin_write ON public.role_capabilities;
CREATE POLICY role_capabilities__super_admin_write ON public.role_capabilities
  FOR ALL TO authenticated
  USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- 2. Seed the capability matrix
-- -----------------------------------------------------------------------------
-- Mirrors the matrix the edge `_shared/auth.ts` fell back to, so swapping that
-- fallback for `app.has_cap()` changes no behaviour. Role hierarchy is applied
-- by app.has_role() (super_admin ⊃ admin ⊃ manager ⊃ employee), so each role
-- lists only what it ADDS.
INSERT INTO public.role_capabilities (role, capability, description, requires_step_up) VALUES
  -- ── employee: own data only ────────────────────────────────────────────────
  ('employee', 'me.view',                          'Open the employee self-service surface', false),
  ('employee', 'ai.ask.self',                      'Ask the AI agent about own records', false),
  ('employee', 'attendance.regularization.submit', 'Request an attendance correction', false),
  ('employee', 'attendance.punch.web',             'Punch from the web when entitled', false),
  ('employee', 'leave.request.submit',             'Apply for leave', false),
  ('employee', 'leave.request.withdraw',           'Withdraw own pending leave request', false),
  ('employee', 'claim.submit',                     'Submit an expense claim', false),
  ('employee', 'document.self.view',               'View own documents', false),
  ('employee', 'profile.self.update',              'Edit own self-editable profile fields', false),
  ('employee', 'biometric.consent.manage',         'Give or withdraw biometric consent', false),
  -- ── manager: adds team scope ───────────────────────────────────────────────
  ('manager',  'team.view',                              'Open the manager surface for reportees', false),
  ('manager',  'ai.ask.team',                            'Ask the AI agent about the team', false),
  ('manager',  'roster.publish',                         'Publish a roster week', false),
  ('manager',  'leave.request.approve.team',             'Decide a reportee leave request', false),
  ('manager',  'attendance.regularization.approve.team', 'Decide a reportee regularization', false),
  ('manager',  'claim.approve.team',                     'Decide a reportee expense claim', false),
  ('manager',  'overtime.approve.team',                  'Approve reportee overtime for payment', false),
  ('manager',  'comp_off.approve.team',                  'Approve a reportee comp-off credit', false),
  -- ── admin: org-wide operations ─────────────────────────────────────────────
  ('admin',    'admin.access',                    'Open the admin console', false),
  ('admin',    'ai.ask.all',                      'Ask the AI agent about anyone', false),
  ('admin',    'employee.create',                 'Create an employee record', false),
  ('admin',    'employee.update',                 'Edit any employee record', false),
  ('admin',    'employee.import',                 'Bulk-import employees', true),
  ('admin',    'employee.account.create',         'Create a login for an employee', true),
  ('admin',    'attendance.punch.manual',         'Record a manual punch with a reason', false),
  ('admin',    'attendance.punch.void',           'Void a punch with a reason', false),
  ('admin',    'attendance.recompute',            'Run the attendance recompute console', true),
  ('admin',    'attendance.lock.manage',          'Lock or unlock an attendance period', true),
  ('admin',    'leave.balance.adjust',            'Credit or debit a leave balance', false),
  ('admin',    'payroll.run.execute',             'Lock inputs and compute a payroll run', true),
  ('admin',    'payroll.publish',                 'Approve and publish payslips', true),
  ('admin',    'document.generate',               'Generate documents from a template', false),
  ('admin',    'comms.send',                      'Send announcements and broadcasts', false),
  ('admin',    'biometric.enrol',                 'Enrol or re-enrol a face template', true),
  ('admin',    'biometric.template.manage',       'Manage face template metadata', true),
  ('admin',    'kiosk.device.manage',             'Manage kiosk devices and operators', false),
  ('admin',    'settings.write',                  'Change admin-editable settings', false),
  ('admin',    'audit.read',                      'Read the audit trail', false),
  -- ── super_admin: irreversible and trust-critical ───────────────────────────
  ('super_admin', 'admin.super',                    'Open super-admin-only surfaces', false),
  ('super_admin', 'audit.export',                   'Export the audit log off-platform', true),
  ('super_admin', 'biometric.template.purge',       'Irreversibly purge a face template', true),
  ('super_admin', 'employee.hard_delete',           'Hard-delete an employee record', true),
  ('super_admin', 'employee.data.purge',            'Purge personal data (DPDP erasure)', true),
  ('super_admin', 'role.grant',                     'Grant a role', true),
  ('super_admin', 'role.revoke',                    'Revoke a role', true),
  ('super_admin', 'kiosk.device.secret.rotate',     'Rotate a kiosk device secret', true),
  ('super_admin', 'settings.security.write',        'Change security settings', true),
  ('super_admin', 'ai.budget.override',             'Override the AI monthly budget stop', true),
  ('super_admin', 'payroll.run.delete',             'Delete a payroll run', true),
  ('super_admin', 'attendance.lock.override',       'Write into a locked attendance period', true)
ON CONFLICT (role, capability) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. app.has_cap() — the single authorisation predicate
-- -----------------------------------------------------------------------------
-- Resolves the caller's live roles against role_capabilities, honouring the
-- role hierarchy in app.has_role(). Callers pass the bare capability; a
-- `.team`/`.self` scope suffix is matched either exactly or by its unscoped
-- stem, so `leave.request.approve.team` satisfies a check for
-- `leave.request.approve` at team scope.
CREATE OR REPLACE FUNCTION app.has_cap(p_capability text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_active_user() AND EXISTS (
    SELECT 1
    FROM public.role_capabilities rc
    WHERE app.has_role(rc.role)
      AND (
        rc.capability = p_capability
        -- a scoped grant satisfies the unscoped check
        OR rc.capability LIKE p_capability || '.%'
      )
  );
$$;

-- Does this capability additionally require an MFA step-up?
CREATE OR REPLACE FUNCTION app.cap_requires_step_up(p_capability text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(bool_or(rc.requires_step_up), false)
  FROM public.role_capabilities rc
  WHERE rc.capability = p_capability
     OR rc.capability LIKE p_capability || '.%';
$$;

-- Every capability the caller actually holds — one round-trip for the client
-- to shape navigation with (UX only; RLS remains the boundary).
CREATE OR REPLACE FUNCTION public.my_capabilities()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT rc.capability
  FROM public.role_capabilities rc
  WHERE app.has_role(rc.role) AND app.is_active_user()
  ORDER BY 1;
$$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE EXECUTE ON FUNCTION app.has_cap(text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION app.cap_requires_step_up(text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.my_capabilities() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION app.has_cap(text) TO %I', v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION app.cap_requires_step_up(text) TO %I', v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.my_capabilities() TO %I', v_role);
      EXECUTE format('GRANT SELECT ON public.role_capabilities TO %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT INSERT, UPDATE, DELETE ON public.role_capabilities TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. attendance_punches.idempotency_key — double-punch made impossible
-- -----------------------------------------------------------------------------
-- The kiosk generates a client_event_id per scan and replays it after an
-- offline period. The generic idempotency store expires after 24 h; this index
-- is permanent, so a replay from a queue that sat overnight still cannot
-- create a second punch.
ALTER TABLE public.attendance_punches
  ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON COLUMN public.attendance_punches.idempotency_key IS
  'Client-supplied event id (kiosk client_event_id / edge Idempotency-Key). '
  'Unique per employee among non-voided punches: the structural defence '
  'against an offline-queue replay creating a duplicate punch.';

-- A unique index on a partitioned table MUST contain the partition key, and
-- `(employee_id, idempotency_key, punched_at)` would happily accept the same
-- key at a different instant — exactly the replay we are trying to stop. So the
-- constraint lives in a small companion table that is NOT partitioned, written
-- in the same transaction as the punch by the trigger below. That gives a true
-- cross-partition guarantee rather than a per-partition one.
CREATE TABLE IF NOT EXISTS public.attendance_punch_keys (
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  punch_id        uuid NOT NULL,
  punched_at      timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_punch_keys PRIMARY KEY (employee_id, idempotency_key)
);

COMMENT ON TABLE public.attendance_punch_keys IS
  'One row per punch that carried a client event id. The primary key is the '
  'cross-partition uniqueness guarantee that attendance_punches (partitioned by '
  'punched_at) cannot express. A key stays claimed even if its punch is later '
  'voided: a void is a correction, not permission to replay the same scan.';

CREATE INDEX IF NOT EXISTS idx_attendance_punch_keys__punch
  ON public.attendance_punch_keys (punch_id);

ALTER TABLE public.attendance_punch_keys ENABLE ROW LEVEL SECURITY;

-- Employees may see their own claims (it is their punch); nobody writes here
-- directly — the trigger does, inside the punch transaction.
DROP POLICY IF EXISTS attendance_punch_keys__self_read ON public.attendance_punch_keys;
CREATE POLICY attendance_punch_keys__self_read ON public.attendance_punch_keys
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id() OR app.is_admin());

CREATE OR REPLACE FUNCTION public.claim_punch_idempotency_key()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key) = '' THEN
    RETURN NEW;
  END IF;
  -- A duplicate raises unique_violation (SQLSTATE 23505), which the edge
  -- function surfaces as 409 and the client treats as success.
  INSERT INTO public.attendance_punch_keys (employee_id, idempotency_key, punch_id, punched_at)
  VALUES (NEW.employee_id, NEW.idempotency_key, NEW.id, NEW.punched_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_attendance_punches__claim_key
  AFTER INSERT ON public.attendance_punches
  FOR EACH ROW EXECUTE FUNCTION public.claim_punch_idempotency_key();

-- Same instant, same device, same employee is a duplicate regardless of any
-- key (protects against a client that forgets to send one). Legal on the
-- partitioned table because it includes the partition key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_punches__emp_instant_device
  ON public.attendance_punches (employee_id, punched_at, kiosk_device_id)
  WHERE is_voided = false AND kiosk_device_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.attendance_punch_keys TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.attendance_punch_keys TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Where a device's HMAC secret actually lives
-- -----------------------------------------------------------------------------
-- secure.kiosk_device_secrets.secret_hash is Argon2id: it proves a presented
-- secret is correct but cannot regenerate one, so it cannot compute an HMAC.
-- The raw shared secret therefore lives in Supabase Vault, read server-side
-- through app.secret(). This column names that entry explicitly instead of
-- relying on a convention buried in TypeScript.
-- Declared BEFORE §6 because the narrowed audit trigger names this column.
ALTER TABLE public.kiosk_devices
  ADD COLUMN IF NOT EXISTS vault_secret_name text;

COMMENT ON COLUMN public.kiosk_devices.vault_secret_name IS
  'Name of the Vault entry holding this device''s raw HMAC shared secret, read '
  'via app.secret(). Written once by kiosk-device-activate; rotation writes the '
  'new value and keeps <name>_prev readable until '
  'secure.kiosk_device_secrets.rotation_grace_until. The Argon2id hash in '
  'secure.kiosk_device_secrets remains the presence/rotation record.';

-- -----------------------------------------------------------------------------
-- 6. Kiosk heartbeat must not flood the audit log
-- -----------------------------------------------------------------------------
-- `UPDATE OF <cols>` fires only when the statement mentions one of those
-- columns, so a heartbeat that writes last_seen_at / last_punch_at /
-- clock_skew_seconds / app_version never reaches audit.log_changes() — and
-- therefore never demands a reason either. Configuration changes still audit.
DROP TRIGGER IF EXISTS trg_kiosk_devices__audit ON public.kiosk_devices;
CREATE TRIGGER trg_kiosk_devices__audit
  AFTER INSERT OR DELETE OR UPDATE OF
    device_code, label, location_id, device_kind, is_active,
    allowed_ip_cidrs, allowed_geofence, require_operator,
    min_match_confidence, max_offline_queue, revoked_at,
    vault_secret_name, deleted_at, deletion_reason
  ON public.kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- Belt and braces: if a future statement does touch both a heartbeat column
-- and a config column, these exclusions keep the heartbeat fields out of the
-- diff so the audit row shows only what a human changed.
INSERT INTO audit.excluded_columns (entity_table, column_name, note) VALUES
  ('public.kiosk_devices', 'last_seen_at',       'heartbeat telemetry, not a configuration change'),
  ('public.kiosk_devices', 'last_punch_at',      'heartbeat telemetry'),
  ('public.kiosk_devices', 'clock_skew_seconds', 'heartbeat telemetry'),
  ('public.kiosk_devices', 'app_version',        'heartbeat telemetry'),
  ('public.kiosk_devices', 'platform',           'reported by the device at registration')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. Back-fill the Vault entry name for devices seeded before this migration
-- -----------------------------------------------------------------------------
UPDATE public.kiosk_devices
   SET vault_secret_name = 'kiosk_device_secret:' || id::text
 WHERE vault_secret_name IS NULL;

COMMIT;
