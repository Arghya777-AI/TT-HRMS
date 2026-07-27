-- =============================================================================
-- Migration 049 — deferred foreign keys (cross-order sweep)
-- Source: docs/plan/04-data-model.md §1.8 (FK policy); build-order note in
--         migration 008.
--
-- The migration order (spec-migrations §2) creates employees (008) before the
-- policy/shift masters (014) and satellites (009). FKs that point "forward"
-- are omitted at table-creation time and attached here, once every referenced
-- table exists. Every ALTER is guarded on (a) both relations existing and
-- (b) the constraint not already existing — so the file is idempotent and
-- stays correct even if an intermediate migration already declared the FK.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- (child table,               constraint name,                        FK column,                referenced table,                 on delete)
      ('public.employees',           'fk_employees__attendance_policy',      'attendance_policy_id',   'public.attendance_policies',     'SET NULL'),
      ('public.employees',           'fk_employees__weekly_off_rule',        'weekly_off_rule_id',     'public.weekly_off_rules',        'SET NULL'),
      ('public.employees',           'fk_employees__holiday_calendar',       'holiday_calendar_id',    'public.holiday_calendars',       'SET NULL'),
      ('public.employees',           'fk_employees__shift',                  'shift_id',               'public.shifts',                  'SET NULL'),
      ('public.employees',           'fk_employees__pay_period',             'pay_period_id',          'public.pay_periods',             'SET NULL'),
      ('public.employees',           'fk_employees__primary_bank_account',   'primary_bank_account_id','public.employee_bank_accounts',  'SET NULL'),
      -- secure-schema tables (012) reference kiosk_devices/operators (013)
      ('secure.kiosk_device_secrets','fk_kiosk_device_secrets__device',      'device_id',              'public.kiosk_devices',           'CASCADE'),
      ('secure.kiosk_operator_secrets','fk_kiosk_operator_secrets__operator','operator_id',            'public.kiosk_operators',         'CASCADE'),
      ('secure.face_match_log',      'fk_face_match_log__device',            'kiosk_device_id',        'public.kiosk_devices',           'SET NULL'),
      ('secure.face_match_log',      'fk_face_match_log__operator',          'operator_id',            'public.kiosk_operators',         'SET NULL'),
      ('secure.biometric_consents',  'fk_biometric_consents__device',        'device_id',              'public.kiosk_devices',           'SET NULL'),
      ('secure.face_templates',      'fk_face_templates__enrolled_device',   'enrolled_device_id',     'public.kiosk_devices',           'SET NULL'),
      ('secure.kiosk_nonces',        'fk_kiosk_nonces__device',              'device_id',              'public.kiosk_devices',           'CASCADE'),
      ('secure.api_keys',            'fk_api_keys__kiosk_device',            'kiosk_device_id',        'public.kiosk_devices',           'SET NULL'),
      -- shifts (014) reference salary_components (020)
      ('public.shifts',              'fk_shifts__night_allowance_component', 'night_allowance_component_id', 'public.salary_components', 'SET NULL'),
      -- designations (007) reference shifts (014)
      ('public.designations',       'fk_designations__default_shift',       'default_shift_id',       'public.shifts',                  'SET NULL'),
      -- attendance policies (014) reference leave_types (019)
      ('public.attendance_policies','fk_attendance_policies__late_ded_lt',  'late_deduction_leave_type_id', 'public.leave_types',       'SET NULL'),
      -- roster slots (015) reference attendance_days (017) and the event register
      ('public.roster_slots',        'fk_roster_slots__attendance_day',      'attendance_day_id',      'public.attendance_days',         'SET NULL'),
      ('public.roster_slots',        'fk_roster_slots__event',               'event_id',               'public.events',                  'SET NULL'),
      -- punches (016) reference approvals (029) and webauthn credentials
      ('public.attendance_punches',  'fk_attendance_punches__approval',      'approval_request_id',    'public.approval_requests',       'SET NULL'),
      ('public.attendance_punches',  'fk_attendance_punches__webauthn',      'webauthn_credential_id', 'public.webauthn_credentials',    'SET NULL'),
      -- lifecycle events (011) reference approvals (029) and documents (025)
      ('public.employee_lifecycle_events', 'fk_ele__approval',               'approval_request_id',    'public.approval_requests',       'SET NULL'),
      ('public.employee_lifecycle_events', 'fk_ele__document',               'document_id',            'public.documents',               'SET NULL'),
      ('public.employee_change_requests',  'fk_ecr__approval',               'approval_request_id',    'public.approval_requests',       'SET NULL'),
      ('public.employee_custom_field_values', 'fk_ecfv__document',           'value_document_id',      'public.documents',               'SET NULL'),
      -- qualifications (009) reference the documents vault (025)
      ('public.employee_qualifications','fk_employee_qualifications__document','document_id',          'public.documents',               'SET NULL'),
      ('public.employee_identity_documents','fk_eid__document',              'document_id',            'public.documents',               'SET NULL'),
      -- documents (025) reference the contracts/e-sign engine (026)
      ('public.document_types',       'fk_document_types__template',          'template_id',            'public.contract_templates',      'SET NULL'),
      ('public.documents',            'fk_documents__generated_from_template','generated_from_template_id','public.contract_templates',   'SET NULL'),
      ('public.documents',            'fk_documents__esign_request',          'esign_request_id',       'public.e_sign_requests',         'SET NULL'),
      -- contracts (026) reference approvals (029) and AI messages (030)
      ('public.contracts',            'fk_contracts__approval_request',       'approval_request_id',    'public.approval_requests',       'SET NULL'),
      ('public.contract_clauses',     'fk_contract_clauses__ai_message',      'ai_message_id',          'public.ai_messages',             'SET NULL'),
      -- asset allocations (028) reference approvals (029)
      ('public.asset_allocations',    'fk_asset_allocations__approval',       'approval_request_id',    'public.approval_requests',       'SET NULL'),
      -- attendance_days (017) references the leave domain (019) and payroll runs (022)
      ('public.attendance_days',     'fk_attendance_days__leave_type',       'leave_type_id',          'public.leave_types',             'SET NULL'),
      ('public.attendance_days',     'fk_attendance_days__leave_request',    'leave_request_id',       'public.leave_requests',          'SET NULL'),
      ('public.attendance_days',     'fk_attendance_days__comp_off_ledger',  'comp_off_ledger_id',     'public.comp_off_ledger',         'SET NULL'),
      ('public.attendance_days',     'fk_attendance_days__payroll_run',      'payroll_run_id',         'public.payroll_runs',            'SET NULL'),
      -- attendance_regularizations (017) reference documents (025) and approvals (029)
      ('public.attendance_regularizations', 'fk_ar__supporting_document',    'supporting_document_id', 'public.documents',               'SET NULL'),
      ('public.attendance_regularizations', 'fk_ar__approval',               'approval_request_id',    'public.approval_requests',       'SET NULL'),
      -- salary revisions (021) reference approvals (029) and documents (025)
      ('public.employee_salary_revisions', 'fk_esr__approval',               'approval_request_id',    'public.approval_requests',       'SET NULL'),
      ('public.employee_salary_revisions', 'fk_esr__letter_document',        'letter_document_id',     'public.documents',               'SET NULL'),
      -- payroll runs/payslips/form16/bank advices (022) reference attendance_locks (017) and documents (025)
      ('public.payroll_runs',          'fk_payroll_runs__attendance_lock',   'attendance_lock_id',     'public.attendance_locks',        'SET NULL'),
      ('public.payslips',              'fk_payslips__pdf_document',          'pdf_document_id',        'public.documents',               'SET NULL'),
      ('public.form16_documents',      'fk_f16__document',                   'document_id',            'public.documents',               'SET NULL'),
      ('public.bank_advice_batches',   'fk_bab__file_document',              'file_document_id',       'public.documents',               'SET NULL'),
      -- claims & bonuses (024) reference approvals (029) and documents (025)
      ('public.reimbursement_claims',  'fk_rc__approval',                    'approval_request_id',    'public.approval_requests',       'SET NULL'),
      ('public.claim_lines',           'fk_claim_lines__receipt_document',   'receipt_document_id',    'public.documents',               'SET NULL'),
      ('public.bonus_incentives',      'fk_bi__approval',                    'approval_request_id',    'public.approval_requests',       'SET NULL')
    ) AS t(child_table, cname, col, ref_table, on_delete)
  LOOP
    -- both relations must exist, the child column must exist, and the
    -- constraint must not already be present under this or any other name
    -- covering the same column.
    IF to_regclass(spec.child_table) IS NOT NULL
       AND to_regclass(spec.ref_table) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM pg_attribute
         WHERE attrelid = to_regclass(spec.child_table)
           AND attname = spec.col AND NOT attisdropped)
       AND NOT EXISTS (
         SELECT 1
         FROM pg_constraint c
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.conrelid = to_regclass(spec.child_table)
           AND c.contype = 'f'
           AND a.attname = spec.col)
    THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s (id) ON DELETE %s',
        spec.child_table, spec.cname, spec.col, spec.ref_table, spec.on_delete);
      RAISE NOTICE 'deferred FK added: %.% -> %', spec.child_table, spec.col, spec.ref_table;
    ELSE
      RAISE NOTICE 'deferred FK skipped (missing relation/column or already constrained): %.% -> %',
        spec.child_table, spec.col, spec.ref_table;
    END IF;
  END LOOP;
END $$;

COMMIT;
