/*
  A part-minute counts against the venue, never against the employee.

  ── WHAT WAS REPORTED ────────────────────────────────────────────────────────
  "Why are you deducting 1 minute from each employee's working hours?"

  Measured, it is not a minute and it is not every employee — it is the fraction of a minute
  each person's day happens to end on, and it is dropped because `util.minutes_between` now
  FLOORS. Real rows from 4 September:

      Anuj S       09:11:43-17:44:42   512.99 min stored as 512   (0.99 lost)
      Deshappa S   08:54:56-17:34:31   519.59 min stored as 519   (0.59 lost)
      Chikkiramma  09:05:56-17:31:02   505.09 min stored as 505   (0.09 lost)

  Across 230 closed days it totals 115 minutes — about half a minute per person per day, and
  up to 59 seconds on a bad one. Small, but it only ever goes one way, and somebody watching
  their own hours will see it every day.

  ── FLOORING WAS RIGHT FOR THE THING IT WAS ASKED FOR ────────────────────────
  The floor was introduced for LATENESS, where it is generous: 54 seconds past the hour is not
  a minute late. Applied to WORKED time by the same shared function, the identical rule became
  stingy — 8h 00m 59s paid as 8h 00m.

  So the two part company here, on the principle that a part-minute should never count against
  the person:

    · durations — the day's span, a break, a session — ROUND to the nearest minute, so the
      error averages to nothing instead of always falling the same way;
    · punctuality — late, early exit — keeps its FLOOR, so a part-minute is never held
      against anybody.

  `util.minutes_between` is the duration one and reverts to rounding.
  `util.minutes_late` is new and floors, and section 9 of the engine is the only caller.
*/

CREATE OR REPLACE FUNCTION util.minutes_between(
  p_from timestamp with time zone,
  p_to   timestamp with time zone
)
RETURNS integer
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_from IS NULL OR p_to IS NULL THEN 0
    /*
      ROUND, not floor. This is a DURATION — how long somebody was here — and flooring it
      takes up to 59 seconds off every day in the same direction. Rounding averages out.
      Punctuality does not use this; it uses `util.minutes_late`, which floors on purpose.
    */
    ELSE GREATEST(0, round(EXTRACT(EPOCH FROM (p_to - p_from)) / 60.0)::integer)
  END;
$function$;

COMMENT ON FUNCTION util.minutes_between(timestamptz, timestamptz) IS
  'Whole elapsed minutes, ROUNDED to nearest — a duration, so the part-minute must not always '
  'fall against the employee. Lateness uses util.minutes_late, which floors.';

/*
  Punctuality. Floored, so a part-minute is never lateness: 54 seconds past the shift start is
  not a minute late, and 1m 32s is one minute, not two.
*/
CREATE OR REPLACE FUNCTION util.minutes_late(
  p_from timestamp with time zone,
  p_to   timestamp with time zone
)
RETURNS integer
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_from IS NULL OR p_to IS NULL THEN 0
    ELSE GREATEST(0, floor(EXTRACT(EPOCH FROM (p_to - p_from)) / 60.0)::integer)
  END;
$function$;

COMMENT ON FUNCTION util.minutes_late(timestamptz, timestamptz) IS
  'Whole elapsed minutes, FLOORED. For lateness and early exit only: a part-minute is never '
  'held against somebody. Durations use util.minutes_between, which rounds.';

REVOKE ALL ON FUNCTION util.minutes_late(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION util.minutes_late(timestamptz, timestamptz) TO authenticated, service_role;
