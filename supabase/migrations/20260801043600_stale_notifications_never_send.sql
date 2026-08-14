-- =============================================================================
-- 20260801043600 — a queued notification has a shelf life
-- =============================================================================
--
-- THE HAZARD THIS DEFUSES. `notification-dispatch` has been switched off for
-- months while `notifications` kept accumulating `queued` rows. Its claim query
-- caps retries and honours `expires_at`, but has NO age limit and orders by
-- `recorded_at` ASC — so the first run after it is enabled would work through the
-- entire backlog, oldest first, in batches of two hundred.
--
-- What that sends is not a nuisance, it is misinformation:
--
--   · "A leave request is waiting for your approval" — decided five weeks ago.
--   · "Your document expires in 30 days" — it expired in June.
--   · "Nobody has clocked in for the morning shift" — a Tuesday in April.
--
-- Every one arrives looking current, and each is somebody's afternoon spent
-- chasing a fact that stopped being true before the email was sent. The people
-- most affected are the ones with the most queued rows, which is to say the
-- managers and administrators who use the product most.
--
-- ── WHY EXPIRY AND NOT DELETION ─────────────────────────────────────────────
--
-- The rows are marked `suppressed`, not deleted. This codebase already answers
-- "why did I not get an email?" from the data rather than from memory — a
-- preference that suppressed it leaves a `suppressed` row, and so should a
-- backlog sweep. `failure_detail` carries the reason in words so nobody has to
-- infer it from a timestamp.
--
-- ── WHY A SETTING RATHER THAN A CONSTANT ────────────────────────────────────
--
-- The right cap is a judgement about this venue, not a fact about software. Three
-- days is the default because a notification nobody has acted on in three days
-- has been overtaken by the thing it was about — but a venue that closes for a
-- fortnight in the monsoon may want longer, and that is a setting change rather
-- than a deployment.
--
-- ── THIS DOES NOT TURN THE DISPATCHER ON ────────────────────────────────────
--
-- Deliberately. It removes one of the three reasons it is off. The others — the
-- per-run ceiling and the operational-code handling — are already in the function
-- (`DEFAULT_BATCH`/`MAX_BATCH`, `QUIET_HOURS_EXEMPT_CODES`), so after this the
-- remaining question is whether somebody wants to press the switch, not whether
-- pressing it is safe.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043600: expire_stale_notifications and notifications.max_age_hours, so enabling the dispatcher cannot blast a months-old backlog at everybody', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The cap, as a setting
-- -----------------------------------------------------------------------------

-- Per COMPANY, like every other seeded setting (004600): `settings` is scoped,
-- and a global row would be invisible to the resolver every screen uses.
INSERT INTO public.settings
  (company_id, key, value, value_kind, scope, group_name, label,
   is_sensitive, is_editable_by_admin)
SELECT c.id, 'notifications.max_age_hours', '72'::jsonb, 'number', 'company',
       'notifications', 'Stop sending a queued notification older than (hours)',
       false, true
  FROM public.companies c
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.settings s
      WHERE s.key = 'notifications.max_age_hours' AND s.company_id = c.id);

-- -----------------------------------------------------------------------------
-- 2. The sweep
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_stale_notifications(
  p_max_age_hours integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hours   integer;
  v_expired integer;
BEGIN
  /*
    The argument wins, then the setting, then 72. The argument exists so a run can
    be rehearsed at a different cap without editing the setting first — reading
    what a sweep WOULD do is how somebody gains the confidence to let it run.
  */
  v_hours := COALESCE(
    p_max_age_hours,
    (SELECT (s.value #>> '{}')::integer FROM public.settings s
      WHERE s.key = 'notifications.max_age_hours'
      ORDER BY s.company_id NULLS LAST LIMIT 1),
    72);

  IF v_hours < 1 THEN
    RAISE EXCEPTION 'a maximum age of % hour(s) would expire everything, including what was queued a minute ago', v_hours
      USING errcode = '23514';
  END IF;

  UPDATE public.notifications n
     SET status = 'suppressed',
         failure_detail = format(
           'not sent: queued %s hours ago, older than the %s-hour limit (notifications.max_age_hours)',
           round(EXTRACT(EPOCH FROM (now() - n.recorded_at)) / 3600)::text,
           v_hours::text)
   WHERE n.status = 'queued'
     AND n.recorded_at < now() - make_interval(hours => v_hours);

  GET DIAGNOSTICS v_expired = ROW_COUNT;

  IF v_expired > 0 THEN
    RAISE NOTICE 'suppressed % stale notification(s) older than % hours', v_expired, v_hours;
  END IF;
  RETURN v_expired;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.expire_stale_notifications(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.expire_stale_notifications(integer) TO service_role;

COMMENT ON FUNCTION public.expire_stale_notifications(integer) IS
  'Mark queued notifications older than notifications.max_age_hours (default 72) as suppressed, with the reason in failure_detail. Returns how many. Suppressed rather than deleted, so "why did I not get an email?" still has an answer in the data.';

-- -----------------------------------------------------------------------------
-- 3. How big is the backlog right now
-- -----------------------------------------------------------------------------
--
-- Read this BEFORE running the sweep or enabling anything. A number nobody has
-- looked at is the reason this migration is necessary.

CREATE OR REPLACE VIEW public.v_notification_backlog
WITH (security_invoker = true) AS
SELECT n.channel,
       count(*)::integer                                        AS queued,
       count(*) FILTER (WHERE n.recorded_at < now() - interval '72 hours')::integer
                                                                AS older_than_72h,
       min(n.recorded_at)                                       AS oldest,
       max(n.recorded_at)                                       AS newest
  FROM public.notifications n
 WHERE n.status = 'queued'
 GROUP BY n.channel;

COMMENT ON VIEW public.v_notification_backlog IS
  'Queued notifications per channel, how many are already past the default 72-hour limit, and how far back they go. Read this before enabling the dispatcher.';

GRANT SELECT ON public.v_notification_backlog TO authenticated;

COMMIT;
