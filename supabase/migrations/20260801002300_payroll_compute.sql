-- ============================================================================
-- Migration 023: payroll compute engine
--   compute_payslip(employee_id, payroll_run_id), compute_payroll_run,
--   finalise_payroll_run, reverse_payslip.
--   PF / ESI / PT (Karnataka) / LWF / TDS / OT / gratuity-provision logic
--   reads the run's PINNED statutory_settings row; minimum-wage guard.
-- Source: docs/plan/04-data-model.md §3.8, §13 row 023, §9.2 (paid-days
--         definition), §4.4 matrix.
-- Money: integer paise everywhere (matches 020/021/022). Rounding: PF/EPS/
--   EDLI and TDS round to the nearest rupee; ESI rounds UP to the next rupee
--   (statutory convention); PT/LWF are exact slab amounts.
-- Notes:
--   * attendance_days/attendance_locks (017) and reimbursement_claims/
--     bonus_incentives (024) are referenced from plpgsql bodies only, so this
--     file creates cleanly regardless of apply order; 024-table reads are
--     additionally guarded with to_regclass().
--   * Late deductions are NOT re-deducted here: they materialise as leave
--     debits / LWP in attendance_days.day_fraction_paid (§8.4), and are
--     reported on the payslip via late_deduction_days.
--   * TDS is a monthly projection over the pinned tds_config (standard
--     deduction + slabs + 87A rebate + cess, catch-up on YTD), not a full
--     Chapter VI-A engine — investment declarations arrive in Phase 3.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. compute_payslip(p_employee_id, p_payroll_run_id) -> payslip id
--    Idempotent per (run, employee): recompute updates the same payslip row
--    (number preserved), replaces its lines, and appends a fresh immutable
--    payroll_inputs_snapshot.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_payslip(p_employee_id uuid, p_payroll_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_run        public.payroll_runs%ROWTYPE;
  v_period     public.pay_periods%ROWTYPE;
  v_stat       public.statutory_settings%ROWTYPE;
  v_emp        public.employees%ROWTYPE;
  v_es         public.employee_statutory%ROWTYPE;
  v_rev        public.employee_salary_revisions%ROWTYPE;
  v_att        record;
  v_c          record;
  v_slab       record;

  v_payslip_id uuid;
  v_snapshot_id uuid;
  v_period_days integer;
  v_proration  numeric;
  v_seq        integer := 0;

  -- component accumulation (pass 1)
  v_codes      text[]  := '{}';
  v_fulls      bigint[] := '{}';
  v_calc       text;
  v_pct        numeric;
  v_fixed      bigint;
  v_rev_amt    bigint;
  v_full       bigint;
  v_earned     bigint;
  v_base_ix    integer;
  v_basis      jsonb;

  v_gross_full   bigint := 0;   -- bucket-A full-month entitlement
  v_gross_earned bigint := 0;
  v_taxable_earned bigint := 0;
  v_pf_wage_earned  bigint := 0;
  v_esi_wage_full   bigint := 0;
  v_esi_wage_earned bigint := 0;
  v_pt_wage_earned  bigint := 0;
  v_basic_full   bigint := 0;

  -- statutory outputs
  v_pf_base    bigint;
  v_amt        bigint;
  v_eps        bigint := 0;
  v_pf_er      bigint := 0;

  -- TDS
  v_regime     text;
  v_tds_cfg    jsonb;
  v_annual     numeric;
  v_tax        numeric := 0;
  v_cess       numeric := 0;
  v_months_left integer;
  v_tds        bigint := 0;

  -- prior YTD chain (same financial year)
  v_fy         text;
  v_prior      record;

  -- totals
  v_tot_earn   bigint := 0;
  v_tot_ded    bigint := 0;
  v_tot_er     bigint := 0;
  v_tot_reimb  bigint := 0;
  v_net        bigint := 0;

  -- exceptions
  v_holds      text[] := '{}';
  v_bank_account_id uuid;
  v_min_wage   bigint;
  v_grade_code text;
  v_days_json  jsonb;
  v_snapshot   jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT app.is_admin() THEN
    RAISE EXCEPTION 'compute_payslip: admin or service role required'
      USING errcode = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_payroll_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_payslip: payroll run % not found', p_payroll_run_id;
  END IF;
  IF v_run.status NOT IN ('draft','inputs_locked','computed','in_review','failed') THEN
    RAISE EXCEPTION 'compute_payslip: run % is % — recompute is only allowed before approval',
      v_run.run_number, v_run.status USING errcode = '0A000';
  END IF;

  SELECT * INTO v_period FROM public.pay_periods WHERE id = v_run.pay_period_id;
  SELECT * INTO v_stat   FROM public.statutory_settings WHERE id = v_run.statutory_settings_id;
  SELECT * INTO v_emp    FROM public.employees WHERE id = p_employee_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_payslip: employee % not found', p_employee_id;
  END IF;

  -- Eligibility: excluded employees get an 'excluded' run row, no payslip.
  IF v_emp.exclude_from_payroll
     OR v_emp.date_of_join IS NULL
     OR v_emp.date_of_join > v_period.end_date
     OR (v_emp.last_working_day IS NOT NULL AND v_emp.last_working_day < v_period.start_date) THEN
    INSERT INTO public.payroll_run_employees AS pre
           (payroll_run_id, employee_id, status, exclusion_reason)
    VALUES (p_payroll_run_id, p_employee_id, 'excluded',
            CASE WHEN v_emp.exclude_from_payroll THEN 'flagged exclude_from_payroll'
                 ELSE 'not employed during pay period' END)
    ON CONFLICT (payroll_run_id, employee_id) DO UPDATE
      SET status = 'excluded',
          exclusion_reason = EXCLUDED.exclusion_reason,
          payslip_id = NULL, computed_at = NULL, error_detail = NULL, hold_reason = NULL;
    RETURN NULL;
  END IF;

  SELECT * INTO v_es FROM public.employee_statutory WHERE employee_id = p_employee_id;

  -- Pinned salary revision: latest approved revision in force at period end.
  SELECT * INTO v_rev
    FROM public.employee_salary_revisions r
   WHERE r.employee_id = p_employee_id
     AND r.status = 'approved'
     AND r.effective_from <= v_period.end_date
   ORDER BY r.effective_from DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_payslip: no approved salary revision in force for employee % at %',
      v_emp.employee_code, v_period.end_date;
  END IF;

  v_period_days := CASE v_period.month_days_basis
                     WHEN 'fixed_30' THEN 30
                     WHEN 'fixed_26' THEN 26
                     ELSE (v_period.end_date - v_period.start_date + 1)
                   END;

  -- ── Attendance aggregates: THE one definition of paid days ───────────────
  SELECT
    COALESCE(SUM(ad.day_fraction_paid), 0)                                        AS paid_days,
    COALESCE(SUM(CASE WHEN ad.status NOT IN ('not_yet_joined','post_exit','pending')
                      THEN 1 - ad.day_fraction_paid ELSE 0 END), 0)               AS lop_days,
    COALESCE(SUM(ad.day_fraction_paid) FILTER (WHERE ad.status IN
      ('present','half_day','weekly_off_worked','holiday_worked','on_duty','work_from_home')), 0)
                                                                                  AS present_days,
    COUNT(*) FILTER (WHERE ad.is_weekly_off)                                      AS weekly_off_days,
    COUNT(*) FILTER (WHERE ad.is_holiday)                                         AS holiday_days,
    COALESCE(SUM(ad.leave_day_fraction) FILTER (WHERE ad.status IN
      ('on_leave','on_leave_half','comp_off_availed') AND ad.day_fraction_paid > 0), 0)
                                                                                  AS leave_days_paid,
    COALESCE(SUM(ad.leave_day_fraction) FILTER (WHERE ad.status IN
      ('on_leave','on_leave_half') AND ad.day_fraction_paid = 0), 0)              AS leave_days_unpaid,
    COALESCE(SUM(ad.approved_overtime_minutes), 0)::integer                       AS ot_minutes,
    COALESCE(SUM(ad.extra_work_minutes), 0)::integer                              AS extra_minutes,
    COALESCE(SUM(ad.late_deduction_leave_days), 0)                                AS late_ded_days,
    COUNT(*) FILTER (WHERE s.night_shift AND ad.day_fraction_paid > 0)            AS night_days,
    COALESCE(array_agg(ad.id), '{}')                                              AS day_ids,
    COALESCE(jsonb_agg(jsonb_build_object(
      'date', ad.ist_date, 'status', ad.status,
      'worked_minutes', ad.payable_worked_minutes,
      'ot_minutes', ad.approved_overtime_minutes,
      'fraction', ad.day_fraction_paid) ORDER BY ad.ist_date), '[]'::jsonb)       AS days_json
    INTO v_att
    FROM public.attendance_days ad
    LEFT JOIN public.shifts s ON s.id = ad.shift_id
   WHERE ad.employee_id = p_employee_id
     AND ad.ist_date BETWEEN v_period.start_date AND v_period.end_date;

  v_days_json := v_att.days_json;
  v_proration := LEAST(1, round(v_att.paid_days / v_period_days, 6));

  -- Prior YTD chain (latest non-reversed payslip earlier in this FY).
  v_fy := util.financial_year(v_period.end_date);
  SELECT p.ytd_gross_paise, p.ytd_deductions_paise, p.ytd_net_paise, p.ytd_tds_paise
    INTO v_prior
    FROM public.payslips p
    JOIN public.pay_periods pp ON pp.id = p.pay_period_id
   WHERE p.employee_id = p_employee_id
     AND pp.financial_year = v_fy
     AND p.period_start < v_period.start_date
     AND p.is_reversed = false
   ORDER BY p.period_start DESC
   LIMIT 1;
  IF NOT FOUND THEN
    SELECT 0::bigint AS ytd_gross_paise, 0::bigint AS ytd_deductions_paise,
           0::bigint AS ytd_net_paise,   0::bigint AS ytd_tds_paise
      INTO v_prior;
  END IF;

  -- ── Upsert payslip shell first (lines carry an FK to it) ─────────────────
  SELECT id INTO v_payslip_id
    FROM public.payslips
   WHERE payroll_run_id = p_payroll_run_id AND employee_id = p_employee_id;

  SELECT id INTO v_bank_account_id
    FROM public.employee_bank_accounts
   WHERE employee_id = p_employee_id AND is_active
   ORDER BY effective_from DESC
   LIMIT 1;

  IF v_payslip_id IS NULL THEN
    INSERT INTO public.payslips
      (payroll_run_id, employee_id, pay_period_id, payslip_number,
       period_start, period_end, pay_date, period_days, paid_days,
       payment_mode, bank_account_id)
    VALUES
      (p_payroll_run_id, p_employee_id, v_period.id,
       v_emp.employee_code || '/' || v_period.code
         || CASE WHEN v_run.run_kind = 'regular' THEN ''
                 ELSE '-' || upper(substr(v_run.run_kind, 1, 3)) END,
       v_period.start_date, v_period.end_date, v_period.pay_date,
       v_period_days, v_att.paid_days, v_emp.payment_mode, v_bank_account_id)
    RETURNING id INTO v_payslip_id;
  ELSE
    DELETE FROM public.payslip_lines WHERE payslip_id = v_payslip_id;
  END IF;

  -- ── Pass 1: earnings from the structure / revision breakup ───────────────
  -- Statutory codes are skipped here and computed authoritatively in pass 2.
  FOR v_c IN
    SELECT c.id, c.code, c.name, c.line_kind, c.calc_kind, c.percentage,
           c.fixed_amount_paise, c.formula, c.base_component_id,
           c.is_taxable, c.is_pf_wage, c.is_esi_wage, c.is_pt_wage,
           c.prorate_on_paid_days, c.affects_gross, c.ctc_bucket,
           bc.code AS base_code,
           sc.sequence, sc.calc_kind_override, sc.percentage_override,
           sc.fixed_amount_override_paise, sc.min_amount_paise, sc.max_amount_paise
      FROM public.salary_structure_components sc
      JOIN public.salary_components c  ON c.id = sc.salary_component_id
      LEFT JOIN public.salary_components bc ON bc.id = c.base_component_id
     WHERE sc.salary_structure_id = v_rev.salary_structure_id
       AND v_rev.salary_structure_id IS NOT NULL
       AND c.line_kind = 'earning'
       AND c.code NOT IN ('OT','NIGHT_ALLOW','PF_EE','ESI_EE','PT','LWF_EE','TDS',
                          'PF_ER','EPS_ER','EDLI_ER','ESI_ER','LWF_ER','GRATUITY_PROV')
    UNION ALL
    -- revision without a structure: pay the revision breakup as-is
    SELECT c.id, c.code, c.name, c.line_kind, c.calc_kind, c.percentage,
           c.fixed_amount_paise, c.formula, c.base_component_id,
           c.is_taxable, c.is_pf_wage, c.is_esi_wage, c.is_pt_wage,
           c.prorate_on_paid_days, c.affects_gross, c.ctc_bucket,
           bc.code AS base_code,
           rl.sequence, NULL, NULL, NULL, NULL, NULL
      FROM public.employee_salary_revision_lines rl
      JOIN public.salary_components c  ON c.id = rl.salary_component_id
      LEFT JOIN public.salary_components bc ON bc.id = c.base_component_id
     WHERE rl.revision_id = v_rev.id
       AND v_rev.salary_structure_id IS NULL
       AND c.line_kind = 'earning'
     ORDER BY sequence
  LOOP
    v_seq   := v_seq + 10;
    v_calc  := COALESCE(v_c.calc_kind_override, v_c.calc_kind);
    v_pct   := COALESCE(v_c.percentage_override, v_c.percentage);
    v_fixed := COALESCE(v_c.fixed_amount_override_paise, v_c.fixed_amount_paise);

    SELECT rl.monthly_amount_paise INTO v_rev_amt
      FROM public.employee_salary_revision_lines rl
     WHERE rl.revision_id = v_rev.id AND rl.salary_component_id = v_c.id;

    IF v_rev_amt IS NOT NULL THEN
      v_full  := v_rev_amt;
      v_basis := jsonb_build_object('basis', 'salary_revision_line',
                                    'revision_id', v_rev.id);
    ELSIF v_calc = 'fixed' OR v_calc = 'attendance_prorated' THEN
      v_full  := COALESCE(v_fixed, 0);
      v_basis := jsonb_build_object('basis', v_calc, 'fixed_amount_paise', v_full);
    ELSIF v_calc = 'pct_of_component' THEN
      v_base_ix := array_position(v_codes, v_c.base_code);
      IF v_base_ix IS NULL THEN
        RAISE EXCEPTION 'compute_payslip: %% base component % must precede % in structure sequence',
          v_c.base_code, v_c.code;
      END IF;
      v_full  := round(COALESCE(v_pct, 0) / 100.0 * v_fulls[v_base_ix])::bigint;
      v_basis := jsonb_build_object('basis', 'pct_of_component',
                   'base_component', v_c.base_code,
                   'base_amount_paise', v_fulls[v_base_ix], 'percentage', v_pct);
    ELSIF v_calc = 'pct_of_gross' THEN
      v_full  := round(COALESCE(v_pct, 0) / 100.0 * v_rev.monthly_gross_paise)::bigint;
      v_basis := jsonb_build_object('basis', 'pct_of_gross',
                   'gross_paise', v_rev.monthly_gross_paise, 'percentage', v_pct);
    ELSIF v_calc = 'pct_of_ctc' THEN
      v_full  := round(COALESCE(v_pct, 0) / 100.0 * v_rev.monthly_ctc_paise)::bigint;
      v_basis := jsonb_build_object('basis', 'pct_of_ctc',
                   'ctc_paise', v_rev.monthly_ctc_paise, 'percentage', v_pct);
    ELSIF v_calc = 'balance' THEN
      v_full  := GREATEST(0, v_rev.monthly_gross_paise - v_gross_full);
      v_basis := jsonb_build_object('basis', 'balance',
                   'gross_paise', v_rev.monthly_gross_paise,
                   'allocated_paise', v_gross_full);
    ELSIF v_calc = 'formula' THEN
      v_full  := round(public.eval_component_formula(v_c.formula, jsonb_build_object(
                   'basic', v_basic_full, 'gross', v_rev.monthly_gross_paise,
                   'ctc', v_rev.monthly_ctc_paise, 'paid_days', v_att.paid_days,
                   'period_days', v_period_days, 'ot_minutes', v_att.ot_minutes)))::bigint;
      v_basis := jsonb_build_object('basis', 'formula', 'formula', v_c.formula);
    ELSE
      CONTINUE;  -- slab/per_minute/per_unit earnings are pass-2 responsibilities
    END IF;

    IF v_c.min_amount_paise IS NOT NULL THEN v_full := GREATEST(v_full, v_c.min_amount_paise); END IF;
    IF v_c.max_amount_paise IS NOT NULL THEN v_full := LEAST(v_full, v_c.max_amount_paise); END IF;

    v_earned := CASE WHEN v_c.prorate_on_paid_days
                     THEN round(v_full * v_proration)::bigint ELSE v_full END;
    v_basis  := v_basis || jsonb_build_object('full_month_paise', v_full,
                  'paid_days', v_att.paid_days, 'period_days', v_period_days,
                  'proration', CASE WHEN v_c.prorate_on_paid_days THEN v_proration ELSE 1 END);

    v_codes := v_codes || v_c.code;
    v_fulls := v_fulls || v_full;
    IF v_c.code = 'BASIC' THEN v_basic_full := v_full; END IF;
    IF v_c.affects_gross AND v_c.ctc_bucket = 'A' THEN
      v_gross_full   := v_gross_full + v_full;
      v_gross_earned := v_gross_earned + v_earned;
    END IF;
    IF v_c.is_taxable  THEN v_taxable_earned  := v_taxable_earned + v_earned; END IF;
    IF v_c.is_pf_wage  THEN v_pf_wage_earned  := v_pf_wage_earned + v_earned; END IF;
    IF v_c.is_esi_wage THEN v_esi_wage_full   := v_esi_wage_full + v_full;
                            v_esi_wage_earned := v_esi_wage_earned + v_earned; END IF;
    IF v_c.is_pt_wage  THEN v_pt_wage_earned  := v_pt_wage_earned + v_earned; END IF;

    v_tot_earn := v_tot_earn + v_earned;
    INSERT INTO public.payslip_lines
      (payslip_id, salary_component_id, label, line_kind, sequence,
       full_month_amount_paise, amount_paise, calc_kind, calc_basis, is_prorated)
    VALUES
      (v_payslip_id, v_c.id, v_c.name, 'earning', v_seq,
       v_full, v_earned, v_calc, v_basis, v_c.prorate_on_paid_days AND v_earned <> v_full);
  END LOOP;

  -- ── Minimum-wage guard: below-minimum full-month gross blocks the run ────
  IF v_stat.minimum_wage_config IS NOT NULL THEN
    SELECT g.code INTO v_grade_code FROM public.grades g WHERE g.id = v_emp.grade_id;
    v_min_wage := COALESCE(
      (v_stat.minimum_wage_config ->> COALESCE(v_grade_code, ''))::bigint,
      (v_stat.minimum_wage_config ->> 'default')::bigint);
    IF v_min_wage IS NOT NULL AND v_gross_full < v_min_wage THEN
      RAISE EXCEPTION 'minimum_wage_violation: employee % full-month gross % paise is below the Karnataka minimum % paise',
        v_emp.employee_code, v_gross_full, v_min_wage USING errcode = '23514';
    END IF;
  END IF;

  -- ── Pass 2: OT, night allowance, statutory deductions & contributions ────
  v_seq := 1000;

  -- Overtime: approved minutes only; per-minute = multiplier × basic/(26×8×60).
  IF v_emp.is_ot_eligible AND v_att.ot_minutes > 0 THEN
    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'OT' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_amt := round(v_att.ot_minutes
                     * v_stat.overtime_multiplier_statutory * v_basic_full
                     / (26.0 * 8 * 60))::bigint;
      v_seq := v_seq + 10;
      v_tot_earn := v_tot_earn + v_amt;
      IF v_c.is_taxable  THEN v_taxable_earned  := v_taxable_earned + v_amt; END IF;
      IF v_c.is_pf_wage  THEN v_pf_wage_earned  := v_pf_wage_earned + v_amt; END IF;
      IF v_c.is_esi_wage THEN v_esi_wage_earned := v_esi_wage_earned + v_amt; END IF;
      IF v_c.is_pt_wage  THEN v_pt_wage_earned  := v_pt_wage_earned + v_amt; END IF;
      IF v_c.affects_gross THEN v_gross_earned := v_gross_earned + v_amt; END IF;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES
        (v_payslip_id, v_c.id, v_c.name, 'earning', v_seq, v_amt, v_amt, 'per_minute',
         jsonb_build_object('basis', 'per_minute', 'ot_minutes', v_att.ot_minutes,
           'multiplier', v_stat.overtime_multiplier_statutory,
           'basic_paise', v_basic_full, 'divisor', '26*8*60'));
    END IF;
  END IF;

  -- Night allowance: fixed amount per night-shift day worked.
  IF v_att.night_days > 0 THEN
    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'NIGHT_ALLOW' AND c.deleted_at IS NULL;
    IF FOUND AND COALESCE(v_c.fixed_amount_paise, 0) > 0 THEN
      v_amt := v_att.night_days * v_c.fixed_amount_paise;
      v_seq := v_seq + 10;
      v_tot_earn := v_tot_earn + v_amt;
      IF v_c.is_taxable  THEN v_taxable_earned  := v_taxable_earned + v_amt; END IF;
      IF v_c.is_esi_wage THEN v_esi_wage_earned := v_esi_wage_earned + v_amt; END IF;
      IF v_c.is_pt_wage  THEN v_pt_wage_earned  := v_pt_wage_earned + v_amt; END IF;
      IF v_c.affects_gross THEN v_gross_earned := v_gross_earned + v_amt; END IF;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES
        (v_payslip_id, v_c.id, v_c.name, 'earning', v_seq, v_amt, v_amt, 'per_unit',
         jsonb_build_object('basis', 'per_unit', 'units', v_att.night_days,
           'rate_paise', v_c.fixed_amount_paise, 'unit', 'night_shift_day'));
    END IF;
  END IF;

  -- Reimbursements / bonuses routed through this run (tables from 024).
  IF to_regclass('public.reimbursement_claims') IS NOT NULL THEN
    FOR v_c IN
      SELECT rc.id, rc.claim_number, rc.total_approved_paise
        FROM public.reimbursement_claims rc
       WHERE rc.employee_id = p_employee_id
         AND rc.paid_via_payroll_run_id = p_payroll_run_id
         AND rc.status = 'approved'
         AND COALESCE(rc.total_approved_paise, 0) > 0
    LOOP
      v_seq := v_seq + 10;
      v_tot_reimb := v_tot_reimb + v_c.total_approved_paise;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES
        (v_payslip_id, NULL, 'Reimbursement ' || v_c.claim_number, 'reimbursement', v_seq,
         v_c.total_approved_paise, v_c.total_approved_paise, 'fixed',
         jsonb_build_object('reason', 'approved reimbursement claim',
                            'claim_id', v_c.id, 'claim_number', v_c.claim_number));
    END LOOP;
  END IF;

  IF to_regclass('public.bonus_incentives') IS NOT NULL THEN
    FOR v_c IN
      SELECT b.id, b.bonus_kind, b.amount_paise, b.is_taxable, b.salary_component_id
        FROM public.bonus_incentives b
       WHERE b.employee_id = p_employee_id
         AND b.paid_via_payroll_run_id = p_payroll_run_id
         AND b.status = 'approved'
         AND b.amount_paise > 0
    LOOP
      v_seq := v_seq + 10;
      v_tot_earn := v_tot_earn + v_c.amount_paise;
      v_gross_earned := v_gross_earned + v_c.amount_paise;
      IF v_c.is_taxable THEN v_taxable_earned := v_taxable_earned + v_c.amount_paise; END IF;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES
        (v_payslip_id, v_c.salary_component_id,
         initcap(replace(v_c.bonus_kind, '_', ' ')), 'earning', v_seq,
         v_c.amount_paise, v_c.amount_paise, 'fixed',
         jsonb_build_object('reason', 'approved bonus/incentive', 'bonus_id', v_c.id,
                            'bonus_kind', v_c.bonus_kind));
    END LOOP;
  END IF;

  v_seq := 2000;

  -- PF (employee + employer split incl. EPS/EDLI), on PF wages, ceiling-capped.
  IF COALESCE(v_es.pf_applicable, true) AND v_pf_wage_earned > 0 THEN
    v_pf_base := v_pf_wage_earned;
    IF COALESCE(v_es.pf_wage_ceiling_applied, true) THEN
      v_pf_base := LEAST(v_pf_base, v_stat.pf_wage_ceiling_paise);
    END IF;

    -- PF_EE
    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'PF_EE' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_amt := (round(v_pf_base * v_stat.pf_employee_pct / 100.0 / 100.0) * 100)::bigint;
      v_seq := v_seq + 10; v_tot_ded := v_tot_ded + v_amt;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'deduction', v_seq, v_amt, v_amt, 'slab',
        jsonb_build_object('basis', 'pf', 'pf_wage_paise', v_pf_wage_earned,
          'capped_base_paise', v_pf_base, 'pct', v_stat.pf_employee_pct,
          'ceiling_paise', v_stat.pf_wage_ceiling_paise,
          'statutory_settings_id', v_stat.id));
    END IF;

    -- EPS_ER (on ceiling-capped wage), then PF_ER = employer PF − EPS, EDLI_ER.
    v_eps := CASE WHEN COALESCE(v_es.eps_applicable, true)
      THEN (round(LEAST(v_pf_wage_earned, v_stat.pf_wage_ceiling_paise)
                  * v_stat.eps_pct / 100.0 / 100.0) * 100)::bigint
      ELSE 0 END;
    v_pf_er := GREATEST(0,
      (round(v_pf_base * v_stat.pf_employer_pct / 100.0 / 100.0) * 100)::bigint - v_eps);

    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'EPS_ER' AND c.deleted_at IS NULL;
    IF FOUND AND v_eps > 0 THEN
      v_seq := v_seq + 10; v_tot_er := v_tot_er + v_eps;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'employer_contribution', v_seq, v_eps, v_eps, 'slab',
        jsonb_build_object('basis', 'eps', 'pct', v_stat.eps_pct,
          'capped_base_paise', LEAST(v_pf_wage_earned, v_stat.pf_wage_ceiling_paise)));
    END IF;

    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'PF_ER' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_seq := v_seq + 10; v_tot_er := v_tot_er + v_pf_er;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'employer_contribution', v_seq, v_pf_er, v_pf_er, 'slab',
        jsonb_build_object('basis', 'pf_employer', 'pct', v_stat.pf_employer_pct,
          'capped_base_paise', v_pf_base, 'eps_deducted_paise', v_eps));
    END IF;

    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'EDLI_ER' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_amt := (round(LEAST(v_pf_wage_earned, v_stat.pf_wage_ceiling_paise)
                      * v_stat.edli_pct / 100.0 / 100.0) * 100)::bigint;
      v_seq := v_seq + 10; v_tot_er := v_tot_er + v_amt;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'employer_contribution', v_seq, v_amt, v_amt, 'slab',
        jsonb_build_object('basis', 'edli', 'pct', v_stat.edli_pct));
    END IF;
  END IF;

  -- ESI: only while the full-month ESI wage is within the ceiling. EE rounds UP.
  IF COALESCE(v_es.esi_applicable, false)
     AND v_esi_wage_full <= v_stat.esi_wage_ceiling_paise
     AND v_esi_wage_earned > 0 THEN
    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'ESI_EE' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_amt := (ceil(v_esi_wage_earned * v_stat.esi_employee_pct / 100.0 / 100.0) * 100)::bigint;
      v_seq := v_seq + 10; v_tot_ded := v_tot_ded + v_amt;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'deduction', v_seq, v_amt, v_amt, 'slab',
        jsonb_build_object('basis', 'esi', 'esi_wage_paise', v_esi_wage_earned,
          'pct', v_stat.esi_employee_pct, 'ceiling_paise', v_stat.esi_wage_ceiling_paise));
    END IF;

    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'ESI_ER' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_amt := (ceil(v_esi_wage_earned * v_stat.esi_employer_pct / 100.0 / 100.0) * 100)::bigint;
      v_seq := v_seq + 10; v_tot_er := v_tot_er + v_amt;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'employer_contribution', v_seq, v_amt, v_amt, 'slab',
        jsonb_build_object('basis', 'esi_employer', 'pct', v_stat.esi_employer_pct));
    END IF;
  END IF;

  -- Professional tax: Karnataka slab over PT wages (pinned pt_slabs, paise).
  IF COALESCE(v_es.professional_tax_applicable, true) THEN
    v_amt := 0;
    FOR v_slab IN
      SELECT (e ->> 'from')::bigint AS slab_from,
             NULLIF(e ->> 'to', '')::bigint AS slab_to,
             COALESCE((e ->> 'amount')::bigint, 0) AS amount
        FROM jsonb_array_elements(v_stat.pt_slabs) e
    LOOP
      IF v_pt_wage_earned >= v_slab.slab_from
         AND (v_slab.slab_to IS NULL OR v_pt_wage_earned <= v_slab.slab_to) THEN
        v_amt := v_slab.amount;
      END IF;
    END LOOP;
    IF v_amt > 0 THEN
      SELECT c.* INTO v_c FROM public.salary_components c
       WHERE c.company_id = v_emp.company_id AND c.code = 'PT' AND c.deleted_at IS NULL;
      IF FOUND THEN
        v_seq := v_seq + 10; v_tot_ded := v_tot_ded + v_amt;
        INSERT INTO public.payslip_lines
          (payslip_id, salary_component_id, label, line_kind, sequence,
           full_month_amount_paise, amount_paise, calc_kind, calc_basis)
        VALUES (v_payslip_id, v_c.id, v_c.name, 'deduction', v_seq, v_amt, v_amt, 'slab',
          jsonb_build_object('basis', 'pt_slab', 'state', v_stat.pt_state,
            'pt_wage_paise', v_pt_wage_earned, 'slabs', v_stat.pt_slabs));
      END IF;
    END IF;
  END IF;

  -- LWF: Karnataka annual, deducted in the December-ending period.
  IF COALESCE(v_es.lwf_applicable, true)
     AND v_stat.lwf_frequency = 'annual_december'
     AND EXTRACT(MONTH FROM v_period.end_date) = 12 THEN
    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'LWF_EE' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_seq := v_seq + 10; v_tot_ded := v_tot_ded + v_stat.lwf_employee_amount_paise;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'deduction', v_seq,
        v_stat.lwf_employee_amount_paise, v_stat.lwf_employee_amount_paise, 'fixed',
        jsonb_build_object('basis', 'lwf', 'frequency', v_stat.lwf_frequency));
    END IF;
    SELECT c.* INTO v_c FROM public.salary_components c
     WHERE c.company_id = v_emp.company_id AND c.code = 'LWF_ER' AND c.deleted_at IS NULL;
    IF FOUND THEN
      v_seq := v_seq + 10; v_tot_er := v_tot_er + v_stat.lwf_employer_amount_paise;
      INSERT INTO public.payslip_lines
        (payslip_id, salary_component_id, label, line_kind, sequence,
         full_month_amount_paise, amount_paise, calc_kind, calc_basis)
      VALUES (v_payslip_id, v_c.id, v_c.name, 'employer_contribution', v_seq,
        v_stat.lwf_employer_amount_paise, v_stat.lwf_employer_amount_paise, 'fixed',
        jsonb_build_object('basis', 'lwf_employer', 'frequency', v_stat.lwf_frequency));
    END IF;
  END IF;

  -- Gratuity provision (bucket C, informational employer cost): 15/26 × basic / 12.
  SELECT c.* INTO v_c FROM public.salary_components c
   WHERE c.company_id = v_emp.company_id AND c.code = 'GRATUITY_PROV' AND c.deleted_at IS NULL;
  IF FOUND AND v_basic_full > 0 THEN
    v_amt := round(v_basic_full * v_stat.gratuity_days_per_year
                   / v_stat.gratuity_divisor / 12.0)::bigint;
    v_seq := v_seq + 10; v_tot_er := v_tot_er + v_amt;
    INSERT INTO public.payslip_lines
      (payslip_id, salary_component_id, label, line_kind, sequence,
       full_month_amount_paise, amount_paise, calc_kind, calc_basis)
    VALUES (v_payslip_id, v_c.id, v_c.name, 'employer_contribution', v_seq, v_amt, v_amt, 'formula',
      jsonb_build_object('basis', 'gratuity_provision',
        'days_per_year', v_stat.gratuity_days_per_year,
        'divisor', v_stat.gratuity_divisor, 'basic_paise', v_basic_full));
  END IF;

  -- TDS: monthly projection over the pinned regime config, with YTD catch-up.
  v_regime  := COALESCE(v_es.tax_regime, 'new');
  v_tds_cfg := v_stat.tds_config -> v_regime;
  IF v_tds_cfg IS NOT NULL THEN
    v_annual := GREATEST(0,
      v_taxable_earned * 12
      - COALESCE((v_tds_cfg ->> 'standard_deduction')::numeric, 0));
    v_tax := 0;
    FOR v_slab IN
      SELECT (e ->> 'from')::numeric AS slab_from,
             NULLIF(e ->> 'to', '')::numeric AS slab_to,
             COALESCE((e ->> 'pct')::numeric, 0) AS pct
        FROM jsonb_array_elements(v_tds_cfg -> 'slabs') e
    LOOP
      IF v_annual > v_slab.slab_from THEN
        v_tax := v_tax
          + (LEAST(v_annual, COALESCE(v_slab.slab_to, v_annual)) - v_slab.slab_from)
            * v_slab.pct / 100.0;
      END IF;
    END LOOP;
    -- 87A rebate
    IF (v_tds_cfg ->> 'rebate_87a_threshold') IS NOT NULL
       AND v_annual <= (v_tds_cfg ->> 'rebate_87a_threshold')::numeric THEN
      v_tax := GREATEST(0, v_tax - COALESCE((v_tds_cfg ->> 'rebate_87a_amount')::numeric, v_tax));
    END IF;
    v_cess := v_tax * COALESCE((v_tds_cfg ->> 'cess_pct')::numeric, 4) / 100.0;

    -- catch-up: (annual liability − TDS already deducted this FY) / months left
    v_months_left := 12 - ((EXTRACT(YEAR FROM v_period.end_date)::int * 12
                            + EXTRACT(MONTH FROM v_period.end_date)::int)
                         - (CASE WHEN EXTRACT(MONTH FROM v_period.end_date) >= 4
                                 THEN EXTRACT(YEAR FROM v_period.end_date)::int
                                 ELSE EXTRACT(YEAR FROM v_period.end_date)::int - 1 END * 12 + 4));
    v_months_left := GREATEST(1, v_months_left);
    v_tds := GREATEST(0,
      (round((v_tax + v_cess - v_prior.ytd_tds_paise) / v_months_left / 100.0) * 100))::bigint;

    IF v_tds > 0 THEN
      SELECT c.* INTO v_c FROM public.salary_components c
       WHERE c.company_id = v_emp.company_id AND c.code = 'TDS' AND c.deleted_at IS NULL;
      IF FOUND THEN
        v_seq := v_seq + 10; v_tot_ded := v_tot_ded + v_tds;
        INSERT INTO public.payslip_lines
          (payslip_id, salary_component_id, label, line_kind, sequence,
           full_month_amount_paise, amount_paise, calc_kind, calc_basis)
        VALUES (v_payslip_id, v_c.id, v_c.name, 'deduction', v_seq, v_tds, v_tds, 'slab',
          jsonb_build_object('basis', 'tds_projection', 'regime', v_regime,
            'annual_taxable_paise', round(v_annual)::bigint,
            'annual_tax_paise', round(v_tax + v_cess)::bigint,
            'ytd_tds_paise', v_prior.ytd_tds_paise, 'months_left', v_months_left));
      END IF;
    END IF;
  END IF;

  -- ── Totals, exceptions, snapshot ─────────────────────────────────────────
  v_net := v_tot_earn + v_tot_reimb - v_tot_ded;

  IF v_net < 0 THEN v_holds := v_holds || 'negative net pay'; END IF;
  IF v_att.paid_days = 0 THEN v_holds := v_holds || 'zero paid days'; END IF;
  IF v_emp.payment_mode = 'bank_transfer' AND v_bank_account_id IS NULL THEN
    v_holds := v_holds || 'missing active bank account';
  END IF;

  v_snapshot := jsonb_build_object(
    'engine_version', v_run.engine_version,
    'employee_id', p_employee_id,
    'employee_code', v_emp.employee_code,
    'pay_period', jsonb_build_object('id', v_period.id, 'code', v_period.code,
      'start', v_period.start_date, 'end', v_period.end_date,
      'basis', v_period.month_days_basis, 'period_days', v_period_days),
    'attendance_days', v_days_json,
    'attendance_summary', jsonb_build_object('paid_days', v_att.paid_days,
      'lop_days', v_att.lop_days, 'ot_minutes', v_att.ot_minutes,
      'extra_minutes', v_att.extra_minutes, 'night_days', v_att.night_days),
    'salary_revision', jsonb_build_object('id', v_rev.id,
      'revision_number', v_rev.revision_number,
      'monthly_gross_paise', v_rev.monthly_gross_paise,
      'monthly_ctc_paise', v_rev.monthly_ctc_paise,
      'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'component_id', rl.salary_component_id,
                 'monthly_amount_paise', rl.monthly_amount_paise) ORDER BY rl.sequence)
                 FROM public.employee_salary_revision_lines rl
                 WHERE rl.revision_id = v_rev.id), '[]'::jsonb)),
    'statutory_settings_id', v_stat.id,
    'statutory', jsonb_build_object('pf_employee_pct', v_stat.pf_employee_pct,
      'pf_wage_ceiling_paise', v_stat.pf_wage_ceiling_paise,
      'esi_employee_pct', v_stat.esi_employee_pct,
      'esi_wage_ceiling_paise', v_stat.esi_wage_ceiling_paise,
      'pt_slabs', v_stat.pt_slabs, 'ot_multiplier', v_stat.overtime_multiplier_statutory));

  INSERT INTO public.payroll_inputs_snapshot
    (payroll_run_id, employee_id, payslip_id, snapshot, snapshot_hash,
     attendance_days_included, salary_revision_id, statutory_settings_id, engine_version)
  VALUES
    (p_payroll_run_id, p_employee_id, v_payslip_id, v_snapshot,
     util.sha256_hex(v_snapshot::text), v_att.day_ids, v_rev.id, v_stat.id,
     v_run.engine_version)
  RETURNING id INTO v_snapshot_id;

  UPDATE public.payslips SET
    pay_period_id        = v_period.id,
    period_start         = v_period.start_date,
    period_end           = v_period.end_date,
    pay_date             = v_period.pay_date,
    period_days          = v_period_days,
    paid_days            = v_att.paid_days,
    lop_days             = v_att.lop_days,
    present_days         = v_att.present_days,
    weekly_off_days      = v_att.weekly_off_days,
    holiday_days         = v_att.holiday_days,
    leave_days_paid      = v_att.leave_days_paid,
    leave_days_unpaid    = v_att.leave_days_unpaid,
    overtime_minutes     = v_att.ot_minutes,
    extra_work_minutes   = v_att.extra_minutes,
    late_deduction_days  = v_att.late_ded_days,
    gross_earnings_paise = v_tot_earn,
    total_deductions_paise = v_tot_ded,
    net_pay_paise        = v_net,
    employer_contributions_paise = v_tot_er,
    total_ctc_for_period_paise   = v_tot_earn + v_tot_er,
    ytd_gross_paise      = v_prior.ytd_gross_paise + v_tot_earn,
    ytd_deductions_paise = v_prior.ytd_deductions_paise + v_tot_ded,
    ytd_net_paise        = v_prior.ytd_net_paise + v_net,
    ytd_tds_paise        = v_prior.ytd_tds_paise + v_tds,
    bank_account_id      = v_bank_account_id,
    payment_mode         = v_emp.payment_mode,
    computed_snapshot_id = v_snapshot_id
  WHERE id = v_payslip_id;

  INSERT INTO public.payroll_run_employees AS pre
         (payroll_run_id, employee_id, status, hold_reason, computed_at, payslip_id)
  VALUES (p_payroll_run_id, p_employee_id,
          CASE WHEN array_length(v_holds, 1) IS NOT NULL THEN 'held' ELSE 'computed' END,
          NULLIF(array_to_string(v_holds, '; '), ''), now(), v_payslip_id)
  ON CONFLICT (payroll_run_id, employee_id) DO UPDATE
    SET status = EXCLUDED.status,
        hold_reason = EXCLUDED.hold_reason,
        exclusion_reason = NULL,
        error_detail = NULL,
        computed_at = EXCLUDED.computed_at,
        payslip_id = EXCLUDED.payslip_id;

  RETURN v_payslip_id;
END;
$$;

COMMENT ON FUNCTION public.compute_payslip(uuid, uuid) IS
  'Computes/recomputes one payslip inside a pre-approval payroll run: earnings from the pinned salary revision + structure, OT/night allowance from attendance_days, PF/ESI/PT-Karnataka/LWF/TDS from the run''s pinned statutory_settings, minimum-wage guard, immutable payroll_inputs_snapshot, exception holds.';

-- ----------------------------------------------------------------------------
-- 2. compute_payroll_run(p_payroll_run_id) -> jsonb summary
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_payroll_run(p_payroll_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_run      public.payroll_runs%ROWTYPE;
  v_period   public.pay_periods%ROWTYPE;
  v_emp_id   uuid;
  v_computed integer := 0;
  v_errors   integer := 0;
  v_prev_net bigint;
  v_totals   record;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT app.is_admin() THEN
    RAISE EXCEPTION 'compute_payroll_run: admin or service role required'
      USING errcode = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_payroll_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_payroll_run: payroll run % not found', p_payroll_run_id;
  END IF;
  IF v_run.status NOT IN ('draft','inputs_locked','computed','in_review','failed') THEN
    RAISE EXCEPTION 'compute_payroll_run: run % is % — compute is only allowed before approval',
      v_run.run_number, v_run.status USING errcode = '0A000';
  END IF;
  SELECT * INTO v_period FROM public.pay_periods WHERE id = v_run.pay_period_id;

  FOR v_emp_id IN
    SELECT e.id
      FROM public.employees e
     WHERE e.company_id = v_run.company_id
       AND e.deleted_at IS NULL
       AND NOT e.exclude_from_payroll
       AND e.employment_status <> 'pre_joining'
       AND e.date_of_join IS NOT NULL
       AND e.date_of_join <= v_period.end_date
       AND (e.last_working_day IS NULL OR e.last_working_day >= v_period.start_date)
       AND (v_run.employee_filter IS NULL
            OR ((NOT v_run.employee_filter ? 'employee_ids'
                 OR e.id::text IN (SELECT jsonb_array_elements_text(v_run.employee_filter -> 'employee_ids')))
            AND (NOT v_run.employee_filter ? 'department_ids'
                 OR e.department_id::text IN (SELECT jsonb_array_elements_text(v_run.employee_filter -> 'department_ids')))))
     ORDER BY e.employee_code
  LOOP
    BEGIN
      PERFORM public.compute_payslip(v_emp_id, p_payroll_run_id);
      v_computed := v_computed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      INSERT INTO public.payroll_run_employees AS pre
             (payroll_run_id, employee_id, status, error_detail, retry_count)
      VALUES (p_payroll_run_id, v_emp_id, 'error', SQLERRM, 1)
      ON CONFLICT (payroll_run_id, employee_id) DO UPDATE
        SET status = 'error',
            error_detail = EXCLUDED.error_detail,
            retry_count = pre.retry_count + 1,
            payslip_id = NULL, computed_at = NULL, hold_reason = NULL;
    END;
  END LOOP;

  SELECT COALESCE(SUM(p.gross_earnings_paise), 0)         AS gross,
         COALESCE(SUM(p.total_deductions_paise), 0)       AS ded,
         COALESCE(SUM(p.net_pay_paise), 0)                AS net,
         COALESCE(SUM(p.gross_earnings_paise + p.employer_contributions_paise), 0) AS er_cost,
         COUNT(*)                                         AS n
    INTO v_totals
    FROM public.payslips p
    JOIN public.payroll_run_employees pre
      ON pre.payroll_run_id = p.payroll_run_id AND pre.payslip_id = p.id
   WHERE p.payroll_run_id = p_payroll_run_id
     AND pre.status IN ('computed','held');

  -- Variance vs the previous released regular run of this company.
  SELECT r.total_net_paise INTO v_prev_net
    FROM public.payroll_runs r
    JOIN public.pay_periods pp ON pp.id = r.pay_period_id
   WHERE r.company_id = v_run.company_id
     AND r.id <> v_run.id
     AND r.run_kind = 'regular'
     AND r.status IN ('approved','disbursement_pending','paid','closed')
     AND pp.start_date < v_period.start_date
   ORDER BY pp.start_date DESC
   LIMIT 1;

  UPDATE public.payroll_runs SET
    status = 'computed',
    computed_at = now(),
    computed_by = COALESCE(app.ctx_actor_id(), computed_by),
    employee_count = v_totals.n,
    total_gross_paise = v_totals.gross,
    total_deductions_paise = v_totals.ded,
    total_net_paise = v_totals.net,
    total_employer_cost_paise = v_totals.er_cost,
    variance_vs_previous_pct = CASE WHEN v_prev_net IS NULL OR v_prev_net = 0 THEN NULL
      ELSE round((v_totals.net - v_prev_net) * 100.0 / v_prev_net, 4) END,
    exception_count = (SELECT COUNT(*) FROM public.payroll_run_employees pre
                        WHERE pre.payroll_run_id = p_payroll_run_id
                          AND pre.status IN ('error','held'))
  WHERE id = p_payroll_run_id;

  RETURN jsonb_build_object(
    'payroll_run_id', p_payroll_run_id,
    'run_number', v_run.run_number,
    'computed', v_computed,
    'errors', v_errors,
    'held', (SELECT COUNT(*) FROM public.payroll_run_employees pre
              WHERE pre.payroll_run_id = p_payroll_run_id AND pre.status = 'held'),
    'excluded', (SELECT COUNT(*) FROM public.payroll_run_employees pre
                  WHERE pre.payroll_run_id = p_payroll_run_id AND pre.status = 'excluded'),
    'total_net_paise', v_totals.net);
END;
$$;

COMMENT ON FUNCTION public.compute_payroll_run(uuid) IS
  'Computes payslips for every eligible employee of the run (employee_filter honoured), records per-employee errors/holds, then stamps run totals, variance vs the previous released regular run, exception_count and status=computed.';

-- ----------------------------------------------------------------------------
-- 3. finalise_payroll_run(p_payroll_run_id)
--    approved(+) -> closed: stamps consumed attendance_days, escalates the
--    attendance lock soft -> hard, finalises the pay period. Irreversible.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalise_payroll_run(p_payroll_run_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_run    public.payroll_runs%ROWTYPE;
  v_period public.pay_periods%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT app.is_admin() THEN
    RAISE EXCEPTION 'finalise_payroll_run: admin or service role required'
      USING errcode = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_payroll_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalise_payroll_run: payroll run % not found', p_payroll_run_id;
  END IF;
  IF v_run.status NOT IN ('approved','disbursement_pending','paid') THEN
    RAISE EXCEPTION 'finalise_payroll_run: run % is % — only an approved/paid run can be closed',
      v_run.run_number, v_run.status USING errcode = '23514';
  END IF;
  SELECT * INTO v_period FROM public.pay_periods WHERE id = v_run.pay_period_id;

  -- Mark the consumed attendance days: locked + pinned to this run.
  -- (attendance_days ships in migration 017; the lock-guard bypass flag is the
  --  documented app.allow_locked_recompute contract from §8.11.)
  IF to_regclass('public.attendance_days') IS NOT NULL THEN
    PERFORM set_config('app.allow_locked_recompute', 'on', true);
    UPDATE public.attendance_days ad
       SET payroll_run_id = v_run.id,
           is_locked = true
     WHERE ad.ist_date BETWEEN v_period.start_date AND v_period.end_date
       AND ad.employee_id IN (SELECT p.employee_id FROM public.payslips p
                               WHERE p.payroll_run_id = v_run.id)
       AND (ad.payroll_run_id IS NULL OR ad.payroll_run_id = v_run.id);
    PERFORM set_config('app.allow_locked_recompute', '', true);
  END IF;

  -- Escalate the run's attendance lock (and any pay-period lock) soft -> hard.
  IF to_regclass('public.attendance_locks') IS NOT NULL THEN
    UPDATE public.attendance_locks al
       SET lock_kind = 'hard'
     WHERE al.unlocked_at IS NULL
       AND (al.id = v_run.attendance_lock_id OR al.pay_period_id = v_run.pay_period_id);
  END IF;

  UPDATE public.pay_periods
     SET payroll_finalised_at = COALESCE(payroll_finalised_at, now()),
         is_open = false
   WHERE id = v_run.pay_period_id;

  UPDATE public.payroll_runs
     SET status = 'closed',
         closed_at = now()
   WHERE id = p_payroll_run_id;
END;
$$;

COMMENT ON FUNCTION public.finalise_payroll_run(uuid) IS
  'Closes an approved/paid payroll run: pins + locks the consumed attendance_days, escalates attendance locks soft->hard, finalises the pay period, sets status=closed. After closure the run is immutable; corrections require an arrears run.';

-- ----------------------------------------------------------------------------
-- 4. reverse_payslip(p_payslip_id, p_payroll_run_id, p_reason) -> new payslip id
--    Corrections are reversal + reissue, never edits: emits a fully negated
--    payslip into a pre-approval correction/arrears run and marks the original
--    reversed. Reissue happens as a separate computed payslip in that run for
--    a DIFFERENT period or a second correction run (uq run+employee).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_payslip(p_payslip_id uuid, p_payroll_run_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orig    public.payslips%ROWTYPE;
  v_target  public.payroll_runs%ROWTYPE;
  v_new_id  uuid;
  v_number  text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT app.is_admin() THEN
    RAISE EXCEPTION 'reverse_payslip: admin or service role required'
      USING errcode = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'reverse_payslip: a reason of at least 10 characters is required'
      USING errcode = '23514';
  END IF;

  SELECT * INTO v_orig FROM public.payslips WHERE id = p_payslip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reverse_payslip: payslip % not found', p_payslip_id;
  END IF;
  IF v_orig.is_reversed THEN
    RAISE EXCEPTION 'reverse_payslip: payslip % is already reversed', v_orig.payslip_number;
  END IF;
  IF NOT public.payroll_run_is_released(v_orig.payroll_run_id) THEN
    RAISE EXCEPTION 'reverse_payslip: payslip % belongs to an unreleased run — recompute it instead',
      v_orig.payslip_number USING errcode = '23514';
  END IF;

  SELECT * INTO v_target FROM public.payroll_runs WHERE id = p_payroll_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reverse_payslip: target payroll run % not found', p_payroll_run_id;
  END IF;
  IF v_target.run_kind NOT IN ('correction','arrears','off_cycle','full_and_final') THEN
    RAISE EXCEPTION 'reverse_payslip: target run % must be a correction/arrears/off-cycle run',
      v_target.run_number USING errcode = '23514';
  END IF;
  IF v_target.status NOT IN ('draft','inputs_locked','computed','in_review') THEN
    RAISE EXCEPTION 'reverse_payslip: target run % is % — it must be pre-approval',
      v_target.run_number, v_target.status USING errcode = '23514';
  END IF;

  v_number := v_orig.payslip_number || '-REV';
  IF EXISTS (SELECT 1 FROM public.payslips WHERE payslip_number = v_number) THEN
    v_number := v_number || '-' || v_target.run_number;
  END IF;

  INSERT INTO public.payslips
    (payroll_run_id, employee_id, pay_period_id, payslip_number,
     period_start, period_end, pay_date, period_days,
     paid_days, lop_days, present_days, weekly_off_days, holiday_days,
     leave_days_paid, leave_days_unpaid, overtime_minutes, extra_work_minutes,
     late_deduction_days,
     gross_earnings_paise, total_deductions_paise, net_pay_paise,
     employer_contributions_paise, total_ctc_for_period_paise,
     ytd_gross_paise, ytd_deductions_paise, ytd_net_paise, ytd_tds_paise,
     bank_account_id, payment_mode, payment_status)
  VALUES
    (p_payroll_run_id, v_orig.employee_id, v_orig.pay_period_id, v_number,
     v_orig.period_start, v_orig.period_end, v_orig.pay_date, v_orig.period_days,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     -v_orig.gross_earnings_paise, -v_orig.total_deductions_paise, -v_orig.net_pay_paise,
     -v_orig.employer_contributions_paise, -v_orig.total_ctc_for_period_paise,
     GREATEST(0, v_orig.ytd_gross_paise - v_orig.gross_earnings_paise),
     GREATEST(0, v_orig.ytd_deductions_paise - v_orig.total_deductions_paise),
     GREATEST(0, v_orig.ytd_net_paise - v_orig.net_pay_paise),
     v_orig.ytd_tds_paise,
     v_orig.bank_account_id, v_orig.payment_mode, 'pending')
  RETURNING id INTO v_new_id;

  INSERT INTO public.payslip_lines
    (payslip_id, salary_component_id, label, line_kind, sequence,
     full_month_amount_paise, amount_paise, calc_kind, calc_basis,
     is_prorated, is_arrear, arrear_for_period_id)
  SELECT v_new_id, pl.salary_component_id, pl.label, pl.line_kind, pl.sequence,
         -pl.full_month_amount_paise, -pl.amount_paise, pl.calc_kind,
         pl.calc_basis || jsonb_build_object(
           'reason', p_reason, 'reversal_of_payslip_id', p_payslip_id,
           'reversal_of_line_id', pl.id),
         pl.is_prorated, true, v_orig.pay_period_id
    FROM public.payslip_lines pl
   WHERE pl.payslip_id = p_payslip_id;

  UPDATE public.payslips
     SET is_reversed = true,
         reversed_by_payslip_id = v_new_id
   WHERE id = p_payslip_id;

  INSERT INTO public.payroll_run_employees AS pre
         (payroll_run_id, employee_id, status, computed_at, payslip_id)
  VALUES (p_payroll_run_id, v_orig.employee_id, 'computed', now(), v_new_id)
  ON CONFLICT (payroll_run_id, employee_id) DO UPDATE
    SET status = 'computed', computed_at = now(), payslip_id = v_new_id,
        error_detail = NULL, hold_reason = NULL, exclusion_reason = NULL;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.reverse_payslip(uuid, uuid, text) IS
  'Reversal + reissue, never edits: writes a fully negated copy of a released payslip into a pre-approval correction/arrears run, links reversed_by_payslip_id and marks the original is_reversed. Requires a reason (>= 10 chars).';

-- ----------------------------------------------------------------------------
-- 5. Grants — execution is admin/service-gated inside each function.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.compute_payslip(uuid, uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_payroll_run(uuid)            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalise_payroll_run(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_payslip(uuid, uuid, text)    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_payslip(uuid, uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_payroll_run(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalise_payroll_run(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_payslip(uuid, uuid, text) TO authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.compute_payslip(uuid, uuid)       TO service_role;
    GRANT EXECUTE ON FUNCTION public.compute_payroll_run(uuid)         TO service_role;
    GRANT EXECUTE ON FUNCTION public.finalise_payroll_run(uuid)        TO service_role;
    GRANT EXECUTE ON FUNCTION public.reverse_payslip(uuid, uuid, text) TO service_role;
  END IF;
END $$;

COMMIT;
