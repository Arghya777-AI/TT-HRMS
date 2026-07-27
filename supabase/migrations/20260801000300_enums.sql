-- =============================================================================
-- Migration 003 — enums
-- Source: docs/plan/04-data-model.md §3 (every CREATE TYPE, transcribed
--         verbatim from the domain sections); §1.7 (enum vs lookup policy);
--         docs/build/spec-migrations.md §2 row 003.
--
-- Every closed, product-logic-owned set in the model. Admin-configurable sets
-- (departments, leave types, document categories, shifts, ...) are lookup
-- tables, NOT enums — see §1.7.
--
-- Evolution rule (§1.7): ALTER TYPE ... ADD VALUE only, each in its own
-- migration file with no other statements. Values are never renamed/dropped.
--
-- CREATE TYPE has no IF NOT EXISTS; each is wrapped in a duplicate_object
-- guard so a partial re-run is idempotent-safe.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- §3.1 Identity & Access
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('employee', 'manager', 'admin', 'super_admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.3 Employee master
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.employment_type AS ENUM
    ('permanent','probation','contract','intern','consultant','casual','apprentice','retainer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.employment_status AS ENUM
    ('pre_joining','active','on_probation','confirmed','on_notice','suspended',
     'on_long_leave','absconding','exited','retired','rehired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.gender AS ENUM ('male','female','transgender','prefer_not_to_say');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.marital_status AS ENUM ('single','married','divorced','widowed','separated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.blood_group AS ENUM ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.punch_mode AS ENUM ('single_punch','multi_punch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_mode AS ENUM ('bank_transfer','cash','cheque','upi');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.id_document_kind AS ENUM
    ('aadhaar','pan','passport','visa','driving_licence','voter_id','ration_card','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.custom_field_type AS ENUM
    ('text','number','date','boolean','single_select','multi_select','employee_ref','file');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.lifecycle_event_type AS ENUM
    ('offer_accepted','joined','probation_started','confirmed','probation_extended',
     'promoted','transferred','department_changed','manager_changed','salary_revised',
     'suspended','reinstated','notice_started','resigned','terminated','absconded',
     'retired','contract_ended','rehired','deceased');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.5 Attendance
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.punch_source AS ENUM
    ('kiosk_face','kiosk_fingerprint','kiosk_card','kiosk_manual','web','mobile',
     'biometric_device','manual_admin','import','system_regularization');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.punch_direction AS ENUM ('in','out','break_start','break_end','undetermined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.attendance_status AS ENUM
    ('present','half_day','absent','weekly_off','holiday','on_leave','on_leave_half',
     'weekly_off_worked','holiday_worked','comp_off_availed','on_duty','work_from_home',
     'suspended','not_yet_joined','post_exit','pending');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.attendance_day_source AS ENUM
    ('computed','regularized','admin_override','imported','leave_applied',
     'holiday_calendar','roster_absence');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.regularization_status AS ENUM
    ('draft','pending','approved','rejected','cancelled','applied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.7 Leave
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.leave_request_status AS ENUM
    ('draft','pending','approved','rejected','cancelled','withdrawn',
     'cancellation_pending','partially_approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.leave_day_portion AS ENUM ('full_day','first_half','second_half');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.ledger_entry_type AS ENUM
    ('opening_balance','accrual','pro_rata_accrual','credit_adjustment',
     'carry_forward_in','carry_forward_out','encashment','lapse','availed',
     'availed_reversal','debit_adjustment','late_deduction','comp_off_credit',
     'comp_off_debit','comp_off_expiry','settlement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.accrual_frequency AS ENUM
    ('none','monthly','quarterly','half_yearly','annual','per_worked_days','on_confirmation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.8 Payroll
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.payroll_run_status AS ENUM
    ('draft','inputs_locked','computed','in_review','approved',
     'disbursement_pending','paid','closed','cancelled','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payslip_line_kind AS ENUM
    ('earning','deduction','employer_contribution','reimbursement',
     'informational','arrear','recovery');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.9 Documents
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.document_status AS ENUM
    ('draft','pending_review','approved','rejected','expired','superseded','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.10 Contracts & e-Sign
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.esign_status AS ENUM
    ('draft','sent','partially_signed','completed','declined','expired','cancelled','voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.signer_status AS ENUM
    ('pending','notified','viewed','identity_verified','signed','declined','delegated','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.11 Communications & Notifications
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.notification_channel AS ENUM
    ('in_app','email','sms','whatsapp','push','kiosk_display');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.notification_status AS ENUM
    ('queued','sending','sent','delivered','opened','clicked','failed',
     'bounced','suppressed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.12 Assets
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.asset_allocation_status AS ENUM
    ('requested','approved','allocated','acknowledged','return_requested','returned',
     'recalled','lost','damaged','written_off','transferred');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.13 Workflow & Approvals
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.approval_status AS ENUM
    ('draft','pending','in_progress','approved','rejected','cancelled','withdrawn',
     'expired','auto_approved','escalated','applied','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.approval_action AS ENUM
    ('submit','approve','reject','request_info','provide_info','delegate','reassign',
     'escalate','recall','cancel','comment','auto_approve','skip_level');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.14 Audit
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.audit_action AS ENUM
    ('insert','update','delete','soft_delete','restore','hard_delete','login','logout',
     'login_failed','read_sensitive','export','approve','reject','cancel','void',
     'override','recompute','lock','unlock','send','sign','enrol_biometric',
     'purge_biometric','grant_role','revoke_role','impersonate','config_change','job_run');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.actor_source AS ENUM
    ('web_employee','web_manager','web_admin','kiosk','edge_function','cron',
     'import','ai_agent','service_role','migration');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- §3.6 Shifts & calendars / §3.16 System
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.holiday_type AS ENUM
    ('national','state','festival','restricted','optional','company','venue_closure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.job_run_status AS ENUM
    ('running','succeeded','failed','skipped','timed_out','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- NOTE: §1.7 also lists `week_of_month` in its enum column; that is a doc
-- slip — week-of-month is the util.week_of_month(date) FUNCTION (002), and no
-- column in §3 uses such a type. Deliberately not created.

-- -----------------------------------------------------------------------------
-- §3.15 AI
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.ai_role AS ENUM ('system','user','assistant','tool');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.ai_feedback_verdict AS ENUM
    ('helpful','not_helpful','wrong_data','wrong_chart','offensive','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
