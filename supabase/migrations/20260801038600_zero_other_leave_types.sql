-- =============================================================================
-- Migration 092 — Set all leave balances & quotas to 0 except Sick Leave & Earned Leave
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 092: zero out leave quotas for non-SL/EL types', true);
SELECT set_config('app.source', 'migration', true);

-- Update leave_types: set quotas to 0 for all types except SL and EL
UPDATE public.leave_types
   SET annual_quota_days = 0,
       accrual_frequency = 'none',
       accrual_days_per_period = 0,
       carry_forward_allowed = false,
       max_carry_forward_days = 0
 WHERE code NOT IN ('SL', 'EL');

COMMIT;
