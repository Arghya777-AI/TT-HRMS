-- =============================================================================
-- Migration 002 — util.* helper functions
-- Source: docs/plan/04-data-model.md §6.2 (exact SQL, transcribed verbatim),
--         §4.7 (util.mask_tail exact SQL), §1.8 (Verhoeff Aadhaar validation);
--         docs/build/spec-migrations.md §2 row 002.
--
-- Functions: ist_ts, ist_date, ist_time, ist_instant, ist_today,
--            minutes_between, business_date, week_of_month, financial_year,
--            mask_tail, sha256_hex, is_valid_aadhaar (Verhoeff), slugify.
--
-- These are the canonical time/identity helpers. Generated columns, index
-- expressions, partition keys and CHECK constraints depend on them — their
-- signatures are frozen; later migrations CALL them, never redefine them.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS util;  -- defensive; created in migration 001

-- -----------------------------------------------------------------------------
-- 1. IST time helpers (§6.2 — exact SQL)
-- -----------------------------------------------------------------------------

-- IMMUTABLE wrapper. Required because generated columns and index expressions
-- reject STABLE functions, and `ts AT TIME ZONE 'Asia/Kolkata'` is only STABLE
-- (Postgres must assume the tz database could change).
--
-- Safety of the IMMUTABLE assertion: Asia/Kolkata has been a fixed UTC+05:30
-- with no DST since 1945; the risk of a tzdata change altering historic values
-- is effectively zero. Documented risk acceptance: IF the IANA definition of
-- Asia/Kolkata ever changes, every index and generated column depending on
-- these functions must be rebuilt (REINDEX + a full attendance recompute).
-- That procedure is written up in 08-architecture.md §Runbooks.
CREATE OR REPLACE FUNCTION util.ist_ts(p_ts timestamptz)
RETURNS timestamp
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT p_ts AT TIME ZONE 'Asia/Kolkata';
$$;

CREATE OR REPLACE FUNCTION util.ist_date(p_ts timestamptz)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
$$;

CREATE OR REPLACE FUNCTION util.ist_time(p_ts timestamptz)
RETURNS time
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
$$;

-- The inverse: build a UTC instant from an IST date + wall-clock time.
-- Used to materialise shift_start_at / shift_end_at.
CREATE OR REPLACE FUNCTION util.ist_instant(p_date date, p_time time)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT ((p_date + p_time) AT TIME ZONE 'Asia/Kolkata');
$$;

-- "Today" and "now" in IST business terms.
CREATE OR REPLACE FUNCTION util.ist_today()
RETURNS date LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT util.ist_date(now());
$$;

-- Whole minutes between two instants, always non-negative, NULL-safe.
CREATE OR REPLACE FUNCTION util.minutes_between(p_from timestamptz, p_to timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_from IS NULL OR p_to IS NULL THEN 0
    ELSE GREATEST(0, (EXTRACT(EPOCH FROM (p_to - p_from)) / 60)::integer)
  END;
$$;

-- Business date with a shift day-cutover. A punch at 02:10 IST on 15-Feb for a
-- night shift whose cutover is 05:00 belongs to business date 14-Feb.
CREATE OR REPLACE FUNCTION util.business_date(p_ts timestamptz, p_cutover time DEFAULT '05:00')
RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT CASE
    WHEN (p_ts AT TIME ZONE 'Asia/Kolkata')::time < p_cutover
      THEN ((p_ts AT TIME ZONE 'Asia/Kolkata')::date - 1)
    ELSE   ((p_ts AT TIME ZONE 'Asia/Kolkata')::date)
  END;
$$;

-- Week-of-month for the weekly-off engine (calendar day-of-month basis).
CREATE OR REPLACE FUNCTION util.week_of_month(p_date date)
RETURNS smallint LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT (ceil(EXTRACT(DAY FROM p_date) / 7.0))::smallint;   -- 1..5
$$;

-- IST financial year label: 2026-07-25 -> '2026-27'
CREATE OR REPLACE FUNCTION util.financial_year(p_date date)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT CASE WHEN EXTRACT(MONTH FROM p_date) >= 4
    THEN EXTRACT(YEAR FROM p_date)::int || '-' || right((EXTRACT(YEAR FROM p_date)::int + 1)::text, 2)
    ELSE (EXTRACT(YEAR FROM p_date)::int - 1) || '-' || right(EXTRACT(YEAR FROM p_date)::text, 2)
  END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Masking helper (§4.7 — exact SQL)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION util.mask_tail(p_value text, p_visible integer DEFAULT 4, p_mask char DEFAULT 'X')
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_value IS NULL OR length(p_value) = 0 THEN NULL
    WHEN length(p_value) <= p_visible THEN repeat(p_mask, length(p_value))
    ELSE repeat(p_mask, length(p_value) - p_visible) || right(p_value, p_visible)
  END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Hashing helper
-- -----------------------------------------------------------------------------

-- Hex-encoded SHA-256 of a UTF-8 text value. Uses the pg_catalog builtin
-- sha256() (PG11+) rather than pgcrypto digest() so the body needs no
-- environment-dependent extension schema qualification (pgcrypto lives in
-- `extensions` on hosted Supabase and `public` on the validation harness).
CREATE OR REPLACE FUNCTION util.sha256_hex(p_value text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(p_value, 'UTF8')), 'hex');
$$;

-- -----------------------------------------------------------------------------
-- 4. Aadhaar Verhoeff validation (§1.8)
-- -----------------------------------------------------------------------------

-- Verhoeff checksum over the full 12-digit Aadhaar number (the 12th digit is
-- the check digit; the number is valid when the running Verhoeff checksum of
-- the reversed digit string is 0). Also enforces the structural rule from
-- ck_aadhaar: 12 digits, first digit 2-9 (rejects 0/1-prefixed impossibilities
-- and float-mangled imports like 1.0202E+11).
-- STRICT: NULL in -> NULL out, so CHECK (util.is_valid_aadhaar(col)) passes
-- for NULL columns, matching the "open value is NULL" convention.
CREATE OR REPLACE FUNCTION util.is_valid_aadhaar(p_value text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $$
DECLARE
  -- Verhoeff dihedral group D5 multiplication table.
  d int[] := ARRAY[
    [0,1,2,3,4,5,6,7,8,9],
    [1,2,3,4,0,6,7,8,9,5],
    [2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],
    [4,0,1,2,3,9,5,6,7,8],
    [5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],
    [7,6,5,9,8,2,1,0,4,3],
    [8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]];
  -- Verhoeff permutation table.
  p int[] := ARRAY[
    [0,1,2,3,4,5,6,7,8,9],
    [1,5,7,6,2,8,3,0,9,4],
    [5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0],
    [4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],
    [7,0,4,6,9,1,3,2,5,8]];
  v_reversed text;
  v_digit    int;
  v_check    int := 0;
  i          int;
BEGIN
  IF p_value !~ '^[2-9][0-9]{11}$' THEN
    RETURN false;
  END IF;

  v_reversed := reverse(p_value);
  FOR i IN 0 .. 11 LOOP
    v_digit := substr(v_reversed, i + 1, 1)::int;
    v_check := d[v_check + 1][ p[(i % 8) + 1][v_digit + 1] + 1 ];
  END LOOP;

  RETURN v_check = 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Slugify
-- -----------------------------------------------------------------------------

-- Accent-folded, lowercase, hyphen-separated slug: 'Café  Crème!' -> 'cafe-creme'.
-- The unaccent extension's schema differs between environments (`extensions`
-- on hosted Supabase, `public` on the validation harness), so the function is
-- created dynamically with the resolved schema baked in — the body stays fully
-- schema-qualified under SET search_path = ''. The two-argument unaccent form
-- is used because the one-argument form resolves its dictionary via
-- search_path, which is empty inside the function.
-- IMMUTABLE is the same documented risk acceptance as util.ist_ts: the
-- unaccent dictionary shipping with the extension is treated as fixed.
DO $$
DECLARE
  v_schema text;
  v_dict   text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'unaccent';

  IF v_schema IS NOT NULL THEN
    v_dict := quote_ident(v_schema) || '.unaccent';
    EXECUTE format($fmt$
      CREATE OR REPLACE FUNCTION util.slugify(p_value text)
      RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $fn$
        SELECT btrim(
                 regexp_replace(
                   lower(%I.unaccent(%L::regdictionary, p_value)),
                   '[^a-z0-9]+', '-', 'g'),
                 '-');
      $fn$;
    $fmt$, v_schema, v_dict);
  ELSE
    -- unaccent unavailable (should not happen: created in migration 001).
    -- Degrade to a non-folding slug rather than failing the build.
    RAISE NOTICE 'unaccent extension not found; util.slugify created without accent folding';
    CREATE OR REPLACE FUNCTION util.slugify(p_value text)
    RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = '' AS $fn$
      SELECT btrim(regexp_replace(lower(p_value), '[^a-z0-9]+', '-', 'g'), '-');
    $fn$;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------

-- util.* is called from RLS policies, CHECK constraints, generated columns and
-- security_invoker views, all of which evaluate as the querying role — so
-- `authenticated` (and service_role) need schema USAGE + EXECUTE. `anon` gets
-- nothing. Guarded: the Supabase roles may not exist on the validation harness.
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA util TO %I', v_role);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA util TO %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA util GRANT EXECUTE ON FUNCTIONS TO %I', v_role);
    ELSE
      RAISE NOTICE 'role % does not exist here, grant skipped', v_role;
    END IF;
  END LOOP;
END $$;

COMMIT;
