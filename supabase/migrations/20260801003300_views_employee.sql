-- =============================================================================
-- Migration 033 — employee read-model views (§4.6, §9.3)
-- Source: docs/plan/04-data-model.md §4.6 (manager column allowlisting),
--         §9.3 catalogue rows v_my_employee / v_team_employee_basic /
--         v_employee_directory / v_admin_employee / v_employee_statutory_masked
--         / v_employee_bank_masked.
--
-- Access model recap (008/009 already enforce it):
--   * public.employees carries NO table-level SELECT for authenticated — only
--     a 7-column identity grant. All broader reads flow through these views.
--   * The sensitive satellites carry column-scoped SELECT grants that exclude
--     the full numbers; unmasked values exist only behind the 032 reveals.
--
-- View mechanics: these views run as their owner (PostgreSQL "security
-- definer" view semantics) with security_barrier, and every one hard-codes
-- the §4.6 row predicate (self / is_manager_of / admin_scope_covers) in its
-- WHERE clause. security_invoker=true is NOT usable here: the whole §4.6
-- design revokes base-table SELECT from authenticated, and an invoker view
-- re-checks base-table privileges against the caller, which would make the
-- views unreadable. The doc's row predicates are transcribed verbatim.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Belt-and-braces: the §4.6 REVOKE, verbatim. Table-level SELECT was never
--    granted for these (008/009); column-level grants are unaffected.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE SELECT ON public.employees                   FROM authenticated;
    REVOKE SELECT ON public.employee_statutory          FROM authenticated;
    REVOKE SELECT ON public.employee_bank_accounts      FROM authenticated;
    REVOKE SELECT ON public.employee_identity_documents FROM authenticated;

    -- A table-level REVOKE also drops column-level privileges (PostgreSQL
    -- REVOKE semantics), so the deliberate column-scoped grants of 008/009
    -- are re-issued VERBATIM — full numbers stay unselectable.
    GRANT SELECT (id, employee_code, display_name, about, photo_path, cover_photo_path, food_preference)
      ON public.employees TO authenticated;

    GRANT SELECT (id, employee_id, document_kind, number_last4, name_on_document,
                  issue_date, expiry_date, issuing_country, issuing_authority,
                  place_of_issue, visa_kind, visa_valid_from, visa_valid_to,
                  document_id, is_verified, verified_by, verified_at, is_current,
                  created_at, updated_at)
      ON public.employee_identity_documents TO authenticated;

    GRANT SELECT (employee_id, pf_applicable, pf_joining_date, pf_wage_ceiling_applied,
                  eps_applicable, esi_applicable, esi_dispensary, aadhaar_last4,
                  aadhaar_linked_to_uan, professional_tax_applicable,
                  professional_tax_state, lwf_applicable, gratuity_eligible_from,
                  tax_regime, tax_regime_locked_fy, is_director_or_partner,
                  created_at, updated_at)
      ON public.employee_statutory TO authenticated;

    GRANT SELECT (id, employee_id, beneficiary_name, bank_name, branch, ifsc,
                  account_number_last4, account_type, upi_id, is_verified,
                  verification_method, verified_by, verified_at, is_active,
                  effective_from, effective_to, created_at, updated_at)
      ON public.employee_bank_accounts TO authenticated;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. v_my_employee — my own record: everything about me (§4.6)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_my_employee
WITH (security_barrier = true) AS
SELECT e.*
FROM public.employees e
WHERE e.id = app.current_employee_id() AND e.deleted_at IS NULL;

COMMENT ON VIEW public.v_my_employee IS
  '§4.6 view 1: the caller''s own employees row, all columns. Owner-executed; the WHERE pins it to app.current_employee_id().';

-- -----------------------------------------------------------------------------
-- 2. v_team_employee_basic — the manager allowlist, and only the allowlist (§4.6)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_team_employee_basic
WITH (security_barrier = true) AS
SELECT e.id, e.employee_code, e.display_name, e.photo_path,
       e.work_email, e.mobile,
       d.name  AS department_name, s.name AS section_name,
       g.name  AS designation_name, gr.name AS grade_name,
       l.name  AS location_name,
       e.employment_type, e.employment_status,
       e.date_of_join, e.confirmation_due_date,
       (e.employment_status = 'on_probation') AS is_on_probation,
       e.reporting_manager_id, e.dotted_line_manager_id,
       e.shift_id, e.is_shift_worker, e.is_ot_eligible,
       e.face_enrolled_at IS NOT NULL AS is_face_enrolled,
       to_char(e.date_of_birth, 'DD Mon') AS birthday_display   -- day+month only, never the year
FROM public.employees e
LEFT JOIN public.departments  d  ON d.id  = e.department_id
LEFT JOIN public.sections     s  ON s.id  = e.section_id
LEFT JOIN public.designations g  ON g.id  = e.designation_id
LEFT JOIN public.grades       gr ON gr.id = e.grade_id
LEFT JOIN public.locations    l  ON l.id  = e.location_id
WHERE e.deleted_at IS NULL
  AND (   e.id = app.current_employee_id()
       OR app.is_manager_of(e.id)
       OR (app.is_admin() AND app.admin_scope_covers(e.id)) );

COMMENT ON VIEW public.v_team_employee_basic IS
  '§4.6 view 2: the manager column allowlist. No salary, no bank, no Aadhaar/PAN, no home address, no dependents. birthday_display carries day+month only.';

-- -----------------------------------------------------------------------------
-- 3. v_employee_directory — the smallest possible set, visible to everyone (§4.6)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_employee_directory
WITH (security_barrier = true) AS
SELECT e.id, e.employee_code, e.display_name, e.photo_path, e.work_email,
       g.name AS designation_name, d.name AS department_name, l.name AS location_name
FROM public.employees e
LEFT JOIN public.designations g ON g.id = e.designation_id
LEFT JOIN public.departments  d ON d.id = e.department_id
LEFT JOIN public.locations    l ON l.id = e.location_id
WHERE e.deleted_at IS NULL
  AND e.employment_status IN ('active','confirmed','on_probation','on_notice');

COMMENT ON VIEW public.v_employee_directory IS
  '§4.6 view 3: org directory — name, designation, department, work email, photo. A venue team needs to find each other.';

-- -----------------------------------------------------------------------------
-- 4. v_employee_ref — internal label helper for the fact views (034–037).
--    Directory-visible employees for everyone, PLUS any employee the caller
--    can already see (so managers/admins keep labels for exited reportees in
--    historical attendance/audit surfaces). Minimal, non-sensitive columns.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_employee_ref
WITH (security_barrier = true) AS
SELECT e.id, e.profile_id, e.employee_code, e.display_name, e.photo_path, e.work_email,
       e.department_id, d.name AS department_name,
       e.section_id, s.name AS section_name,
       e.designation_id, g.name AS designation_name,
       e.location_id, l.name AS location_name,
       e.employment_status, e.employment_type,
       e.date_of_join, e.last_working_day,
       e.reporting_manager_id, e.shift_id, e.is_shift_worker, e.is_ot_eligible,
       e.exclude_from_attendance, e.exclude_from_payroll
FROM public.employees e
LEFT JOIN public.departments  d ON d.id = e.department_id
LEFT JOIN public.sections     s ON s.id = e.section_id
LEFT JOIN public.designations g ON g.id = e.designation_id
LEFT JOIN public.locations    l ON l.id = e.location_id
WHERE e.deleted_at IS NULL
  AND (   e.employment_status IN ('active','confirmed','on_probation','on_notice')
       OR e.id = app.current_employee_id()
       OR app.is_manager_of(e.id)
       OR (app.is_admin() AND app.admin_scope_covers(e.id)) );

COMMENT ON VIEW public.v_employee_ref IS
  'Label helper for 034–037 fact views: directory columns + org pointers, no PII. Rows: directory-visible employees for everyone, plus own/team/admin-scope rows (covers exited employees in history views).';

-- -----------------------------------------------------------------------------
-- 5. v_admin_employee — all columns + masked sensitive columns + resolved
--    lookup names, admin-scoped (§9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_admin_employee
WITH (security_barrier = true) AS
SELECT
  e.*,
  d.name   AS department_name,
  s.name   AS section_name,
  g.name   AS designation_name,
  gr.name  AS grade_name,
  l.name   AS location_name,
  cc.name  AS cost_centre_name,
  co.trade_name AS company_name,
  rm.display_name AS reporting_manager_name,
  dm.display_name AS dotted_line_manager_name,
  sh.code  AS shift_code,
  ap.code  AS attendance_policy_code,
  -- masked sensitive satellites: displayable without a reveal, per §4.7
  util.mask_tail(es.pan, 4)            AS pan_masked,
  CASE WHEN es.aadhaar_number IS NULL THEN NULL
       ELSE 'XXXX-XXXX-' || es.aadhaar_last4 END AS aadhaar_masked,
  util.mask_tail(es.uan, 4)            AS uan_masked,
  es.pf_applicable, es.esi_applicable,
  es.professional_tax_applicable, es.lwf_applicable, es.tax_regime,
  ba.bank_name                          AS primary_bank_name,
  ba.ifsc                               AS primary_bank_ifsc,
  ba.account_number_last4               AS primary_account_last4,
  ba.is_verified                        AS primary_bank_verified
FROM public.employees e
LEFT JOIN public.departments   d  ON d.id  = e.department_id
LEFT JOIN public.sections      s  ON s.id  = e.section_id
LEFT JOIN public.designations  g  ON g.id  = e.designation_id
LEFT JOIN public.grades        gr ON gr.id = e.grade_id
LEFT JOIN public.locations     l  ON l.id  = e.location_id
LEFT JOIN public.cost_centres  cc ON cc.id = e.cost_centre_id
LEFT JOIN public.companies     co ON co.id = e.company_id
LEFT JOIN public.employees     rm ON rm.id = e.reporting_manager_id
LEFT JOIN public.employees     dm ON dm.id = e.dotted_line_manager_id
LEFT JOIN public.shifts        sh ON sh.id = e.shift_id
LEFT JOIN public.attendance_policies ap ON ap.id = e.attendance_policy_id
LEFT JOIN public.employee_statutory  es ON es.employee_id = e.id
LEFT JOIN public.employee_bank_accounts ba ON ba.id = e.primary_bank_account_id
WHERE e.deleted_at IS NULL
  AND app.is_admin() AND app.admin_scope_covers(e.id);

COMMENT ON VIEW public.v_admin_employee IS
  '§9.3: admin read model — every employees column, resolved lookup names, and MASKED statutory/bank identifiers. Unmasked values only via the 032 reveal functions (which log to data_access_log).';

-- -----------------------------------------------------------------------------
-- 6. v_employee_statutory_masked — pan/aadhaar/uan masked + applicability flags
--    (self + scoped admin; §9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_employee_statutory_masked
WITH (security_barrier = true) AS
SELECT
  es.employee_id,
  util.mask_tail(es.pan, 4) AS pan_masked,
  CASE WHEN es.aadhaar_number IS NULL THEN NULL
       ELSE 'XXXX-XXXX-' || es.aadhaar_last4 END AS aadhaar_masked,
  util.mask_tail(es.uan, 4)       AS uan_masked,
  util.mask_tail(es.pf_number, 4) AS pf_number_masked,
  util.mask_tail(es.esi_number, 4) AS esi_number_masked,
  es.pf_applicable, es.eps_applicable, es.esi_applicable,
  es.pf_joining_date, es.pf_wage_ceiling_applied, es.esi_dispensary,
  es.aadhaar_linked_to_uan,
  es.professional_tax_applicable, es.professional_tax_state,
  es.lwf_applicable, es.gratuity_eligible_from,
  es.tax_regime, es.tax_regime_locked_fy, es.is_director_or_partner
FROM public.employee_statutory es
WHERE es.employee_id = app.current_employee_id()
   OR (app.is_admin() AND app.admin_scope_covers(es.employee_id));

COMMENT ON VIEW public.v_employee_statutory_masked IS
  '§4.7/§9.3: statutory identifiers masked to their tails + applicability flags. Full values only via reveal_employee_statutory().';

-- -----------------------------------------------------------------------------
-- 7. v_employee_bank_masked — bank_name, ifsc, account_number_last4, is_verified
--    (self + scoped admin; §9.3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_employee_bank_masked
WITH (security_barrier = true) AS
SELECT
  b.id, b.employee_id,
  b.beneficiary_name, b.bank_name, b.branch, b.ifsc,
  b.account_number_last4, b.account_type,
  util.mask_tail(b.upi_id, 4) AS upi_id_masked,
  b.is_verified, b.verification_method, b.verified_at,
  b.is_active, b.effective_from, b.effective_to
FROM public.employee_bank_accounts b
WHERE b.employee_id = app.current_employee_id()
   OR (app.is_admin() AND app.admin_scope_covers(b.employee_id));

COMMENT ON VIEW public.v_employee_bank_masked IS
  '§4.7/§9.3: bank accounts with account number reduced to last-4. Full number only via reveal_employee_bank_account().';

-- -----------------------------------------------------------------------------
-- 8. Grants — §4.6 verbatim (+ the additional catalogue views)
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.v_my_employee, public.v_team_employee_basic, public.v_employee_directory,
  public.v_employee_ref, public.v_admin_employee,
  public.v_employee_statutory_masked, public.v_employee_bank_masked
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.v_my_employee, public.v_team_employee_basic, public.v_employee_directory,
      public.v_employee_ref, public.v_admin_employee,
      public.v_employee_statutory_masked, public.v_employee_bank_masked
    FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.v_my_employee, public.v_team_employee_basic,
                    public.v_employee_directory TO authenticated;
    GRANT SELECT ON public.v_employee_ref, public.v_admin_employee,
                    public.v_employee_statutory_masked, public.v_employee_bank_masked
      TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON public.v_my_employee, public.v_team_employee_basic,
                    public.v_employee_directory, public.v_employee_ref,
                    public.v_admin_employee, public.v_employee_statutory_masked,
                    public.v_employee_bank_masked TO service_role;
  END IF;
END $$;

COMMIT;
