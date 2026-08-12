-- =============================================================================
-- 20260801042700 — the person holding it can say they received it
-- =============================================================================
--
-- ASKED FOR: "in next step if assets is issued then employee should also that he
-- has received it".
--
-- ── WHAT WAS THERE ─────────────────────────────────────────────────────────
--
-- `asset_allocations.acknowledged_at` has existed since 028 and the employee's
-- screen has a "To confirm" tile counting the rows where it is NULL. The column
-- is written by nobody. `my-assets.api.ts` says so in its own header, having
-- checked: 028 grants the employee SELECT and INSERT on `asset_allocations` and
-- nothing else — no `asset_allocations__self__update` policy, and no RPC.
--
-- So the screen asked a question with no answer on it. Testing Kumar's laptop
-- shows "Not confirmed" and there is no control anywhere, for him or for Stores,
-- that changes it.
--
-- ── WHY AN RPC AND NOT AN UPDATE POLICY ────────────────────────────────────
--
-- A self-UPDATE policy on `asset_allocations` would let the holder write EVERY
-- column the policy does not pin: `expected_return_date`, `returned_at`,
-- `recovery_amount_paise`, `status`. Column privileges could narrow that, but
-- then the rule lives in a GRANT nobody reads. One definer function that writes
-- exactly two columns is the whole permission, and it is legible.
--
-- ── WHAT IT REFUSES ────────────────────────────────────────────────────────
--
-- Somebody else's allocation, an allocation that was never handed over, and one
-- already confirmed — the last as a plain no-op rather than an error, because
-- pressing a button twice is not a mistake worth a red box.
--
-- Acknowledging is NOT reversible here. It is the employee's word that they have
-- the item, and unsaying it is a dispute for Stores to record, not a checkbox.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042700: acknowledge_asset, so the person holding an asset can confirm receipt — the column has existed since 028 with nothing able to write it', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.acknowledge_asset(
  p_allocation_id uuid,
  p_note          text DEFAULT NULL
)
RETURNS public.asset_allocations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_me    uuid := app.current_employee_id();
  v_alloc public.asset_allocations;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Only an employee can confirm receipt of an asset.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_alloc
    FROM public.asset_allocations
   WHERE id = p_allocation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such allocation.' USING errcode = 'P0002';
  END IF;

  /*
    The holder, and only the holder. An administrator confirming on somebody's
    behalf would defeat the point of the record — the value of `acknowledged_at`
    is that the person with the item said so.
  */
  IF v_alloc.employee_id <> v_me THEN
    RAISE EXCEPTION 'That asset is issued to somebody else.' USING errcode = '42501';
  END IF;

  IF v_alloc.acknowledged_at IS NOT NULL THEN
    RETURN v_alloc;  -- already confirmed; pressing it twice is not an error
  END IF;

  IF v_alloc.status <> 'allocated' THEN
    RAISE EXCEPTION
      'This allocation is %, so there is nothing to confirm. Stores records receipt only for an asset that has been handed over.',
      v_alloc.status
      USING errcode = '23514';
  END IF;

  UPDATE public.asset_allocations
     SET acknowledged_at = now(),
         status          = 'acknowledged',
         /*
           The note joins the handover notes rather than replacing them: what
           Stores wrote at issue and what the holder says on receipt are two
           statements, and a disagreement between them is the interesting case.
         */
         handover_notes  = CASE
                             WHEN p_note IS NULL OR btrim(p_note) = '' THEN handover_notes
                             WHEN handover_notes IS NULL THEN 'On receipt: ' || btrim(p_note)
                             ELSE handover_notes || E'\n' || 'On receipt: ' || btrim(p_note)
                           END
   WHERE id = p_allocation_id
  RETURNING * INTO v_alloc;

  RETURN v_alloc;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.acknowledge_asset(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.acknowledge_asset(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.acknowledge_asset(uuid, text) IS
  'The holder confirms an asset reached them: stamps acknowledged_at and moves the allocation to acknowledged. Refuses somebody else''s allocation and one never handed over; a second call is a no-op.';

COMMIT;
