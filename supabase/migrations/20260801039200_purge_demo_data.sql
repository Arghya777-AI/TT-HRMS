-- =============================================================================
-- 094 · remove the demo data, so every figure on every screen is real
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

SELECT set_config('app.reason', 'migration 094: purge seeded demo transactional data so every screen shows only real records', true);
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
  -- 1. Lift the append-only guards, but only on the tables being purged
  -- ---------------------------------------------------------------------------
  /*
    SEVERAL OF THESE TABLES REFUSE DELETE OUTRIGHT, and that is not an oversight
    to work around casually: `attendance_days` carries
    `trg_attendance_days__no_delete`, the ledgers carry their own guards, and they
    exist because an attendance day and a leave debit are records a labour
    inspector may ask for. A DELETE raises 0A000, 'append-only table'.

    So the guards are disabled by NAME, discovered from the catalogue rather than
    hard-coded — a guard added later is then covered too — and re-enabled in §1c
    before this transaction commits. Two properties make that safe:

      * only triggers whose function is one of the three refusal guards are
        touched. The AUDIT triggers stay enabled, so every row this migration
        deletes is still recorded in `public.audit_log` with a reason. A purge
        that erased its own evidence would be a worse bug than the demo data.
      * it is one transaction. If anything below fails, the disable is rolled back
        with it, and no table is left permanently unguarded.
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
       AND p.proname IN ('refuse_mutation', 'refuse_mutation_except_void',
                         'leave_ledger_guard_mutation')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', v_guard.tbl, v_guard.trg);
    v_guards := v_guards || format('%s.%s', v_guard.tbl, v_guard.trg);
  END LOOP;
  RAISE NOTICE 'migration 094 lifted % append-only guard(s): %',
    coalesce(array_length(v_guards, 1), 0), coalesce(array_to_string(v_guards, ', '), '(none)');

  -- ---------------------------------------------------------------------------
  -- 1b. The transactional tables
  -- ---------------------------------------------------------------------------
  FOREACH v_t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      CONTINUE;                              -- table not in this build
    END IF;
    EXECUTE format('DELETE FROM public.%I', v_t);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_counts := v_counts || format('%s=%s ', v_t, v_n);
    END IF;
  END LOOP;

  RAISE NOTICE 'migration 094 deleted: %', COALESCE(NULLIF(v_counts, ''), '(nothing)');

  -- ---------------------------------------------------------------------------
  -- 1c. Put every guard back
  -- ---------------------------------------------------------------------------
  FOREACH v_t IN ARRAY v_guards LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',
                   split_part(v_t, '.', 1), split_part(v_t, '.', 2));
  END LOOP;
  RAISE NOTICE 'migration 094 restored % append-only guard(s)', coalesce(array_length(v_guards, 1), 0);

  -- ---------------------------------------------------------------------------
  -- 2. The demo employees themselves
  -- ---------------------------------------------------------------------------
  /*
    ONLY the soft-deleted ones. Everybody archived at this point is a seeded demo
    person; every real employee — the 75 from the joining sheet, plus the accounts
    still in use — is live and is therefore untouched. Naming codes explicitly
    would be more fragile, not safer: `deleted_at IS NOT NULL` is the fact.

    Their satellite rows go first. `employee_id` is ON DELETE RESTRICT on several
    of these, so the order matters and a missed table shows up as a failed
    migration rather than a silent partial purge.
  */
  DELETE FROM public.employee_statutory        WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_bank_accounts    WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_addresses        WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_contacts         WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_dependents       WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_qualifications   WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_skills           WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_hobbies          WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_identity_documents WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_custom_field_values WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_lifecycle_events WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_swipe_cards      WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  DELETE FROM public.employee_onboarding       WHERE employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);

  -- A reporting line into a demo employee would block the delete.
  UPDATE public.employees SET reporting_manager_id = NULL
   WHERE reporting_manager_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  UPDATE public.employees SET dotted_line_manager_id = NULL
   WHERE dotted_line_manager_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);
  UPDATE public.departments SET head_employee_id = NULL
   WHERE head_employee_id IN (SELECT id FROM public.employees WHERE deleted_at IS NOT NULL);

  DELETE FROM public.employees WHERE deleted_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'migration 094 removed % archived demo employee record(s)', v_n;

  -- ---------------------------------------------------------------------------
  -- 3. Their logins
  -- ---------------------------------------------------------------------------
  /*
    A profile with no employee record and no role beyond `employee` is a demo
    login with nothing left to sign in to. Deleting the auth.users row cascades
    the profile.

    THE ACCOUNTS STILL IN USE ARE SAFE and it is worth saying why rather than
    trusting the predicate: each of them still has a live employee record, so
    `NOT EXISTS (… employees …)` excludes them — including the HR admin login,
    whose employee row is TT0002.
  */
  DELETE FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.profile_id = u.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles r
        WHERE r.user_id = u.id AND r.revoked_at IS NULL AND r.role <> 'employee'
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'migration 094 removed % orphaned demo login(s)', v_n;
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
