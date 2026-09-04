/*
  Durations floor. A part-minute is not a minute.

  ── WHAT WAS HAPPENING ───────────────────────────────────────────────────────
  `util.minutes_between` divided the seconds by sixty and cast to integer, and a cast to
  integer in Postgres ROUNDS half away from zero. So

      54 seconds  ->  0.9   -> 1 minute
      1m 32s      ->  1.53  -> 2 minutes
      29 seconds  ->  0.48  -> 0 minutes

  Somebody scanning at 09:30:54 against a 09:30:00 shift was recorded a minute late for
  fifty-four seconds, and the dashboard said so. Rounding up a part-minute is the wrong
  direction on every figure it touches: it invents lateness, it invents early exits, and it
  inflates a span by up to thirty seconds per end.

  Flooring is the venue's rule and the conservative one: a minute is counted once it has
  actually elapsed. 1m 32s is one minute. 54 seconds is none.

  ── WHERE THIS LANDS ─────────────────────────────────────────────────────────
  Every duration the attendance engine derives goes through this one function — the day's
  span, the late and early figures, a break's length and a session's length. That is exactly
  why it is fixed here rather than at each call site: one definition, one behaviour, and no
  chance of two figures on the same row disagreeing about what a minute is.

  GREATEST(0, ...) stays. A negative duration means the two instants arrived in the wrong
  order, and clamping is still the right answer for that.
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
    -- floor, not a rounding cast: a part-minute has not elapsed yet.
    ELSE GREATEST(0, floor(EXTRACT(EPOCH FROM (p_to - p_from)) / 60)::integer)
  END;
$function$;

COMMENT ON FUNCTION util.minutes_between(timestamptz, timestamptz) IS
  'Whole elapsed minutes, FLOORED. A cast to integer would round, which turned 54 seconds '
  'into a minute of lateness. Negative intervals clamp to zero.';
