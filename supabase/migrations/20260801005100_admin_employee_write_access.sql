-- =============================================================================
-- Migration 051 — admin read + write access to the employee master
-- Source: docs/plan/04-data-model.md §3.3 (RLS posture), §4.3 pattern P8,
--         §4.6 (column allow-listing), spec-admin §2/§3 (Employee 360, Add
--         Employee wizard, inline editing).
--
-- Migration 008 gave `employees` a self SELECT policy, admin INSERT/UPDATE
-- policies, and column-scoped grants for the four self-editable fields. Three
-- things made the admin console unable to function:
--
--  1. NO ADMIN SELECT POLICY. Postgres applies SELECT policies to the rows a
--     WHERE-qualified UPDATE touches, so `UPDATE employees ... WHERE id = $1`
--     as an admin matched ZERO rows — the row simply was not visible to them.
--     PostgREST answers 204 for a zero-row PATCH, so every admin edit failed
--     SILENTLY. Reads went through v_admin_employee (a definer-ish view) and
--     hid the problem until the first write.
--
--  2. NO ADMIN UPDATE GRANT. Only (about, photo_path, cover_photo_path,
--     food_preference) were grantable — the self-editable set. An admin
--     changing a department, designation, shift or manager had no privilege on
--     those columns at all.
--
--  3. NO INSERT GRANT. The admin INSERT policy existed with no table-level
--     INSERT privilege behind it, so the Add Employee wizard could never write.
--
-- The security model is unchanged and still two-layer: ROW access by RLS policy
-- (admin + scope), FIELD access by column grant. Nothing here grants a client
-- any privilege on the sensitive columns that reveal-RPCs own; `employees` holds
-- no salary or statutory numbers (those live in employee_statutory /
-- employee_bank_accounts / employee_salary_revisions, all untouched here).
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 051: give admins row visibility and column privileges on the employee master', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Admin row visibility (P8). Scope-checked, soft-deletes visible to admins
--    on purpose — the Archive console needs them (§1.4).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS employees__admin_read ON public.employees;
CREATE POLICY employees__admin_read ON public.employees
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(id));

-- Managers see their reportees' rows for the columns they are granted. The
-- allow-listed view v_team_employee_basic remains the intended read path; this
-- policy exists so a manager-scoped write path (roster, regularization
-- decisions) can resolve the row it is acting on.
DROP POLICY IF EXISTS employees__manager_read ON public.employees;
CREATE POLICY employees__manager_read ON public.employees
  FOR SELECT TO authenticated
  USING (app.is_manager_of(id));

-- -----------------------------------------------------------------------------
-- 2. Column privileges for the admin-editable field set
-- -----------------------------------------------------------------------------
-- Granted to `authenticated` because column privileges are per-ROLE; the RLS
-- policies above are what restrict this to admins in practice. This mirrors how
-- migration 014 grants INSERT/UPDATE on shifts/policies to `authenticated` and
-- lets the policy decide. A non-admin attempting any of these gets zero rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE 'role authenticated absent (local harness) — grants skipped';
    RETURN;
  END IF;

  -- Identity and personal detail an HR admin maintains.
  GRANT SELECT, UPDATE (
    title, first_name, middle_name, last_name, display_name, preferred_name,
    name_in_local_script, work_email, personal_email, mobile,
    date_of_birth, date_of_birth_actual, gender, blood_group,
    marital_status, marriage_anniversary, father_or_spouse_name,
    father_or_spouse_relation, mother_name, nationality, religion, category,
    is_differently_abled, disability_type, mode_of_transport, uniform_size,
    food_preference, about, photo_path, cover_photo_path,
    physical_address_same_as_permanent, biometric_enrolment_id
  ) ON public.employees TO authenticated;

  -- Employment: role, org placement, reporting line, dates.
  GRANT UPDATE (
    employment_type, employment_status, date_of_join, probation_months,
    confirmed_on, contract_start_date, contract_end_date, notice_period_days,
    department_id, section_id, designation_id, grade_id, location_id,
    cost_centre_id, reporting_manager_id, dotted_line_manager_id,
    work_order_number
  ) ON public.employees TO authenticated;

  -- Attendance and payroll policy assignment (the "how this person is judged"
  -- fields the Employment tab renders in plain language).
  GRANT UPDATE (
    is_ot_eligible, is_shift_worker, punch_mode, attendance_policy_id,
    weekly_off_rule_id, holiday_calendar_id, shift_id, pay_period_id,
    attendance_regularize_from, allow_web_punch, allow_mobile_selfie_punch,
    restrict_punch_to_venue_ip, exclude_from_attendance, exclude_from_payroll,
    payment_mode, primary_bank_account_id
  ) ON public.employees TO authenticated;

  -- Exit / lifecycle. employment_status itself stays a projection of
  -- employee_lifecycle_events; these are the settlement fields HR records.
  GRANT UPDATE (
    resignation_date, last_working_day, exit_type, exit_reason,
    exit_interview_done, is_rehire_eligible, full_and_final_settled_on,
    deleted_at, deleted_by, deletion_reason
  ) ON public.employees TO authenticated;

  -- The Add Employee wizard. employee_code is deliberately NOT granted: it is
  -- generated by trigger and immutable (§8.6).
  GRANT INSERT (
    company_id, profile_id, title, first_name, middle_name, last_name,
    display_name, preferred_name, name_in_local_script, work_email,
    personal_email, mobile, date_of_birth, date_of_birth_actual, gender,
    blood_group, photo_path, employment_type, employment_status, date_of_join,
    probation_months, contract_start_date, contract_end_date,
    notice_period_days, department_id, section_id, designation_id, grade_id,
    location_id, cost_centre_id, reporting_manager_id, dotted_line_manager_id,
    work_order_number, is_ot_eligible, is_shift_worker, punch_mode,
    attendance_policy_id, weekly_off_rule_id, holiday_calendar_id, shift_id,
    pay_period_id, payment_mode, marital_status, father_or_spouse_name,
    father_or_spouse_relation, mother_name, nationality, uniform_size,
    food_preference, mode_of_transport, about
  ) ON public.employees TO authenticated;
END $$;

-- -----------------------------------------------------------------------------
-- 3. The same gap on the satellites an admin maintains
-- -----------------------------------------------------------------------------
-- employee_addresses / _contacts / _dependents already carry an admin ALL
-- policy (migration 009). employee_swipe_cards and the lifecycle tables need
-- admin row visibility for the same WHERE-qualified-UPDATE reason.
DROP POLICY IF EXISTS esc__admin_read ON public.employee_swipe_cards;
CREATE POLICY esc__admin_read ON public.employee_swipe_cards
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 4. Assert the fix: an admin must be able to SEE a row they may update.
-- -----------------------------------------------------------------------------
-- Catches a future edit that removes the SELECT policy and silently breaks
-- every admin write again.
DO $$
DECLARE
  v_has_admin_select boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'employees'
      AND cmd = 'SELECT' AND qual LIKE '%is_admin%'
  ) INTO v_has_admin_select;

  IF NOT v_has_admin_select THEN
    RAISE EXCEPTION
      'employees has admin UPDATE policies but no admin SELECT policy: every '
      'WHERE-qualified admin update would match zero rows and answer 204'
      USING errcode = '2F004';
  END IF;
  RAISE NOTICE 'admin employee write access asserted';
END $$;

COMMIT;
