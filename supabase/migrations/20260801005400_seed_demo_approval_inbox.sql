-- =============================================================================
-- Migration 054 — raise the approval requests for the pending demo leave, using
-- the engine's own entry point.
--
-- 053 tried to INSERT into approval_requests directly and was rejected:
-- request_number is NOT NULL and, unlike leave_requests, has no BEFORE INSERT
-- generator. That was the right failure — the number comes from
-- `seq_approval_request_number` and the whole row is supposed to be built by
-- `public.create_approval_request(...)`, which additionally:
--
--   * resolves WHICH approval chain applies, honouring the chain's day bands,
--     department, grade and employment-type predicates;
--   * counts the chain's levels into total_levels; and
--   * leaves current_level 0 so `advance_approval` computes current_approver_ids
--     from the chain definition rather than from a guess.
--
-- Hand-inserting would have produced a row the approval engine could not act on:
-- the inbox would list it and Approve would fail. Calling the function is both
-- less code and the only version that is actually correct, so this migration
-- calls it once per pending leave request.
--
-- Guarded by settings.seed_demo_data. Idempotent: requests that already carry an
-- approval_request_id are skipped.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'seed 054: raise approval requests for pending demo leave via create_approval_request', true);
SELECT set_config('app.source', 'migration', true);

DO $seed$
DECLARE
  v_enabled boolean;
  lr        record;
  v_id      uuid;
  v_seq     integer := 0;
  v_fail    integer := 0;
BEGIN
  SELECT (value #>> '{}')::boolean INTO v_enabled
    FROM public.settings WHERE key = 'seed_demo_data' LIMIT 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE NOTICE 'seed 054 skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  FOR lr IN
    SELECT r.id, r.employee_id, r.request_number, r.from_date, r.to_date, r.total_days,
           e.display_name, lt.name AS type_name
      FROM public.leave_requests r
      JOIN public.employees   e  ON e.id  = r.employee_id
      JOIN public.leave_types lt ON lt.id = r.leave_type_id
     WHERE r.status = 'pending'
       AND r.approval_request_id IS NULL
     ORDER BY r.request_number
  LOOP
    BEGIN
      v_id := public.create_approval_request(
        'LEAVE',
        lr.employee_id,
        lr.id,
        format('%s — %s, %s day(s) from %s',
               lr.display_name, lr.type_name, lr.total_days,
               to_char(lr.from_date, 'DD-Mon-YYYY')),
        jsonb_build_object(
          'request_number', lr.request_number,
          'from_date',      lr.from_date,
          'to_date',        lr.to_date,
          'total_days',     lr.total_days),
        NULL,              -- p_amount: leave has no money
        lr.total_days,     -- p_days: the chain may band on this
        'normal'
      );

      UPDATE public.leave_requests SET approval_request_id = v_id WHERE id = lr.id;

      -- Populate current_approver_ids from the chain (current_level 0 → 1).
      BEGIN
        PERFORM public.advance_approval(v_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'seed 054: advance_approval for % said: %', lr.request_number, SQLERRM;
      END;

      v_seq := v_seq + 1;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
      RAISE NOTICE 'seed 054: approval request for % skipped (%)', lr.request_number, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'seed 054: % approval requests raised, % skipped', v_seq, v_fail;
END $seed$;

COMMIT;
