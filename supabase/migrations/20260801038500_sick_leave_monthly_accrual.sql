-- =============================================================================
-- Migration 091 — Sick Leave monthly accrual policy (1 day per month)
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 091: update Sick Leave to monthly accrual policy (1 day per month)', true);
SELECT set_config('app.source', 'migration', true);

-- 1. Update leave_types rule for Sick Leave (code 'SL')
UPDATE public.leave_types
   SET description = '1 day accrued per month (12 days annual quota). Medical certificate required beyond 2 days.',
       annual_quota_days = 12,
       accrual_frequency = 'monthly',
       accrual_days_per_period = 1.0,
       accrual_start_after_months = 0,
       pro_rata_on_join = true,
       pro_rata_on_exit = true
 WHERE code = 'SL';

-- 2. Create a helper function to convert Sick Leave opening balances into monthly accruals
CREATE OR REPLACE FUNCTION public.setup_sick_leave_monthly_accrual()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sl_id uuid;
  e       record;
  m       date;
  v_months date[] := ARRAY['2026-01-01'::date, '2026-02-01'::date, '2026-03-01'::date, '2026-04-01'::date, '2026-05-01'::date, '2026-06-01'::date, '2026-07-01'::date];
BEGIN
  SELECT id INTO v_sl_id FROM public.leave_types WHERE code = 'SL' AND deleted_at IS NULL LIMIT 1;
  IF v_sl_id IS NULL THEN RETURN; END IF;

  -- For every employee, remove 9-day opening_balance for SL and add 1 day/month accrual entries
  FOR e IN SELECT id FROM public.employees WHERE deleted_at IS NULL LOOP
    -- Delete opening balance entry for SL
    DELETE FROM public.leave_ledger
     WHERE employee_id = e.id
       AND leave_type_id = v_sl_id
       AND entry_type = 'opening_balance';

    -- Insert 1 day accrual for each month from Jan to Jul 2026
    FOREACH m IN ARRAY v_months LOOP
      INSERT INTO public.leave_ledger (
        employee_id, leave_type_id, leave_year, entry_type, days, effective_date, source_table, reason
      ) VALUES (
        e.id, v_sl_id, 2026, 'accrual', 1.0, m, 'migration', 'Monthly accrual (1 day/month)'
      ) ON CONFLICT (employee_id, leave_type_id, entry_type, effective_date)
        WHERE entry_type IN ('accrual','pro_rata_accrual')
        DO UPDATE SET days = 1.0;
    END LOOP;

    -- Recompute balance cache
    PERFORM public.recompute_leave_balance(e.id, v_sl_id, 2026);
  END LOOP;
END;
$$;

SELECT public.setup_sick_leave_monthly_accrual();

GRANT EXECUTE ON FUNCTION public.setup_sick_leave_monthly_accrual() TO authenticated, service_role;

COMMIT;
