-- =============================================================================
-- 20260827160000 — five leave types, named
-- =============================================================================
--
-- STATED PLAINLY, after I put back one too many:
--
--   "I told that keep these option only for leave: sick, earn, paternity,
--    maternity, week-off only"
--
-- 20260827140000 restored four types on the grounds that nobody had asked for
-- their removal. That was right for maternity, paternity and week-off. It was
-- wrong for ON DUTY, which I restored on the same reasoning and which is not in
-- the venue''s list. Twice now the mistake has been inferring the boundary instead
-- of using the one that was given, in opposite directions — first removing more
-- than was asked, then restoring more than was asked.
--
-- So this migration stops inferring. The list is written down, once, as five
-- codes, and every other type is off. Nothing is deleted: `leave_ledger` and
-- `leave_requests` hold RESTRICT references, and On Duty already has one balance
-- row behind it.
--
--   OFFERED      SL   Sick Leave
--                EL   Earned Leave
--                PL   Paternity Leave
--                ML   Maternity Leave
--                MRL  Week-off
--
--   NOT OFFERED  everything else, which today means BL (bereavement),
--                LWP (leave without pay), CO (comp-off) and OD (on duty).
--                CL (casual) is soft-deleted by 039600 and not switched here.
--
-- ── WHY EXCLUSION IS SAFE HERE AND WAS NOT IN 100000 ────────────────────────
--
-- 20260827100000 also matched by exclusion and it did real damage. The difference
-- is not the technique, it is that the INCLUDED set is now the venue''s own list
-- rather than my guess at it. `NOT IN ('SL','EL')` encoded an assumption that the
-- complement was junk; `NOT IN ('SL','EL','PL','ML','MRL')` encodes a decision
-- somebody actually made and can read back in one line.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 160000: exactly five leave types are offered — sick, earned, paternity, maternity and week-off — and On Duty goes back off, having been restored in 140000 without being on the list', true);
SELECT set_config('app.source', 'migration', true);

DO $before$
BEGIN
  RAISE NOTICE 'offered before: %', COALESCE((
    SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
      FROM public.leave_types WHERE deleted_at IS NULL AND is_active), 'none');
END $before$;

-- ── The five, on ─────────────────────────────────────────────────────────────
UPDATE public.leave_types
   SET is_active = true
 WHERE code IN ('SL', 'EL', 'PL', 'ML', 'MRL')
   AND deleted_at IS NULL
   AND NOT is_active;

-- ── Everything else, off ─────────────────────────────────────────────────────
UPDATE public.leave_types
   SET is_active = false
 WHERE code NOT IN ('SL', 'EL', 'PL', 'ML', 'MRL')
   AND deleted_at IS NULL
   AND is_active;

DO $verify$
DECLARE
  v_wanted text[] := ARRAY['EL','ML','MRL','PL','SL'];
  v_actual text[];
BEGIN
  SELECT array_agg(code ORDER BY code) INTO v_actual
    FROM public.leave_types WHERE deleted_at IS NULL AND is_active;

  IF v_actual IS DISTINCT FROM v_wanted THEN
    RAISE EXCEPTION 'offered types are % but should be exactly %',
      array_to_string(COALESCE(v_actual, '{}'), ','), array_to_string(v_wanted, ',');
  END IF;

  RAISE NOTICE 'offered now: %', (
    SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
      FROM public.leave_types WHERE deleted_at IS NULL AND is_active);
  RAISE NOTICE 'not offered: %', COALESCE((
    SELECT string_agg(format('%s (%s)', code, name), ', ' ORDER BY code)
      FROM public.leave_types WHERE deleted_at IS NULL AND NOT is_active), 'none');
END $verify$;

COMMIT;
