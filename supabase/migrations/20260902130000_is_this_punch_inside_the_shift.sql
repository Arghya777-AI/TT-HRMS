-- ============================================================================
-- STEP 3a: one answer to "is this punch inside the employee's shift?"
--
-- ── WHY A DATABASE FUNCTION AND NOT A CHECK IN THE ENDPOINT ─────────────────
-- The endpoint has to ask this to decide whether a reason is required. The engine
-- already resolves the same three things to compute lateness — which shift applies
-- on this date, which policy, and what grace they allow — through
-- `resolve_shift_for_date` and `resolve_policy`. Asking the same functions in the
-- same place means the endpoint and the engine cannot disagree about whether 19:00
-- was inside somebody's day.
--
-- Doing it in TypeScript would mean re-deriving the rota, the policy override and the
-- night-shift cutover in a second language. Migration 20260801040000 already records
-- what happens when a second implementation of a resolved policy is written:
-- "THE ROTA IS RESOLVED, NOT READ OFF THE EMPLOYEE".
--
-- ── WHAT COUNTS AS INSIDE ───────────────────────────────────────────────────
-- From the shift's start minus the in-grace, to the shift's end plus the out-grace,
-- on the BUSINESS date the punch would be filed under — not the calendar date. A
-- 00:37 scan by somebody on a shift that started at 19:00 the previous evening is
-- inside their shift, and `punch_business_date` is the function that knows it.
--
-- Grace is included deliberately. Somebody arriving four minutes late is inside their
-- working hours by every reasonable reading, and asking them to type a sentence about
-- it would be the kind of friction that teaches people to write "worked" in every box.
--
-- ── NULL MEANS "NO SHIFT", AND THAT IS NOT OUTSIDE ──────────────────────────
-- An employee with no shift resolving for the date has no working hours to be outside
-- of. The function returns TRUE — inside — so a missing roster cannot start demanding
-- reasons from people. A punch is never refused because configuration is absent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.punch_within_shift(
  p_employee_id uuid,
  p_at          timestamptz
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_date   date;
  v_shift  public.shifts;
  v_pol    public.attendance_policies;
  v_from   timestamptz;
  v_to     timestamptz;
BEGIN
  IF p_employee_id IS NULL OR p_at IS NULL THEN RETURN true; END IF;

  v_date := public.punch_business_date(p_employee_id, p_at);

  SELECT * INTO v_shift FROM public.shifts s
   WHERE s.id = public.resolve_shift_for_date(p_employee_id, v_date);
  -- No shift, no working hours to be outside of. See the header.
  IF v_shift.id IS NULL OR v_shift.start_time IS NULL OR v_shift.end_time IS NULL THEN
    RETURN true;
  END IF;

  SELECT * INTO v_pol FROM public.attendance_policies ap
   WHERE ap.id = public.resolve_policy('attendance_policy', p_employee_id, v_date);

  v_from := util.ist_instant(v_date, v_shift.start_time)
            - make_interval(mins => COALESCE(v_pol.grace_in_minutes, v_shift.grace_in_minutes, 10));
  v_to   := util.ist_instant(
              v_date + (CASE WHEN v_shift.crosses_midnight THEN 1 ELSE 0 END),
              v_shift.end_time)
            + make_interval(mins => COALESCE(v_pol.grace_out_minutes, v_shift.grace_out_minutes, 10));

  RETURN p_at >= v_from AND p_at <= v_to;
END;
$$;

COMMENT ON FUNCTION public.punch_within_shift(uuid, timestamptz) IS
  'Is this instant inside the employee''s shift window (start minus in-grace to end plus out-grace) on the business date it would be filed under? TRUE when no shift resolves — absent configuration must never make a punch look irregular.';

REVOKE ALL ON FUNCTION public.punch_within_shift(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.punch_within_shift(uuid, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.punch_within_shift(uuid, timestamptz) TO authenticated, service_role;
