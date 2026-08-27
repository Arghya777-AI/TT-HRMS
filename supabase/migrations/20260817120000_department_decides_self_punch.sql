-- =============================================================================
-- 20260817120000 — the department decides whether somebody may punch from a phone
-- =============================================================================
--
-- REPORTED: after 20260817110000 cleared self-service punching for the Ground
-- department, one employee still had the button. The clearing worked — every other
-- Ground employee reads false — but `Testing` did not, and the reason matters more
-- than that one row:
--
--   THAT MIGRATION WAS A ONE-TIME UPDATE. It set a flag; it could not hold one.
--   Anybody hired into Ground afterwards, moved into Ground later, or created with
--   the wizard's toggle switched on, gets self-service punching back. The venue's
--   rule ("ground staff punch at the gate, where a face is seen") is a STANDING
--   rule, and a single UPDATE cannot express a standing rule.
--
-- The client asked for exactly the right thing: apply it when a department changes,
-- and to every new employee.
--
-- ── WHY THE RULE LIVES ON THE DEPARTMENT ────────────────────────────────────
--
-- The obvious implementation hard-codes 'Ground' in a trigger. That works until
-- somebody adds Landscaping, or renames Ground, and then the rule silently stops
-- applying to the people it was written for — the same failure the one-time UPDATE
-- had, wearing a trigger.
--
-- So `departments.self_service_punch_allowed` says it once, as data. Ground is set
-- false here; any other department can be set false from the masters screen without
-- another migration, and a rename cannot break it because nothing matches on a
-- name any more.
--
-- ── WHAT THE TRIGGER DOES NOT DO ────────────────────────────────────────────
--
-- Moving somebody OUT of Ground does not switch the flags back on. The rule is a
-- restriction, not a grant: leaving a restricted department means an administrator
-- MAY now enable it, not that the system should decide to. Auto-granting a way to
-- record attendance from a phone is not a side effect a transfer should have.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 20260817120000: departments.self_service_punch_allowed plus a trigger, so the no-self-punch rule holds for new hires and transfers instead of being a one-time update', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The rule, as data
-- -----------------------------------------------------------------------------

ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS self_service_punch_allowed boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.departments.self_service_punch_allowed IS
  'False where this department''s staff must scan at the gate rather than punching from a browser or a phone. Enforced by trg_employees__punch_rule on insert and on transfer, so it holds for people hired later.';

/* Ground staff are at the venue; their scan belongs to the gate, where a face is
   seen — which is also what makes the record worth anything. */
UPDATE public.departments
   SET self_service_punch_allowed = false
 WHERE deleted_at IS NULL
   AND (lower(btrim(name)) = 'ground' OR lower(btrim(name)) LIKE 'ground %'
        OR lower(btrim(code)) IN ('ground','grnd','gr'));

-- -----------------------------------------------------------------------------
-- 2. The enforcement
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.employees_enforce_punch_rule()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  /* No department, no departmental rule. Deliberately not a refusal: somebody is
     often created before their placement is decided. */
  IF NEW.department_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.self_service_punch_allowed INTO v_allowed
    FROM public.departments d
   WHERE d.id = NEW.department_id;

  /*
    FORCED, not refused. An administrator filling in the wizard should not have a
    save rejected because a toggle they were offered contradicts a rule they may
    not know about — the row is corrected and the audit trail records what was
    stored. Refusing would turn a venue policy into a form error.
  */
  IF v_allowed IS FALSE THEN
    NEW.allow_web_punch           := false;
    NEW.allow_mobile_selfie_punch := false;
  END IF;

  RETURN NEW;
END;
$$;

/*
  BEFORE INSERT catches every new hire. BEFORE UPDATE is not narrowed with
  `UPDATE OF department_id, allow_web_punch, …` on purpose: a narrowed trigger
  fires only when a listed column appears in the statement, and the point of this
  rule is that it cannot be got around — including by a bulk update that touches
  the department through a path nobody predicted.
*/
DROP TRIGGER IF EXISTS trg_employees__punch_rule ON public.employees;
CREATE TRIGGER trg_employees__punch_rule
  BEFORE INSERT OR UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_enforce_punch_rule();

-- -----------------------------------------------------------------------------
-- 3. Bring the existing rows into line
-- -----------------------------------------------------------------------------
--
-- Including whoever the one-time update missed. Reported, so a zero is visible
-- rather than assumed.

DO $fix$
DECLARE
  v_fixed integer;
BEGIN
  UPDATE public.employees e
     SET allow_web_punch = false, allow_mobile_selfie_punch = false
   WHERE e.deleted_at IS NULL
     AND (e.allow_web_punch OR e.allow_mobile_selfie_punch)
     AND EXISTS (SELECT 1 FROM public.departments d
                  WHERE d.id = e.department_id AND d.self_service_punch_allowed IS FALSE);
  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RAISE NOTICE 'self-service punching removed from % existing employee(s)', v_fixed;

  RAISE NOTICE 'departments that must use the gate: %',
    COALESCE((SELECT string_agg(name, ', ' ORDER BY name) FROM public.departments
               WHERE deleted_at IS NULL AND self_service_punch_allowed IS FALSE), '(none)');
END $fix$;

-- -----------------------------------------------------------------------------
-- 4. Prove the rule holds, rather than trusting the trigger
-- -----------------------------------------------------------------------------

DO $verify$
DECLARE
  v_dept uuid;
  v_comp uuid;
  v_emp  uuid;
  v_web  boolean;
BEGIN
  SELECT id INTO v_dept FROM public.departments
   WHERE deleted_at IS NULL AND self_service_punch_allowed IS FALSE LIMIT 1;
  SELECT id INTO v_comp FROM public.companies WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1;

  IF v_dept IS NULL OR v_comp IS NULL THEN
    RAISE NOTICE 'no restricted department or no company — assertion skipped';
    RETURN;
  END IF;

  BEGIN
    /* Ask for self-service punching explicitly; the trigger must overrule it. */
    INSERT INTO public.employees
      (company_id, department_id, first_name, last_name, display_name,
       employment_status, employment_type, date_of_join, gender,
       allow_web_punch, allow_mobile_selfie_punch)
    VALUES (v_comp, v_dept, 'Rule', 'Selfcheck', 'Rule Selfcheck',
            'pre_joining', 'probation', util.ist_today(), 'male', true, true)
    RETURNING id, allow_web_punch INTO v_emp, v_web;

    IF v_web IS NOT FALSE THEN
      RAISE EXCEPTION 'migration 20260817120000: the trigger did not hold — a new employee in a restricted department kept allow_web_punch';
    END IF;

    RAISE EXCEPTION 'UNDO_OK';   -- never keep the row
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'UNDO_OK' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'migration 20260817120000: a new hire in a restricted department cannot self-punch';
END $verify$;

COMMIT;
