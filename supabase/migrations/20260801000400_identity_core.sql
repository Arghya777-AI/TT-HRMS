-- ============================================================================
-- 004 — IDENTITY CORE
-- Source: docs/plan/04-data-model.md §3.1 (profiles, user_roles,
--         employee_role_assignments, sessions_audit), §1.3 (touch/stamp),
--         §8.1 (handle_new_user).
-- Depends on: 001 (schemas util/app/audit/secure), 002 (util.*),
--             003 (enum public.app_role).
-- NOTE: RLS is ENABLED here (default-deny). The policies for these four
--       tables are created at the end of migration 005, because they call
--       app.* helper functions that do not exist until 005.
-- ============================================================================

BEGIN;

SET LOCAL check_function_bodies = off;

-- ----------------------------------------------------------------------------
-- 1. Generic touch/stamp trigger functions (§1.3)
--    trg_<table>__touch  BEFORE UPDATE : owns updated_at / updated_by and
--                                        pins created_at / created_by.
--    trg_<table>__stamp  BEFORE INSERT : sets created_by when NULL.
--    app.ctx_actor_id() is defined in 005; plpgsql resolves it at run time.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION util.touch_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.created_at := OLD.created_at;   -- application code never moves these
  NEW.created_by := OLD.created_by;
  NEW.updated_at := now();
  NEW.updated_by := app.ctx_actor_id();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION util.stamp_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := app.ctx_actor_id();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION util.touch_row() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION util.stamp_row() FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 2. profiles — 1:1 with auth.users; login-identity facts only (§3.1)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.profiles (
  id                   uuid        NOT NULL PRIMARY KEY
                                   REFERENCES auth.users (id) ON DELETE CASCADE,
  email                text        NOT NULL,
  full_name            text        NOT NULL,
  avatar_url           text        NULL,
  phone                text        NULL,
  locale               text        NOT NULL DEFAULT 'en-IN',
  timezone             text        NOT NULL DEFAULT 'Asia/Kolkata',
  is_active            boolean     NOT NULL DEFAULT true,
  must_change_password boolean     NOT NULL DEFAULT false,
  last_login_at        timestamptz NULL,
  failed_login_count   integer     NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  CONSTRAINT ck_profiles__email
    CHECK (email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_profiles__phone_e164
    CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT ck_profiles__failed_login_count
    CHECK (failed_login_count >= 0)
);

COMMENT ON TABLE public.profiles IS
  '1:1 with auth.users. Login-identity facts only; all HR facts live in employees.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles__email
  ON public.profiles (lower(email));
CREATE INDEX IF NOT EXISTS idx_profiles__is_active
  ON public.profiles (is_active);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Email is lowercased by trigger (§3.1 profiles.email).
CREATE OR REPLACE FUNCTION public.profiles_normalise_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.profiles_normalise_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles__email_lower ON public.profiles;
CREATE TRIGGER trg_profiles__email_lower
  BEFORE INSERT OR UPDATE OF email ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_normalise_email();

DROP TRIGGER IF EXISTS trg_profiles__stamp ON public.profiles;
CREATE TRIGGER trg_profiles__stamp
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();

DROP TRIGGER IF EXISTS trg_profiles__touch ON public.profiles;
CREATE TRIGGER trg_profiles__touch
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- ----------------------------------------------------------------------------
-- 3. user_roles (§3.1)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_roles (
  id             uuid            NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid            NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  role           public.app_role NOT NULL,
  granted_by     uuid            NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  granted_at     timestamptz     NOT NULL DEFAULT now(),
  granted_reason text            NOT NULL,
  revoked_at     timestamptz     NULL,
  revoked_by     uuid            NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  revoke_reason  text            NULL,
  created_at     timestamptz     NOT NULL DEFAULT now(),
  created_by     uuid            NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_at     timestamptz     NOT NULL DEFAULT now(),
  updated_by     uuid            NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  CONSTRAINT ck_user_roles__granted_reason
    CHECK (length(btrim(granted_reason)) >= 10)
);

COMMENT ON TABLE public.user_roles IS
  'Role grants. granted_by NULL only for the bootstrap super-admin. Soft revoke via revoked_at.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles__user_role_live
  ON public.user_roles (user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_roles__role
  ON public.user_roles (role);
CREATE INDEX IF NOT EXISTS idx_user_roles__user
  ON public.user_roles (user_id);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_user_roles__stamp ON public.user_roles;
CREATE TRIGGER trg_user_roles__stamp
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();

DROP TRIGGER IF EXISTS trg_user_roles__touch ON public.user_roles;
CREATE TRIGGER trg_user_roles__touch
  BEFORE UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- ----------------------------------------------------------------------------
-- 4. employee_role_assignments — scoped administrative delegation (§3.1)
--    company_id/location_id/department_id/section_id are plain uuid here:
--    the org tables are created in 007 (after this file), so the FKs cannot
--    be declared yet without breaking build order.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_role_assignments (
  id             uuid            NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid            NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  role           public.app_role NOT NULL,
  scope_kind     text            NOT NULL,
  company_id     uuid            NULL,
  location_id    uuid            NULL,
  department_id  uuid            NULL,
  section_id     uuid            NULL,
  employee_ids   uuid[]          NULL,
  effective_from date            NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date            NULL,
  created_at     timestamptz     NOT NULL DEFAULT now(),
  created_by     uuid            NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_at     timestamptz     NOT NULL DEFAULT now(),
  updated_by     uuid            NULL REFERENCES public.profiles (id) ON DELETE SET NULL,
  CONSTRAINT ck_era__role
    CHECK (role IN ('manager', 'admin')),
  CONSTRAINT ck_era__scope_kind
    CHECK (scope_kind IN ('global', 'company', 'location', 'department', 'section', 'employee_list')),
  CONSTRAINT ck_era__scope_target CHECK (
       (scope_kind = 'global'        AND company_id IS NULL     AND location_id IS NULL     AND department_id IS NULL     AND section_id IS NULL     AND employee_ids IS NULL)
    OR (scope_kind = 'company'       AND company_id IS NOT NULL AND location_id IS NULL     AND department_id IS NULL     AND section_id IS NULL     AND employee_ids IS NULL)
    OR (scope_kind = 'location'      AND company_id IS NULL     AND location_id IS NOT NULL AND department_id IS NULL     AND section_id IS NULL     AND employee_ids IS NULL)
    OR (scope_kind = 'department'    AND company_id IS NULL     AND location_id IS NULL     AND department_id IS NOT NULL AND section_id IS NULL     AND employee_ids IS NULL)
    OR (scope_kind = 'section'       AND company_id IS NULL     AND location_id IS NULL     AND department_id IS NULL     AND section_id IS NOT NULL AND employee_ids IS NULL)
    OR (scope_kind = 'employee_list' AND company_id IS NULL     AND location_id IS NULL     AND department_id IS NULL     AND section_id IS NULL     AND employee_ids IS NOT NULL AND cardinality(employee_ids) > 0)
  ),
  CONSTRAINT ck_era__dates CHECK (
    effective_from <= DATE '2100-01-01'
    AND (effective_to IS NULL OR (effective_to >= effective_from AND effective_to <= DATE '2100-01-01'))
  )
);

COMMENT ON TABLE public.employee_role_assignments IS
  'Scoped administrative delegation: admin for one department/location/… only. effective_to NULL = open-ended.';

CREATE INDEX IF NOT EXISTS idx_era__profile_live
  ON public.employee_role_assignments (profile_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_era__employee_ids
  ON public.employee_role_assignments USING gin (employee_ids);

ALTER TABLE public.employee_role_assignments ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_era__stamp ON public.employee_role_assignments;
CREATE TRIGGER trg_era__stamp
  BEFORE INSERT ON public.employee_role_assignments
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();

DROP TRIGGER IF EXISTS trg_era__touch ON public.employee_role_assignments;
CREATE TRIGGER trg_era__touch
  BEFORE UPDATE ON public.employee_role_assignments
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- ----------------------------------------------------------------------------
-- 5. sessions_audit — append-only login/logout/refresh record (§3.1)
--    profile_id is deliberately NOT a FK: any ON DELETE action would need an
--    UPDATE/DELETE on this append-only table, which is refused (§4.9).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sessions_audit (
  id              uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid        NULL,
  attempted_email text        NULL,
  event           text        NOT NULL,
  auth_method     text        NULL,
  ip              inet        NULL,
  user_agent      text        NULL,
  device_id       text        NULL,
  geo             jsonb       NULL,
  failure_reason  text        NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sessions_audit__event CHECK (event IN (
    'login_success', 'login_failed', 'logout', 'token_refresh',
    'password_reset_requested', 'password_changed', 'passkey_registered',
    'passkey_used', 'mfa_challenge', 'session_revoked')),
  CONSTRAINT ck_sessions_audit__auth_method CHECK (auth_method IS NULL OR auth_method IN (
    'password', 'passkey', 'magic_link', 'otp', 'kiosk_pin')),
  CONSTRAINT ck_sessions_audit__attempted_email_lower
    CHECK (attempted_email IS NULL OR attempted_email = lower(attempted_email))
);

COMMENT ON TABLE public.sessions_audit IS
  'Append-only auth event record, written by edge functions with the service role.';

CREATE INDEX IF NOT EXISTS idx_sessions_audit__profile_time
  ON public.sessions_audit (profile_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_audit__event_time
  ON public.sessions_audit (event, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_audit__recorded_brin
  ON public.sessions_audit USING brin (recorded_at);

ALTER TABLE public.sessions_audit ENABLE ROW LEVEL SECURITY;

-- Projects login events onto profiles: last_login_at, failed_login_count,
-- lockout at >= 10 failures with a system_health alert (§3.1 profiles).
CREATE OR REPLACE FUNCTION public.sessions_audit_apply_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_email text;
BEGIN
  IF NEW.profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NEW.event = 'login_success' THEN
    UPDATE public.profiles
       SET last_login_at      = NEW.recorded_at,
           failed_login_count = 0
     WHERE id = NEW.profile_id;

  ELSIF NEW.event = 'login_failed' THEN
    UPDATE public.profiles
       SET failed_login_count = failed_login_count + 1
     WHERE id = NEW.profile_id
    RETURNING failed_login_count, email INTO v_count, v_email;

    IF v_count >= 10 THEN
      UPDATE public.profiles
         SET is_active = false
       WHERE id = NEW.profile_id AND is_active;

      IF to_regclass('public.system_health') IS NOT NULL THEN
        BEGIN
          EXECUTE format(
            'INSERT INTO public.system_health (component, status, metric_name, metric_value, message)
             VALUES (%L, %L, %L, %s, %L)',
            'db', 'degraded', 'failed_login_lockout', v_count,
            'account locked after ' || v_count || ' failed logins: '
              || coalesce(v_email, NEW.profile_id::text));
        EXCEPTION WHEN OTHERS THEN
          NULL;  -- alerting must never block the auth audit write
        END;
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sessions_audit_apply_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sessions_audit__apply_event ON public.sessions_audit;
CREATE TRIGGER trg_sessions_audit__apply_event
  AFTER INSERT ON public.sessions_audit
  FOR EACH ROW EXECUTE FUNCTION public.sessions_audit_apply_event();

-- ----------------------------------------------------------------------------
-- 6. handle_new_user() — bootstrap trigger on auth.users (§8.1)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_full_name text := COALESCE(
                        NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
                        split_part(NEW.email, '@', 1));
  v_code      text := NULLIF(btrim(NEW.raw_user_meta_data ->> 'employee_code'), '');
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, lower(NEW.email), v_full_name)
  ON CONFLICT (id) DO NOTHING;

  -- The FIRST user in a fresh database becomes super_admin (audited, reasoned).
  -- No hard-coded email — the reference repo's pattern is explicitly rejected.
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    INSERT INTO public.user_roles (user_id, role, granted_by, granted_reason)
    VALUES (NEW.id, 'super_admin', NULL, 'bootstrap: first user');
  END IF;

  -- Everyone gets the employee tier.
  INSERT INTO public.user_roles (user_id, role, granted_reason)
  VALUES (NEW.id, 'employee', 'default: account created via auth signup')
  ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING;

  -- Link a pre-created employees row by employee_code (employees is built in 008).
  IF v_code IS NOT NULL AND to_regclass('public.employees') IS NOT NULL THEN
    UPDATE public.employees
       SET profile_id = NEW.id
     WHERE employee_code = v_code
       AND profile_id IS NULL
       AND deleted_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auth_users__handle_new_user ON auth.users;
CREATE TRIGGER trg_auth_users__handle_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 7. Grants (final sweep re-asserts these in 048)
-- ----------------------------------------------------------------------------

REVOKE ALL ON public.profiles                  FROM anon, authenticated, service_role;
REVOKE ALL ON public.user_roles                FROM anon, authenticated, service_role;
REVOKE ALL ON public.employee_role_assignments FROM anon, authenticated, service_role;
REVOKE ALL ON public.sessions_audit            FROM anon, authenticated, service_role;

GRANT SELECT, UPDATE         ON public.profiles                  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_roles                TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.employee_role_assignments TO authenticated;
GRANT SELECT                 ON public.sessions_audit            TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles                  TO service_role;
GRANT SELECT, INSERT, UPDATE         ON public.user_roles                TO service_role;
GRANT SELECT, INSERT, UPDATE         ON public.employee_role_assignments TO service_role;
GRANT SELECT, INSERT                 ON public.sessions_audit            TO service_role;

COMMIT;
