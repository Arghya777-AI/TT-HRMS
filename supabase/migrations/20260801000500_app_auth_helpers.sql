-- =============================================================================
-- Migration 005 — app.* authorization helpers
-- Source: docs/plan/04-data-model.md §4.2 (exact SQL, transcribed verbatim),
--         §5.5 (PostgREST pre-request hook); spec-migrations §2 row 005.
--
-- Every RLS policy in the model is written against these helpers — never
-- against inline sub-selects (a policy on employees would recurse into
-- itself). SECURITY DEFINER + SET search_path = '' per §4.2: definer rights
-- stop the recursion, the empty search_path with fully-qualified names blocks
-- search-path hijack.
--
-- Forward references: current_employee_id/reportee_ids/... read
-- public.employees (created in 008) and is_manager_of reads
-- public.delegations (created in 029). LANGUAGE sql bodies are therefore
-- created with check_function_bodies = off (validation happens on first
-- execution, by which time the tables exist). This mirrors how Supabase
-- itself ships auth helper migrations.
-- =============================================================================

BEGIN;

SET LOCAL check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────
-- Request context. The API layer (edge functions and PostgREST
-- pre-request hook) sets these with set_config(..., true) so they
-- are transaction-scoped and cannot leak between requests.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.ctx(p_key text)
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(current_setting('app.' || p_key, true), '');
$$;

CREATE OR REPLACE FUNCTION app.ctx_actor_id()
RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(
    nullif(current_setting('app.actor_id', true), '')::uuid,  -- edge function acting for a user
    auth.uid()                                                -- normal PostgREST session
  );
$$;

CREATE OR REPLACE FUNCTION app.current_employee_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id
  FROM public.employees e
  WHERE e.profile_id = app.ctx_actor_id()
    AND e.deleted_at IS NULL
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app.is_active_user()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = app.ctx_actor_id() AND p.is_active
  );
$$;

CREATE OR REPLACE FUNCTION app.has_role(p_role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  -- role hierarchy: super_admin > admin > manager > employee
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = app.ctx_actor_id()
      AND ur.revoked_at IS NULL
      AND (
        ur.role = p_role
        OR (p_role = 'admin'    AND ur.role = 'super_admin')
        OR (p_role = 'manager'  AND ur.role IN ('admin','super_admin'))
        OR (p_role = 'employee' AND ur.role IN ('manager','admin','super_admin'))
      )
  );
$$;

CREATE OR REPLACE FUNCTION app.is_admin()       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app.has_role('admin')       AND app.is_active_user() $$;
CREATE OR REPLACE FUNCTION app.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app.has_role('super_admin') AND app.is_active_user() $$;
CREATE OR REPLACE FUNCTION app.is_manager()     RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app.has_role('manager')     AND app.is_active_user() $$;

-- ─────────────────────────────────────────────────────────────
-- Team scope: recursive CTE over reporting_manager_id.
-- Returns every employee at or below p_manager_employee_id.
-- max_depth guards against a cycle that slipped past the guard trigger.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.reportee_ids(p_manager_employee_id uuid, p_max_depth integer DEFAULT 8)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH RECURSIVE tree AS (
    SELECT e.id, 1 AS depth
    FROM public.employees e
    WHERE e.reporting_manager_id = p_manager_employee_id
      AND e.deleted_at IS NULL
    UNION ALL
    SELECT e.id, t.depth + 1
    FROM public.employees e
    JOIN tree t ON e.reporting_manager_id = t.id
    WHERE e.deleted_at IS NULL
      AND t.depth < p_max_depth
  )
  SELECT id FROM tree;
$$;

CREATE OR REPLACE FUNCTION app.direct_reportee_ids(p_manager_employee_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id FROM public.employees e
  WHERE e.reporting_manager_id = p_manager_employee_id AND e.deleted_at IS NULL;
$$;

-- Dotted-line reportees are visible for rostering/attendance but NOT for
-- leave approval or salary. Kept separate on purpose.
CREATE OR REPLACE FUNCTION app.dotted_reportee_ids(p_manager_employee_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id FROM public.employees e
  WHERE e.dotted_line_manager_id = p_manager_employee_id AND e.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION app.is_manager_of(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.reportee_ids(app.current_employee_id()) r WHERE r = p_employee_id
  )
  OR EXISTS (  -- active delegation of team view
    SELECT 1
    FROM public.delegations d
    JOIN public.employees me ON me.profile_id = d.delegator_profile_id
    WHERE d.delegate_profile_id = app.ctx_actor_id()
      AND d.is_active
      AND d.scope = 'approvals_and_team_view'
      AND CURRENT_DATE BETWEEN d.from_date AND COALESCE(d.to_date, CURRENT_DATE)
      AND p_employee_id IN (SELECT app.reportee_ids(me.id))
  );
$$;

-- Scoped admin: which employees may this admin touch?
-- Returns NULL-free set; a 'global' assignment short-circuits to all.
CREATE OR REPLACE FUNCTION app.admin_scope_covers(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_super_admin()
      OR EXISTS (SELECT 1 FROM public.employee_role_assignments a
                 WHERE a.profile_id = app.ctx_actor_id() AND a.role = 'admin'
                   AND a.scope_kind = 'global'
                   AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE))
      OR EXISTS (SELECT 1
                 FROM public.employee_role_assignments a
                 JOIN public.employees e ON e.id = p_employee_id
                 WHERE a.profile_id = app.ctx_actor_id() AND a.role = 'admin'
                   AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE)
                   AND (
                        (a.scope_kind = 'company'       AND a.company_id    = e.company_id)
                     OR (a.scope_kind = 'location'      AND a.location_id   = e.location_id)
                     OR (a.scope_kind = 'department'    AND a.department_id = e.department_id)
                     OR (a.scope_kind = 'section'       AND a.section_id    = e.section_id)
                     OR (a.scope_kind = 'employee_list' AND e.id = ANY(a.employee_ids))
                   ));
$$;

-- Composite predicate used by nearly every policy.
CREATE OR REPLACE FUNCTION app.can_see_employee(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_employee_id = app.current_employee_id()
      OR app.is_manager_of(p_employee_id)
      OR (app.is_admin() AND app.admin_scope_covers(p_employee_id));
$$;

-- Reason gate for policies that require justification on write.
CREATE OR REPLACE FUNCTION app.has_reason(p_min_length integer DEFAULT 10)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT length(btrim(coalesce(app.ctx('reason'), ''))) >= p_min_length;
$$;

-- ─────────────────────────────────────────────────────────────
-- PostgREST pre-request hook (§5.5). Configured via
-- PGRST_DB_PRE_REQUEST / config.toml. Reads JWT-adjacent request
-- headers and applies the same transaction-scoped set_config calls
-- the edge functions make, so audit.log_changes() resolves an
-- identical context whichever door the write came through.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.pgrst_pre_request()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
BEGIN
  PERFORM set_config('app.source', 'web_employee', true);
  PERFORM set_config('app.request_id',
    coalesce(nullif(v_headers->>'x-request-id', ''), gen_random_uuid()::text), true);
  PERFORM set_config('app.reason',
    coalesce(v_headers->>'x-reason', ''), true);
  PERFORM set_config('app.device_id',
    coalesce(v_headers->>'x-client-device', ''), true);
  PERFORM set_config('app.ip',
    coalesce(split_part(v_headers->>'x-forwarded-for', ',', 1), ''), true);
  PERFORM set_config('app.user_agent',
    coalesce(v_headers->>'user-agent', ''), true);
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- Grants (§4.2 note): every definer function is REVOKEd from
-- public then GRANTed to authenticated individually. service_role
-- gets the same set — edge functions call these after set_context.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn   text;
  v_role text;
  v_fns  text[] := ARRAY[
    'app.ctx(text)',
    'app.ctx_actor_id()',
    'app.current_employee_id()',
    'app.is_active_user()',
    'app.has_role(public.app_role)',
    'app.is_admin()',
    'app.is_super_admin()',
    'app.is_manager()',
    'app.reportee_ids(uuid, integer)',
    'app.direct_reportee_ids(uuid)',
    'app.dotted_reportee_ids(uuid)',
    'app.is_manager_of(uuid)',
    'app.admin_scope_covers(uuid)',
    'app.can_see_employee(uuid)',
    'app.has_reason(integer)',
    'app.pgrst_pre_request()'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', v_role);
      FOREACH v_fn IN ARRAY v_fns LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_fn, v_role);
      END LOOP;
    ELSE
      RAISE NOTICE 'role % does not exist here, grant skipped', v_role;
    END IF;
  END LOOP;

  -- anon may resolve the pre-request hook (PostgREST calls it before auth
  -- decisions on public endpoints) but nothing else in app.*.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT USAGE ON SCHEMA app TO anon;
    GRANT EXECUTE ON FUNCTION app.pgrst_pre_request() TO anon;
  END IF;
END $$;

COMMIT;
