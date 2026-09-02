-- ============================================================================
-- STEP 3b (part 1): a tolerance that applies ONLY to the reason requirement.
--
-- ── THE PROBLEM WITH USING THE POLICY GRACE ─────────────────────────────────
-- `punch_within_shift` used the shift window plus `grace_in_minutes` /
-- `grace_out_minutes`. On the Operations policy those are 10, so a General-shift
-- employee punching out at 17:41 is already "outside" — and would be asked to
-- justify it. Every slightly-late departure, every day. That is plainly not what
-- "outside their working hours" was meant to catch.
--
-- Widening the policy grace would fix the prompt and break something else:
-- `grace_in_minutes` and `grace_out_minutes` are what the engine measures lateness
-- and early exits against, and both feed `late_days`, `late_minutes` and the late
-- deduction that costs people leave. Loosening them to quieten a dialog would
-- quietly forgive real lateness across the whole venue.
--
-- So the reason requirement gets its OWN tolerance, applied on top of the shift
-- window and nowhere else. Lateness arithmetic is untouched.
--
-- ── SIXTY MINUTES, AND WHY THAT NUMBER ──────────────────────────────────────
-- An hour either side of the shift is ordinary working life — staying late to
-- finish, coming in early before a function. The day this feature exists for is
-- 09:00-13:00 and then 19:00-21:00: the evening session starts 90 minutes after the
-- shift ended, so it is still caught, while an 18:20 departure is not.
--
-- `attendance.off_hours_reason_tolerance_minutes`, so a venue can change it without
-- a deploy. Absent means 60.
--
-- The two-argument form is DROPPED rather than left beside the new one: two
-- functions differing only by a defaulted argument make every call ambiguous, and
-- nothing calls it yet — it shipped in the previous migration with no callers.
-- ============================================================================

DROP FUNCTION IF EXISTS public.punch_within_shift(uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.punch_within_shift(
  p_employee_id       uuid,
  p_at                timestamptz,
  p_tolerance_minutes integer DEFAULT 0
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_date   date;
  v_shift  public.shifts;
  v_pol    public.attendance_policies;
  v_from   timestamptz;
  v_to     timestamptz;
  v_tol    integer := GREATEST(0, COALESCE(p_tolerance_minutes, 0));
BEGIN
  IF p_employee_id IS NULL OR p_at IS NULL THEN RETURN true; END IF;

  v_date := public.punch_business_date(p_employee_id, p_at);

  SELECT * INTO v_shift FROM public.shifts s
   WHERE s.id = public.resolve_shift_for_date(p_employee_id, v_date);
  -- No shift, no working hours to be outside of. Absent configuration must never
  -- make a punch look irregular.
  IF v_shift.id IS NULL OR v_shift.start_time IS NULL OR v_shift.end_time IS NULL THEN
    RETURN true;
  END IF;

  SELECT * INTO v_pol FROM public.attendance_policies ap
   WHERE ap.id = public.resolve_policy('attendance_policy', p_employee_id, v_date);

  v_from := util.ist_instant(v_date, v_shift.start_time)
            - make_interval(mins => COALESCE(v_pol.grace_in_minutes, v_shift.grace_in_minutes, 10) + v_tol);
  v_to   := util.ist_instant(
              v_date + (CASE WHEN v_shift.crosses_midnight THEN 1 ELSE 0 END),
              v_shift.end_time)
            + make_interval(mins => COALESCE(v_pol.grace_out_minutes, v_shift.grace_out_minutes, 10) + v_tol);

  RETURN p_at >= v_from AND p_at <= v_to;
END;
$$;

COMMENT ON FUNCTION public.punch_within_shift(uuid, timestamptz, integer) IS
  'Is this instant inside the employee''s shift window on the business date it would be filed under? Window is shift start/end, plus the policy grace, plus an optional extra tolerance used only by the off-hours reason requirement — never by lateness. TRUE when no shift resolves.';

REVOKE ALL ON FUNCTION public.punch_within_shift(uuid, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.punch_within_shift(uuid, timestamptz, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.punch_within_shift(uuid, timestamptz, integer) TO authenticated, service_role;

/*
  Seeded explicitly rather than left to the code's fallback, so the number is visible
  on the Settings screen where somebody can change it.
*/
INSERT INTO public.settings (key, value, scope)
SELECT 'attendance.off_hours_reason_tolerance_minutes', '60'::jsonb, 'global'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.settings
    WHERE key = 'attendance.off_hours_reason_tolerance_minutes');
