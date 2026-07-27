-- =============================================================================
-- Migration 047 — OPTIONAL demo seed (regression fixtures).
-- Guarded by settings.seed_demo_data = true (seeded false in 046).
-- NEVER applied to production: with the flag false this file is a no-op.
-- Source: docs/plan/04-data-model.md §14 (spec-migrations §6.15):
--   12 sample employees, 1 published roster week, 30 days of synthetic
--   punches, 1 payroll run.
--
-- Implementation notes:
--  * Employee codes TT0001–TT0012 are assigned explicitly (deterministic and
--    safe under the per-row MAX+1 generator).
--  * Punches are source='import' (reason required, provided) over the 30 IST
--    days ending yesterday, so ck_ap__not_future always holds and the punches
--    land in partitions migration 016 has already created. Jitter is
--    deterministic (date/employee arithmetic), not random().
--  * The roster is the next IST week for Banquet; slots are published. The
--    roster header can only be status='published' when a profile exists to
--    stand as published_by (constraint); otherwise it stays 'draft' with
--    published slots and a NOTICE.
--  * The payroll run stays in 'draft' — computing it is an engine concern,
--    not a seed concern.
-- =============================================================================

BEGIN;

-- Reason/source context for audit.log_changes(): the demo writes to tables
-- that are in audit.reason_required_tables (employees, salary revisions).
SELECT set_config('app.reason', 'seed 047: optional demo fixtures (employees, roster, punches, payroll run)', true);
SELECT set_config('app.source', 'migration', true);

DO $demo$
DECLARE
  v_enabled     boolean;
  v_company     uuid;
  v_location    uuid;
  v_today       date;
  v_publisher   uuid;
  v_roster      uuid;
  v_week_start  date;
  v_period      uuid;
  v_period_code text;
  v_statutory   uuid;
  emp           record;
  v_d           date;
  v_shift       record;
  v_in_at       timestamptz;
  v_out_at      timestamptz;
  v_ord         integer;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Guard: settings.seed_demo_data must be true.
  -- ---------------------------------------------------------------------------
  IF to_regclass('public.settings') IS NULL THEN
    RAISE NOTICE 'demo seed skipped: public.settings does not exist';
    RETURN;
  END IF;

  SELECT (s.value #>> '{}')::boolean INTO v_enabled
  FROM public.settings s
  WHERE s.key = 'seed_demo_data'
  ORDER BY s.scope = 'company' DESC
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RAISE NOTICE 'demo seed skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  SELECT id INTO v_company
  FROM public.companies WHERE code = 'TT' AND deleted_at IS NULL;
  SELECT id INTO v_location
  FROM public.locations
  WHERE company_id = v_company AND code = 'TTT-VENUE' AND deleted_at IS NULL;

  IF v_company IS NULL OR v_location IS NULL THEN
    RAISE NOTICE 'demo seed skipped: reference seed (042) not present';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.employees
             WHERE company_id = v_company AND employee_code = 'TT0001'
               AND deleted_at IS NULL) THEN
    RAISE NOTICE 'demo seed skipped: demo employees already present';
    RETURN;
  END IF;

  v_today := util.ist_today();

  -- ---------------------------------------------------------------------------
  -- 1. Twelve sample employees across venue departments.
  -- ---------------------------------------------------------------------------
  INSERT INTO public.employees
    (company_id, location_id, employee_code, first_name, last_name,
     display_name, gender, mobile, date_of_birth,
     employment_type, employment_status, date_of_join, probation_months,
     department_id, section_id, designation_id, grade_id, cost_centre_id,
     shift_id, is_ot_eligible, is_shift_worker)
  SELECT
    v_company, v_location, v.code, v.first_name, v.last_name,
    v.first_name || ' ' || v.last_name, v.gender::public.gender, v.mobile,
    DATE '1990-01-01' + (v.ord * 173),
    'permanent', 'confirmed', v.doj, COALESCE(g.probation_months, 6),
    d.id, NULL, dg.id, g.id, d.cost_centre_id,
    s.id, v.ot, v.shift_worker
  FROM (VALUES
      ( 1, 'TT0001', 'Arjun',     'Nair',    'male',   '9880010001', DATE '2026-01-05', 'FO',    'OPS-MGR',    'G6', 'G',      false, false),
      ( 2, 'TT0002', 'Priya',     'Menon',   'female', '9880010002', DATE '2026-01-12', 'HR',    'HR-EXEC',    'G4', 'G',      true,  false),
      ( 3, 'TT0003', 'Ravi',      'Kumar',   'male',   '9880010003', DATE '2026-01-19', 'BANQ',  'BANQ-MGR',   'G6', 'BANQ-A', false, true),
      ( 4, 'TT0004', 'Suresh',    'Gowda',   'male',   '9880010004', DATE '2026-02-02', 'BANQ',  'STEWARD',    'G2', 'BANQ-A', true,  true),
      ( 5, 'TT0005', 'Lakshmi',   'Devi',    'female', '9880010005', DATE '2026-02-09', 'HK',    'HK-ATT',     'G1', 'HK-A',   true,  true),
      ( 6, 'TT0006', 'Manjunath', 'R',       'male',   '9880010006', DATE '2026-02-16', 'SEC',   'SEC-GUARD',  'G2', 'SEC-D',  true,  true),
      ( 7, 'TT0007', 'Venkatesh', 'Rao',     'male',   '9880010007', DATE '2026-02-23', 'SEC',   'SEC-GUARD',  'G2', 'SEC-N',  true,  true),
      ( 8, 'TT0008', 'Anita',     'Sharma',  'female', '9880010008', DATE '2026-03-02', 'FIN',   'ACCOUNTANT', 'G4', 'G',      true,  false),
      ( 9, 'TT0009', 'Deepak',    'Shetty',  'male',   '9880010009', DATE '2026-03-09', 'KITCH', 'CDP',        'G4', 'KIT-A',  true,  true),
      (10, 'TT0010', 'Rahul',     'Verma',   'male',   '9880010010', DATE '2026-03-16', 'KITCH', 'COMMIS-1',   'G3', 'KIT-A',  true,  true),
      (11, 'TT0011', 'Farhan',    'Khan',    'male',   '9880010011', DATE '2026-03-23', 'GARD',  'GARDENER',   'G1', 'HK-A',   true,  true),
      (12, 'TT0012', 'Meena',     'Kumari',  'female', '9880010012', DATE '2026-04-06', 'FO',    'FO-EXEC',    'G4', 'G',      true,  false)
    ) AS v(ord, code, first_name, last_name, gender, mobile, doj,
           dept_code, desig_code, grade_code, shift_code, ot, shift_worker)
  JOIN public.departments  d  ON d.company_id  = v_company AND d.code  = v.dept_code  AND d.deleted_at  IS NULL
  JOIN public.designations dg ON dg.company_id = v_company AND dg.code = v.desig_code AND dg.deleted_at IS NULL
  JOIN public.grades       g  ON g.company_id  = v_company AND g.code  = v.grade_code AND g.deleted_at  IS NULL
  JOIN public.shifts       s  ON s.company_id  = v_company AND s.code  = v.shift_code AND s.deleted_at  IS NULL;

  -- Reporting lines: Ops Manager leads; Banquet Manager and CDP lead their teams.
  UPDATE public.employees e
  SET reporting_manager_id = m.id
  FROM (VALUES
      ('TT0002', 'TT0001'), ('TT0003', 'TT0001'), ('TT0005', 'TT0001'),
      ('TT0006', 'TT0001'), ('TT0007', 'TT0001'), ('TT0008', 'TT0001'),
      ('TT0009', 'TT0001'), ('TT0011', 'TT0001'), ('TT0012', 'TT0001'),
      ('TT0004', 'TT0003'), ('TT0010', 'TT0009')
    ) AS v(emp_code, mgr_code)
  JOIN public.employees m
    ON m.company_id = v_company AND m.employee_code = v.mgr_code AND m.deleted_at IS NULL
  WHERE e.company_id = v_company AND e.employee_code = v.emp_code AND e.deleted_at IS NULL;

  -- A profile to stand as approver/publisher. Resolved HERE, before the first
  -- row that needs it: ck_esr__approved_fields requires approved_by AND
  -- approved_at whenever status = 'approved', so a revision cannot be seeded as
  -- approved until an approver exists. With no profile yet, the revisions are
  -- seeded as 'pending' instead of violating the constraint — the demo is still
  -- usable and the approval gate stays honest.
  SELECT id INTO v_publisher FROM public.profiles ORDER BY created_at LIMIT 1;

  -- Initial salary revisions (paise; all above minimum wage).
  INSERT INTO public.employee_salary_revisions
    (employee_id, revision_number, salary_structure_id, effective_from,
     revision_kind, monthly_gross_paise, monthly_employer_contribution_paise,
     ctc_at_join_paise, status, approved_by, approved_at, notes)
  SELECT e.id, 1, ss.id, e.date_of_join,
         'initial', v.gross_paise, 0,
         v.gross_paise,
         (CASE WHEN v_publisher IS NOT NULL THEN 'approved' ELSE 'pending' END)::public.approval_status,
         v_publisher,
         CASE WHEN v_publisher IS NOT NULL THEN now() END,
         'demo seed: initial salary'
  FROM (VALUES
      ('TT0001', 9000000), ('TT0002', 4500000), ('TT0003', 7500000),
      ('TT0004', 2200000), ('TT0005', 1800000), ('TT0006', 2400000),
      ('TT0007', 2400000), ('TT0008', 5000000), ('TT0009', 4200000),
      ('TT0010', 2800000), ('TT0011', 1800000), ('TT0012', 4000000)
    ) AS v(emp_code, gross_paise)
  JOIN public.employees e
    ON e.company_id = v_company AND e.employee_code = v.emp_code AND e.deleted_at IS NULL
  JOIN public.grades g ON g.id = e.grade_id
  JOIN public.salary_structures ss
    ON ss.company_id = v_company AND ss.deleted_at IS NULL AND ss.version = 1
   AND ss.code = CASE WHEN g.level <= 3 THEN 'SS-OPS-2026' ELSE 'SS-STAFF-2026' END;

  -- ---------------------------------------------------------------------------
  -- 2. Thirty days of synthetic punches (ending yesterday, IST).
  --    Ops staff sit out Tuesdays (mid-week off); office staff sit out Sundays.
  -- ---------------------------------------------------------------------------
  FOR emp IN
    SELECT e.id, e.employee_code, d.code AS dept_code,
           s.start_time, s.end_time, s.crosses_midnight,
           row_number() OVER (ORDER BY e.employee_code)::integer AS ord
    FROM public.employees e
    JOIN public.departments d ON d.id = e.department_id
    JOIN public.shifts s      ON s.id = e.shift_id
    WHERE e.company_id = v_company
      AND e.employee_code BETWEEN 'TT0001' AND 'TT0012'
      AND e.deleted_at IS NULL
  LOOP
    v_ord := emp.ord;
    FOR v_d IN SELECT generate_series(v_today - 30, v_today - 1, INTERVAL '1 day')::date
    LOOP
      -- weekly offs
      CONTINUE WHEN emp.dept_code IN ('BANQ','KITCH','HK','SEC','GARD','FO','TRAN')
               AND EXTRACT(DOW FROM v_d) = 2;   -- Tuesday
      CONTINUE WHEN emp.dept_code NOT IN ('BANQ','KITCH','HK','SEC','GARD','FO','TRAN')
               AND EXTRACT(DOW FROM v_d) = 0;   -- Sunday

      v_in_at  := ((v_d + emp.start_time)::timestamp AT TIME ZONE 'Asia/Kolkata')
                  + make_interval(mins => ((EXTRACT(DAY FROM v_d)::integer * 7 + v_ord) % 15) - 5);
      v_out_at := (((CASE WHEN emp.crosses_midnight THEN v_d + 1 ELSE v_d END)
                    + emp.end_time)::timestamp AT TIME ZONE 'Asia/Kolkata')
                  + make_interval(mins => ((EXTRACT(DAY FROM v_d)::integer * 11 + v_ord) % 20) - 5);

      -- A night shift's out-punch for "yesterday" lands this morning; skip the
      -- pair when it has not happened yet (ck_ap__not_future).
      CONTINUE WHEN v_out_at > now();

      INSERT INTO public.attendance_punches
        (employee_id, punched_at, direction, source, reason)
      VALUES
        (emp.id, v_in_at,  'in',  'import', 'demo seed: synthetic punch (regression fixture)'),
        (emp.id, v_out_at, 'out', 'import', 'demo seed: synthetic punch (regression fixture)');
    END LOOP;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 3. One roster week for Banquet (next IST week), slots published.
  -- ---------------------------------------------------------------------------
  v_week_start := (date_trunc('week', v_today::timestamp))::date + 7;  -- next Monday
  -- v_publisher was resolved above, before the salary revisions needed it.

  INSERT INTO public.rosters
    (company_id, location_id, department_id, week_start_date, title, status,
     published_by, published_at, notes)
  SELECT v_company, v_location, d.id, v_week_start,
         'Banquet — week of ' || to_char(v_week_start, 'DD Mon YYYY'),
         CASE WHEN v_publisher IS NOT NULL THEN 'published' ELSE 'draft' END,
         v_publisher,
         CASE WHEN v_publisher IS NOT NULL THEN now() END,
         'demo seed: sample published roster week'
  FROM public.departments d
  WHERE d.company_id = v_company AND d.code = 'BANQ' AND d.deleted_at IS NULL
  RETURNING id INTO v_roster;

  IF v_publisher IS NULL THEN
    RAISE NOTICE 'demo seed: no profile exists yet — roster header left in draft (slots are published)';
  END IF;

  INSERT INTO public.roster_slots
    (roster_id, employee_id, slot_date, shift_id, is_weekly_off, is_published)
  SELECT v_roster, e.id, v_week_start + o.offset_days,
         CASE WHEN o.offset_days = 1 THEN NULL ELSE s.id END,
         (o.offset_days = 1),          -- Tuesday: weekly off
         true
  FROM public.employees e
  JOIN generate_series(0, 6) AS o(offset_days) ON true
  JOIN public.shifts s
    ON s.company_id = v_company AND s.deleted_at IS NULL
   AND s.code = CASE WHEN o.offset_days >= 4 THEN 'BANQ-B' ELSE 'BANQ-A' END
  WHERE e.company_id = v_company
    AND e.employee_code IN ('TT0003', 'TT0004')
    AND e.deleted_at IS NULL;

  -- ---------------------------------------------------------------------------
  -- 4. One payroll run (draft) for the pay period covering two weeks ago.
  -- ---------------------------------------------------------------------------
  SELECT pp.id, pp.code INTO v_period, v_period_code
  FROM public.pay_periods pp
  WHERE pp.company_id = v_company
    AND (v_today - 15) BETWEEN pp.start_date AND pp.end_date
  LIMIT 1;

  SELECT st.id INTO v_statutory
  FROM public.statutory_settings st
  WHERE st.company_id = v_company
    AND st.effective_from <= COALESCE(v_today, CURRENT_DATE)
  ORDER BY st.effective_from DESC
  LIMIT 1;

  IF v_period IS NOT NULL AND v_statutory IS NOT NULL THEN
    INSERT INTO public.payroll_runs
      (company_id, pay_period_id, run_number, run_kind, status,
       statutory_settings_id, notes)
    VALUES
      (v_company, v_period, 'PR-' || v_period_code || '-DEMO', 'regular',
       'draft', v_statutory, 'demo seed: draft payroll run (regression fixture)')
    ON CONFLICT ON CONSTRAINT uq_payroll_runs__run_number DO NOTHING;
  ELSE
    RAISE NOTICE 'demo seed: pay period or statutory settings not found — payroll run skipped';
  END IF;

  RAISE NOTICE 'demo seed applied: 12 employees, roster week %, 30 days of punches, 1 payroll run', v_week_start;
END;
$demo$;

COMMIT;
