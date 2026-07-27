-- =============================================================================
-- Migration 044 — seed: salary components, salary structures,
-- statutory_settings effective 01-Apr-2026.
-- Source: docs/plan/04-data-model.md §14.8 + §3.8 catalogue;
--         spec-migrations §6.11.
--
-- Notes:
--  * Money is integer paise (fixed_amount_paise / slab_config amounts).
--  * §14.8 says "25 rows"; the §3.8 catalogue enumerates 26 component codes —
--    all 26 are seeded (BASIC … GRATUITY_PROV).
--  * Statutory components (OT, NIGHT_ALLOW, PF/ESI/PT/LWF/TDS, employer
--    contributions, GRATUITY_PROV) are computed by compute_payslip() from the
--    pinned statutory_settings row; their calc_kind/formula here is
--    descriptive metadata, excluded from the generic evaluation loop (023).
--  * The engine's OT rate divides by (26 × 8 × 60); the venue has no DA
--    component, so the documented formula uses basic alone.
--  * shifts.night_allowance_component_id (SEC-N, EVT) is wired here because
--    NIGHT_ALLOW does not exist before this file (deferred FK already added
--    by 20260801004900_deferred_fks.sql when it runs last).
-- =============================================================================

BEGIN;

-- Reason/source context for audit.log_changes(): tables in
-- audit.reason_required_tables demand a reason on UPDATE, and every audit row
-- this seed writes should say where it came from.
SELECT set_config('app.reason', 'seed 044: salary components, structures and statutory settings', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Salary components (§3.8 catalogue, §14.8 values)
-- -----------------------------------------------------------------------------
INSERT INTO public.salary_components
  (company_id, code, name, description, sort_order, line_kind, calc_kind,
   percentage, fixed_amount_paise, formula, slab_config,
   is_taxable, is_pf_wage, is_esi_wage, is_pt_wage, is_lwf_wage,
   is_gratuity_wage, prorate_on_paid_days, affects_gross, affects_net,
   affects_ctc, ctc_bucket, statutory_reference, is_system_managed)
SELECT c.id, v.code, v.name, v.descr, v.ord,
       v.line_kind::public.payslip_line_kind, v.calc_kind,
       v.pct, v.fixed_paise, v.formula, v.slab,
       v.taxable, v.pf_wage, v.esi_wage, v.pt_wage, v.lwf_wage,
       v.grat_wage, v.prorate, v.a_gross, v.a_net,
       v.a_ctc, v.bucket, v.statute, v.system
FROM public.companies c,
     (VALUES
        -- ============ Earnings — bucket A (gross) ============
        ('BASIC',      'Basic',
         '50% of monthly gross. PF and gratuity wage base.',
         10, 'earning', 'pct_of_gross', 50::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  'A',
         'EPF Act 1952 s.2(b); Payment of Gratuity Act 1972', false),
        -- HRA is inserted separately below: calc_kind='pct_of_component'
        -- requires base_component_id, and ck_salary_components__base_required
        -- is a CHECK (so it cannot be deferred to a later UPDATE) — BASIC must
        -- already exist to be referenced.
        ('CONV',       'Conveyance Allowance',
         'Fixed ₹1,600 per month.',
         30, 'earning', 'fixed', NULL::numeric, 160000::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, true,  true,  true,  true,  'A',
         NULL, false),
        ('FOOD',       'Food Allowance',
         'Fixed ₹1,250 per month. Staff meals are provided; the component exists for CTC transparency.',
         40, 'earning', 'fixed', NULL::numeric, 125000::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, true,  true,  true,  true,  'A',
         NULL, false),
        ('UNIFORM',    'Uniform Allowance',
         'Fixed ₹500 per month for operational departments.',
         50, 'earning', 'fixed', NULL::numeric, 50000::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, true,  true,  true,  true,  'A',
         NULL, false),
        ('LTA',        'Leave Travel Allowance',
         'Amount defined per salary revision line.',
         60, 'earning', 'fixed', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, false, true,  true,  true,  'A',
         'Income-tax Act 1961 s.10(5)', false),
        ('CHILD_EDU',  'Children Education Allowance',
         'Fixed ₹200 per month.',
         70, 'earning', 'fixed', NULL::numeric, 20000::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, true,  true,  true,  true,  'A',
         'Income-tax Act 1961 s.10(14)', false),
        ('SPL',        'Special Allowance',
         'Balancing component — bucket A, evaluated last.',
         90, 'earning', 'balance', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, true,  true,  true,  true,  'A',
         NULL, false),
        -- ============ Earnings — bucket B (variable / attendance-driven) ============
        ('NIGHT_ALLOW','Night Shift Allowance',
         '₹150 per night-shift day (unit = night-shift days from attendance_days).',
         100, 'earning', 'per_unit', NULL::numeric, 15000::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, false, true,  true,  true,  'B',
         NULL, true),
        ('SERVICE_CHG','Service Charge Share',
         'Distribution of pooled service charge, entered per run.',
         110, 'earning', 'fixed', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, false, true,  true,  true,  'B',
         NULL, false),
        ('OT',         'Overtime',
         'Per-minute at 2.0 × basic / (26 × 8 × 60); the venue has no DA component. Approved OT minutes only.',
         120, 'earning', 'per_minute', NULL::numeric, NULL::bigint,
         '2.0 * basic / (26 * 8 * 60)', NULL::jsonb,
         true,  false, true,  true,  false, false, false, true,  true,  true,  'B',
         'Karnataka Shops & Commercial Establishments Act 1961 — double rate', true),
        ('ATT_BONUS',  'Attendance Bonus',
         'Discretionary full-attendance bonus, entered per run.',
         130, 'earning', 'fixed', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         true,  false, true,  true,  false, false, false, true,  true,  true,  'B',
         NULL, false),
        -- ============ Employee deductions ============
        ('PF_EE',      'Provident Fund (Employee)',
         '12% of PF wage, wage capped at ₹15,000/month.',
         200, 'deduction', 'formula', NULL::numeric, NULL::bigint,
         '0.12 * least(basic, 15000)', NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         'EPF Act 1952 s.6', true),
        ('ESI_EE',     'ESI (Employee)',
         '0.75% of ESI wage when monthly gross ≤ ₹21,000.',
         210, 'deduction', 'formula', NULL::numeric, NULL::bigint,
         '0.0075 * gross', NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         'ESI Act 1948 s.39', true),
        ('PT',         'Professional Tax',
         'Karnataka slab: ₹200/month at gross ≥ ₹25,000.',
         220, 'deduction', 'slab', NULL::numeric, NULL::bigint, NULL::text,
         '[{"from": 0, "to": 2499999, "amount": 0},
           {"from": 2500000, "to": null, "amount": 20000}]'::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         'Karnataka Tax on Professions, Trades, Callings and Employments Act 1976', true),
        ('LWF_EE',     'Labour Welfare Fund (Employee)',
         '₹20, deducted with the December payroll.',
         230, 'deduction', 'fixed', NULL::numeric, 2000::bigint, NULL::text, NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         'Karnataka Labour Welfare Fund Act 1965', true),
        ('TDS',        'Income Tax (TDS)',
         'Per the regime slabs pinned in statutory_settings.tds_config.',
         240, 'deduction', 'slab', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         'Income-tax Act 1961 s.192', true),
        ('LATE_DED',   'Late Arrival Deduction',
         'Leave-day deduction beyond the monthly late threshold (attendance engine).',
         250, 'deduction', 'attendance_prorated', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         NULL, true),
        -- ============ Recoveries ============
        ('ADVANCE',    'Salary Advance Recovery',
         'Recovery of salary advances, entered per run.',
         260, 'recovery', 'fixed', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         NULL, false),
        ('LOAN',       'Loan Recovery',
         'Recovery of staff loans, entered per run.',
         270, 'recovery', 'fixed', NULL::numeric, NULL::bigint, NULL::text, NULL::jsonb,
         false, false, false, false, false, false, false, false, true,  false, 'A',
         NULL, false),
        -- ============ Employer contributions — bucket C ============
        ('PF_ER',      'Provident Fund (Employer)',
         '12% of PF wage (3.67% EPF after the 8.33% EPS split), wage capped at ₹15,000.',
         300, 'employer_contribution', 'formula', NULL::numeric, NULL::bigint,
         '0.12 * least(basic, 15000)', NULL::jsonb,
         false, false, false, false, false, false, false, false, false, true,  'C',
         'EPF Act 1952 s.6', true),
        ('EPS_ER',     'Pension Scheme (Employer)',
         '8.33% of PF wage, wage capped at ₹15,000.',
         310, 'employer_contribution', 'formula', NULL::numeric, NULL::bigint,
         '0.0833 * least(basic, 15000)', NULL::jsonb,
         false, false, false, false, false, false, false, false, false, true,  'C',
         'Employees'' Pension Scheme 1995', true),
        ('EDLI_ER',    'EDLI (Employer)',
         '0.5% of PF wage, wage capped at ₹15,000.',
         320, 'employer_contribution', 'formula', NULL::numeric, NULL::bigint,
         '0.005 * least(basic, 15000)', NULL::jsonb,
         false, false, false, false, false, false, false, false, false, true,  'C',
         'EDLI Scheme 1976', true),
        ('ESI_ER',     'ESI (Employer)',
         '3.25% of ESI wage when monthly gross ≤ ₹21,000.',
         330, 'employer_contribution', 'formula', NULL::numeric, NULL::bigint,
         '0.0325 * gross', NULL::jsonb,
         false, false, false, false, false, false, false, false, false, true,  'C',
         'ESI Act 1948 s.39', true),
        ('LWF_ER',     'Labour Welfare Fund (Employer)',
         '₹40, contributed with the December payroll.',
         340, 'employer_contribution', 'fixed', NULL::numeric, 4000::bigint, NULL::text, NULL::jsonb,
         false, false, false, false, false, false, false, false, false, true,  'C',
         'Karnataka Labour Welfare Fund Act 1965', true),
        ('GRATUITY_PROV', 'Gratuity Provision',
         'Monthly provision: 15/26 × basic / 12. Informational, bucket C.',
         350, 'informational', 'formula', NULL::numeric, NULL::bigint,
         '(15.0 / 26.0) * basic / 12', NULL::jsonb,
         false, false, false, false, false, true,  false, false, false, true,  'C',
         'Payment of Gratuity Act 1972 s.4', true)
     ) AS v(code, name, descr, ord, line_kind, calc_kind, pct, fixed_paise,
            formula, slab, taxable, pf_wage, esi_wage, pt_wage, lwf_wage,
            grat_wage, prorate, a_gross, a_net, a_ctc, bucket, statute, system)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- HRA = 40% of BASIC. Inserted after the bulk pass so base_component_id can
-- point at the BASIC row that pass just created (the CHECK demands it at
-- INSERT time).
INSERT INTO public.salary_components
  (company_id, code, name, description, sort_order, line_kind, calc_kind,
   percentage, base_component_id,
   is_taxable, is_pf_wage, is_esi_wage, is_pt_wage, is_lwf_wage,
   is_gratuity_wage, prorate_on_paid_days, affects_gross, affects_net,
   affects_ctc, ctc_bucket, statutory_reference, is_system_managed)
SELECT c.id, 'HRA', 'House Rent Allowance', '40% of BASIC.', 20,
       'earning'::public.payslip_line_kind, 'pct_of_component',
       40::numeric, b.id,
       true, false, true, true, false, false, true, true, true, true, 'A',
       'Income-tax Act 1961 s.10(13A)', false
FROM public.companies c
JOIN public.salary_components b
  ON b.company_id = c.id AND b.code = 'BASIC' AND b.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- Night shifts pay NIGHT_ALLOW (§14.7 AP-SECURITY / §3.6 shifts).
UPDATE public.shifts s
SET night_allowance_component_id = sc.id
FROM public.salary_components sc
WHERE sc.company_id = s.company_id AND sc.code = 'NIGHT_ALLOW' AND sc.deleted_at IS NULL
  AND s.night_shift AND s.deleted_at IS NULL
  AND s.night_allowance_component_id IS DISTINCT FROM sc.id;

-- -----------------------------------------------------------------------------
-- 2. Salary structures (§14.8): SS-OPS-2026 (wage-based, G1–G3) and
--    SS-STAFF-2026 (CTC-based, G4–G7). Balance component SPL evaluates last.
-- -----------------------------------------------------------------------------
INSERT INTO public.salary_structures
  (company_id, code, name, description, sort_order, structure_kind,
   applies_to_grade_ids, effective_from, version)
SELECT c.id, v.code, v.name, v.descr, v.ord, v.kind,
       (SELECT array_agg(g.id ORDER BY g.level)
          FROM public.grades g
         WHERE g.company_id = c.id AND g.code = ANY (v.grades) AND g.deleted_at IS NULL),
       DATE '2026-04-01', 1
FROM public.companies c,
     (VALUES
        ('SS-OPS-2026',   'Operations Wage Structure 2026',
         'Wage-based structure for grades G1–G3: BASIC 50%, HRA 40% of basic, CONV, FOOD, UNIFORM, SPL balance.',
         10, 'wage_based', ARRAY['G1','G2','G3']),
        ('SS-STAFF-2026', 'Staff CTC Structure 2026',
         'CTC-based structure for grades G4–G7: BASIC, HRA, CONV, LTA, CHILD_EDU, SPL balance, employer PF.',
         20, 'ctc_based',  ARRAY['G4','G5','G6','G7'])
     ) AS v(code, name, descr, ord, kind, grades)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code, version) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.salary_structure_components
  (salary_structure_id, salary_component_id, sequence, is_mandatory)
SELECT ss.id, sc.id, v.seq, v.mandatory
FROM public.companies c
JOIN (VALUES
        ('SS-OPS-2026',   'BASIC',     10, true),
        ('SS-OPS-2026',   'HRA',       20, true),
        ('SS-OPS-2026',   'CONV',      30, true),
        ('SS-OPS-2026',   'FOOD',      40, true),
        ('SS-OPS-2026',   'UNIFORM',   50, true),
        ('SS-OPS-2026',   'SPL',       90, true),   -- balance: evaluated last
        ('SS-STAFF-2026', 'BASIC',     10, true),
        ('SS-STAFF-2026', 'HRA',       20, true),
        ('SS-STAFF-2026', 'CONV',      30, true),
        ('SS-STAFF-2026', 'LTA',       40, false),
        ('SS-STAFF-2026', 'CHILD_EDU', 50, false),
        ('SS-STAFF-2026', 'SPL',       90, true),   -- balance: evaluated last
        ('SS-STAFF-2026', 'PF_ER',    100, true)    -- employer PF inside CTC
     ) AS v(ss_code, sc_code, seq, mandatory) ON true
JOIN public.salary_structures ss
  ON ss.company_id = c.id AND ss.code = v.ss_code AND ss.version = 1 AND ss.deleted_at IS NULL
JOIN public.salary_components sc
  ON sc.company_id = c.id AND sc.code = v.sc_code AND sc.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (salary_structure_id, salary_component_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. statutory_settings — one row effective 2026-04-01 (§14.8, Appendix B11).
--    Money in integer paise. Rates must be verified against current
--    notifications by the payroll consultant before the first live run;
--    a correction is a NEW effective-dated row, never a rewrite.
-- -----------------------------------------------------------------------------
INSERT INTO public.statutory_settings
  (company_id, effective_from,
   pf_employee_pct, pf_employer_pct, pf_wage_ceiling_paise, pf_admin_charges_pct,
   eps_pct, edli_pct,
   esi_employee_pct, esi_employer_pct, esi_wage_ceiling_paise,
   pt_state, pt_slabs,
   lwf_employee_amount_paise, lwf_employer_amount_paise, lwf_frequency,
   gratuity_days_per_year, gratuity_divisor, gratuity_eligibility_years,
   bonus_min_pct, bonus_max_pct, bonus_wage_ceiling_paise, bonus_calculation_ceiling_paise,
   minimum_wage_config, tds_config,
   overtime_multiplier_statutory, max_weekly_hours, max_daily_hours,
   max_overtime_hours_per_quarter, notes)
SELECT
  c.id, DATE '2026-04-01',
  12.0, 12.0, 1500000, 0.5,
  8.33, 0.5,
  0.75, 3.25, 2100000,
  'Karnataka',
  '[{"from": 0, "to": 2499999, "amount": 0},
    {"from": 2500000, "to": null, "amount": 20000}]'::jsonb,
  2000, 4000, 'annual_december',
  15.0, 26.0, 5.0,
  8.33, 20.0, 2100000, 700000,
  jsonb_build_object(
    'default',        1500000,
    'unskilled',      1500000,
    'semi_skilled',   1650000,
    'skilled',        1800000,
    'highly_skilled', 2000000,
    'G1', 1500000, 'G2', 1650000, 'G3', 1800000,
    'note', 'Karnataka minimum wages — hotels & restaurants, monthly paise. VERIFY against the current notification before the first live run (Appendix B11).'),
  jsonb_build_object(
    'financial_year', '2026-27',
    'new', jsonb_build_object(
      'standard_deduction', 7500000,
      'slabs', jsonb_build_array(
        jsonb_build_object('from', 0,         'to', 40000000,  'pct', 0),
        jsonb_build_object('from', 40000000,  'to', 80000000,  'pct', 5),
        jsonb_build_object('from', 80000000,  'to', 120000000, 'pct', 10),
        jsonb_build_object('from', 120000000, 'to', 160000000, 'pct', 15),
        jsonb_build_object('from', 160000000, 'to', 200000000, 'pct', 20),
        jsonb_build_object('from', 200000000, 'to', 240000000, 'pct', 25),
        jsonb_build_object('from', 240000000, 'to', NULL,      'pct', 30)),
      'rebate_87a_threshold', 120000000,
      'rebate_87a_amount',    6000000,
      'cess_pct', 4),
    'old', jsonb_build_object(
      'standard_deduction', 5000000,
      'slabs', jsonb_build_array(
        jsonb_build_object('from', 0,         'to', 25000000,  'pct', 0),
        jsonb_build_object('from', 25000000,  'to', 50000000,  'pct', 5),
        jsonb_build_object('from', 50000000,  'to', 100000000, 'pct', 20),
        jsonb_build_object('from', 100000000, 'to', NULL,      'pct', 30)),
      'rebate_87a_threshold', 50000000,
      'rebate_87a_amount',    1250000,
      'cess_pct', 4)),
  2.0, 48, 9,
  50,
  'Rates as of 01-Apr-2026. Verify PF/ESI/PT/LWF and minimum-wage figures with the payroll consultant before the first live run (Appendix B11).'
FROM public.companies c
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, effective_from) DO NOTHING;

COMMIT;
