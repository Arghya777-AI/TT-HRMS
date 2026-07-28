-- =============================================================================
-- Migration 075 — a coordinate-to-address cache, so a punch can say WHERE.
--
-- WHY, IN THE CLIENT'S WORDS
-- --------------------------
--   "Instead of this that you need to do, just show the actual location. Show the
--    pinpointed location, the precise location. Also show the exact place name in
--    the details, like how Google Maps shows in details."
--
-- Geofencing is DROPPED as a product idea. The punch log no longer answers "was
-- this inside a boundary" — it answers "where was this". `attendance_punches`
-- already carries lat/lng/location_accuracy_m on every punch that had a fix (both
-- the web self-punch and the gate kiosk write them), so the missing piece is not
-- data collection. It is the human string: "Tamarind Tree, 12th Main Road,
-- Indiranagar, Bengaluru, Karnataka 560038". That string comes from a third-party
-- reverse geocoder, and this table is where it is kept.
--
-- `attendance_punches.geofence_ok` is deliberately LEFT ALONE. It is append-only
-- history with real rows behind it; dropping the column would rewrite the past.
-- It simply stops being rendered.
--
-- WHY A CACHE AT ALL, AND WHY THE KEY IS ROUNDED
-- ----------------------------------------------
-- One gate produces hundreds of punches a day at effectively one point. Reverse
-- geocoding each of them is (a) hundreds of identical HTTP calls for one answer,
-- (b) a straight violation of the OpenStreetMap Nominatim usage policy, which
-- allows 1 request/second and expects results to be cached, and (c) a page that
-- renders at the speed of somebody else's server.
--
-- So the lookup key is the coordinate ROUNDED TO 4 DECIMAL PLACES:
--
--     4 dp of latitude  ~= 11.1 m
--     4 dp of longitude ~= 10.8 m at Bengaluru's latitude (12.93 N)
--
-- That number was chosen from both sides:
--   * COARSE ENOUGH that consumer GPS jitter collapses to ONE row. Successive
--     fixes at the same doorway differ in the 5th and 6th decimal (metres); at
--     4 dp they are the same key, so the 300th punch of the day is a single-row
--     index hit and no HTTP call at all.
--   * FINE ENOUGH to still be a distinct place. 11 m separates a gate from the car
--     park, a building's front door from its back door, one shop in a row from the
--     next. 3 dp (~110 m) would merge the venue with the street outside it and the
--     client asked for "the pinpointed location"; 5 dp (~1 m) would give a fresh
--     row for every jittered fix and cache nothing.
--
-- Rounding is honest about one thing: a coordinate sitting exactly on a 0.0001
-- boundary can land in either of two adjacent squares depending on jitter, so one
-- physical doorway can occupy at most two rows. That costs one extra provider call
-- in a lifetime. It can never produce a WRONG address, because each row's address
-- was fetched for a coordinate inside that row's own square.
--
-- The key is a pair of STORED GENERATED columns over `util.geocode_key()`, not a
-- value the writer supplies. A caller cannot store a key that disagrees with the
-- coordinate it claims to describe, and the UNIQUE constraint is therefore an
-- invariant rather than a convention. Both the reader and the writer in
-- `supabase/functions/reverse-geocode` derive the lookup key with the SAME
-- expression -- util.geocode_key(<coord>::numeric(9,6)) -- so a hit is guaranteed
-- for any coordinate in the square. (Verified live before this migration was
-- written: two fixes 3.5 m apart collapse to one row and the ON CONFLICT path
-- fires.)
--
-- SCHEMA CHOICE: public, NOT secure. THE ARGUMENT.
-- -----------------------------------------------
-- A street address of where an employee punched IS personal data under the DPDP
-- Act once it is attached to that employee, and the instinct in this repo is to
-- put personal data in `secure` (unreachable over PostgREST, service-role only,
-- as with face templates). That instinct was considered and rejected here, for
-- three reasons:
--
--  1. A ROW IN THIS TABLE IS NOT ABOUT A PERSON. It carries no employee_id, no
--     punch id, no time of presence, no device — nothing but "the square around
--     12.9269, 77.6060 is called X". It is a dictionary, in the same class as a
--     postcode table. The personal datum is the JOIN of an address to a punch, and
--     that join is already gated where it belongs: `attendance_punches` RLS is
--     self-or-admin, and `v_team_punches` (migration 055) deliberately withholds
--     lat/lng from managers.
--
--  2. THE RESIDUAL RISK IS ENUMERATION, AND RLS IS THE RIGHT ANSWER TO IT. The
--     SET of keys is the set of places punches have happened, which for web
--     punches includes people's homes. So this table is emphatically NOT
--     world-readable: SELECT is restricted to admins and managers, and there is no
--     write policy for any client role at all. What a manager can learn from a row
--     is an address — never whose, never when.
--
--  3. `secure` WOULD DEFEAT THE CACHE. The punch log renders ~50 rows at a time.
--     Off PostgREST, the only way for the grid to obtain place names would be one
--     edge-function invocation per visible row on every render — 50 cold starts to
--     read 50 rows we already have. In `public` under RLS, the grid reads the
--     addresses it needs in one request, and only genuine misses reach the edge
--     function. The writer stays service-role-only either way, which is the
--     property that actually matters: nothing but `reverse-geocode` can put an
--     address in here.
--
-- NOT AUDITED, BY DESIGN. Filling a cache is not a business event, and this table
-- is deliberately absent from both `audit.reason_required_tables` and the audit
-- trigger attach list (migration 038) — otherwise every page render would demand a
-- 10-character reason and hash-chain a row. The verify block asserts that.
--
-- REVERSIBLE / OPERATIONS:
--   Force one place to be re-fetched:
--     DELETE FROM public.geocode_cache WHERE lat_key = 12.9269 AND lng_key = 77.6060;
--   Drop everything the provider failed on (they carry expires_at):
--     DELETE FROM public.geocode_cache WHERE expires_at IS NOT NULL AND expires_at <= now();
--   Remove the feature entirely:
--     DROP TABLE public.geocode_cache; DROP FUNCTION util.geocode_key(numeric);
-- =============================================================================

BEGIN;

-- No table touched here is in audit.reason_required_tables, but app.source is read
-- by util.stamp_row and the audit engine on anything this transaction happens to
-- brush against, and a migration that sets one and not the other has bitten this
-- repo before. Both, always.
SELECT set_config('app.reason', 'migration 075: cache reverse-geocoded place names per ~11 m coordinate square so the punch log can show where a punch happened without re-asking the geocoder', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. util.geocode_key — the ONE definition of the cache key
-- -----------------------------------------------------------------------------
-- IMMUTABLE is required (a STORED generated column may only use immutable
-- functions) and true: round(numeric, integer) has no dependence on locale, time
-- zone or search_path. STRICT so a NULL coordinate yields a NULL key rather than
-- a key over nothing; the column is NOT NULL, so such a row cannot be stored.
--
-- It exists as a function rather than an inline `round(lat, 4)` so that the
-- generated column and the edge function's lookup predicate cannot drift apart:
-- there is one expression, named, and changing the grid size is one CREATE OR
-- REPLACE plus a rebuild, not a hunt through TypeScript.
CREATE OR REPLACE FUNCTION util.geocode_key(p_coord numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT round(p_coord, 4);
$$;

COMMENT ON FUNCTION util.geocode_key(numeric) IS
  'Reverse-geocode cache key: a coordinate rounded to 4 dp (~11 m). Used by the '
  'generated key columns on public.geocode_cache AND by the reverse-geocode edge '
  'function''s lookup, so both sides always agree.';

-- -----------------------------------------------------------------------------
-- 2. public.geocode_cache
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.geocode_cache (
  id                uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- The fix that FIRST created this row. Provenance, not the key: it is kept as
  -- observed so an operator can see which exact coordinate produced the address,
  -- and it is never overwritten by a later fix in the same square (the square is
  -- the identity; the sample is history).
  -- numeric(9,6): 6 dp is ~0.11 m, well past any consumer GPS, and the scale is
  -- fixed so the value the key is derived from is byte-identical to the value the
  -- edge function casts on lookup.
  lat               numeric(9,6) NOT NULL,
  lng               numeric(9,6) NOT NULL,

  -- THE KEY. Generated, stored, and the only thing the UNIQUE constraint is on.
  lat_key           numeric(9,4) NOT NULL GENERATED ALWAYS AS (util.geocode_key(lat)) STORED,
  lng_key           numeric(9,4) NOT NULL GENERATED ALWAYS AS (util.geocode_key(lng)) STORED,

  -- What happened when we asked. A cache that stores only successes asks the
  -- provider again on every render for the coordinates that will never resolve —
  -- which is the exact abuse the usage policy forbids. See expires_at.
  --   resolved       an address came back and is below
  --   not_found      the provider answered, authoritatively, "nothing here"
  --   provider_error the provider failed or answered unusably
  outcome           text         NOT NULL,

  -- The full human string, as the provider composed it. This is what the client
  -- asked for: the line Google Maps shows in its details panel.
  display_name      text,

  -- The parts, split out. Typed columns rather than jsonb-only so a grid can join
  -- and render "Indiranagar, Bengaluru" without digging through jsonb, and so a
  -- future "group punches by locality" report is an index away.
  place_name        text,   -- venue / POI / building name, when the provider knows one
  road              text,
  suburb            text,   -- neighbourhood / locality / sublocality
  city              text,
  state             text,
  postcode          text,
  country           text,

  -- The provider's own address object, verbatim (trimmed of anything but the
  -- address block by the edge function). Providers name their fields differently
  -- and add new ones; keeping the raw block means a later need for, say, a
  -- district or a plus-code is a read, not a re-fetch of the whole city.
  provider_raw      jsonb        NOT NULL DEFAULT '{}'::jsonb,

  provider          text         NOT NULL,
  -- Nominatim place_id / Google place_id. The stable handle for the same place at
  -- the provider, useful when comparing two rows that describe one doorway.
  provider_place_id text,

  -- Populated only for outcome = 'provider_error': the caller-safe reason, so an
  -- operator reading the table knows whether it was a timeout, a 429 or a body
  -- that would not parse.
  failure_reason    text,

  fetched_at        timestamptz  NOT NULL DEFAULT now(),

  -- NULL for a resolved address = never expires. A street address for a fixed
  -- 11 m square does not go stale on any timescale this product cares about, and
  -- re-fetching one is pure provider load. Force a refresh with a DELETE.
  -- NOT NULL for the two failure outcomes = the negative cache: brief, so a bad
  -- coordinate stops hammering the provider on every page render, and short
  -- enough that a transient outage self-heals without an operator.
  expires_at        timestamptz,

  -- Cheap evidence that the cache is doing its job (and the number to quote when
  -- someone asks how many provider calls it saved).
  hit_count         integer      NOT NULL DEFAULT 0,
  last_hit_at       timestamptz,

  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT uq_geocode_cache__key UNIQUE (lat_key, lng_key),

  CONSTRAINT ck_geocode_cache__lat_range CHECK (lat BETWEEN -90  AND 90),
  CONSTRAINT ck_geocode_cache__lng_range CHECK (lng BETWEEN -180 AND 180),

  CONSTRAINT ck_geocode_cache__outcome
    CHECK (outcome IN ('resolved', 'not_found', 'provider_error')),

  CONSTRAINT ck_geocode_cache__provider
    CHECK (provider IN ('nominatim', 'google')),

  CONSTRAINT ck_geocode_cache__hit_count CHECK (hit_count >= 0),

  -- A resolved row MUST carry the string it exists to carry, and MUST NOT carry a
  -- failure reason or an expiry. This is what stops a half-written row from
  -- rendering as an address in the punch log.
  CONSTRAINT ck_geocode_cache__resolved_shape
    CHECK (outcome <> 'resolved' OR (
      display_name IS NOT NULL
      AND length(btrim(display_name)) > 0
      AND failure_reason IS NULL
      AND expires_at IS NULL
    )),

  -- A failed row MUST be empty of address text (nothing to render) and MUST
  -- expire (nothing to be stuck with).
  CONSTRAINT ck_geocode_cache__failed_shape
    CHECK (outcome = 'resolved' OR (
      display_name IS NULL
      AND place_name IS NULL AND road IS NULL AND suburb IS NULL
      AND city IS NULL AND state IS NULL AND postcode IS NULL AND country IS NULL
      AND provider_place_id IS NULL
      AND expires_at IS NOT NULL
    )),

  -- A provider failure has to say what failed; "not found" is its own explanation.
  CONSTRAINT ck_geocode_cache__failure_reason
    CHECK ((outcome = 'provider_error') = (failure_reason IS NOT NULL))
);

COMMENT ON TABLE public.geocode_cache IS
  'Reverse-geocoded place names keyed on the coordinate rounded to 4 dp (~11 m), '
  'so one gate is one row however many punches happen there. Carries no employee '
  'or punch reference: it is a coordinate-to-address dictionary. Read: admins and '
  'managers (RLS). Write: service_role only, from the reverse-geocode edge '
  'function. Not audited — a cache fill is not a business event.';

COMMENT ON COLUMN public.geocode_cache.lat_key IS
  'util.geocode_key(lat) — the ~11 m square this row describes. Generated, so it '
  'can never disagree with lat.';
COMMENT ON COLUMN public.geocode_cache.expires_at IS
  'NULL = a resolved address, kept indefinitely. NOT NULL = the negative cache for '
  'not_found / provider_error, deliberately brief.';

-- The only lookup path is the UNIQUE constraint's index. This second index serves
-- the negative-cache sweep (and is tiny, because resolved rows are excluded).
CREATE INDEX IF NOT EXISTS idx_geocode_cache__expires
  ON public.geocode_cache (expires_at)
  WHERE expires_at IS NOT NULL;

-- updated_at only. util.stamp_row/util.touch_row also write created_by/updated_by
-- from app.ctx_actor_id(), and recording WHICH ADMIN caused a cache fill would
-- turn a place dictionary into a log of who looked at where — the one thing this
-- table is careful not to be.
CREATE OR REPLACE FUNCTION public.geocode_cache_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_geocode_cache__touch ON public.geocode_cache;
CREATE TRIGGER trg_geocode_cache__touch BEFORE UPDATE ON public.geocode_cache
  FOR EACH ROW EXECUTE FUNCTION public.geocode_cache_touch();

-- -----------------------------------------------------------------------------
-- 3. RLS + grants — read for admins and managers, write for nobody
-- -----------------------------------------------------------------------------
-- The shape is copied from public.attendance_punches (migration 016): a SELECT
-- policy per audience, NO write policy for any client role at all, and the write
-- privileges revoked at the grant level as well so the absence of a policy is not
-- the only thing standing there.
ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS geocode_cache__admin_manager_read ON public.geocode_cache;
CREATE POLICY geocode_cache__admin_manager_read ON public.geocode_cache
  FOR SELECT TO authenticated
  USING (app.is_admin() OR app.is_manager());

-- NO INSERT/UPDATE/DELETE policies for client roles — deliberately absent, so an
-- address can only ever arrive through the reverse-geocode edge function.

DO $grants$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.geocode_cache FROM %I', v_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- SELECT only, and RLS narrows it to admins and managers.
    GRANT SELECT ON public.geocode_cache TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- The edge function: read (hit), insert (miss), update (hit counter and the
    -- upsert that replaces an expired negative), delete (sweep expired negatives).
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.geocode_cache TO service_role;
  END IF;
END
$grants$;

-- -----------------------------------------------------------------------------
-- 4. Verify — this migration either achieved all of it, or it did not happen
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_generated  integer;
  v_policies   integer;
  v_write_pol  integer;
  v_rows       integer;
  v_hits       integer;
  v_lat_key    numeric;
  v_lng_key    numeric;
  v_ok         boolean;
  -- Null Island. Deliberately not near any gate, so a probe row that somehow
  -- survived would be obviously synthetic rather than quietly wrong.
  c_lat_a      numeric := 0.000100;
  c_lng_a      numeric := 0.000200;
  -- ~3.5 m away: different 6 dp value, SAME 4 dp square.
  c_lat_b      numeric := 0.000132;
  c_lng_b      numeric := 0.000171;
BEGIN
  -- 4.1 The key columns are STORED GENERATED, not merely present. A plain column
  --     would let a writer store a key that lies about its coordinate.
  SELECT count(*) INTO v_generated
    FROM pg_attribute a
   WHERE a.attrelid = 'public.geocode_cache'::regclass
     AND a.attname IN ('lat_key', 'lng_key')
     AND a.attgenerated = 's';
  IF v_generated <> 2 THEN
    RAISE EXCEPTION 'migration 075: lat_key/lng_key are not both STORED generated columns (found %)', v_generated;
  END IF;

  -- 4.2 The UNIQUE constraint is on the rounded key and nothing else — that is
  --     the whole "one place, one row" guarantee.
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.geocode_cache'::regclass
       AND c.conname  = 'uq_geocode_cache__key'
       AND c.contype  = 'u'
       AND c.conkey   = ARRAY[
             (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'lat_key'),
             (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'lng_key')
           ]::smallint[]
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 075: uq_geocode_cache__key is missing or is not exactly (lat_key, lng_key)';
  END IF;

  -- 4.3 RLS on, and the policy set is read-only.
  SELECT relrowsecurity INTO v_ok FROM pg_class WHERE oid = 'public.geocode_cache'::regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 075: row level security is not enabled on public.geocode_cache';
  END IF;

  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'geocode_cache';
  SELECT count(*) INTO v_write_pol FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'geocode_cache' AND cmd <> 'SELECT';
  IF v_policies <> 1 OR v_write_pol <> 0 THEN
    RAISE EXCEPTION 'migration 075: expected exactly one SELECT policy and no write policy (policies=%, write=%)',
      v_policies, v_write_pol;
  END IF;

  -- 4.4 Privileges match the intent: clients read, only service_role writes.
  IF NOT has_table_privilege('authenticated', 'public.geocode_cache', 'SELECT') THEN
    RAISE EXCEPTION 'migration 075: authenticated cannot SELECT — admins and managers would see no place names';
  END IF;
  IF has_table_privilege('authenticated', 'public.geocode_cache', 'INSERT')
     OR has_table_privilege('authenticated', 'public.geocode_cache', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.geocode_cache', 'DELETE') THEN
    RAISE EXCEPTION 'migration 075: authenticated can write to the cache — an address must only come from the edge function';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_table_privilege('anon', 'public.geocode_cache', 'SELECT') THEN
    RAISE EXCEPTION 'migration 075: anon can read the cache — the set of keys is the set of places staff punch from';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND NOT has_table_privilege('service_role', 'public.geocode_cache', 'INSERT') THEN
    RAISE EXCEPTION 'migration 075: service_role cannot INSERT — the edge function could never fill the cache';
  END IF;

  -- 4.5 Not audited and not reason-gated. Either would make every cache fill fail
  --     or write a hash-chained row per page render.
  IF EXISTS (SELECT 1 FROM audit.reason_required_tables WHERE entity_table = 'public.geocode_cache') THEN
    RAISE EXCEPTION 'migration 075: public.geocode_cache is reason-gated — a cache fill has no business reason to give';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.geocode_cache'::regclass
       AND NOT t.tgisinternal
       AND t.tgfoid = 'audit.log_changes'::regproc
  ) THEN
    RAISE EXCEPTION 'migration 075: the audit trigger is attached to the cache — page renders would hash-chain audit rows';
  END IF;

  -- 4.6 THE FUNCTIONAL PROBE. Everything above is shape; this is behaviour: two
  --     fixes metres apart must collapse to ONE row, and the writer's upsert must
  --     take the UPDATE branch rather than raise.
  INSERT INTO public.geocode_cache (lat, lng, outcome, display_name, provider, provider_place_id)
  VALUES (c_lat_a, c_lng_a, 'resolved', 'migration 075 probe', 'nominatim', 'probe');

  INSERT INTO public.geocode_cache (lat, lng, outcome, display_name, provider)
  VALUES (c_lat_b, c_lng_b, 'resolved', 'migration 075 probe (jittered)', 'nominatim')
  ON CONFLICT ON CONSTRAINT uq_geocode_cache__key
  DO UPDATE SET hit_count = public.geocode_cache.hit_count + 1;

  SELECT count(*), max(hit_count), min(lat_key), min(lng_key)
    INTO v_rows, v_hits, v_lat_key, v_lng_key
    FROM public.geocode_cache
   WHERE lat_key = util.geocode_key(c_lat_a) AND lng_key = util.geocode_key(c_lng_a);

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'migration 075: two fixes ~3.5 m apart produced % cache rows — the key is not collapsing GPS jitter', v_rows;
  END IF;
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'migration 075: the ON CONFLICT upsert did not take the UPDATE branch (hit_count=%)', v_hits;
  END IF;
  IF v_lat_key <> 0.0001 OR v_lng_key <> 0.0002 THEN
    RAISE EXCEPTION 'migration 075: generated key is (%, %), expected (0.0001, 0.0002)', v_lat_key, v_lng_key;
  END IF;

  -- The lookup the edge function will actually run, with a THIRD coordinate in the
  -- same square, cast exactly as the function casts it.
  IF NOT EXISTS (
    SELECT 1 FROM public.geocode_cache
     WHERE lat_key = util.geocode_key(0.00014900::numeric(9,6))
       AND lng_key = util.geocode_key(0.00015100::numeric(9,6))
  ) THEN
    RAISE EXCEPTION 'migration 075: the edge function''s lookup expression does not find a row it should hit';
  END IF;

  -- 4.7 The shape CHECKs actually refuse the two rows that would break the UI:
  --     a "resolved" row with no address, and a failure with no expiry.
  BEGIN
    INSERT INTO public.geocode_cache (lat, lng, outcome, provider)
    VALUES (0.000300, 0.000400, 'resolved', 'nominatim');
    RAISE EXCEPTION 'migration 075: a resolved row with no display_name was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- expected
  END;

  BEGIN
    INSERT INTO public.geocode_cache (lat, lng, outcome, provider, failure_reason)
    VALUES (0.000300, 0.000400, 'provider_error', 'nominatim', 'probe');
    RAISE EXCEPTION 'migration 075: a failed row with no expires_at was accepted — the negative cache would be permanent';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- expected
  END;

  -- Probe rows are evidence, not data. Remove them.
  DELETE FROM public.geocode_cache
   WHERE lat_key = util.geocode_key(c_lat_a) AND lng_key = util.geocode_key(c_lng_a);
  IF EXISTS (SELECT 1 FROM public.geocode_cache) THEN
    RAISE NOTICE 'migration 075: cache already holds rows from an earlier run — probe rows removed, real rows kept';
  END IF;

  RAISE NOTICE 'migration 075: public.geocode_cache is live — key is 4 dp (~11 m), read is admin+manager, write is service_role only';
END
$verify$;

COMMIT;
