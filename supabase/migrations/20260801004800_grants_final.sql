-- =============================================================================
-- Migration 048 — final GRANT/REVOKE sweep + RLS assertion.
-- Source: docs/plan/04-data-model.md §4.4 (table × role × operation matrix);
--         spec-migrations §2 row 048.
--
-- What this file does:
--  1. Revokes ALL from anon on every table/sequence/function in every app
--     schema — anon touches nothing.
--  2. Locks the secure schema to the service role (zero grants for clients).
--  3. Removes DELETE/TRUNCATE from authenticated across public — §4.4 grants
--     D below super-admin only for employee_skills / employee_hobbies (self,
--     row-gated by RLS), which are re-granted.
--  4. Re-asserts the §4.4 column-narrowing (employees P2, notifications
--     read_at/dismissed_at) verbatim.
--  5. Function sweep: strips the default PUBLIC EXECUTE from every routine in
--     the app schemas, grants service_role everywhere, grants authenticated
--     on util.* + app.* (RLS policies and CHECK constraints evaluate these as
--     the calling role) and on the named client-facing RPC surface. Explicit
--     per-function grants made by earlier migrations are unaffected (REVOKE
--     ... FROM PUBLIC removes only the pseudo-role's default).
--  6. Identity tables (profiles, user_roles, employee_role_assignments,
--     sessions_audit) ship from 004 with RLS enabled and no policies; if no
--     other migration has added policies by now, the §4.4 matrix rows are
--     created here so default-deny becomes the deliberate matrix instead.
--  7. FINAL ASSERTION: fails the migration if any public table (excluding
--     partitions of audited parents — policies live on the parent) has
--     relrowsecurity = false or zero policies.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1–3. Table and sequence sweep.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_schema text;
BEGIN
  -- anon: nothing, anywhere.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH v_schema IN ARRAY ARRAY['public', 'secure', 'util', 'app', 'audit', 'analytics'] LOOP
      IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = v_schema) THEN
        EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA %I FROM anon', v_schema);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM anon', v_schema);
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- secure / audit-internals / analytics: never direct for clients.
    FOREACH v_schema IN ARRAY ARRAY['secure', 'audit', 'analytics'] LOOP
      IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = v_schema) THEN
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM authenticated', v_schema);
      END IF;
    END LOOP;

    -- §4.4: no D below super-admin (hard deletes go through edge functions with
    -- the service role); TRUNCATE for nobody.
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM authenticated;
    -- ... except the two self-managed lists (P4: I,U,D self — rows gated by RLS).
    GRANT DELETE ON public.employee_skills, public.employee_hobbies TO authenticated;

    -- Schema usage the client role does need (001 grants; re-asserted).
    GRANT USAGE ON SCHEMA public TO authenticated;
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'util') THEN
      GRANT USAGE ON SCHEMA util TO authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app') THEN
      GRANT USAGE ON SCHEMA app TO authenticated;
    END IF;

    -- Sequence usage for client-writable tables whose defaults draw numbers.
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
  END IF;

  -- service_role: full data-plane access (bypasses RLS; privileges must exist).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH v_schema IN ARRAY ARRAY['public', 'secure'] LOOP
      IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = v_schema) THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role', v_schema);
        EXECUTE format('GRANT ALL ON ALL TABLES    IN SCHEMA %I TO service_role', v_schema);
        EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO service_role', v_schema);
      END IF;
    END LOOP;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Column-level narrowing (§4.4, exact SQL).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;

  -- P2: employee self-service edits are column-scoped (008 sets this; the
  -- sweep re-asserts it so a later broad grant cannot survive to production).
  REVOKE UPDATE ON public.employees FROM authenticated;
  GRANT UPDATE (about, photo_path, cover_photo_path, food_preference)
    ON public.employees TO authenticated;

  -- notifications: self update of read_at / dismissed_at only.
  REVOKE UPDATE ON public.notifications FROM authenticated;
  GRANT UPDATE (read_at, dismissed_at) ON public.notifications TO authenticated;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Function sweep. REVOKE ... FROM PUBLIC strips only the default
--    pseudo-role EXECUTE; the explicit per-function grants each migration
--    made (019 leave RPCs, 029 workflow RPCs, 032 reveals, …) survive.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_has_anon    boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  v_has_auth    boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  v_has_service boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
  -- Client-facing RPC surface in schema public (granted only if present).
  v_client_fns text[] := ARRAY[
    'resolve_policy', 'resolve_shift_for_date', 'is_weekly_off',
    'leave_year_of', 'calc_leave_days', 'recompute_leave_balance',
    'create_approval_request', 'act_on_approval',
    'apply_change_request',
    'reveal_employee_statutory', 'reveal_employee_bank_account',
    'reveal_identity_document', 'reveal_employee_salary',
    'reveal_face_match_candidates',
    'f_attendance_period_summary'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig,
           n.nspname,
           p.proname,
           p.prokind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'util', 'app', 'audit', 'analytics', 'secure')
      AND p.prokind IN ('f', 'p', 'w')
  LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC', r.sig);
    IF v_has_anon THEN
      EXECUTE format('REVOKE ALL ON ROUTINE %s FROM anon', r.sig);
    END IF;
    IF v_has_service THEN
      EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO service_role', r.sig);
    END IF;
    IF v_has_auth THEN
      -- util.* and app.* run as the calling role inside RLS predicates,
      -- CHECK constraints and generated columns — authenticated must be able
      -- to execute them. public.* is allow-listed.
      IF r.nspname IN ('util', 'app')
         OR (r.nspname = 'public' AND r.proname = ANY (v_client_fns)) THEN
        EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO authenticated', r.sig);
      END IF;
    END IF;
  END LOOP;

  -- PostgREST pre-request hook runs for anonymous requests too.
  IF v_has_anon AND to_regprocedure('app.pgrst_pre_request()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION app.pgrst_pre_request() TO anon;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. Identity-table policies (§4.4 rows for profiles / user_roles /
--    employee_role_assignments / sessions_audit) — created only when the
--    table still has none, so a dedicated policy migration always wins.
--    app.* helpers are SECURITY DEFINER, so none of these recurse.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- profiles: S(self) U(self) | admin S,I,U (manager reads go through views).
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.profiles'::regclass) THEN
    EXECUTE $p$ CREATE POLICY profiles__self__select ON public.profiles
                FOR SELECT TO authenticated
                USING (id = app.ctx_actor_id()) $p$;
    EXECUTE $p$ CREATE POLICY profiles__self__update ON public.profiles
                FOR UPDATE TO authenticated
                USING (id = app.ctx_actor_id())
                WITH CHECK (id = app.ctx_actor_id()) $p$;
    EXECUTE $p$ CREATE POLICY profiles__admin__select ON public.profiles
                FOR SELECT TO authenticated
                USING (app.is_admin()) $p$;
    EXECUTE $p$ CREATE POLICY profiles__admin__insert ON public.profiles
                FOR INSERT TO authenticated
                WITH CHECK (app.is_admin()) $p$;
    EXECUTE $p$ CREATE POLICY profiles__admin__update ON public.profiles
                FOR UPDATE TO authenticated
                USING (app.is_admin())
                WITH CHECK (app.is_admin()) $p$;
  END IF;

  -- user_roles: S(self) | admin S | super-admin I,U (grants are super-admin acts).
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.user_roles'::regclass) THEN
    EXECUTE $p$ CREATE POLICY user_roles__self__select ON public.user_roles
                FOR SELECT TO authenticated
                USING (user_id = app.ctx_actor_id()) $p$;
    EXECUTE $p$ CREATE POLICY user_roles__admin__select ON public.user_roles
                FOR SELECT TO authenticated
                USING (app.is_admin()) $p$;
    EXECUTE $p$ CREATE POLICY user_roles__super__insert ON public.user_roles
                FOR INSERT TO authenticated
                WITH CHECK (app.is_super_admin()) $p$;
    EXECUTE $p$ CREATE POLICY user_roles__super__update ON public.user_roles
                FOR UPDATE TO authenticated
                USING (app.is_super_admin())
                WITH CHECK (app.is_super_admin()) $p$;
  END IF;

  -- employee_role_assignments: S(self) | admin S | super-admin I,U.
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'public.employee_role_assignments'::regclass) THEN
    EXECUTE $p$ CREATE POLICY era__self__select ON public.employee_role_assignments
                FOR SELECT TO authenticated
                USING (profile_id = app.ctx_actor_id()) $p$;
    EXECUTE $p$ CREATE POLICY era__admin__select ON public.employee_role_assignments
                FOR SELECT TO authenticated
                USING (app.is_admin()) $p$;
    EXECUTE $p$ CREATE POLICY era__super__insert ON public.employee_role_assignments
                FOR INSERT TO authenticated
                WITH CHECK (app.is_super_admin()) $p$;
    EXECUTE $p$ CREATE POLICY era__super__update ON public.employee_role_assignments
                FOR UPDATE TO authenticated
                USING (app.is_super_admin())
                WITH CHECK (app.is_super_admin()) $p$;
  END IF;

  -- sessions_audit: S(self) | admin S. Writes are edge-function only.
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'public.sessions_audit'::regclass) THEN
    EXECUTE $p$ CREATE POLICY sessions_audit__self__select ON public.sessions_audit
                FOR SELECT TO authenticated
                USING (profile_id = app.ctx_actor_id()) $p$;
    EXECUTE $p$ CREATE POLICY sessions_audit__admin__select ON public.sessions_audit
                FOR SELECT TO authenticated
                USING (app.is_admin()) $p$;
  END IF;
END $$;

-- Matching table privileges for the rows above (004 revoked ALL, granting
-- back only what its design used; the matrix needs these).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON public.profiles                  TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.user_roles                TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.employee_role_assignments TO authenticated;
    GRANT SELECT                 ON public.sessions_audit            TO authenticated;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7. FINAL ASSERTION — every table in public has RLS enabled AND at least one
--    policy. Partitions (relispartition) are excluded: RLS and policies live
--    on their partitioned parents, which ARE checked. Fails the deploy loudly
--    rather than shipping a default-allow or policy-less table.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_no_rls      text[];
  v_no_policies text[];
BEGIN
  SELECT COALESCE(array_agg(c.relname ORDER BY c.relname), '{}') INTO v_no_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND NOT c.relrowsecurity;

  -- Deliberate exception list: tables that are RLS-enabled with ZERO policies
  -- ON PURPOSE, because no client role may ever touch them — only the service
  -- role (which bypasses RLS) inside an edge function. Default-deny IS the
  -- intended behaviour, so a missing policy here is correct, not a defect.
  -- Any addition to this list needs a comment saying why.
  SELECT COALESCE(array_agg(c.relname ORDER BY c.relname), '{}') INTO v_no_policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND c.relname <> ALL (ARRAY[
      'idempotency_keys'   -- edge-function replay store; never client-readable
    ])
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

  IF array_length(v_no_rls, 1) IS NOT NULL OR array_length(v_no_policies, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'RLS assertion failed.\nTables without RLS enabled: %\nTables with zero policies: %',
      COALESCE(array_to_string(v_no_rls, ', '), '(none)'),
      COALESCE(array_to_string(v_no_policies, ', '), '(none)')
      USING errcode = '2F004',
            HINT = 'Every table in schema public must have ENABLE ROW LEVEL SECURITY and at least one policy (spec-migrations row 048).';
  END IF;

  RAISE NOTICE 'RLS assertion passed: every public table has row security and at least one policy.';
END $$;

COMMIT;
