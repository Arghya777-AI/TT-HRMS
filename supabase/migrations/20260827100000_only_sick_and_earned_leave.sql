-- =============================================================================
-- 20260827100000 — two leave types, and the numbers the venue actually uses
-- =============================================================================
--
-- ASKED FOR, in three sentences:
--
--   "remove the option of leave like: bereavement leave, casual, leave without pay"
--   "if earn leave is above 30 then reset it to 30"
--   "reset sick leave to 0 at the end of year"
--
-- ── WHY THIS IS NOT THE FIRST MIGRATION TO SAY SO ───────────────────────────
--
-- 20260801038600 already ran `UPDATE leave_types SET is_active = false WHERE code
-- NOT IN ('SL','EL')`, and 20260801039600 deactivated Casual Leave by name. So
-- bereavement, casual and LWP were switched off months ago — and they are visible
-- again, which means they were re-created or re-activated through Admin → Leave →
-- Leave Type Master afterwards.
--
-- That is a different situation from the Ground punch rule, and it gets a
-- different tool. A leave type only appears when an administrator deliberately
-- creates one on a master screen; employees do not create them by existing. So a
-- one-time deactivation IS the right instrument here, and a trigger forbidding
-- new types would be an overreach that stops a future legitimate one (maternity,
-- say) from ever being added. If bereavement reappears, somebody added it back on
-- purpose, and that is a conversation rather than a bug.
--
-- MATCHED BY EXCLUSION, NOT BY NAME. Deactivating "everything that is not SL or
-- EL" catches a bereavement type whatever it was called and whatever code it was
-- given — 'BL', 'BRV', 'BEREAVEMENT'. Naming the three types the request names
-- would have left a fourth one standing.
--
-- NOTHING IS DELETED. `leave_types_guard()` refuses to delete a system-managed
-- row, and rightly: `leave_ledger` and `leave_requests` both hold RESTRICT
-- references to `leave_types`, so deleting one would either fail or orphan
-- somebody's leave history. Deactivating removes it from every picker —
-- `leave_types__ref_read` is `USING ((is_active AND deleted_at IS NULL) OR
-- app.is_admin())` and the apply form filters `is_active` as well — while the
-- history behind it stays readable and correct.
--
-- ── LWP IS SAFE TO SWITCH OFF, AND THAT WAS WORTH CHECKING ──────────────────
--
-- Leave Without Pay is `is_system_managed`, described in the client as "written by
-- the engine", which is the sort of thing that breaks payroll when you switch it
-- off. It does not here: `compute_payslip` derives `lop_days` from
-- `attendance_days.day_fraction_paid` (002300 line 172), and NO function or edge
-- function resolves the type by code — the string 'LWP' appears in exactly one
-- place in the SQL, the seed that created it. Unpaid days are computed from
-- attendance, not from a leave type, so the type going quiet costs nothing.
--
-- ── THE TWO NUMBERS ─────────────────────────────────────────────────────────
--
-- Both of these columns existed already and neither was set, which is why the
-- Year-End Rollover screen has been showing a rulebook with blanks in it.
--
--   EARNED LEAVE  max_carry_forward_days = 30, max_balance_days = 30
--   SICK LEAVE    carry_forward_allowed  = false
--
-- Setting the numbers does not enforce them: no deployed function reads
-- `max_carry_forward_days`, because there was no rollover to read it. The
-- enforcement is 20260827110000, which must be applied with this one.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 100000: only sick and earned leave remain offered, earned leave carries forward at most 30 days, and sick leave does not carry forward at all', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Only Sick Leave and Earned Leave are offered
-- ─────────────────────────────────────────────────────────────────────────────

DO $only_two$
DECLARE
  v_names text;
  v_count int;
BEGIN
  SELECT string_agg(format('%s (%s)', name, code), ', ' ORDER BY code), count(*)
    INTO v_names, v_count
    FROM public.leave_types
   WHERE deleted_at IS NULL
     AND is_active
     AND code NOT IN ('SL', 'EL');

  IF v_count = 0 THEN
    RAISE NOTICE 'only sick and earned leave were active already — nothing to switch off';
  ELSE
    RAISE NOTICE 'switching off % leave type(s): %', v_count, v_names;
  END IF;
END $only_two$;

UPDATE public.leave_types
   SET is_active = false
 WHERE deleted_at IS NULL
   AND is_active
   AND code NOT IN ('SL', 'EL');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Earned leave: at most 30 days, carried or held
-- ─────────────────────────────────────────────────────────────────────────────
--
-- BOTH columns, because they answer different questions and the request needs
-- both answered the same way. `max_carry_forward_days` is what survives a year
-- end; `max_balance_days` is the ceiling the accrual respects DURING a year. Set
-- one and not the other and earned leave either climbs past 30 all year and is cut
-- back in March, or is held at 30 and then carried without limit.

UPDATE public.leave_types
   SET carry_forward_allowed  = true,
       max_carry_forward_days = 30,
       max_balance_days       = 30
 WHERE code = 'EL'
   AND deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Sick leave: nothing carries
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `max_carry_forward_days = 0` as well as the flag. The flag is what a reader
-- checks; the zero is what arithmetic reaches for. Leaving the number NULL under a
-- false flag invites a `COALESCE(max_carry_forward_days, balance)` somewhere down
-- the line to carry everything.

UPDATE public.leave_types
   SET carry_forward_allowed      = false,
       max_carry_forward_days     = 0,
       carry_forward_expiry_months = NULL
 WHERE code = 'SL'
   AND deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Report, and refuse to look successful if the venue has no earned leave
-- ─────────────────────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_active int;
  v_el     record;
  v_sl     record;
BEGIN
  SELECT count(*) INTO v_active
    FROM public.leave_types WHERE deleted_at IS NULL AND is_active;

  SELECT code, name, max_carry_forward_days, max_balance_days, carry_forward_allowed
    INTO v_el FROM public.leave_types WHERE code = 'EL' AND deleted_at IS NULL;
  SELECT code, name, max_carry_forward_days, carry_forward_allowed
    INTO v_sl FROM public.leave_types WHERE code = 'SL' AND deleted_at IS NULL;

  IF v_el IS NULL OR v_sl IS NULL THEN
    RAISE EXCEPTION
      'this venue has no % leave type, so the rule cannot be written against it',
      CASE WHEN v_el IS NULL THEN 'EL (earned)' ELSE 'SL (sick)' END;
  END IF;

  RAISE NOTICE 'active leave types now: %', v_active;
  RAISE NOTICE 'EL: carry_forward=% cap=% balance_cap=%',
    v_el.carry_forward_allowed, v_el.max_carry_forward_days, v_el.max_balance_days;
  RAISE NOTICE 'SL: carry_forward=% cap=%',
    v_sl.carry_forward_allowed, v_sl.max_carry_forward_days;
END $verify$;

COMMIT;
