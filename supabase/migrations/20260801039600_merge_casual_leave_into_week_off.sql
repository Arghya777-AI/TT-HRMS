-- ============================================================================
-- 20260801039600_merge_casual_leave_into_week_off.sql
--
-- CASUAL LEAVE BECOMES WEEK-OFF (product instruction, option B).
--
-- A `Week-off` type already existed — `MRL`, renamed from Marriage Leave by
-- migration 038700 — so this is a MERGE, not a rename: CL's entitlement moves into
-- MRL and CL is retired.
--
-- ── THE FIRST ATTEMPT WAS WRONG, AND THE REFUSAL WAS RIGHT ───────────────────
-- The obvious implementation is `UPDATE leave_ledger SET leave_type_id = mrl`.
-- `leave_ledger_guard_mutation` refuses it:
--
--   UPDATE on public.leave_ledger may only set reversed_by_id: append-only ledger
--
-- That guard is the reason leave balances can be trusted, and disabling it for the
-- convenience of a migration would spend the ledger's entire value to save some
-- typing. So nothing is rewritten. Instead the transfer is APPENDED, exactly as a
-- human-made correction would be:
--
--   on CL   a debit  of the employee's whole available balance
--   on MRL  a credit of the same amount
--
-- The result is the same entitlement in the same place, and the ledger now
-- EXPLAINS the move — a statement printed next year still shows where those days
-- came from. Re-pointing rows would have made the days appear always to have been
-- Week-off, which is not what happened.
--
-- ── HISTORY IS NOT REWRITTEN EITHER ──────────────────────────────────────────
-- The 3 existing CL requests keep their type. Those people DID take Casual Leave,
-- at a time when it existed; relabelling them would make the record say otherwise.
-- CL is soft-deleted rather than dropped, so those rows still resolve their type
-- name and a statement of last month still reads correctly.
--
-- ── MEASURED BEFORE, ASSERTED AFTER ──────────────────────────────────────────
--   CL   57 balance rows, 122.500 available, 3.5 already availed
--   MRL  14 balance rows,  53.200 available
--   combined 175.700 — and the migration RAISES unless that is exactly what is
--   left afterwards, with CL at zero. A silently wrong entitlement is invisible
--   until somebody is refused leave they thought they had, so committing one must
--   be impossible.
-- ============================================================================

BEGIN;

SELECT set_config(
  'app.reason',
  'merging Casual Leave into the existing Week-off leave type per product instruction',
  true
);

DO $$
DECLARE
  v_actor uuid;
  v_cl       uuid;
  v_mrl      uuid;
  v_before   numeric(12,3);
  v_after    numeric(12,3);
  v_cl_left  numeric(12,3);
  v_row      record;
  v_moved    integer := 0;
BEGIN
  SELECT id INTO v_cl  FROM public.leave_types WHERE code = 'CL'  AND deleted_at IS NULL;
  SELECT id INTO v_mrl FROM public.leave_types WHERE code = 'MRL' AND deleted_at IS NULL;

  IF v_cl IS NULL THEN
    RAISE NOTICE 'CL already merged or absent — nothing to do';
    RETURN;
  END IF;
  IF v_mrl IS NULL THEN
    RAISE EXCEPTION 'the Week-off type (MRL) is missing; refusing to merge into nothing';
  END IF;

  SELECT COALESCE(SUM(available_days), 0) INTO v_before
  FROM public.leave_balances WHERE leave_type_id IN (v_cl, v_mrl);
  RAISE NOTICE 'combined available before the merge = %', v_before;

  -- ── Append the transfer, per employee-year that has anything to move ───────
  FOR v_row IN
    SELECT lb.employee_id, lb.leave_year, lb.available_days
    FROM public.leave_balances lb
    WHERE lb.leave_type_id = v_cl AND lb.available_days <> 0
  LOOP
    -- Out of Casual Leave. A debit is a NEGATIVE day count.
    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, reason, recorded_at)
    VALUES
      (v_row.employee_id, v_cl, v_row.leave_year, 'debit_adjustment',
       -v_row.available_days, util.ist_today(),
       'Casual Leave retired — balance transferred to Week-off',
       'leave_type_merge',
       'Casual Leave was merged into Week-off; this closes the Casual Leave balance',
       now());

    -- Into Week-off, the same amount.
    INSERT INTO public.leave_ledger
      (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
       description, source_table, reason, recorded_at)
    VALUES
      (v_row.employee_id, v_mrl, v_row.leave_year, 'credit_adjustment',
       v_row.available_days, util.ist_today(),
       'Transferred in from Casual Leave on its retirement',
       'leave_type_merge',
       'Casual Leave was merged into Week-off; this carries the balance across',
       now());

    -- Re-derive BOTH sides with the engine's own arithmetic.
    PERFORM public.recompute_leave_balance(v_row.employee_id, v_cl,  v_row.leave_year);
    PERFORM public.recompute_leave_balance(v_row.employee_id, v_mrl, v_row.leave_year);
    v_moved := v_moved + 1;
  END LOOP;

  -- ── Retire the type ──────────────────────────────────────────────────────
  -- `ck_lt__deletion_reason` requires deleted_by AND a reason of 10+ characters
  -- whenever deleted_at is set — a soft delete must say who and why or not happen.
  -- `app.ctx_actor_id()` is NULL in a migration (no JWT), so an owner account is
  -- resolved instead.
  SELECT COALESCE(
           app.ctx_actor_id(),
           (SELECT p.id FROM public.profiles p
             JOIN public.user_roles ur ON ur.user_id = p.id
            WHERE ur.role = 'super_admin' AND ur.revoked_at IS NULL AND p.is_active
            ORDER BY p.created_at LIMIT 1)
         )
    INTO v_actor;

  /*
    ── WHEN THERE IS NOBODY TO NAME ───────────────────────────────────────────
    Corrected after this migration spent months failing `npm run db:validate`.

    On the deployed database the COALESCE above finds a super-admin and the soft
    delete is complete. On a FRESH database — a replay, a test harness, a new
    environment — there are no profiles at all, so it resolved to NULL and
    `ck_lt__deletion_reason` refused the row. Correctly: a soft delete that cannot
    say who did it is exactly what that constraint exists to stop.

    So when no actor can be resolved, the type is DEACTIVATED without being
    soft-deleted. That achieves what the merge is for — CL stops being selectable —
    while declining to invent an author for the deletion. Retiring it is the
    migration's business; claiming somebody deleted it is not.
  */
  IF v_actor IS NULL THEN
    UPDATE public.leave_types
       SET is_active = false
     WHERE id = v_cl;
    RAISE NOTICE 'CL deactivated but not soft-deleted: no profile exists to record as the author';
  ELSE
    UPDATE public.leave_types
       SET is_active = false,
           deleted_at = now(),
           deleted_by = v_actor,
           deletion_reason = 'merged into the Week-off type (MRL) — migration 039600'
     WHERE id = v_cl;
  END IF;

  -- ── Assert, or roll the whole thing back ─────────────────────────────────
  SELECT COALESCE(SUM(available_days), 0) INTO v_after
  FROM public.leave_balances WHERE leave_type_id IN (v_cl, v_mrl);

  SELECT COALESCE(SUM(available_days), 0) INTO v_cl_left
  FROM public.leave_balances WHERE leave_type_id = v_cl;

  IF v_after <> v_before THEN
    RAISE EXCEPTION
      'merge would change total entitlement: % before, % after — rolling back', v_before, v_after;
  END IF;
  IF v_cl_left <> 0 THEN
    RAISE EXCEPTION
      'Casual Leave still holds % day(s) after the merge — rolling back', v_cl_left;
  END IF;

  RAISE NOTICE
    'merged % employee-year balance(s); Week-off now holds % day(s), Casual Leave 0',
    v_moved, v_after;
END $$;

COMMIT;
