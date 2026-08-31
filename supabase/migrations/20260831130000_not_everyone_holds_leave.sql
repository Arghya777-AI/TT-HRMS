-- =============================================================================
-- 20260831130000 — some people are not tracked for leave
-- =============================================================================
--
-- ASKED FOR, of the leave balances screen:
--
--   "hide it Preethi Machani · TT0019 / Arghya Ghosh · TT0013 /
--    Suraj Kumar · TT0002 / Vinod Maurya · TT0017"
--
-- Trisha K (TT0022) stays. She had no leave data either, and appearing with zeros
-- is right for her: she is staff whose leave will be tracked once something is
-- granted. The other four are the people who run the system.
--
-- ── WHY A COLUMN AND NOT A ROLE CHECK ───────────────────────────────────────
--
-- All four hold `admin` or `super_admin` and Trisha holds only `employee`, so
-- "hide administrators" would have matched exactly the right five people today. It
-- was rejected anyway: a person's ACCESS LEVEL has nothing to do with whether the
-- venue tracks their leave. Promote a department head to admin next month and they
-- would disappear from the leave register silently, which is the kind of rule that
-- is discovered a year later when somebody asks where their balance went.
--
-- ── WHY NOT REUSE AN EXISTING FLAG ──────────────────────────────────────────
--
-- `exclude_from_payroll` was the tempting shortcut — Vinod already carries it. It
-- was rejected because setting it on the other three would take them out of PAYROLL
-- to fix a leave screen: a real consequence, in the wrong system, to achieve a
-- display change. `exclude_from_attendance` is the same mistake in the other
-- direction; it stops their days being computed at all.
--
-- One flag, one meaning.
--
-- ── WHAT IT DOES AND DOES NOT DO ────────────────────────────────────────────
--
-- It is a REPORTING flag. It hides somebody from the leave balances register. It
-- does NOT stop them applying for leave, does not stop accrual, does not delete a
-- balance, and nothing in the leave engine reads it — so turning it off puts the
-- person and their figures straight back, unchanged. That is deliberate: a flag
-- that quietly stopped accruing days would be a policy change dressed as a filter.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 20260831130000: employees.exclude_from_leave_tracking, so the four administrators who run the system stop appearing on the leave balances register — a reporting flag only, read by no part of the leave engine', true);
SELECT set_config('app.source', 'migration', true);

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS exclude_from_leave_tracking boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.employees.exclude_from_leave_tracking IS
  'Reporting only: hides this employee from the leave balances register. Does not affect accrual, applying for leave, or any existing balance — no part of the leave engine reads it. Set for administrators who run the system rather than staff whose leave is tracked.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The four, by code
-- ─────────────────────────────────────────────────────────────────────────────
--
-- By employee code rather than by name: TT0002 cannot be spelled two ways, and the
-- balance load earlier today failed nine times out of fourteen on name matching.

UPDATE public.employees
   SET exclude_from_leave_tracking = true
 WHERE employee_code IN ('TT0002', 'TT0013', 'TT0017', 'TT0019')
   AND deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant the column so the editor can write it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `employees` is guarded twice — RLS and COLUMN privileges — and 005100 grants
-- INSERT/UPDATE on an enumerated list. A column missing from that list is refused
-- with 42501, which an administrator reads as "you do not have permission": exactly
-- the failure 20260801043800 was written to fix for the punch flags. Granted here so
-- the flag can be turned off from the employee screen and not only from SQL.

GRANT UPDATE (exclude_from_leave_tracking) ON public.employees TO authenticated;
GRANT INSERT (exclude_from_leave_tracking) ON public.employees TO authenticated;

DO $verify$
DECLARE v_hidden text; v_trisha boolean; v_can_write boolean;
BEGIN
  SELECT string_agg(employee_code || ' ' || display_name, ', ' ORDER BY employee_code)
    INTO v_hidden
    FROM public.employees
   WHERE exclude_from_leave_tracking AND deleted_at IS NULL;

  SELECT exclude_from_leave_tracking INTO v_trisha
    FROM public.employees WHERE employee_code = 'TT0022' AND deleted_at IS NULL;

  /* The grant is the half that fails silently until somebody tries to save. */
  SELECT has_column_privilege('authenticated', 'public.employees',
                              'exclude_from_leave_tracking', 'UPDATE')
    INTO v_can_write;
  IF NOT v_can_write THEN
    RAISE EXCEPTION 'authenticated cannot UPDATE the new column, so the editor would refuse with 42501';
  END IF;

  IF v_trisha IS TRUE THEN
    RAISE EXCEPTION 'Trisha K was excluded — she is staff and was meant to stay';
  END IF;

  RAISE NOTICE 'not tracked for leave: %', COALESCE(v_hidden, 'nobody');
END $verify$;

COMMIT;
