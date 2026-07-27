-- =============================================================================
-- Migration 070 — stop step-up blocking admin-led face enrolment.
--
-- THE DEAD END
-- ------------
-- `role_capabilities` seeds ('admin', 'biometric.enrol', …, requires_step_up =
-- TRUE), so `face-enrol` answers 403 MFA_STEP_UP_REQUIRED until the admin has
-- presented a TOTP code. An admin whose account has no authenticator enrolled
-- therefore sees:
--
--     "No authenticator is enrolled for your account.
--      Set one up under Settings → Security first."
--
-- and cannot enrol anybody, ever. Not slow — impossible. The employee is standing
-- at the desk and the admin is sent to configure an authenticator app.
--
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
-- ---------------------------------------
-- `biometric.enrol` no longer requires step-up. The capability itself is
-- unchanged: only an `admin`/`super_admin` holds it, `requireCapWithStepUp` still
-- checks that they hold it, RLS still applies, the audit row is still written with
-- a mandatory reason, and consent is still required before any descriptor is
-- processed.
--
-- The honest trade: whoever holds a live admin session can now enrol a face
-- without a second factor. That is consistent with what an admin can ALREADY do
-- with that session and no step-up — edit an employee's record, approve a change
-- request, unlock an attendance period, record biometric consent. Enrolment is
-- supervised, in-person work; putting the strongest lock in the product on it
-- while leaving those open was not a coherent security posture, it was a blocker
-- in the one place it was noticed.
--
-- DELIBERATELY LEFT REQUIRING STEP-UP — these are the destructive and
-- trust-granting ones, where a stolen session is the threat:
--   * biometric.template.purge   (irreversible erasure, super_admin only)
--   * role.grant / role.revoke   (grants trust)
--   * employee.hard_delete, employee.data.purge
--   * payroll.run.delete, attendance.lock.override
--   * settings.security.write, kiosk.device.secret.rotate, ai.budget.override
--
-- REVERSIBLE IN ONE STATEMENT. If the venue later wants the second factor back:
--   UPDATE public.role_capabilities SET requires_step_up = true
--    WHERE capability = 'biometric.enrol';
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 070: admin-led face enrolment no longer requires MFA step-up, which made enrolment impossible for admins without an authenticator', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.role_capabilities
   SET requires_step_up = false
 WHERE capability = 'biometric.enrol';

DO $verify$
DECLARE
  v_rows integer;
  v_still integer;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.role_capabilities
   WHERE capability = 'biometric.enrol';
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'migration 070: biometric.enrol is not seeded — the capability name is wrong';
  END IF;

  SELECT count(*) INTO v_still
    FROM public.role_capabilities
   WHERE capability = 'biometric.enrol' AND requires_step_up;
  IF v_still > 0 THEN
    RAISE EXCEPTION 'migration 070: % biometric.enrol row(s) still require step-up', v_still;
  END IF;

  RAISE NOTICE 'migration 070: biometric.enrol no longer requires step-up (% row(s))', v_rows;
END
$verify$;

COMMIT;
