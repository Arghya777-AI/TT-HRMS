-- ============================================================================
-- Migration 020: payroll masters
--   salary_components, salary_structures, salary_structure_components,
--   statutory_settings, eval_component_formula(); RLS.
-- Source: docs/plan/04-data-model.md §3.8 (lines 1941–2210), §1 conventions.
-- Money convention: integer paise columns suffixed _paise (spec-architecture
-- D-04 "Money = integer paise end-to-end"). All jsonb slab/config money values
-- are ALSO in integer paise.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Generic touch/stamp trigger functions (§1.3).
--    Migration 004 defines the canonical versions; CREATE OR REPLACE keeps this
--    idempotent and convergent if 004 already created them.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_touch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := app.ctx_actor_id();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_stamp()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.created_at := COALESCE(NEW.created_at, now());
  IF NEW.created_by IS NULL THEN
    NEW.created_by := app.ctx_actor_id();
  END IF;
  NEW.updated_at := COALESCE(NEW.updated_at, now());
  IF NEW.updated_by IS NULL THEN
    NEW.updated_by := app.ctx_actor_id();
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. salary_components
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salary_components (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id            uuid        NOT NULL,
  code                  text        NOT NULL,
  name                  text        NOT NULL,
  description           text        NULL,
  sort_order            integer     NOT NULL DEFAULT 100,
  is_active             boolean     NOT NULL DEFAULT true,
  line_kind             public.payslip_line_kind NOT NULL,
  calc_kind             text        NOT NULL DEFAULT 'fixed',
  base_component_id     uuid        NULL,
  percentage            numeric(9,4) NULL,
  fixed_amount_paise    bigint      NULL,
  formula               text        NULL,
  slab_config           jsonb       NULL,
  is_taxable            boolean     NOT NULL DEFAULT true,
  is_pf_wage            boolean     NOT NULL DEFAULT false,
  is_esi_wage           boolean     NOT NULL DEFAULT true,
  is_pt_wage            boolean     NOT NULL DEFAULT true,
  is_lwf_wage           boolean     NOT NULL DEFAULT false,
  is_gratuity_wage      boolean     NOT NULL DEFAULT false,
  prorate_on_paid_days  boolean     NOT NULL DEFAULT true,
  affects_gross         boolean     NOT NULL DEFAULT true,
  affects_net           boolean     NOT NULL DEFAULT true,
  affects_ctc           boolean     NOT NULL DEFAULT true,
  ctc_bucket            text        NOT NULL DEFAULT 'A',
  statutory_reference   text        NULL,
  gl_code               text        NULL,
  show_on_payslip       boolean     NOT NULL DEFAULT true,
  show_if_zero          boolean     NOT NULL DEFAULT false,
  is_system_managed     boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NULL,
  deleted_at            timestamptz NULL,
  deleted_by            uuid        NULL,
  deletion_reason       text        NULL,
  CONSTRAINT pk_salary_components PRIMARY KEY (id),
  CONSTRAINT fk_salary_components__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salary_components__base_component_id
    FOREIGN KEY (base_component_id) REFERENCES public.salary_components(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salary_components__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_salary_components__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_salary_components__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_salary_components__calc_kind CHECK (calc_kind IN
    ('fixed','pct_of_component','pct_of_gross','pct_of_ctc','balance',
     'formula','slab','attendance_prorated','per_minute','per_unit')),
  CONSTRAINT ck_salary_components__ctc_bucket CHECK (ctc_bucket IN ('A','B','C')),
  CONSTRAINT ck_salary_components__pct_range
    CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  CONSTRAINT ck_salary_components__fixed_nonneg
    CHECK (fixed_amount_paise IS NULL OR fixed_amount_paise >= 0),
  CONSTRAINT ck_salary_components__base_required
    CHECK (calc_kind <> 'pct_of_component' OR base_component_id IS NOT NULL),
  CONSTRAINT ck_salary_components__deletion_reason
    CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE  public.salary_components IS 'Payroll component master. Codes: BASIC, HRA, CONV, SPL, LTA, CHILD_EDU, FOOD, UNIFORM, NIGHT_ALLOW, SERVICE_CHG, OT, ATT_BONUS, PF_EE, ESI_EE, PT, LWF_EE, TDS, ADVANCE, LOAN, LATE_DED, PF_ER, EPS_ER, EDLI_ER, ESI_ER, LWF_ER, GRATUITY_PROV.';
COMMENT ON COLUMN public.salary_components.formula IS 'Restricted expression evaluated by public.eval_component_formula() over a whitelisted variable set (basic, gross, ctc, paid_days, period_days, ot_minutes, per_minute_rate, ...). Fixed grammar; never EXECUTEd as SQL.';
COMMENT ON COLUMN public.salary_components.slab_config IS 'For calc_kind=slab (professional tax, TDS): [{from, to, amount | pct}]. Money values in integer paise.';
COMMENT ON COLUMN public.salary_components.ctc_bucket IS 'A = gross earnings, B = variable/bonus, C = employer contributions. CTC = A + C, defined in data, not hardcoded.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_components__company_code
  ON public.salary_components (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_salary_components__company_id
  ON public.salary_components (company_id);
CREATE INDEX IF NOT EXISTS idx_salary_components__base_component_id
  ON public.salary_components (base_component_id);

DROP TRIGGER IF EXISTS trg_salary_components__stamp ON public.salary_components;
CREATE TRIGGER trg_salary_components__stamp
  BEFORE INSERT ON public.salary_components
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp();
DROP TRIGGER IF EXISTS trg_salary_components__touch ON public.salary_components;
CREATE TRIGGER trg_salary_components__touch
  BEFORE UPDATE ON public.salary_components
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch();

ALTER TABLE public.salary_components ENABLE ROW LEVEL SECURITY;

-- P7: every authenticated user may read active components (payslip labels).
DROP POLICY IF EXISTS salary_components__authenticated__select ON public.salary_components;
CREATE POLICY salary_components__authenticated__select ON public.salary_components
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS salary_components__admin__select ON public.salary_components;
CREATE POLICY salary_components__admin__select ON public.salary_components
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- P8 write; P9 (super-admin) for system-managed statutory components.
DROP POLICY IF EXISTS salary_components__admin__insert ON public.salary_components;
CREATE POLICY salary_components__admin__insert ON public.salary_components
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND (NOT is_system_managed OR app.is_super_admin()));

DROP POLICY IF EXISTS salary_components__admin__update ON public.salary_components;
CREATE POLICY salary_components__admin__update ON public.salary_components
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND (NOT is_system_managed OR app.is_super_admin()))
  WITH CHECK (app.is_admin() AND (NOT is_system_managed OR app.is_super_admin()));

GRANT SELECT, INSERT, UPDATE ON public.salary_components TO authenticated;
REVOKE DELETE ON public.salary_components FROM authenticated;

-- ----------------------------------------------------------------------------
-- 2. salary_structures
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salary_structures (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id                  uuid        NOT NULL,
  code                        text        NOT NULL,
  name                        text        NOT NULL,
  description                 text        NULL,
  sort_order                  integer     NOT NULL DEFAULT 100,
  is_active                   boolean     NOT NULL DEFAULT true,
  structure_kind              text        NOT NULL DEFAULT 'ctc_based',
  applies_to_grade_ids        uuid[]      NULL,
  applies_to_employment_types public.employment_type[] NULL,
  effective_from              date        NOT NULL,
  effective_to                date        NULL,
  version                     integer     NOT NULL DEFAULT 1,
  is_template                 boolean     NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  deleted_at                  timestamptz NULL,
  deleted_by                  uuid        NULL,
  deletion_reason             text        NULL,
  CONSTRAINT pk_salary_structures PRIMARY KEY (id),
  CONSTRAINT fk_salary_structures__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salary_structures__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_salary_structures__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_salary_structures__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_salary_structures__kind
    CHECK (structure_kind IN ('ctc_based','gross_based','wage_based')),
  CONSTRAINT ck_salary_structures__version CHECK (version >= 1),
  CONSTRAINT ck_salary_structures__range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_salary_structures__no_sentinel_dates
    CHECK (effective_from <= DATE '2100-01-01'
           AND (effective_to IS NULL OR effective_to <= DATE '2100-01-01')),
  CONSTRAINT ck_salary_structures__deletion_reason
    CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_structures__company_code_version
  ON public.salary_structures (company_id, code, version) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_salary_structures__company_id
  ON public.salary_structures (company_id);
CREATE INDEX IF NOT EXISTS idx_salary_structures__effective
  ON public.salary_structures (effective_from, effective_to);

DROP TRIGGER IF EXISTS trg_salary_structures__stamp ON public.salary_structures;
CREATE TRIGGER trg_salary_structures__stamp
  BEFORE INSERT ON public.salary_structures
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp();
DROP TRIGGER IF EXISTS trg_salary_structures__touch ON public.salary_structures;
CREATE TRIGGER trg_salary_structures__touch
  BEFORE UPDATE ON public.salary_structures
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch();

ALTER TABLE public.salary_structures ENABLE ROW LEVEL SECURITY;

-- P8: admin only (matrix: no employee/manager access to structures).
DROP POLICY IF EXISTS salary_structures__admin__select ON public.salary_structures;
CREATE POLICY salary_structures__admin__select ON public.salary_structures
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS salary_structures__admin__insert ON public.salary_structures;
CREATE POLICY salary_structures__admin__insert ON public.salary_structures
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS salary_structures__admin__update ON public.salary_structures;
CREATE POLICY salary_structures__admin__update ON public.salary_structures
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.salary_structures TO authenticated;
REVOKE DELETE ON public.salary_structures FROM authenticated;

-- ----------------------------------------------------------------------------
-- 3. salary_structure_components
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salary_structure_components (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  salary_structure_id         uuid        NOT NULL,
  salary_component_id         uuid        NOT NULL,
  sequence                    integer     NOT NULL DEFAULT 100,
  calc_kind_override          text        NULL,
  percentage_override         numeric(9,4) NULL,
  fixed_amount_override_paise bigint      NULL,
  min_amount_paise            bigint      NULL,
  max_amount_paise            bigint      NULL,
  is_mandatory                boolean     NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL,
  CONSTRAINT pk_salary_structure_components PRIMARY KEY (id),
  CONSTRAINT fk_ssc__salary_structure_id
    FOREIGN KEY (salary_structure_id) REFERENCES public.salary_structures(id) ON DELETE CASCADE,
  CONSTRAINT fk_ssc__salary_component_id
    FOREIGN KEY (salary_component_id) REFERENCES public.salary_components(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ssc__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_ssc__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_ssc__structure_component UNIQUE (salary_structure_id, salary_component_id),
  CONSTRAINT ck_ssc__calc_kind_override CHECK (calc_kind_override IS NULL OR calc_kind_override IN
    ('fixed','pct_of_component','pct_of_gross','pct_of_ctc','balance',
     'formula','slab','attendance_prorated','per_minute','per_unit')),
  CONSTRAINT ck_ssc__pct_override_range
    CHECK (percentage_override IS NULL OR (percentage_override >= 0 AND percentage_override <= 100)),
  CONSTRAINT ck_ssc__min_le_max
    CHECK (min_amount_paise IS NULL OR max_amount_paise IS NULL OR min_amount_paise <= max_amount_paise)
);

COMMENT ON COLUMN public.salary_structure_components.sequence IS 'Evaluation order — balance components must evaluate last.';

CREATE INDEX IF NOT EXISTS idx_ssc__sequence
  ON public.salary_structure_components (salary_structure_id, sequence);
CREATE INDEX IF NOT EXISTS idx_ssc__salary_component_id
  ON public.salary_structure_components (salary_component_id);

DROP TRIGGER IF EXISTS trg_salary_structure_components__stamp ON public.salary_structure_components;
CREATE TRIGGER trg_salary_structure_components__stamp
  BEFORE INSERT ON public.salary_structure_components
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp();
DROP TRIGGER IF EXISTS trg_salary_structure_components__touch ON public.salary_structure_components;
CREATE TRIGGER trg_salary_structure_components__touch
  BEFORE UPDATE ON public.salary_structure_components
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch();

ALTER TABLE public.salary_structure_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS salary_structure_components__admin__select ON public.salary_structure_components;
CREATE POLICY salary_structure_components__admin__select ON public.salary_structure_components
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS salary_structure_components__admin__insert ON public.salary_structure_components;
CREATE POLICY salary_structure_components__admin__insert ON public.salary_structure_components
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS salary_structure_components__admin__update ON public.salary_structure_components;
CREATE POLICY salary_structure_components__admin__update ON public.salary_structure_components
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.salary_structure_components TO authenticated;
REVOKE DELETE ON public.salary_structure_components FROM authenticated;

-- ----------------------------------------------------------------------------
-- 4. statutory_settings — effective-dated statutory rate set; runs PIN a row.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.statutory_settings (
  id                              uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id                      uuid        NOT NULL,
  effective_from                  date        NOT NULL,
  effective_to                    date        NULL,
  pf_employee_pct                 numeric(9,4) NOT NULL DEFAULT 12.0000,
  pf_employer_pct                 numeric(9,4) NOT NULL DEFAULT 12.0000,
  pf_wage_ceiling_paise           bigint      NOT NULL DEFAULT 1500000,
  pf_admin_charges_pct            numeric(9,4) NOT NULL DEFAULT 0.5000,
  eps_pct                         numeric(9,4) NOT NULL DEFAULT 8.3300,
  edli_pct                        numeric(9,4) NOT NULL DEFAULT 0.5000,
  esi_employee_pct                numeric(9,4) NOT NULL DEFAULT 0.7500,
  esi_employer_pct                numeric(9,4) NOT NULL DEFAULT 3.2500,
  esi_wage_ceiling_paise          bigint      NOT NULL DEFAULT 2100000,
  pt_state                        text        NOT NULL DEFAULT 'Karnataka',
  pt_slabs                        jsonb       NOT NULL,
  lwf_employee_amount_paise       bigint      NOT NULL DEFAULT 2000,
  lwf_employer_amount_paise       bigint      NOT NULL DEFAULT 4000,
  lwf_frequency                   text        NOT NULL DEFAULT 'annual_december',
  gratuity_days_per_year          numeric(9,4) NOT NULL DEFAULT 15.0000,
  gratuity_divisor                numeric(9,4) NOT NULL DEFAULT 26.0000,
  gratuity_eligibility_years      numeric(9,4) NOT NULL DEFAULT 5.0000,
  bonus_min_pct                   numeric(9,4) NOT NULL DEFAULT 8.3300,
  bonus_max_pct                   numeric(9,4) NOT NULL DEFAULT 20.0000,
  bonus_wage_ceiling_paise        bigint      NOT NULL DEFAULT 2100000,
  bonus_calculation_ceiling_paise bigint      NOT NULL DEFAULT 700000,
  minimum_wage_config             jsonb       NULL,
  tds_config                      jsonb       NOT NULL,
  overtime_multiplier_statutory   numeric(9,4) NOT NULL DEFAULT 2.0000,
  max_weekly_hours                integer     NOT NULL DEFAULT 48,
  max_daily_hours                 integer     NOT NULL DEFAULT 9,
  max_overtime_hours_per_quarter  integer     NOT NULL DEFAULT 50,
  notes                           text        NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NULL,
  CONSTRAINT pk_statutory_settings PRIMARY KEY (id),
  CONSTRAINT fk_statutory_settings__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_statutory_settings__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_statutory_settings__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_statutory_settings__company_effective UNIQUE (company_id, effective_from),
  CONSTRAINT ck_statutory_settings__range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_statutory_settings__no_sentinel_dates
    CHECK (effective_from <= DATE '2100-01-01'
           AND (effective_to IS NULL OR effective_to <= DATE '2100-01-01')),
  CONSTRAINT ck_statutory_settings__lwf_frequency
    CHECK (lwf_frequency IN ('annual_december','half_yearly','monthly')),
  CONSTRAINT ck_statutory_settings__pcts_nonneg
    CHECK (pf_employee_pct >= 0 AND pf_employer_pct >= 0 AND eps_pct >= 0
           AND edli_pct >= 0 AND esi_employee_pct >= 0 AND esi_employer_pct >= 0
           AND pf_admin_charges_pct >= 0),
  CONSTRAINT ck_statutory_settings__ceilings_nonneg
    CHECK (pf_wage_ceiling_paise >= 0 AND esi_wage_ceiling_paise >= 0
           AND bonus_wage_ceiling_paise >= 0 AND bonus_calculation_ceiling_paise >= 0
           AND lwf_employee_amount_paise >= 0 AND lwf_employer_amount_paise >= 0)
);

COMMENT ON TABLE  public.statutory_settings IS 'Effective-dated statutory rate set. Payroll runs pin a row (payroll_runs.statutory_settings_id) so recomputing an old run cannot apply today''s ceilings.';
COMMENT ON COLUMN public.statutory_settings.pt_slabs IS 'Professional tax slabs, money in integer paise: [{"from":0,"to":2499999,"amount":0},{"from":2500000,"to":null,"amount":20000}].';
COMMENT ON COLUMN public.statutory_settings.minimum_wage_config IS 'Karnataka minimum wages (hospitality) by skill/grade key, monthly integer paise, e.g. {"default":..., "G1":..., "skilled":...}. Checked at payroll compute; a below-minimum gross blocks the run.';
COMMENT ON COLUMN public.statutory_settings.tds_config IS 'Per-regime config, money in integer paise: {"new":{"standard_deduction":7500000,"slabs":[{"from":0,"to":40000000,"pct":0},...],"rebate_87a_threshold":...,"rebate_87a_amount":...,"cess_pct":4},"old":{...}}.';

CREATE INDEX IF NOT EXISTS idx_statutory_settings__company_id
  ON public.statutory_settings (company_id);
CREATE INDEX IF NOT EXISTS idx_statutory_settings__effective
  ON public.statutory_settings (effective_from DESC);

DROP TRIGGER IF EXISTS trg_statutory_settings__stamp ON public.statutory_settings;
CREATE TRIGGER trg_statutory_settings__stamp
  BEFORE INSERT ON public.statutory_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp();
DROP TRIGGER IF EXISTS trg_statutory_settings__touch ON public.statutory_settings;
CREATE TRIGGER trg_statutory_settings__touch
  BEFORE UPDATE ON public.statutory_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch();

ALTER TABLE public.statutory_settings ENABLE ROW LEVEL SECURITY;

-- P7 read: statutory rates are law, not secrets.
DROP POLICY IF EXISTS statutory_settings__authenticated__select ON public.statutory_settings;
CREATE POLICY statutory_settings__authenticated__select ON public.statutory_settings
  FOR SELECT TO authenticated
  USING (true);

-- P9 write: super-admin only.
DROP POLICY IF EXISTS statutory_settings__super_admin__insert ON public.statutory_settings;
CREATE POLICY statutory_settings__super_admin__insert ON public.statutory_settings
  FOR INSERT TO authenticated
  WITH CHECK (app.is_super_admin());

DROP POLICY IF EXISTS statutory_settings__super_admin__update ON public.statutory_settings;
CREATE POLICY statutory_settings__super_admin__update ON public.statutory_settings
  FOR UPDATE TO authenticated
  USING (app.is_super_admin())
  WITH CHECK (app.is_super_admin());

GRANT SELECT, INSERT, UPDATE ON public.statutory_settings TO authenticated;
REVOKE DELETE ON public.statutory_settings FROM authenticated;

-- ----------------------------------------------------------------------------
-- 5. eval_component_formula — restricted arithmetic-expression evaluator.
--    Fixed grammar: numbers, whitelisted variables (resolved from p_vars),
--    + - * / , unary minus, parentheses, and the function set
--    abs/floor/ceil/ceiling/round/min/max/least/greatest.
--    NO SQL, NO EXECUTE of user text — the string is parsed, never run.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eval_component_formula(p_formula text, p_vars jsonb DEFAULT '{}'::jsonb)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT SET search_path = ''
AS $fn$
DECLARE
  v_src        text := lower(p_formula);
  v_len        integer;
  v_pos        integer := 1;
  v_ch         text;
  v_buf        text;
  -- token stream
  v_tk         text[]  := '{}';  -- kinds: num ident op lparen rparen comma
  v_tv         text[]  := '{}';  -- values
  v_n          integer;
  i            integer;
  -- shunting-yard output (RPN): kinds num var op fun
  v_ok         text[]  := '{}';
  v_ov         text[]  := '{}';
  v_oa         integer[] := '{}';
  -- operator stack: '+','-','*','/','neg','(', 'fun:<name>'
  v_ops        text[]  := '{}';
  v_argc       integer[] := '{}';
  v_top        text;
  v_prev_kind  text := '';
  v_this_op    text;
  -- evaluation
  v_st         numeric[] := '{}';
  v_a          numeric;
  v_b          numeric;
  v_fname      text;
  v_fargc      integer;

  FUNCTION_WHITELIST CONSTANT text[] :=
    ARRAY['abs','floor','ceil','ceiling','round','min','max','least','greatest'];
BEGIN
  IF length(v_src) = 0 THEN
    RAISE EXCEPTION 'eval_component_formula: empty formula';
  END IF;
  IF length(v_src) > 1000 THEN
    RAISE EXCEPTION 'eval_component_formula: formula longer than 1000 characters';
  END IF;
  v_len := length(v_src);

  -- ── 1. tokenize ──────────────────────────────────────────────────────────
  WHILE v_pos <= v_len LOOP
    v_ch := substr(v_src, v_pos, 1);
    IF v_ch ~ '\s' THEN
      v_pos := v_pos + 1;
    ELSIF v_ch ~ '[0-9.]' THEN
      v_buf := substring(substr(v_src, v_pos) FROM '^[0-9]*\.?[0-9]+');
      IF v_buf IS NULL THEN
        RAISE EXCEPTION 'eval_component_formula: malformed number at position %', v_pos;
      END IF;
      v_tk := v_tk || 'num'; v_tv := v_tv || v_buf;
      v_pos := v_pos + length(v_buf);
    ELSIF v_ch ~ '[a-z_]' THEN
      v_buf := substring(substr(v_src, v_pos) FROM '^[a-z_][a-z0-9_]*');
      v_tk := v_tk || 'ident'; v_tv := v_tv || v_buf;
      v_pos := v_pos + length(v_buf);
    ELSIF v_ch IN ('+','-','*','/') THEN
      v_tk := v_tk || 'op'; v_tv := v_tv || v_ch;
      v_pos := v_pos + 1;
    ELSIF v_ch = '(' THEN
      v_tk := v_tk || 'lparen'; v_tv := v_tv || v_ch; v_pos := v_pos + 1;
    ELSIF v_ch = ')' THEN
      v_tk := v_tk || 'rparen'; v_tv := v_tv || v_ch; v_pos := v_pos + 1;
    ELSIF v_ch = ',' THEN
      v_tk := v_tk || 'comma'; v_tv := v_tv || v_ch; v_pos := v_pos + 1;
    ELSE
      RAISE EXCEPTION 'eval_component_formula: illegal character "%" at position %', v_ch, v_pos;
    END IF;
  END LOOP;

  v_n := coalesce(array_length(v_tk, 1), 0);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'eval_component_formula: no tokens';
  END IF;
  IF v_n > 200 THEN
    RAISE EXCEPTION 'eval_component_formula: too many tokens (%)', v_n;
  END IF;

  -- ── 2. shunting-yard to RPN ──────────────────────────────────────────────
  i := 1;
  WHILE i <= v_n LOOP
    CASE v_tk[i]
      WHEN 'num' THEN
        v_ok := v_ok || 'num'; v_ov := v_ov || v_tv[i]; v_oa := v_oa || 0;
        v_prev_kind := 'operand';

      WHEN 'ident' THEN
        IF i < v_n AND v_tk[i+1] = 'lparen' THEN
          -- function call
          IF NOT (v_tv[i] = ANY (FUNCTION_WHITELIST)) THEN
            RAISE EXCEPTION 'eval_component_formula: function "%" is not whitelisted', v_tv[i];
          END IF;
          v_ops := v_ops || ('fun:' || v_tv[i]);
          v_prev_kind := 'fun';
        ELSE
          -- variable: must exist in the caller-supplied whitelist
          IF NOT (p_vars ? v_tv[i]) THEN
            RAISE EXCEPTION 'eval_component_formula: unknown variable "%"', v_tv[i];
          END IF;
          v_ok := v_ok || 'var'; v_ov := v_ov || v_tv[i]; v_oa := v_oa || 0;
          v_prev_kind := 'operand';
        END IF;

      WHEN 'lparen' THEN
        v_ops := v_ops || '(';
        IF v_prev_kind = 'fun' THEN
          v_argc := v_argc || 1;   -- function argument counter (>= 1 arg required)
        END IF;
        v_prev_kind := 'open';

      WHEN 'comma' THEN
        LOOP
          IF coalesce(array_length(v_ops,1),0) = 0 THEN
            RAISE EXCEPTION 'eval_component_formula: misplaced comma';
          END IF;
          v_top := v_ops[array_length(v_ops,1)];
          EXIT WHEN v_top = '(';
          v_ops := v_ops[1:array_length(v_ops,1)-1];
          v_ok := v_ok || 'op'; v_ov := v_ov || v_top; v_oa := v_oa || 0;
        END LOOP;
        IF coalesce(array_length(v_argc,1),0) = 0 THEN
          RAISE EXCEPTION 'eval_component_formula: comma outside a function call';
        END IF;
        v_argc[array_length(v_argc,1)] := v_argc[array_length(v_argc,1)] + 1;
        v_prev_kind := 'open';

      WHEN 'rparen' THEN
        LOOP
          IF coalesce(array_length(v_ops,1),0) = 0 THEN
            RAISE EXCEPTION 'eval_component_formula: unbalanced parentheses';
          END IF;
          v_top := v_ops[array_length(v_ops,1)];
          v_ops := v_ops[1:array_length(v_ops,1)-1];
          EXIT WHEN v_top = '(';
          v_ok := v_ok || 'op'; v_ov := v_ov || v_top; v_oa := v_oa || 0;
        END LOOP;
        IF coalesce(array_length(v_ops,1),0) > 0
           AND v_ops[array_length(v_ops,1)] LIKE 'fun:%' THEN
          v_top := v_ops[array_length(v_ops,1)];
          v_ops := v_ops[1:array_length(v_ops,1)-1];
          v_ok := v_ok || 'fun';
          v_ov := v_ov || substr(v_top, 5);
          v_oa := v_oa || v_argc[array_length(v_argc,1)];
          v_argc := v_argc[1:array_length(v_argc,1)-1];
        END IF;
        v_prev_kind := 'operand';

      WHEN 'op' THEN
        v_this_op := v_tv[i];
        IF v_this_op = '-' AND v_prev_kind IN ('', 'open', 'operator', 'fun') THEN
          v_this_op := 'neg';   -- unary minus
        ELSIF v_this_op = '+' AND v_prev_kind IN ('', 'open', 'operator', 'fun') THEN
          i := i + 1; CONTINUE; -- unary plus: no-op
        END IF;
        LOOP
          EXIT WHEN coalesce(array_length(v_ops,1),0) = 0;
          v_top := v_ops[array_length(v_ops,1)];
          EXIT WHEN v_top = '(' OR v_top LIKE 'fun:%';
          -- precedence: neg=4 (right-assoc), * /=3, + -=2 (left-assoc)
          EXIT WHEN NOT (
            (CASE v_top WHEN 'neg' THEN 4 WHEN '*' THEN 3 WHEN '/' THEN 3 ELSE 2 END)
              > (CASE v_this_op WHEN 'neg' THEN 4 WHEN '*' THEN 3 WHEN '/' THEN 3 ELSE 2 END)
            OR (
              (CASE v_top WHEN 'neg' THEN 4 WHEN '*' THEN 3 WHEN '/' THEN 3 ELSE 2 END)
                = (CASE v_this_op WHEN 'neg' THEN 4 WHEN '*' THEN 3 WHEN '/' THEN 3 ELSE 2 END)
              AND v_this_op <> 'neg'  -- neg is right-associative
            )
          );
          v_ops := v_ops[1:array_length(v_ops,1)-1];
          v_ok := v_ok || 'op'; v_ov := v_ov || v_top; v_oa := v_oa || 0;
        END LOOP;
        v_ops := v_ops || v_this_op;
        v_prev_kind := 'operator';
    END CASE;
    i := i + 1;
  END LOOP;

  WHILE coalesce(array_length(v_ops,1),0) > 0 LOOP
    v_top := v_ops[array_length(v_ops,1)];
    v_ops := v_ops[1:array_length(v_ops,1)-1];
    IF v_top = '(' OR v_top LIKE 'fun:%' THEN
      RAISE EXCEPTION 'eval_component_formula: unbalanced parentheses';
    END IF;
    v_ok := v_ok || 'op'; v_ov := v_ov || v_top; v_oa := v_oa || 0;
  END LOOP;

  -- ── 3. evaluate RPN ──────────────────────────────────────────────────────
  FOR i IN 1 .. coalesce(array_length(v_ok,1),0) LOOP
    CASE v_ok[i]
      WHEN 'num' THEN
        v_st := v_st || v_ov[i]::numeric;

      WHEN 'var' THEN
        BEGIN
          v_st := v_st || (p_vars ->> v_ov[i])::numeric;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'eval_component_formula: variable "%" is not numeric', v_ov[i];
        END;

      WHEN 'op' THEN
        IF v_ov[i] = 'neg' THEN
          IF coalesce(array_length(v_st,1),0) < 1 THEN
            RAISE EXCEPTION 'eval_component_formula: malformed expression';
          END IF;
          v_a := v_st[array_length(v_st,1)];
          v_st := v_st[1:array_length(v_st,1)-1];
          v_st := v_st || (-v_a);
        ELSE
          IF coalesce(array_length(v_st,1),0) < 2 THEN
            RAISE EXCEPTION 'eval_component_formula: malformed expression';
          END IF;
          v_b := v_st[array_length(v_st,1)];
          v_a := v_st[array_length(v_st,1)-1];
          v_st := v_st[1:array_length(v_st,1)-2];
          CASE v_ov[i]
            WHEN '+' THEN v_st := v_st || (v_a + v_b);
            WHEN '-' THEN v_st := v_st || (v_a - v_b);
            WHEN '*' THEN v_st := v_st || (v_a * v_b);
            WHEN '/' THEN
              IF v_b = 0 THEN
                RAISE EXCEPTION 'eval_component_formula: division by zero';
              END IF;
              v_st := v_st || (v_a / v_b);
          END CASE;
        END IF;

      WHEN 'fun' THEN
        v_fname := v_ov[i];
        v_fargc := v_oa[i];
        IF v_fname IN ('abs','floor','ceil','ceiling') THEN
          IF v_fargc <> 1 THEN
            RAISE EXCEPTION 'eval_component_formula: %() takes exactly 1 argument', v_fname;
          END IF;
          v_a := v_st[array_length(v_st,1)];
          v_st := v_st[1:array_length(v_st,1)-1];
          v_st := v_st || (CASE v_fname
                             WHEN 'abs'   THEN abs(v_a)
                             WHEN 'floor' THEN floor(v_a)
                             ELSE ceiling(v_a)
                           END);
        ELSIF v_fname = 'round' THEN
          IF v_fargc = 1 THEN
            v_a := v_st[array_length(v_st,1)];
            v_st := v_st[1:array_length(v_st,1)-1];
            v_st := v_st || round(v_a);
          ELSIF v_fargc = 2 THEN
            v_b := v_st[array_length(v_st,1)];
            v_a := v_st[array_length(v_st,1)-1];
            v_st := v_st[1:array_length(v_st,1)-2];
            v_st := v_st || round(v_a, v_b::integer);
          ELSE
            RAISE EXCEPTION 'eval_component_formula: round() takes 1 or 2 arguments';
          END IF;
        ELSIF v_fname IN ('min','least','max','greatest') THEN
          IF v_fargc <> 2 THEN
            RAISE EXCEPTION 'eval_component_formula: %() takes exactly 2 arguments', v_fname;
          END IF;
          v_b := v_st[array_length(v_st,1)];
          v_a := v_st[array_length(v_st,1)-1];
          v_st := v_st[1:array_length(v_st,1)-2];
          v_st := v_st || (CASE WHEN v_fname IN ('min','least')
                                THEN least(v_a, v_b) ELSE greatest(v_a, v_b) END);
        END IF;
    END CASE;
  END LOOP;

  IF coalesce(array_length(v_st,1),0) <> 1 THEN
    RAISE EXCEPTION 'eval_component_formula: malformed expression (stack depth %)',
      coalesce(array_length(v_st,1),0);
  END IF;
  RETURN v_st[1];
END;
$fn$;

COMMENT ON FUNCTION public.eval_component_formula(text, jsonb) IS
  'Evaluates a salary-component formula over a whitelisted variable set (basic, gross, ctc, paid_days, period_days, ot_minutes, per_minute_rate, ...). Fixed grammar (numbers, vars, + - * /, parens, abs/floor/ceil/round/min/max/least/greatest). Never executes user text as SQL.';

REVOKE ALL ON FUNCTION public.eval_component_formula(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.eval_component_formula(text, jsonb) TO authenticated;

COMMIT;
