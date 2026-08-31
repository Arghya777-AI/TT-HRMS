-- =============================================================================
-- 20260831140000 — Preethi Machani is staff, and should not have been hidden
-- =============================================================================
--
-- 20260831130000 hid four people from the leave balances register. Three were
-- right; the fourth was not:
--
--   "trisha is management, we don't want arghya, vinod and suraj here because
--    these are just testing data, just hide them"
--
-- Arghya, Vinod and Suraj are the accounts the system was trialled with — their
-- leave data was deleted earlier today because it was test data, which is exactly
-- why they had no balances to show. Preethi Machani (TT0019) is not that. She is
-- Management staff who has simply never had leave credited, the same position as
-- Trisha K — and Trisha was kept for precisely that reason.
--
-- ── WHERE I WENT WRONG ──────────────────────────────────────────────────────
--
-- I grouped the four by the wrong property. The list I was given was "hide these
-- four", and I looked for what they had in common — all four held `admin` or
-- `super_admin` while Trisha held only `employee`, and I noted that as a clean
-- rule I was choosing not to encode. The real distinction was not access level at
-- all: it was whether the account existed to TEST the system. Three did. Preethi's
-- does not, and her holding an admin role is incidental.
--
-- The rule the flag actually expresses, now that it has the right people in it, is
-- narrower and clearer than the one I described when I wrote it: not "the people
-- who run the system", but "the accounts the system was tested with".
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 20260831140000: Preethi Machani is Management staff who has never had leave credited, not a test account — restoring her to the leave balances register', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.employees
   SET exclude_from_leave_tracking = false
 WHERE employee_code = 'TT0019'
   AND deleted_at IS NULL;

COMMENT ON COLUMN public.employees.exclude_from_leave_tracking IS
  'Reporting only: hides this employee from the leave balances register. Does not affect accrual, applying for leave, or any existing balance — no part of the leave engine reads it. Set for the accounts the system was TESTED with, not for administrators in general: a real employee who happens to hold an admin role still has their leave tracked.';

DO $verify$
DECLARE v_unexpected text; v_wrongly_hidden text; v_hidden text;
BEGIN
  /*
    ASSERTS THE INVARIANT, NOT THE VENUE'S ROSTER.

    The first version of this required the hidden set to be exactly the three test
    accounts, and it failed `db:validate` immediately: a replayed database has no
    TT0002 at all, because employees are operational data and were never seeded by a
    migration. An assertion that only holds against one venue's live rows is not a
    post-condition, it is a coincidence.

    So: nobody outside the three may be hidden, and TT0019 must not be — both true
    on an empty database and on this one.
  */
  SELECT string_agg(employee_code || ' ' || display_name, ', ' ORDER BY employee_code)
    INTO v_unexpected
    FROM public.employees
   WHERE exclude_from_leave_tracking AND deleted_at IS NULL
     AND employee_code NOT IN ('TT0002', 'TT0013', 'TT0017');
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'these are hidden from the leave register and are not test accounts: %', v_unexpected;
  END IF;

  SELECT string_agg(display_name, ', ') INTO v_wrongly_hidden
    FROM public.employees
   WHERE employee_code = 'TT0019' AND deleted_at IS NULL AND exclude_from_leave_tracking;
  IF v_wrongly_hidden IS NOT NULL THEN
    RAISE EXCEPTION '% is still hidden', v_wrongly_hidden;
  END IF;

  SELECT string_agg(employee_code, ', ' ORDER BY employee_code) INTO v_hidden
    FROM public.employees WHERE exclude_from_leave_tracking AND deleted_at IS NULL;
  RAISE NOTICE 'hidden from the leave register: %', COALESCE(v_hidden, 'nobody');
END $verify$;

COMMIT;
