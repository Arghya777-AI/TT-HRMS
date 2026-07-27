-- =============================================================================
-- Migration 015 — rosters + roster_slots
-- Source: docs/plan/04-data-model.md §3.6 (rosters/roster_slots, lines
--         1595–1604); spec-migrations §2 row 015.
--
-- Weekly published schedule. Employees see only their own PUBLISHED slots;
-- drafts are manager/admin territory. Slot writes go through the roster
-- edge functions / RPCs (P5 — no client write), so policies here grant
-- admin-only direct writes.
--
-- Forward references handled by the deferred-FK sweep (049):
--   roster_slots.attendance_day_id → attendance_days (017)
--   roster_slots.event_id          → events register (admin PRD; created later)
-- The enqueue-attendance-recompute trigger on roster_slots is created by the
-- attendance engine (018), not here.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. rosters — one row per department-week
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rosters (
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  location_id      uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  department_id    uuid NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  week_start_date  date NOT NULL,   -- IST Monday
  title            text,
  status           text NOT NULL DEFAULT 'draft',
  published_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  published_at     timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES public.profiles(id),
  deletion_reason  text,
  CONSTRAINT ck_rosters__status CHECK (status IN ('draft', 'published', 'locked')),
  CONSTRAINT ck_rosters__monday CHECK (EXTRACT(DOW FROM week_start_date) = 1),
  CONSTRAINT ck_rosters__published_fields CHECK (
    status = 'draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT ck_rosters__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rosters__department_week
  ON public.rosters (department_id, week_start_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rosters__company  ON public.rosters (company_id);
CREATE INDEX IF NOT EXISTS idx_rosters__location ON public.rosters (location_id);
CREATE INDEX IF NOT EXISTS idx_rosters__week     ON public.rosters (week_start_date DESC);

CREATE TRIGGER trg_rosters__stamp BEFORE INSERT ON public.rosters
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_rosters__touch BEFORE UPDATE ON public.rosters
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.rosters ENABLE ROW LEVEL SECURITY;

-- Managers/admins see all rosters (planning is team-scoped by slots, the
-- header row is not sensitive); employees see published ones for context.
DROP POLICY IF EXISTS rosters__read ON public.rosters;
CREATE POLICY rosters__read ON public.rosters
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (status <> 'draft' OR app.is_manager() OR app.is_admin())
  );

DROP POLICY IF EXISTS rosters__admin_write ON public.rosters;
CREATE POLICY rosters__admin_write ON public.rosters
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 2. roster_slots — one row per employee-date within a roster
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.roster_slots (
  id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  roster_id             uuid NOT NULL REFERENCES public.rosters(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  slot_date             date NOT NULL,
  shift_id              uuid REFERENCES public.shifts(id) ON DELETE RESTRICT,
  section_id            uuid REFERENCES public.sections(id) ON DELETE SET NULL,
  event_id              uuid,   -- FK added by deferred sweep (event register)
  planned_start_at      timestamptz,
  planned_end_at        timestamptz,
  role_label            text,
  is_weekly_off         boolean NOT NULL DEFAULT false,
  is_published          boolean NOT NULL DEFAULT false,
  swap_requested_with_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  swap_status           text,
  attendance_day_id     uuid,   -- FK added by deferred sweep (attendance_days in 017)
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at            timestamptz,
  deleted_by            uuid REFERENCES public.profiles(id),
  deletion_reason       text,
  CONSTRAINT ck_roster_slots__swap_status CHECK (
    swap_status IS NULL OR swap_status IN ('requested', 'accepted', 'declined', 'approved', 'cancelled')),
  CONSTRAINT ck_roster_slots__shift_or_off CHECK (is_weekly_off OR shift_id IS NOT NULL),
  CONSTRAINT ck_roster_slots__planned_order CHECK (
    planned_start_at IS NULL OR planned_end_at IS NULL OR planned_end_at > planned_start_at),
  CONSTRAINT ck_roster_slots__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_slots__employee_date
  ON public.roster_slots (employee_id, slot_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_roster_slots__date_shift ON public.roster_slots (slot_date, shift_id);
CREATE INDEX IF NOT EXISTS idx_roster_slots__roster     ON public.roster_slots (roster_id);
CREATE INDEX IF NOT EXISTS idx_roster_slots__section    ON public.roster_slots (section_id);
CREATE INDEX IF NOT EXISTS idx_roster_slots__event      ON public.roster_slots (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_roster_slots__swap       ON public.roster_slots (swap_requested_with_employee_id) WHERE swap_requested_with_employee_id IS NOT NULL;

CREATE TRIGGER trg_roster_slots__stamp BEFORE INSERT ON public.roster_slots
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_roster_slots__touch BEFORE UPDATE ON public.roster_slots
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.roster_slots ENABLE ROW LEVEL SECURITY;

-- P5: self sees own PUBLISHED slots; managers see their team's (drafts
-- included, for planning); admins all. No client write path — publishes and
-- edits go through the roster edge functions / admin console (service role),
-- plus a direct admin policy for the console's simple cases.
DROP POLICY IF EXISTS roster_slots__self_read ON public.roster_slots;
CREATE POLICY roster_slots__self_read ON public.roster_slots
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND employee_id = app.current_employee_id()
    AND is_published
  );

DROP POLICY IF EXISTS roster_slots__team_read ON public.roster_slots;
CREATE POLICY roster_slots__team_read ON public.roster_slots
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (app.is_manager_of(employee_id) OR (app.is_admin() AND app.admin_scope_covers(employee_id)))
  );

DROP POLICY IF EXISTS roster_slots__admin_write ON public.roster_slots;
CREATE POLICY roster_slots__admin_write ON public.roster_slots
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 3. Grants
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.rosters, public.roster_slots TO authenticated;
    GRANT INSERT, UPDATE ON public.rosters, public.roster_slots TO authenticated;  -- row access policy-gated (admin)
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.rosters, public.roster_slots TO service_role;
  END IF;
END $$;

COMMIT;
