-- =============================================================================
-- Migration 001 — extensions and schemas
-- Source: docs/plan/04-data-model.md §1.1 (schemas), §1.9 (extensions);
--         docs/build/spec-migrations.md §1, §2 row 001.
--
-- Creates the required Postgres extensions and the five non-public schemas
-- (secure, util, app, audit, analytics), then locks the non-public schemas
-- away from anon/authenticated so nothing in them is ever client-reachable
-- through PostgREST or a direct grant mistake.
--
-- Portability: pgcrypto/btree_gist/pg_trgm/unaccent are plain
-- CREATE EXTENSION IF NOT EXISTS (present in contrib everywhere).
-- pg_cron/pg_net exist only on hosted Supabase, so they are wrapped in
-- guarded DO blocks and skipped with a NOTICE on the local validation
-- harness. anon/authenticated role grants are guarded by pg_roles existence
-- checks for the same reason.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Extensions (§1.9)
-- -----------------------------------------------------------------------------

-- Pinned to the `extensions` schema so unqualified references never work by
-- accident and qualified references (extensions.digest, ...) resolve
-- identically on hosted Supabase (which pre-installs them there) and on the
-- vanilla-Postgres validation harness. The schema exists on hosted Supabase;
-- created here for the harness.
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto   WITH SCHEMA extensions; -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions; -- daterange exclusion constraints
CREATE EXTENSION IF NOT EXISTS pg_trgm    WITH SCHEMA extensions; -- employee/global fuzzy search
CREATE EXTENSION IF NOT EXISTS unaccent   WITH SCHEMA extensions; -- accent-folded search + slugify

-- Operator/opclass resolution (gin_trgm_ops, gist exclusion operators) relies
-- on `extensions` being on the database search_path, exactly as hosted
-- Supabase configures it. No-op there; makes the harness identical.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = %L, %L, %L',
                 current_database(), '$user', 'public', 'extensions');
END $$;
SET search_path = "$user", public, extensions;

GRANT USAGE ON SCHEMA extensions TO PUBLIC;

-- Supabase-only extensions: unavailable on the vanilla-Postgres validation
-- harness. Guarded so the migration runs on both targets.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;   -- scheduled jobs (migration 041)
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'extension pg_cron unavailable, skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;    -- async HTTP from cron -> edge fns
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'extension pg_net unavailable, skipped: %', SQLERRM;
END $$;

-- `vector` and `tablefunc` are deliberately NOT created here (deferred /
-- optional per spec-migrations §1 note).

-- -----------------------------------------------------------------------------
-- 2. Schemas (§1.1)
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS secure;
COMMENT ON SCHEMA secure IS
  'Biometric templates, device/API secrets, identity vault. NEVER exposed to '
  'PostgREST (removed from db.schemas). RLS enabled with ZERO policies: '
  'service-role only. A schema PostgREST cannot see cannot be queried even if '
  'an RLS policy is misauthored.';

CREATE SCHEMA IF NOT EXISTS util;
COMMENT ON SCHEMA util IS
  'Pure/IMMUTABLE helpers (ist_date, ist_ts, business_date, mask_tail, '
  'minutes_between, sha256_hex, ...). Keeps public free of non-table objects '
  'and keeps generated-column dependencies stable.';

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS
  'SECURITY DEFINER authorization helpers called from RLS policies '
  '(current_employee_id, has_role, is_admin, is_manager_of, ctx, ...). '
  'Not exposed as RPC.';

CREATE SCHEMA IF NOT EXISTS audit;
COMMENT ON SCHEMA audit IS
  'Audit trigger functions and audit-engine configuration tables '
  '(excluded_columns, redacted_columns, reason_required_tables, chain_state). '
  'The audit_log table itself lives in public (admins query it via the API) '
  'but is write-locked. Configuration here must not be editable through the API.';

CREATE SCHEMA IF NOT EXISTS analytics;
COMMENT ON SCHEMA analytics IS
  'Materialized views and their refresh functions. Read through public.v_* '
  'wrappers so REFRESH MATERIALIZED VIEW CONCURRENTLY never touches client grants.';

-- -----------------------------------------------------------------------------
-- 3. Lock down the non-public schemas (§1.1, spec row 001)
-- -----------------------------------------------------------------------------

-- Nothing in these schemas is ever reachable by the PUBLIC pseudo-role.
REVOKE ALL ON SCHEMA secure, util, app, audit, analytics FROM PUBLIC;

-- Future objects created (by the migration role) in these schemas must not
-- inherit the default PUBLIC EXECUTE grant on functions, nor any table or
-- sequence privilege. Later migrations grant back exactly what each audience
-- needs (002 for util, 005 for app, 048 final sweep).
ALTER DEFAULT PRIVILEGES IN SCHEMA secure, util, app, audit, analytics
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA secure, util, app, audit, analytics
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA secure, util, app, audit, analytics
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

-- Revoke everything from the Supabase API roles. Guarded: the roles exist on
-- hosted Supabase but not necessarily on the vanilla validation harness.
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA secure, util, app, audit, analytics FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA secure, util, app, audit, analytics FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA secure, util, app, audit, analytics FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA secure, util, app, audit, analytics FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA secure, util, app, audit, analytics REVOKE ALL ON TABLES FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA secure, util, app, audit, analytics REVOKE EXECUTE ON FUNCTIONS FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA secure, util, app, audit, analytics REVOKE ALL ON SEQUENCES FROM %I', v_role);
    ELSE
      RAISE NOTICE 'role % does not exist here, revoke skipped', v_role;
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 4. search_path conventions (§1.1, spec row 001)
-- -----------------------------------------------------------------------------
-- Convention (enforced per object, not per database — the database-level
-- search_path is deliberately left untouched because hosted Supabase resolves
-- extension objects through its `extensions` schema entry):
--   * Every SECURITY DEFINER function is created with SET search_path = ''.
--   * Every function body fully schema-qualifies every non-pg_catalog object
--     it references (public.*, util.*, app.*, audit.*, secure.*, analytics.*).
--   * PostgREST exposure is `public` only; secure/util/app/audit/analytics are
--     never added to db.schemas in config.toml.

COMMIT;
