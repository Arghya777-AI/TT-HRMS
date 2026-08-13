-- =============================================================================
-- 20260801043100 — the events register four screens already describe
-- =============================================================================
--
-- ── THE FINDING ─────────────────────────────────────────────────────────────
--
-- `public.events` is never created. Not in any of the ninety-odd migrations.
-- What exists is everything that POINTS at it:
--
--   · `roster_slots.event_id`  — a bare uuid, no FK, NULL on every row
--     (20260801001500_rosters.sql:89, commented "FK deferred — register created
--     later").
--   · `fk_roster_slots__event` — registered in the deferred-FK sweep
--     (20260801004900_deferred_fks.sql:46) against a table that does not exist,
--     so the sweep has been silently skipping it ever since.
--   · `holidays.working_if_event_booked` — the venue's whole "is a booking a
--     working day" rule, seeded and unusable because nothing can book.
--   · `src/features/admin/api/events.api.ts` and `useEventRegister.ts` — real
--     client modules, imported by nothing, whose headers say the table is absent.
--   · `/admin/org/events` — in the route manifest, absent from the registry, so
--     it renders a stub.
--
-- And two analytics screens have been telling administrators that "the events
-- master records who worked which function", which was simply false.
--
-- For a WEDDING AND EVENTS VENUE this is the missing centre of the product. A
-- banquet on Saturday is the reason anyone is rostered, the reason a holiday
-- becomes a working day, and the unit management wants cost against. Everything
-- else in this schema — rosters, attendance, payroll — already hangs together;
-- nothing could say which function the work was for.
--
-- ── WHAT THIS MIGRATION DOES, AND DELIBERATELY DOES NOT ─────────────────────
--
-- It creates the register, attaches the FK the sweep has been waiting for, and
-- adds the labour-demand table that `EventCoverage` needs to answer "were we
-- short". It does NOT invent the cost view: apportioning payroll across events
-- needs a decision about what to do with cost that belongs to no event, and that
-- belongs in its own migration with its own reasoning rather than smuggled in
-- here. `attendance_days.roster_slot_id` is already written by the punch engine
-- (20260801037600), so the bridge from a worked day to an event exists the moment
-- a slot carries one.
--
-- ── ON DELETING AN EVENT ────────────────────────────────────────────────────
--
-- Soft delete only, with a reason, like every other register here. A cancelled
-- wedding is a fact about the business — the roster that was built for it, the
-- shifts people worked preparing for it and the pay they received are all real,
-- and a hard delete would orphan them. `status = 'cancelled'` is the normal way
-- to say a booking is off; `deleted_at` is for a row entered in error.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043100: create the events register that roster_slots.event_id, holidays.working_if_event_booked and four screens have all been pointing at since the schema was written', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. events — one row per booking
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.events (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  location_id           uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  /* Human reference — what the venue calls it on the phone. */
  event_code            text NOT NULL,
  title                 text NOT NULL,
  client_name           text,
  event_type            text NOT NULL DEFAULT 'wedding',
  /*
    Expected at booking, actual after the night. Both nullable: a guest count is
    a forecast until it is a fact, and a zero would read as "nobody came".
  */
  guest_count_expected  integer,
  guest_count_actual    integer,
  /* When staff are called in, which is earlier than when guests arrive — and it
     is the call time a roster is built against. */
  call_time_at          timestamptz,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  cost_centre_id        uuid REFERENCES public.cost_centres(id) ON DELETE SET NULL,
  sales_owner_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'enquiry',
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at            timestamptz,
  deleted_by            uuid REFERENCES public.profiles(id),
  deletion_reason       text,
  CONSTRAINT ck_events__status CHECK (status IN ('enquiry', 'confirmed', 'completed', 'cancelled')),
  CONSTRAINT ck_events__type CHECK (event_type IN
    ('wedding', 'reception', 'corporate', 'conference', 'birthday', 'photoshoot', 'other')),
  /* An event that ends before it starts is a typo, and a roster built on it
     would put people on shift in the wrong order. */
  CONSTRAINT ck_events__span CHECK (ends_at > starts_at),
  CONSTRAINT ck_events__call_before_start CHECK (call_time_at IS NULL OR call_time_at <= starts_at),
  CONSTRAINT ck_events__guests CHECK (
    (guest_count_expected IS NULL OR guest_count_expected >= 0) AND
    (guest_count_actual   IS NULL OR guest_count_actual   >= 0)),
  CONSTRAINT ck_events__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

/* One code per company, among live rows — a cancelled booking keeps its code,
   a soft-deleted one releases it. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_events__company_code
  ON public.events (company_id, event_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events__starts   ON public.events (starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_events__status   ON public.events (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events__location ON public.events (location_id);

CREATE TRIGGER trg_events__stamp BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_events__touch BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.events IS
  'The venue diary: one row per booking. Referenced by roster_slots.event_id (FK attached in this migration) and by holidays.working_if_event_booked. Created here because nothing created it before — the column, the deferred FK and four screens all predate the table.';

-- -----------------------------------------------------------------------------
-- 2. event_labour_demand — how many people the event needs
-- -----------------------------------------------------------------------------
--
-- The other half of "were we short on Saturday". `EventCoverage` compares
-- rostered headcount against required headcount and has never had anywhere to
-- read the requirement from, so it says so on screen instead of guessing.

CREATE TABLE IF NOT EXISTS public.event_labour_demand (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id            uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  department_id       uuid NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  shift_id            uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  role_label          text,
  required_headcount  integer NOT NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_eld__headcount CHECK (required_headcount > 0)
);

/* One requirement per event-department-role, so a second entry is an edit rather
   than a silent doubling of the requirement. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_eld__event_dept_role
  ON public.event_labour_demand (event_id, department_id, COALESCE(role_label, ''));
CREATE INDEX IF NOT EXISTS idx_eld__event ON public.event_labour_demand (event_id);

CREATE TRIGGER trg_eld__stamp BEFORE INSERT ON public.event_labour_demand
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_eld__touch BEFORE UPDATE ON public.event_labour_demand
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

COMMENT ON TABLE public.event_labour_demand IS
  'Required headcount per event, department and role. The denominator EventCoverage needs; rostered headcount is the numerator and already exists in roster_slots.';

-- -----------------------------------------------------------------------------
-- 3. The FK the deferred sweep has been skipping
-- -----------------------------------------------------------------------------
--
-- Guarded exactly like 004900's own sweep, so it is idempotent and so a
-- deployment that already has the constraint is untouched.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_slots__event'
  ) THEN
    ALTER TABLE public.roster_slots
      ADD CONSTRAINT fk_roster_slots__event
      FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;
    RAISE NOTICE 'attached fk_roster_slots__event — deferred since 004900';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
--
-- READ is wide on purpose. An event is not personal data — it is the venue's
-- diary, and a chef needs to know Saturday is a 300-cover wedding to do their
-- job. What is NOT readable is the client's name on an enquiry that has not been
-- confirmed, which is commercially sensitive; that stays admin-only.
--
-- WRITE is admin. Sales and management book events; a section head does not.

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_labour_demand ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events__read ON public.events;
CREATE POLICY events__read ON public.events
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    /* An enquiry is a commercial negotiation, not yet an operational fact. */
    AND (status <> 'enquiry' OR app.is_admin()));

DROP POLICY IF EXISTS events__admin_write ON public.events;
CREATE POLICY events__admin_write ON public.events
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS eld__read ON public.event_labour_demand;
CREATE POLICY eld__read ON public.event_labour_demand
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.events e
     WHERE e.id = event_id AND e.deleted_at IS NULL
       AND (e.status <> 'enquiry' OR app.is_admin())));

DROP POLICY IF EXISTS eld__admin_write ON public.event_labour_demand;
CREATE POLICY eld__admin_write ON public.event_labour_demand
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.events, public.event_labour_demand TO authenticated;
    -- Row access is policy-gated to admins; the grant alone confers nothing.
    GRANT INSERT, UPDATE ON public.events, public.event_labour_demand TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.events, public.event_labour_demand TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. What a roster week is actually covering
-- -----------------------------------------------------------------------------
--
-- The join every event screen needs, in one place so four screens cannot each
-- write their own version of it. Rostered headcount against required, per event
-- and department.

CREATE OR REPLACE VIEW public.v_event_coverage
WITH (security_invoker = true) AS
SELECT e.id                AS event_id,
       e.event_code,
       e.title,
       e.status,
       e.starts_at,
       e.ends_at,
       d.id                AS department_id,
       d.name              AS department_name,
       COALESCE(dem.required_headcount, 0)::integer AS required_headcount,
       COALESCE(ros.rostered, 0)::integer           AS rostered_headcount,
       /*
        Short by, never negative — over-rostering is not a shortfall and a
        negative "short" figure reads as a bug. The two counts are both on the
        row, so anybody who wants the surplus can subtract them.
       */
       GREATEST(COALESCE(dem.required_headcount, 0) - COALESCE(ros.rostered, 0), 0)::integer
         AS short_by
  FROM public.events e
  LEFT JOIN public.event_labour_demand dem ON dem.event_id = e.id
  LEFT JOIN public.departments d ON d.id = dem.department_id
  LEFT JOIN LATERAL (
    /*
      The department is on the PARENT roster, not on the slot — `rosters` is one
      row per department-week and `roster_slots` hangs off it. Counting through
      the parent is the only way to attribute a slot to a department, and getting
      that wrong is how a coverage figure ends up counting the whole venue against
      one department's requirement.
    */
    SELECT count(*)::integer AS rostered
      FROM public.roster_slots rs
      JOIN public.rosters r ON r.id = rs.roster_id AND r.deleted_at IS NULL
     WHERE rs.event_id = e.id
       AND (dem.department_id IS NULL OR r.department_id = dem.department_id)
       AND rs.deleted_at IS NULL
  ) ros ON true
 WHERE e.deleted_at IS NULL;

COMMENT ON VIEW public.v_event_coverage IS
  'Rostered against required headcount per event and department. security_invoker, so the events and roster_slots policies decide what a caller sees.';

GRANT SELECT ON public.v_event_coverage TO authenticated;

COMMIT;
