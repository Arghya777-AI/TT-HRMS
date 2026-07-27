-- =============================================================================
-- Migration 010 — employee custom-field engine
-- Source: docs/plan/04-data-model.md §3.3 (employee_custom_field_defs /
--         _values, lines 1085–1130); spec-migrations §2 row 010.
--
-- Metadata-driven custom fields: admin defines them, the UI renders them,
-- values are TYPED columns (never a single text column) so the metric layer
-- and the AI agent can filter/aggregate without casting, and a date can never
-- be stored as '09/25/2000'.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. employee_custom_field_defs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_custom_field_defs (
  id                           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                   uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                         text NOT NULL,
  label                        text NOT NULL,
  help_text                    text,
  field_type                   public.custom_field_type NOT NULL,
  options                      jsonb,
  is_required                  boolean NOT NULL DEFAULT false,
  is_employee_editable         boolean NOT NULL DEFAULT false,
  requires_approval            boolean NOT NULL DEFAULT true,
  is_pii                       boolean NOT NULL DEFAULT false,
  section                      text NOT NULL DEFAULT 'additional',
  sort_order                   integer NOT NULL DEFAULT 100,
  applies_to_employment_types  public.employment_type[],
  applies_to_department_ids    uuid[],
  validation_regex             text,
  min_value                    numeric(14,2),
  max_value                    numeric(14,2),
  is_active                    boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at                   timestamptz,
  deleted_by                   uuid REFERENCES public.profiles(id),
  deletion_reason              text,
  CONSTRAINT ck_ecfd__code    CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ck_ecfd__options CHECK (
    field_type NOT IN ('single_select','multi_select') OR jsonb_typeof(options) = 'array'),
  CONSTRAINT ck_ecfd__minmax  CHECK (min_value IS NULL OR max_value IS NULL OR max_value >= min_value),
  CONSTRAINT ck_ecfd__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ecfd__company_code
  ON public.employee_custom_field_defs (company_id, code) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_ecfd__stamp BEFORE INSERT ON public.employee_custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_ecfd__touch BEFORE UPDATE ON public.employee_custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_custom_field_defs ENABLE ROW LEVEL SECURITY;

-- P7: the renderer needs defs; admins manage them.
DROP POLICY IF EXISTS ecfd__ref_read ON public.employee_custom_field_defs;
CREATE POLICY ecfd__ref_read ON public.employee_custom_field_defs
  FOR SELECT TO authenticated
  USING ((is_active AND deleted_at IS NULL) OR app.is_admin());

DROP POLICY IF EXISTS ecfd__admin_write ON public.employee_custom_field_defs;
CREATE POLICY ecfd__admin_write ON public.employee_custom_field_defs
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 2. employee_custom_field_values
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_custom_field_values (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  field_def_id      uuid NOT NULL REFERENCES public.employee_custom_field_defs(id) ON DELETE CASCADE,
  value_text        text,
  value_number      numeric(14,4),
  value_date        date,
  value_boolean     boolean,
  value_json        jsonb,
  value_document_id uuid,   -- FK added by deferred sweep (documents in 025)
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Exactly one value_* populated (which one is validated against the def's
  -- field_type by trg_ecfv__validate).
  CONSTRAINT ck_ecfv__one_value CHECK (
    (CASE WHEN value_text        IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN value_number      IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN value_date        IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN value_boolean     IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN value_json        IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN value_document_id IS NOT NULL THEN 1 ELSE 0 END) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ecfv__employee_field
  ON public.employee_custom_field_values (employee_id, field_def_id);
CREATE INDEX IF NOT EXISTS idx_ecfv__field_def ON public.employee_custom_field_values (field_def_id);

-- Type validation against the def (§3.3 trg_ecfv__validate).
CREATE OR REPLACE FUNCTION public.ecfv_validate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.employee_custom_field_defs%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.employee_custom_field_defs WHERE id = NEW.field_def_id;
  IF d.id IS NULL OR d.deleted_at IS NOT NULL OR NOT d.is_active THEN
    RAISE EXCEPTION 'custom field definition % is not active', NEW.field_def_id
      USING errcode = '23514';
  END IF;

  IF NOT (
    CASE d.field_type
      WHEN 'text'          THEN NEW.value_text        IS NOT NULL
      WHEN 'number'        THEN NEW.value_number      IS NOT NULL
      WHEN 'date'          THEN NEW.value_date        IS NOT NULL
      WHEN 'boolean'       THEN NEW.value_boolean     IS NOT NULL
      WHEN 'single_select' THEN NEW.value_text        IS NOT NULL
      WHEN 'multi_select'  THEN NEW.value_json        IS NOT NULL
      WHEN 'employee_ref'  THEN NEW.value_json        IS NOT NULL
      WHEN 'file'          THEN NEW.value_document_id IS NOT NULL
    END
  ) THEN
    RAISE EXCEPTION 'custom field % expects a % value in the matching typed column',
      d.code, d.field_type USING errcode = '23514';
  END IF;

  IF d.field_type = 'text' AND d.validation_regex IS NOT NULL
     AND NEW.value_text !~ d.validation_regex THEN
    RAISE EXCEPTION 'custom field % value fails its validation pattern', d.code
      USING errcode = '23514';
  END IF;

  IF d.field_type = 'number' THEN
    IF d.min_value IS NOT NULL AND NEW.value_number < d.min_value THEN
      RAISE EXCEPTION 'custom field % value below minimum %', d.code, d.min_value
        USING errcode = '23514';
    END IF;
    IF d.max_value IS NOT NULL AND NEW.value_number > d.max_value THEN
      RAISE EXCEPTION 'custom field % value above maximum %', d.code, d.max_value
        USING errcode = '23514';
    END IF;
  END IF;

  IF d.field_type = 'single_select' AND d.options IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(d.options) o
      WHERE o->>'value' = NEW.value_text
    ) THEN
      RAISE EXCEPTION 'custom field %: % is not one of the configured options',
        d.code, NEW.value_text USING errcode = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ecfv__validate
  BEFORE INSERT OR UPDATE ON public.employee_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION public.ecfv_validate();

CREATE TRIGGER trg_ecfv__stamp BEFORE INSERT ON public.employee_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_ecfv__touch BEFORE UPDATE ON public.employee_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_custom_field_values ENABLE ROW LEVEL SECURITY;

-- P3 self-read; P8 admin-all. Manager read of non-PII values happens through
-- v_team_custom_fields (037), never the base table. Employee edits of
-- is_employee_editable fields go through change requests (011) — no self
-- write policy here.
DROP POLICY IF EXISTS ecfv__self_read ON public.employee_custom_field_values;
CREATE POLICY ecfv__self_read ON public.employee_custom_field_values
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS ecfv__admin_all ON public.employee_custom_field_values;
CREATE POLICY ecfv__admin_all ON public.employee_custom_field_values
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 3. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.employee_custom_field_defs, public.employee_custom_field_values TO authenticated;
    GRANT INSERT, UPDATE ON public.employee_custom_field_defs, public.employee_custom_field_values TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.employee_custom_field_defs, public.employee_custom_field_values TO service_role;
  END IF;
END $$;

COMMIT;
