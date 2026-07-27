-- =============================================================================
-- Migration 011 — employee lifecycle events + profile change requests
-- Source: docs/plan/04-data-model.md §3.3 (employee_lifecycle_events /
--         employee_change_requests, lines 1138–1191), §8.10
--         (apply_change_request), §8.11 (status projection);
--         spec-migrations §2 row 011.
--
-- employees.employment_status is a PROJECTION of the append-only lifecycle
-- event stream — never hand-edited. Profile edits outside the self-editable
-- whitelist travel as per-field change requests (maker-checker), applied by
-- apply_change_request() in one transaction with full audit.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. employee_lifecycle_events (append-only, reversal-by-event)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_lifecycle_events (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id           uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  event_type            public.lifecycle_event_type NOT NULL,
  effective_date        date NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  recorded_by           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reason                text NOT NULL,
  from_values           jsonb,
  to_values             jsonb,
  approval_request_id   uuid,   -- FK added by deferred sweep (approval_requests in 029)
  document_id           uuid,   -- FK added by deferred sweep (documents in 025)
  is_reversed           boolean NOT NULL DEFAULT false,
  reversed_by_event_id  uuid REFERENCES public.employee_lifecycle_events(id) ON DELETE SET NULL,
  CONSTRAINT ck_ele__reason CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT ck_ele__sane_date CHECK (effective_date < DATE '2100-01-01')
);

CREATE INDEX IF NOT EXISTS idx_ele__employee_date ON public.employee_lifecycle_events (employee_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_ele__type_date     ON public.employee_lifecycle_events (event_type, effective_date DESC);

-- Append-only, except flagging a row as reversed (the correction itself is a
-- new reversing event).
CREATE OR REPLACE FUNCTION public.ele_refuse_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_allowed text[] := ARRAY['is_reversed', 'reversed_by_event_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on employee_lifecycle_events is not permitted: reverse with a new event'
      USING errcode = '0A000';
  END IF;
  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'employee_lifecycle_events is append-only; only reversal flags may change'
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ele__append_only
  BEFORE UPDATE OR DELETE ON public.employee_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.ele_refuse_mutation();

-- Status projection (§8.11 trg_employees__status_projection).
CREATE OR REPLACE FUNCTION public.ele_status_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status public.employment_status;
  v_caller_reason text := coalesce(current_setting('app.reason', true), '');
BEGIN
  v_status := CASE NEW.event_type
    WHEN 'offer_accepted'      THEN 'pre_joining'
    WHEN 'joined'              THEN 'active'
    WHEN 'probation_started'   THEN 'on_probation'
    WHEN 'probation_extended'  THEN 'on_probation'
    WHEN 'confirmed'           THEN 'confirmed'
    WHEN 'suspended'           THEN 'suspended'
    WHEN 'reinstated'          THEN 'active'
    WHEN 'notice_started'      THEN 'on_notice'
    WHEN 'resigned'            THEN 'on_notice'
    WHEN 'terminated'          THEN 'exited'
    WHEN 'absconded'           THEN 'absconding'
    WHEN 'retired'             THEN 'retired'
    WHEN 'contract_ended'      THEN 'exited'
    WHEN 'deceased'            THEN 'exited'
    WHEN 'rehired'             THEN 'rehired'
    ELSE NULL  -- promoted/transferred/department_changed/manager_changed/salary_revised
  END;

  PERFORM set_config('app.reason',
    'lifecycle: ' || NEW.event_type || ' — ' || NEW.reason, true);

  UPDATE public.employees e SET
    employment_status = COALESCE(v_status, e.employment_status),
    confirmed_on      = CASE WHEN NEW.event_type = 'confirmed' THEN NEW.effective_date ELSE e.confirmed_on END,
    resignation_date  = CASE WHEN NEW.event_type = 'resigned'  THEN NEW.effective_date ELSE e.resignation_date END,
    last_working_day  = CASE WHEN NEW.event_type IN ('terminated','retired','contract_ended','deceased','absconded')
                             THEN NEW.effective_date ELSE e.last_working_day END,
    exit_type         = CASE NEW.event_type
                          WHEN 'resigned'       THEN 'resignation'
                          WHEN 'terminated'     THEN 'termination'
                          WHEN 'contract_ended' THEN 'end_of_contract'
                          WHEN 'retired'        THEN 'retirement'
                          WHEN 'absconded'      THEN 'absconding'
                          WHEN 'deceased'       THEN 'death'
                          ELSE e.exit_type
                        END
  WHERE e.id = NEW.employee_id;

  PERFORM set_config('app.reason', v_caller_reason, true);
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_ele__status_projection
  AFTER INSERT ON public.employee_lifecycle_events
  FOR EACH ROW WHEN (NOT NEW.is_reversed)
  EXECUTE FUNCTION public.ele_status_projection();

ALTER TABLE public.employee_lifecycle_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ele__scope_read ON public.employee_lifecycle_events;
CREATE POLICY ele__scope_read ON public.employee_lifecycle_events
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

DROP POLICY IF EXISTS ele__admin_insert ON public.employee_lifecycle_events;
CREATE POLICY ele__admin_insert ON public.employee_lifecycle_events
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- Reversal flagging is admin-only too.
DROP POLICY IF EXISTS ele__admin_reverse ON public.employee_lifecycle_events;
CREATE POLICY ele__admin_reverse ON public.employee_lifecycle_events
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 2. employee_change_requests (per-field maker-checker)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_change_requests (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id          uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  requested_by         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  request_group_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_table         text NOT NULL,
  entity_id            uuid,
  field_name           text NOT NULL,
  field_label          text NOT NULL,
  old_value            jsonb,
  new_value            jsonb NOT NULL,
  is_sensitive         boolean NOT NULL DEFAULT false,
  status               public.approval_status NOT NULL DEFAULT 'pending',
  approval_request_id  uuid,   -- FK added by deferred sweep (approval_requests in 029)
  decided_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at           timestamptz,
  decision_comment     text,
  applied_at           timestamptz,
  apply_error          text,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  effective_from       date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ecr__entity_table CHECK (entity_table IN
    ('employees','employee_addresses','employee_contacts','employee_dependents',
     'employee_qualifications','employee_identity_documents','employee_statutory',
     'employee_bank_accounts','employee_custom_field_values'))
);

CREATE INDEX IF NOT EXISTS idx_ecr__employee_status  ON public.employee_change_requests (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_ecr__status_requested ON public.employee_change_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ecr__group            ON public.employee_change_requests (request_group_id);

CREATE TRIGGER trg_ecr__stamp BEFORE INSERT ON public.employee_change_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_ecr__touch BEFORE UPDATE ON public.employee_change_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- The whitelist of employees columns a change request may target. One
-- implementation, used by both the self-insert guard and apply_change_request.
CREATE OR REPLACE FUNCTION public.employee_changeable_fields()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'title','first_name','middle_name','last_name','display_name','preferred_name',
    'name_in_local_script','personal_email','mobile','date_of_birth',
    'date_of_birth_actual','gender','marital_status','marriage_anniversary',
    'father_or_spouse_name','father_or_spouse_relation','mother_name',
    'nationality','religion','category','is_differently_abled','disability_type',
    'mode_of_transport','uniform_size','food_preference','blood_group','about',
    'photo_path','cover_photo_path'];
$$;

-- Self-submitted requests may only target whitelisted employees columns or
-- employee-editable custom fields; status/decision columns are server-owned.
CREATE OR REPLACE FUNCTION public.ecr_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_is_self boolean := (NEW.requested_by = app.ctx_actor_id()) AND NOT app.is_admin();
  v_def public.employee_custom_field_defs%ROWTYPE;
BEGIN
  NEW.status := 'pending';
  NEW.decided_by := NULL; NEW.decided_at := NULL;
  NEW.applied_at := NULL; NEW.apply_error := NULL;

  IF v_is_self THEN
    IF NEW.entity_table = 'employees' THEN
      IF NOT (NEW.field_name = ANY (public.employee_changeable_fields())) THEN
        RAISE EXCEPTION 'field % cannot be changed through a change request', NEW.field_name
          USING errcode = '42501';
      END IF;
    ELSIF NEW.entity_table = 'employee_custom_field_values' THEN
      IF NEW.field_name !~ '^custom:' THEN
        RAISE EXCEPTION 'custom-field requests use field_name = custom:<code>' USING errcode = '22023';
      END IF;
      SELECT * INTO v_def FROM public.employee_custom_field_defs
      WHERE code = substring(NEW.field_name FROM 8) AND deleted_at IS NULL;
      IF v_def.id IS NULL OR NOT v_def.is_employee_editable THEN
        RAISE EXCEPTION 'custom field % is not employee-editable', NEW.field_name
          USING errcode = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ecr__insert_guard
  BEFORE INSERT ON public.employee_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.ecr_insert_guard();

ALTER TABLE public.employee_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ecr__self_read ON public.employee_change_requests;
CREATE POLICY ecr__self_read ON public.employee_change_requests
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id() OR requested_by = app.ctx_actor_id());

DROP POLICY IF EXISTS ecr__team_read ON public.employee_change_requests;
CREATE POLICY ecr__team_read ON public.employee_change_requests
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS ecr__admin_all ON public.employee_change_requests;
CREATE POLICY ecr__admin_all ON public.employee_change_requests
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS ecr__self_insert ON public.employee_change_requests;
CREATE POLICY ecr__self_insert ON public.employee_change_requests
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id() AND requested_by = app.ctx_actor_id());

-- -----------------------------------------------------------------------------
-- 3. apply_change_request (§8.10) — one transaction, visible failures
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_change_request(p_change_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r          public.employee_change_requests%ROWTYPE;
  v_coltype  text;
  v_def      public.employee_custom_field_defs%ROWTYPE;
  v_caller_reason text := coalesce(current_setting('app.reason', true), '');
BEGIN
  SELECT * INTO r FROM public.employee_change_requests
  WHERE id = p_change_request_id FOR UPDATE;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'change request % not found', p_change_request_id USING errcode = 'P0002';
  END IF;
  IF r.status <> 'approved' OR r.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'change request % is not in an applicable state (status=%, applied_at=%)',
      p_change_request_id, r.status, r.applied_at USING errcode = '22023';
  END IF;

  PERFORM set_config('app.reason',
    'change request ' || r.id || ' approved by ' || coalesce(r.decided_by::text, 'system'), true);

  BEGIN
    IF r.entity_table = 'employees' THEN
      -- Whitelist double-check + real-column check, then a dynamic
      -- single-column UPDATE with a type-correct cast.
      IF NOT (r.field_name = ANY (public.employee_changeable_fields())) THEN
        RAISE EXCEPTION 'field % is not in the changeable whitelist', r.field_name;
      END IF;
      SELECT format_type(a.atttypid, a.atttypmod) INTO v_coltype
      FROM pg_attribute a
      WHERE a.attrelid = 'public.employees'::regclass
        AND a.attname = r.field_name AND NOT a.attisdropped;
      IF v_coltype IS NULL THEN
        RAISE EXCEPTION 'field % does not exist on employees', r.field_name;
      END IF;
      EXECUTE format('UPDATE public.employees SET %I = ($1 #>> ''{}'')::%s WHERE id = $2',
                     r.field_name, v_coltype)
      USING r.new_value, r.employee_id;

    ELSIF r.entity_table = 'employee_custom_field_values' THEN
      SELECT * INTO v_def FROM public.employee_custom_field_defs
      WHERE code = substring(r.field_name FROM 8) AND deleted_at IS NULL;
      IF v_def.id IS NULL THEN
        RAISE EXCEPTION 'custom field % not found', r.field_name;
      END IF;
      INSERT INTO public.employee_custom_field_values AS v
        (employee_id, field_def_id, value_text, value_number, value_date, value_boolean, value_json, value_document_id)
      VALUES (
        r.employee_id, v_def.id,
        CASE WHEN v_def.field_type IN ('text','single_select') THEN r.new_value #>> '{}' END,
        CASE WHEN v_def.field_type = 'number'  THEN (r.new_value #>> '{}')::numeric END,
        CASE WHEN v_def.field_type = 'date'    THEN (r.new_value #>> '{}')::date END,
        CASE WHEN v_def.field_type = 'boolean' THEN (r.new_value #>> '{}')::boolean END,
        CASE WHEN v_def.field_type IN ('multi_select','employee_ref') THEN r.new_value END,
        CASE WHEN v_def.field_type = 'file'    THEN (r.new_value #>> '{}')::uuid END)
      ON CONFLICT (employee_id, field_def_id) DO UPDATE SET
        value_text        = excluded.value_text,
        value_number      = excluded.value_number,
        value_date        = excluded.value_date,
        value_boolean     = excluded.value_boolean,
        value_json        = excluded.value_json,
        value_document_id = excluded.value_document_id;

    ELSIF r.entity_id IS NOT NULL THEN
      -- Satellite single-column update, same dynamic pattern.
      SELECT format_type(a.atttypid, a.atttypmod) INTO v_coltype
      FROM pg_attribute a
      WHERE a.attrelid = ('public.' || r.entity_table)::regclass
        AND a.attname = r.field_name AND NOT a.attisdropped;
      IF v_coltype IS NULL THEN
        RAISE EXCEPTION 'field % does not exist on %', r.field_name, r.entity_table;
      END IF;
      EXECUTE format('UPDATE public.%I SET %I = ($1 #>> ''{}'')::%s WHERE id = $2 AND employee_id = $3',
                     r.entity_table, r.field_name, v_coltype)
      USING r.new_value, r.entity_id, r.employee_id;

    ELSE
      RAISE EXCEPTION 'creating a new % row via change request is not supported; HR records it directly',
        r.entity_table;
    END IF;

    UPDATE public.employee_change_requests
       SET applied_at = now(), status = 'applied', apply_error = NULL
     WHERE id = r.id;

  EXCEPTION WHEN OTHERS THEN
    -- A failed application is visible, never silent (§8.10 step 4).
    UPDATE public.employee_change_requests
       SET status = 'failed', apply_error = SQLERRM
     WHERE id = r.id;
  END;

  PERFORM set_config('app.reason', v_caller_reason, true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_change_request(uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 4. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON public.employee_lifecycle_events TO authenticated;
    GRANT SELECT, INSERT ON public.employee_change_requests TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.employee_lifecycle_events TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_change_requests TO service_role;
    GRANT EXECUTE ON FUNCTION public.apply_change_request(uuid) TO service_role;
  END IF;
END $$;

COMMIT;
