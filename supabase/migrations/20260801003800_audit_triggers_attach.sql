-- =============================================================================
-- 038 — AUDIT TRIGGER ATTACHMENT (docs/plan/04-data-model.md §5.4)
-- =============================================================================
-- Attaches audit.log_changes() (defined in 006) to every audited table, one
-- explicit CREATE TRIGGER per table — written out explicitly (not generated in
-- a DO block) so the migration is greppable and reviewable.
--
-- Also re-asserts the §5.2 configuration seeds (excluded_columns,
-- redacted_columns, reason_required_tables). Migration 006 seeds the same rows;
-- every INSERT here is ON CONFLICT DO NOTHING, so this file is idempotent and
-- safe whether or not 006 already ran.
--
-- Deliberately NOT attached (append-only logs; auditing an audit is infinite
-- regress): audit_log, audit_seals, data_access_log, export_log,
-- sessions_audit, attendance_punches (its insert IS the audit record; voids
-- are audited by the void-punch path), leave_ledger, comp_off_ledger,
-- approval_actions, asset_history, contract_events, e_sign_events,
-- communication_events, notifications, ai_*, job_runs, system_health,
-- attendance_recompute_queue, import_rows, secure.face_match_log.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Configuration seeds (§5.2) — idempotent re-assertion
-- -----------------------------------------------------------------------------

-- Global exclusions applied to every table (entity_table = '*') + per-table.
INSERT INTO audit.excluded_columns (entity_table, column_name, note) VALUES
  ('*', 'updated_at',               'stamped by trigger; noise'),
  ('*', 'updated_by',               'stamped by trigger; noise'),
  ('*', 'search_tsv',               'derived'),
  ('*', 'computed_at',              'derived'),
  ('*', 'last_recomputed_at',       'derived'),
  ('*', 'ledger_high_water_mark',   'derived'),
  ('*', 'profile_completeness_pct', 'derived'),
  ('*', 'view_count',               'counter'),
  ('*', 'open_count',               'counter'),
  ('public.attendance_days', 'computed_version', 'engine bookkeeping'),
  ('public.notifications',   'retry_count',      'delivery bookkeeping'),
  ('public.assets',          'qr_payload',       'derived')
ON CONFLICT DO NOTHING;

INSERT INTO audit.redacted_columns (entity_table, column_name, mode) VALUES
  ('public.employee_statutory',          'aadhaar_number',            'hash'),
  ('public.employee_statutory',          'pan',                       'mask_tail'),
  ('public.employee_statutory',          'uan',                       'mask_tail'),
  ('public.employee_bank_accounts',      'account_number',            'hash'),
  ('public.employee_identity_documents', 'document_number',           'mask_tail'),
  ('public.profiles',                    'phone',                     'mask_tail'),
  ('public.e_sign_signers',              'identity_check_value_hash', 'hash'),
  ('secure.kiosk_operator_secrets',      'pin_hash',                  'omit'),
  ('secure.face_templates',              'descriptor',                'omit'),
  ('secure.face_templates',              'descriptor_set',            'omit')
ON CONFLICT DO NOTHING;

INSERT INTO audit.reason_required_tables (entity_table) VALUES
  ('public.employees'),
  ('public.employee_salary_revisions'),
  ('public.employee_statutory'),
  ('public.employee_bank_accounts'),
  ('public.attendance_days'),
  ('public.attendance_locks'),
  ('public.attendance_policies'),
  ('public.statutory_settings'),
  ('public.payroll_runs'),
  ('public.user_roles'),
  ('public.leave_balances'),
  ('public.kiosk_devices'),
  ('public.settings'),
  ('public.holidays'),
  ('public.pay_periods'),
  ('public.leave_types'),
  ('public.documents')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Identity & access (004, 000550)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_profiles__audit ON public.profiles;
CREATE TRIGGER trg_profiles__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_user_roles__audit ON public.user_roles;
CREATE TRIGGER trg_user_roles__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_role_assignments__audit ON public.employee_role_assignments;
CREATE TRIGGER trg_employee_role_assignments__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_role_assignments
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_webauthn_credentials__audit ON public.webauthn_credentials;
CREATE TRIGGER trg_webauthn_credentials__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.webauthn_credentials
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 3. Kiosk (013)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_kiosk_devices__audit ON public.kiosk_devices;
CREATE TRIGGER trg_kiosk_devices__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_kiosk_operators__audit ON public.kiosk_operators;
CREATE TRIGGER trg_kiosk_operators__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.kiosk_operators
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 4. Org structure (007)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_companies__audit ON public.companies;
CREATE TRIGGER trg_companies__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_locations__audit ON public.locations;
CREATE TRIGGER trg_locations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_departments__audit ON public.departments;
CREATE TRIGGER trg_departments__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_sections__audit ON public.sections;
CREATE TRIGGER trg_sections__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.sections
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_designations__audit ON public.designations;
CREATE TRIGGER trg_designations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.designations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_grades__audit ON public.grades;
CREATE TRIGGER trg_grades__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.grades
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_cost_centres__audit ON public.cost_centres;
CREATE TRIGGER trg_cost_centres__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.cost_centres
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 5. Employees & satellites (008, 009, 010, 011)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_employees__audit ON public.employees;
CREATE TRIGGER trg_employees__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_addresses__audit ON public.employee_addresses;
CREATE TRIGGER trg_employee_addresses__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_addresses
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_contacts__audit ON public.employee_contacts;
CREATE TRIGGER trg_employee_contacts__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_contacts
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_dependents__audit ON public.employee_dependents;
CREATE TRIGGER trg_employee_dependents__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_dependents
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_qualifications__audit ON public.employee_qualifications;
CREATE TRIGGER trg_employee_qualifications__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_qualifications
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_identity_documents__audit ON public.employee_identity_documents;
CREATE TRIGGER trg_employee_identity_documents__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_identity_documents
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_statutory__audit ON public.employee_statutory;
CREATE TRIGGER trg_employee_statutory__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_statutory
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_bank_accounts__audit ON public.employee_bank_accounts;
CREATE TRIGGER trg_employee_bank_accounts__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_swipe_cards__audit ON public.employee_swipe_cards;
CREATE TRIGGER trg_employee_swipe_cards__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_swipe_cards
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_custom_field_defs__audit ON public.employee_custom_field_defs;
CREATE TRIGGER trg_employee_custom_field_defs__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_custom_field_values__audit ON public.employee_custom_field_values;
CREATE TRIGGER trg_employee_custom_field_values__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_skills__audit ON public.employee_skills;
CREATE TRIGGER trg_employee_skills__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_skills
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_hobbies__audit ON public.employee_hobbies;
CREATE TRIGGER trg_employee_hobbies__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_hobbies
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_change_requests__audit ON public.employee_change_requests;
CREATE TRIGGER trg_employee_change_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_change_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 6. Biometrics (012) — lifecycle is audited even though the data is invisible
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_face_enrolment_requests__audit ON public.face_enrolment_requests;
CREATE TRIGGER trg_face_enrolment_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.face_enrolment_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_face_templates__audit ON secure.face_templates;
CREATE TRIGGER trg_face_templates__audit
  AFTER INSERT OR UPDATE OR DELETE ON secure.face_templates
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_biometric_consents__audit ON secure.biometric_consents;
CREATE TRIGGER trg_biometric_consents__audit
  AFTER INSERT OR UPDATE OR DELETE ON secure.biometric_consents
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 7. Attendance (014, 015, 017)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_attendance_days__audit ON public.attendance_days;
CREATE TRIGGER trg_attendance_days__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_days
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_attendance_regularizations__audit ON public.attendance_regularizations;
CREATE TRIGGER trg_attendance_regularizations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_regularizations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_attendance_locks__audit ON public.attendance_locks;
CREATE TRIGGER trg_attendance_locks__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_locks
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_shifts__audit ON public.shifts;
CREATE TRIGGER trg_shifts__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_shift_assignments__audit ON public.shift_assignments;
CREATE TRIGGER trg_shift_assignments__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_rosters__audit ON public.rosters;
CREATE TRIGGER trg_rosters__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.rosters
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_roster_slots__audit ON public.roster_slots;
CREATE TRIGGER trg_roster_slots__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.roster_slots
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_weekly_off_rules__audit ON public.weekly_off_rules;
CREATE TRIGGER trg_weekly_off_rules__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.weekly_off_rules
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_holiday_calendars__audit ON public.holiday_calendars;
CREATE TRIGGER trg_holiday_calendars__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_holidays__audit ON public.holidays;
CREATE TRIGGER trg_holidays__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_attendance_policies__audit ON public.attendance_policies;
CREATE TRIGGER trg_attendance_policies__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_policies
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_policy_assignments__audit ON public.policy_assignments;
CREATE TRIGGER trg_policy_assignments__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.policy_assignments
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_pay_periods__audit ON public.pay_periods;
CREATE TRIGGER trg_pay_periods__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.pay_periods
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 8. Leave (019)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_leave_types__audit ON public.leave_types;
CREATE TRIGGER trg_leave_types__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_leave_balances__audit ON public.leave_balances;
CREATE TRIGGER trg_leave_balances__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.leave_balances
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_leave_requests__audit ON public.leave_requests;
CREATE TRIGGER trg_leave_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_leave_request_days__audit ON public.leave_request_days;
CREATE TRIGGER trg_leave_request_days__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.leave_request_days
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 9. Payroll (020, 021, 022)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_salary_components__audit ON public.salary_components;
CREATE TRIGGER trg_salary_components__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.salary_components
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_salary_structures__audit ON public.salary_structures;
CREATE TRIGGER trg_salary_structures__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.salary_structures
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_salary_structure_components__audit ON public.salary_structure_components;
CREATE TRIGGER trg_salary_structure_components__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.salary_structure_components
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_salary_revisions__audit ON public.employee_salary_revisions;
CREATE TRIGGER trg_employee_salary_revisions__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_salary_revisions
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_employee_salary_revision_lines__audit ON public.employee_salary_revision_lines;
CREATE TRIGGER trg_employee_salary_revision_lines__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_salary_revision_lines
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_payroll_runs__audit ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_payroll_run_employees__audit ON public.payroll_run_employees;
CREATE TRIGGER trg_payroll_run_employees__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_run_employees
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_payslips__audit ON public.payslips;
CREATE TRIGGER trg_payslips__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_statutory_settings__audit ON public.statutory_settings;
CREATE TRIGGER trg_statutory_settings__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.statutory_settings
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_form16_documents__audit ON public.form16_documents;
CREATE TRIGGER trg_form16_documents__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.form16_documents
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_bank_advice_batches__audit ON public.bank_advice_batches;
CREATE TRIGGER trg_bank_advice_batches__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.bank_advice_batches
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 10. Claims & bonus (024)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_reimbursement_claims__audit ON public.reimbursement_claims;
CREATE TRIGGER trg_reimbursement_claims__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.reimbursement_claims
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_claim_lines__audit ON public.claim_lines;
CREATE TRIGGER trg_claim_lines__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.claim_lines
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_bonus_incentives__audit ON public.bonus_incentives;
CREATE TRIGGER trg_bonus_incentives__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.bonus_incentives
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 11. Documents (025)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_document_types__audit ON public.document_types;
CREATE TRIGGER trg_document_types__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.document_types
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_documents__audit ON public.documents;
CREATE TRIGGER trg_documents__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_document_acknowledgements__audit ON public.document_acknowledgements;
CREATE TRIGGER trg_document_acknowledgements__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.document_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 12. E-sign & contracts (026)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_e_sign_requests__audit ON public.e_sign_requests;
CREATE TRIGGER trg_e_sign_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.e_sign_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_e_sign_signers__audit ON public.e_sign_signers;
CREATE TRIGGER trg_e_sign_signers__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.e_sign_signers
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_contract_templates__audit ON public.contract_templates;
CREATE TRIGGER trg_contract_templates__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.contract_templates
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_contracts__audit ON public.contracts;
CREATE TRIGGER trg_contracts__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_contract_clauses__audit ON public.contract_clauses;
CREATE TRIGGER trg_contract_clauses__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.contract_clauses
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 13. Communications (027)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_announcements__audit ON public.announcements;
CREATE TRIGGER trg_announcements__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_communications__audit ON public.communications;
CREATE TRIGGER trg_communications__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.communications
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_notification_templates__audit ON public.notification_templates;
CREATE TRIGGER trg_notification_templates__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_notification_preferences__audit ON public.notification_preferences;
CREATE TRIGGER trg_notification_preferences__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 14. Assets (028)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_asset_categories__audit ON public.asset_categories;
CREATE TRIGGER trg_asset_categories__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.asset_categories
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_assets__audit ON public.assets;
CREATE TRIGGER trg_assets__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_asset_allocations__audit ON public.asset_allocations;
CREATE TRIGGER trg_asset_allocations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.asset_allocations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 15. Workflow (029)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_request_types__audit ON public.request_types;
CREATE TRIGGER trg_request_types__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.request_types
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_approval_chains__audit ON public.approval_chains;
CREATE TRIGGER trg_approval_chains__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.approval_chains
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_approval_chain_levels__audit ON public.approval_chain_levels;
CREATE TRIGGER trg_approval_chain_levels__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.approval_chain_levels
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_approval_requests__audit ON public.approval_requests;
CREATE TRIGGER trg_approval_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_delegations__audit ON public.delegations;
CREATE TRIGGER trg_delegations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.delegations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 16. System (031)
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_settings__audit ON public.settings;
CREATE TRIGGER trg_settings__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_feature_flags__audit ON public.feature_flags;
CREATE TRIGGER trg_feature_flags__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_integrations__audit ON public.integrations;
CREATE TRIGGER trg_integrations__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_cron_jobs__audit ON public.cron_jobs;
CREATE TRIGGER trg_cron_jobs__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.cron_jobs
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

DROP TRIGGER IF EXISTS trg_import_batches__audit ON public.import_batches;
CREATE TRIGGER trg_import_batches__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

COMMIT;
