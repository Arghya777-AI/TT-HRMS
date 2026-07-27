-- =============================================================================
-- Migration 008 — employees (the spine of the product)
-- Source: docs/plan/04-data-model.md §3.3 (all columns), §1.3/§1.4 (audit +
--         soft-delete columns), §1.6/§1.8 (identifier rules, regex checks),
--         §8.6 (generate_employee_code, exact SQL), §8.11 (guard triggers);
--         spec-migrations §2 row 008.
--
-- Every field of the 8 profile tabs is a first-class column or satellite row —
-- nothing hides in jsonb. employee_code is TEXT forever (the 1.0202E+11 fix).
--
-- FKs to tables created by LATER migrations (shifts, attendance_policies,
-- weekly_off_rules, holiday_calendars, pay_periods, employee_bank_accounts)
-- are deliberately NOT declared here; they are added by the deferred-FK sweep
-- migration once those tables exist. Grants here are narrow by design:
-- no base-table SELECT for authenticated beyond (id); reads go through the
-- §4.6 views (migration 033), admin mutations through edge functions.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.employees (
  -- Identity & basic (tab "Basic Info")
  id                       uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  employee_code            text NOT NULL,
  title                    text,
  first_name               text NOT NULL,
  middle_name              text,
  last_name                text NOT NULL,
  display_name             text NOT NULL,
  preferred_name           text,
  name_in_local_script     text,
  work_email               text,
  personal_email           text,
  mobile                   text,
  date_of_birth            date,
  date_of_birth_actual     date,
  gender                   public.gender,
  blood_group              public.blood_group NOT NULL DEFAULT 'unknown',
  photo_path               text,
  cover_photo_path         text,
  about                    text,
  biometric_enrolment_id   text,

  -- Employment (tab "Employment")
  employment_type          public.employment_type NOT NULL DEFAULT 'probation',
  employment_status        public.employment_status NOT NULL DEFAULT 'pre_joining',
  date_of_join             date,
  probation_months         integer NOT NULL DEFAULT 6,
  confirmation_due_date    date GENERATED ALWAYS AS
                             ((date_of_join + make_interval(months => probation_months))::date) STORED,
  confirmed_on             date,
  contract_start_date      date,
  contract_end_date        date,
  notice_period_days       integer NOT NULL DEFAULT 30,
  department_id            uuid REFERENCES public.departments(id) ON DELETE RESTRICT,
  section_id               uuid REFERENCES public.sections(id) ON DELETE RESTRICT,
  designation_id           uuid REFERENCES public.designations(id) ON DELETE RESTRICT,
  grade_id                 uuid REFERENCES public.grades(id) ON DELETE RESTRICT,
  location_id              uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  cost_centre_id           uuid REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  reporting_manager_id     uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  dotted_line_manager_id   uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  work_order_number        text,
  is_ot_eligible           boolean NOT NULL DEFAULT true,
  is_shift_worker          boolean NOT NULL DEFAULT true,
  punch_mode               public.punch_mode NOT NULL DEFAULT 'multi_punch',
  attendance_policy_id     uuid,   -- FK added by deferred-FK sweep (table in 014)
  weekly_off_rule_id       uuid,   -- FK added by deferred-FK sweep (table in 014)
  holiday_calendar_id      uuid,   -- FK added by deferred-FK sweep (table in 014)
  shift_id                 uuid,   -- FK added by deferred-FK sweep (table in 014)
  pay_period_id            uuid,   -- FK added by deferred-FK sweep (table in 014)
  attendance_regularize_from date,
  allow_web_punch          boolean NOT NULL DEFAULT false,
  allow_mobile_selfie_punch boolean NOT NULL DEFAULT false,
  restrict_punch_to_venue_ip boolean NOT NULL DEFAULT true,
  exclude_from_attendance  boolean NOT NULL DEFAULT false,
  exclude_from_payroll     boolean NOT NULL DEFAULT false,

  -- Payment (tab "Payment")
  payment_mode             public.payment_mode NOT NULL DEFAULT 'bank_transfer',
  primary_bank_account_id  uuid,   -- FK added by deferred-FK sweep (table in 009)

  -- Personal (tab "Personal")
  marital_status           public.marital_status,
  marriage_anniversary     date,
  father_or_spouse_name    text,
  father_or_spouse_relation text,
  mother_name              text,
  nationality              text NOT NULL DEFAULT 'Indian',
  religion                 text,
  category                 text,
  is_differently_abled     boolean NOT NULL DEFAULT false,
  disability_type          text,
  physical_address_same_as_permanent boolean NOT NULL DEFAULT true,
  mode_of_transport        text,
  uniform_size             text,
  food_preference          text,

  -- Exit
  resignation_date         date,
  last_working_day         date,
  exit_type                text,
  exit_reason              text,
  exit_interview_done      boolean NOT NULL DEFAULT false,
  is_rehire_eligible       boolean,
  full_and_final_settled_on date,

  -- Derived / system
  profile_completeness_pct numeric(6,3) NOT NULL DEFAULT 0,
  face_enrolled_at         timestamptz,
  fingerprint_enrolled_at  timestamptz,
  search_tsv               tsvector,

  -- §1.3 audit columns + §1.4 soft delete
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at               timestamptz,
  deleted_by               uuid REFERENCES public.profiles(id),
  deletion_reason          text,

  -- §3.3 constraints
  CONSTRAINT ck_employees__no_self_manager   CHECK (id <> reporting_manager_id),
  CONSTRAINT ck_employees__no_self_dotted    CHECK (id <> dotted_line_manager_id),
  CONSTRAINT ck_employees__join_before_lwd   CHECK (last_working_day IS NULL OR date_of_join IS NULL OR last_working_day >= date_of_join),
  CONSTRAINT ck_employees__exit_fields       CHECK (employment_status <> 'exited' OR (last_working_day IS NOT NULL AND exit_type IS NOT NULL)),
  CONSTRAINT ck_employees__work_email        CHECK (work_email IS NULL OR work_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_employees__personal_email    CHECK (personal_email IS NULL OR personal_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_employees__mobile_in         CHECK (mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT ck_employees__exit_type         CHECK (exit_type IS NULL OR exit_type IN ('resignation','termination','end_of_contract','retirement','absconding','death')),
  CONSTRAINT ck_employees__relation          CHECK (father_or_spouse_relation IS NULL OR father_or_spouse_relation IN ('father','spouse')),
  CONSTRAINT ck_employees__category          CHECK (category IS NULL OR category IN ('GEN','OBC','SC','ST','EWS')),
  CONSTRAINT ck_employees__food_preference   CHECK (food_preference IS NULL OR food_preference IN ('veg','non_veg','jain','eggetarian')),
  CONSTRAINT ck_employees__probation_months  CHECK (probation_months BETWEEN 0 AND 24),
  CONSTRAINT ck_employees__notice_days       CHECK (notice_period_days BETWEEN 0 AND 180),
  CONSTRAINT ck_employees__completeness      CHECK (profile_completeness_pct >= 0 AND profile_completeness_pct <= 100),
  -- Sentinel-date ban (§1.6): open-ended is NULL, never a year-3000 date.
  CONSTRAINT ck_employees__sane_dates CHECK (
        coalesce(date_of_birth,        DATE '2000-01-01') < DATE '2100-01-01'
    AND coalesce(date_of_join,         DATE '2000-01-01') < DATE '2100-01-01'
    AND coalesce(contract_end_date,    DATE '2000-01-01') < DATE '2100-01-01'
    AND coalesce(last_working_day,     DATE '2000-01-01') < DATE '2100-01-01'),
  CONSTRAINT ck_employees__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

-- -----------------------------------------------------------------------------
-- Indexes (§3.3 verbatim + FK hygiene per §1.8)
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees__employee_code ON public.employees (employee_code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees__profile_id    ON public.employees (profile_id) WHERE profile_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees__work_email    ON public.employees (lower(work_email)) WHERE work_email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees__manager      ON public.employees (reporting_manager_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees__dept_status  ON public.employees (department_id, employment_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees__location     ON public.employees (location_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees__status_live  ON public.employees (employment_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees__confirmation ON public.employees (confirmation_due_date) WHERE employment_status = 'on_probation';
CREATE INDEX IF NOT EXISTS idx_employees__contract_end ON public.employees (contract_end_date) WHERE contract_end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees__search_tsv   ON public.employees USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_employees__name_trgm    ON public.employees USING gin (display_name extensions.gin_trgm_ops);
-- FK hygiene (every FK column indexed)
CREATE INDEX IF NOT EXISTS idx_employees__company      ON public.employees (company_id);
CREATE INDEX IF NOT EXISTS idx_employees__section      ON public.employees (section_id);
CREATE INDEX IF NOT EXISTS idx_employees__designation  ON public.employees (designation_id);
CREATE INDEX IF NOT EXISTS idx_employees__grade        ON public.employees (grade_id);
CREATE INDEX IF NOT EXISTS idx_employees__cost_centre  ON public.employees (cost_centre_id);
CREATE INDEX IF NOT EXISTS idx_employees__dotted_mgr   ON public.employees (dotted_line_manager_id) WHERE dotted_line_manager_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees__shift        ON public.employees (shift_id);
CREATE INDEX IF NOT EXISTS idx_employees__att_policy   ON public.employees (attendance_policy_id);

-- -----------------------------------------------------------------------------
-- generate_employee_code (§8.6 exact SQL)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_employee_code(p_company_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prefix text; v_pad integer; v_next integer;
BEGIN
  SELECT employee_code_prefix, employee_code_padding INTO v_prefix, v_pad
    FROM public.companies WHERE id = p_company_id FOR UPDATE;   -- row lock serialises
  SELECT COALESCE(MAX(substring(employee_code FROM '[0-9]+$')::integer), 0) + 1
    INTO v_next
    FROM public.employees
   WHERE company_id = p_company_id
     AND employee_code ~ ('^' || v_prefix || '[0-9]+$');
  RETURN v_prefix || lpad(v_next::text, v_pad, '0');   -- TT0001 — always text
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_employee_code(uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Row triggers
-- -----------------------------------------------------------------------------

-- Code assignment on insert (when NULL) + display_name defaulting.
CREATE OR REPLACE FUNCTION public.employees_before_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.employee_code IS NULL OR btrim(NEW.employee_code) = '' THEN
    NEW.employee_code := public.generate_employee_code(NEW.company_id);
  END IF;
  IF NEW.display_name IS NULL OR btrim(NEW.display_name) = '' THEN
    NEW.display_name := btrim(NEW.first_name || ' ' || NEW.last_name);
  END IF;
  RETURN NEW;
END;
$$;

-- employee_code is identity, permanent (§8.6 note / §8.11).
CREATE OR REPLACE FUNCTION public.employees_immutable_code()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
    RAISE EXCEPTION 'employee_code is immutable (% -> %)',
      OLD.employee_code, NEW.employee_code USING errcode = '22023';
  END IF;
  RETURN NEW;
END;
$$;

-- Manager-cycle guard (§8.11): walks up max 20 levels.
CREATE OR REPLACE FUNCTION public.employees_no_manager_cycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cursor uuid := NEW.reporting_manager_id;
  v_depth  integer := 0;
BEGIN
  WHILE v_cursor IS NOT NULL AND v_depth < 20 LOOP
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'manager_cycle_detected: % would report to itself through the chain',
        NEW.employee_code USING errcode = '23514';
    END IF;
    SELECT e.reporting_manager_id INTO v_cursor FROM public.employees e WHERE e.id = v_cursor;
    v_depth := v_depth + 1;
  END LOOP;
  RETURN NEW;
END;
$$;

-- Self-edit guard (§8.11): belt-and-braces behind the column-level GRANT.
-- When the actor IS the subject and NOT an admin, only the self-editable
-- whitelist may change (touch columns are owned by util.touch_row()).
CREATE OR REPLACE FUNCTION public.employees_self_edit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_allowed text[] := ARRAY[
    'about', 'photo_path', 'cover_photo_path', 'food_preference',
    'updated_at', 'updated_by', 'profile_completeness_pct', 'search_tsv'];
  v_changed text[];
BEGIN
  IF NEW.profile_id IS NOT NULL
     AND NEW.profile_id = app.ctx_actor_id()
     AND NOT app.is_admin() THEN
    SELECT array_agg(k) INTO v_changed
    FROM (
      SELECT jsonb_object_keys(to_jsonb(NEW)) AS k
    ) keys
    WHERE (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k)
      AND k <> ALL (v_allowed);
    IF v_changed IS NOT NULL THEN
      RAISE EXCEPTION 'self_edit_not_allowed: change % through a profile change request',
        array_to_string(v_changed, ', ') USING errcode = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Global-search vector (§3.3): name + code + designation + department.
CREATE OR REPLACE FUNCTION public.employees_search_tsv()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_designation text;
  v_department  text;
BEGIN
  SELECT d.name INTO v_designation FROM public.designations d WHERE d.id = NEW.designation_id;
  SELECT d.name INTO v_department  FROM public.departments  d WHERE d.id = NEW.department_id;
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.employee_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.preferred_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(v_designation, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(v_department, '')), 'C');
  RETURN NEW;
END;
$$;

-- Profile completeness (§3.3): a defined checklist, recomputed on every write.
-- On-row items score 60; satellite items (emergency contact, verified bank,
-- statutory ids, qualification, nominee) score 40 via
-- public.satellite_completeness_score() (migration 009). Late-bound so this
-- trigger works before 009 exists.
CREATE OR REPLACE FUNCTION public.employees_completeness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_score numeric := 0;
BEGIN
  -- 8 on-row items, 60 points.
  IF NEW.photo_path IS NOT NULL THEN v_score := v_score + 10; END IF;
  IF NEW.mobile IS NOT NULL THEN v_score := v_score + 10; END IF;
  IF NEW.personal_email IS NOT NULL THEN v_score := v_score + 6; END IF;
  IF NEW.date_of_birth IS NOT NULL THEN v_score := v_score + 8; END IF;
  IF NEW.blood_group <> 'unknown' THEN v_score := v_score + 8; END IF;
  IF NEW.about IS NOT NULL AND length(btrim(NEW.about)) > 0 THEN v_score := v_score + 6; END IF;
  IF NEW.uniform_size IS NOT NULL THEN v_score := v_score + 6; END IF;
  IF NEW.food_preference IS NOT NULL THEN v_score := v_score + 6; END IF;
  v_score := LEAST(v_score, 60);
  IF to_regprocedure('public.satellite_completeness_score(uuid)') IS NOT NULL THEN
    v_score := v_score + public.satellite_completeness_score(NEW.id);
  END IF;
  NEW.profile_completeness_pct := LEAST(v_score, 100);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_employees__before_insert
  BEFORE INSERT ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_before_insert();

CREATE TRIGGER trg_employees__immutable_code
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_immutable_code();

CREATE TRIGGER trg_employees__no_manager_cycle
  BEFORE INSERT OR UPDATE OF reporting_manager_id ON public.employees
  FOR EACH ROW WHEN (NEW.reporting_manager_id IS NOT NULL)
  EXECUTE FUNCTION public.employees_no_manager_cycle();

CREATE TRIGGER trg_employees__self_edit_guard
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_self_edit_guard();

CREATE TRIGGER trg_employees__search_tsv
  BEFORE INSERT OR UPDATE OF display_name, preferred_name, employee_code, designation_id, department_id
  ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_search_tsv();

CREATE TRIGGER trg_employees__completeness
  BEFORE INSERT OR UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_completeness();

CREATE TRIGGER trg_employees__stamp
  BEFORE INSERT ON public.employees
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();

CREATE TRIGGER trg_employees__touch
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- -----------------------------------------------------------------------------
-- RLS (§3.3): no broad base-table read; views carry the read model (033).
-- -----------------------------------------------------------------------------

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

-- Narrow self UPDATE (P2): row scope self; column scope enforced by the
-- column-level GRANT below + the self-edit guard trigger.
DROP POLICY IF EXISTS employees__self_update ON public.employees;
CREATE POLICY employees__self_update ON public.employees
  FOR UPDATE TO authenticated
  USING (profile_id = app.ctx_actor_id() AND deleted_at IS NULL)
  WITH CHECK (profile_id = app.ctx_actor_id() AND deleted_at IS NULL);

-- Self row visibility, constrained to the granted column set below.
DROP POLICY IF EXISTS employees__self_read ON public.employees;
CREATE POLICY employees__self_read ON public.employees
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id() AND deleted_at IS NULL);

-- Admin write policies (P8). Effective only through paths holding matching
-- column privileges (edge functions / SECURITY DEFINER RPCs).
DROP POLICY IF EXISTS employees__admin_insert ON public.employees;
CREATE POLICY employees__admin_insert ON public.employees
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS employees__admin_update ON public.employees;
CREATE POLICY employees__admin_update ON public.employees
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(id));

-- Column-scoped grants: identity handle + the self-editable four. NOTHING else
-- is selectable/updatable on the base table by authenticated (§4.6).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT (id, employee_code, display_name, about, photo_path, cover_photo_path, food_preference)
      ON public.employees TO authenticated;
    GRANT UPDATE (about, photo_path, cover_photo_path, food_preference)
      ON public.employees TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO service_role;
    GRANT EXECUTE ON FUNCTION public.generate_employee_code(uuid) TO service_role;
  END IF;
END $$;

COMMIT;
