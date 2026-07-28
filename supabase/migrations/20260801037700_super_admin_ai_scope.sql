-- =============================================================================
-- 082 · super_admin may ask the assistant about the whole organisation
--
-- The assistant's scope is resolved from capabilities and the design is already right:
--   ai.ask.all  -> org tier  (every employee)
--   ai.ask.team -> team tier (their reportees)
--   otherwise   -> self tier (their own record only)
--
-- But `ai.ask.all` was granted to `admin` ONLY. `super_admin` holds twelve explicit
-- capabilities and that was not among them, so a super-admin — who also carries the
-- `employee` role — fell through to SELF tier and could ask only about themselves, while
-- a plain admin could ask about anybody. Exactly backwards.
--
-- Granting it to `super_admin` too. `ai.ask.team` is deliberately NOT added: org tier
-- already includes every reportee, and a second grant would be a second thing to keep in
-- step for no gain.
--
-- This widens what the ASSISTANT will answer for a super-admin. It does not widen what
-- they may see: every tool still runs the caller's own scope in SQL, so the assistant can
-- only ever surface rows the same account could already read on a screen.
-- =============================================================================

SELECT set_config('app.reason',
  'migration 082: grant ai.ask.all to super_admin so the assistant answers org-wide for them',
  true);

INSERT INTO public.role_capabilities (role, capability)
SELECT 'super_admin'::public.app_role, 'ai.ask.all'
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_capabilities
   WHERE role = 'super_admin'::public.app_role AND capability = 'ai.ask.all'
);
