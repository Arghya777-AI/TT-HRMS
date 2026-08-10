-- =============================================================================
-- 20260801040700 — recording that a claim was actually paid
-- =============================================================================
--
-- `payment_mode`, `paid_on`, `payment_reference` and `paid_via_payroll_run_id`
-- have existed on `reimbursement_claims` since 002400. Every one of them is READ
-- — by the admin register, by `compute_payslip` — and NONE of them has ever been
-- written by anything. A grep of `src/` finds them only in schemas and column
-- lists; the sole writes to that table in the entire codebase are the employee's
-- own insert and the approval back-link.
--
-- So "Paid via Bank / Paid in Cash / Cheque Paid" could be filtered on but never
-- reached. This adds the one writer.
--
-- WHY A DEFINER RPC AND NOT A WIDENED RLS POLICY
--
-- `rc__admin__update` already grants the write to `app.is_admin()` — so on the
-- face of it the client could just UPDATE. Two reasons not to:
--
--   * The rules that make a payment record meaningful are conditional on the
--     row's current state (approved, not already paid, not future-dated). RLS
--     expresses who may write, not which transitions are legal. A policy cannot
--     say "only from approved".
--   * A finance approver who is a manager but not an admin is a legitimate
--     level-2 approver under some configurations and fails `app.is_admin()`.
--     Routing through a function keeps one place to change that later, instead
--     of a policy and a client both needing to agree.
--
-- THE REFERENCE IS REQUIRED FOR EVERYTHING BUT CASH. A bank transfer, cheque or
-- UPI payment that nobody can trace back to a statement line is not a record of
-- payment, it is a claim that one happened. Cash has no such handle, which is
-- exactly why it is the one mode that does not demand one.
--
-- Reasons come from the caller's `x-reason` header via `app.pgrst_pre_request()`
-- — `rpcAudited` in `src/shared/api/query.ts` is the client entry point — so the
-- audit row for a payment carries the operator's own sentence.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 040700: record_claim_payment', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.record_claim_payment(
  p_claim_id  uuid,
  p_mode      public.payment_mode,
  p_paid_on   date,
  p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rc          public.reimbursement_claims%ROWTYPE;
  v_actor     uuid := app.ctx_actor_id();
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_today     date := util.ist_today();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cannot resolve the acting user' USING errcode = '42501';
  END IF;

  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can record a payment against a claim.'
      USING errcode = '42501';
  END IF;

  SELECT * INTO rc FROM public.reimbursement_claims WHERE id = p_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim % not found', p_claim_id USING errcode = 'P0002';
  END IF;

  IF rc.status <> 'approved' THEN
    RAISE EXCEPTION
      'This claim is %, so there is nothing to pay yet. Only an approved claim can be marked paid.',
      rc.status
      USING errcode = '23514';
  END IF;

  IF rc.paid_on IS NOT NULL THEN
    RAISE EXCEPTION
      'This claim was already marked paid on %, reference %. Reversing a payment is a correction, not a second payment — ask for the entry to be amended.',
      to_char(rc.paid_on, 'DD Mon YYYY'), COALESCE(rc.payment_reference, '—')
      USING errcode = '23514';
  END IF;

  IF p_paid_on IS NULL THEN
    RAISE EXCEPTION 'A payment needs the date it was made.' USING errcode = '23514';
  END IF;

  IF p_paid_on > v_today THEN
    RAISE EXCEPTION
      'That payment is dated %, which is in the future. Record it on the day it actually leaves.',
      to_char(p_paid_on, 'DD Mon YYYY')
      USING errcode = '23514';
  END IF;

  IF p_mode <> 'cash' AND v_reference IS NULL THEN
    RAISE EXCEPTION
      'A % payment needs a reference — the UTR, cheque number or transaction id — so it can be matched to the bank statement later.',
      replace(p_mode::text, '_', ' ')
      USING errcode = '23514';
  END IF;

  UPDATE public.reimbursement_claims
     SET payment_mode      = p_mode,
         paid_on           = p_paid_on,
         payment_reference = v_reference,
         updated_by        = v_actor
   WHERE id = p_claim_id;

  RETURN jsonb_build_object(
    'id',                p_claim_id,
    'claim_number',      rc.claim_number,
    'payment_mode',      p_mode,
    'paid_on',           p_paid_on,
    'payment_reference', v_reference);
END;
$$;

COMMENT ON FUNCTION public.record_claim_payment(uuid, public.payment_mode, date, text) IS
  'Records how and when an approved claim was paid. Refuses a claim that is not approved, one already marked paid, a future date, and a non-cash payment with no reference.';

GRANT EXECUTE ON FUNCTION public.record_claim_payment(uuid, public.payment_mode, date, text)
  TO authenticated;

COMMIT;
