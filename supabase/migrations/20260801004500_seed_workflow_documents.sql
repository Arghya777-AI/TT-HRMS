-- =============================================================================
-- Migration 045 — seed: document types (26), request types (18),
-- approval chains + levels (11 chains), notification templates
-- (26 event codes → 52 in_app/email rows + 6 sms rows).
-- Source: docs/plan/04-data-model.md §14.9–14.10, §3.9, §3.11, §3.13;
--         spec-migrations §6.12–6.13.
--
-- Notes:
--  * FACE_ENROLMENT maps to detail_table 'employee_change_requests' — the
--    request_types CHECK constraint (029, per §3.13) does not include
--    face_enrolment_requests as a detail table.
--  * Per-level conditions ("L2 hr_admin when days > 5") are not expressible
--    in approval_chain_levels; AC-LEAVE-STD seeds L2 as is_optional with the
--    condition documented, while day-range routing (>15 → AC-LEAVE-LONG,
--    claim amount routing) uses the chains' days_from/amount_from selectors.
--  * SL (Sick Leave) is wired to MEDICAL_CERT here, once document_types exist.
-- =============================================================================

BEGIN;

-- Several tables touched here are in audit.reason_required_tables (leave_types,
-- documents, ...), so audit.log_changes() demands a reason on UPDATE. Set it
-- once for the whole transaction; the audit rows this seed writes then carry a
-- meaningful provenance instead of failing the migration.
SELECT set_config('app.reason', 'seed 045: workflow, document types and notification templates', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Document types (§3.9 codes, §14.9 flags)
-- -----------------------------------------------------------------------------
INSERT INTO public.document_types
  (code, name, description, sort_order, category,
   is_required_for_onboarding, required_for_department_ids,
   requires_expiry, requires_acknowledgement, acknowledgement_deadline_days,
   requires_esign, is_sensitive, visible_to_employee, visible_to_manager)
SELECT v.code, v.name, v.descr, v.ord, v.category,
       v.onboarding, dept.ids,
       v.expiry, v.ack, v.ack_days,
       v.esign, v.sensitive, v.vis_emp, v.vis_mgr
FROM (VALUES
        ('AADHAAR',             'Aadhaar Card',            NULL,                                                   10, 'identity',   true,  NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('PAN',                 'PAN Card',                NULL,                                                   20, 'identity',   true,  NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('PASSPORT',            'Passport',                NULL,                                                   30, 'identity',   false, NULL,                      true,  false, NULL::integer, false, true,  true,  false),
        ('PHOTO',               'Photograph',              NULL,                                                   40, 'identity',   true,  NULL,                      false, false, NULL::integer, false, false, true,  false),
        ('SIGNATURE',           'Specimen Signature',      NULL,                                                   50, 'identity',   false, NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('OFFER_LETTER',        'Offer Letter',            NULL,                                                   60, 'employment', false, NULL,                      false, false, NULL::integer, true,  false, true,  false),
        ('APPOINTMENT_LETTER',  'Appointment Letter',      NULL,                                                   70, 'employment', false, NULL,                      false, false, NULL::integer, true,  false, true,  false),
        ('CONTRACT',            'Employment Contract',     NULL,                                                   80, 'employment', false, NULL,                      false, false, NULL::integer, true,  false, true,  false),
        ('RESUME',              'Resume',                  NULL,                                                   90, 'employment', false, NULL,                      false, false, NULL::integer, false, false, true,  true),
        ('EDU_CERT',            'Education Certificate',   NULL,                                                  100, 'education',  true,  NULL,                      false, false, NULL::integer, false, false, true,  false),
        ('EXP_LETTER',          'Experience Letter',       NULL,                                                  110, 'employment', false, NULL,                      false, false, NULL::integer, false, false, true,  false),
        ('RELIEVING_LETTER',    'Relieving Letter',        NULL,                                                  120, 'employment', false, NULL,                      false, false, NULL::integer, false, false, true,  false),
        ('PAYSLIP',             'Payslip',                 NULL,                                                  130, 'payroll',    false, NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('FORM16',              'Form 16',                 NULL,                                                  140, 'payroll',    false, NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('BANK_PROOF',          'Bank Proof',              NULL,                                                  150, 'payroll',    true,  NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('CANCELLED_CHEQUE',    'Cancelled Cheque',        NULL,                                                  160, 'payroll',    false, NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('POLICY',              'Company Policy',          'Requires acknowledgement within 7 days.',             170, 'policy',     false, NULL,                      false, true,  7,             false, false, true,  true),
        ('SOP',                 'Standard Operating Procedure', 'Requires acknowledgement within 7 days.',        180, 'policy',     false, NULL,                      false, true,  7,             false, false, true,  true),
        ('MEDICAL_CERT',        'Medical Certificate',     'Food-handler fitness: Kitchen and Banquet, annual renewal.', 190, 'medical', false, ARRAY['KITCH','BANQ'], true,  false, NULL::integer, false, true,  true,  false),
        ('FSSAI_CERT',          'FSSAI Certificate',       'Required for Kitchen staff.',                         200, 'compliance', false, ARRAY['KITCH'],            true,  false, NULL::integer, false, false, true,  false),
        ('FIRE_SAFETY_CERT',    'Fire Safety Certificate', NULL,                                                  210, 'compliance', false, NULL,                      true,  false, NULL::integer, false, false, true,  false),
        ('POLICE_VERIFICATION', 'Police Verification',     'Required for Security, Transport and Housekeeping.',  220, 'compliance', false, ARRAY['SEC','TRAN','HK'],  false, false, NULL::integer, false, true,  false, false),
        ('NDA',                 'Non-Disclosure Agreement', NULL,                                                 230, 'employment', false, NULL,                      false, false, NULL::integer, true,  false, true,  false),
        ('INCREMENT_LETTER',    'Increment Letter',        NULL,                                                  240, 'employment', false, NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('WARNING_LETTER',      'Warning Letter',          NULL,                                                  250, 'employment', false, NULL,                      false, false, NULL::integer, false, true,  true,  false),
        ('EXIT_CLEARANCE',      'Exit Clearance',          NULL,                                                  260, 'exit',       false, NULL,                      false, false, NULL::integer, false, false, true,  false)
     ) AS v(code, name, descr, ord, category, onboarding, dept_codes, expiry,
            ack, ack_days, esign, sensitive, vis_emp, vis_mgr)
LEFT JOIN LATERAL (
  SELECT array_agg(d.id) AS ids
  FROM public.departments d
  JOIN public.companies c ON c.id = d.company_id AND c.code = 'TT' AND c.deleted_at IS NULL
  WHERE d.code = ANY (v.dept_codes) AND d.deleted_at IS NULL
) AS dept ON v.dept_codes IS NOT NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

-- Sick Leave: medical certificate required beyond 2 days (§14.7).
UPDATE public.leave_types lt
SET document_type_id = dt.id
FROM public.document_types dt
WHERE lt.code = 'SL' AND lt.deleted_at IS NULL
  AND dt.code = 'MEDICAL_CERT' AND dt.deleted_at IS NULL
  AND lt.document_type_id IS DISTINCT FROM dt.id;

-- -----------------------------------------------------------------------------
-- 2. Request types (§3.13 codes, §14.9 SLAs).
--    auto_approve_after_hours stays NULL for all — silence is not consent.
-- -----------------------------------------------------------------------------
INSERT INTO public.request_types
  (company_id, code, name, description, sort_order, detail_table, sla_hours,
   escalation_hours, allows_withdrawal, requires_attachment, icon)
SELECT c.id, v.code, v.name, v.descr, v.ord, v.detail_table, v.sla,
       v.esc, v.withdraw, v.attach, v.icon
FROM public.companies c
CROSS JOIN
     (VALUES
        ('WEB_LOGIN',          'Web Punch Request',        'Request a web login/logout punch.',                 10, 'web_punch_requests',          48, NULL::integer, true,  false, 'globe'),
        ('LEAVE',              'Leave',                    'Apply for leave.',                                  20, 'leave_requests',              24, 48,            true,  false, 'calendar'),
        ('ATT_REGULARIZATION', 'Attendance Regularization','Fix a missing or wrong punch.',                     30, 'attendance_regularizations',  48, 72,            true,  false, 'clock'),
        ('COMP_OFF',           'Compensatory Off',         'Claim comp-off for extra or holiday work.',         40, 'comp_off_ledger',             48, 72,            true,  false, 'rotate-ccw'),
        ('IT_DECLARATION',     'IT Declaration',           'Submit income-tax regime and investment declaration.', 50, 'income_tax_declarations',  48, NULL::integer, true,  false, 'file-text'),
        ('PAYSLIP_REQUEST',    'Payslip Request',          'Request a payslip or salary certificate copy.',     60, 'document_requests',           48, NULL::integer, true,  false, 'receipt'),
        ('RESIGNATION',        'Resignation',              'Submit your resignation.',                          70, 'resignations',                72, 96,            true,  false, 'log-out'),
        ('TRAVEL_REQUISITION', 'Travel Requisition',       'Request official travel.',                          80, 'travel_requisitions',         48, 72,            true,  false, 'plane'),
        ('LOCAL_CLAIM',        'Local Claim',              'Claim local conveyance/expense reimbursement.',     90, 'reimbursement_claims',        72, 96,            true,  true,  'wallet'),
        ('PROFILE_CHANGE',     'Profile Change',           'Request a change to your profile details.',        100, 'employee_change_requests',    72, NULL::integer, true,  false, 'user'),
        ('BANK_CHANGE',        'Bank Account Change',      'Change your salary bank account.',                 110, 'employee_change_requests',    24, 48,            true,  true,  'landmark'),
        ('SHIFT_SWAP',         'Shift Swap',               'Swap a rostered shift with a colleague.',          120, 'shift_swaps',                 12, 24,            true,  false, 'repeat'),
        ('OT_PREAPPROVAL',     'Overtime Pre-approval',    'Get overtime approved before working it.',         130, 'overtime_preapprovals',        6, 12,            true,  false, 'timer'),
        ('ASSET_REQUEST',      'Asset Request',            'Request an asset allocation.',                     140, 'asset_allocations',           48, NULL::integer, true,  false, 'package'),
        ('DOCUMENT_REQUEST',   'Document Request',         'Request an HR document or letter.',                150, 'document_requests',           48, NULL::integer, true,  false, 'folder'),
        ('ADVANCE_REQUEST',    'Salary Advance',           'Request a salary advance.',                        160, 'advance_requests',            48, NULL::integer, true,  false, 'banknote'),
        ('SALARY_REVISION',    'Salary Revision',          'Propose a salary revision.',                       170, 'employee_salary_revisions',  120, 168,           true,  false, 'trending-up'),
        ('FACE_ENROLMENT',     'Face Enrolment',           'Request biometric face enrolment or re-enrolment.', 180, 'employee_change_requests',   24, 48,            true,  false, 'scan-face')
     ) AS v(code, name, descr, ord, detail_table, sla, esc, withdraw, attach, icon)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Approval chains (§14.9) + levels.
-- -----------------------------------------------------------------------------
INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id, v.code, v.name, v.descr, v.ord,
       v.amt_from, v.amt_to, v.d_from, v.d_to, v.prio, v.dflt
FROM public.companies c
JOIN (VALUES
        ('AC-LEAVE-STD',   'LEAVE',              'Leave — standard',
         'L1 reporting manager; L2 HR admin engages when days > 5 (L2 seeded optional).',
         10, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-LEAVE-LONG',  'LEAVE',              'Leave — long (> 15 days)',
         'Reporting manager → department head → HR admin.',
         20, NULL::numeric, NULL::numeric, 15.5::numeric, NULL::numeric, 50::smallint,  false),
        ('AC-REG-STD',     'ATT_REGULARIZATION', 'Regularization — standard',
         NULL,
         30, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-CLAIM-SMALL', 'LOCAL_CLAIM',        'Claim ≤ ₹10,000',
         NULL,
         40, NULL::numeric, 10000::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-CLAIM-LARGE', 'LOCAL_CLAIM',        'Claim > ₹10,000',
         'Reporting manager → finance → super admin.',
         50, 10000.01::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 50::smallint, false),
        ('AC-BANK-CHANGE', 'BANK_CHANGE',        'Bank account change',
         'HR admin → finance.',
         60, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-SALARY',      'SALARY_REVISION',    'Salary revision',
         'Department head → HR admin → super admin.',
         70, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-OT',          'OT_PREAPPROVAL',     'Overtime pre-approval',
         NULL,
         80, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-SHIFT-SWAP',  'SHIFT_SWAP',         'Shift swap',
         'skip_if_same_as_previous avoids self-approval when the requester is the manager.',
         90, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-PROFILE',     'PROFILE_CHANGE',     'Profile change',
         NULL,
        100, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true),
        ('AC-FACE-ENROL',  'FACE_ENROLMENT',     'Face enrolment',
         NULL,
        110, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 100::smallint, true)
     ) AS v(code, rt_code, name, descr, ord, amt_from, amt_to, d_from, d_to, prio, dflt) ON true
JOIN public.request_types rt
  ON rt.code = v.rt_code AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, v.lvl, v.kind, v.optional, true
FROM public.approval_chains ac
JOIN (VALUES
        ('AC-LEAVE-STD',   1, 'reporting_manager', false),
        ('AC-LEAVE-STD',   2, 'hr_admin',          true),   -- engaged when days > 5
        ('AC-LEAVE-LONG',  1, 'reporting_manager', false),
        ('AC-LEAVE-LONG',  2, 'department_head',   false),
        ('AC-LEAVE-LONG',  3, 'hr_admin',          false),
        ('AC-REG-STD',     1, 'reporting_manager', false),
        ('AC-CLAIM-SMALL', 1, 'reporting_manager', false),
        ('AC-CLAIM-LARGE', 1, 'reporting_manager', false),
        ('AC-CLAIM-LARGE', 2, 'finance',           false),
        ('AC-CLAIM-LARGE', 3, 'super_admin',       false),
        ('AC-BANK-CHANGE', 1, 'hr_admin',          false),
        ('AC-BANK-CHANGE', 2, 'finance',           false),
        ('AC-SALARY',      1, 'department_head',   false),
        ('AC-SALARY',      2, 'hr_admin',          false),
        ('AC-SALARY',      3, 'super_admin',       false),
        ('AC-OT',          1, 'reporting_manager', false),
        ('AC-SHIFT-SWAP',  1, 'reporting_manager', false),
        ('AC-PROFILE',     1, 'hr_admin',          false),
        ('AC-FACE-ENROL',  1, 'hr_admin',          false)
     ) AS v(chain_code, lvl, kind, optional)
  ON v.chain_code = ac.code
WHERE ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- Wire the default chain onto each request type that has one.
UPDATE public.request_types rt
SET default_approval_chain_id = ac.id
FROM public.approval_chains ac
WHERE ac.request_type_id = rt.id
  AND ac.is_default AND ac.deleted_at IS NULL
  AND rt.deleted_at IS NULL
  AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

-- -----------------------------------------------------------------------------
-- 4. Notification templates (§14.10): one in_app + one email row per event
--    code (26 × 2 = 52), plus sms rows with DLT placeholders for the six
--    shop-floor codes. Copy follows the Tamarind Tree voice
--    (07-design-system.md §Copy); dates/numbers formatted by the callers'
--    shared formatters before substitution.
-- -----------------------------------------------------------------------------
WITH tt AS (
  SELECT id AS company_id FROM public.companies
  WHERE code = 'TT' AND deleted_at IS NULL
),
copy AS (
  SELECT * FROM (VALUES
    ('LEAVE_APPLIED',           'Leave application submitted',
     '{{employee_name}} applied for {{days}} day(s) of {{leave_type_name}} ({{from_date}} to {{to_date}}).',
     true),
    ('LEAVE_DECIDED',           'Your leave application was {{decision}}',
     'Your {{leave_type_name}} request for {{from_date}} to {{to_date}} was {{decision}} by {{approver_name}}. {{comment}}',
     true),
    ('REGULARIZATION_APPLIED',  'Regularization request submitted',
     '{{employee_name}} requested attendance regularization for {{date}}: {{reason}}.',
     true),
    ('REGULARIZATION_DECIDED',  'Your regularization was {{decision}}',
     'Your attendance regularization for {{date}} was {{decision}} by {{approver_name}}.',
     true),
    ('PUNCH_MISSING_OUT',       'Missing out-punch',
     'No out-punch was recorded for {{date}}. Please regularize within {{window_days}} days.',
     true),
    ('NO_SHOW_ALERT',           'No-show alert',
     '{{employee_name}} has not punched in for the {{shift_label}} shift on {{date}}.',
     true),
    ('PAYSLIP_READY',           'Your payslip is ready',
     'Your payslip for {{period_name}} is ready to view in the app.',
     true),
    ('SALARY_CREDITED',         'Salary credited',
     'Your salary for {{period_name}} has been credited to your bank account ending {{account_tail}}.',
     true),
    ('PROBATION_DUE',           'Probation review due',
     'The probation review for {{employee_name}} is due on {{due_date}}.',
     true),
    ('CONTRACT_EXPIRING',       'Contract expiring',
     'Contract {{contract_number}} for {{employee_name}} expires on {{expiry_date}}.',
     true),
    ('DOCUMENT_EXPIRING',       'Document expiring',
     '{{document_name}} expires on {{expiry_date}}. Please upload a renewal.',
     true),
    ('LICENCE_EXPIRING',        'Licence expiring',
     '{{licence_name}} expires on {{expiry_date}}. Please arrange the renewal.',
     true),
    ('COMP_OFF_EXPIRING',       'Comp-off expiring',
     '{{days}} compensatory off day(s) will expire on {{expiry_date}}. Plan your time off.',
     true),
    ('LEAVE_BALANCE_LAPSING',   'Leave balance lapsing',
     '{{days}} day(s) of {{leave_type_name}} will lapse on {{lapse_date}}.',
     true),
    ('BIRTHDAY',                'Happy birthday!',
     'Happy birthday, {{first_name}}! Warm wishes from all of us at The Tamarind Tree.',
     false),
    ('WORK_ANNIVERSARY',        'Work anniversary',
     'Congratulations, {{first_name}} — {{years}} year(s) at The Tamarind Tree today. Thank you for everything you do.',
     false),
    ('ROSTER_PUBLISHED',        'Roster published',
     'Your roster for the week of {{week_start}} is published. Check your shifts in the app.',
     true),
    ('SHIFT_CHANGED',           'Shift changed',
     'Your shift on {{date}} has changed to {{shift_label}}.',
     true),
    ('APPROVAL_PENDING',        'Approval waiting',
     '{{request_title}} from {{requester_name}} is waiting for your approval. Due by {{sla_due}}.',
     true),
    ('APPROVAL_SLA_BREACH',     'Approval overdue',
     '{{request_title}} has been waiting {{hours_overdue}} hour(s) past its SLA. Please act or delegate.',
     true),
    ('POLICY_ACK_DUE',          'Policy acknowledgement due',
     'Please read and acknowledge "{{document_name}}" by {{deadline}}.',
     true),
    ('ASSET_RETURN_DUE',        'Asset return due',
     '{{asset_name}} ({{asset_tag}}) is due for return on {{due_date}}.',
     true),
    ('KIOSK_OFFLINE',           'Kiosk offline',
     'Kiosk {{device_code}} has been offline since {{since}}. Attendance punches may be queuing.',
     true),
    ('FACE_ENROLMENT_REQUIRED', 'Face enrolment required',
     'Your face enrolment is pending. Please visit the HR desk to complete it.',
     true),
    ('PASSWORD_CHANGED',        'Password changed',
     'Your password was changed on {{time}}. If this was not you, contact HR immediately.',
     true),
    ('NEW_DEVICE_LOGIN',        'New sign-in',
     'New sign-in to your account from {{device_info}} at {{time}}. If this was not you, contact HR immediately.',
     true)
  ) AS t(code, title, body, transactional)
)
INSERT INTO public.notification_templates
  (company_id, code, name, sort_order, channel, subject_template,
   body_template, locale, is_transactional, is_system)
SELECT tt.company_id, copy.code, copy.title, 100,
       ch.channel::public.notification_channel,
       copy.title,
       CASE ch.channel
         WHEN 'in_app' THEN copy.body
         ELSE 'Hi {{first_name}},' || E'\n\n' || copy.body || E'\n\n'
              || 'Warm regards,' || E'\n' || 'The Tamarind Tree HR'
       END,
       'en-IN', copy.transactional, true
FROM tt, copy
CROSS JOIN (VALUES ('in_app'), ('email')) AS ch(channel)
ON CONFLICT (company_id, code, channel) WHERE (deleted_at IS NULL) DO NOTHING;

-- SMS templates (DLT placeholders — register with TRAI before enabling msg91).
INSERT INTO public.notification_templates
  (company_id, code, name, sort_order, channel, body_template, sms_template,
   dlt_template_id, locale, is_transactional, is_system)
SELECT c.id, v.code, v.name, 100, 'sms', v.sms, v.sms,
       'DLT-PENDING-' || v.code, 'en-IN', true, true
FROM public.companies c
CROSS JOIN (VALUES
        ('NO_SHOW_ALERT',
         'No-show alert (SMS)',
         '{{employee_name}} has not punched in for the {{shift_label}} shift on {{date}}. - Tamarind Tree'),
        ('ROSTER_PUBLISHED',
         'Roster published (SMS)',
         'Your Tamarind Tree roster for week of {{week_start}} is published. Check the app for shifts.'),
        ('SHIFT_CHANGED',
         'Shift changed (SMS)',
         'Your Tamarind Tree shift on {{date}} is now {{shift_label}}. See the app for details.'),
        ('SALARY_CREDITED',
         'Salary credited (SMS)',
         'Your Tamarind Tree salary for {{period_name}} is credited to a/c ending {{account_tail}}.'),
        ('PUNCH_MISSING_OUT',
         'Missing out-punch (SMS)',
         'No out-punch recorded for {{date}}. Please regularize in the Tamarind Tree app.'),
        ('LEAVE_DECIDED',
         'Leave decided (SMS)',
         'Your {{leave_type_name}} leave for {{from_date}} to {{to_date}} is {{decision}}. - Tamarind Tree')
     ) AS v(code, name, sms)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code, channel) WHERE (deleted_at IS NULL) DO NOTHING;

COMMIT;
