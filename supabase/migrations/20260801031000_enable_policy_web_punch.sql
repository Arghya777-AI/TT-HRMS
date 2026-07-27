-- =============================================================================
-- Migration 069 — switch web punching ON at POLICY level, now that the function
-- actually honours the switch.
--
-- WHY THIS AND THE CODE CHANGE ARE ONE CHANGE
-- -------------------------------------------
-- `attendance-self-punch` checked only `employees.allow_web_punch` (the
-- per-person exception) and ignored `attendance_policies.allow_web_punch` (what
-- the venue set for the group). An adversarial review called that an
-- authorisation gap, and it was: a venue that deliberately switched portal
-- punching off at policy level would still have seen punches land.
--
-- The function now requires BOTH. But all three seeded policies carry the column's
-- `DEFAULT false`:
--
--     AP-OPS        allow_web_punch = false
--     AP-OFFICE     allow_web_punch = false
--     AP-SECURITY   allow_web_punch = false
--
-- (verified live before writing this). So enforcing the switch WITHOUT this
-- migration would have turned a permissive bug into a total outage of the feature
-- the client just asked for — every punch answering 403
-- SELF_PUNCH_POLICY_FORBIDS_WEB. Correctness and the requirement have to land
-- together, which is why the code fix and this row change are the same commit.
--
-- WHY ALL THREE POLICIES
-- ----------------------
-- The client's requirement is not scoped to one group: "When the employee is
-- giving attendance ... there will be a Login button in their portal." Office
-- staff, operations and security all get the button. If the venue later wants to
-- restrict it — say, gate staff must use the gate scanner so that a guard is
-- physically present — that is now a one-row UPDATE per policy, which is exactly
-- the control the column exists to provide and which the function will honour.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
--   * It does not grant anybody `employees.allow_web_punch`. The per-person
--     entitlement is unchanged; both switches still have to be true.
--   * It does not touch `require_liveness`, which stays TRUE on all three. That
--     flag now drives a review NOTE on this endpoint rather than a refusal — the
--     only liveness signal in the build is a frame-motion heuristic and the
--     capture guidance says "hold still", so refusing on it would reject compliant
--     employees as spoofs. The score, its model and the frame count are recorded
--     in `secure.face_match_log` either way, so the forensic evidence is the same;
--     only the outcome for the employee differs. The gate scanner keeps the strict
--     gate, where a guard can ask a person to move.
--   * It does not weaken the geofence. A punch outside the fence is still
--     recorded with `geofence_ok = false` and `needs_review = true`.
--
-- NOT guarded by settings.seed_demo_data — deliberately. The review found the
-- entitlement migration (20260801022000) hid its only grant behind that flag,
-- which is FALSE on a fresh cluster, so a new deployment would enable the feature
-- for nobody. A policy switch the client asked for is configuration, not demo
-- data, and must apply wherever this schema is deployed.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 069: enable portal (web) punching at attendance-policy level, which the self-punch function now enforces', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.attendance_policies
   SET allow_web_punch = true
 WHERE allow_web_punch = false
   AND deleted_at IS NULL;

DO $verify$
DECLARE
  v_off integer;
BEGIN
  SELECT count(*) INTO v_off
    FROM public.attendance_policies
   WHERE deleted_at IS NULL
     AND allow_web_punch = false;
  IF v_off > 0 THEN
    RAISE EXCEPTION 'migration 069: % active policy row(s) still forbid web punching', v_off;
  END IF;
  RAISE NOTICE 'migration 069: every active attendance policy now allows web punching';
END
$verify$;

COMMIT;
