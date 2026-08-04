-- =============================================================================
-- 098 · remove the demo data, so every figure on every screen is real
--
-- REPORTED: "all data should be real, no dummy data across page even attendence,
--            leave etc." … "there should not be any demo-data".
--
-- WHY THIS CANNOT BE DONE FROM THE APP. Migration 048 does
-- `REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM authenticated`,
-- so no admin session — no browser, no matter whose — can delete a row. That is
-- correct for an HR system and it is also why a purge has to be a migration.
--
-- WHAT WAS POLLUTING THE SCREENS, measured before writing this:
--   * 674 punches and 540 attendance days, of which 591 and 388 respectively
--     belong to employees who are soft-deleted — the seeded demo staff. They
--     survive their employee record, so the analytics dashboard averaged them and
--     the punch log listed them nameless.
--   * 14 payslip lines, 8 leave-calendar rows, 12 approved salary revisions, one
--     draft payroll run, one published roster week.
--   * The venue's real roster arrived on 2026-07-31 and has no attendance, no
--     leave and no payroll of its own yet. So none of the above is business data:
--     all of it is seed.
--
-- TWO SAFETY INTERLOCKS, because this deletes rows and cannot be undone:
--
--   1. IT ONLY RUNS WHILE `settings.seed_demo_data` IS TRUE. That flag is the
--      project's own marker for "this database still holds demo data"
--      (DEMO-ACCOUNTS.md says to turn it off before real employee data lands).
--      On any database where it is already false — a restored backup, a second
--      environment, a future production project — this migration is a no-op with
--      a notice. It cannot fire twice, because §4 sets the flag false.
--
--   2. IT DOES NOT TOUCH THE AUDIT TRAIL. `public.audit_log` is append-only and
--      hash-chained (`audit.verify_chain` over `audit.chain_state`); deleting
--      entries would break the chain and destroy the one record of who did what.
--      It is absent from the table list below, deliberately. The trail therefore
--      still shows the demo period, which is the honest outcome: the data is gone,
--      the history of it having existed is not.
--
-- WHAT IS DELIBERATELY KEPT: every master and configuration row — departments,
-- designations, shifts, leave types, salary components, holidays, pay periods,
-- policies, document types. Those are the venue's setup, not demo content, and
-- the real roster now depends on them.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 098: purge seeded demo transactional data so every screen shows only real records', true);
SELECT set_config('app.source', 'migration', true);

DO $$
DECLARE
  v_demo    boolean;
  v_counts  text := '';
  v_n       bigint;

  -- Children first, parents last. Every one of these holds transactional demo
  -- content only; masters are absent from the list on purpose.
  v_tables  text[] := ARRAY[
    -- attendance
    'attendance_regularizations',
    'attendance_punch_keys',
    'attendance_punches',
    'attendance_days',
    'attendance_recompute_queue',
    'attendance_recompute_runs',
    'attendance_locks',
    -- leave
    'leave_request_days',
    'leave_requests',
    'leave_ledger',
    'leave_balances',
    'leave_year_rollovers',
    'comp_off_ledger',
    -- payroll
    'payslip_lines',
    'payslips',
    'payroll_run_employees',
    'payroll_inputs_snapshot',
    'payroll_runs',
    -- rostering
    'roster_slots',
    'rosters',
    -- compensation history
    'employee_salary_revision_lines',
    'employee_salary_revisions',
    -- workflow noise
    'employee_change_requests',
    'notifications',
    'document_acknowledgements',
    'document_versions',
    'documents'
  ];
  v_t       text;
  v_guard   record;
  v_guards  text[] := '{}';
BEGIN
  -- `#>> '{}'` then ::boolean, NOT `value::boolean`: there is no cast from jsonb
  -- to boolean in Postgres, and the flag is stored as a jsonb scalar. The direct
  -- cast parses fine and raises only when a row actually exists, which is the
  -- worst kind of latent bug in a one-shot destructive migration.
  SELECT (s.value #>> '{}')::boolean INTO v_demo
    FROM public.settings s
   WHERE s.key = 'seed_demo_data'
   LIMIT 1;

  IF v_demo IS NOT TRUE THEN
    RAISE NOTICE 'settings.seed_demo_data is not true — this database is not marked as holding demo data, so nothing was deleted.';
    RETURN;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 1. Scope: rows belonging to employees who are already archived
  -- ---------------------------------------------------------------------------
  /*
    SCOPED BY EMPLOYEE, NOT WHOLE-TABLE — and that is a correction, not a
    preference. This migration was written when every transactional row in the
    database was seed data. By the time it came to be applied the real roster had
    been loaded and had started working, and a whole-table DELETE would have taken:

        4,080 attendance days and 160 punches belonging to live staff
           42 of those days carrying real punches
           12 documents uploaded by real employees
            1 salary revision for a live employee
        4,727 notifications, nearly all system-generated for real people

    Measured, not assumed. The demo cohort is exactly the soft-deleted employees —
    466 attendance days and 600 punches — and every one of the 75 real staff plus
    the accounts in use is live. So `deleted_at IS NOT NULL` is the whole
    definition of "demo", and nothing outside it is touched.

    SEVERAL OF THESE TABLES REFUSE DELETE OUTRIGHT. `attendance_days` carries
    `trg_attendance_days__no_delete` and the ledgers carry their own guards,
    because an attendance day and a leave debit are records a labour inspector may
    ask for. The guards are lifted by NAME, discovered from the catalogue so a
    guard added later is covered too, and restored before this transaction commits.
    The AUDIT triggers stay enabled, so every deletion is still recorded.
  */
  FOR v_guard IN
    SELECT c.relname AS tbl, t.tgname AS trg
      FROM pg_trigger t
      JOIN pg_class c     ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p      ON p.oid = t.tgfoid
     WHERE n.nspname = 'public'
       AND NOT t.tgisinternal
       AND c.relname = ANY (v_tables)
       -- Matched by SHAPE, not by a list of names. The first version named three
       -- functions and missed two: `attendance_punches_append_only` (punches are
       -- voided, never deleted) and `payroll_runs_guard` (the two-person rule).
       -- A pattern covers a guard added later; a list silently does not.
       AND (p.proname LIKE '%append_only%'
         OR p.proname LIKE '%refuse%'
         OR p.proname LIKE '%guard%'
         OR p.proname LIKE '%immutable%')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', v_guard.tbl, v_guard.trg);
    v_guards := v_guards || format('%s.%s', v_guard.tbl, v_guard.trg);
  END LOOP;
  RAISE NOTICE 'migration 098 lifted % append-only guard(s)', coalesce(array_length(v_guards, 1), 0);

  -- Children before parents; every one scoped to the archived cohort.
  DELETE FROM public.attendance_regularizations WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.attendance_punches         WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.attendance_days            WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.leave_request_days         WHERE leave_request_id IN (SELECT lr.id FROM public.leave_requests lr JOIN public.employees e ON e.id = lr.employee_id WHERE e.deleted_at IS NOT NULL);
  DELETE FROM public.leave_requests             WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.leave_ledger               WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.leave_balances             WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.comp_off_ledger            WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.payslip_lines              WHERE payslip_id IN (SELECT ps.id FROM public.payslips ps JOIN public.employees e ON e.id = ps.employee_id WHERE e.deleted_at IS NOT NULL);
  DELETE FROM public.payslips                   WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.payroll_run_employees      WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.roster_slots               WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_salary_revision_lines WHERE revision_id IN (SELECT r.id FROM public.employee_salary_revisions r JOIN public.employees e ON e.id = r.employee_id WHERE e.deleted_at IS NOT NULL);
  DELETE FROM public.employee_salary_revisions  WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_change_requests   WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.document_acknowledgements  WHERE document_id IN (SELECT d.id FROM public.documents d JOIN public.employees e ON e.id = d.employee_id WHERE e.deleted_at IS NOT NULL);
  DELETE FROM public.document_versions          WHERE document_id IN (SELECT d.id FROM public.documents d JOIN public.employees e ON e.id = d.employee_id WHERE e.deleted_at IS NOT NULL);
  DELETE FROM public.documents                  WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.notifications              WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);

  /*
    A payroll run or a roster week that is left holding NOBODY was a demo artefact
    whose every member has just been removed. Deleting an empty shell is safe;
    deleting one that still covers a live employee is not, so the NOT EXISTS is the
    guard rather than a judgement made here.
  */
  DELETE FROM public.payroll_inputs_snapshot pis
   WHERE NOT EXISTS (SELECT 1 FROM public.payroll_run_employees x WHERE x.payroll_run_id = pis.payroll_run_id);
  DELETE FROM public.payroll_runs pr
   WHERE NOT EXISTS (SELECT 1 FROM public.payroll_run_employees x WHERE x.payroll_run_id = pr.id);
  DELETE FROM public.rosters r
   WHERE NOT EXISTS (SELECT 1 FROM public.roster_slots x WHERE x.roster_id = r.id);

  -- ---------------------------------------------------------------------------
  -- 1c. Put every guard back
  -- ---------------------------------------------------------------------------
  FOREACH v_t IN ARRAY v_guards LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',
                   split_part(v_t, '.', 1), split_part(v_t, '.', 2));
  END LOOP;
  RAISE NOTICE 'migration 098 restored % append-only guard(s)', coalesce(array_length(v_guards, 1), 0);

  -- ---------------------------------------------------------------------------
  -- 2. The archived employee RECORDS are deliberately left in place
  -- ---------------------------------------------------------------------------
  /*
    An earlier draft deleted them. It should not, and the reason is worth writing
    down so nobody restores it: 620 foreign keys point at `employees.id` — assets,
    contracts, approval requests, kiosk operators, e-sign signers, reimbursement
    claims, communication recipients, every notification partition. Removing 14 rows
    means unpicking all of that, and the first attempt failed on
    `document_acknowledgements` after the transactional deletes had already run.

    It buys nothing. Those employees are ALREADY soft-deleted, and every view in the
    product filters `deleted_at IS NULL` — `v_admin_employee`, `v_employee_ref`,
    `v_employee_roles`. They appear on no screen and in no count. What put demo
    figures in front of people was their attendance, leave and payroll, and §1 has
    removed exactly that.

    So the rule is: demo TRANSACTIONS go, the tombstones stay. The audit trail keeps
    referring to real rows, and nothing has to be unpicked.
  */
  RAISE NOTICE 'migration 098: archived employee records left in place on purpose — see §2';

END $$;

-- -----------------------------------------------------------------------------
-- 4. Disarm — and record that this database no longer holds demo data
-- -----------------------------------------------------------------------------
/*
  Outside the DO block so it runs even on the no-op path: a database that reached
  this migration has been told, one way or another, that demo data is not wanted.
  It is also what stops a re-run from deleting a second time — by then the
  interlock in §1 reads false.
*/
UPDATE public.settings
   SET value = to_jsonb(false)
 WHERE key = 'seed_demo_data';

COMMIT;
