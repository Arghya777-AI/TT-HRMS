-- =============================================================================
-- 20260801043500 — attaching a rostered day to a booking
-- =============================================================================
--
-- THE STATE 043100 LEFT BEHIND. `public.events` exists, `event_labour_demand`
-- states a required headcount per department, `v_event_coverage` joins the two —
-- and every `rostered_headcount` it emits is ZERO, because `roster_slots.event_id`
-- has its foreign key now and nothing has ever written to it.
--
-- Four screens say so honestly. That honesty is the point of this migration:
-- coverage that reads zero forever is not a feature, it is a well-documented gap.
--
-- ── WHY BY THE DAY, NOT BY THE SLOT ─────────────────────────────────────────
--
-- The obvious RPC is `set_slot_event(slot_id, event_id)`. It is also the wrong
-- shape for the work. A venue does not tag forty people one at a time; somebody
-- says "everyone on Saturday is on the Sharma wedding", and that sentence is one
-- action. Forty round trips is forty chances to stop halfway and leave a roster
-- half-attributed, which is worse than none — a coverage figure that is missing a
-- third of the floor reads as a shortfall and sends somebody chasing staff who are
-- already rostered.
--
-- So the unit is (roster, date): every working slot on that day, in one statement,
-- inside one transaction.
--
-- ── THE RULE WORTH ENFORCING: THE DATE MUST BE THE EVENT'S ──────────────────
--
-- Tagging Tuesday's slots to Saturday's wedding is the mistake this will actually
-- see, and it is invisible afterwards: the coverage screen would show the wedding
-- fully staffed by people who were not there. So the slot date must fall inside
-- the event's own span, from its CALL TIME (not its start — staff arrive before
-- guests, and an event beginning at 6pm is rostered from noon) to its end.
--
-- ── WEEKLY OFFS ARE SKIPPED, NOT REFUSED ────────────────────────────────────
--
-- A weekly-off row is a slot, but it is a person NOT working. Attaching one would
-- count somebody towards an event's cover while they are at home. They are passed
-- over silently rather than raising, because "everyone on Saturday" naturally
-- means everyone who is IN on Saturday, and refusing the whole day because one
-- person is off would be pedantry.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043500: attach_roster_day_to_event and detach_roster_day_from_event, so roster_slots.event_id is finally written and v_event_coverage stops reading zero', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Attach every working slot on one rostered day to one booking
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attach_roster_day_to_event(
  p_roster_id uuid,
  p_slot_date date,
  p_event_id  uuid
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event      public.events%ROWTYPE;
  v_roster     public.rosters%ROWTYPE;
  v_from       date;
  v_to         date;
  v_not_mine   integer;
  v_attached   integer;
BEGIN
  SELECT * INTO v_roster FROM public.rosters
   WHERE id = p_roster_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such roster.' USING errcode = 'P0002';
  END IF;

  SELECT * INTO v_event FROM public.events
   WHERE id = p_event_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such event.' USING errcode = 'P0002';
  END IF;

  /*
    A cancelled booking staffs nobody. Attaching to one would put people on a
    coverage sheet for a night that is not happening — and the roster would look
    committed when it is free.
  */
  IF v_event.status = 'cancelled' THEN
    RAISE EXCEPTION 'That event is cancelled, so nobody can be rostered against it.'
      USING errcode = '23514';
  END IF;

  /*
    The event's own span, in IST CIVIL DATES — from the call time where there is
    one, because that is when staff are required, and an event starting at 6pm is
    worked from noon. `util.ist_date` is the sanctioned conversion; comparing a
    date to a timestamptz directly would be read in UTC and drop the evening.
  */
  v_from := util.ist_date(COALESCE(v_event.call_time_at, v_event.starts_at));
  v_to   := util.ist_date(v_event.ends_at);

  IF p_slot_date < v_from OR p_slot_date > v_to THEN
    RAISE EXCEPTION
      'That date is not part of this event. % runs from % to %, and the roster day is %.',
      v_event.event_code, v_from, v_to, p_slot_date
      USING errcode = '23514';
  END IF;

  /*
    ── WHO MAY ────────────────────────────────────────────────────────────────
    The same whole-set rule `publish_roster` uses, and for the same reason: RLS is
    per row, so row by row a manager could attribute another department's people
    to their own event. Counted once, over the whole day.
  */
  IF NOT app.is_admin() THEN
    SELECT count(*)::integer INTO v_not_mine
      FROM public.roster_slots rs
     WHERE rs.roster_id = p_roster_id
       AND rs.slot_date = p_slot_date
       AND rs.deleted_at IS NULL
       AND NOT rs.is_weekly_off
       AND NOT app.is_manager_of(rs.employee_id);

    IF v_not_mine > 0 THEN
      RAISE EXCEPTION
        'This day rosters % person(s) who do not report to you, so it is not yours to assign. Ask HR.',
        v_not_mine
        USING errcode = '42501';
    END IF;
  END IF;

  UPDATE public.roster_slots rs
     SET event_id = p_event_id
   WHERE rs.roster_id = p_roster_id
     AND rs.slot_date = p_slot_date
     AND rs.deleted_at IS NULL
     /* See the header: an off day is a person not working. */
     AND NOT rs.is_weekly_off
     /* Idempotent — pressing it twice attaches nothing and reports nothing. */
     AND rs.event_id IS DISTINCT FROM p_event_id;

  GET DIAGNOSTICS v_attached = ROW_COUNT;
  RETURN v_attached;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.attach_roster_day_to_event(uuid, date, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.attach_roster_day_to_event(uuid, date, uuid) TO authenticated;

COMMENT ON FUNCTION public.attach_roster_day_to_event(uuid, date, uuid) IS
  'Attach every working slot on one rostered day to one event, and return how many moved. Refuses a cancelled event and a date outside the event span (call time to end, in IST). Weekly offs are skipped. Permitted for an administrator, or for a manager when the whole day is their own people.';

-- -----------------------------------------------------------------------------
-- 2. Undo it
-- -----------------------------------------------------------------------------
--
-- Its own function rather than "attach to NULL": passing NULL to the attach
-- function would skip every check above, including the ownership one, and a
-- manager would be able to strip another department's day off its event.

CREATE OR REPLACE FUNCTION public.detach_roster_day_from_event(
  p_roster_id uuid,
  p_slot_date date
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_not_mine integer;
  v_detached integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rosters
                  WHERE id = p_roster_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'No such roster.' USING errcode = 'P0002';
  END IF;

  IF NOT app.is_admin() THEN
    SELECT count(*)::integer INTO v_not_mine
      FROM public.roster_slots rs
     WHERE rs.roster_id = p_roster_id
       AND rs.slot_date = p_slot_date
       AND rs.deleted_at IS NULL
       AND rs.event_id IS NOT NULL
       AND NOT app.is_manager_of(rs.employee_id);

    IF v_not_mine > 0 THEN
      RAISE EXCEPTION
        'This day rosters % person(s) who do not report to you, so it is not yours to change. Ask HR.',
        v_not_mine
        USING errcode = '42501';
    END IF;
  END IF;

  UPDATE public.roster_slots rs
     SET event_id = NULL
   WHERE rs.roster_id = p_roster_id
     AND rs.slot_date = p_slot_date
     AND rs.deleted_at IS NULL
     AND rs.event_id IS NOT NULL;

  GET DIAGNOSTICS v_detached = ROW_COUNT;
  RETURN v_detached;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.detach_roster_day_from_event(uuid, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.detach_roster_day_from_event(uuid, date) TO authenticated;

COMMENT ON FUNCTION public.detach_roster_day_from_event(uuid, date) IS
  'Clear the event from every slot on one rostered day, and return how many moved. Its own function rather than attaching NULL, so the ownership check cannot be bypassed.';

-- -----------------------------------------------------------------------------
-- 3. What a week is covering — for the roster screens
-- -----------------------------------------------------------------------------
--
-- `v_event_coverage` answers "is this EVENT staffed". The roster screens ask the
-- mirror question — "what is this DAY working towards" — and answering it by
-- reading forty slot rows in a browser and grouping them is the client-side
-- aggregation this codebase keeps out of the browser.

CREATE OR REPLACE VIEW public.v_roster_day_events
WITH (security_invoker = true) AS
SELECT rs.roster_id,
       rs.slot_date,
       e.id          AS event_id,
       e.event_code,
       e.title,
       e.status,
       count(*)::integer AS slots_attached
  FROM public.roster_slots rs
  JOIN public.events e ON e.id = rs.event_id AND e.deleted_at IS NULL
 WHERE rs.deleted_at IS NULL
 GROUP BY rs.roster_id, rs.slot_date, e.id, e.event_code, e.title, e.status;

COMMENT ON VIEW public.v_roster_day_events IS
  'Which events one rostered day is working towards, with how many slots are attached to each. security_invoker, so the roster_slots and events policies decide visibility.';

GRANT SELECT ON public.v_roster_day_events TO authenticated;

COMMIT;
