-- =============================================================================
-- 090 · Drop the second-factor prompt from account creation and role grants
--
-- NOT YET APPLIED. Written for review because it REMOVES a security control, and that is a
-- decision to take deliberately rather than as a side effect of unblocking a screen.
--
-- WHAT IT CHANGES. `requires_step_up` on `public.role_capabilities` is what
-- `requireCapWithStepUp` reads to demand aal2, so this is a DATA flag and needs no redeploy
-- — and the inverse UPDATE puts it back. Three capabilities lose the prompt:
--
--     employee.account.create   creating a portal login
--     role.grant / role.revoke  making somebody an admin, or taking it away
--
-- WHAT IT COSTS, stated plainly because it is the reason the flag existed. These three are
-- the escalation path: an attacker holding a live admin session — a borrowed laptop, a stolen
-- cookie — can currently do nothing with it against these actions without the authenticator.
-- Afterwards they can mint a login and grant themselves admin, and the audit row will carry
-- the legitimate admin's name because that is whose session it was. The second factor is the
-- only control that distinguishes "the admin did this" from "somebody using the admin's
-- browser did this".
--
-- WHY IT IS STILL REASONABLE. The venue has one super admin and a handful of admins on shared
-- office machines, MFA enrolment is not universal, and a control nobody can satisfy is not a
-- control — it is an outage. An account that cannot be created is a person who cannot be paid
-- or rostered. That trade is the operator's to make, not this file's.
--
-- WHAT DELIBERATELY KEEPS THE PROMPT — everything irreversible or exfiltrating:
--   employee.data.purge, employee.hard_delete, biometric.template.purge, audit.export,
--   payroll.run.execute, payroll.run.delete, payroll.publish, attendance.recompute,
--   attendance.lock.manage/override, kiosk.device.secret.rotate, settings.security.write,
--   employee.import, ai.budget.override
-- Losing the prompt on those risks destroyed records or exported personal data, neither of
-- which can be undone by noticing afterwards.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 090: drop the second-factor prompt from account creation and role grants, on request', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.role_capabilities
   SET requires_step_up = false,
       updated_at = now()
 WHERE capability IN ('employee.account.create', 'role.grant', 'role.revoke')
   AND requires_step_up;

COMMIT;

-- Reverse it with:
--   UPDATE public.role_capabilities SET requires_step_up = true
--    WHERE capability IN ('employee.account.create', 'role.grant', 'role.revoke');
