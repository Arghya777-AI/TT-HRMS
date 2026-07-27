-- =============================================================================
-- Migration 029 — Workflow & Approvals
-- Source: docs/plan/04-data-model.md §3.13 (lines 2388–2454);
--         spec-migrations §2 row 029.
--
-- One generic approvals engine drives every request type: the Approvals inbox
-- is a single query over approval_requests and the SLA/escalation logic
-- exists exactly once (sla_sweep).
--
-- Enums approval_status / approval_action were created in 003.
-- Engine functions live in `public` (doc §3.13 says "rpc.act_on_approval",
-- but 001 creates no `rpc` schema; every other engine function — resolve_*,
-- compute_* — lives in public, so these do too. PostgREST exposes them as
-- /rpc/* regardless).
--
-- Writes to approval_requests / approval_actions never come from clients:
-- status/current_level are engine-owned (SECURITY DEFINER RPCs). Clients only
-- ever call create_approval_request / act_on_approval.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. request_types — lookup shape + routing/SLA config
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.request_types (
  id                        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                      text NOT NULL,
  name                      text NOT NULL,
  description               text,
  sort_order                integer NOT NULL DEFAULT 100,
  is_active                 boolean NOT NULL DEFAULT true,
  detail_table              text NOT NULL,
  default_approval_chain_id uuid,   -- FK added below, after approval_chains exists
  sla_hours                 integer NOT NULL DEFAULT 48,
  escalation_hours          integer,
  -- NULL = never auto-approve. Decision (§3.13): NULL for everything with
  -- money or attendance impact — silence is not consent.
  auto_approve_after_hours  integer,
  allows_withdrawal         boolean NOT NULL DEFAULT true,
  allows_partial_approval   boolean NOT NULL DEFAULT false,
  requires_attachment       boolean NOT NULL DEFAULT false,
  icon                      text,
  form_schema               jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                timestamptz,
  deleted_by                uuid REFERENCES public.profiles(id),
  deletion_reason           text,
  CONSTRAINT ck_request_types__detail_table CHECK (detail_table IN
    ('leave_requests','attendance_regularizations','employee_change_requests',
     'reimbursement_claims','comp_off_ledger','asset_allocations','contracts',
     'employee_salary_revisions','resignations','travel_requisitions',
     'overtime_preapprovals','shift_swaps','web_punch_requests',
     'income_tax_declarations','document_requests','advance_requests')),
  CONSTRAINT ck_request_types__sla_hours CHECK (sla_hours > 0),
  CONSTRAINT ck_request_types__escalation_hours CHECK (escalation_hours IS NULL OR escalation_hours > 0),
  CONSTRAINT ck_request_types__auto_approve CHECK (auto_approve_after_hours IS NULL OR auto_approve_after_hours > 0),
  CONSTRAINT ck_request_types__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_request_types__code
  ON public.request_types (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_request_types__company ON public.request_types (company_id);
CREATE INDEX IF NOT EXISTS idx_request_types__default_chain
  ON public.request_types (default_approval_chain_id) WHERE default_approval_chain_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_request_types__stamp ON public.request_types;
CREATE TRIGGER trg_request_types__stamp BEFORE INSERT ON public.request_types
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_request_types__touch ON public.request_types;
CREATE TRIGGER trg_request_types__touch BEFORE UPDATE ON public.request_types
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.request_types ENABLE ROW LEVEL SECURITY;

-- P7: employees need the launcher list (My Applications); admins see all.
DROP POLICY IF EXISTS request_types__all_read ON public.request_types;
CREATE POLICY request_types__all_read ON public.request_types
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS request_types__admin_read ON public.request_types;
CREATE POLICY request_types__admin_read ON public.request_types
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS request_types__admin_write ON public.request_types;
CREATE POLICY request_types__admin_write ON public.request_types
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 2. approval_chains — routing rules (amount/days/department/grade selectors)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.approval_chains (
  id                          uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                  uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  request_type_id             uuid REFERENCES public.request_types(id) ON DELETE CASCADE,
  code                        text NOT NULL,
  name                        text NOT NULL,
  description                 text,
  sort_order                  integer NOT NULL DEFAULT 100,
  is_active                   boolean NOT NULL DEFAULT true,
  applies_to_department_ids   uuid[],
  applies_to_grade_ids        uuid[],
  applies_to_employment_types public.employment_type[],
  amount_from                 numeric(14,2),
  amount_to                   numeric(14,2),
  days_from                   numeric(6,2),
  days_to                     numeric(6,2),
  priority                    smallint NOT NULL DEFAULT 100,
  is_default                  boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                  timestamptz,
  deleted_by                  uuid REFERENCES public.profiles(id),
  deletion_reason             text,
  CONSTRAINT ck_approval_chains__amount_range CHECK (
    amount_from IS NULL OR amount_to IS NULL OR amount_to >= amount_from),
  CONSTRAINT ck_approval_chains__days_range CHECK (
    days_from IS NULL OR days_to IS NULL OR days_to >= days_from),
  CONSTRAINT ck_approval_chains__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_chains__code
  ON public.approval_chains (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_approval_chains__request_type
  ON public.approval_chains (request_type_id);
CREATE INDEX IF NOT EXISTS idx_approval_chains__company
  ON public.approval_chains (company_id);

DROP TRIGGER IF EXISTS trg_approval_chains__stamp ON public.approval_chains;
CREATE TRIGGER trg_approval_chains__stamp BEFORE INSERT ON public.approval_chains
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_approval_chains__touch ON public.approval_chains;
CREATE TRIGGER trg_approval_chains__touch BEFORE UPDATE ON public.approval_chains
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.approval_chains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_chains__all_read ON public.approval_chains;
CREATE POLICY approval_chains__all_read ON public.approval_chains
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS approval_chains__admin_read ON public.approval_chains;
CREATE POLICY approval_chains__admin_read ON public.approval_chains
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS approval_chains__admin_write ON public.approval_chains;
CREATE POLICY approval_chains__admin_write ON public.approval_chains
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- request_types.default_approval_chain_id → approval_chains (same file, so a
-- plain guarded ALTER, not the deferred-FK sweep).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_request_types__default_chain'
      AND conrelid = 'public.request_types'::regclass)
  THEN
    ALTER TABLE public.request_types
      ADD CONSTRAINT fk_request_types__default_chain
      FOREIGN KEY (default_approval_chain_id)
      REFERENCES public.approval_chains(id) ON DELETE SET NULL;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. approval_chain_levels
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.approval_chain_levels (
  id                        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  approval_chain_id         uuid NOT NULL REFERENCES public.approval_chains(id) ON DELETE CASCADE,
  level                     integer NOT NULL,
  approver_kind             text NOT NULL,
  specific_employee_id      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  role                      public.app_role,
  min_approvals             integer NOT NULL DEFAULT 1,
  is_optional               boolean NOT NULL DEFAULT false,
  can_edit_request          boolean NOT NULL DEFAULT false,
  sla_hours                 integer,
  escalate_to_kind          text,
  -- avoids "approve your own request" when the requester IS the manager
  skip_if_same_as_previous  boolean NOT NULL DEFAULT true,
  notify_only               boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_acl__level CHECK (level >= 1),
  CONSTRAINT ck_acl__min_approvals CHECK (min_approvals >= 1),
  CONSTRAINT ck_acl__sla_hours CHECK (sla_hours IS NULL OR sla_hours > 0),
  CONSTRAINT ck_acl__approver_kind CHECK (approver_kind IN
    ('reporting_manager','dotted_line_manager','skip_level_manager','department_head',
     'location_head','specific_employee','role','any_of_role','hr_admin','finance','super_admin')),
  CONSTRAINT ck_acl__escalate_to_kind CHECK (escalate_to_kind IS NULL OR escalate_to_kind IN
    ('reporting_manager','dotted_line_manager','skip_level_manager','department_head',
     'location_head','specific_employee','role','any_of_role','hr_admin','finance','super_admin')),
  CONSTRAINT ck_acl__specific_needs_employee CHECK (
    approver_kind <> 'specific_employee' OR specific_employee_id IS NOT NULL),
  CONSTRAINT ck_acl__role_kinds_need_role CHECK (
    approver_kind NOT IN ('role','any_of_role') OR role IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acl__chain_level
  ON public.approval_chain_levels (approval_chain_id, level);
CREATE INDEX IF NOT EXISTS idx_acl__specific_employee
  ON public.approval_chain_levels (specific_employee_id) WHERE specific_employee_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_approval_chain_levels__stamp ON public.approval_chain_levels;
CREATE TRIGGER trg_approval_chain_levels__stamp BEFORE INSERT ON public.approval_chain_levels
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_approval_chain_levels__touch ON public.approval_chain_levels;
CREATE TRIGGER trg_approval_chain_levels__touch BEFORE UPDATE ON public.approval_chain_levels
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.approval_chain_levels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acl__all_read ON public.approval_chain_levels;
CREATE POLICY acl__all_read ON public.approval_chain_levels
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.approval_chains c
                 WHERE c.id = approval_chain_id
                   AND ((c.is_active AND c.deleted_at IS NULL) OR app.is_admin())));

DROP POLICY IF EXISTS acl__admin_write ON public.approval_chain_levels;
CREATE POLICY acl__admin_write ON public.approval_chain_levels
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 4. approval_requests — the generic spine
-- -----------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.seq_approval_request_number;

CREATE TABLE IF NOT EXISTS public.approval_requests (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_number       text NOT NULL,
  request_type_id      uuid NOT NULL REFERENCES public.request_types(id) ON DELETE RESTRICT,
  approval_chain_id    uuid NOT NULL REFERENCES public.approval_chains(id) ON DELETE RESTRICT,
  detail_table         text NOT NULL,   -- denormalised for polymorphic joins
  detail_id            uuid NOT NULL,
  subject_employee_id  uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  raised_by            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  on_behalf_of         uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  title                text NOT NULL,
  summary              jsonb NOT NULL DEFAULT '{}',
  amount               numeric(14,2),
  days                 numeric(6,2),
  status               public.approval_status NOT NULL DEFAULT 'pending',
  current_level        integer NOT NULL DEFAULT 1,
  total_levels         integer NOT NULL,
  -- materialised so the inbox is WHERE app.current_employee_id() = ANY(...)
  current_approver_ids uuid[] NOT NULL DEFAULT '{}',
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  sla_due_at           timestamptz NOT NULL,
  first_action_at      timestamptz,
  decided_at           timestamptz,
  decided_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decision_comment     text,
  applied_at           timestamptz,
  apply_error          text,
  cancelled_at         timestamptz,
  cancelled_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancellation_reason  text,
  escalated_at         timestamptz,
  escalated_to         uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  priority             text NOT NULL DEFAULT 'normal',
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ar__priority CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT ck_ar__levels CHECK (total_levels >= 1 AND current_level >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ar__request_number
  ON public.approval_requests (request_number);
CREATE INDEX IF NOT EXISTS idx_ar__approver_pending
  ON public.approval_requests USING gin (current_approver_ids)
  WHERE status IN ('pending','in_progress','escalated');
CREATE INDEX IF NOT EXISTS idx_ar__subject_status
  ON public.approval_requests (subject_employee_id, status);
CREATE INDEX IF NOT EXISTS idx_ar__sla
  ON public.approval_requests (sla_due_at)
  WHERE status IN ('pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_ar__detail
  ON public.approval_requests (detail_table, detail_id);
CREATE INDEX IF NOT EXISTS idx_ar__request_type ON public.approval_requests (request_type_id);
CREATE INDEX IF NOT EXISTS idx_ar__chain        ON public.approval_requests (approval_chain_id);
CREATE INDEX IF NOT EXISTS idx_ar__raised_by    ON public.approval_requests (raised_by);

DROP TRIGGER IF EXISTS trg_approval_requests__stamp ON public.approval_requests;
CREATE TRIGGER trg_approval_requests__stamp BEFORE INSERT ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_approval_requests__touch ON public.approval_requests;
CREATE TRIGGER trg_approval_requests__touch BEFORE UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

-- P1: subject or raiser (HR raising on behalf sees what they raised)
DROP POLICY IF EXISTS ar__self_read ON public.approval_requests;
CREATE POLICY ar__self_read ON public.approval_requests
  FOR SELECT TO authenticated
  USING (subject_employee_id = app.current_employee_id()
      OR on_behalf_of = app.current_employee_id()
      OR raised_by = app.ctx_actor_id());

-- Approver read: the materialised inbox predicate
DROP POLICY IF EXISTS ar__approver_read ON public.approval_requests;
CREATE POLICY ar__approver_read ON public.approval_requests
  FOR SELECT TO authenticated
  USING (app.current_employee_id() = ANY (current_approver_ids));

-- P8 admin
DROP POLICY IF EXISTS ar__admin_read ON public.approval_requests;
CREATE POLICY ar__admin_read ON public.approval_requests
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(subject_employee_id));

-- status/current_level are never client-writable: no INSERT/UPDATE/DELETE
-- policy exists for authenticated. All actions go through
-- public.act_on_approval / public.create_approval_request (SECURITY DEFINER).

-- -----------------------------------------------------------------------------
-- 5. approval_actions — append-only decision trail
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.approval_actions (
  id                      uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  approval_request_id     uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  level                   integer NOT NULL,
  actor_id                uuid REFERENCES public.profiles(id) ON DELETE SET NULL,  -- NULL = system (sweep)
  actor_role              public.app_role,
  acted_as                text,
  delegated_from          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action                  public.approval_action NOT NULL,
  comment                 text,
  payload                 jsonb,   -- edits made, e.g. approved days reduced
  ip                      inet,
  user_agent              text,
  device_id               text,
  acted_at                timestamptz NOT NULL DEFAULT now(),
  time_to_action_seconds  integer,
  CONSTRAINT ck_aa__acted_as CHECK (acted_as IS NULL OR acted_as IN
    ('approver','delegate','escalation','admin_override'))
);

CREATE INDEX IF NOT EXISTS idx_aa__request_level
  ON public.approval_actions (approval_request_id, level);
CREATE INDEX IF NOT EXISTS idx_aa__actor_time
  ON public.approval_actions (actor_id, acted_at DESC);

ALTER TABLE public.approval_actions ENABLE ROW LEVEL SECURITY;

-- Inherits the parent request's audience (the EXISTS runs under the caller's
-- RLS on approval_requests, which is exactly the visibility we want).
DROP POLICY IF EXISTS aa__via_request_read ON public.approval_actions;
CREATE POLICY aa__via_request_read ON public.approval_actions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.approval_requests r
                 WHERE r.id = approval_request_id));

-- Append-only: no UPDATE/DELETE ever, for anyone.
DROP TRIGGER IF EXISTS trg_approval_actions__immutable ON public.approval_actions;
CREATE TRIGGER trg_approval_actions__immutable
  BEFORE UPDATE OR DELETE ON public.approval_actions
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

-- -----------------------------------------------------------------------------
-- 6. delegations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delegations (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  delegator_profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  delegate_profile_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_type_ids      uuid[],   -- NULL = all request types
  scope                 text NOT NULL DEFAULT 'approvals',
  from_date             date NOT NULL,
  to_date               date,
  reason                text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_delegations__scope CHECK (scope IN ('approvals','approvals_and_team_view')),
  CONSTRAINT ck_delegations__no_self CHECK (delegator_profile_id <> delegate_profile_id),
  CONSTRAINT ck_delegations__dates CHECK (
    to_date IS NULL OR (to_date >= from_date AND to_date <= DATE '2100-01-01'))
);

CREATE INDEX IF NOT EXISTS idx_delegations__delegator
  ON public.delegations (delegator_profile_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_delegations__delegate
  ON public.delegations (delegate_profile_id) WHERE is_active;

-- No overlapping active delegation for the same delegator + request type;
-- max chain depth 1 (a delegate cannot re-delegate). Array-overlap semantics
-- with NULL = all cannot be expressed as an exclusion constraint, hence a
-- guard trigger.
CREATE OR REPLACE FUNCTION public.delegations_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;

  -- depth 1: the delegator must not themselves be an active delegate ...
  IF EXISTS (
    SELECT 1 FROM public.delegations d
    WHERE d.delegate_profile_id = NEW.delegator_profile_id
      AND d.is_active
      AND daterange(d.from_date, COALESCE(d.to_date, DATE '2100-01-01'), '[]')
       && daterange(NEW.from_date, COALESCE(NEW.to_date, DATE '2100-01-01'), '[]'))
  THEN
    RAISE EXCEPTION 'delegation chain depth exceeds 1: % is already a delegate', NEW.delegator_profile_id
      USING errcode = '23514';
  END IF;
  -- ... and the delegate must not already be an active delegator.
  IF EXISTS (
    SELECT 1 FROM public.delegations d
    WHERE d.delegator_profile_id = NEW.delegate_profile_id
      AND d.is_active
      AND daterange(d.from_date, COALESCE(d.to_date, DATE '2100-01-01'), '[]')
       && daterange(NEW.from_date, COALESCE(NEW.to_date, DATE '2100-01-01'), '[]'))
  THEN
    RAISE EXCEPTION 'delegation chain depth exceeds 1: % already delegates their approvals', NEW.delegate_profile_id
      USING errcode = '23514';
  END IF;

  -- no overlapping active delegation for the same delegator + request type
  IF EXISTS (
    SELECT 1 FROM public.delegations d
    WHERE d.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND d.delegator_profile_id = NEW.delegator_profile_id
      AND d.is_active
      AND daterange(d.from_date, COALESCE(d.to_date, DATE '2100-01-01'), '[]')
       && daterange(NEW.from_date, COALESCE(NEW.to_date, DATE '2100-01-01'), '[]')
      AND (d.request_type_ids IS NULL
        OR NEW.request_type_ids IS NULL
        OR d.request_type_ids && NEW.request_type_ids))
  THEN
    RAISE EXCEPTION 'overlapping active delegation exists for this delegator and request type'
      USING errcode = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_delegations__guard ON public.delegations;
CREATE TRIGGER trg_delegations__guard
  BEFORE INSERT OR UPDATE ON public.delegations
  FOR EACH ROW EXECUTE FUNCTION public.delegations_guard();

DROP TRIGGER IF EXISTS trg_delegations__stamp ON public.delegations;
CREATE TRIGGER trg_delegations__stamp BEFORE INSERT ON public.delegations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_delegations__touch ON public.delegations;
CREATE TRIGGER trg_delegations__touch BEFORE UPDATE ON public.delegations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.delegations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delegations__own_read ON public.delegations;
CREATE POLICY delegations__own_read ON public.delegations
  FOR SELECT TO authenticated
  USING (delegator_profile_id = app.ctx_actor_id()
      OR delegate_profile_id = app.ctx_actor_id()
      OR app.is_admin());

-- A manager sets up their own delegation (the F&B manager on the floor for a
-- 12-hour wedding); admins can manage any.
DROP POLICY IF EXISTS delegations__own_insert ON public.delegations;
CREATE POLICY delegations__own_insert ON public.delegations
  FOR INSERT TO authenticated
  WITH CHECK (delegator_profile_id = app.ctx_actor_id() OR app.is_admin());

DROP POLICY IF EXISTS delegations__own_update ON public.delegations;
CREATE POLICY delegations__own_update ON public.delegations
  FOR UPDATE TO authenticated
  USING (delegator_profile_id = app.ctx_actor_id() OR app.is_admin())
  WITH CHECK (delegator_profile_id = app.ctx_actor_id() OR app.is_admin());

-- -----------------------------------------------------------------------------
-- 7. sla_breaches
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sla_breaches (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  approval_request_id  uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  level                integer NOT NULL,
  approver_id          uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  sla_due_at           timestamptz NOT NULL,
  breached_at          timestamptz NOT NULL DEFAULT now(),
  hours_overdue        numeric(9,2),
  escalated_to         uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  escalated_at         timestamptz,
  resolved_at          timestamptz,
  resolution           text,
  notified_count       integer NOT NULL DEFAULT 0,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sla_breaches__resolution CHECK (
    resolution IS NULL OR resolution IN ('acted','escalated','auto_approved','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_sla_breaches__request
  ON public.sla_breaches (approval_request_id, level);
CREATE INDEX IF NOT EXISTS idx_sla_breaches__approver_open
  ON public.sla_breaches (approver_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sla_breaches__escalated_to
  ON public.sla_breaches (escalated_to) WHERE escalated_to IS NOT NULL;

ALTER TABLE public.sla_breaches ENABLE ROW LEVEL SECURITY;

-- P5: a manager sees their own breaches — visibility drives behaviour.
DROP POLICY IF EXISTS sla_breaches__own_read ON public.sla_breaches;
CREATE POLICY sla_breaches__own_read ON public.sla_breaches
  FOR SELECT TO authenticated
  USING (approver_id = app.current_employee_id()
      OR escalated_to = app.current_employee_id());

DROP POLICY IF EXISTS sla_breaches__admin_read ON public.sla_breaches;
CREATE POLICY sla_breaches__admin_read ON public.sla_breaches
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- Writes: engine only (sla_sweep, SECURITY DEFINER) — no client policies.

-- -----------------------------------------------------------------------------
-- 8. resolve_approvers — kind → employee ids
-- -----------------------------------------------------------------------------

-- Core resolution of one approver kind for one subject. Used by both
-- resolve_approvers (chain levels) and sla_sweep (escalate_to_kind).
CREATE OR REPLACE FUNCTION public.resolve_approver_kind(
  p_kind text,
  p_role public.app_role,
  p_specific_employee_id uuid,
  p_subject_employee_id uuid)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_subject public.employees%ROWTYPE;
  v_ids     uuid[] := '{}';
BEGIN
  SELECT * INTO v_subject FROM public.employees WHERE id = p_subject_employee_id;
  IF NOT FOUND THEN
    RETURN '{}';
  END IF;

  CASE p_kind
    WHEN 'reporting_manager' THEN
      v_ids := ARRAY(SELECT v_subject.reporting_manager_id WHERE v_subject.reporting_manager_id IS NOT NULL);
    WHEN 'dotted_line_manager' THEN
      v_ids := ARRAY(SELECT v_subject.dotted_line_manager_id WHERE v_subject.dotted_line_manager_id IS NOT NULL);
    WHEN 'skip_level_manager' THEN
      v_ids := ARRAY(
        SELECT m.reporting_manager_id FROM public.employees m
        WHERE m.id = v_subject.reporting_manager_id
          AND m.reporting_manager_id IS NOT NULL
          AND m.deleted_at IS NULL);
    WHEN 'department_head' THEN
      v_ids := ARRAY(
        SELECT d.head_employee_id FROM public.departments d
        WHERE d.id = v_subject.department_id
          AND d.head_employee_id IS NOT NULL
          AND d.deleted_at IS NULL);
    WHEN 'location_head' THEN
      -- locations carry no head column (§3.2); the location head is whoever
      -- holds a location-scoped admin assignment for the subject's location.
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.employee_role_assignments a
        JOIN public.employees e ON e.profile_id = a.profile_id AND e.deleted_at IS NULL
        WHERE a.role = 'admin'
          AND a.scope_kind = 'location'
          AND a.location_id = v_subject.location_id
          AND CURRENT_DATE BETWEEN a.effective_from AND COALESCE(a.effective_to, CURRENT_DATE));
    WHEN 'specific_employee' THEN
      v_ids := ARRAY(
        SELECT e.id FROM public.employees e
        WHERE e.id = p_specific_employee_id AND e.deleted_at IS NULL);
    WHEN 'role', 'any_of_role' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.user_roles ur
        JOIN public.employees e ON e.profile_id = ur.user_id AND e.deleted_at IS NULL
        WHERE ur.role = p_role AND ur.revoked_at IS NULL);
    WHEN 'hr_admin' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.user_roles ur
        JOIN public.employees e ON e.profile_id = ur.user_id AND e.deleted_at IS NULL
        WHERE ur.role = 'admin' AND ur.revoked_at IS NULL);
    WHEN 'finance' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.employees e
        JOIN public.departments d ON d.id = e.department_id AND d.code = 'FIN' AND d.deleted_at IS NULL
        JOIN public.user_roles ur ON ur.user_id = e.profile_id AND ur.revoked_at IS NULL
        WHERE e.deleted_at IS NULL
          AND ur.role IN ('manager','admin','super_admin'));
    WHEN 'super_admin' THEN
      v_ids := ARRAY(
        SELECT DISTINCT e.id
        FROM public.user_roles ur
        JOIN public.employees e ON e.profile_id = ur.user_id AND e.deleted_at IS NULL
        WHERE ur.role = 'super_admin' AND ur.revoked_at IS NULL);
    ELSE
      v_ids := '{}';
  END CASE;

  RETURN COALESCE(v_ids, '{}');
END;
$$;

-- Resolve the approver set for one chain level + subject, with the admin
-- fallback ladder (hr_admin → super_admin) and delegation expansion.
CREATE OR REPLACE FUNCTION public.resolve_approvers(
  p_chain_level_id uuid,
  p_subject_employee_id uuid,
  p_request_type_id uuid DEFAULT NULL,
  p_expand_delegations boolean DEFAULT true)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_level public.approval_chain_levels%ROWTYPE;
  v_ids   uuid[];
BEGIN
  SELECT * INTO v_level FROM public.approval_chain_levels WHERE id = p_chain_level_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval chain level % not found', p_chain_level_id;
  END IF;

  v_ids := public.resolve_approver_kind(
    v_level.approver_kind, v_level.role, v_level.specific_employee_id, p_subject_employee_id);

  -- Fallback ladder: an unresolvable mandatory level lands with HR admins,
  -- then super-admins, so no request can strand ownerless.
  IF COALESCE(array_length(v_ids, 1), 0) = 0 AND NOT v_level.is_optional THEN
    v_ids := public.resolve_approver_kind('hr_admin', NULL, NULL, p_subject_employee_id);
    IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
      v_ids := public.resolve_approver_kind('super_admin', NULL, NULL, p_subject_employee_id);
    END IF;
  END IF;

  -- Delegation expansion (depth 1, approvals scope, active, date-covered,
  -- request-type-covered). The delegator stays in the set — they may still act.
  IF p_expand_delegations AND COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    v_ids := ARRAY(
      SELECT DISTINCT u FROM (
        SELECT unnest(v_ids) AS u
        UNION
        SELECT e2.id
        FROM public.delegations dl
        JOIN public.employees del ON del.profile_id = dl.delegator_profile_id
                                 AND del.id = ANY (v_ids)
        JOIN public.employees e2  ON e2.profile_id = dl.delegate_profile_id
                                 AND e2.deleted_at IS NULL
        WHERE dl.is_active
          AND dl.scope IN ('approvals','approvals_and_team_view')
          AND CURRENT_DATE BETWEEN dl.from_date AND COALESCE(dl.to_date, CURRENT_DATE)
          AND (dl.request_type_ids IS NULL
            OR p_request_type_id IS NULL
            OR p_request_type_id = ANY (dl.request_type_ids))
      ) s WHERE u IS NOT NULL);
  END IF;

  RETURN COALESCE(v_ids, '{}');
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. advance_approval — move a request to its next actionable level
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.advance_approval(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req        public.approval_requests%ROWTYPE;
  v_level      public.approval_chain_levels%ROWTYPE;
  v_ids        uuid[];
  v_last_actor uuid;   -- employee id of the most recent human actor
BEGIN
  SELECT * INTO v_req FROM public.approval_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request % not found', p_request_id;
  END IF;
  IF v_req.status NOT IN ('pending','in_progress','escalated') THEN
    RETURN;   -- already decided; nothing to advance
  END IF;

  SELECT e.id INTO v_last_actor
  FROM public.approval_actions a
  JOIN public.employees e ON e.profile_id = a.actor_id
  WHERE a.approval_request_id = p_request_id AND a.actor_id IS NOT NULL
  ORDER BY a.acted_at DESC LIMIT 1;

  FOR v_level IN
    SELECT * FROM public.approval_chain_levels
    WHERE approval_chain_id = v_req.approval_chain_id
      AND level > v_req.current_level
    ORDER BY level
  LOOP
    -- notify-only levels never hold the request
    IF v_level.notify_only THEN
      CONTINUE;
    END IF;

    v_ids := public.resolve_approvers(v_level.id, v_req.subject_employee_id, v_req.request_type_id);

    -- Never let the requester approve their own request: drop them when the
    -- level resolves to more people than just them.
    IF COALESCE(array_length(v_ids, 1), 0) > 1 THEN
      v_ids := array_remove(v_ids, v_req.subject_employee_id);
    END IF;

    -- skip_if_same_as_previous: the level collapses onto the requester or the
    -- actor who just approved — skip it rather than ask someone to approve
    -- their own work.
    IF v_level.skip_if_same_as_previous
       AND COALESCE(array_length(v_ids, 1), 0) > 0
       AND v_ids <@ ARRAY[v_req.subject_employee_id, v_last_actor]::uuid[]
    THEN
      INSERT INTO public.approval_actions
        (approval_request_id, level, actor_id, action, comment)
      VALUES
        (p_request_id, v_level.level, NULL, 'skip_level',
         'level skipped: approver identical to requester/previous approver');
      CONTINUE;
    END IF;

    IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
      IF v_level.is_optional THEN
        CONTINUE;   -- optional level with nobody to ask
      END IF;
      -- resolve_approvers already fell back to hr_admin/super_admin; an empty
      -- set here means the instance has no admins at all — leave the level in
      -- place so the console surfaces it.
    END IF;

    UPDATE public.approval_requests
    SET current_level        = v_level.level,
        current_approver_ids = v_ids,
        status               = CASE WHEN first_action_at IS NULL THEN 'pending'
                                    ELSE 'in_progress' END::public.approval_status
    WHERE id = p_request_id;
    RETURN;
  END LOOP;

  -- No actionable level remains: fully approved.
  UPDATE public.approval_requests
  SET status               = 'approved',
      decided_at           = now(),
      decided_by           = COALESCE(app.ctx_actor_id(), decided_by),
      current_approver_ids = '{}'
  WHERE id = p_request_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. create_approval_request
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_approval_request(
  p_request_type_code text,
  p_subject_employee_id uuid,
  p_detail_id uuid,
  p_title text,
  p_summary jsonb DEFAULT '{}'::jsonb,
  p_amount numeric DEFAULT NULL,
  p_days numeric DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_on_behalf_of uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rt      public.request_types%ROWTYPE;
  v_chain   public.approval_chains%ROWTYPE;
  v_subject public.employees%ROWTYPE;
  v_total   integer;
  v_id      uuid;
  v_number  text;
  v_raised  uuid;
BEGIN
  SELECT * INTO v_rt FROM public.request_types
  WHERE code = p_request_type_code AND is_active AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown or inactive request type %', p_request_type_code;
  END IF;

  SELECT * INTO v_subject FROM public.employees
  WHERE id = p_subject_employee_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown employee %', p_subject_employee_id;
  END IF;

  -- Chain selection: most specific matching active chain wins (lowest
  -- priority number first, then explicit default), falling back to the
  -- request type's default chain.
  SELECT c.* INTO v_chain
  FROM public.approval_chains c
  WHERE c.request_type_id = v_rt.id
    AND c.is_active AND c.deleted_at IS NULL
    AND (c.amount_from IS NULL OR (p_amount IS NOT NULL AND p_amount >= c.amount_from))
    AND (c.amount_to   IS NULL OR (p_amount IS NOT NULL AND p_amount <= c.amount_to))
    AND (c.days_from   IS NULL OR (p_days   IS NOT NULL AND p_days   >= c.days_from))
    AND (c.days_to     IS NULL OR (p_days   IS NOT NULL AND p_days   <= c.days_to))
    AND (c.applies_to_department_ids IS NULL OR v_subject.department_id = ANY (c.applies_to_department_ids))
    AND (c.applies_to_grade_ids      IS NULL OR v_subject.grade_id      = ANY (c.applies_to_grade_ids))
    AND (c.applies_to_employment_types IS NULL OR v_subject.employment_type = ANY (c.applies_to_employment_types))
  ORDER BY c.priority ASC, c.is_default DESC
  LIMIT 1;

  IF NOT FOUND AND v_rt.default_approval_chain_id IS NOT NULL THEN
    SELECT * INTO v_chain FROM public.approval_chains
    WHERE id = v_rt.default_approval_chain_id AND deleted_at IS NULL;
  END IF;
  IF v_chain.id IS NULL THEN
    RAISE EXCEPTION 'no approval chain matches request type % for employee %',
      p_request_type_code, p_subject_employee_id;
  END IF;

  SELECT count(*) INTO v_total
  FROM public.approval_chain_levels WHERE approval_chain_id = v_chain.id;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'approval chain % has no levels', v_chain.code;
  END IF;

  v_number := v_rt.code || '-' ||
              lpad(nextval('public.seq_approval_request_number')::text, 6, '0');
  v_raised := COALESCE(app.ctx_actor_id(), v_subject.profile_id);
  IF v_raised IS NULL THEN
    RAISE EXCEPTION 'cannot determine raising actor for approval request';
  END IF;

  INSERT INTO public.approval_requests
    (request_number, request_type_id, approval_chain_id, detail_table, detail_id,
     subject_employee_id, raised_by, on_behalf_of, title, summary, amount, days,
     status, current_level, total_levels, current_approver_ids,
     submitted_at, sla_due_at, priority)
  VALUES
    (v_number, v_rt.id, v_chain.id, v_rt.detail_table, p_detail_id,
     p_subject_employee_id, v_raised, p_on_behalf_of, p_title,
     COALESCE(p_summary, '{}'::jsonb), p_amount, p_days,
     'pending', 0, v_total, '{}',
     now(), now() + make_interval(hours => v_rt.sla_hours), COALESCE(p_priority, 'normal'))
  RETURNING id INTO v_id;

  INSERT INTO public.approval_actions
    (approval_request_id, level, actor_id, action, comment, payload)
  VALUES
    (v_id, 0, v_raised, 'submit', NULL,
     jsonb_build_object('request_number', v_number));

  PERFORM public.advance_approval(v_id);
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. act_on_approval — the single client-facing action RPC
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.act_on_approval(
  p_request_id uuid,
  p_action public.approval_action,
  p_comment text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req          public.approval_requests%ROWTYPE;
  v_rt           public.request_types%ROWTYPE;
  v_level        public.approval_chain_levels%ROWTYPE;
  v_actor        uuid := app.ctx_actor_id();
  v_actor_emp    uuid := app.current_employee_id();
  v_is_approver  boolean;
  v_is_admin     boolean := app.is_admin();
  v_is_subject   boolean;
  v_acted_as     text;
  v_delegated_from uuid;
  v_base_set     uuid[];
  v_approvals    integer;
  v_target_emp   uuid;
  v_tta          integer;
  v_ip           inet;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'no acting user in context';
  END IF;

  SELECT * INTO v_req FROM public.approval_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request % not found', p_request_id;
  END IF;
  SELECT * INTO v_rt FROM public.request_types WHERE id = v_req.request_type_id;
  SELECT * INTO v_level FROM public.approval_chain_levels
  WHERE approval_chain_id = v_req.approval_chain_id AND level = v_req.current_level;

  v_is_approver := v_actor_emp IS NOT NULL AND v_actor_emp = ANY (v_req.current_approver_ids);
  v_is_subject  := (v_actor_emp IS NOT NULL AND
                    (v_actor_emp = v_req.subject_employee_id OR v_actor_emp = v_req.on_behalf_of))
                   OR v_actor = v_req.raised_by;

  -- classify how the actor is acting (approver / delegate / admin_override)
  IF v_is_approver THEN
    v_base_set := CASE WHEN v_level.id IS NULL THEN '{}'::uuid[]
                       ELSE public.resolve_approvers(
                              v_level.id, v_req.subject_employee_id,
                              v_req.request_type_id, false) END;
    IF v_actor_emp = ANY (v_base_set) THEN
      v_acted_as := 'approver';
    ELSE
      v_acted_as := 'delegate';
      SELECT dl.delegator_profile_id INTO v_delegated_from
      FROM public.delegations dl
      JOIN public.employees del ON del.profile_id = dl.delegator_profile_id
      WHERE dl.delegate_profile_id = v_actor
        AND dl.is_active
        AND CURRENT_DATE BETWEEN dl.from_date AND COALESCE(dl.to_date, CURRENT_DATE)
        AND del.id = ANY (v_base_set)
      LIMIT 1;
    END IF;
  ELSIF v_is_admin THEN
    v_acted_as := 'admin_override';
  END IF;

  BEGIN
    v_ip := app.ctx('ip')::inet;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  v_tta := GREATEST(0, floor(extract(epoch FROM (now() - COALESCE(
    (SELECT max(acted_at) FROM public.approval_actions
     WHERE approval_request_id = p_request_id AND action <> 'comment'),
    v_req.submitted_at)))))::integer;

  -- ---------------------------------------------------------------- approve
  IF p_action = 'approve' THEN
    IF NOT (v_is_approver OR v_is_admin) THEN
      RAISE EXCEPTION 'not an approver for request %', v_req.request_number USING errcode = '42501';
    END IF;
    IF v_req.status NOT IN ('pending','in_progress','escalated') THEN
      RAISE EXCEPTION 'request % is already %', v_req.request_number, v_req.status;
    END IF;
    IF v_actor_emp IS NOT NULL AND v_actor_emp = v_req.subject_employee_id
       AND NOT v_is_admin THEN
      RAISE EXCEPTION 'an employee cannot approve their own request' USING errcode = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.approval_actions
               WHERE approval_request_id = p_request_id
                 AND level = v_req.current_level
                 AND action = 'approve' AND actor_id = v_actor) THEN
      RAISE EXCEPTION 'you have already approved level % of %', v_req.current_level, v_req.request_number;
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, actor_role, acted_as, delegated_from,
       action, comment, payload, ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor,
       CASE WHEN app.is_super_admin() THEN 'super_admin'
            WHEN v_is_admin THEN 'admin'
            WHEN app.is_manager() THEN 'manager' ELSE 'employee' END::public.app_role,
       v_acted_as, v_delegated_from, 'approve', p_comment, p_payload,
       v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    UPDATE public.approval_requests
    SET first_action_at = COALESCE(first_action_at, now()),
        decision_comment = COALESCE(p_comment, decision_comment)
    WHERE id = p_request_id;

    SELECT count(DISTINCT actor_id) INTO v_approvals
    FROM public.approval_actions
    WHERE approval_request_id = p_request_id
      AND level = v_req.current_level AND action = 'approve';

    IF v_approvals >= COALESCE(v_level.min_approvals, 1) OR v_is_admin AND NOT v_is_approver THEN
      -- level satisfied (an admin override always satisfies the level)
      UPDATE public.approval_requests
      SET decided_by = v_actor
      WHERE id = p_request_id;
      PERFORM public.advance_approval(p_request_id);
    ELSE
      UPDATE public.approval_requests
      SET status = 'in_progress',
          current_approver_ids = array_remove(current_approver_ids, v_actor_emp)
      WHERE id = p_request_id;
    END IF;

  -- ----------------------------------------------------------------- reject
  ELSIF p_action = 'reject' THEN
    IF NOT (v_is_approver OR v_is_admin) THEN
      RAISE EXCEPTION 'not an approver for request %', v_req.request_number USING errcode = '42501';
    END IF;
    IF v_req.status NOT IN ('pending','in_progress','escalated') THEN
      RAISE EXCEPTION 'request % is already %', v_req.request_number, v_req.status;
    END IF;
    IF length(btrim(COALESCE(p_comment, ''))) < 3 THEN
      RAISE EXCEPTION 'a rejection needs a comment';
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, actor_role, acted_as, delegated_from,
       action, comment, payload, ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor,
       CASE WHEN app.is_super_admin() THEN 'super_admin'
            WHEN v_is_admin THEN 'admin'
            WHEN app.is_manager() THEN 'manager' ELSE 'employee' END::public.app_role,
       v_acted_as, v_delegated_from, 'reject', p_comment, p_payload,
       v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    UPDATE public.approval_requests
    SET status = 'rejected',
        first_action_at = COALESCE(first_action_at, now()),
        decided_at = now(), decided_by = v_actor,
        decision_comment = p_comment,
        current_approver_ids = '{}'
    WHERE id = p_request_id;

  -- --------------------------------------------- request_info / provide_info
  ELSIF p_action IN ('request_info','provide_info','comment') THEN
    IF p_action = 'request_info' AND NOT (v_is_approver OR v_is_admin) THEN
      RAISE EXCEPTION 'not an approver for request %', v_req.request_number USING errcode = '42501';
    END IF;
    IF p_action = 'provide_info' AND NOT (v_is_subject OR v_is_admin) THEN
      RAISE EXCEPTION 'only the requester can provide info' USING errcode = '42501';
    END IF;
    IF p_action = 'comment' AND NOT (v_is_subject OR v_is_approver OR v_is_admin) THEN
      RAISE EXCEPTION 'no access to request %', v_req.request_number USING errcode = '42501';
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, acted_as, delegated_from,
       action, comment, payload, ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor, v_acted_as, v_delegated_from,
       p_action, p_comment, p_payload, v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    IF p_action = 'request_info' THEN
      UPDATE public.approval_requests
      SET status = 'in_progress', first_action_at = COALESCE(first_action_at, now())
      WHERE id = p_request_id;
    END IF;

  -- ------------------------------------------------------ delegate / reassign
  ELSIF p_action IN ('delegate','reassign') THEN
    IF p_action = 'delegate' AND NOT v_is_approver THEN
      RAISE EXCEPTION 'only a current approver may delegate' USING errcode = '42501';
    END IF;
    IF p_action = 'reassign' AND NOT v_is_admin THEN
      RAISE EXCEPTION 'only an admin may reassign' USING errcode = '42501';
    END IF;
    v_target_emp := (p_payload ->> 'to_employee_id')::uuid;
    IF v_target_emp IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.employees WHERE id = v_target_emp AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'payload.to_employee_id must name an active employee';
    END IF;
    IF v_target_emp = v_req.subject_employee_id THEN
      RAISE EXCEPTION 'cannot hand an approval to its own requester';
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, acted_as, delegated_from,
       action, comment, payload, ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor, v_acted_as, v_delegated_from,
       p_action, p_comment, p_payload, v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    UPDATE public.approval_requests
    SET current_approver_ids =
          (SELECT ARRAY(SELECT DISTINCT x FROM unnest(
             CASE WHEN p_action = 'reassign'
                  THEN array_remove(current_approver_ids, v_actor_emp)
                  ELSE current_approver_ids END || v_target_emp) AS x)),
        first_action_at = COALESCE(first_action_at, now()),
        status = CASE WHEN status = 'pending' THEN 'in_progress'::public.approval_status ELSE status END
    WHERE id = p_request_id;

  -- --------------------------------------------------------------- escalate
  ELSIF p_action = 'escalate' THEN
    IF NOT (v_is_approver OR v_is_admin) THEN
      RAISE EXCEPTION 'not an approver for request %', v_req.request_number USING errcode = '42501';
    END IF;
    v_target_emp := (p_payload ->> 'to_employee_id')::uuid;
    IF v_target_emp IS NULL AND v_level.escalate_to_kind IS NOT NULL THEN
      v_target_emp := (public.resolve_approver_kind(
        v_level.escalate_to_kind, v_level.role, v_level.specific_employee_id,
        v_req.subject_employee_id))[1];
    END IF;
    IF v_target_emp IS NULL THEN
      RAISE EXCEPTION 'no escalation target: pass payload.to_employee_id or set escalate_to_kind';
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, acted_as, delegated_from,
       action, comment, payload, ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor, v_acted_as, v_delegated_from,
       'escalate', p_comment, p_payload, v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    UPDATE public.approval_requests
    SET status = 'escalated',
        escalated_at = now(),
        escalated_to = v_target_emp,
        first_action_at = COALESCE(first_action_at, now()),
        current_approver_ids =
          (SELECT ARRAY(SELECT DISTINCT x
                        FROM unnest(current_approver_ids || v_target_emp) AS x))
    WHERE id = p_request_id;

  -- ---------------------------------------------------------- recall / cancel
  ELSIF p_action = 'recall' THEN
    IF NOT v_is_subject THEN
      RAISE EXCEPTION 'only the requester can recall' USING errcode = '42501';
    END IF;
    IF NOT v_rt.allows_withdrawal THEN
      RAISE EXCEPTION 'request type % does not allow withdrawal', v_rt.code;
    END IF;
    IF v_req.status NOT IN ('pending','in_progress','escalated') THEN
      RAISE EXCEPTION 'request % is already %', v_req.request_number, v_req.status;
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, action, comment, payload,
       ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor, 'recall', p_comment, p_payload,
       v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    UPDATE public.approval_requests
    SET status = 'withdrawn', current_approver_ids = '{}',
        decided_at = now(), decided_by = v_actor
    WHERE id = p_request_id;

  ELSIF p_action = 'cancel' THEN
    IF NOT (v_is_subject OR v_is_admin) THEN
      RAISE EXCEPTION 'only the requester or an admin can cancel' USING errcode = '42501';
    END IF;
    IF v_req.status NOT IN ('pending','in_progress','escalated') THEN
      RAISE EXCEPTION 'request % is already %', v_req.request_number, v_req.status;
    END IF;

    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, acted_as, action, comment, payload,
       ip, user_agent, device_id, time_to_action_seconds)
    VALUES
      (p_request_id, v_req.current_level, v_actor,
       CASE WHEN v_is_admin AND NOT v_is_subject THEN 'admin_override' ELSE NULL END,
       'cancel', p_comment, p_payload,
       v_ip, app.ctx('user_agent'), app.ctx('device_id'), v_tta);

    UPDATE public.approval_requests
    SET status = 'cancelled',
        cancelled_at = now(), cancelled_by = v_actor,
        cancellation_reason = COALESCE(p_comment, 'cancelled'),
        current_approver_ids = '{}'
    WHERE id = p_request_id;

  ELSE
    -- submit / auto_approve / skip_level are engine-internal
    RAISE EXCEPTION 'action % is not client-actionable', p_action;
  END IF;

  SELECT * INTO v_req FROM public.approval_requests WHERE id = p_request_id;
  RETURN jsonb_build_object(
    'id', v_req.id,
    'request_number', v_req.request_number,
    'status', v_req.status,
    'current_level', v_req.current_level,
    'current_approver_ids', to_jsonb(v_req.current_approver_ids));
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. sla_sweep — every 30 min (scheduled in 041)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sla_sweep()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req        record;
  v_level      public.approval_chain_levels%ROWTYPE;
  v_new        integer := 0;
  v_ins        integer;
  v_esc_ids    uuid[];
  v_approver   uuid;
BEGIN
  -- 1. Close breaches whose request has since been decided.
  UPDATE public.sla_breaches b
  SET resolved_at = now(),
      resolution  = CASE r.status
                      WHEN 'auto_approved' THEN 'auto_approved'
                      WHEN 'cancelled'     THEN 'cancelled'
                      WHEN 'withdrawn'     THEN 'cancelled'
                      WHEN 'expired'       THEN 'cancelled'
                      ELSE 'acted'
                    END
  FROM public.approval_requests r
  WHERE r.id = b.approval_request_id
    AND b.resolved_at IS NULL
    AND r.status NOT IN ('pending','in_progress','escalated');

  -- 2. Auto-approve where the request type opted in (NULL = never; every
  --    money/attendance type is NULL — silence is not consent).
  FOR v_req IN
    SELECT r.id, r.current_level
    FROM public.approval_requests r
    JOIN public.request_types rt ON rt.id = r.request_type_id
    WHERE r.status IN ('pending','in_progress')
      AND rt.auto_approve_after_hours IS NOT NULL
      AND now() >= r.submitted_at + make_interval(hours => rt.auto_approve_after_hours)
  LOOP
    INSERT INTO public.approval_actions
      (approval_request_id, level, actor_id, action, comment)
    VALUES
      (v_req.id, v_req.current_level, NULL, 'auto_approve',
       'auto-approved: request type auto_approve_after_hours elapsed');
    UPDATE public.approval_requests
    SET status = 'auto_approved', decided_at = now(),
        decision_comment = 'auto-approved after configured hours',
        current_approver_ids = '{}'
    WHERE id = v_req.id;
    UPDATE public.sla_breaches
    SET resolved_at = now(), resolution = 'auto_approved'
    WHERE approval_request_id = v_req.id AND resolved_at IS NULL;
  END LOOP;

  -- 3. Record fresh breaches + escalate + notify.
  FOR v_req IN
    SELECT r.*
    FROM public.approval_requests r
    WHERE r.status IN ('pending','in_progress','escalated')
      AND r.sla_due_at < now()
    ORDER BY r.sla_due_at
  LOOP
    SELECT * INTO v_level FROM public.approval_chain_levels
    WHERE approval_chain_id = v_req.approval_chain_id AND level = v_req.current_level;

    -- one breach row per current approver, once per (request, level, approver)
    FOREACH v_approver IN ARRAY (CASE WHEN COALESCE(array_length(v_req.current_approver_ids,1),0) = 0
                                      THEN ARRAY[NULL::uuid] ELSE v_req.current_approver_ids END)
    LOOP
      INSERT INTO public.sla_breaches
        (approval_request_id, level, approver_id, sla_due_at, breached_at,
         hours_overdue, notified_count)
      SELECT v_req.id, v_req.current_level, v_approver, v_req.sla_due_at, now(),
             round((extract(epoch FROM (now() - v_req.sla_due_at)) / 3600.0)::numeric, 2), 1
      WHERE NOT EXISTS (
        SELECT 1 FROM public.sla_breaches b
        WHERE b.approval_request_id = v_req.id
          AND b.level = v_req.current_level
          AND b.approver_id IS NOT DISTINCT FROM v_approver
          AND b.resolved_at IS NULL);
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_new := v_new + v_ins;

      -- notify (in-app row; the notifier job fans out other channels).
      -- notifications is created in 027 (< this file in run order); guarded so
      -- a partial/older database still sweeps safely.
      IF v_ins > 0 AND v_approver IS NOT NULL
         AND to_regclass('public.notifications') IS NOT NULL THEN
        EXECUTE format($sql$
          INSERT INTO public.notifications
            (employee_id, profile_id, event_code, channel, title, body,
             deep_link, priority, status, dedupe_key)
          SELECT e.id, e.profile_id, 'APPROVAL_SLA_BREACH', 'in_app',
                 %L, %L, %L, 'high', 'queued', %L
          FROM public.employees e WHERE e.id = %L
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        $sql$,
          'Approval overdue: ' || v_req.title,
          'Request ' || v_req.request_number || ' has breached its SLA (due ' ||
            to_char(v_req.sla_due_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST).',
          '/approvals/' || v_req.id,
          'APPROVAL_SLA_BREACH:' || v_req.id || ':' || v_req.current_level || ':' || v_approver,
          v_approver);
      END IF;
    END LOOP;

    -- escalate once per level, per approval_chain_levels.escalate_to_kind
    IF v_req.escalated_at IS NULL
       AND v_level.id IS NOT NULL
       AND v_level.escalate_to_kind IS NOT NULL THEN
      v_esc_ids := public.resolve_approver_kind(
        v_level.escalate_to_kind, v_level.role, v_level.specific_employee_id,
        v_req.subject_employee_id);
      v_esc_ids := array_remove(v_esc_ids, v_req.subject_employee_id);
      IF COALESCE(array_length(v_esc_ids, 1), 0) > 0 THEN
        INSERT INTO public.approval_actions
          (approval_request_id, level, actor_id, acted_as, action, comment)
        VALUES
          (v_req.id, v_req.current_level, NULL, 'escalation', 'escalate',
           'SLA breach: escalated to ' || v_level.escalate_to_kind);
        UPDATE public.approval_requests
        SET status = 'escalated',
            escalated_at = now(),
            escalated_to = v_esc_ids[1],
            current_approver_ids =
              (SELECT ARRAY(SELECT DISTINCT x
                            FROM unnest(current_approver_ids || v_esc_ids) AS x))
        WHERE id = v_req.id;
        UPDATE public.sla_breaches
        SET escalated_to = v_esc_ids[1], escalated_at = now()
        WHERE approval_request_id = v_req.id
          AND level = v_req.current_level
          AND resolved_at IS NULL
          AND escalated_at IS NULL;
      END IF;
    END IF;
  END LOOP;

  RETURN v_new;
END;
$$;

-- -----------------------------------------------------------------------------
-- 13. Grants
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.resolve_approver_kind(text, public.app_role, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_approvers(uuid, uuid, uuid, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.advance_approval(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_approval_request(text, uuid, uuid, text, jsonb, numeric, numeric, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.act_on_approval(uuid, public.approval_action, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sla_sweep() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delegations_guard() FROM PUBLIC;

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.request_types, public.approval_chains, '
                     'public.approval_chain_levels, public.approval_requests, '
                     'public.approval_actions, public.delegations, public.sla_breaches FROM %I', v_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.request_types, public.approval_chains,
                    public.approval_chain_levels, public.approval_requests,
                    public.approval_actions, public.sla_breaches TO authenticated;
    -- reference-data maintenance (policy-gated to admins)
    GRANT INSERT, UPDATE ON public.request_types, public.approval_chains,
                            public.approval_chain_levels TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.delegations TO authenticated;
    GRANT EXECUTE ON FUNCTION public.create_approval_request(text, uuid, uuid, text, jsonb, numeric, numeric, text, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.act_on_approval(uuid, public.approval_action, text, jsonb) TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.request_types, public.approval_chains,
                                    public.approval_chain_levels, public.approval_requests,
                                    public.delegations, public.sla_breaches TO service_role;
    GRANT SELECT, INSERT ON public.approval_actions TO service_role;
    GRANT USAGE ON SEQUENCE public.seq_approval_request_number TO service_role;
    GRANT EXECUTE ON FUNCTION public.resolve_approver_kind(text, public.app_role, uuid, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.resolve_approvers(uuid, uuid, uuid, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION public.advance_approval(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.create_approval_request(text, uuid, uuid, text, jsonb, numeric, numeric, text, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.act_on_approval(uuid, public.approval_action, text, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.sla_sweep() TO service_role;
  END IF;
END $$;

COMMIT;
