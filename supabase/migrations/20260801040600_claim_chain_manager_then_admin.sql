-- =============================================================================
-- 20260801040600 — claims route: reporting manager → admin
-- =============================================================================
--
-- ASKED FOR: "reimbursement information should reach to concern manager and he
-- will approve then it will reach to finance department, keep option so
-- admin/super-admin can always approve" — and, on the shape of the chain,
-- "manager -> admin/super-admin".
--
-- WHAT WAS THERE, AND WHY IT DID NOT MATCH
--
-- 045 seeded two amount-banded chains:
--   AC-CLAIM-SMALL  ≤ ₹10,000  → reporting manager only
--   AC-CLAIM-LARGE  > ₹10,000  → reporting manager → finance → super admin
--
-- Two problems with keeping them.
--
--   1. A claim of ₹9,999 was signed off by one manager and by nobody who
--      handles money. That is the band doing the deciding, not a person.
--   2. THE `finance` LEVEL RESOLVED TO NOBODY. `resolve_approver_kind('finance')`
--      requires membership of a department coded `FIN` *and* a manager/admin
--      role. On this deployment `FIN` is inactive with zero staff — departments
--      were deliberately cut to Ground, Management, Restaurant and Coorg — so
--      the level fell through `resolve_approvers`' ladder to hr_admin and then
--      super_admin. It looked like a finance stage in the seed and behaved as an
--      admin stage at runtime. Naming it what it actually is beats leaving a
--      label that lies.
--
-- SO: ONE CHAIN, TWO LEVELS, NO BANDS. Level 1 the employee's reporting manager
-- — the person who knows whether the trip happened. Level 2 an administrator —
-- the money sign-off. Admin override at any level already works
-- (`act_on_approval`, `v_is_admin`) and is untouched.
--
-- THE TRANSITIONAL CASE, STATED PLAINLY
--
-- 79 of 81 employees currently have no `reporting_manager_id`. For them
-- `resolve_approvers` falls back to hr_admin, so level 1 AND level 2 resolve to
-- the same five administrators, and the claim needs two approvals from that
-- pool — possibly two clicks by the same person, which `act_on_approval` allows
-- because its double-approval guard is per level. That is friction, not a
-- defect, and it disappears as reporting managers are filled in. The admin
-- screen lists who is still missing one so it can be fixed rather than
-- discovered.
--
-- THE OLD CHAINS ARE DEACTIVATED, NOT DELETED. `advance_approval` re-reads the
-- chain of a request already in flight and assumes it is stable; deleting a row
-- an open request points at would strand it. `is_active = false` removes it from
-- selection for new requests and leaves the old ones intact.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 040600: single claim chain — reporting manager then admin', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The new chain
-- -----------------------------------------------------------------------------
--
-- No amount_from / amount_to: every claim takes the same route, whatever it is
-- worth. priority 10 so it is selected ahead of anything left over.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-CLAIM-STD', 'Claim — manager then admin',
       'Level 1 the employee''s reporting manager; level 2 an administrator (admin or super_admin). No amount bands: the same two people sign off ₹200 and ₹20,000.',
       35,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       10::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'LOCAL_CLAIM' AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, v.lvl, v.kind, false, true
FROM public.approval_chains ac
JOIN (VALUES
        (1, 'reporting_manager'),
        (2, 'hr_admin')
     ) AS v(lvl, kind) ON true
WHERE ac.code = 'AC-CLAIM-STD' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Retire the banded chains
-- -----------------------------------------------------------------------------

UPDATE public.approval_chains
   SET is_active  = false,
       is_default = false,
       description = COALESCE(description || ' ', '')
                     || '[Retired by 040600: replaced by AC-CLAIM-STD. Kept because requests already in flight resolve their chain by id.]'
 WHERE code IN ('AC-CLAIM-SMALL', 'AC-CLAIM-LARGE')
   AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Point the request type at the new default
-- -----------------------------------------------------------------------------
--
-- `create_approval_request` falls back to `default_approval_chain_id` when no
-- chain matches on its selectors — so leaving this on a deactivated chain would
-- route a claim to a retired route by the back door.

UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.code = 'AC-CLAIM-STD'
   AND ac.deleted_at IS NULL
   AND rt.code = 'LOCAL_CLAIM'
   AND rt.deleted_at IS NULL
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

COMMIT;
