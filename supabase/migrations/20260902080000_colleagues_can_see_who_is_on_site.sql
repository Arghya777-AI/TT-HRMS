-- ============================================================================
-- Every employee can see who is at the venue today, and who is working elsewhere.
--
-- ── WHY A SECOND NARROW VIEW ────────────────────────────────────────────────
-- Same reasoning as `v_leave_roster`, and the same refusal to reach for RLS.
-- `v_attendance_today_board` already answers this for admins, but it filters on
-- `app.can_see_employee(e.id)`, so an employee reading it sees only themselves.
-- Wrapping it in a definer view would not help: that predicate is evaluated against
-- whoever is asking, not against the view's owner.
--
-- And relaxing the policy on `attendance_days` would hand colleagues the whole row —
-- late minutes, early exits, payable minutes, day_fraction_paid, anomaly flags. "Is
-- Ravi at the venue" does not mean "here is Ravi's punctuality record", and a
-- disciplinary conversation is not something a peer should be able to reconstruct.
--
-- So this is built from the base tables with exactly the columns the question needs.
--
-- ── WHAT "INSIDE" AND "OUTSIDE" MEAN, PRECISELY ─────────────────────────────
-- Decided by HOW the punch was taken, not by a coordinate comparison:
--
--   on_campus  a gate scan exists today. The tablet is bolted to a known wall and
--              its own fixes cluster inside ~17 m x 32 m, so a gate scan IS the
--              venue. This is the strongest evidence available and needs no fence.
--   remote     punches exist today, none of them from the gate. Somebody recorded
--              attendance from a phone or a laptop, which since the location became
--              mandatory always carries coordinates.
--   not_in     no punch today.
--
-- Deliberately NOT `geofence_ok`. A web punch taken in the car park is inside the
-- fence and is still not somebody at their desk, and `geofence_ok` was NULL on every
-- punch until the venue's coordinates were set two days ago — so it would report
-- "outside" for history that merely predates a setting.
--
-- ── NO TIMES, NO LATENESS, NO MINUTES ───────────────────────────────────────
-- `first_in_hm` is included because "in since 09:20" is the natural way to say
-- somebody is here. Lateness, worked minutes, early exits and the paid fraction are
-- not: they answer a different question and belong to that person and their manager.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_presence_roster
WITH (security_invoker = false, security_barrier = true) AS
WITH todays_punches AS (
  SELECT p.employee_id,
         bool_or(p.source = 'kiosk_face')  AS any_gate,
         count(*)                          AS punches
    FROM public.attendance_punches p
   WHERE p.effective_date = util.ist_today()
     AND p.is_voided = false
   GROUP BY p.employee_id
)
SELECT
  e.id                                  AS employee_id,
  e.employee_code,
  e.display_name,
  e.photo_path,
  e.department_id,
  d.name                                AS department_name,
  util.ist_today()                       AS ist_date,
  CASE
    WHEN tp.any_gate                     THEN 'on_campus'
    WHEN tp.punches IS NOT NULL          THEN 'remote'
    ELSE 'not_in'
  END                                    AS presence,
  to_char(util.ist_ts(ad.first_in_at), 'HH24:MI') AS first_in_hm,
  to_char(util.ist_ts(ad.last_out_at), 'HH24:MI') AS last_out_hm,
  -- So a colleague is not listed as "not in" when they are on approved leave or off.
  COALESCE(ad.status::text, 'pending')   AS day_status
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
LEFT JOIN todays_punches tp    ON tp.employee_id = e.id
LEFT JOIN public.attendance_days ad
       ON ad.employee_id = e.id AND ad.ist_date = util.ist_today()
WHERE e.deleted_at IS NULL
  AND NOT e.exclude_from_attendance
  AND e.employment_status IN ('active', 'confirmed', 'on_probation', 'on_notice', 'pre_joining');

COMMENT ON VIEW public.v_presence_roster IS
  'Who is at the venue today, readable by any authenticated employee. Name, department, presence (on_campus / remote / not_in), arrival and departure times, and the day status. Never lateness, worked minutes or the paid fraction.';

REVOKE ALL ON public.v_presence_roster FROM PUBLIC;
REVOKE ALL ON public.v_presence_roster FROM anon;
REVOKE ALL ON public.v_presence_roster FROM authenticated;
GRANT SELECT ON public.v_presence_roster TO authenticated;
