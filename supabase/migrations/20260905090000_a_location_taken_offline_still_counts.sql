-- ============================================================================
-- A location taken with no signal still counts.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- "Even if the internet is not on, then we can access the GPS." That half is
-- correct: a phone's GPS receiver needs no network at all. What it cannot do is
-- SEND the reading — so a fix taken in a basement or a dead zone was simply lost.
--
-- For staff working away from the venue that is the wrong half to lose: the places
-- with no signal are exactly the places somebody is least accounted for.
--
-- So the app now queues a fix it cannot send and replays it when the network
-- returns, and this migration is the server half:
--
--   captured_offline   the device had no connectivity when the fix was taken
--   synced_at          when it finally reached the server, or NULL if it arrived live
--
-- ── THE REPLAYED FIX KEEPS ITS OWN INSTANT ──────────────────────────────────
-- `captured_at` is the moment the GPS answered, never the moment the row arrived.
-- The same discipline the gate's offline punch queue already keeps, and for the
-- same reason: a trail that re-dated its points to the sync would show somebody
-- teleporting to wherever they regained signal, all at once. `synced_at` carries
-- the arrival separately so the delay is visible instead of being hidden inside
-- the timestamp.
--
-- ── AND WHY BOTH FLAGS, NOT ONE ─────────────────────────────────────────────
-- `captured_offline` is about the DEVICE at capture time; `synced_at` is about the
-- ROW's journey. A fix can be taken online and still fail to send (a 502, a
-- dropped request), and one taken offline can sit for a day. Collapsing them would
-- lose the difference between "no signal there" and "our server was unreachable",
-- which are different facts about different things.
-- ============================================================================

SELECT set_config('app.reason',
  'location pings can be captured with no connectivity and replayed later, keeping their original capture instant',
  true);

ALTER TABLE public.employee_location_pings
  ADD COLUMN IF NOT EXISTS captured_offline boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS synced_at        timestamptz;

COMMENT ON COLUMN public.employee_location_pings.captured_offline IS
  'The device had no connectivity when the GPS answered. The fix is no less accurate for it — GPS needs no network — but it reached the server later.';
COMMENT ON COLUMN public.employee_location_pings.synced_at IS
  'When a queued fix finally arrived. NULL means it was sent live. captured_at is always the moment the GPS answered, never the moment the row landed.';

/*
  A replay can only ever be late, never early. Cheap to state and it catches a client
  that muddles the two timestamps — which is the one mistake that would quietly
  corrupt a trail's ordering.
*/
ALTER TABLE public.employee_location_pings
  DROP CONSTRAINT IF EXISTS ck_elp__synced_after_capture;
ALTER TABLE public.employee_location_pings
  ADD CONSTRAINT ck_elp__synced_after_capture
    CHECK (synced_at IS NULL OR synced_at >= captured_at);

-- ---------------------------------------------------------------------------
-- Recording one, live or replayed
-- ---------------------------------------------------------------------------
/*
  DROPPED FIRST: adding a parameter to a plpgsql function changes its signature, and
  leaving the old three-argument version in place would let a stale client keep
  writing rows with `captured_offline` silently false. One way in, always.
*/
DROP FUNCTION IF EXISTS public.record_location_ping(timestamptz, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.record_location_ping(
  p_captured_at timestamptz,
  p_lat         numeric,
  p_lng         numeric,
  p_accuracy_m  numeric DEFAULT NULL,
  /* True when the device had no connectivity as the GPS answered. */
  p_offline     boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER            -- the self-insert policy is the authorisation
SET search_path TO ''
AS $fn$
DECLARE
  v_emp  uuid := app.current_employee_id();
  v_id   uuid;
  v_loc  record;
  v_dist numeric;
BEGIN
  IF v_emp IS NULL THEN
    RAISE EXCEPTION 'no employee record for the signed-in account' USING errcode = '42501';
  END IF;

  SELECT l.lat, l.lng INTO v_loc
    FROM public.employees e
    JOIN public.locations l ON l.id = e.location_id
   WHERE e.id = v_emp AND l.lat IS NOT NULL AND l.lng IS NOT NULL;

  IF v_loc.lat IS NOT NULL THEN
    v_dist := 2 * 6371008.8 * asin(sqrt(
        power(sin(radians(p_lat - v_loc.lat) / 2), 2)
      + cos(radians(v_loc.lat)) * cos(radians(p_lat))
      * power(sin(radians(p_lng - v_loc.lng) / 2), 2)));
  END IF;

  INSERT INTO public.employee_location_pings
    (employee_id, captured_at, lat, lng, accuracy_m, source,
     within_shift, distance_m, captured_offline, synced_at)
  VALUES
    (v_emp, p_captured_at, p_lat, p_lng, p_accuracy_m, 'web_foreground',
     /*
       Resolved against the shift for the CAPTURE instant, not for now. A fix taken at
       21:40 and replayed at 09:00 the next morning was off-shift when it happened, and
       that is the fact the trail has to keep.
     */
     public.punch_within_shift(v_emp, p_captured_at, 0),
     round(v_dist, 1),
     COALESCE(p_offline, false),
     /* Only a replayed fix carries an arrival time; a live one has nothing to record. */
     CASE WHEN COALESCE(p_offline, false) THEN now() ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_location_ping(timestamptz, numeric, numeric, numeric, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_location_ping(timestamptz, numeric, numeric, numeric, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_location_ping(timestamptz, numeric, numeric, numeric, boolean) TO authenticated;
