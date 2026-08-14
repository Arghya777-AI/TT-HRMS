-- =============================================================================
-- 20260801044100 — delivering a scheduled report
-- =============================================================================
--
-- 043400 built the register: what to send, to whom, how often. It said plainly
-- that nothing dispatched it, and `last_dispatched_at` has been NULL on every row
-- since — which the screen reports as "Never sent", deliberately looking slightly
-- wrong.
--
-- ── THE SECOND TIME AN "EDGE FUNCTION" TURNED OUT NOT TO BE THE ANSWER ──────
--
-- The plan was a `report-render` function: build a file, attach it, hand it to the
-- mailer. Two problems with that, and the second is the important one.
--
--  1. It needs a deployment, and this venue runs SQL.
--  2. IT WOULD EMAIL PAYROLL DATA. A rendered muster or statutory register sitting
--     in an inbox is a copy nobody can withdraw, forwarded by whoever receives it,
--     readable by anybody who later opens that mailbox. The export engine already
--     refuses to produce those in a browser for exactly this reason.
--
-- So a scheduled report DOES NOT SEND A FILE. It sends a notification with a DEEP
-- LINK, through the dispatcher that is already deployed. The recipient clicks,
-- signs in, and the download happens under their own permissions — which means an
-- accountant who has left the venue stops being able to open last month's report
-- the moment their account is closed, rather than keeping every copy they were
-- ever sent.
--
-- That is a better feature than the one that was planned, and it needs no new
-- function at all.
--
-- ── WHAT THE LINK COSTS: EXTERNAL RECIPIENTS ────────────────────────────────
--
-- A consequence worth stating rather than discovering. `scheduled_report_recipients`
-- allows a bare email address for somebody with no login — an auditor, the
-- accountant. Those CANNOT be served by this delivery: `notifications` requires an
-- employee or a profile because it is a per-user feed, and more to the point a
-- link that needs a login is useless to somebody who has none.
--
-- They are skipped, counted, and named in `last_dispatch_note`, so the screen can
-- say so. Mailing them a link they will bounce off would be worse than saying it.
-- Serving them properly means an attachment, which is the thing this design
-- deliberately does not do.
--
-- ── A NEW SCHEDULE DOES NOT FIRE THE MOMENT THE JOB NEXT RUNS ───────────────
--
-- `next_run_at` is NULL on a freshly created schedule. Treating NULL as "due"
-- would send every schedule ever recorded on the first run of this function — the
-- same backlog blast 043600 was written to prevent, arriving from the other
-- direction. So a NULL is FILLED IN and skipped: the schedule waits for its first
-- real occurrence.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 044100: dispatch_due_scheduled_reports, delivering a scheduled report as a link through the existing notification dispatcher rather than emailing payroll data as an attachment', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. When is it next due
-- -----------------------------------------------------------------------------
--
-- A general cron parser in plpgsql would be a liability: five fields, ranges,
-- steps, lists, and every one of them a chance to fire a report at the wrong hour
-- on the wrong day. This handles exactly the shapes the picker in
-- `scheduled-reports.api.ts` can produce, and returns NULL for anything else so
-- the caller can say so rather than guess.

CREATE OR REPLACE FUNCTION util.next_schedule_run(
  p_cron  text,
  p_after timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_parts  text[];
  v_min    integer;
  v_hour   integer;
  v_dom    text;
  v_month  text;
  v_dow    text;
  v_local  timestamp;      -- IST wall clock
  v_today  date;
  v_cand   timestamp;
  v_i      integer;
BEGIN
  v_parts := regexp_split_to_array(btrim(p_cron), '\s+');
  IF array_length(v_parts, 1) <> 5 THEN RETURN NULL; END IF;

  BEGIN
    v_min  := v_parts[1]::integer;
    v_hour := v_parts[2]::integer;
  EXCEPTION WHEN others THEN
    RETURN NULL;   -- a minute or hour that is not a plain number
  END;
  v_dom := v_parts[3]; v_month := v_parts[4]; v_dow := v_parts[5];

  /* Only the every-month shapes are generated, and only those are honoured. */
  IF v_month <> '*' THEN RETURN NULL; END IF;
  IF v_min NOT BETWEEN 0 AND 59 OR v_hour NOT BETWEEN 0 AND 23 THEN RETURN NULL; END IF;

  v_local := (p_after AT TIME ZONE 'Asia/Kolkata');
  v_today := v_local::date;

  -- ── daily: 0 7 * * * ──────────────────────────────────────────────────────
  IF v_dom = '*' AND v_dow = '*' THEN
    v_cand := v_today + make_time(v_hour, v_min, 0);
    IF v_cand <= v_local THEN v_cand := v_cand + interval '1 day'; END IF;
    RETURN v_cand AT TIME ZONE 'Asia/Kolkata';
  END IF;

  -- ── weekly: 0 7 * * 1  (0 and 7 both mean Sunday, as cron has it) ─────────
  IF v_dom = '*' AND v_dow ~ '^[0-7]$' THEN
    FOR v_i IN 0..7 LOOP
      v_cand := (v_today + v_i) + make_time(v_hour, v_min, 0);
      IF EXTRACT(DOW FROM v_cand)::integer = (v_dow::integer % 7)
         AND v_cand > v_local THEN
        RETURN v_cand AT TIME ZONE 'Asia/Kolkata';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;

  -- ── the last day of the month: 0 17 28-31 * * ────────────────────────────
  IF v_dom = '28-31' AND v_dow = '*' THEN
    v_cand := (date_trunc('month', v_today) + interval '1 month - 1 day')::date
              + make_time(v_hour, v_min, 0);
    IF v_cand <= v_local THEN
      v_cand := (date_trunc('month', v_today + interval '1 month')
                 + interval '1 month - 1 day')::date + make_time(v_hour, v_min, 0);
    END IF;
    RETURN v_cand AT TIME ZONE 'Asia/Kolkata';
  END IF;

  -- ── monthly on a day: 0 7 1 * * ──────────────────────────────────────────
  IF v_dom ~ '^[0-9]{1,2}$' AND v_dow = '*' THEN
    IF v_dom::integer NOT BETWEEN 1 AND 28 THEN
      /* 29th to 31st is refused rather than silently moved: a report that skips
         February is worse than one that was never scheduled, and "end of month"
         has its own shape above. */
      RETURN NULL;
    END IF;
    v_cand := (date_trunc('month', v_today)::date + (v_dom::integer - 1))
              + make_time(v_hour, v_min, 0);
    IF v_cand <= v_local THEN
      v_cand := (date_trunc('month', v_today + interval '1 month')::date
                 + (v_dom::integer - 1)) + make_time(v_hour, v_min, 0);
    END IF;
    RETURN v_cand AT TIME ZONE 'Asia/Kolkata';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION util.next_schedule_run(text, timestamptz) IS
  'The next IST occurrence of a cron expression, for the four shapes the scheduled-report picker generates (daily, weekly on a weekday, monthly on days 1-28, and end of month). NULL for anything else — a partial cron parser that guesses is worse than one that declines.';

-- -----------------------------------------------------------------------------
-- 2. Send what is due
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_due_scheduled_reports()
RETURNS TABLE (schedule_code text, notified integer, note text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rep    record;
  v_rec    record;
  v_next   timestamptz;
  v_count  integer;
  v_skipped integer;
  v_link   text;
BEGIN
  FOR v_rep IN
    SELECT sr.* FROM public.scheduled_reports sr
     WHERE sr.deleted_at IS NULL AND sr.is_enabled
     ORDER BY sr.code
  LOOP
    v_next := util.next_schedule_run(v_rep.schedule_cron, now());

    /*
      A cadence this function cannot read. Recorded on the row rather than
      raising: one unreadable schedule must not stop the other eleven, and the
      screen shows the note beside the schedule that has it.
    */
    IF v_next IS NULL THEN
      UPDATE public.scheduled_reports
         SET last_dispatch_note = 'this cadence is not one the dispatcher can read, so nothing was sent'
       WHERE id = v_rep.id;
      schedule_code := v_rep.code; notified := 0;
      note := 'unreadable cadence';
      RETURN NEXT;
      CONTINUE;
    END IF;

    /* NEVER SCHEDULED BEFORE. Fill it in and wait — see the header. */
    IF v_rep.next_run_at IS NULL THEN
      UPDATE public.scheduled_reports
         SET next_run_at = v_next,
             last_dispatch_note = 'first run scheduled; nothing sent yet'
       WHERE id = v_rep.id;
      schedule_code := v_rep.code; notified := 0;
      note := 'first occurrence scheduled';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_rep.next_run_at > now() THEN
      CONTINUE;   -- not due
    END IF;

    /*
      THE LINK, NOT THE FILE. The recipient opens the register and downloads it
      under their own permissions, so access dies with their account rather than
      living forever in an inbox.
    */
    v_link := '/admin/analytics/scheduled?report=' || v_rep.id::text;
    v_count := 0;
    v_skipped := 0;

    FOR v_rec IN
      SELECT r.employee_id, r.email,
             COALESCE(r.email, p.email) AS to_email,
             e.profile_id
        FROM public.scheduled_report_recipients r
        LEFT JOIN public.employees e ON e.id = r.employee_id AND e.deleted_at IS NULL
        LEFT JOIN public.profiles  p ON p.id = e.profile_id
       WHERE r.scheduled_report_id = v_rep.id
    LOOP
      /*
        ── WHY AN EXTERNAL ADDRESS CANNOT BE REACHED THIS WAY ──────────────────
        `ck_notifications__recipient` requires an employee or a profile: the
        notification feed is per-USER, by design. A bare address belongs to
        somebody with no account — and the whole point of this delivery is a link
        the recipient opens under their own permissions, which they could not do.

        So they are counted and named in the note rather than silently dropped.
        Half-supporting them — mailing the link to somebody who will hit a login
        wall — would be worse than saying it plainly.
      */
      IF v_rec.profile_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      CONTINUE WHEN v_rec.to_email IS NULL;

      INSERT INTO public.notifications
        (employee_id, profile_id, event_code, channel, title, body, deep_link,
         priority, status, payload)
      VALUES
        (v_rec.employee_id, v_rec.profile_id, 'SCHEDULED_REPORT', 'email',
         v_rep.name,
         format('Your scheduled report "%s" is ready. Open it in the HRMS to download it — the file is not attached, so it stays inside the system.', v_rep.name),
         v_link, 'normal', 'queued',
         jsonb_build_object('scheduled_report_id', v_rep.id, 'subject', v_rep.subject));
      v_count := v_count + 1;
    END LOOP;

    UPDATE public.scheduled_reports
       SET last_dispatched_at = now(),
           next_run_at        = util.next_schedule_run(v_rep.schedule_cron, now()),
           last_dispatch_note = CASE
             WHEN v_count = 0 AND v_skipped > 0
               THEN format('nothing sent: all %s recipient(s) are external addresses, which cannot open a link that needs a login', v_skipped)
             WHEN v_count = 0
               THEN 'nobody to send to: no recipient has a usable address'
             WHEN v_skipped > 0
               THEN format('%s recipient(s) notified; %s external address(es) skipped — they have no account to open the link with', v_count, v_skipped)
               ELSE format('%s recipient(s) notified', v_count)
           END
     WHERE id = v_rep.id;

    schedule_code := v_rep.code; notified := v_count;
    note := CASE WHEN v_count = 0 THEN 'no usable recipients' ELSE 'notified' END;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dispatch_due_scheduled_reports() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.dispatch_due_scheduled_reports() TO service_role;

COMMENT ON FUNCTION public.dispatch_due_scheduled_reports() IS
  'Queue a notification per recipient for every scheduled report that is due, and advance next_run_at. Sends a LINK, never a file — the recipient downloads under their own permissions. A schedule with no next_run_at is scheduled and skipped rather than fired immediately. service_role only: this is a job, not a button.';

-- -----------------------------------------------------------------------------
-- 3. Register it as a job
-- -----------------------------------------------------------------------------
--
-- `cron_jobs` is the register of recurring work. Hourly, because a schedule is due
-- on the hour and a job that runs hourly can be at most an hour late — checking
-- every minute would be twenty-four times the work to gain a delay nobody notices
-- on a weekly report.

INSERT INTO public.cron_jobs
  (code, name, description, schedule_cron, schedule_human, target, target_name,
   is_enabled, overlap_policy, alert_on_failure)
SELECT 'scheduled-report-dispatch', 'Scheduled report dispatch',
       'Queues a notification for every scheduled report that has come due.',
       '5 * * * *', 'Five minutes past every hour',
       'sql_function', 'public.dispatch_due_scheduled_reports',
       /*
         DISABLED. Every other switch in this product is turned on by a person who
         has looked at what it will do first — and this one queues email. The
         register records that it exists and how to run it.
       */
       false, 'skip', true
 WHERE NOT EXISTS (SELECT 1 FROM public.cron_jobs WHERE code = 'scheduled-report-dispatch');

COMMIT;
