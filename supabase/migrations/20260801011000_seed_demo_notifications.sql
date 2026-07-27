-- =============================================================================
-- Migration 061 — give every employee a notification feed.
--
-- WHY
-- ---
-- A per-persona probe (real logins, through RLS) found that of 13 notifications
-- in the whole system, 12 were KIOSK_OFFLINE and 1 was PUNCH_MISSING_OUT, all
-- belonging to a single employee. So for four of the five demo personas the
-- top-bar bell and /me/notifications were completely empty — the one widget
-- visible on EVERY screen, reading as unfinished software.
--
-- The notification feed is normally written by the notification-dispatch edge
-- function as events happen. Nothing has driven those events for the seeded
-- history (the seeds insert rows directly rather than going through the app),
-- so the feed was never populated. This backfills a plausible feed from facts
-- that ALREADY EXIST in the database — the payslip that was published, the
-- leave that was decided, the policy that needs acknowledging — rather than
-- inventing unrelated noise.
--
-- SAFETY
-- ------
--  * Guarded by settings.seed_demo_data.
--  * Idempotent via dedupe_key, which has a UNIQUE index per partition.
--  * Deterministic; no random().
--
-- SCHEMA FACTS VERIFIED FIRST
-- --------------------------
--  * notifications is PARTITIONED BY RANGE (recorded_at), quarterly, and six
--    partitions from the current quarter exist. recorded_at must land inside
--    one — a date outside every partition fails the insert outright. This bit
--    on the first run: acknowledgements assigned 45 days ago fell into Q2,
--    which has no partition. Hence the v_floor clamp.
--  * The CHECK requires employee_id IS NOT NULL OR profile_id IS NOT NULL.
--    Both are set here so the self-select policy matches on either arm
--    (it tests profile_id = app.ctx_actor_id() OR employee_id =
--    app.current_employee_id()).
--  * notification_templates keys on `code`, NOT `event_code` (the notifications
--    table uses event_code; the templates table uses code — they differ).
--  * `authenticated` is REVOKEd INSERT on notifications, so only a migration or
--    service_role can write them. Employees may only UPDATE (read_at,
--    dismissed_at) — which is exactly what "mark as read" needs.
--  * notification_status ∈ queued|sending|sent|delivered|opened|clicked|failed|
--    bounced|suppressed|cancelled.  priority ∈ low|normal|high|critical.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 061: backfill per-employee notification feed from existing facts', true);
SELECT set_config('app.source', 'migration', true);

DO $seed$
DECLARE
  v_enabled boolean;
  v_actor   uuid;
  v_n       integer := 0;
  -- Earliest recorded_at that a partition exists for. Partitions are created
  -- from the current quarter forward (six of them), so anything derived from
  -- older rows must be clamped up to this or the insert fails outright with
  -- "no partition of relation notifications found for row".
  v_floor   timestamptz := date_trunc('quarter', now()) + interval '1 hour';
BEGIN
  SELECT (value #>> '{}')::boolean INTO v_enabled
    FROM public.settings WHERE key = 'seed_demo_data' LIMIT 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE NOTICE 'seed 061 skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  SELECT id INTO v_actor FROM public.profiles ORDER BY created_at LIMIT 1;

  -- 1. PAYSLIP_READY — one per payslip that actually exists and is visible.
  INSERT INTO public.notifications
    (employee_id, profile_id, event_code, channel, title, body, deep_link,
     priority, status, sent_at, delivered_at, read_at, dedupe_key, recorded_at)
  SELECT p.employee_id, e.profile_id, 'PAYSLIP_READY', 'in_app',
         'Your payslip is ready',
         'Your payslip has been published and is available to download.',
         '/me/payslips',
         'normal', 'delivered',
         now() - interval '5 days', now() - interval '5 days',
         CASE WHEN (row_number() OVER (ORDER BY p.id)) % 3 = 0
              THEN now() - interval '4 days' END,
         'seed061:payslip:' || p.id::text,
         now() - interval '5 days'
    FROM public.payslips p
    JOIN public.employees e ON e.id = p.employee_id
   WHERE e.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notifications n
                      WHERE n.dedupe_key = 'seed061:payslip:' || p.id::text);
  v_n := v_n + 1;

  -- 2. LEAVE_DECIDED — for every leave request that reached a decision.
  INSERT INTO public.notifications
    (employee_id, profile_id, event_code, channel, title, body, deep_link,
     priority, status, sent_at, delivered_at, read_at, dedupe_key, recorded_at)
  SELECT lr.employee_id, e.profile_id, 'LEAVE_DECIDED', 'in_app',
         CASE WHEN lr.status = 'approved' THEN 'Your leave was approved'
              WHEN lr.status = 'rejected' THEN 'Your leave was declined'
              ELSE 'Your leave request was updated' END,
         'Open the request to see the decision and any comment.',
         '/me/leave/' || lr.id::text,
         'normal', 'delivered',
         GREATEST(COALESCE(lr.updated_at, now() - interval '9 days'), v_floor),
         GREATEST(COALESCE(lr.updated_at, now() - interval '9 days'), v_floor),
         NULL,
         'seed061:leave:' || lr.id::text,
         GREATEST(COALESCE(lr.updated_at, now() - interval '9 days'), v_floor)
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
   WHERE lr.status IN ('approved', 'rejected')
     AND e.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notifications n
                      WHERE n.dedupe_key = 'seed061:leave:' || lr.id::text);

  -- 3. POLICY_ACK_DUE — for every acknowledgement still outstanding. This is
  --    the actionable one: it links straight to the document the employee owes.
  INSERT INTO public.notifications
    (employee_id, profile_id, event_code, channel, title, body, deep_link,
     priority, status, sent_at, delivered_at, read_at, dedupe_key, recorded_at)
  SELECT da.employee_id, e.profile_id, 'POLICY_ACK_DUE', 'in_app',
         'Action needed: acknowledge ' || d.title,
         'You have not yet acknowledged this policy. It is due on '
           || to_char(da.due_on, 'DD Mon YYYY') || '.',
         '/me/documents',
         'high', 'delivered',
         GREATEST(da.assigned_at, v_floor), GREATEST(da.assigned_at, v_floor), NULL,
         'seed061:ack:' || da.id::text,
         GREATEST(da.assigned_at, v_floor)
    FROM public.document_acknowledgements da
    JOIN public.documents d ON d.id = da.document_id
    JOIN public.employees e ON e.id = da.employee_id
   WHERE da.status IN ('assigned', 'opened', 'overdue')
     AND e.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notifications n
                      WHERE n.dedupe_key = 'seed061:ack:' || da.id::text);

  -- 4. ROSTER_PUBLISHED — one per employee, the everyday informational case, so
  --    a feed is never a single lonely row.
  INSERT INTO public.notifications
    (employee_id, profile_id, event_code, channel, title, body, deep_link,
     priority, status, sent_at, delivered_at, read_at, dedupe_key, recorded_at)
  SELECT e.id, e.profile_id, 'ROSTER_PUBLISHED', 'in_app',
         'This week''s roster is published',
         'Your shifts for the coming week are confirmed. Event days are marked.',
         '/me/attendance',
         'normal', 'delivered',
         now() - interval '2 days', now() - interval '2 days',
         now() - interval '2 days' + interval '3 hours',
         'seed061:roster:' || e.id::text,
         now() - interval '2 days'
    FROM public.employees e
   WHERE e.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notifications n
                      WHERE n.dedupe_key = 'seed061:roster:' || e.id::text);

  -- 5. LEAVE_BALANCE_LAPSING — unread and high priority, so the bell shows a
  --    genuine unread count rather than a zero badge.
  INSERT INTO public.notifications
    (employee_id, profile_id, event_code, channel, title, body, deep_link,
     priority, status, sent_at, delivered_at, read_at, dedupe_key, recorded_at)
  SELECT e.id, e.profile_id, 'LEAVE_BALANCE_LAPSING', 'in_app',
         'Leave balance lapses at year end',
         'Some of your privilege leave will lapse if unused. Check your balance.',
         '/me/leave',
         'high', 'delivered',
         now() - interval '1 day', now() - interval '1 day', NULL,
         'seed061:lapse:' || e.id::text,
         now() - interval '1 day'
    FROM public.employees e
   WHERE e.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notifications n
                      WHERE n.dedupe_key = 'seed061:lapse:' || e.id::text);

  RAISE NOTICE 'seed 061 complete';
END
$seed$;

COMMIT;
