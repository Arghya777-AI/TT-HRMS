-- =============================================================================
-- Migration 052 — demo data for the screens migration 047 left empty.
--
-- WHY THIS EXISTS
-- ---------------
-- 047 seeded employees, punches, attendance days, salary revisions and a draft
-- payroll run. That made the attendance surface convincing and left everything
-- else showing an empty state. A probe of the LIVE project found ELEVEN views
-- returning zero rows — v_approval_inbox, v_payslip_detail, v_employee_bank_masked,
-- v_employee_statutory_masked, v_comp_off_balance, v_leave_calendar,
-- v_kiosk_health, v_face_match_audit, v_asset_custody, v_payroll_variance and
-- v_my_data_access — so roughly thirty BUILT AND CORRECT screens rendered
-- "nothing here yet" and therefore read as broken.
--
-- This seed fills the gaps along the demo narrative:
--   * leave requests in every state, the pending ones addressed to a real
--     reporting manager, so the approval inbox and manager surface have work;
--   * statutory identifiers and bank accounts, so the Employee 360's masked
--     fields and the audited reveal ceremony have something to reveal;
--   * per-employee payroll rows AND published payslips, so the admin payroll
--     console and the employee payslip screens both work;
--   * personal satellites (address, emergency contact, nominee) for the 360;
--   * face-match rows, so the gate console shows the camera story the client
--     actually came to see.
--
-- SAFETY
-- ------
--  * Guarded by settings.seed_demo_data exactly like 047: flag false ⇒ no-op.
--  * Idempotent — every insert is existence-guarded, so re-applying is inert.
--  * Deterministic — no random(). Values derive from employee code and date
--    arithmetic so every rebuild produces the identical demo.
--
-- SCHEMA FACTS THIS FILE WAS CORRECTED AGAINST (each one broke a first draft):
--  * attendance_punches is IMMUTABLE (trg_attendance_punches__append_only fires
--    BEFORE UPDATE OR DELETE), so punches can NOT be back-filled with a device.
--    v_kiosk_health aggregates secure.face_match_log anyway — that is what gets
--    seeded, and it is the honest source: a gate scan IS a face match.
--  * payroll_run_employees carries NO money. It is a per-employee run STATUS row
--    (status IN pending|computed|excluded|error|held) pointing at a payslip.
--    Every figure lives on payslips.
--  * employee_contacts is a kind/value table, not a phone column, and
--    ck_ec__emergency_fields demands contact_name AND relationship when
--    contact_kind = 'emergency'.
--  * employee_dependents uses full_name/relationship/is_nominee, and
--    ck_ed__nominee_fields demands nominee_scheme AND nominee_share_pct
--    whenever is_nominee is true.
--  * employee_salary_revision_lines stores monthly_amount_paise, not amount_paise.
--  * Aadhaar must satisfy util.is_valid_aadhaar (Verhoeff), so the check digit is
--    SEARCHED rather than invented.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'seed 052: demo coverage for leave, payroll, statutory, bank, personal and gate screens', true);
SELECT set_config('app.source', 'migration', true);

DO $seed$
DECLARE
  v_enabled  boolean;
  v_company  uuid;
  v_today    date := util.ist_date(now());
  v_actor    uuid;
  v_device   uuid;
  v_operator uuid;
  emp        record;
  v_type     record;
  v_period   record;
  v_run      uuid;
  v_slip     uuid;
  v_aadhaar  text;
  v_check    integer;
  v_prefix   text;
  v_gross    bigint;
  v_ded      bigint;
  v_seq      integer := 0;
  v_d        date;
BEGIN
  SELECT (value #>> '{}')::boolean INTO v_enabled
    FROM public.settings WHERE key = 'seed_demo_data' LIMIT 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE NOTICE 'seed 052 skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;
  SELECT id INTO v_actor   FROM public.profiles  ORDER BY created_at LIMIT 1;
  IF v_company IS NULL THEN
    RAISE NOTICE 'seed 052 skipped: no company row';
    RETURN;
  END IF;

  -- ===========================================================================
  -- 1. Statutory identifiers  →  v_employee_statutory_masked + the 360 reveal
  -- ===========================================================================
  v_seq := 0;
  FOR emp IN
    SELECT e.id, e.employee_code, e.first_name, e.date_of_join,
           row_number() OVER (ORDER BY e.employee_code) AS n
      FROM public.employees e
     WHERE e.deleted_at IS NULL
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.employee_statutory WHERE employee_id = emp.id);

    v_prefix := substring(lpad((200000000000 + emp.n * 7919)::text, 12, '0') FROM 1 FOR 11);
    v_aadhaar := NULL;
    FOR v_check IN 0..9 LOOP
      IF util.is_valid_aadhaar(v_prefix || v_check::text) THEN
        v_aadhaar := v_prefix || v_check::text;
        EXIT;
      END IF;
    END LOOP;

    INSERT INTO public.employee_statutory (
      employee_id, pf_applicable, pf_number, uan, pf_joining_date,
      esi_applicable, esi_number, esi_dispensary,
      pan, aadhaar_number, aadhaar_linked_to_uan,
      professional_tax_applicable, professional_tax_state,
      gratuity_eligible_from, tax_regime
    ) VALUES (
      emp.id,
      true,
      format('KA/BNG/%s/000/%s',
             lpad((1000000 + emp.n)::text, 7, '0'),
             lpad((emp.n * 137)::text, 7, '0')),
      lpad((100000000000 + emp.n * 4231)::text, 12, '0'),
      emp.date_of_join,
      (emp.n % 3 <> 0),
      CASE WHEN emp.n % 3 <> 0 THEN lpad((31000000000000000 + emp.n * 971)::text, 17, '0') END,
      CASE WHEN emp.n % 3 <> 0 THEN 'ESIC Dispensary, Whitefield' END,
      -- ck_es__pan: exactly 5 letters, 4 digits, 1 letter.
      upper(substring(regexp_replace(coalesce(emp.first_name, 'AAA'), '[^A-Za-z]', '', 'g') || 'AAAAA' FROM 1 FOR 3))
        -- row_number() is bigint and chr() only accepts integer, so the cast is
        -- mandatory, not decorative: chr(bigint) is 42883 "does not exist".
        || 'PM' || lpad(((1000 + emp.n * 13) % 10000)::text, 4, '0')
        || chr((65 + (emp.n % 26))::integer),
      v_aadhaar,
      (emp.n % 2 = 0),
      true,
      'Karnataka',
      (emp.date_of_join + INTERVAL '5 years')::date,
      CASE WHEN emp.n % 4 = 0 THEN 'old' ELSE 'new' END
    );
    v_seq := v_seq + 1;
  END LOOP;
  RAISE NOTICE 'seed 052: % statutory records', v_seq;

  -- ===========================================================================
  -- 2. Bank accounts  →  v_employee_bank_masked, payslip disbursement
  -- ===========================================================================
  v_seq := 0;
  FOR emp IN
    SELECT e.id, e.display_name, e.date_of_join,
           row_number() OVER (ORDER BY e.employee_code) AS n
      FROM public.employees e
     WHERE e.deleted_at IS NULL
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.employee_bank_accounts WHERE employee_id = emp.id AND is_active);

    INSERT INTO public.employee_bank_accounts (
      employee_id, beneficiary_name, bank_name, branch, ifsc, account_number,
      account_type, is_verified, verification_method, verified_by, verified_at,
      is_active, effective_from
    ) VALUES (
      emp.id,
      emp.display_name,
      CASE emp.n % 4 WHEN 0 THEN 'State Bank of India' WHEN 1 THEN 'HDFC Bank'
                     WHEN 2 THEN 'Canara Bank'         ELSE 'Axis Bank' END,
      CASE emp.n % 4 WHEN 0 THEN 'Whitefield, Bengaluru' WHEN 1 THEN 'Indiranagar, Bengaluru'
                     WHEN 2 THEN 'Jayanagar, Bengaluru'  ELSE 'Koramangala, Bengaluru' END,
      CASE emp.n % 4 WHEN 0 THEN 'SBIN0007890' WHEN 1 THEN 'HDFC0001234'
                     WHEN 2 THEN 'CNRB0002345' ELSE 'UTIB0003456' END,
      lpad((30000000000 + emp.n * 8617)::text, 14, '0'),
      'salary', true, 'penny_drop', v_actor,
      (emp.date_of_join + INTERVAL '2 days')::timestamptz,
      true, emp.date_of_join
    );
    v_seq := v_seq + 1;
  END LOOP;
  RAISE NOTICE 'seed 052: % bank accounts', v_seq;

  -- ===========================================================================
  -- 3. Personal satellites  →  the 360's Personal tab
  -- ===========================================================================
  v_seq := 0;
  FOR emp IN
    SELECT e.id, e.display_name, e.father_or_spouse_name,
           row_number() OVER (ORDER BY e.employee_code) AS n
      FROM public.employees e
     WHERE e.deleted_at IS NULL
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.employee_addresses WHERE employee_id = emp.id) THEN
      INSERT INTO public.employee_addresses (
        employee_id, address_kind, line1, line2, city, district, state, pincode, country
      ) VALUES (
        emp.id, 'permanent',
        format('%s, %s Cross', 100 + emp.n, 1 + (emp.n % 12)),
        CASE emp.n % 5 WHEN 0 THEN 'Whitefield'  WHEN 1 THEN 'Marathahalli'
                       WHEN 2 THEN 'K R Puram'   WHEN 3 THEN 'Hoskote'
                       ELSE 'Budigere Cross' END,
        'Bengaluru', 'Bengaluru Urban', 'Karnataka',
        lpad((560000 + (emp.n * 3))::text, 6, '0'), 'India'
      );
      v_seq := v_seq + 1;
    END IF;

    -- ck_ec__emergency_fields: an 'emergency' contact needs a name AND relationship.
    IF NOT EXISTS (SELECT 1 FROM public.employee_contacts WHERE employee_id = emp.id) THEN
      INSERT INTO public.employee_contacts (
        employee_id, contact_kind, value, contact_name, relationship, is_primary
      ) VALUES (
        emp.id, 'emergency',
        lpad((9800000000 + emp.n * 11)::text, 10, '0'),
        coalesce(nullif(btrim(emp.father_or_spouse_name), ''), 'Next of kin'),
        CASE WHEN emp.n % 2 = 0 THEN 'spouse' ELSE 'father' END,
        true
      );
      v_seq := v_seq + 1;
    END IF;

    -- ck_ed__nominee_fields: is_nominee demands a scheme AND a share.
    IF emp.n % 2 = 0
       AND NOT EXISTS (SELECT 1 FROM public.employee_dependents WHERE employee_id = emp.id) THEN
      INSERT INTO public.employee_dependents (
        employee_id, full_name, relationship, date_of_birth,
        is_nominee, nominee_scheme, nominee_share_pct, is_dependent_for_insurance
      ) VALUES (
        emp.id,
        coalesce(nullif(btrim(emp.father_or_spouse_name), ''), emp.display_name || ' (nominee)'),
        'spouse',
        (v_today - INTERVAL '32 years' - (emp.n || ' months')::interval)::date,
        true, 'pf', 100, true
      );
      v_seq := v_seq + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'seed 052: % personal satellite rows', v_seq;

  -- ===========================================================================
  -- 3b. Opening leave balances  →  v_leave_balance_current, and the precondition
  --     for every leave request below
  -- ===========================================================================
  -- The first attempt at this seed failed with "insufficient CL balance: 0.000
  -- available" for every single employee, which exposed something more important
  -- than the seed: NOBODY HAD ANY LEAVE BALANCE. `leave_ledger` held four rows in
  -- total, because accrual is a scheduled job that has never run against this
  -- project. Every leave screen — balances, apply, calendar, the manager's
  -- approval queue — was therefore correctly showing nothing, and the leave
  -- engine was correctly refusing every application.
  --
  -- An 'opening_balance' entry is exactly the right instrument: it is what an
  -- HRMS posts when a company goes live mid-year, the ledger is append-only, and
  -- v_leave_balance_current is a GENERATED sum over it, so the balance, the apply
  -- screen's preview and the payroll engine all read the same number.
  v_seq := 0;
  FOR emp IN
    SELECT e.id, e.employee_code, e.date_of_join
      FROM public.employees e
     WHERE e.deleted_at IS NULL
  LOOP
    FOR v_type IN
      SELECT lt.id, lt.code, lt.annual_quota_days
        FROM public.leave_types lt
       WHERE lt.is_active
         AND lt.deleted_at IS NULL
         AND coalesce(lt.annual_quota_days, 0) > 0
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.leave_ledger l
         WHERE l.employee_id = emp.id
           AND l.leave_type_id = v_type.id
           AND l.entry_type = 'opening_balance'
           AND l.leave_year = EXTRACT(YEAR FROM v_today)::integer);

      INSERT INTO public.leave_ledger (
        employee_id, leave_type_id, leave_year, entry_type, days,
        effective_date, description, source_table, reason, recorded_by
      ) VALUES (
        emp.id, v_type.id,
        EXTRACT(YEAR FROM v_today)::integer,
        'opening_balance',
        -- Three quarters of the annual quota: consistent with a mid-year opening
        -- and it leaves a visible "used" portion on the balance screens.
        round(coalesce(v_type.annual_quota_days, 12) * 0.75, 1),
        greatest(emp.date_of_join, date_trunc('year', v_today)::date),
        format('Opening balance for %s on system go-live', v_type.code),
        'migration',
        'seed 052: opening balances so the leave engine has something to work with',
        v_actor
      );
      v_seq := v_seq + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'seed 052: % opening balance entries', v_seq;

  -- ===========================================================================
  -- 4. Leave requests  →  v_approval_inbox, manager approvals, leave calendar
  -- ===========================================================================
  -- THE PATH MATTERS. A request is inserted as 'draft' and then transitioned to
  -- 'pending' — never inserted as 'pending' directly. `leave_requests_submit_guard`
  -- is a BEFORE INSERT OR UPDATE trigger that expands the request into
  -- `leave_request_days` via rebuild_leave_request_days(NEW.id, …), and on INSERT
  -- the parent row does not exist yet, so the child FK fails with 23503. The
  -- guard's own `TG_OP = 'INSERT'` branch is therefore unreachable in practice —
  -- a latent defect worth fixing by moving the expansion to an AFTER trigger,
  -- but not on the eve of a demo. The frontend already does draft → pending
  -- (src/features/leave/api/leave-apply.api.ts), so this seed exercises exactly
  -- the path the product uses.
  --
  -- Each request is also wrapped in its own exception block: leave_types carry
  -- quota, notice and handover rules, and one employee with a thin balance must
  -- degrade to a NOTICE rather than abort the entire seed.
  v_seq := 0;
  FOR emp IN
    SELECT e.id, e.employee_code, e.reporting_manager_id,
           row_number() OVER (ORDER BY e.employee_code) AS n
      FROM public.employees e
     WHERE e.deleted_at IS NULL
       AND e.reporting_manager_id IS NOT NULL
     ORDER BY e.employee_code
     LIMIT 8
  LOOP
    SELECT lt.id AS id INTO v_type
      FROM public.leave_types lt
     WHERE lt.is_active
     ORDER BY lt.sort_order
     OFFSET (emp.n % 3) LIMIT 1;
    CONTINUE WHEN v_type.id IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.leave_requests
       WHERE employee_id = emp.id AND status IN ('pending','approved','rejected'));

    BEGIN
      IF emp.n <= 4 THEN
        -- Future-dated and left PENDING with their real manager as approver:
        -- this is what makes /team/approvals and /me/approvals non-empty.
        INSERT INTO public.leave_requests (
          employee_id, leave_type_id, from_date, to_date,
          reason, status, current_approver_id,
          handover_to_employee_id, created_by
        ) VALUES (
          emp.id, v_type.id,
          (v_today + (5 + emp.n)::integer),
          (v_today + (5 + emp.n + (emp.n % 2))::integer),
          format('Family commitment planned in advance — %s day(s) requested, cover discussed with the section lead.',
                 1 + (emp.n % 2)),
          'draft', emp.reporting_manager_id,
          -- Mandatory for operational departments (banquet, kitchen, housekeeping).
          emp.reporting_manager_id, v_actor
        ) RETURNING id INTO v_slip;

        UPDATE public.leave_requests SET status = 'pending' WHERE id = v_slip;
        v_seq := v_seq + 1;
      ELSE
        -- Decided history, so the lists show approved AND rejected outcomes.
        INSERT INTO public.leave_requests (
          employee_id, leave_type_id, from_date, to_date,
          reason, status, current_approver_id,
          handover_to_employee_id, created_by
        ) VALUES (
          emp.id, v_type.id,
          (v_today - (20 - emp.n)::integer),
          (v_today - (20 - emp.n)::integer),
          'Medical appointment that could not be rescheduled outside working hours.',
          'draft', emp.reporting_manager_id,
          emp.reporting_manager_id, v_actor
        ) RETURNING id INTO v_slip;

        UPDATE public.leave_requests SET status = 'pending' WHERE id = v_slip;

        -- Then the manager's decision, which is what fires the ledger trigger.
        UPDATE public.leave_requests
           SET status = CASE WHEN emp.n = 8 THEN 'rejected'::public.leave_request_status
                             ELSE 'approved'::public.leave_request_status END,
               approved_days = CASE WHEN emp.n = 8 THEN 0 ELSE total_days END,
               decided_by = v_actor,
               decided_at = (v_today - (18 - emp.n)::integer)::timestamptz,
               decision_comment = CASE WHEN emp.n = 8
                 THEN 'Declined — the banquet that evening needs full floor cover. Please re-apply for another day.'
                 ELSE 'Approved. Cover arranged with the section lead.' END
         WHERE id = v_slip;
        v_seq := v_seq + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'seed 052: leave request for % skipped (%)', emp.employee_code, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'seed 052: % leave requests', v_seq;

  -- ===========================================================================
  -- 5. Payroll: run rows + PUBLISHED payslips  →  v_payslip_detail, /me/payslips
  -- ===========================================================================
  SELECT pr.id INTO v_run FROM public.payroll_runs pr ORDER BY pr.created_at DESC LIMIT 1;
  SELECT pp.id, pp.start_date, pp.end_date, pp.pay_date, pp.code
    INTO v_period
    FROM public.pay_periods pp
   WHERE pp.company_id = v_company
   ORDER BY pp.start_date DESC LIMIT 1;

  IF v_run IS NOT NULL AND v_period.id IS NOT NULL THEN
    v_seq := 0;
    FOR emp IN
      SELECT e.id, e.employee_code, e.payment_mode,
             row_number() OVER (ORDER BY e.employee_code) AS n
        FROM public.employees e
       WHERE e.deleted_at IS NULL
         AND e.exclude_from_payroll = false
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.payslips WHERE payroll_run_id = v_run AND employee_id = emp.id);

      -- Derived from the employee's live salary revision so the payslip and the
      -- salary screen cannot disagree. There is no `is_current` flag on
      -- employee_salary_revisions (that guess cost a failed push): the live row
      -- is the open-ended one, latest effective_from wins.
      SELECT r.monthly_gross_paise INTO v_gross
        FROM public.employee_salary_revisions r
       WHERE r.employee_id = emp.id
         AND r.effective_to IS NULL
       ORDER BY r.effective_from DESC
       LIMIT 1;
      IF v_gross IS NULL OR v_gross = 0 THEN
        v_gross := 2500000 + emp.n * 50000;
      END IF;
      v_ded := (v_gross * 12) / 100;   -- employee PF share; a fixture, not the engine

      INSERT INTO public.payslips (
        payroll_run_id, employee_id, pay_period_id, payslip_number,
        period_start, period_end, pay_date, period_days,
        paid_days, lop_days, present_days, weekly_off_days, holiday_days,
        gross_earnings_paise, total_deductions_paise, net_pay_paise,
        ytd_gross_paise, ytd_deductions_paise, ytd_net_paise,
        bank_account_id, payment_mode, payment_status, paid_on
      ) VALUES (
        v_run, emp.id, v_period.id,
        format('%s/%s', emp.employee_code, v_period.code),
        v_period.start_date, v_period.end_date, v_period.pay_date,
        (v_period.end_date - v_period.start_date + 1),
        26 - (emp.n % 2), (emp.n % 2), 22 - (emp.n % 2), 4, 1,
        v_gross, v_ded, v_gross - v_ded,
        v_gross * 4, v_ded * 4, (v_gross - v_ded) * 4,
        (SELECT b.id FROM public.employee_bank_accounts b
          WHERE b.employee_id = emp.id AND b.is_active LIMIT 1),
        coalesce(emp.payment_mode::public.payment_mode, 'bank_transfer'::public.payment_mode),
        'paid', v_period.pay_date
      ) RETURNING id INTO v_slip;

      INSERT INTO public.payroll_run_employees (
        payroll_run_id, employee_id, status, computed_at, payslip_id
      ) VALUES (v_run, emp.id, 'computed', now(), v_slip)
      ON CONFLICT (payroll_run_id, employee_id) DO UPDATE
        SET status = 'computed', payslip_id = EXCLUDED.payslip_id;

      v_seq := v_seq + 1;
    END LOOP;
    RAISE NOTICE 'seed 052: % payslips', v_seq;
  ELSE
    RAISE NOTICE 'seed 052: no payroll run or pay period — payslips skipped';
  END IF;

  -- ===========================================================================
  -- 6. Face matches  →  v_kiosk_health, v_face_match_audit, the gate console
  -- ===========================================================================
  -- A gate scan IS a face match, so this is the honest source for the kiosk
  -- console. Punches cannot be back-filled with a device: the log is immutable.
  SELECT id INTO v_device   FROM public.kiosk_devices   ORDER BY created_at LIMIT 1;
  SELECT id INTO v_operator FROM public.kiosk_operators ORDER BY created_at LIMIT 1;

  IF v_device IS NOT NULL THEN
    v_seq := 0;
    FOR v_d IN SELECT generate_series(v_today - 13, v_today, '1 day'::interval)::date LOOP
      FOR emp IN
        SELECT e.id, row_number() OVER (ORDER BY e.employee_code) AS n
          FROM public.employees e
         WHERE e.deleted_at IS NULL
         LIMIT 10
      LOOP
        CONTINUE WHEN EXISTS (
          SELECT 1 FROM secure.face_match_log f
           WHERE f.ist_date = v_d AND f.matched_employee_id = emp.id);

        -- Two scans a day: arrival and departure. Deterministic minute jitter.
        INSERT INTO secure.face_match_log (
          attempted_at, kiosk_device_id, operator_id, candidate_set_size,
          outcome, matched_employee_id, best_distance, best_confidence,
          margin, threshold_used, model_version, detector_score, liveness_score,
          latency_ms, app_version
        )
        SELECT
          -- make_interval takes integer arguments; emp.n is bigint (row_number).
          (v_d::timestamp + make_interval(hours => h, mins => ((emp.n * 7 + h) % 25)::integer))
            AT TIME ZONE 'Asia/Kolkata',
          v_device, v_operator, 13,
          -- One deliberate no_match and one ambiguous in the window, so the
          -- console has something real to review instead of a perfect record.
          CASE WHEN emp.n = 7 AND v_d = v_today - 3 THEN 'no_match'
               WHEN emp.n = 4 AND v_d = v_today - 6 THEN 'ambiguous'
               ELSE 'matched' END,
          CASE WHEN emp.n = 7 AND v_d = v_today - 3 THEN NULL ELSE emp.id END,
          0.28 + ((emp.n % 5) * 0.01),
          0.94 - ((emp.n % 5) * 0.01),
          CASE WHEN emp.n = 4 AND v_d = v_today - 6 THEN 0.03 ELSE 0.18 END,
          0.42, 'face-api/ssd_mobilenetv1+128d',
          0.97, 0.95,
          120 + ((emp.n * 13) % 90),
          '1.0.0'
        FROM (VALUES (9), (18)) AS t(h);
        v_seq := v_seq + 2;
      END LOOP;
    END LOOP;
    RAISE NOTICE 'seed 052: % face match rows', v_seq;
  ELSE
    RAISE NOTICE 'seed 052: no kiosk device — face match log skipped';
  END IF;

  RAISE NOTICE 'seed 052 complete';
END $seed$;

COMMIT;
