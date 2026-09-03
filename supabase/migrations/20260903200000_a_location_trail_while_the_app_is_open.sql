-- ============================================================================
-- A location trail for web and mobile users, captured while the app is open.
--
-- ── WHAT WAS ASKED FOR, AND WHERE THE CEILING IS ────────────────────────────
-- Asked for: "background geolocation tracking — create it and build it so that it
-- always tracks the GPS system. Not only a photo, but also it will track their live
-- locations." The venue holds signed consent from staff for location tracking.
--
-- Consent settles whether this SHOULD be built. It does not move the platform
-- ceiling, and the ceiling is worth stating in the schema so nobody later reads
-- gaps in this table as a fault:
--
--   * This product is a Vite PWA plus a thin WKWebView shell. There is no native
--     iOS or Android project, and the shell's entire JavaScript bridge is
--     `playSound` and `speak` — there is no background capability to switch on.
--   * A web page cannot watch position in the background. `watchPosition` is
--     suspended when the page is hidden, and the Geolocation API is not exposed to
--     service workers at all, so no amount of code in this repo can sample a
--     position while the app is closed.
--   * Genuinely continuous tracking needs a native app with iOS
--     `UIBackgroundModes: location` or an Android foreground service holding
--     ACCESS_BACKGROUND_LOCATION. That is a new application, an Apple Developer
--     account this venue does not yet hold, store review, and — by both platforms'
--     design — a permission prompt, a persistent status indicator and recurring
--     "used your location in the background" notices to every employee.
--
-- So this table holds what is actually obtainable: a point every few minutes while
-- somebody has the app open, which through a working day is most of the time they
-- are using it. It is a real trail, and it is honestly bounded. A day with no rows
-- means the app was closed, NOT that the employee was elsewhere — anyone reading
-- this as evidence has to know that, and the column comments say so.
--
-- ── COST, WHICH THE VENUE ASKED ABOUT DIRECTLY ──────────────────────────────
-- Throttled client-side to one point every five minutes AND only after fifty
-- metres of movement, so a person sitting at a desk writes roughly a dozen rows a
-- day rather than one every second. Eighty-three employees come to a few hundred
-- thousand rows a year, which one plain table with one index carries comfortably.
-- `purge_location_pings` exists so retention is a decision rather than a default.
-- ============================================================================

SELECT set_config('app.reason',
  'a location trail for web and mobile users, sampled while the app is open, under the signed tracking policy',
  true);

CREATE TABLE IF NOT EXISTS public.employee_location_pings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,

  captured_at   timestamptz NOT NULL,
  /* IST, so a day's trail is one indexed equality rather than a range over a timezone. */
  ist_date      date GENERATED ALWAYS AS (util.ist_date(captured_at)) STORED,

  lat           numeric(9,6)  NOT NULL,
  lng           numeric(9,6)  NOT NULL,
  /*
    The browser's own accuracy radius, in metres. KEPT AND SHOWN, never discarded: a
    point good to 2 km and a point good to 8 m look identical on a map and mean
    completely different things. A reading with no accuracy is not evidence.
  */
  accuracy_m    numeric(8,2),

  /*
    Where the sample came from. 'web_foreground' is the only writer today. A future
    native build would add its own value rather than pretend to be this one, so a
    reader can always tell a foreground sample from a background one.
  */
  source        text NOT NULL DEFAULT 'web_foreground',

  /* Answered by the server at capture time, so the trail can be read without
     re-deriving somebody's shift months later. */
  within_shift  boolean,
  /* Metres from the venue, by the same haversine the punch screens use. */
  distance_m    numeric(10,1),

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_elp__lat        CHECK (lat  BETWEEN -90  AND 90),
  CONSTRAINT ck_elp__lng        CHECK (lng  BETWEEN -180 AND 180),
  CONSTRAINT ck_elp__accuracy   CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CONSTRAINT ck_elp__source     CHECK (source IN ('web_foreground', 'native_background', 'punch')),
  /* Five minutes of clock skew, matching the punch table's own tolerance. A point
     from the future is a broken device clock, not a location. */
  CONSTRAINT ck_elp__not_future CHECK (captured_at <= now() + interval '5 minutes')
);

COMMENT ON TABLE public.employee_location_pings IS
  'Location samples taken while the app is OPEN. A gap means the app was closed, not that the employee was absent — web pages cannot sample position in the background, so this trail is bounded by design and must never be read as continuous.';
COMMENT ON COLUMN public.employee_location_pings.accuracy_m IS
  'The browser''s accuracy radius in metres. A point good to 2 km and one good to 8 m look the same on a map; show this beside every point.';
COMMENT ON COLUMN public.employee_location_pings.source IS
  'web_foreground: sampled while the PWA was visible. punch: captured with a punch. native_background: reserved for a native app, which does not exist yet.';

/* One employee's day, which is every query this table serves. */
CREATE INDEX IF NOT EXISTS ix_elp__employee_day
  ON public.employee_location_pings (employee_id, ist_date, captured_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.employee_location_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_location_pings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS elp__self_insert  ON public.employee_location_pings;
DROP POLICY IF EXISTS elp__self_select  ON public.employee_location_pings;
DROP POLICY IF EXISTS elp__admin_select ON public.employee_location_pings;
DROP POLICY IF EXISTS elp__admin_delete ON public.employee_location_pings;

/*
  The employee's own browser writes these, so INSERT is scoped to their own id and
  nothing else. `source` is pinned to 'web_foreground' in the policy: a client must
  not be able to label its own sample as a background reading it did not take.
*/
CREATE POLICY elp__self_insert ON public.employee_location_pings
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id() AND source = 'web_foreground');

/*
  AN EMPLOYEE CAN SEE THEIR OWN TRAIL. Deliberate, and not merely permitted: the
  venue holds signed consent, and a policy people have signed is one they are
  entitled to see the effect of. A tracking record its subject cannot read is the
  version that causes trouble later.
*/
CREATE POLICY elp__self_select ON public.employee_location_pings
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

CREATE POLICY elp__admin_select ON public.employee_location_pings
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

/* Retention is an administrator's act. Nobody may edit a point — a trail that can be
   rewritten is not a trail — so there is no UPDATE policy at all. */
CREATE POLICY elp__admin_delete ON public.employee_location_pings
  FOR DELETE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

/*
  ── REVOKE BEFORE GRANT, AND FROM `authenticated` BY NAME ──────────────────
  Supabase ships `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
  authenticated`, so a table created here arrives with UPDATE already granted to
  every signed-in user. A `GRANT SELECT, INSERT, DELETE` is ADDITIVE and removes
  nothing — the first version of this migration did exactly that, and a test then
  rewrote a recorded point successfully. A trail whose rows can be edited is not a
  trail.

  `REVOKE ALL FROM PUBLIC` would not have helped either: PUBLIC and a named role
  are different grantees, and the default privileges name the roles.
*/
REVOKE ALL ON TABLE public.employee_location_pings FROM PUBLIC;
REVOKE ALL ON TABLE public.employee_location_pings FROM anon;
REVOKE ALL ON TABLE public.employee_location_pings FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.employee_location_pings TO authenticated;

-- ---------------------------------------------------------------------------
-- Recording one point
-- ---------------------------------------------------------------------------
/*
  A function rather than a bare INSERT so `within_shift` and `distance_m` are
  answered by the server. Both are facts about the moment of capture: re-deriving
  somebody's shift or the venue's coordinates months later would read the trail
  against configuration that has since changed.
*/
CREATE OR REPLACE FUNCTION public.record_location_ping(
  p_captured_at timestamptz,
  p_lat         numeric,
  p_lng         numeric,
  p_accuracy_m  numeric DEFAULT NULL)
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

  /* The venue, for the distance. Its own coordinates, not a constant in code. */
  SELECT l.lat, l.lng INTO v_loc
    FROM public.employees e
    JOIN public.locations l ON l.id = e.location_id
   WHERE e.id = v_emp AND l.lat IS NOT NULL AND l.lng IS NOT NULL;

  IF v_loc.lat IS NOT NULL THEN
    /*
      Haversine, in metres. 6371008.8 m is the IUGG mean Earth radius — the same
      figure `_shared/geofence.ts` uses, so the map and the punch screens cannot
      disagree about how far away somebody was.
    */
    v_dist := 2 * 6371008.8 * asin(sqrt(
        power(sin(radians(p_lat - v_loc.lat) / 2), 2)
      + cos(radians(v_loc.lat)) * cos(radians(p_lat))
      * power(sin(radians(p_lng - v_loc.lng) / 2), 2)));
  END IF;

  INSERT INTO public.employee_location_pings
    (employee_id, captured_at, lat, lng, accuracy_m, source, within_shift, distance_m)
  VALUES
    (v_emp, p_captured_at, p_lat, p_lng, p_accuracy_m, 'web_foreground',
     public.punch_within_shift(v_emp, p_captured_at, 0),
     round(v_dist, 1))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_location_ping(timestamptz, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_location_ping(timestamptz, numeric, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_location_ping(timestamptz, numeric, numeric, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
/*
  HR asked for the evidence to be removable once a decision is made. Automatic
  deletion was deliberately NOT wired to a cron job: "DB deletion we cannot give
  automation process because then somebody delete you only." So this is a function
  an administrator runs, with a floor on the window so a slip cannot empty the table.
*/
CREATE OR REPLACE FUNCTION public.purge_location_pings(p_older_than_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE v_n integer;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'only an administrator can purge the location trail' USING errcode = '42501';
  END IF;
  IF p_older_than_days IS NULL OR p_older_than_days < 7 THEN
    RAISE EXCEPTION 'refusing to purge anything newer than seven days (asked for %)', p_older_than_days
      USING errcode = '22023';
  END IF;

  DELETE FROM public.employee_location_pings
   WHERE captured_at < now() - make_interval(days => p_older_than_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_location_pings(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_location_pings(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.purge_location_pings(integer) TO authenticated;
