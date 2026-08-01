-- ============================================================================
-- 20260801039300_adjust_leave_balance.sql
--
-- MANUAL LEAVE ADJUSTMENTS COULD NOT BE SAVED AT ALL.
--
-- `leave_ledger` is append-only and carries exactly one policy —
-- `leave_ledger__scope_read`, a SELECT. There is no INSERT for anybody, and no
-- `leave-adjust` edge function was ever deployed. So the Leave Adjustments screen
-- did the honest thing and refused up front: "the endpoint that would post an
-- adjustment is not deployed on this environment". Correct, and useless — an
-- administrator could not set an opening balance, correct a migration error, or
-- grant a day.
--
-- THIS IS AN RPC, NOT AN EDGE FUNCTION, matching `decide_document_review` and
-- `decide_regularization`: the work is two writes and a recompute inside one
-- transaction, which is what a SECURITY DEFINER function is for. An edge function
-- would add a network hop, a second auth path and a place for the two to disagree.
--
-- OPENING BALANCE IS A FIRST-CLASS ENTRY TYPE, not a credit with a note.
-- `ledger_entry_type` already has `opening_balance` beside `credit_adjustment` and
-- `debit_adjustment`, and the distinction matters downstream: an opening balance is
-- what the year STARTED with, so a report that separates "granted during the year"
-- from "carried in" needs them apart. Folding it into a credit would make that
-- report unbuildable after the fact.
--
-- THE AUTHORITY RULES MIRROR WHAT THE SCREEN ALREADY PROMISED. Its own hint says
-- "credits over 5 days and any debit need a super-admin", which until now was a
-- sentence with nothing enforcing it. It is enforced here, server-side, where it
-- cannot be bypassed by calling the RPC directly.
--
--   * `leave.balance.adjust` capability, always
--   * `app.admin_scope_covers()` on the subject — an admin cannot adjust somebody
--     their own directory would not show them
--   * super admin for ANY debit, and for a credit or opening balance over 5 days
--   * a reason of at least 15 characters (D-21), because this is the only record of
--     why a balance moved
--
-- THE BALANCE IS RE-DERIVED, NEVER PATCHED. `recompute_leave_balance` is called
-- after the insert and its result is returned, so the caller shows the server's
-- number rather than one the browser guessed. That is the same reason the screen
-- refuses to preview a post-adjustment figure.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.adjust_leave_balance(
  p_employee_id    uuid,
  p_leave_type_id  uuid,
  p_days           numeric,
  p_kind           text,      -- 'credit' | 'debit' | 'opening'
  p_effective_date date,
  p_category       text,
  p_reason         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor       uuid := app.ctx_actor_id();
  v_entry_type  public.ledger_entry_type;
  v_signed_days numeric(8,3);
  v_leave_year  integer;
  v_ledger_id   uuid;
  v_available   numeric(8,3);
  v_type_name   text;
BEGIN
  -- ── Authority ────────────────────────────────────────────────────────────
  IF NOT app.has_cap('leave.balance.adjust') THEN
    RAISE EXCEPTION 'not permitted: leave.balance.adjust is required'
      USING errcode = '42501';
  END IF;
  IF NOT app.admin_scope_covers(p_employee_id) THEN
    RAISE EXCEPTION 'not permitted: that employee is outside your scope'
      USING errcode = '42501';
  END IF;

  IF p_kind NOT IN ('credit', 'debit', 'opening') THEN
    RAISE EXCEPTION 'kind must be credit, debit or opening (got %)', p_kind
      USING errcode = '22023';
  END IF;
  IF p_days IS NULL OR p_days <= 0 OR p_days > 365 THEN
    RAISE EXCEPTION 'days must be greater than 0 and at most 365'
      USING errcode = '22023';
  END IF;
  -- Half days only: the leave engine works in 0.5 steps and a 0.3 would round
  -- somewhere nobody can see.
  IF (p_days * 2) <> floor(p_days * 2) THEN
    RAISE EXCEPTION 'days must be a whole or half day' USING errcode = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'a reason of at least 15 characters is required'
      USING errcode = '22023';
  END IF;
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'a reason category is required' USING errcode = '22023';
  END IF;

  -- The rule the screen has always displayed, now actually enforced.
  IF (p_kind = 'debit' OR p_days > 5) AND NOT app.is_super_admin() THEN
    RAISE EXCEPTION
      'a super admin is required for any debit, and for more than 5 days'
      USING errcode = '42501';
  END IF;

  -- ── Shape the entry ──────────────────────────────────────────────────────
  v_entry_type := CASE p_kind
                    WHEN 'opening' THEN 'opening_balance'
                    WHEN 'debit'   THEN 'debit_adjustment'
                    ELSE 'credit_adjustment'
                  END::public.ledger_entry_type;
  -- A debit is stored as a NEGATIVE day count, which is how the ledger sums.
  v_signed_days := CASE WHEN p_kind = 'debit' THEN -p_days ELSE p_days END;
  v_leave_year  := public.leave_year_of(p_effective_date);

  SELECT lt.name INTO v_type_name
  FROM public.leave_types lt WHERE lt.id = p_leave_type_id AND lt.deleted_at IS NULL;
  IF v_type_name IS NULL THEN
    RAISE EXCEPTION 'unknown leave type' USING errcode = '23503';
  END IF;

  -- `description` is NOT NULL and is what the ledger statement renders. It states the
  -- category; `reason` carries the administrator's sentence verbatim.
  INSERT INTO public.leave_ledger (
    employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
    description, source_table, reason, recorded_by, recorded_at
  ) VALUES (
    p_employee_id, p_leave_type_id, v_leave_year, v_entry_type, v_signed_days,
    p_effective_date,
    CASE p_kind
      WHEN 'opening' THEN 'Opening balance set by an administrator'
      WHEN 'debit'   THEN 'Manual debit by an administrator'
      ELSE 'Manual credit by an administrator'
    END || ' — ' || btrim(p_category),
    'manual_adjustment', btrim(p_reason), v_actor, now()
  )
  RETURNING id INTO v_ledger_id;

  -- ── Re-derive, never patch ───────────────────────────────────────────────
  PERFORM public.recompute_leave_balance(p_employee_id, p_leave_type_id, v_leave_year);

  SELECT lb.available_days INTO v_available
  FROM public.leave_balances lb
  WHERE lb.employee_id = p_employee_id
    AND lb.leave_type_id = p_leave_type_id
    AND lb.leave_year = v_leave_year;

  RETURN jsonb_build_object(
    'ledger_id',      v_ledger_id,
    'entry_type',     v_entry_type::text,
    'days',           v_signed_days,
    'leave_year',     v_leave_year,
    'leave_type',     v_type_name,
    'available_days', v_available
  );
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_leave_balance(uuid, uuid, numeric, text, date, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_leave_balance(uuid, uuid, numeric, text, date, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.adjust_leave_balance(uuid, uuid, numeric, text, date, text, text) IS
  'Post a manual leave adjustment — credit, debit or opening balance — to the append-only '
  'leave_ledger and re-derive the balance. Migration 039300: leave_ledger had only a SELECT '
  'policy and no leave-adjust function was deployed, so adjustments could not be saved at '
  'all. Enforces leave.balance.adjust, admin scope, a 15-character reason, and super admin '
  'for any debit or more than 5 days.';

COMMIT;
