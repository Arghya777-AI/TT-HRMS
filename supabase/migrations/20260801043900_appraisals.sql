-- =============================================================================
-- 20260801043900 — appraisal cycles, and the judgement a person makes
-- =============================================================================
--
-- /team/performance has carried this notice for the life of the product:
--
--   "There are no appraisal cycles, ratings, goals or 1:1 notes anywhere in this
--    database — the build defers them (D-02-22) and none of those tables exist.
--    So this screen shows no score: what you see is the attendance record the
--    engine actually computed, which is evidence you can take into a review
--    rather than a number nothing stands behind."
--
-- That sentence is the specification for this migration, and its second half is
-- the part that constrains the design.
--
-- ── ATTENDANCE IS EVIDENCE, NEVER A RATING ──────────────────────────────────
--
-- Nothing here reads `attendance_days`, and no column is computed from one. The
-- temptation is obvious — punctuality is already measured, per person, per day,
-- and it would populate a score with no effort at all. It would also be wrong.
-- A cook who is late twice a month and holds the pass together on a Saturday is
-- not a worse employee than one who is punctual and slow, and a system that says
-- otherwise will be believed because it looks computed.
--
-- So the ratings in this file are typed by a human, about a person, in a period.
-- The attendance figures stay on the screen beside them as EVIDENCE. That is a
-- different thing and it is deliberately not joined.
--
-- ── NO OVERALL SCORE IS CALCULATED ──────────────────────────────────────────
--
-- `appraisals.overall_rating` is stated by the manager, not averaged from the
-- competency lines. Averaging four judgements into 3.25 manufactures precision
-- nobody has: it makes "solid everywhere" and "outstanding at the job, poor with
-- colleagues" the same number, and the second is the one that needs a
-- conversation. The lines are there to structure that conversation, not to be
-- arithmetic.
--
-- ── WHAT AN EMPLOYEE MAY SEE, AND WHEN ──────────────────────────────────────
--
-- Their own appraisal, once it is SHARED — never before. A manager's working
-- draft is not a verdict, and a rating read halfway through the cycle is read as
-- one. This is enforced in RLS rather than left to the screens, because there is
-- no version of "the employee saw the draft" that ends well.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043900: appraisal_cycles, appraisal_competencies, appraisals and appraisal_ratings, so a review is a record rather than a paragraph explaining that none exists', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The cycle
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.appraisal_cycles (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code            text NOT NULL,
  name            text NOT NULL,
  /* The period being REVIEWED, which is not when the reviewing happens. */
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  self_due_on     date,
  manager_due_on  date,
  status          text NOT NULL DEFAULT 'draft',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_apcycle__status CHECK (status IN ('draft', 'open', 'closed')),
  CONSTRAINT ck_apcycle__period CHECK (period_to >= period_from),
  /* Reviewing a period before it has finished is guesswork presented as a record. */
  CONSTRAINT ck_apcycle__due CHECK (
    self_due_on IS NULL OR self_due_on >= period_to),
  CONSTRAINT ck_apcycle__deletion CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_apcycle__company_code
  ON public.appraisal_cycles (company_id, code) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_apcycle__stamp ON public.appraisal_cycles;
CREATE TRIGGER trg_apcycle__stamp BEFORE INSERT ON public.appraisal_cycles
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_apcycle__touch ON public.appraisal_cycles;
CREATE TRIGGER trg_apcycle__touch BEFORE UPDATE ON public.appraisal_cycles
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.appraisal_cycles IS
  'A review period. period_from/to is what is being reviewed; the due dates are when the reviewing must be done, and must fall after the period has finished.';

-- -----------------------------------------------------------------------------
-- 2. What is assessed
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.appraisal_competencies (
  id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code         text NOT NULL,
  label        text NOT NULL,
  description  text,
  sort_order   integer NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  deleted_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_apcomp__label CHECK (length(btrim(label)) > 0),
  CONSTRAINT ck_apcomp__deletion CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_apcomp__company_code
  ON public.appraisal_competencies (company_id, code) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_apcomp__stamp ON public.appraisal_competencies;
CREATE TRIGGER trg_apcomp__stamp BEFORE INSERT ON public.appraisal_competencies
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_apcomp__touch ON public.appraisal_competencies;
CREATE TRIGGER trg_apcomp__touch BEFORE UPDATE ON public.appraisal_competencies
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.appraisal_competencies IS
  'What this venue assesses. No weights: a weighted average would turn four judgements into one manufactured number, and the lines exist to structure a conversation rather than to be arithmetic.';

-- Written for a hospitality floor, not an office. Every one is something a
-- manager has actually watched somebody do.
INSERT INTO public.appraisal_competencies (company_id, code, label, description, sort_order)
SELECT c.id, v.code, v.label, v.description, v.sort
  FROM public.companies c
 CROSS JOIN (VALUES
   ('GUEST',    'Guest experience',
    'How the guest is left feeling — including when something has gone wrong.', 10),
   ('CRAFT',    'Skill at the job',
    'The actual craft: the cooking, the service, the paperwork, done well.', 20),
   ('TEAM',     'Working with the team',
    'Whether the shift runs better or worse when this person is on it.', 30),
   ('RELIABLE', 'Reliability',
    'Turning up, finishing what was started, and saying so early when they cannot.', 40),
   ('SAFETY',   'Safety and hygiene',
    'Food safety, cleanliness, and not cutting corners when it is quiet.', 50),
   ('GROWTH',   'Learning and initiative',
    'Taking on more than the minimum, and getting better at it.', 60)
 ) AS v(code, label, description, sort)
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.appraisal_competencies ac
      WHERE ac.company_id = c.id AND ac.code = v.code);

-- -----------------------------------------------------------------------------
-- 3. One person's appraisal in one cycle
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.appraisals (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cycle_id          uuid NOT NULL REFERENCES public.appraisal_cycles(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  /* Who is reviewing — captured when the cycle opens, because a reporting line
     that changes in March must not silently reassign a review of January. */
  reviewer_id       uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'not_started',
  self_comment      text,
  self_submitted_at timestamptz,
  manager_comment   text,
  /*
    STATED, never averaged from the lines below. See the header: 3.25 makes
    "solid everywhere" and "outstanding at the job, poor with colleagues" the same
    number, and the second is the one that needs a conversation.
  */
  overall_rating    integer,
  manager_submitted_at timestamptz,
  /* When the employee was actually shown it — the moment a draft becomes a verdict. */
  shared_at         timestamptz,
  employee_ack_at   timestamptz,
  employee_ack_note text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_appr__status CHECK (status IN
    ('not_started', 'self_submitted', 'manager_submitted', 'shared', 'acknowledged')),
  CONSTRAINT ck_appr__overall CHECK (overall_rating IS NULL OR overall_rating BETWEEN 1 AND 5),
  /* A manager's verdict needs words. A bare number is unusable in the meeting it
     is for, and impossible to defend later. */
  CONSTRAINT ck_appr__manager_words CHECK (
    manager_submitted_at IS NULL OR length(btrim(COALESCE(manager_comment, ''))) >= 20),
  CONSTRAINT ck_appr__shared_after CHECK (
    shared_at IS NULL OR manager_submitted_at IS NOT NULL),
  CONSTRAINT ck_appr__ack_after CHECK (
    employee_ack_at IS NULL OR shared_at IS NOT NULL)
);

/* One appraisal per person per cycle. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_appr__cycle_employee
  ON public.appraisals (cycle_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_appr__employee ON public.appraisals (employee_id);
CREATE INDEX IF NOT EXISTS idx_appr__reviewer ON public.appraisals (reviewer_id);

DROP TRIGGER IF EXISTS trg_appr__stamp ON public.appraisals;
CREATE TRIGGER trg_appr__stamp BEFORE INSERT ON public.appraisals
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_appr__touch ON public.appraisals;
CREATE TRIGGER trg_appr__touch BEFORE UPDATE ON public.appraisals
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.appraisals IS
  'One person''s review in one cycle. overall_rating is STATED by the reviewer, never averaged from appraisal_ratings. Nothing here is computed from attendance: punctuality is evidence for a conversation, not a score.';

-- -----------------------------------------------------------------------------
-- 4. The per-competency lines
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.appraisal_ratings (
  id             uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  appraisal_id   uuid NOT NULL REFERENCES public.appraisals(id) ON DELETE CASCADE,
  competency_id  uuid REFERENCES public.appraisal_competencies(id) ON DELETE SET NULL,
  /* A snapshot, like the clearance checklist: renaming a competency next year
     must not restate what was said about somebody this year. */
  label          text NOT NULL,
  sort_order     integer NOT NULL DEFAULT 100,
  self_rating    integer,
  manager_rating integer,
  manager_note   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_aprate__self CHECK (self_rating IS NULL OR self_rating BETWEEN 1 AND 5),
  CONSTRAINT ck_aprate__manager CHECK (manager_rating IS NULL OR manager_rating BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aprate__appraisal_competency
  ON public.appraisal_ratings (appraisal_id, competency_id)
  WHERE competency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aprate__appraisal ON public.appraisal_ratings (appraisal_id);

DROP TRIGGER IF EXISTS trg_aprate__stamp ON public.appraisal_ratings;
CREATE TRIGGER trg_aprate__stamp BEFORE INSERT ON public.appraisal_ratings
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_aprate__touch ON public.appraisal_ratings;
CREATE TRIGGER trg_aprate__touch BEFORE UPDATE ON public.appraisal_ratings
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.appraisal_ratings IS
  'Per-competency ratings, self and manager, 1 to 5. label is a snapshot of the competency at the time so a later rename cannot restate what was said.';

-- -----------------------------------------------------------------------------
-- 5. Open a cycle for a set of people
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_appraisal_cycle(p_cycle_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cycle   public.appraisal_cycles%ROWTYPE;
  v_created integer := 0;
  v_emp     record;
  v_appr    uuid;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can open an appraisal cycle.'
      USING errcode = '42501';
  END IF;

  SELECT * INTO v_cycle FROM public.appraisal_cycles
   WHERE id = p_cycle_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such appraisal cycle.' USING errcode = 'P0002';
  END IF;

  IF v_cycle.status = 'closed' THEN
    RAISE EXCEPTION 'That cycle is closed.' USING errcode = '23514';
  END IF;

  /*
    Everybody employed at the END of the period being reviewed. Somebody who left
    in the middle is not reviewed — there is nobody to have the conversation with —
    and somebody who joined after it ended has nothing to be reviewed ON.
  */
  FOR v_emp IN
    SELECT e.id, e.reporting_manager_id
      FROM public.employees e
     WHERE e.company_id = v_cycle.company_id
       AND e.deleted_at IS NULL
       AND e.date_of_join <= v_cycle.period_to
       AND (e.last_working_day IS NULL OR e.last_working_day >= v_cycle.period_to)
       AND e.employment_status NOT IN ('pre_joining')
  LOOP
    INSERT INTO public.appraisals (cycle_id, employee_id, reviewer_id)
    VALUES (p_cycle_id, v_emp.id, v_emp.reporting_manager_id)
    ON CONFLICT (cycle_id, employee_id) DO NOTHING
    RETURNING id INTO v_appr;

    /* NULL when the row already existed, so the lines are not written twice. */
    IF v_appr IS NOT NULL THEN
      INSERT INTO public.appraisal_ratings (appraisal_id, competency_id, label, sort_order)
      SELECT v_appr, ac.id, ac.label, ac.sort_order
        FROM public.appraisal_competencies ac
       WHERE ac.company_id = v_cycle.company_id
         AND ac.is_active AND ac.deleted_at IS NULL;
      v_created := v_created + 1;
    END IF;
  END LOOP;

  UPDATE public.appraisal_cycles SET status = 'open'
   WHERE id = p_cycle_id AND status = 'draft';

  RETURN v_created;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.open_appraisal_cycle(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.open_appraisal_cycle(uuid) TO authenticated;

COMMENT ON FUNCTION public.open_appraisal_cycle(uuid) IS
  'Create an appraisal (and its competency lines) for everybody employed at the end of the period, and move the cycle to open. Returns how many were created. Idempotent: re-running adds only people who were missing.';

-- -----------------------------------------------------------------------------
-- 6. Share it with the employee
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.share_appraisal(p_appraisal_id uuid)
RETURNS public.appraisals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.appraisals%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.appraisals WHERE id = p_appraisal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such appraisal.' USING errcode = 'P0002';
  END IF;

  IF NOT (app.is_admin() OR app.is_manager_of(v_row.employee_id)) THEN
    RAISE EXCEPTION 'Only the reviewer or an administrator can share an appraisal.'
      USING errcode = '42501';
  END IF;

  /*
    THE ORDER MATTERS. Sharing is the moment a draft becomes a verdict the person
    will read, so it cannot happen before the manager has finished — and
    `ck_appr__manager_words` means finishing required them to write something.
  */
  IF v_row.manager_submitted_at IS NULL THEN
    RAISE EXCEPTION
      'This appraisal has not been completed yet, so there is nothing to share. Finish the review first.'
      USING errcode = '23514';
  END IF;

  UPDATE public.appraisals
     SET shared_at = COALESCE(shared_at, now()),
         status    = CASE WHEN status = 'acknowledged' THEN status ELSE 'shared' END
   WHERE id = p_appraisal_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.share_appraisal(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.share_appraisal(uuid) TO authenticated;

COMMENT ON FUNCTION public.share_appraisal(uuid) IS
  'Show a completed appraisal to the employee. Refuses one the manager has not submitted — a draft rating read mid-cycle is read as a verdict. Sharing twice keeps the first instant.';

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.appraisal_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appraisal_competencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appraisals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appraisal_ratings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS apcycle__read ON public.appraisal_cycles;
CREATE POLICY apcycle__read ON public.appraisal_cycles
  FOR SELECT TO authenticated USING (status <> 'draft' OR app.is_admin());

DROP POLICY IF EXISTS apcycle__admin_write ON public.appraisal_cycles;
CREATE POLICY apcycle__admin_write ON public.appraisal_cycles
  FOR ALL TO authenticated USING (app.is_admin()) WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS apcomp__read ON public.appraisal_competencies;
CREATE POLICY apcomp__read ON public.appraisal_competencies
  FOR SELECT TO authenticated USING (is_active OR app.is_admin());

DROP POLICY IF EXISTS apcomp__admin_write ON public.appraisal_competencies;
CREATE POLICY apcomp__admin_write ON public.appraisal_competencies
  FOR ALL TO authenticated USING (app.is_admin()) WITH CHECK (app.is_admin());

/*
  ── THE ONE THAT MATTERS ───────────────────────────────────────────────────
  An employee reads their own appraisal ONLY once it has been shared. Before that
  it is a manager's working draft, and a draft rating that leaks mid-cycle is read
  as a verdict — after which no amount of "it was not final" helps.

  In RLS rather than in the screens, because there is no version of "the employee
  saw the draft" that ends well, and a screen is one careless query away from it.
*/
DROP POLICY IF EXISTS appr__self_select ON public.appraisals;
CREATE POLICY appr__self_select ON public.appraisals
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id() AND shared_at IS NOT NULL);

/* Their own self-assessment, though, is theirs to write while the cycle is open. */
DROP POLICY IF EXISTS appr__self_update ON public.appraisals;
CREATE POLICY appr__self_update ON public.appraisals
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id()
         AND status IN ('not_started', 'self_submitted', 'shared'))
  WITH CHECK (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS appr__manager_all ON public.appraisals;
CREATE POLICY appr__manager_all ON public.appraisals
  FOR ALL TO authenticated
  USING (app.is_manager_of(employee_id)) WITH CHECK (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS appr__admin_all ON public.appraisals;
CREATE POLICY appr__admin_all ON public.appraisals
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

/* The lines follow the appraisal they belong to, including the sharing rule. */
DROP POLICY IF EXISTS aprate__self_select ON public.appraisal_ratings;
CREATE POLICY aprate__self_select ON public.appraisal_ratings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.appraisals a
                  WHERE a.id = appraisal_id
                    AND a.employee_id = app.current_employee_id()
                    AND a.shared_at IS NOT NULL));

DROP POLICY IF EXISTS aprate__self_update ON public.appraisal_ratings;
CREATE POLICY aprate__self_update ON public.appraisal_ratings
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.appraisals a
                  WHERE a.id = appraisal_id
                    AND a.employee_id = app.current_employee_id()
                    AND a.status IN ('not_started', 'self_submitted')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.appraisals a
                       WHERE a.id = appraisal_id
                         AND a.employee_id = app.current_employee_id()));

DROP POLICY IF EXISTS aprate__manager_all ON public.appraisal_ratings;
CREATE POLICY aprate__manager_all ON public.appraisal_ratings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.appraisals a
                  WHERE a.id = appraisal_id AND app.is_manager_of(a.employee_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.appraisals a
                       WHERE a.id = appraisal_id AND app.is_manager_of(a.employee_id)));

DROP POLICY IF EXISTS aprate__admin_all ON public.appraisal_ratings;
CREATE POLICY aprate__admin_all ON public.appraisal_ratings
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 8. How a cycle is going
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_appraisal_cycle_progress
WITH (security_invoker = true) AS
SELECT a.cycle_id,
       count(*)::integer                                                    AS total,
       count(*) FILTER (WHERE a.self_submitted_at IS NOT NULL)::integer     AS self_done,
       count(*) FILTER (WHERE a.manager_submitted_at IS NOT NULL)::integer  AS manager_done,
       count(*) FILTER (WHERE a.shared_at IS NOT NULL)::integer             AS shared,
       count(*) FILTER (WHERE a.employee_ack_at IS NOT NULL)::integer       AS acknowledged,
       /* Nobody to review them — the reporting line was empty when the cycle
          opened. Worth surfacing: these are the reviews that quietly never happen. */
       count(*) FILTER (WHERE a.reviewer_id IS NULL)::integer               AS no_reviewer
  FROM public.appraisals a
 GROUP BY a.cycle_id;

COMMENT ON VIEW public.v_appraisal_cycle_progress IS
  'Per-cycle counts: self-assessments in, manager reviews in, shared, acknowledged, and how many have no reviewer at all. security_invoker, so the appraisals policies decide visibility.';

GRANT SELECT ON public.v_appraisal_cycle_progress TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.appraisal_cycles, public.appraisal_competencies,
                    public.appraisals, public.appraisal_ratings TO authenticated;
    GRANT INSERT, UPDATE ON public.appraisal_cycles, public.appraisal_competencies,
                            public.appraisals, public.appraisal_ratings TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.appraisal_cycles, public.appraisal_competencies,
         public.appraisals, public.appraisal_ratings TO service_role;
  END IF;
END $$;

COMMIT;
