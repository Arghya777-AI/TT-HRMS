-- =============================================================================
-- 20260801042500 — Stores can actually hand something over
-- =============================================================================
--
-- REPORTED: "in assets there is nothing, but testing kumar has laptop".
--
-- ── WHY /me/assets IS EMPTY FOR SOMEBODY HOLDING A LAPTOP ───────────────────
--
-- Because nothing in the application can write an `asset_allocations` row.
-- `/admin/assets/allocations` is a read-only register — no mutation, no API
-- function — and `allocation_number` is NOT NULL and UNIQUE with no generating
-- trigger, so even a hand-written insert has to invent a reference. Migration
-- 041300 recorded that as an open blocker and 041400 worked around it by giving
-- asset REQUESTS their own table.
--
-- So the request half works — an employee asks, a manager and Stores approve —
-- and then the trail stops. Approving is not issuing, and there was no way to
-- record the issuing. Anything an employee actually holds was handed over in the
-- real world and never entered anywhere.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--
-- 1. The missing reference generator, copied from `generate_claim_number()`
--    (024) down to the advisory lock so two concurrent issues cannot take the
--    same number.
-- 2. `issue_asset(...)` — one definer RPC that creates the allocation, marks the
--    unit allocated, and (when given one) closes the asset request that asked for
--    it. One function because those three writes are one act: an allocation whose
--    asset still reads `in_stock` is a register that disagrees with itself.
--
-- ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
--
-- A unit that is not in stock, an employee who has left, and a caller who is not
-- an administrator. Each raises with a sentence, because Stores reads these.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042500: allocation_number generator and the issue_asset RPC, so an approved asset request can actually be handed over', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The reference nobody could mint
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_allocation_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_year text := to_char(util.ist_date(now()), 'YYYY');
  v_next integer;
BEGIN
  IF NEW.allocation_number IS NULL OR btrim(NEW.allocation_number) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('asset_allocations.allocation_number'));
    SELECT COALESCE(MAX(substring(a.allocation_number FROM '[0-9]+$')::integer), 0) + 1
      INTO v_next
      FROM public.asset_allocations a
     WHERE a.allocation_number LIKE 'ALC-' || v_year || '-%';
    NEW.allocation_number := 'ALC-' || v_year || '-' || lpad(v_next::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_asset_allocations__number ON public.asset_allocations;
CREATE TRIGGER trg_asset_allocations__number
  BEFORE INSERT ON public.asset_allocations
  FOR EACH ROW EXECUTE FUNCTION public.generate_allocation_number();

COMMENT ON FUNCTION public.generate_allocation_number() IS
  'Mints ALC-2026-000001 for an allocation that arrives without one. The absence of this is why nothing could write asset_allocations before 042500.';

-- -----------------------------------------------------------------------------
-- 2. Issuing, as one act
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER: `assets` is admin-write only and `asset_requests` carries a
-- fulfilment guard that refuses anybody but an administrator. The function
-- re-checks the caller itself rather than trusting the door it came through.
--
-- The asset request id is OPTIONAL. Most of what Stores hands over was never
-- requested through the system — a uniform on day one, a locker key — and
-- refusing to record those until somebody raises a retrospective request would
-- keep the register empty for exactly the reason it is empty now.

CREATE OR REPLACE FUNCTION public.issue_asset(
  p_asset_id            uuid,
  p_employee_id         uuid,
  p_expected_return_date date DEFAULT NULL,
  p_asset_request_id    uuid DEFAULT NULL,
  p_notes               text DEFAULT NULL
)
RETURNS public.asset_allocations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor      uuid := app.ctx_actor_id();
  v_asset      public.assets%ROWTYPE;
  v_employee   public.employees%ROWTYPE;
  v_allocation public.asset_allocations;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only Stores can issue an asset.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such asset.' USING errcode = 'P0002';
  END IF;
  IF v_asset.status <> 'in_stock' THEN
    RAISE EXCEPTION
      '% (%) is marked %, not in stock. Return or repair it before issuing it again.',
      v_asset.name, v_asset.asset_tag, v_asset.status
      USING errcode = '23514';
  END IF;

  SELECT * INTO v_employee FROM public.employees
   WHERE id = p_employee_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such employee.' USING errcode = 'P0002';
  END IF;
  IF v_employee.employment_status IN ('exited','retired') THEN
    RAISE EXCEPTION 'Nothing can be issued to somebody who has left.' USING errcode = '23514';
  END IF;
  IF NOT app.admin_scope_covers(p_employee_id) THEN
    RAISE EXCEPTION 'That employee is outside your admin scope.' USING errcode = '42501';
  END IF;

  /*
    `allocated`, not `requested`: this function records a HANDOVER that has
    happened. The acknowledgement is the employee's next step and is a separate
    column — `acknowledged_at` stays NULL until they confirm, which is what
    /me/assets lists under "to confirm".
  */
  INSERT INTO public.asset_allocations
    (asset_id, employee_id, quantity, status, requested_at, approved_by, approved_at,
     allocated_by, allocated_at, expected_return_date, handover_notes, approval_request_id)
  VALUES
    (p_asset_id, p_employee_id, 1, 'allocated', now(), v_actor, now(),
     v_actor, now(), p_expected_return_date, p_notes,
     (SELECT r.approval_request_id FROM public.asset_requests r WHERE r.id = p_asset_request_id))
  RETURNING * INTO v_allocation;

  -- The register and the unit must agree; two statements, one act.
  UPDATE public.assets SET status = 'allocated' WHERE id = p_asset_id;

  /*
    Close the request that asked for it, when there was one.
    `trg_asr__fulfilment` permits this for an administrator and refuses it for
    anybody else, so the guard is doing its job whichever door this came through.
  */
  IF p_asset_request_id IS NOT NULL THEN
    UPDATE public.asset_requests
       SET fulfilled_allocation_id = v_allocation.id,
           fulfilled_at            = now(),
           fulfilled_by            = v_actor
     WHERE id = p_asset_request_id
       AND fulfilled_allocation_id IS NULL;
  END IF;

  RETURN v_allocation;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.issue_asset(uuid, uuid, date, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.issue_asset(uuid, uuid, date, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.issue_asset(uuid, uuid, date, uuid, text) IS
  'Record that Stores handed a unit to somebody: creates the allocation, marks the asset allocated, and closes the asset_request that asked for it. The request id is optional — most of what a venue hands over was never requested in the system.';

COMMIT;
