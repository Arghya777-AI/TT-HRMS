-- =============================================================================
-- 078 · Face sign-in: a per-person switch, and the three people who may flip it
--
-- WHAT WAS MISSING
--
-- Face sign-in availability was decided by three things and NONE of them was a
-- switch anybody could see or set:
--   1. the `face_login` feature flag (enabled, 100% rollout — never the blocker),
--   2. an active consented template of the right dimension,
--   3. NOT being a manager / admin / super_admin.
--
-- So the honest answer to "how does an employee enable this?" was "they cannot, and
-- neither can you" — there was nothing to enable. This adds the switch, and the
-- authority matrix the client asked for:
--
--   employee -> their OWN switch, nobody else's
--   manager  -> their reportees' (app.is_manager_of)
--   admin    -> anyone inside their admin scope (app.admin_scope_covers)
--
-- DEFAULT true, DELIBERATELY. A non-privileged employee holding a live consented
-- template can sign in with their face TODAY. Defaulting to false would silently
-- switch that off for everybody the moment this migration ran — a migration that
-- removes a working capability from real users is not a safe default, it is an
-- outage. The switch exists to let somebody turn it OFF and back on again, and the
-- consent to hold a face template is recorded separately in
-- `secure.biometric_consents` and is unaffected by this column.
--
-- WHY A SECURITY DEFINER FUNCTION RATHER THAN AN RLS UPDATE POLICY
--
-- `authenticated` holds broad column privileges on `public.employees`, so making
-- this settable through a policy would mean widening UPDATE on a table that also
-- carries salary-adjacent and statutory columns. One narrow function whose ONLY
-- possible effect is this one boolean is a far smaller surface, and it keeps the
-- three-way authority test in a single place that can be read and audited at once.
--
-- SECURITY DEFINER BYPASSES RLS, so the check inside IS the boundary. It is written
-- to fail closed: an unrecognised caller falls through every branch to a raise.
-- =============================================================================

SELECT set_config('app.reason', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The column
-- -----------------------------------------------------------------------------

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS allow_face_login boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.employees.allow_face_login IS
  'Per-person switch for signing IN to the app with a face (not for punching at the gate). Defaults true so existing face sign-in keeps working; set via public.set_face_login_enabled, which allows self, the reporting manager, or an admin within scope. Independent of biometric CONSENT, which lives in secure.biometric_consents.';

-- -----------------------------------------------------------------------------
-- 2. Who may read it about whom — a view, so the UI never reads `employees`
-- -----------------------------------------------------------------------------

/*
  One relation the three screens share, rather than three separate column additions
  to three separate views that could drift. The row predicate is the SAME three-way
  test the setter enforces, so a reader can only see a switch they could also flip —
  which means the UI never has to render a control it will then be refused.
*/
CREATE OR REPLACE VIEW public.v_face_login_access
WITH (security_barrier = true) AS
SELECT
  e.id                AS employee_id,
  e.employee_code,
  e.display_name,
  e.allow_face_login,
  -- Enrolment state, so the UI can explain WHY a switch that is on still cannot be
  -- used. "Enabled but you have not enrolled a face yet" and "enabled and working"
  -- are different sentences and the reader needs the right one.
  (e.face_enrolled_at IS NOT NULL) AS has_enrolled,
  EXISTS (
    SELECT 1
      FROM secure.face_templates t
      JOIN secure.biometric_consents c
        ON c.id = t.consent_id
       AND c.granted
       AND c.withdrawn_at IS NULL
     WHERE t.employee_id = e.id
       AND t.is_active
       AND t.purged_at IS NULL
  )                   AS has_live_template,
  /*
    Managers, admins and super_admins are refused face sign-in by `face-login`
    itself, on purpose: a privileged session is the one an attacker wants most, and
    the refusal is deliberately indistinguishable from "no template" so it cannot be
    used to discover which accounts are privileged.

    Surfacing it HERE is not a contradiction. This is an authenticated reader asking
    about an employee they already administer — no oracle — and without it the screen
    would show a switch that is on, an enrolled face, and a sign-in that still
    refuses, with nothing to explain why. That is worse than saying so.
  */
  EXISTS (
    SELECT 1
      FROM public.user_roles ur
     WHERE ur.user_id = e.profile_id
       AND ur.revoked_at IS NULL
       AND ur.role IN ('manager', 'admin', 'super_admin')
  )                   AS is_privileged,
  -- Whether the CALLER may flip this particular switch, decided by the database so
  -- the UI does not re-derive an authority rule and get it subtly wrong.
  (
    e.id = app.current_employee_id()
    OR app.is_manager_of(e.id)
    OR (app.is_admin() AND app.admin_scope_covers(e.id))
  )                   AS can_manage
FROM public.employees e
WHERE e.deleted_at IS NULL
  AND (
    e.id = app.current_employee_id()
    OR app.is_manager_of(e.id)
    OR (app.is_admin() AND app.admin_scope_covers(e.id))
  );

COMMENT ON VIEW public.v_face_login_access IS
  'Face sign-in switch plus the enrolment facts that explain it. Row scope: self OR manager-of OR admin-within-scope — the same test public.set_face_login_enabled enforces, so a visible switch is always a flippable one.';

GRANT SELECT ON public.v_face_login_access TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. The setter
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_face_login_enabled(
  p_employee_id uuid,
  p_enabled     boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned: a SECURITY DEFINER function without this can be hijacked by a caller
-- who puts their own schema in front of `public`.
SET search_path = public, app, secure, pg_temp
AS $$
DECLARE
  v_me    uuid;
  v_actor text;
  v_new   boolean;
BEGIN
  IF p_employee_id IS NULL OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'set_face_login_enabled needs an employee id and a value'
      USING ERRCODE = '22023';
  END IF;

  v_me := app.current_employee_id();

  -- FAIL CLOSED. Every branch that grants authority is explicit; anything that
  -- matches none of them raises. Ordered cheapest-first: self is a comparison,
  -- the other two are queries.
  IF v_me IS NOT NULL AND p_employee_id = v_me THEN
    v_actor := 'self';
  ELSIF app.is_manager_of(p_employee_id) THEN
    v_actor := 'reporting manager';
  ELSIF app.is_admin() AND app.admin_scope_covers(p_employee_id) THEN
    v_actor := 'admin';
  ELSE
    -- 42501 so PostgREST answers 403 rather than 500. The message names the limit
    -- without naming the employee, so it cannot confirm that an id exists.
    RAISE EXCEPTION 'Not permitted to change face sign-in for that employee'
      USING ERRCODE = '42501';
  END IF;

  /*
    The audit trail needs a reason and this is the one place that knows it. Written
    as a sentence a human will read in the record history months later — "face
    sign-in disabled by reporting manager" — not a code they would have to look up.
    `true` scopes it to this transaction.
  */
  PERFORM set_config(
    'app.reason',
    format('face sign-in %s by %s',
           CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END,
           v_actor),
    true
  );

  UPDATE public.employees
     SET allow_face_login = p_enabled
   WHERE id = p_employee_id
     AND deleted_at IS NULL
  RETURNING allow_face_login INTO v_new;

  IF v_new IS NULL THEN
    -- Reached only for a deleted or non-existent row, AFTER authority passed.
    RAISE EXCEPTION 'No such employee' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.set_face_login_enabled(uuid, boolean) IS
  'Turn face sign-in on or off for one employee. Permitted for self, the reporting manager, or an admin whose scope covers them; anything else raises 42501. SECURITY DEFINER, so the check inside is the boundary — it fails closed.';

REVOKE ALL ON FUNCTION public.set_face_login_enabled(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_face_login_enabled(uuid, boolean) TO authenticated;
