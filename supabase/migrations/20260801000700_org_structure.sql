-- ============================================================================
-- 007  ORG STRUCTURE
-- companies, locations, cost_centres, departments, sections, grades,
-- designations  + indexes + RLS + touch/stamp triggers.
-- Source: docs/plan/04-data-model.md §3.2, §1.3, §1.4, §1.7, §1.8, §4.
-- Notes:
--   * audit.log_changes() triggers for these tables are attached centrally in
--     migration 038 (20260801003800_audit_triggers_attach.sql).
--   * FKs to tables created later are added by the migration that creates the
--     target: employees-FKs (head_employee_id / owner_employee_id) in 008,
--     holiday_calendars / shifts FKs in 014, leave_types FK in 019.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- Touch/stamp trigger functions are owned by migration 004. They are created
-- here ONLY if absent (defensive interface guard so this file is runnable in
-- isolation on the validation harness). Semantics per §1.3.
-- ----------------------------------------------------------------------------
DO $do$
BEGIN
  IF to_regproc('public.touch_row') IS NULL THEN
    EXECUTE $def$
      CREATE FUNCTION public.touch_row() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $fn$
      BEGIN
        NEW.updated_at := now();
        NEW.updated_by := app.ctx_actor_id();
        RETURN NEW;
      END;
      $fn$;
    $def$;
  END IF;

  IF to_regproc('public.stamp_row') IS NULL THEN
    EXECUTE $def$
      CREATE FUNCTION public.stamp_row() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $fn$
      BEGIN
        IF NEW.created_by IS NULL THEN
          NEW.created_by := app.ctx_actor_id();
        END IF;
        RETURN NEW;
      END;
      $fn$;
    $def$;
  END IF;
END;
$do$;

-- ============================================================================
-- companies
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.companies (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  code                        text        NOT NULL,
  name                        text        NOT NULL,
  description                 text        NULL,
  sort_order                  integer     NOT NULL DEFAULT 100,
  is_active                   boolean     NOT NULL DEFAULT true,
  legal_name                  text        NOT NULL,
  trade_name                  text        NOT NULL,
  entity_type                 text        NOT NULL DEFAULT 'LLP',
  registration_number         text        NULL,
  incorporation_date          date        NULL,
  pan                         text        NULL,
  tan                         text        NULL,
  gstin                       text        NULL,
  pf_establishment_code       text        NULL,
  esi_establishment_code      text        NULL,
  lwf_registration            text        NULL,
  shops_establishment_reg     text        NULL,
  registered_address          jsonb       NOT NULL,
  employee_code_prefix        text        NOT NULL DEFAULT 'TT',
  employee_code_padding       integer     NOT NULL DEFAULT 4,
  logo_path                   text        NULL,
  financial_year_start_month  integer     NOT NULL DEFAULT 4,
  default_currency            text        NOT NULL DEFAULT 'INR',
  is_default                  boolean     NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  deleted_at                  timestamptz NULL,
  deleted_by                  uuid        NULL,
  deletion_reason             text        NULL,
  CONSTRAINT pk_companies PRIMARY KEY (id),
  CONSTRAINT fk_companies__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_companies__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_companies__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_companies__pan_format   CHECK (pan   IS NULL OR pan   ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  CONSTRAINT ck_companies__tan_format   CHECK (tan   IS NULL OR tan   ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  CONSTRAINT ck_companies__gstin_format CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
  CONSTRAINT ck_companies__fy_start_month CHECK (financial_year_start_month BETWEEN 1 AND 12),
  CONSTRAINT ck_companies__code_padding   CHECK (employee_code_padding BETWEEN 1 AND 8),
  CONSTRAINT ck_companies__incorporation_date CHECK (incorporation_date IS NULL OR incorporation_date <= DATE '2100-01-01'),
  CONSTRAINT ck_companies__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_companies__code
  ON public.companies (code) WHERE deleted_at IS NULL;
-- Exactly one default company (partial unique index over a constant).
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies__single_default
  ON public.companies ((true)) WHERE is_default AND deleted_at IS NULL;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies__all_read__select ON public.companies;
CREATE POLICY companies__all_read__select ON public.companies
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS companies__admin__select ON public.companies;
CREATE POLICY companies__admin__select ON public.companies
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS companies__admin__update ON public.companies;
CREATE POLICY companies__admin__update ON public.companies
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

-- Only a super-admin may create a legal entity.
DROP POLICY IF EXISTS companies__super_admin__insert ON public.companies;
CREATE POLICY companies__super_admin__insert ON public.companies
  FOR INSERT TO authenticated
  WITH CHECK (app.is_super_admin());

REVOKE ALL ON public.companies FROM anon;
REVOKE DELETE, TRUNCATE ON public.companies FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.companies TO authenticated;

DROP TRIGGER IF EXISTS trg_companies__stamp ON public.companies;
CREATE TRIGGER trg_companies__stamp BEFORE INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_companies__touch ON public.companies;
CREATE TRIGGER trg_companies__touch BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

-- ============================================================================
-- locations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.locations (
  id                          uuid           NOT NULL DEFAULT gen_random_uuid(),
  company_id                  uuid           NOT NULL,
  code                        text           NOT NULL,
  name                        text           NOT NULL,
  description                 text           NULL,
  sort_order                  integer        NOT NULL DEFAULT 100,
  is_active                   boolean        NOT NULL DEFAULT true,
  address                     jsonb          NOT NULL,
  city                        text           NOT NULL DEFAULT 'Bengaluru',
  state                       text           NOT NULL DEFAULT 'Karnataka',
  pincode                     text           NULL,
  lat                         numeric(10,7)  NULL,
  lng                         numeric(10,7)  NULL,
  geofence_radius_m           integer        NOT NULL DEFAULT 300,
  timezone                    text           NOT NULL DEFAULT 'Asia/Kolkata',
  -- FK to public.holiday_calendars(id) is added by migration 014.
  default_holiday_calendar_id uuid           NULL,
  is_primary                  boolean        NOT NULL DEFAULT false,
  created_at                  timestamptz    NOT NULL DEFAULT now(),
  created_by                  uuid           NULL,
  updated_at                  timestamptz    NOT NULL DEFAULT now(),
  updated_by                  uuid           NULL,
  deleted_at                  timestamptz    NULL,
  deleted_by                  uuid           NULL,
  deletion_reason             text           NULL,
  CONSTRAINT pk_locations PRIMARY KEY (id),
  CONSTRAINT fk_locations__company_id FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_locations__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_locations__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_locations__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_locations__pincode_format CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT ck_locations__lat_range CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  CONSTRAINT ck_locations__lng_range CHECK (lng IS NULL OR (lng BETWEEN -180 AND 180)),
  CONSTRAINT ck_locations__geofence_radius CHECK (geofence_radius_m > 0),
  CONSTRAINT ck_locations__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_locations__company_code
  ON public.locations (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_locations__company
  ON public.locations (company_id);
CREATE INDEX IF NOT EXISTS idx_locations__default_holiday_calendar
  ON public.locations (default_holiday_calendar_id) WHERE default_holiday_calendar_id IS NOT NULL;

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS locations__all_read__select ON public.locations;
CREATE POLICY locations__all_read__select ON public.locations
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS locations__admin__select ON public.locations;
CREATE POLICY locations__admin__select ON public.locations
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS locations__admin__insert ON public.locations;
CREATE POLICY locations__admin__insert ON public.locations
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS locations__admin__update ON public.locations;
CREATE POLICY locations__admin__update ON public.locations
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

REVOKE ALL ON public.locations FROM anon;
REVOKE DELETE, TRUNCATE ON public.locations FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.locations TO authenticated;

DROP TRIGGER IF EXISTS trg_locations__stamp ON public.locations;
CREATE TRIGGER trg_locations__stamp BEFORE INSERT ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_locations__touch ON public.locations;
CREATE TRIGGER trg_locations__touch BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

-- ============================================================================
-- cost_centres  (before departments, which reference them)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cost_centres (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL,
  code                    text        NOT NULL,
  name                    text        NOT NULL,
  description             text        NULL,
  sort_order              integer     NOT NULL DEFAULT 100,
  is_active               boolean     NOT NULL DEFAULT true,
  parent_cost_centre_id   uuid        NULL,
  -- Money is integer paise end-to-end (spec-architecture D-04).
  budget_monthly_paise    bigint      NULL,
  -- FK to public.employees(id) is added by migration 008.
  owner_employee_id       uuid        NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        NULL,
  deleted_at              timestamptz NULL,
  deleted_by              uuid        NULL,
  deletion_reason         text        NULL,
  CONSTRAINT pk_cost_centres PRIMARY KEY (id),
  CONSTRAINT fk_cost_centres__company_id FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cost_centres__parent_cost_centre_id FOREIGN KEY (parent_cost_centre_id) REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cost_centres__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_centres__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_centres__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_cost_centres__budget_non_negative CHECK (budget_monthly_paise IS NULL OR budget_monthly_paise >= 0),
  CONSTRAINT ck_cost_centres__no_self_parent CHECK (parent_cost_centre_id IS NULL OR parent_cost_centre_id <> id),
  CONSTRAINT ck_cost_centres__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres__company_code
  ON public.cost_centres (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cost_centres__company
  ON public.cost_centres (company_id);
CREATE INDEX IF NOT EXISTS idx_cost_centres__parent
  ON public.cost_centres (parent_cost_centre_id) WHERE parent_cost_centre_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_centres__owner
  ON public.cost_centres (owner_employee_id) WHERE owner_employee_id IS NOT NULL;

ALTER TABLE public.cost_centres ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cost_centres__all_read__select ON public.cost_centres;
CREATE POLICY cost_centres__all_read__select ON public.cost_centres
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS cost_centres__admin__select ON public.cost_centres;
CREATE POLICY cost_centres__admin__select ON public.cost_centres
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS cost_centres__admin__insert ON public.cost_centres;
CREATE POLICY cost_centres__admin__insert ON public.cost_centres
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS cost_centres__admin__update ON public.cost_centres;
CREATE POLICY cost_centres__admin__update ON public.cost_centres
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

REVOKE ALL ON public.cost_centres FROM anon;
REVOKE DELETE, TRUNCATE ON public.cost_centres FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cost_centres TO authenticated;

DROP TRIGGER IF EXISTS trg_cost_centres__stamp ON public.cost_centres;
CREATE TRIGGER trg_cost_centres__stamp BEFORE INSERT ON public.cost_centres
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_cost_centres__touch ON public.cost_centres;
CREATE TRIGGER trg_cost_centres__touch BEFORE UPDATE ON public.cost_centres
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

-- ============================================================================
-- departments
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.departments (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  code               text        NOT NULL,
  name               text        NOT NULL,
  description        text        NULL,
  sort_order         integer     NOT NULL DEFAULT 100,
  is_active          boolean     NOT NULL DEFAULT true,
  -- FK to public.employees(id) is added by migration 008.
  head_employee_id   uuid        NULL,
  cost_centre_id     uuid        NULL,
  is_operational     boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL,
  deleted_at         timestamptz NULL,
  deleted_by         uuid        NULL,
  deletion_reason    text        NULL,
  CONSTRAINT pk_departments PRIMARY KEY (id),
  CONSTRAINT fk_departments__company_id FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_departments__cost_centre_id FOREIGN KEY (cost_centre_id) REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  CONSTRAINT fk_departments__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_departments__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_departments__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_departments__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_departments__company_code
  ON public.departments (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_departments__company
  ON public.departments (company_id);
CREATE INDEX IF NOT EXISTS idx_departments__cost_centre
  ON public.departments (cost_centre_id) WHERE cost_centre_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_departments__head
  ON public.departments (head_employee_id) WHERE head_employee_id IS NOT NULL;

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS departments__all_read__select ON public.departments;
CREATE POLICY departments__all_read__select ON public.departments
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS departments__admin__select ON public.departments;
CREATE POLICY departments__admin__select ON public.departments
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS departments__admin__insert ON public.departments;
CREATE POLICY departments__admin__insert ON public.departments
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS departments__admin__update ON public.departments;
CREATE POLICY departments__admin__update ON public.departments
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

REVOKE ALL ON public.departments FROM anon;
REVOKE DELETE, TRUNCATE ON public.departments FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.departments TO authenticated;

DROP TRIGGER IF EXISTS trg_departments__stamp ON public.departments;
CREATE TRIGGER trg_departments__stamp BEFORE INSERT ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_departments__touch ON public.departments;
CREATE TRIGGER trg_departments__touch BEFORE UPDATE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

-- ============================================================================
-- sections
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sections (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  department_id      uuid        NOT NULL,
  code               text        NOT NULL,
  name               text        NOT NULL,
  description        text        NULL,
  sort_order         integer     NOT NULL DEFAULT 100,
  is_active          boolean     NOT NULL DEFAULT true,
  -- FK to public.employees(id) is added by migration 008.
  head_employee_id   uuid        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL,
  deleted_at         timestamptz NULL,
  deleted_by         uuid        NULL,
  deletion_reason    text        NULL,
  CONSTRAINT pk_sections PRIMARY KEY (id),
  CONSTRAINT fk_sections__department_id FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sections__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_sections__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_sections__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_sections__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sections__department_code
  ON public.sections (department_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sections__department
  ON public.sections (department_id);
CREATE INDEX IF NOT EXISTS idx_sections__head
  ON public.sections (head_employee_id) WHERE head_employee_id IS NOT NULL;

ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sections__all_read__select ON public.sections;
CREATE POLICY sections__all_read__select ON public.sections
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS sections__admin__select ON public.sections;
CREATE POLICY sections__admin__select ON public.sections
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS sections__admin__insert ON public.sections;
CREATE POLICY sections__admin__insert ON public.sections
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS sections__admin__update ON public.sections;
CREATE POLICY sections__admin__update ON public.sections
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

REVOKE ALL ON public.sections FROM anon;
REVOKE DELETE, TRUNCATE ON public.sections FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sections TO authenticated;

DROP TRIGGER IF EXISTS trg_sections__stamp ON public.sections;
CREATE TRIGGER trg_sections__stamp BEFORE INSERT ON public.sections
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_sections__touch ON public.sections;
CREATE TRIGGER trg_sections__touch BEFORE UPDATE ON public.sections
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

-- ============================================================================
-- grades  (before designations, which reference them)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.grades (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL,
  code                   text        NOT NULL,
  name                   text        NOT NULL,
  description            text        NULL,
  sort_order             integer     NOT NULL DEFAULT 100,
  is_active              boolean     NOT NULL DEFAULT true,
  level                  integer     NOT NULL,
  -- Money is integer paise end-to-end (spec-architecture D-04).
  min_ctc_monthly_paise  bigint      NULL,
  max_ctc_monthly_paise  bigint      NULL,
  -- FK to public.leave_types(id) is added by migration 019.
  leave_policy_id        uuid        NULL,
  notice_period_days     integer     NOT NULL DEFAULT 30,
  probation_months       integer     NOT NULL DEFAULT 6,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NULL,
  deleted_at             timestamptz NULL,
  deleted_by             uuid        NULL,
  deletion_reason        text        NULL,
  CONSTRAINT pk_grades PRIMARY KEY (id),
  CONSTRAINT fk_grades__company_id FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_grades__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_grades__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_grades__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_grades__level_positive CHECK (level >= 1),
  CONSTRAINT ck_grades__ctc_band CHECK (max_ctc_monthly_paise IS NULL OR min_ctc_monthly_paise IS NULL OR max_ctc_monthly_paise >= min_ctc_monthly_paise),
  CONSTRAINT ck_grades__notice_period CHECK (notice_period_days >= 0),
  CONSTRAINT ck_grades__probation_months CHECK (probation_months BETWEEN 0 AND 24),
  CONSTRAINT ck_grades__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_grades__company_code
  ON public.grades (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_grades__company
  ON public.grades (company_id);
CREATE INDEX IF NOT EXISTS idx_grades__leave_policy
  ON public.grades (leave_policy_id) WHERE leave_policy_id IS NOT NULL;

ALTER TABLE public.grades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grades__all_read__select ON public.grades;
CREATE POLICY grades__all_read__select ON public.grades
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS grades__admin__select ON public.grades;
CREATE POLICY grades__admin__select ON public.grades
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS grades__admin__insert ON public.grades;
CREATE POLICY grades__admin__insert ON public.grades
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS grades__admin__update ON public.grades;
CREATE POLICY grades__admin__update ON public.grades
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

REVOKE ALL ON public.grades FROM anon;
REVOKE DELETE, TRUNCATE ON public.grades FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.grades TO authenticated;

DROP TRIGGER IF EXISTS trg_grades__stamp ON public.grades;
CREATE TRIGGER trg_grades__stamp BEFORE INSERT ON public.grades
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_grades__touch ON public.grades;
CREATE TRIGGER trg_grades__touch BEFORE UPDATE ON public.grades
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

-- ============================================================================
-- designations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.designations (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  code               text        NOT NULL,
  name               text        NOT NULL,
  description        text        NULL,
  sort_order         integer     NOT NULL DEFAULT 100,
  is_active          boolean     NOT NULL DEFAULT true,
  grade_id           uuid        NULL,
  is_managerial      boolean     NOT NULL DEFAULT false,
  is_executive       boolean     NOT NULL DEFAULT false,
  -- FK to public.shifts(id) is added by migration 014.
  default_shift_id   uuid        NULL,
  ot_eligible        boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL,
  deleted_at         timestamptz NULL,
  deleted_by         uuid        NULL,
  deletion_reason    text        NULL,
  CONSTRAINT pk_designations PRIMARY KEY (id),
  CONSTRAINT fk_designations__company_id FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_designations__grade_id FOREIGN KEY (grade_id) REFERENCES public.grades(id) ON DELETE RESTRICT,
  CONSTRAINT fk_designations__created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_designations__updated_by FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_designations__deleted_by FOREIGN KEY (deleted_by) REFERENCES public.profiles(id),
  CONSTRAINT ck_designations__deletion_reason CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_designations__company_code
  ON public.designations (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_designations__company
  ON public.designations (company_id);
CREATE INDEX IF NOT EXISTS idx_designations__grade
  ON public.designations (grade_id) WHERE grade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_designations__default_shift
  ON public.designations (default_shift_id) WHERE default_shift_id IS NOT NULL;

ALTER TABLE public.designations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS designations__all_read__select ON public.designations;
CREATE POLICY designations__all_read__select ON public.designations
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS designations__admin__select ON public.designations;
CREATE POLICY designations__admin__select ON public.designations
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS designations__admin__insert ON public.designations;
CREATE POLICY designations__admin__insert ON public.designations
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS designations__admin__update ON public.designations;
CREATE POLICY designations__admin__update ON public.designations
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

REVOKE ALL ON public.designations FROM anon;
REVOKE DELETE, TRUNCATE ON public.designations FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.designations TO authenticated;

DROP TRIGGER IF EXISTS trg_designations__stamp ON public.designations;
CREATE TRIGGER trg_designations__stamp BEFORE INSERT ON public.designations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_row();
DROP TRIGGER IF EXISTS trg_designations__touch ON public.designations;
CREATE TRIGGER trg_designations__touch BEFORE UPDATE ON public.designations
  FOR EACH ROW EXECUTE FUNCTION public.touch_row();

COMMIT;
