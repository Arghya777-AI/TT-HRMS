-- =============================================================================
-- 20260801043700 — the no-dues checklist a leaver actually has to clear
-- =============================================================================
--
-- DEFERRED ON PURPOSE, IN 040800, AND NOW DUE. That migration built the
-- resignation itself and said plainly why it stopped there:
--
--   "item3 (clearance templates / clearance items) and item4 (exit interviews)
--    are DELIBERATELY NOT BUILT HERE. […] Inventing a clearance checklist now
--    would put a second, unowned workflow next to the one this file is adding,
--    and the screen that would have to render it does not exist."
--
-- Both objections have expired. The resignation workflow is deployed and
-- exercised, and /admin/people/exits is a real screen that already shows open
-- asset custody per leaver — the recoverable half of a clearance — while stating
-- that no table holds the line items. This adds the table it names.
--
-- ── A TEMPLATE, AND A SNAPSHOT OF IT ────────────────────────────────────────
--
-- Two tables, and the second is not a join to the first. `employee_clearance`
-- COPIES the label and the owner at the moment a checklist is opened, because a
-- template edited in November must not rewrite what somebody signed off in June.
-- A cleared checklist is a record of what was actually attested to; a live join
-- would quietly restate history every time HR renames an item.
--
-- ── NO MONEY, AGAIN ─────────────────────────────────────────────────────────
--
-- 040800 refused to hold a recovery or full-and-final figure, because notice
-- shortfall is `shortfall × monthly_gross / days_in_month` — payroll arithmetic
-- on a salary figure — and a column here would invite exactly the browser-side
-- computation the screens avoid. That still holds. A clearance item is a THING to
-- hand back or an ACT to complete, never an amount. F&F stays where payroll owns
-- it: `employees.full_and_final_settled_on`.
--
-- ── WHO MAY CLEAR ───────────────────────────────────────────────────────────
--
-- Administrators, and that is a smaller claim than it looks. The obvious design
-- gives IT its own items to tick and Stores its own — but this product's roles are
-- admin / manager / employee, and "manager" is a relationship to a PERSON
-- (`app.is_manager_of`), not to a department. Inventing a department-ownership
-- permission model to serve one screen would be a second authorisation system.
--
-- So `owner_hint` is recorded and used as GUIDANCE — who to chase — exactly as
-- `certification_catalogue.eligibility_note` is. The screen shows it; the database
-- does not enforce it.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043700: clearance_items and employee_clearance, so an exit has a no-dues checklist instead of a paragraph saying one does not exist', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The template — what this venue asks a leaver to clear
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.clearance_items (
  id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code         text NOT NULL,
  label        text NOT NULL,
  description  text,
  /* Who chases it, in words. Guidance, not a permission — see the header. */
  owner_hint   text,
  /*
    A mandatory item blocks the checklist from being complete. An optional one is
    still recorded and still asked about — "return the locker key if you had one"
    is worth a line even when most people did not.
  */
  is_mandatory boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  deleted_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_clritem__label CHECK (length(btrim(label)) > 0),
  CONSTRAINT ck_clritem__deletion CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clritem__company_code
  ON public.clearance_items (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clritem__active
  ON public.clearance_items (company_id, sort_order) WHERE is_active AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_clritem__stamp ON public.clearance_items;
CREATE TRIGGER trg_clritem__stamp BEFORE INSERT ON public.clearance_items
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_clritem__touch ON public.clearance_items;
CREATE TRIGGER trg_clritem__touch BEFORE UPDATE ON public.clearance_items
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.clearance_items IS
  'The no-dues checklist template: what this venue asks a leaver to clear. Copied into employee_clearance when a checklist is opened, never joined live — a template edited later must not rewrite what somebody already signed off.';

-- -----------------------------------------------------------------------------
-- 2. One leaver's checklist
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_clearance (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  /* Where it came from, for tracing. NULL once the template row is deleted —
     which is exactly why the label below is a copy and not a join. */
  clearance_item_id uuid REFERENCES public.clearance_items(id) ON DELETE SET NULL,
  /* THE SNAPSHOT. What was actually asked of this person, in the words used. */
  label             text NOT NULL,
  owner_hint        text,
  is_mandatory      boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 100,
  status            text NOT NULL DEFAULT 'pending',
  /*
    A blocked item must say what is blocking it. "Blocked" with no sentence is a
    dead end for whoever picks the file up next week, and the person who knew is
    the one recording it now.
  */
  note              text,
  cleared_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cleared_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_empclr__status CHECK (status IN ('pending', 'cleared', 'waived', 'blocked')),
  /* Settled means somebody settled it: who and when, or neither. */
  CONSTRAINT ck_empclr__settled CHECK (
    (status IN ('pending', 'blocked') AND cleared_at IS NULL AND cleared_by IS NULL)
    OR (status IN ('cleared', 'waived') AND cleared_at IS NOT NULL)),
  /* A waiver and a block are both departures from the norm; both say why. */
  CONSTRAINT ck_empclr__note CHECK (
    status NOT IN ('waived', 'blocked') OR length(btrim(COALESCE(note, ''))) >= 10)
);

/* One line per item per person — opening a checklist twice must not double it. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_empclr__employee_item
  ON public.employee_clearance (employee_id, clearance_item_id)
  WHERE clearance_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_empclr__employee ON public.employee_clearance (employee_id);
CREATE INDEX IF NOT EXISTS idx_empclr__open
  ON public.employee_clearance (employee_id) WHERE status IN ('pending', 'blocked');

DROP TRIGGER IF EXISTS trg_empclr__stamp ON public.employee_clearance;
CREATE TRIGGER trg_empclr__stamp BEFORE INSERT ON public.employee_clearance
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_empclr__touch ON public.employee_clearance;
CREATE TRIGGER trg_empclr__touch BEFORE UPDATE ON public.employee_clearance
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.employee_clearance IS
  'One leaver''s no-dues checklist. label/owner_hint/is_mandatory are COPIES of the template at the moment the checklist was opened, so a later template edit cannot rewrite what was signed off. No money: a clearance item is a thing to hand back or an act to complete, never an amount.';

-- -----------------------------------------------------------------------------
-- 3. Seed the template with what a venue actually asks for
-- -----------------------------------------------------------------------------
--
-- Written from what this schema already knows a leaver holds: allocated assets,
-- an ID card, a locker, system access, and any advance that was paid. Every one
-- of these is a THING, which is the test for belonging on this list.

INSERT INTO public.clearance_items
  (company_id, code, label, description, owner_hint, is_mandatory, sort_order)
SELECT c.id, v.code, v.label, v.description, v.owner_hint, v.mandatory, v.sort
  FROM public.companies c
 CROSS JOIN (VALUES
   ('ASSETS',    'Return all allocated assets',
    'Laptops, phones, tools and uniform items still showing in the asset register.',
    'Stores', true, 10),
   ('ID_CARD',   'Return the ID card and access card',
    'Including any gate or kiosk card issued for attendance.',
    'Security', true, 20),
   ('LOCKER',    'Empty and return the locker key',
    'Only where a locker was issued.',
    'Stores', false, 30),
   ('SYSTEM',    'Revoke system access',
    'HRMS login, email, and any shared account the person used.',
    'IT', true, 40),
   ('HANDOVER',  'Hand over work in progress',
    'Live files, supplier contacts, and anything only this person knows.',
    'Reporting manager', true, 50),
   ('ADVANCES',  'Settle any outstanding advance',
    'Recorded so payroll knows before the final settlement is computed — the amount itself lives with payroll.',
    'Finance', true, 60),
   ('EXIT_DOCS', 'Collect signed exit paperwork',
    'Resignation acceptance and the exit clearance document.',
    'HR', true, 70)
 ) AS v(code, label, description, owner_hint, mandatory, sort)
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.clearance_items ci
      WHERE ci.company_id = c.id AND ci.code = v.code);

-- -----------------------------------------------------------------------------
-- 4. Open a checklist
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_exit_clearance(p_employee_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_company uuid;
  v_added   integer;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can open an exit clearance.'
      USING errcode = '42501';
  END IF;

  SELECT company_id INTO v_company FROM public.employees
   WHERE id = p_employee_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such employee.' USING errcode = 'P0002';
  END IF;

  /*
    ON CONFLICT DO NOTHING against `uq_empclr__employee_item`, so re-opening adds
    only what is genuinely new — an item added to the template after the checklist
    was opened — and never resets a line somebody has already cleared. Pressing
    the button twice is a no-op, which is what anybody would expect it to be.
  */
  INSERT INTO public.employee_clearance
    (employee_id, clearance_item_id, label, owner_hint, is_mandatory, sort_order)
  SELECT p_employee_id, ci.id, ci.label, ci.owner_hint, ci.is_mandatory, ci.sort_order
    FROM public.clearance_items ci
   WHERE ci.company_id = v_company
     AND ci.is_active
     AND ci.deleted_at IS NULL
  /*
    The index is PARTIAL (`WHERE clearance_item_id IS NOT NULL`), so the inference
    clause has to carry the same predicate — without it Postgres cannot match the
    arbiter and raises "no unique or exclusion constraint matching the ON CONFLICT
    specification" at RUN time, which is to say the first time anybody opens a
    checklist rather than when this file was applied.
  */
  ON CONFLICT (employee_id, clearance_item_id) WHERE clearance_item_id IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_added;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.open_exit_clearance(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.open_exit_clearance(uuid) TO authenticated;

COMMENT ON FUNCTION public.open_exit_clearance(uuid) IS
  'Copy the active clearance template onto one employee and return how many lines were added. Idempotent: re-opening adds only items new to the template and never resets a cleared line.';

-- -----------------------------------------------------------------------------
-- 5. Settle one line
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_clearance_status(
  p_clearance_id uuid,
  p_status       text,
  p_note         text DEFAULT NULL
)
RETURNS public.employee_clearance
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.employee_clearance%ROWTYPE;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can settle a clearance line.'
      USING errcode = '42501';
  END IF;

  IF p_status NOT IN ('pending', 'cleared', 'waived', 'blocked') THEN
    RAISE EXCEPTION 'Unknown clearance status %.', p_status USING errcode = '22023';
  END IF;

  /* The CHECK enforces this too; saying it here means the person gets a sentence
     rather than a constraint name. */
  IF p_status IN ('waived', 'blocked') AND length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION
      'Say why in a sentence: a waived or blocked item with no reason is a dead end for whoever picks this up next.'
      USING errcode = '23514';
  END IF;

  UPDATE public.employee_clearance
     SET status     = p_status,
         note       = CASE WHEN btrim(COALESCE(p_note, '')) = '' THEN note ELSE btrim(p_note) END,
         /* Cleared and waived are settlements and carry who/when; going back to
            pending or blocked withdraws that, rather than leaving a stale name. */
         cleared_by = CASE WHEN p_status IN ('cleared', 'waived') THEN app.ctx_actor_id() ELSE NULL END,
         cleared_at = CASE WHEN p_status IN ('cleared', 'waived') THEN now() ELSE NULL END
   WHERE id = p_clearance_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such clearance line.' USING errcode = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_clearance_status(uuid, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_clearance_status(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.set_clearance_status(uuid, text, text) IS
  'Settle one clearance line. Waived and blocked both require a reason of ten characters or more. Returning a line to pending or blocked clears cleared_by/cleared_at rather than leaving a stale attestation.';

-- -----------------------------------------------------------------------------
-- 6. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.clearance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_clearance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clritem__read ON public.clearance_items;
CREATE POLICY clritem__read ON public.clearance_items
  FOR SELECT TO authenticated USING (is_active OR app.is_admin());

DROP POLICY IF EXISTS clritem__admin_write ON public.clearance_items;
CREATE POLICY clritem__admin_write ON public.clearance_items
  FOR ALL TO authenticated USING (app.is_admin()) WITH CHECK (app.is_admin());

/* A leaver may read their OWN checklist. Being told what you still owe is the
   difference between clearing it and being chased for it. */
DROP POLICY IF EXISTS empclr__self_select ON public.employee_clearance;
CREATE POLICY empclr__self_select ON public.employee_clearance
  FOR SELECT TO authenticated USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS empclr__manager_select ON public.employee_clearance;
CREATE POLICY empclr__manager_select ON public.employee_clearance
  FOR SELECT TO authenticated USING (app.is_manager_of(employee_id));

DROP POLICY IF EXISTS empclr__admin_all ON public.employee_clearance;
CREATE POLICY empclr__admin_all ON public.employee_clearance
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 7. How far a leaver has got
-- -----------------------------------------------------------------------------
--
-- Counted in Postgres so the exits screen can draw a progress bar without
-- grouping rows in a browser — and so "is this person clear" has one definition.

CREATE OR REPLACE VIEW public.v_exit_clearance_progress
WITH (security_invoker = true) AS
SELECT ec.employee_id,
       count(*)::integer                                                  AS total_items,
       count(*) FILTER (WHERE ec.status IN ('cleared', 'waived'))::integer AS settled_items,
       count(*) FILTER (WHERE ec.status = 'blocked')::integer              AS blocked_items,
       count(*) FILTER (WHERE ec.is_mandatory
                          AND ec.status NOT IN ('cleared', 'waived'))::integer
                                                                          AS mandatory_outstanding,
       /*
        CLEAR means every MANDATORY line is settled. An optional item left pending
        does not hold somebody's final settlement — that is what optional means,
        and treating it otherwise would make the flag useless in the one week it
        matters.
       */
       (count(*) FILTER (WHERE ec.is_mandatory
                           AND ec.status NOT IN ('cleared', 'waived')) = 0) AS is_clear
  FROM public.employee_clearance ec
 GROUP BY ec.employee_id;

COMMENT ON VIEW public.v_exit_clearance_progress IS
  'Per-leaver clearance progress. is_clear means every MANDATORY line is cleared or waived; an optional line left pending does not hold up a settlement. security_invoker, so the employee_clearance policies decide visibility.';

GRANT SELECT ON public.v_exit_clearance_progress TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.clearance_items, public.employee_clearance TO authenticated;
    GRANT INSERT, UPDATE ON public.clearance_items, public.employee_clearance TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.clearance_items, public.employee_clearance TO service_role;
  END IF;
END $$;

COMMIT;
