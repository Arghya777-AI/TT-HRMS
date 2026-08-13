-- =============================================================================
-- 20260801043200 — publishing a roster, and a manager's own slots
-- =============================================================================
--
-- REPORTED, on /team/roster: "Publishing is not offered here, and is not being
-- faked. Migration 015 routes roster slot writes through a roster edge function,
-- no such function is deployed, and no publish_roster RPC exists in any
-- migration."
--
-- ── HALF OF THAT WAS TRUE, AND THE OTHER HALF MATTERS MORE ──────────────────
--
-- `roster_slots__admin_write` and `rosters__admin_write` both exist and are `FOR
-- ALL` — so an ADMINISTRATOR has been able to write and publish rosters since
-- 001500, and the client simply never did it. That is the same shape as the
-- lifecycle events: an absent RPC read as an absent write path.
--
-- But /team/roster is a MANAGER'S screen, and for a manager the notice was
-- entirely true: `app.is_admin()` is false, so every write was refused. At a
-- venue the section head builds Saturday's roster — the person who knows who can
-- carry a tray is not the person with an admin login — and none of them could
-- touch it.
--
-- ── WHY AN RPC RATHER THAN A WIDER POLICY ───────────────────────────────────
--
-- A policy permitting a manager to write `roster_slots` would have to be written
-- as "every slot on this roster belongs to somebody who reports to me", and RLS
-- is evaluated PER ROW. Row by row, a manager could add their own person to
-- somebody else's roster, or publish a week where only their own slots are theirs
-- and the rest belong to another department. The rule is about the roster as a
-- WHOLE, so it has to be checked once, over the whole set — which is a function,
-- not a policy.
--
-- ── PUBLISHING IS NOT EDITING ───────────────────────────────────────────────
--
-- This adds one act: move a draft to published. It deliberately does NOT add a
-- slot-writing RPC. Building the roster stays with an administrator for now,
-- because "who may put whom on which shift" involves shift eligibility, rest
-- rules and overlapping bookings, and inventing that in the same migration as a
-- status change would be two features wearing one coat.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043200: publish_roster, so a draft week can be published by an administrator or by the manager whose own people it rosters', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.publish_roster(
  p_roster_id uuid,
  p_reason    text DEFAULT NULL
)
RETURNS public.rosters
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor    uuid := app.ctx_actor_id();
  v_roster   public.rosters%ROWTYPE;
  v_slots    integer;
  v_not_mine integer;
BEGIN
  SELECT * INTO v_roster FROM public.rosters
   WHERE id = p_roster_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such roster.' USING errcode = 'P0002';
  END IF;

  IF v_roster.status = 'published' THEN
    RETURN v_roster;  -- already out; pressing it twice is not an error
  END IF;
  IF v_roster.status = 'locked' THEN
    RAISE EXCEPTION 'This roster week is locked and cannot be published again.'
      USING errcode = '23514';
  END IF;

  SELECT count(*)::integer INTO v_slots
    FROM public.roster_slots rs
   WHERE rs.roster_id = p_roster_id AND rs.deleted_at IS NULL;

  /*
    An empty week is the one thing publishing must refuse. A published roster is
    what the team reads to know when to come in; publishing nothing tells
    everybody they are not needed, silently and for a whole week.
  */
  IF v_slots = 0 THEN
    RAISE EXCEPTION
      'There is nothing on this roster to publish. Add the shifts first.'
      USING errcode = '23514';
  END IF;

  /*
    ── WHO MAY PUBLISH ────────────────────────────────────────────────────────
    An administrator, or a manager for whom EVERY slot on the week belongs to one
    of their own people. Counted rather than tested row by row, because the rule
    is about the whole roster: a week that mixes two departments' people is not
    one manager's to publish, even if some of it is theirs.
  */
  IF NOT app.is_admin() THEN
    SELECT count(*)::integer INTO v_not_mine
      FROM public.roster_slots rs
     WHERE rs.roster_id = p_roster_id
       AND rs.deleted_at IS NULL
       AND NOT app.is_manager_of(rs.employee_id);

    IF v_not_mine > 0 THEN
      RAISE EXCEPTION
        'This roster includes % person(s) who do not report to you, so it is not yours to publish. Ask HR to publish it.',
        v_not_mine
        USING errcode = '42501';
    END IF;
  END IF;

  /*
    `ck_rosters__published_fields` demands published_by AND published_at whenever
    the status is not draft, so all three move in one statement — the constraint
    would refuse anything less, which is exactly why it is there.
  */
  UPDATE public.rosters
     SET status       = 'published',
         published_by = v_actor,
         published_at = now(),
         notes        = CASE
                          WHEN p_reason IS NULL OR btrim(p_reason) = '' THEN notes
                          WHEN notes IS NULL THEN btrim(p_reason)
                          ELSE notes || E'\n' || btrim(p_reason)
                        END
   WHERE id = p_roster_id
  RETURNING * INTO v_roster;

  RETURN v_roster;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.publish_roster(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.publish_roster(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.publish_roster(uuid, text) IS
  'Move a draft roster week to published. Permitted for an administrator, or for a manager when every slot on the week belongs to one of their own reportees — a whole-roster rule, which is why it is a function and not an RLS policy. Refuses an empty week and a locked one; publishing twice is a no-op.';

COMMIT;
