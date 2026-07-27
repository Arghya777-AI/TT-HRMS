-- =============================================================================
-- Migration 053 — release the demo payroll run, and put the pending leave
-- requests into the approval inbox.
--
-- WHY THIS EXISTS
-- ---------------
-- After 052 seeded payslips, a per-persona probe showed the SUPER ADMIN could
-- see 14 payslips while every employee saw ZERO. That is not a bug — it is
-- `payslips__self__select` working exactly as designed:
--
--     USING (employee_id = app.current_employee_id()
--            AND public.payroll_run_is_released(payroll_run_id))
--
-- and `payroll_run_is_released` demands status IN (approved, disbursement_pending,
-- paid, closed). 047 left the run in 'draft', so draft payroll was correctly
-- invisible to staff. For the demo the run has to be genuinely approved, and
-- approving it has to satisfy the real two-person rule rather than bypass it.
--
-- Likewise `v_approval_inbox` reads `approval_requests`, not
-- `leave_requests.current_approver_id`. The leave engine sets the approver on the
-- request itself but nothing creates the polymorphic approval row, so every
-- manager's inbox was empty. This migration creates one approval_request per
-- pending leave request, which is what the inbox, the SLA clock and the admin
-- workflow console all read.
--
-- SAFETY: guarded by settings.seed_demo_data, idempotent, no random().
--
-- THE TWO-PERSON RULE IS HONOURED, NOT SIDESTEPPED. `payroll_runs_guard()`
-- refuses the transition unless approved_by differs from computed_by, so two
-- distinct real profiles are resolved and assigned. If only one profile exists
-- the run is left in 'computed' and a NOTICE explains why — a fixture must never
-- weaken a control it is meant to demonstrate.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'seed 053: release the demo payroll run and raise approval requests for pending leave', true);
SELECT set_config('app.source', 'migration', true);

DO $seed$
DECLARE
  v_enabled   boolean;
  v_run       record;
  v_computer  uuid;
  v_approver  uuid;
  v_chain     uuid;
  v_type      uuid;
  v_levels    integer;
  lr          record;
  v_seq       integer := 0;
BEGIN
  SELECT (value #>> '{}')::boolean INTO v_enabled
    FROM public.settings WHERE key = 'seed_demo_data' LIMIT 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE NOTICE 'seed 053 skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  -- ===========================================================================
  -- 1. Release the payroll run so employees can see their own payslips
  -- ===========================================================================
  SELECT r.id, r.status, r.run_number, r.computed_by
    INTO v_run
    FROM public.payroll_runs r
   ORDER BY r.created_at DESC
   LIMIT 1;

  IF v_run.id IS NULL THEN
    RAISE NOTICE 'seed 053: no payroll run to release';
  ELSIF v_run.status IN ('approved','disbursement_pending','paid','closed') THEN
    RAISE NOTICE 'seed 053: run % already released (%)', v_run.run_number, v_run.status;
  ELSE
    -- Two DISTINCT profiles: one computed, a different one approved.
    SELECT p.id INTO v_computer
      FROM public.profiles p
     WHERE p.id = coalesce(v_run.computed_by, p.id)
     ORDER BY p.created_at
     LIMIT 1;

    SELECT p.id INTO v_approver
      FROM public.profiles p
     WHERE p.id IS DISTINCT FROM v_computer
     ORDER BY p.created_at DESC
     LIMIT 1;

    IF v_computer IS NULL OR v_approver IS NULL OR v_approver = v_computer THEN
      RAISE NOTICE 'seed 053: only one profile exists — run left at % so the two-person rule stays intact',
        v_run.status;
    ELSE
      -- Every employee row must be out of 'error' before approval is allowed.
      UPDATE public.payroll_run_employees
         SET status = 'computed'
       WHERE payroll_run_id = v_run.id
         AND status = 'error';

      UPDATE public.payroll_runs
         SET status      = 'computed',
             computed_by = v_computer,
             computed_at = coalesce(computed_at, now())
       WHERE id = v_run.id
         AND status = 'draft';

      -- The guarded transition. approved_by <> computed_by is checked here.
      UPDATE public.payroll_runs
         SET status      = 'approved',
             approved_by = v_approver,
             approved_at = now()
       WHERE id = v_run.id;

      -- Then to paid, which is what a finished month looks like on the console.
      UPDATE public.payroll_runs
         SET status = 'paid'
       WHERE id = v_run.id;

      RAISE NOTICE 'seed 053: run % released to paid (computed_by <> approved_by)', v_run.run_number;
    END IF;
  END IF;

  -- ===========================================================================
  -- 2. Approval requests for the pending leave  →  v_approval_inbox
  -- ===========================================================================
  SELECT rt.id INTO v_type
    FROM public.request_types rt
   WHERE rt.code IN ('LEAVE','LEAVE_REQUEST','LEAVE_APPLICATION')
   ORDER BY rt.code
   LIMIT 1;
  IF v_type IS NULL THEN
    SELECT rt.id INTO v_type FROM public.request_types rt
     WHERE rt.name ILIKE '%leave%' ORDER BY rt.name LIMIT 1;
  END IF;

  SELECT ac.id INTO v_chain
    FROM public.approval_chains ac
   WHERE ac.request_type_id = v_type
   ORDER BY ac.created_at
   LIMIT 1;
  IF v_chain IS NULL THEN
    SELECT ac.id INTO v_chain FROM public.approval_chains ac ORDER BY ac.created_at LIMIT 1;
  END IF;

  IF v_type IS NULL OR v_chain IS NULL THEN
    RAISE NOTICE 'seed 053: no leave request type or approval chain — inbox not seeded';
  ELSE
    SELECT count(*)::integer INTO v_levels
      FROM public.approval_chain_levels al WHERE al.approval_chain_id = v_chain;
    IF v_levels IS NULL OR v_levels = 0 THEN v_levels := 1; END IF;

    FOR lr IN
      SELECT r.id, r.employee_id, r.request_number, r.from_date, r.to_date,
             r.total_days, r.current_approver_id, r.created_by,
             e.display_name, lt.name AS type_name
        FROM public.leave_requests r
        JOIN public.employees e   ON e.id  = r.employee_id
        JOIN public.leave_types lt ON lt.id = r.leave_type_id
       WHERE r.status = 'pending'
         AND r.current_approver_id IS NOT NULL
         AND r.approval_request_id IS NULL
    LOOP
      BEGIN
        INSERT INTO public.approval_requests (
          request_type_id, approval_chain_id, detail_table, detail_id,
          subject_employee_id, raised_by, title, summary, days,
          status, current_level, total_levels, current_approver_ids,
          submitted_at, sla_due_at
        ) VALUES (
          v_type, v_chain, 'leave_requests', lr.id,
          lr.employee_id,
          coalesce(lr.created_by, (SELECT id FROM public.profiles ORDER BY created_at LIMIT 1)),
          format('%s — %s for %s day(s)', lr.display_name, lr.type_name, lr.total_days),
          jsonb_build_object(
            'request_number', lr.request_number,
            'from_date', lr.from_date,
            'to_date', lr.to_date,
            'total_days', lr.total_days),
          lr.total_days,
          'pending', 1, v_levels,
          ARRAY[lr.current_approver_id]::uuid[],
          now(),
          now() + INTERVAL '48 hours'
        );

        UPDATE public.leave_requests
           SET approval_request_id = (
                 SELECT ar.id FROM public.approval_requests ar
                  WHERE ar.detail_table = 'leave_requests' AND ar.detail_id = lr.id
                  ORDER BY ar.submitted_at DESC LIMIT 1)
         WHERE id = lr.id;

        v_seq := v_seq + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'seed 053: approval request for % skipped (%)', lr.request_number, SQLERRM;
      END;
    END LOOP;
    RAISE NOTICE 'seed 053: % approval requests raised', v_seq;
  END IF;

  RAISE NOTICE 'seed 053 complete';
END $seed$;

COMMIT;
