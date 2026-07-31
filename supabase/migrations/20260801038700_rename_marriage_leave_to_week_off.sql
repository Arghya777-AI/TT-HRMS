-- =============================================================================
-- Migration 093 — Rename Marriage Leave ('MRL') to Week-off
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 093: rename Marriage Leave to Week-off', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.leave_types
   SET name = 'Week-off'
 WHERE code = 'MRL' OR name ILIKE '%marriage%';

COMMIT;
