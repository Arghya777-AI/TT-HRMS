-- =============================================================================
-- 20260817130000 — punching from the web is the DEFAULT, and Ground is the
--                  exception
-- =============================================================================
--
-- REPORTED, by a super-admin looking at their own /me:
--
--   "vinod is super admin but I don't see punch button. our request was if someone
--    is from Ground department then only they should not have access of punch, for
--    rest of all should be."
--
-- Correct, and 20260817110000 only did half of it. That migration turned punching
-- OFF for Ground. It never turned it ON for anybody else — so the rule as built
-- was "Ground cannot punch, and neither can anyone else", which is not the rule
-- that was asked for.
--
-- ── WHY NOBODY COULD PUNCH ──────────────────────────────────────────────────
--
-- There are TWO switches and both ship `NOT NULL DEFAULT false`:
--
--   * `employees.allow_web_punch`            (000800 line 75) — the person
--   * `attendance_policies.allow_web_punch`  (001400 line 344) — the venue
--
-- `attendance-self-punch` refuses unless BOTH are true, so the venue has been
-- shipping with self-service punching structurally off since the schema was
-- written. The only thing that ever flipped the first one was approving a face
-- enrolment (`face-template-admin`), which is why a handful of people have it and
-- nobody else does. The second one has never been flipped by anything.
--
-- Both are set here. Flipping only the employee switch would have produced the
-- same complaint again a day later, from behind a different error message.
--
-- ── WHAT IS DELIBERATELY NOT CHANGED ────────────────────────────────────────
--
-- A FACE IS STILL REQUIRED. `allow_web_punch` is permission, not capability: the
-- punch itself compares a descriptor against that employee's enrolled template
-- and returns 409 "your face is not enrolled yet" when there is none. This
-- migration does not enrol anybody, and it must not — a self-punch that skipped
-- the face check would be attendance nobody's presence was ever verified for.
-- The card now says so before the camera opens instead of after.
--
-- EXITED AND PRE-JOINING STAFF ARE NOT GRANTED. Permission to record attendance
-- for a period you are not employed in is not a convenience.
--
-- PEOPLE EXCLUDED FROM ATTENDANCE ARE NOT GRANTED, for the same reason: their
-- days are not computed, so a punch would be a row nothing reads.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 130000: punching from the web is the default for every department that permits it — 110000 turned it off for Ground and never turned it on for anyone else, so the venue-wide effect was that nobody could punch', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The venue switch
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every active attendance policy now permits web punching. This is the switch
-- that was never on, in any policy, since 001400 — the per-person grants that
-- face approval has been handing out for months could not have worked either.

UPDATE public.attendance_policies
   SET allow_web_punch = true
 WHERE deleted_at IS NULL
   AND is_active
   AND allow_web_punch = false;

DO $venue$
DECLARE v_off int;
BEGIN
  SELECT count(*) INTO v_off
    FROM public.attendance_policies
   WHERE deleted_at IS NULL AND is_active AND allow_web_punch = false;
  IF v_off > 0 THEN
    RAISE NOTICE '% active attendance policies still forbid web punching', v_off;
  END IF;
END $venue$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The people
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Granted to everybody employed whose department permits it. A NULL department
-- is treated as permitted: `self_service_punch_allowed` defaults true, so an
-- unplaced employee is not a restricted one, and refusing them would be a rule
-- nobody wrote.

UPDATE public.employees e
   SET allow_web_punch = true
 WHERE e.deleted_at IS NULL
   AND e.allow_web_punch = false
   AND e.employment_status NOT IN ('exited', 'pre_joining')
   AND e.exclude_from_attendance = false
   AND NOT EXISTS (
     SELECT 1 FROM public.departments d
      WHERE d.id = e.department_id
        AND d.self_service_punch_allowed = false
   );

DO $people$
DECLARE v_on int; v_off int; v_ground int;
BEGIN
  SELECT count(*) FILTER (WHERE allow_web_punch),
         count(*) FILTER (WHERE NOT allow_web_punch)
    INTO v_on, v_off
    FROM public.employees
   WHERE deleted_at IS NULL AND employment_status NOT IN ('exited', 'pre_joining');

  SELECT count(*) INTO v_ground
    FROM public.employees e
    JOIN public.departments d ON d.id = e.department_id
   WHERE e.deleted_at IS NULL
     AND d.self_service_punch_allowed = false
     AND e.allow_web_punch;

  RAISE NOTICE 'web punch: % employed staff can, % cannot', v_on, v_off;

  /* The half this migration must not break. If a restricted department came out
     of this with punching enabled, the grant above was written too wide. */
  IF v_ground > 0 THEN
    RAISE EXCEPTION
      '% employees in a department that forbids self-service punching were granted it. The grant is too wide.',
      v_ground;
  END IF;
END $people$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The standing rule, both ways
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 20260817120000 made the trigger take punching AWAY in a restricted department.
-- It said nothing about the other direction, so somebody transferred OUT of
-- Ground stayed unable to punch with no trace of why — the flag was set by a
-- department they had left.
--
-- Now it is symmetric, but only ON AN ACTUAL DEPARTMENT CHANGE. That distinction
-- is the whole design: re-granting on every UPDATE would silently undo an
-- administrator who turned one person's punching off on purpose, which is a
-- legitimate thing to do and not something a trigger should overrule.

CREATE OR REPLACE FUNCTION public.employees_enforce_punch_rule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allowed     boolean;
  v_was_allowed boolean;
BEGIN
  IF NEW.department_id IS NULL THEN RETURN NEW; END IF;

  SELECT d.self_service_punch_allowed INTO v_allowed
    FROM public.departments d
   WHERE d.id = NEW.department_id;

  -- ── The department forbids it: force, never ask ──────────────────────────
  IF v_allowed IS FALSE THEN
    NEW.allow_web_punch           := false;
    NEW.allow_mobile_selfie_punch := false;
    RETURN NEW;
  END IF;

  -- ── The department permits it ────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    /*
      A new hire in a permitting department can punch. The column default is
      false (000800), which made every wizard-created employee unable to punch
      unless somebody remembered the tick box — the venue's rule is the
      department's, so the department answers it.
    */
    NEW.allow_web_punch := true;
    RETURN NEW;
  END IF;

  IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    SELECT d.self_service_punch_allowed INTO v_was_allowed
      FROM public.departments d
     WHERE d.id = OLD.department_id;

    /* Transferred out of a restricted department: give back what the OLD
       department took. Only then — a move between two permitting departments
       changes nothing, and neither does an edit that is not a transfer. */
    IF v_was_allowed IS FALSE THEN
      NEW.allow_web_punch := true;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employees__punch_rule ON public.employees;
CREATE TRIGGER trg_employees__punch_rule
  BEFORE INSERT OR UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_enforce_punch_rule();

COMMENT ON FUNCTION public.employees_enforce_punch_rule() IS
  'The department decides self-service punching. A department with self_service_punch_allowed = false forces both punch flags off on every insert and update. A department that permits it grants web punch on insert, and restores it when somebody transfers out of a restricted department — but not on an ordinary update, so an administrator can still switch one person off deliberately.';

COMMIT;
