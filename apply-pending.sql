-- =============================================================================
-- PENDING: run these in order. 041400 and 041500 are already applied.
--
--   041600  leave rules      — reason per type, monthly ceiling, approval
--                              request + notification on submit, SL catch-up
--   041700  opening balance  — Earned Leave 32.5, admin-editable
--   041800  sick leave       — may be combined with other types again
-- =============================================================================


-- ###########################################################################
-- 20260801041600_leave_rules_notifications_and_accrual.sql
-- ###########################################################################

-- =============================================================================
-- 20260801041600 — leave: reason only where it is needed, a monthly ceiling,
--                  and an application that actually reaches the manager
-- =============================================================================
--
-- FOUR THINGS WERE REPORTED. THE THIRD IS THE ONE THAT MATTERS.
--
--   1. "for sick leave reason is mandatory / for rest of part reason is not
--      mandatory" — today `ck_lr__reason` demands ten characters on EVERY leave
--      request, whatever the type.
--   2. "maximum month leave" — nothing in `leave_types` caps how much of a type
--      can be taken inside one calendar month. `max_days_per_request` caps ONE
--      request, which four separate requests walk straight past.
--   3. "if employee is applying for 3 or more than then manager should be
--      notify via mail and notification / if less than 3 then show only
--      notification".
--   4. "sick leave should be rewarded per month and it should be visible at
--      dashboard".
--
-- ── (3) IS NOT A NOTIFICATION BUG. THE APPLICATION NEVER REACHED ANYBODY ─────
--
-- Filing leave writes `leave_requests` rows and NOTHING ELSE. Nothing calls
-- `create_approval_request`, so no `approval_requests` row is ever created for a
-- real leave application — the only place in the whole repo that raises one for
-- leave is the DEMO SEED (005400). Consequences, all of them verified by
-- reading, not guessed:
--
--   · `/team/approvals` reads `v_approval_inbox`, which reads
--     `approval_requests`. A manager sees an empty queue.
--   · `/admin/workflow/inbox` likewise.
--   · `sla_sweep` has nothing to sweep, so no SLA clock ever runs on leave.
--   · `leave_requests.approval_request_id` — a column since 019 — is NULL on
--     every row, and `decideApproval`'s leave branch, which is fully built,
--     never fires.
--
-- So there was no notification to suppress or send: there was no event. §4 below
-- raises the approval request the moment a request goes `pending`, which lights
-- up all four surfaces at once, and §5 notifies the people it resolved to.
--
-- ── HOW "3 OR MORE DAYS ⇒ EMAIL" IS ACHIEVED WITHOUT A SECOND RULE ───────────
--
-- `notification-dispatch` already implements exactly this policy in
-- `decideFanOut`: a leave notification carrying `total_days < 3` has its email
-- sibling written as `suppressed`, and everything else fans out. It reads
-- `payload.total_days` first and only falls back to scraping the body text — so
-- §5 puts `total_days` in the payload as a number and the fallback never runs.
-- One rule, in one place, already unit-tested. What was missing was a row for it
-- to decide about.
--
-- §7 schedules that dispatcher. Its own header says migration 041 registers no
-- cron entry for it and that "until one exists it is driven manually" — which
-- means that on this deployment NO notification email has ever been sent. That
-- is a five-minute pg_cron entry, and it is here.
--
-- ── (4) SICK LEAVE: THE ACCRUAL IS NOT THE PROBLEM, THE BACKFILL IS ──────────
--
-- 038500 set SL to 1 day/month and backfilled January–July 2026 with a hardcoded
-- array of seven dates. Every month since has depended on the `leave_accrual`
-- pg_cron entry firing on the 1st. §6 replaces the hardcoded array with a loop
-- that walks from the employee's start to the current IST month, so applying
-- this migration catches up whatever the scheduler missed — and can be re-run
-- safely for the same reason (`uq_leave_ledger__accrual_once`).
--
-- The dashboard half of (4) is NOT here: `normalizeLeaveBalance` in
-- `src/features/leave/api/leave.api.ts` was recomputing the sick-leave
-- entitlement in the BROWSER from the calendar month, which is why the screen
-- and the server disagreed. That is a code change, in the same commit.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 041600: leave reason per type, monthly ceiling, approval request + notification on submit, sick-leave accrual catch-up', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Two rules on the type, where every other leave rule already lives
-- -----------------------------------------------------------------------------

ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS requires_reason boolean NOT NULL DEFAULT false;
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS max_days_per_month numeric(6,2) NULL;

DO $$ BEGIN
  ALTER TABLE public.leave_types
    ADD CONSTRAINT ck_lt__max_days_per_month
      CHECK (max_days_per_month IS NULL OR max_days_per_month > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.leave_types.requires_reason IS
  'Does an employee have to say WHY? True for Sick Leave, false for the rest — asked for directly: "for sick leave reason is mandatory, for rest of part reason is not mandatory". Enforced by trg_leave_requests__submit_rules, not by a CHECK, because a CHECK on leave_requests cannot read leave_types.';
COMMENT ON COLUMN public.leave_types.max_days_per_month IS
  'Ceiling on how many counted days of THIS type one employee may take inside one calendar month, across every request. NULL means no ceiling. Distinct from max_days_per_request, which caps a single request and which four separate requests walk straight past.';

UPDATE public.leave_types
   SET requires_reason = true
 WHERE code = 'SL' AND deleted_at IS NULL AND requires_reason IS DISTINCT FROM true;

/*
  Three days per type per month, on every active type.

  The number is the one the same brief gives for the manager email — "if employee
  is applying for 3 or more than then manager should be notify" — so the two
  rules meet exactly: a three-day request is the largest that can be filed, and
  filing it is precisely what emails the manager.

  IT APPLIES TO EARNED LEAVE TOO, which is the consequence worth stating out
  loud: nobody can book a five-day holiday out of EL in one month until an
  administrator raises EL's own ceiling on the Leave Type Master. That is a
  per-type number, editable, and this seed only sets the starting point.
*/
UPDATE public.leave_types
   SET max_days_per_month = 3
 WHERE deleted_at IS NULL
   AND is_active
   AND max_days_per_month IS NULL;

-- -----------------------------------------------------------------------------
-- 2. The reason constraint stops being universal
-- -----------------------------------------------------------------------------
--
-- `ck_lr__reason CHECK (length(btrim(reason)) >= 10)` is what makes a reason
-- mandatory today, and a CHECK cannot look at `leave_types` to know whether it
-- should. So the length rule moves to the trigger in §3 and the constraint is
-- replaced by a sanity ceiling.
--
-- `reason` STAYS NOT NULL, and that is a deliberate trade rather than an
-- oversight. Making it nullable would ripple through a dozen zod row schemas
-- that read it as `z.string()` — `teamLeaveRequestSchema`, the detail page, the
-- admin register — and every one of them would need a null branch to render a
-- field that is simply empty. An empty string IS "no reason given" here, and it
-- is the value the form now sends for types that do not require one.

ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS ck_lr__reason;

DO $$ BEGIN
  ALTER TABLE public.leave_requests
    ADD CONSTRAINT ck_lr__reason_length CHECK (length(reason) <= 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. The two new rules, in their own trigger
-- -----------------------------------------------------------------------------
--
-- NOT bolted into `leave_requests_submit_guard`. That function is 150 lines of
-- someone else's carefully ordered checks, and 039700 set the precedent when it
-- added the combination rule: "ENFORCED BY ITS OWN TRIGGER, deliberately not by
-- editing leave_requests_submit_guard".
--
-- THE NAME CARRIES AN ORDERING DEPENDENCY. Postgres fires BEFORE triggers in
-- NAME order, and this one must run AFTER `trg_leave_requests__submit_guard`,
-- because that guard is what calls `rebuild_leave_request_days` — the day rows
-- this counts do not exist until it has. `submit_rules` sorts after
-- `submit_guard` ('r' > 'g'), which is why it is called that. Rename it and the
-- monthly ceiling silently counts one request short.

CREATE OR REPLACE FUNCTION public.leave_requests_submit_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  lt        public.leave_types%ROWTYPE;
  m         record;
  v_used    numeric;
  v_this    numeric;
BEGIN
  -- Only the submission transition, exactly as the guard before it decides.
  IF NOT (NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status = 'draft')) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;

  -- ── Reason, where the type asks for one ──────────────────────────────────
  IF lt.requires_reason AND length(btrim(COALESCE(NEW.reason, ''))) < 10 THEN
    RAISE EXCEPTION
      '% needs a reason of at least 10 characters. Say briefly what is wrong.',
      lt.name
      USING errcode = '23514';
  END IF;

  -- ── The monthly ceiling ──────────────────────────────────────────────────
  --
  -- Counted from `leave_request_days`, never from `from_date`/`to_date`: a
  -- request that spans a weekend costs fewer days than it covers, and a half day
  -- costs 0.5. `is_counted` is the engine's own answer to "does this date spend
  -- balance", so the ceiling and the balance agree by construction.
  --
  -- A request spanning two months is checked against BOTH months separately —
  -- 2 days in August plus 2 in September breaks no ceiling, and refusing it
  -- because the total is 4 would be a rule nobody wrote.
  IF lt.max_days_per_month IS NOT NULL THEN
    FOR m IN
      SELECT date_trunc('month', d.leave_date)::date AS month_start,
             SUM(d.day_value) AS days_this_request
        FROM public.leave_request_days d
       WHERE d.leave_request_id = NEW.id
         AND d.is_counted
       GROUP BY 1
    LOOP
      v_this := m.days_this_request;

      SELECT COALESCE(SUM(d.day_value), 0)
        INTO v_used
        FROM public.leave_request_days d
        JOIN public.leave_requests r ON r.id = d.leave_request_id
       WHERE r.employee_id   = NEW.employee_id
         AND r.leave_type_id = NEW.leave_type_id
         AND r.id <> NEW.id
         AND r.status IN ('pending','approved','partially_approved','cancellation_pending')
         AND d.is_counted
         AND date_trunc('month', d.leave_date)::date = m.month_start;

      IF v_used + v_this > lt.max_days_per_month THEN
        RAISE EXCEPTION
          '% allows at most % day(s) in a month. You already have % day(s) in % and this request adds %.',
          lt.name, lt.max_days_per_month, v_used,
          to_char(m.month_start, 'Month YYYY'), v_this
          USING errcode = '23514';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_requests__submit_rules ON public.leave_requests;
CREATE TRIGGER trg_leave_requests__submit_rules
  BEFORE INSERT OR UPDATE OF status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_submit_rules();

COMMENT ON FUNCTION public.leave_requests_submit_rules() IS
  'Per-type reason requirement and per-month ceiling. Must sort AFTER trg_leave_requests__submit_guard, which builds the leave_request_days rows the ceiling counts.';

-- -----------------------------------------------------------------------------
-- 4. The application reaches the approval engine
-- -----------------------------------------------------------------------------
--
-- One `approval_requests` row per leave request, raised the moment it goes
-- pending. Per REQUEST, not per application group: `approval_requests.detail_id`
-- names one detail row, the engine's per-type routing reads `p_days`, and a
-- combined application is several types with several answers. The group id
-- stays on the leave rows and is what the employee's own screen uses to show
-- them as one act.
--
-- AFTER, not BEFORE: `create_approval_request` calls `advance_approval`, which
-- resolves approvers and stamps `current_approver_ids` — work that has no
-- business happening while the row it describes is still being validated.
--
-- The self-UPDATE writes ONE column and cannot recurse: the WHEN clause requires
-- `approval_request_id IS NULL`, which the update itself falsifies. The other
-- AFTER triggers on this table key off a status CHANGE, and this update does not
-- change status, so they no-op.
--
-- A FAILURE HERE MUST NOT LOSE THE LEAVE. If no chain is configured for LEAVE,
-- `create_approval_request` raises — and rolling the employee's application back
-- for that would be punishing them for a configuration gap. The exception is
-- caught, logged as a warning, and the leave row survives as `pending` where the
-- admin leave register still shows it.

CREATE OR REPLACE FUNCTION public.leave_requests_raise_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_request_id uuid;
  lt           public.leave_types%ROWTYPE;
  e            public.employees%ROWTYPE;
  v_approver   uuid;
  v_title      text;
  v_body       text;
BEGIN
  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;
  SELECT * INTO e  FROM public.employees   WHERE id = NEW.employee_id;

  BEGIN
    v_request_id := public.create_approval_request(
      p_request_type_code  => 'LEAVE',
      p_subject_employee_id=> NEW.employee_id,
      p_detail_id          => NEW.id,
      p_title              => COALESCE(lt.name, 'Leave') || ' · ' ||
                              to_char(NEW.from_date, 'DD Mon') ||
                              CASE WHEN NEW.to_date <> NEW.from_date
                                   THEN ' – ' || to_char(NEW.to_date, 'DD Mon') ELSE '' END,
      p_summary            => jsonb_build_object(
                                'summary',        NULLIF(btrim(COALESCE(NEW.reason, '')), ''),
                                'leave_type',     lt.name,
                                'leave_type_code',lt.code,
                                'from_date',      NEW.from_date,
                                'to_date',        NEW.to_date,
                                'total_days',     NEW.total_days,
                                'request_number', NEW.request_number),
      p_amount             => NULL,
      p_days               => NEW.total_days,
      p_priority           => 'normal',
      p_on_behalf_of       => NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'leave request % filed but no approval request could be raised: %',
      NEW.request_number, SQLERRM;
    RETURN NULL;
  END;

  UPDATE public.leave_requests
     SET approval_request_id = v_request_id
   WHERE id = NEW.id;

  -- ── §5. Tell the people it landed on ────────────────────────────────────
  --
  -- `current_approver_ids` holds EMPLOYEE ids (this is what `sla_sweep` joins on
  -- when it notifies a late approver), so the profile comes off `employees`.
  --
  -- `total_days` goes in the payload AS A NUMBER. `decideFanOut` in
  -- notification-dispatch reads `payload.total_days` first and only falls back
  -- to a regex over the body text — and a body that says "1.5 day(s)" would be
  -- read as 1.5 by luck rather than by contract. Under three days it writes the
  -- email sibling as `suppressed`; at three or more it sends. That is the whole
  -- "email only for 3+ days" rule, and it already existed.
  --
  -- The in-app row is written whatever the length, which is the other half of
  -- what was asked: "if less than 3 then show only notification".
  v_title := COALESCE(e.display_name, 'An employee') || ' applied for ' ||
             trim(to_char(NEW.total_days, 'FM999999.99')) || ' day(s) of ' ||
             COALESCE(lt.name, 'leave');
  v_body  := COALESCE(e.display_name, 'An employee') || ' applied for ' ||
             trim(to_char(NEW.total_days, 'FM999999.99')) || ' day(s) of ' ||
             COALESCE(lt.name, 'leave') || ' (' ||
             to_char(NEW.from_date, 'DD Mon YYYY') || ' to ' ||
             to_char(NEW.to_date, 'DD Mon YYYY') || ').' ||
             CASE WHEN NULLIF(btrim(COALESCE(NEW.reason, '')), '') IS NULL
                  THEN '' ELSE ' Reason: ' || btrim(NEW.reason) END;

  FOR v_approver IN
    SELECT unnest(ar.current_approver_ids)
      FROM public.approval_requests ar
     WHERE ar.id = v_request_id
  LOOP
    INSERT INTO public.notifications
      (employee_id, profile_id, event_code, channel, title, body, deep_link,
       payload, priority, status, dedupe_key)
    SELECT ap.id, ap.profile_id, 'LEAVE_APPLIED', 'in_app',
           v_title, v_body, '/team/approvals',
           /*
             The payload is TWO things at once, which is why it carries the same
             number twice.

             `total_days` is what `decideFanOut` reads to decide whether an email
             is sent at all. `days`, `employee_name`, `leave_type_name`,
             `from_date` and `to_date` are the {{tokens}} in the seeded
             LEAVE_APPLIED template (004500) — every payload key becomes a
             template variable, and `renderComplete` refuses to send a
             half-filled template, falling back to the plain body above. Missing
             `days` would mean every one of these emails silently took the
             fallback path.

             The dates are FORMATTED here rather than passed as dates: a template
             variable is stringified as-is, and "2026-08-11" in a sentence
             written for a person is the raw column leaking into the email.
           */
           jsonb_build_object(
             'total_days',      NEW.total_days,
             'days',            trim(to_char(NEW.total_days, 'FM999999.99')),
             'leave_request_id',NEW.id,
             'approval_request_id', v_request_id,
             'employee_name',   COALESCE(e.display_name, 'An employee'),
             'leave_type_name', COALESCE(lt.name, 'leave'),
             'from_date',       to_char(NEW.from_date, 'DD Mon YYYY'),
             'to_date',         to_char(NEW.to_date, 'DD Mon YYYY')),
           CASE WHEN NEW.total_days >= 3 THEN 'high' ELSE 'normal' END,
           'queued',
           'LEAVE_APPLIED:' || NEW.id || ':' || ap.id
      FROM public.employees ap
     WHERE ap.id = v_approver
       AND ap.profile_id IS NOT NULL
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_requests__raise_approval ON public.leave_requests;
CREATE TRIGGER trg_leave_requests__raise_approval
  AFTER INSERT OR UPDATE OF status ON public.leave_requests
  FOR EACH ROW
  WHEN (NEW.status = 'pending' AND NEW.approval_request_id IS NULL)
  EXECUTE FUNCTION public.leave_requests_raise_approval();

COMMENT ON FUNCTION public.leave_requests_raise_approval() IS
  'Raises the approval_requests row for a leave application and notifies the resolved approvers. Before 041600 nothing did this outside the demo seed, so no real leave application ever appeared in an approval inbox.';

-- -----------------------------------------------------------------------------
-- 6. Sick leave: catch up whatever the scheduler missed
-- -----------------------------------------------------------------------------
--
-- 038500 backfilled a hardcoded January–July 2026 and left every later month to
-- the `leave_accrual` cron entry. This walks the months instead, from the later
-- of January 2026 and the employee's join month up to the current IST month, so
-- the catch-up is a property of the data rather than of a date literal somebody
-- has to remember to extend.
--
-- Idempotent twice over: the ON CONFLICT rides
-- `uq_leave_ledger__accrual_once (employee_id, leave_type_id, entry_type,
-- effective_date)`, and re-running writes the same 1.0 it wrote before.
--
-- It does NOT touch anyone's availed days or invent a balance: it inserts the
-- monthly credit and asks `recompute_leave_balance` for the arithmetic, which is
-- the same function the accrual job uses.
--
-- ONE MONTH, DATED THE 1st OF THE MONTH IT IS FOR. That is 038500's convention
-- and this keeps it: an employee who joined in August has a day for August, on
-- 1 August. `accrue_leave` files ITS credits in arrears — run on the 1st of
-- September, it credits September's 1st for the month of August — so the two
-- never collide on `effective_date` and the unique index is what proves it. The
-- practical effect is what was asked for: the month you join, you have a sick
-- day, and an unused one stays on the ledger rather than lapsing.

CREATE OR REPLACE FUNCTION public.backfill_sick_leave_accrual(p_as_of date DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sl_id   uuid;
  v_as_of   date := COALESCE(p_as_of, util.ist_today());
  v_last    date := date_trunc('month', v_as_of)::date;
  v_first   date;
  e         record;
  m         date;
  v_rows    integer := 0;
  v_ins     integer;
BEGIN
  SELECT id INTO v_sl_id
    FROM public.leave_types
   WHERE code = 'SL' AND deleted_at IS NULL
   LIMIT 1;
  IF v_sl_id IS NULL THEN
    RETURN 0;
  END IF;

  /*
    WHO ACCRUES IS `accrue_leave`'S QUESTION, NOT THIS FUNCTION'S.

    The status list and the `date_of_join IS NOT NULL` test are copied from the
    monthly job's own WHERE clause, so a catch-up run credits exactly the people
    the scheduler would have credited and nobody else. An earlier draft said
    `employment_status <> 'exited'`, which quietly included `pre_joining` —
    somebody who has not started earning sick leave because they have not
    started.
  */
  FOR e IN
    SELECT id, date_of_join
      FROM public.employees
     WHERE deleted_at IS NULL
       AND employment_status IN
           ('active','on_probation','confirmed','on_notice','on_long_leave')
       AND date_of_join IS NOT NULL
  LOOP
    -- Nobody accrues for a month they had not joined by, and the leave year's
    -- January is the other floor. Someone joining next month gets v_first later
    -- than v_last, so the loop below simply does not run.
    v_first := GREATEST(DATE '2026-01-01', date_trunc('month', e.date_of_join)::date);

    m := v_first;
    WHILE m <= v_last LOOP
      /*
        `description` IS NOT NULL (019 §5) and is what the ledger statement
        renders; `reason` carries the sentence. 039300 sets the same pair the
        same way. Omitting it is what made the first run of this migration fail
        on the live database — and what the local replay could not catch, because
        the harness has no employee with a join date, so this loop body never
        executed there. A migration that applies is not a migration whose
        function bodies have run.
      */
      INSERT INTO public.leave_ledger
        (employee_id, leave_type_id, leave_year, entry_type, days,
         effective_date, description, source_table, reason)
      VALUES
        (e.id, v_sl_id, extract(year FROM m)::integer, 'accrual', 1.0,
         m, 'Monthly sick leave accrual',
         'migration', 'Monthly accrual (1 day/month)')
      ON CONFLICT (employee_id, leave_type_id, entry_type, effective_date)
        WHERE entry_type IN ('accrual','pro_rata_accrual')
        DO NOTHING;
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_rows := v_rows + v_ins;
      m := (m + INTERVAL '1 month')::date;
    END LOOP;

    PERFORM public.recompute_leave_balance(e.id, v_sl_id, extract(year FROM v_last)::integer);
  END LOOP;

  RETURN v_rows;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.backfill_sick_leave_accrual(date) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.backfill_sick_leave_accrual(date) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.backfill_sick_leave_accrual(date) IS
  'Insert any missing 1-day-per-month Sick Leave accrual from January 2026 (or the employee''s join month) to the month of p_as_of, then recompute. Idempotent; safe to run on demand when the scheduler has missed a month.';

SELECT public.backfill_sick_leave_accrual();

-- -----------------------------------------------------------------------------
-- 7. The dispatcher finally runs
-- -----------------------------------------------------------------------------
--
-- `notification-dispatch`'s own header: "migration 041 registers no `cron_jobs`
-- row and no `pg_cron` entry for this function … Until one exists it is driven
-- manually or by an external scheduler; every 5 minutes is the intended
-- cadence". Nothing has driven it, which means every `queued` notification on
-- this deployment has been sitting in the outbox and no notification email has
-- ever been sent. §5 above would have added to that pile.
--
-- Registered exactly like the other edge-function jobs in 041: pg_net POST with
-- the cron secret, and a `cron_jobs` row so the job register knows about it.

INSERT INTO public.cron_jobs
  (code, name, description, schedule_cron, schedule_human, timezone,
   target, target_name, payload, is_enabled, timeout_seconds, overlap_policy,
   alert_on_failure, alert_after_consecutive_failures)
VALUES
  ('notification_dispatch', 'Notification outbox dispatch',
   'Drains public.notifications: fans queued in_app rows out to email (subject to preferences, quiet hours and the 3-day leave rule) and sends them. Was unscheduled until migration 041600.',
   '*/5 * * * *', 'Every 5 minutes', 'Asia/Kolkata',
   'edge_function', 'notification-dispatch', NULL, true, 120, 'skip', true, 3)
ON CONFLICT (code) DO UPDATE
   SET is_enabled = true,
       schedule_cron = EXCLUDED.schedule_cron,
       description = EXCLUDED.description;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron unavailable — notification_dispatch schedule skipped (vanilla Postgres harness)';
    RETURN;
  END IF;

  PERFORM cron.schedule('notification_dispatch', '*/5 * * * *',
    $cmd$SELECT net.http_post(
      url     := app.setting('edge_base_url') || '/notification-dispatch',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret', app.secret('cron_secret')),
      body    := jsonb_build_object('job_code','notification_dispatch'),
      timeout_milliseconds := 120000);$cmd$);
END
$do$;

COMMIT;

-- ###########################################################################
-- 20260801041700_leave_opening_balance.sql
-- ###########################################################################

-- =============================================================================
-- 20260801041700 — an opening balance an administrator can set, and Earned
--                  Leave starting at 32.5 days
-- =============================================================================
--
-- ASKED FOR: "earn leave should be available at initially that should be 32.5
-- (make editable for admin)".
--
-- ── WHY THIS IS NOT A NUMBER TYPED INTO A SEED ───────────────────────────────
--
-- 32.5 could have been one UPDATE against `leave_ledger` and this file would be
-- ten lines long. It would also be a number nobody could change afterwards
-- without another migration, which is the half of the request that matters:
-- "make editable for admin". So the number lives on the leave TYPE, beside every
-- other rule an administrator already edits on the Leave Type Master, and the
-- ledger is filled from it.
--
-- ── THE LEDGER IS APPEND-ONLY, SO "EDITABLE" MEANS TRUE-UP, NOT OVERWRITE ────
--
-- `leave_ledger` refuses UPDATE and DELETE outright
-- (`leave_ledger_guard_mutation`), and rightly: a balance that can be rewritten
-- is a balance nobody can audit. So when the number changes from 32.5 to 40,
-- nothing is edited — a `credit_adjustment` of 7.5 is APPENDED, with a reason
-- naming the change. `recompute_leave_balance` folds opening + accrued +
-- adjusted into `entitlement_days`, so the employee sees 40 and the ledger still
-- shows how it got there.
--
-- The same mechanism handles the first grant: no opening row yet means insert
-- one. This is why the function is called grant_opening_balances and not
-- set_opening_balance — it makes the world match the rule, whatever state the
-- world is in, and it can be run twice with no effect the second time.
--
-- ── WHO GETS IT ─────────────────────────────────────────────────────────────
--
-- The same employees `accrue_leave` credits: active, on probation, confirmed, on
-- notice, on long leave, with a real join date that is not in the future. An
-- opening balance for somebody who has not started is a balance they can spend
-- before their first day.
--
-- ── WHY EARNED LEAVE CAN HOLD 32.5 ──────────────────────────────────────────
--
-- `max_balance_days` is NULL for EL (004300 seeds no ceiling), so `accrue_leave`
-- writes no `lapse` row against it. Had a ceiling been set below 32.5, the next
-- monthly run would have quietly lapsed the difference — which is the failure
-- this note exists to rule out, not to describe.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 041700: leave_types.opening_balance_days, Earned Leave opening balance of 32.5 days, and the true-up that keeps the ledger matching it', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The rule, on the type
-- -----------------------------------------------------------------------------

ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS opening_balance_days numeric(6,2) NULL;

/*
  Half days only. The whole leave engine works in 0.5 steps — `ck_lrd__day_value`
  admits 0, 0.5 and 1, and `adjust_leave_balance` refuses anything else — so a
  32.3 typed here would be a balance no request could ever spend exactly.
*/
DO $$ BEGIN
  ALTER TABLE public.leave_types
    ADD CONSTRAINT ck_lt__opening_balance_days CHECK (
      opening_balance_days IS NULL
      OR (opening_balance_days >= 0
          AND (opening_balance_days * 2) = floor(opening_balance_days * 2)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.leave_types.opening_balance_days IS
  'What an employee starts the leave year with for this type, filed as an opening_balance ledger entry by grant_opening_balances(). NULL means no opening balance. Editing it appends an adjustment rather than rewriting history — see migration 041700.';

UPDATE public.leave_types
   SET opening_balance_days = 32.5
 WHERE code = 'EL'
   AND deleted_at IS NULL
   AND opening_balance_days IS DISTINCT FROM 32.5;

-- -----------------------------------------------------------------------------
-- 2. The true-up
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER because `leave_ledger` has no INSERT policy for anybody: rows
-- arrive only through definer functions and service-role jobs (019 §"P5 read; no
-- client insert/update/delete policy at all"). That is the same door
-- `accrue_leave` and `adjust_leave_balance` come through.
--
-- Returns the number of ledger rows written, so a caller can tell "already
-- correct" from "granted to 81 people" — the two look identical from outside.

CREATE OR REPLACE FUNCTION public.grant_opening_balances(
  p_leave_type_id uuid    DEFAULT NULL,
  p_leave_year    integer DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year    integer := COALESCE(p_leave_year, public.leave_year_of(util.ist_today()));
  v_today   date    := util.ist_today();
  lt        record;
  e         record;
  v_target  numeric;
  v_have    numeric;
  v_delta   numeric;
  v_written integer := 0;
BEGIN
  FOR lt IN
    SELECT id, code, name, opening_balance_days
      FROM public.leave_types
     WHERE deleted_at IS NULL
       AND is_active
       AND opening_balance_days IS NOT NULL
       AND (p_leave_type_id IS NULL OR id = p_leave_type_id)
  LOOP
    v_target := lt.opening_balance_days;

    FOR e IN
      SELECT id
        FROM public.employees
       WHERE deleted_at IS NULL
         AND employment_status IN
             ('active','on_probation','confirmed','on_notice','on_long_leave')
         AND date_of_join IS NOT NULL
         AND date_of_join <= v_today
    LOOP
      -- What the ledger already says the opening balance is, INCLUDING any
      -- earlier true-up. Reading only `opening_balance` would re-apply the whole
      -- difference every time the number changed.
      SELECT COALESCE(SUM(ll.days), 0)
        INTO v_have
        FROM public.leave_ledger ll
       WHERE ll.employee_id   = e.id
         AND ll.leave_type_id = lt.id
         AND ll.leave_year    = v_year
         AND ll.entry_type IN ('opening_balance','credit_adjustment','debit_adjustment')
         AND ll.reversed_by_id IS NULL;

      v_delta := v_target - v_have;
      CONTINUE WHEN v_delta = 0;

      IF v_have = 0 AND NOT EXISTS (
           SELECT 1 FROM public.leave_ledger ll2
            WHERE ll2.employee_id   = e.id
              AND ll2.leave_type_id = lt.id
              AND ll2.leave_year    = v_year
              AND ll2.entry_type    = 'opening_balance')
      THEN
        -- First grant. Dated the start of the leave year, not today: it is the
        -- balance they STARTED with, and a statement that shows it arriving in
        -- August reads as a windfall rather than an opening position.
        -- `description` states the CATEGORY and is NOT NULL (019 §5); `reason`
        -- carries the sentence. Same split 039300 uses.
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days,
           effective_date, description, source_table, reason)
        VALUES
          (e.id, lt.id, v_year, 'opening_balance', v_target,
           make_date(v_year, 4, 1), 'Opening balance set by policy', 'leave_types',
           'Opening balance for ' || lt.name || ' set by policy (' ||
             trim(to_char(v_target, 'FM999999.99')) || ' days)');
      ELSE
        -- The number changed. Append the difference; never touch the original.
        INSERT INTO public.leave_ledger
          (employee_id, leave_type_id, leave_year, entry_type, days,
           effective_date, description, source_table, reason)
        VALUES
          (e.id, lt.id, v_year,
           /*
             THE CAST IS LOAD-BEARING. A bare literal like 'opening_balance' is
             `unknown` and Postgres coerces it to the enum happily; a CASE over
             two string literals resolves to TEXT, and `entry_type` is
             `ledger_entry_type` — so without this the adjustment branch raises
             42804 "column entry_type is of type ledger_entry_type but expression
             is of type text". The first-grant branch above works and this one
             would not have, which is why it took a probe that actually edited
             the number to find it.
           */
           (CASE WHEN v_delta > 0 THEN 'credit_adjustment' ELSE 'debit_adjustment' END)
             ::public.ledger_entry_type,
           v_delta, v_today, 'Opening balance changed by policy', 'leave_types',
           'Opening balance for ' || lt.name || ' changed to ' ||
             trim(to_char(v_target, 'FM999999.99')) || ' days by policy');
      END IF;

      v_written := v_written + 1;
      PERFORM public.recompute_leave_balance(e.id, lt.id, v_year);
    END LOOP;
  END LOOP;

  RETURN v_written;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.grant_opening_balances(uuid, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.grant_opening_balances(uuid, integer) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.grant_opening_balances(uuid, integer) IS
  'Make the ledger match leave_types.opening_balance_days for every eligible employee: insert the opening_balance entry, or append an adjustment for the difference when the policy number has changed. Idempotent — running it twice writes nothing the second time.';

-- -----------------------------------------------------------------------------
-- 3. Editing the number is what applies it
-- -----------------------------------------------------------------------------
--
-- Without this, "editable by admin" would mean an admin can change a number that
-- does nothing until somebody with database access remembers to run a function.
-- The trigger is what makes the Leave Type Master field real.
--
-- Bounded by design: one type, and only the employees who accrue — on this
-- deployment about eighty rows. It fires only when the NUMBER changes, not on
-- every edit to the type, so renaming Earned Leave does not rewrite anyone's
-- ledger.
--
-- AFTER, and returning NULL: the row is already committed, and the ledger writes
-- must not be able to fail the administrator's edit — if one does, the whole
-- statement rolls back and the admin is told, which is the correct outcome for a
-- change that could not be applied.

CREATE OR REPLACE FUNCTION public.leave_types_apply_opening_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.opening_balance_days IS NOT NULL THEN
    PERFORM public.grant_opening_balances(NEW.id, NULL);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_types__opening_balance ON public.leave_types;
CREATE TRIGGER trg_leave_types__opening_balance
  AFTER UPDATE OF opening_balance_days ON public.leave_types
  FOR EACH ROW
  WHEN (NEW.opening_balance_days IS DISTINCT FROM OLD.opening_balance_days)
  EXECUTE FUNCTION public.leave_types_apply_opening_balance();

-- -----------------------------------------------------------------------------
-- 4. Grant it now
-- -----------------------------------------------------------------------------
--
-- The UPDATE in §1 ran BEFORE the trigger in §3 existed, which is deliberate:
-- creating a trigger and then relying on a statement that already ran is how a
-- migration ends up doing nothing on a re-run. This call is the explicit half.

SELECT public.grant_opening_balances();

COMMIT;

-- ###########################################################################
-- 20260801041800_sick_leave_combines.sql
-- ###########################################################################

-- =============================================================================
-- 20260801041800 — Sick Leave can be combined again
-- =============================================================================
--
-- ASKED FOR, TWICE. "if employee want to take leave let's 5 days so he can
-- distribute leave in sick, earn, leave without pay like that" — sick leave named
-- explicitly in the distribution — and then, looking at the screen:
-- "when I selecting sick then why can't select other".
--
-- WHAT WAS STOPPING IT
--
-- 039700 added `leave_types.allows_combination` and set Sick Leave to false, so
-- `leave_requests_combination_guard` refuses any grouped application that mixes
-- it with another type. The screen mirrors that by switching the other rows off,
-- which is why one sick day plus two earned could not be filed even though both
-- balances covered it.
--
-- That migration's own header says how this should be undone: "the rule is a
-- property of the leave type and the next type that needs it should be a data
-- change, not a migration". It was right, and the reason a migration is needed
-- anyway is that the flag was never put on the Leave Type Master — so there was
-- no screen on which to make the data change. This file flips the flag; the same
-- commit adds the field to that screen, so the NEXT change really is a data
-- change.
--
-- WHAT DOES NOT CHANGE, AND IS WORTH KNOWING
--
--   * `requires_document_after_days = 2` still applies. A medical certificate is
--     still expected beyond two days of sick leave, whether or not the
--     application also carries earned leave.
--   * `requires_reason = true` (041600) still applies, so an application
--     containing sick leave still has to say why. The form already asks when any
--     chosen type demands it.
--   * THE DATES ARE STILL DEALT OUT, NOT SHARED. `leave_requests_no_overlap`
--     refuses two live requests whose ranges touch, so a mixed application
--     becomes one request per type over DISJOINT dates —
--     `splitAllocationsAcrossDates` decides which. One sick day plus two earned
--     across 11–13 August files sick on the 11th and earned on the 12th–13th, in
--     that order. It does not let the employee say the illness was on the 13th;
--     that needs two separate applications, and it is the honest limit of a
--     grouped one.
--
-- The guard itself is UNTOUCHED. It reads the column, so flipping the column is
-- the whole change — which is the point of having stored the rule as data.
-- =============================================================================

BEGIN;

-- `audit.reason_required_tables` includes leave_types, so the UPDATE needs a
-- reason before the audit trigger accepts it. A migration is no more exempt from
-- that than a screen is.
SELECT set_config('app.reason', 'migration 041800: Sick Leave may be combined with other leave types in one application, as asked for', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.leave_types
   SET allows_combination = true
 WHERE code = 'SL'
   AND deleted_at IS NULL
   AND allows_combination IS DISTINCT FROM true;

COMMIT;
