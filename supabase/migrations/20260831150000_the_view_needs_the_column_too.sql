-- =============================================================================
-- 20260831150000 — the directory view needs the column too, and Preethi is hidden
-- =============================================================================
--
-- REPORTED, of the leave balances page:
--
--   "migration ran but still shows no name, preethi should not be here also"
--
-- Two things, and the first is the more serious.
--
-- ── EVERY NAME WENT BLANK, AND WHY ──────────────────────────────────────────
--
-- 20260831130000 added `exclude_from_leave_tracking` to `public.employees`, and I
-- added it to the client's directory schema in the same breath. The directory does
-- not read `employees`. It reads `v_admin_employee`, which enumerates its columns
-- rather than selecting `*` — so the browser asked a view for a column it does not
-- have, PostgREST refused the whole request, and the employee label map came back
-- EMPTY. Every row on the balances grid then rendered with no name, because there
-- were no labels to look one up in.
--
-- THAT IS THE THIRD TIME TODAY I have put a client schema ahead of the database
-- shape: `accrued_this_month_days` on the balances view, then the wizard column
-- grant that `wizardGrants.test.ts` caught, now this. The first two were caught by
-- a test and a probe. This one was not, because nothing compares the directory
-- schema against the view it reads — and a failed read degrades to blank names
-- rather than an error, which is exactly the shape of bug that survives review.
--
-- The column is appended to the view here. `CREATE OR REPLACE VIEW` may only add
-- columns at the end, which is why it sits after the bank fields rather than beside
-- the other employee flags.
--
-- ── PREETHI IS HIDDEN AFTER ALL ─────────────────────────────────────────────
--
-- 20260831130000 hid her, 20260831140000 un-hid her on my reading of "trisha is
-- management, we don't want arghya, vinod and suraj here", and the venue has now
-- said plainly that she should not appear either. She is hidden again.
--
-- I should not have inferred her from that sentence in either direction. The list I
-- was given the first time named four people; when a later message named three of
-- them I treated the omission as a correction rather than asking. The four are what
-- was asked for, twice.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 20260831150000: v_admin_employee gains exclude_from_leave_tracking so the employee directory read stops failing and names render again; and Preethi Machani is hidden from the leave register as originally asked', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The view the directory actually reads
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_admin_employee AS
SELECT e.id,
    e.profile_id,
    e.company_id,
    e.employee_code,
    e.title,
    e.first_name,
    e.middle_name,
    e.last_name,
    e.display_name,
    e.preferred_name,
    e.name_in_local_script,
    e.work_email,
    e.personal_email,
    e.mobile,
    e.date_of_birth,
    e.date_of_birth_actual,
    e.gender,
    e.blood_group,
    e.photo_path,
    e.cover_photo_path,
    e.about,
    e.biometric_enrolment_id,
    e.employment_type,
    e.employment_status,
    e.date_of_join,
    e.probation_months,
    e.confirmation_due_date,
    e.confirmed_on,
    e.contract_start_date,
    e.contract_end_date,
    e.notice_period_days,
    e.department_id,
    e.section_id,
    e.designation_id,
    e.grade_id,
    e.location_id,
    e.cost_centre_id,
    e.reporting_manager_id,
    e.dotted_line_manager_id,
    e.work_order_number,
    e.is_ot_eligible,
    e.is_shift_worker,
    e.punch_mode,
    e.attendance_policy_id,
    e.weekly_off_rule_id,
    e.holiday_calendar_id,
    e.shift_id,
    e.pay_period_id,
    e.attendance_regularize_from,
    e.allow_web_punch,
    e.allow_mobile_selfie_punch,
    e.restrict_punch_to_venue_ip,
    e.exclude_from_attendance,
    e.exclude_from_payroll,
    e.payment_mode,
    e.primary_bank_account_id,
    e.marital_status,
    e.marriage_anniversary,
    e.father_or_spouse_name,
    e.father_or_spouse_relation,
    e.mother_name,
    e.nationality,
    e.religion,
    e.category,
    e.is_differently_abled,
    e.disability_type,
    e.physical_address_same_as_permanent,
    e.mode_of_transport,
    e.uniform_size,
    e.food_preference,
    e.resignation_date,
    e.last_working_day,
    e.exit_type,
    e.exit_reason,
    e.exit_interview_done,
    e.is_rehire_eligible,
    e.full_and_final_settled_on,
    e.profile_completeness_pct,
    e.face_enrolled_at,
    e.fingerprint_enrolled_at,
    e.search_tsv,
    e.created_at,
    e.created_by,
    e.updated_at,
    e.updated_by,
    e.deleted_at,
    e.deleted_by,
    e.deletion_reason,
    d.name AS department_name,
    s.name AS section_name,
    g.name AS designation_name,
    gr.name AS grade_name,
    l.name AS location_name,
    cc.name AS cost_centre_name,
    co.trade_name AS company_name,
    rm.display_name AS reporting_manager_name,
    dm.display_name AS dotted_line_manager_name,
    sh.code AS shift_code,
    ap.code AS attendance_policy_code,
    util.mask_tail(es.pan, 4) AS pan_masked,
        CASE
            WHEN es.aadhaar_number IS NULL THEN NULL::text
            ELSE 'XXXX-XXXX-'::text || es.aadhaar_last4
        END AS aadhaar_masked,
    util.mask_tail(es.uan, 4) AS uan_masked,
    es.pf_applicable,
    es.esi_applicable,
    es.professional_tax_applicable,
    es.lwf_applicable,
    es.tax_regime,
    ba.bank_name AS primary_bank_name,
    ba.ifsc AS primary_bank_ifsc,
    ba.account_number_last4 AS primary_account_last4,
    ba.is_verified AS primary_bank_verified,
    e.exclude_from_leave_tracking
   FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN sections s ON s.id = e.section_id
     LEFT JOIN designations g ON g.id = e.designation_id
     LEFT JOIN grades gr ON gr.id = e.grade_id
     LEFT JOIN locations l ON l.id = e.location_id
     LEFT JOIN cost_centres cc ON cc.id = e.cost_centre_id
     LEFT JOIN companies co ON co.id = e.company_id
     LEFT JOIN employees rm ON rm.id = e.reporting_manager_id
     LEFT JOIN employees dm ON dm.id = e.dotted_line_manager_id
     LEFT JOIN shifts sh ON sh.id = e.shift_id
     LEFT JOIN attendance_policies ap ON ap.id = e.attendance_policy_id
     LEFT JOIN employee_statutory es ON es.employee_id = e.id
     LEFT JOIN employee_bank_accounts ba ON ba.id = e.primary_bank_account_id
  WHERE e.deleted_at IS NULL AND app.is_admin() AND app.admin_scope_covers(e.id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Preethi, hidden again
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.employees
   SET exclude_from_leave_tracking = true
 WHERE employee_code = 'TT0019'
   AND deleted_at IS NULL
   AND NOT exclude_from_leave_tracking;

DO $verify$
DECLARE v_in_view boolean; v_hidden text; v_trisha boolean;
BEGIN
  /* The half that broke the page: the client selects this column by name. */
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'v_admin_employee'
                    AND column_name = 'exclude_from_leave_tracking')
    INTO v_in_view;
  IF NOT v_in_view THEN
    RAISE EXCEPTION 'v_admin_employee still lacks the column, so the directory read will keep failing';
  END IF;

  /* Nobody outside the four may be hidden — asserted as an invariant, so it holds
     on a replayed database with none of these employees in it. */
  SELECT string_agg(employee_code, ', ' ORDER BY employee_code) INTO v_hidden
    FROM public.employees
   WHERE exclude_from_leave_tracking AND deleted_at IS NULL
     AND employee_code NOT IN ('TT0002', 'TT0013', 'TT0017', 'TT0019');
  IF v_hidden IS NOT NULL THEN
    RAISE EXCEPTION 'unexpectedly hidden from the leave register: %', v_hidden;
  END IF;

  SELECT exclude_from_leave_tracking INTO v_trisha
    FROM public.employees WHERE employee_code = 'TT0022' AND deleted_at IS NULL;
  IF v_trisha IS TRUE THEN
    RAISE EXCEPTION 'Trisha K is hidden — she is Management staff and stays';
  END IF;

  RAISE NOTICE 'directory view carries the column; hidden set is the four test/admin accounts';
END $verify$;

COMMIT;
