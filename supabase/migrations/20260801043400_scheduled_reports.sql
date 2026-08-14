-- =============================================================================
-- 20260801043400 — scheduled reports: what should be sent, to whom, and when
-- =============================================================================
--
-- REPORTED, on /admin/analytics and /admin/analytics/scheduled: the scheduled
-- reports tile shows a DASH rather than a zero, because `scheduled_reports` does
-- not exist in any of the 150 migrations. The screen lists the three missing
-- pieces by name — `scheduled_reports`, `scheduled_report_recipients` and a
-- `report-render` function — rather than offering an "Add schedule" form over
-- nothing.
--
-- This migration builds the first two. It does NOT build the third, and the rest
-- of this header is about why that distinction is being kept sharp.
--
-- ── WHAT THIS DOES AND DOES NOT MAKE TRUE ───────────────────────────────────
--
-- After this runs, the venue can RECORD that the muster should go to the general
-- manager every Monday at 07:00. Nothing will send it. Delivery needs a function
-- that renders a subject to a file and hands it to the dispatcher, and no such
-- function is deployed.
--
-- That is worth having anyway — a schedule nobody has written down is a schedule
-- that lives in one person's head — but it must never be dressed up as working
-- delivery. `last_dispatched_at` stays NULL until something actually sends, and
-- the screen reads that column rather than assuming: a row that has never been
-- dispatched says so, in the register, next to the schedule.
--
-- ── WHY NOT REUSE `cron_jobs` ───────────────────────────────────────────────
--
-- `cron_jobs` (003100) is the register of RECURRING JOBS — cron expression,
-- timezone, overlap policy, failure alerting — and a scheduled report is not a
-- job. One job (`report-dispatch`) will eventually run every schedule that is
-- due, the way `notification-dispatch` serves every notification. Modelling each
-- report as its own cron row would put business configuration into the operations
-- register, and an administrator adding a report would be editing the job
-- scheduler.
--
-- ── RECIPIENTS ARE A TABLE, NOT A COLUMN ────────────────────────────────────
--
-- A `text[]` of email addresses would be simpler and wrong. Recipients change as
-- people join and leave, and an address list frozen in a jsonb column keeps
-- mailing somebody eighteen months after they left — with payroll data attached.
-- A recipient row can point at an EMPLOYEE, which follows them, or at a bare
-- address for an auditor who has no login; exactly one of the two, enforced.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043400: scheduled_reports and scheduled_report_recipients, so a recurring report can be recorded with its recipients; delivery remains unbuilt and is not implied', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The schedule
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduled_reports (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                text NOT NULL,
  name                text NOT NULL,
  description         text,
  /*
    WHAT is being sent. A closed vocabulary, and every value names a relation that
    already exists and is already readable on a screen — because a schedule for a
    report nobody can render is the gap this migration is trying not to widen.
  */
  subject             text NOT NULL,
  format              text NOT NULL DEFAULT 'csv',
  /*
    Cron and a human sentence, the same pair `cron_jobs` carries. The sentence is
    stored rather than derived: '0 7 * * 1' is not something an administrator
    should have to read back, and a browser that renders cron into English is a
    second implementation of a thing the author already knew when they typed it.
  */
  schedule_cron       text NOT NULL,
  schedule_human      text NOT NULL,
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  /* Subject-specific narrowing — a department, a cost centre, a leave type. */
  filters             jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled          boolean NOT NULL DEFAULT true,
  /*
    NULL until something actually sends one. The screen reads this column to say
    "never dispatched" rather than letting an enabled schedule imply delivery.
  */
  last_dispatched_at  timestamptz,
  last_dispatch_note  text,
  next_run_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_schedrep__subject CHECK (subject IN (
    'attendance_muster',      -- v_attendance_day_enriched
    'attendance_exceptions',  -- the exception queue
    'leave_balances',         -- leave_balances
    'leave_taken',            -- leave_requests, decided
    'payroll_register',       -- payslips for a run
    'payroll_statutory',      -- payslip_lines, statutory heads
    'document_compliance',    -- the expiry/missing register
    'asset_custody',          -- v_asset_custody
    'approvals_pending',      -- v_approval_inbox
    'headcount')),           -- employees on roll
  CONSTRAINT ck_schedrep__format CHECK (format IN ('csv', 'xlsx', 'pdf')),
  /* A schedule with no cron expression cannot ever be due. */
  CONSTRAINT ck_schedrep__cron CHECK (length(btrim(schedule_cron)) > 0),
  CONSTRAINT ck_schedrep__human CHECK (length(btrim(schedule_human)) > 0),
  CONSTRAINT ck_schedrep__deletion CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_schedrep__company_code
  ON public.scheduled_reports (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedrep__due
  ON public.scheduled_reports (next_run_at) WHERE is_enabled AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_schedrep__stamp ON public.scheduled_reports;
CREATE TRIGGER trg_schedrep__stamp BEFORE INSERT ON public.scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_schedrep__touch ON public.scheduled_reports;
CREATE TRIGGER trg_schedrep__touch BEFORE UPDATE ON public.scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.scheduled_reports IS
  'A recurring report: what to send, in what format, on what cron. Recording one does NOT send it — no render-and-deliver function is deployed, and last_dispatched_at stays NULL until one is.';

-- -----------------------------------------------------------------------------
-- 2. Who receives it
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduled_report_recipients (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_report_id uuid NOT NULL
    REFERENCES public.scheduled_reports(id) ON DELETE CASCADE,
  /*
    EXACTLY ONE OF THESE. An employee recipient follows the person — their address
    changes, their access is revoked when they leave, and the report stops. A bare
    address is for somebody with no login (an auditor, the accountant), and it
    keeps working precisely because nothing revokes it, which is why it is the
    lesser choice and not the default.
  */
  employee_id         uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  email               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_schedrec__one_of CHECK (
    (employee_id IS NOT NULL AND email IS NULL) OR
    (employee_id IS NULL AND email IS NOT NULL)),
  CONSTRAINT ck_schedrec__email CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

/* One row per person per report — adding somebody twice sends it twice. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedrec__employee
  ON public.scheduled_report_recipients (scheduled_report_id, employee_id)
  WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedrec__email
  ON public.scheduled_report_recipients (scheduled_report_id, lower(btrim(email)))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_schedrec__report
  ON public.scheduled_report_recipients (scheduled_report_id);

DROP TRIGGER IF EXISTS trg_schedrec__stamp ON public.scheduled_report_recipients;
CREATE TRIGGER trg_schedrec__stamp BEFORE INSERT ON public.scheduled_report_recipients
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_schedrec__touch ON public.scheduled_report_recipients;
CREATE TRIGGER trg_schedrec__touch BEFORE UPDATE ON public.scheduled_report_recipients
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.scheduled_report_recipients IS
  'Who receives a scheduled report. An employee recipient follows the person and stops when they leave; a bare address does not, which is why exactly one of the two is permitted per row.';

-- -----------------------------------------------------------------------------
-- 3. RLS — administrators only, both tables
-- -----------------------------------------------------------------------------
--
-- A scheduled report carries payroll and attendance data to an inbox. Deciding
-- who receives that is an administrative act, and there is no employee-facing
-- half of this feature to write a self policy for.

ALTER TABLE public.scheduled_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_report_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedrep__admin_all ON public.scheduled_reports;
CREATE POLICY schedrep__admin_all ON public.scheduled_reports
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS schedrec__admin_all ON public.scheduled_report_recipients;
CREATE POLICY schedrec__admin_all ON public.scheduled_report_recipients
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 4. What is due — the query a dispatcher would run
-- -----------------------------------------------------------------------------
--
-- Written now, while the reasoning is fresh, so whoever builds the dispatcher
-- inherits the predicate rather than inventing a second one. It is also what the
-- screen reads to say "this one is overdue to go out".

CREATE OR REPLACE VIEW public.v_scheduled_reports_due
WITH (security_invoker = true) AS
SELECT sr.id,
       sr.company_id,
       sr.code,
       sr.name,
       sr.subject,
       sr.format,
       sr.schedule_human,
       sr.next_run_at,
       sr.last_dispatched_at,
       (SELECT count(*)::integer
          FROM public.scheduled_report_recipients r
         WHERE r.scheduled_report_id = sr.id)          AS recipient_count,
       /*
         Due, and never yet sent, are different states and both matter. A schedule
         that has never gone out is usually a schedule nobody wired up; one that is
         overdue is usually a dispatcher that stopped.
       */
       (sr.next_run_at IS NOT NULL AND sr.next_run_at <= now()) AS is_due,
       (sr.last_dispatched_at IS NULL)                          AS never_dispatched
  FROM public.scheduled_reports sr
 WHERE sr.deleted_at IS NULL
   AND sr.is_enabled;

COMMENT ON VIEW public.v_scheduled_reports_due IS
  'Enabled schedules with their recipient count, whether they are past due, and whether anything has ever dispatched them. security_invoker, so the admin policy decides visibility.';

GRANT SELECT ON public.v_scheduled_reports_due TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.scheduled_reports, public.scheduled_report_recipients TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.scheduled_reports, public.scheduled_report_recipients TO service_role;
  END IF;
END $$;

COMMIT;
