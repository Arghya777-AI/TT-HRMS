-- =============================================================================
-- Migration 072 — one minute between punches, not two.
--
-- WHY, IN THE CLIENT'S WORDS
-- --------------------------
-- "There should always be a button. After 1 minute only, they can log out. Also,
--  they can scan their faces anytime. That button should always be active."
--
-- The debounce was 120 seconds in both places that decide it, so an employee who
-- punched in and then needed to correct or leave was told to wait two minutes, and
-- the second press silently returned the FIRST punch (correctly — that is what the
-- debounce does) which reads as "the button did nothing".
--
-- WHAT THE DEBOUNCE IS FOR, so it is clear why it is not simply removed
-- --------------------------------------------------------------------
-- A face scanner will happily read the same person twice in a row: a second frame
-- lands, or a queue shuffles and the same face reappears. Without a debounce the
-- punch log fills with pairs and `compute_attendance_day` counts an in/out pair
-- that never happened, which moves worked minutes. Sixty seconds is long enough to
-- absorb that and short enough that a person who genuinely turns around and leaves
-- is not blocked.
--
-- BOTH SOURCES CHANGE, because either one alone would be ignored:
--   * `attendance_policies.punch_debounce_seconds` — the per-policy value, which
--     `attendance-self-punch` and `kiosk-punch` prefer when present;
--   * `settings.kiosk.debounce_seconds` — the global fallback.
-- Leaving one at 120 would make the effective window depend on which employee
-- resolved to which policy, which is exactly the kind of inconsistency that makes
-- a product feel unpredictable.
--
-- This DOES also shorten the window at the gate scanner, deliberately: the same
-- reasoning applies to a guard scanning a queue, and two different debounce
-- windows for the same employee depending on where they scanned would be harder to
-- explain than one.
--
-- The permanent per-tap key (`attendance_punch_keys`, one row per clientEventId)
-- and the per-employee advisory lock are untouched — a double-TAP and two
-- simultaneous requests are still both impossible. This changes only how soon a
-- DELIBERATE second punch is accepted.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 072: shorten the punch debounce from 120 to 60 seconds so a deliberate second punch is not blocked for two minutes', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.attendance_policies
   SET punch_debounce_seconds = 60
 WHERE deleted_at IS NULL
   AND punch_debounce_seconds > 60;

UPDATE public.settings
   SET value = to_jsonb(60)
 WHERE key = 'kiosk.debounce_seconds'
   AND (value #>> '{}')::integer > 60;

DO $verify$
DECLARE
  v_policy integer;
  v_setting integer;
BEGIN
  SELECT count(*) INTO v_policy
    FROM public.attendance_policies
   WHERE deleted_at IS NULL AND punch_debounce_seconds <> 60;
  IF v_policy > 0 THEN
    RAISE EXCEPTION 'migration 072: % policy row(s) are not at 60s', v_policy;
  END IF;

  SELECT (value #>> '{}')::integer INTO v_setting
    FROM public.settings WHERE key = 'kiosk.debounce_seconds';
  IF v_setting IS DISTINCT FROM 60 THEN
    RAISE EXCEPTION 'migration 072: kiosk.debounce_seconds is %, expected 60', v_setting;
  END IF;

  RAISE NOTICE 'migration 072: punch debounce is 60s in both the policies and the global setting';
END
$verify$;

COMMIT;
