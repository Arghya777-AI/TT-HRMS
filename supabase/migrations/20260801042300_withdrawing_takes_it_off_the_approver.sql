-- =============================================================================
-- 20260801042300 — withdrawing a request takes it off the approver's desk
-- =============================================================================
--
-- ASKED FOR: "I withdraw then filed again but if I withdraw that one then that
-- status in history of me should be updated and HR/manager notification should be
-- erased".
--
-- ── THE HOLE, WHICH IS 042100 IN REVERSE ────────────────────────────────────
--
-- 042100 made a detail row raise its approval request when it goes pending.
-- Nothing does the opposite. Withdrawing a resignation sets
-- `resignations.status = 'withdrawn'` and stops there, so:
--
--   · `approval_requests` still says `pending`, with the manager still listed in
--     `current_approver_ids`;
--   · `v_approval_inbox` still shows it, so Suraj is still being asked to decide
--     a resignation that has been taken back;
--   · the SLA clock keeps running and `sla_sweep` will eventually escalate it;
--   · and the employee's own register shows the detail row as withdrawn while the
--     workflow row beside it says waiting — two screens, two answers.
--
-- An approver acting on it then decides a request whose subject row is gone,
-- which is worse than a stale row: it is a decision recorded against nothing.
--
-- ── WHY A TRIGGER AND NOT act_on_approval ───────────────────────────────────
--
-- `act_on_approval(request, 'recall')` is the sanctioned path and does exactly
-- this — but it is an RPC the CLIENT must remember to call, in every withdraw
-- path on every screen, in the right order, and it refuses when the caller is not
-- the subject (an administrator cancelling on somebody's behalf is not). That is
-- the same "the client must remember" shape that left leave unrouted for months.
--
-- So the database does it: when a detail row reaches a terminal state its
-- approval request follows, and the trail records who did it. The RPC still
-- works and is still the better path when a screen has one — this is the floor,
-- not a replacement.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
-- It does not delete the notification the approver already received. A
-- notification is a record that they WERE told, and deleting it would rewrite
-- history — the same reason `leave_ledger` is append-only. It stamps
-- `dismissed_at`, which is what the feed and the unread count read, so the row
-- leaves both without pretending nobody was ever told.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042300: a withdrawn or cancelled detail row settles its approval request and dismisses the approver notification', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The settler
-- -----------------------------------------------------------------------------
--
-- Mirrors `raise_approval_for_detail`: one function, attached per table, reading
-- the row's own `approval_request_id`. It settles ONLY a request still in flight
-- — a decided request keeps its decision, because a subject cannot un-approve
-- something by editing their own row afterwards.

CREATE OR REPLACE FUNCTION public.settle_approval_for_detail()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_request public.approval_requests%ROWTYPE;
  v_actor   uuid := app.ctx_actor_id();
  v_status  public.approval_status;
BEGIN
  IF NEW.approval_request_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_request
    FROM public.approval_requests
   WHERE id = NEW.approval_request_id
   FOR UPDATE;
  IF NOT FOUND OR v_request.status NOT IN ('pending','in_progress','escalated') THEN
    RETURN NULL;   -- already settled; nothing to take off anybody's desk
  END IF;

  /*
    The detail row's word for it, mapped to the workflow's. 'withdrawn' is the
    subject taking it back and 'cancelled' is somebody else stopping it; the
    engine has both and the distinction is worth keeping in the trail.
  */
  v_status := CASE NEW.status::text
                WHEN 'withdrawn' THEN 'withdrawn'
                WHEN 'cancelled' THEN 'cancelled'
                ELSE 'withdrawn'
              END::public.approval_status;

  INSERT INTO public.approval_actions
    (approval_request_id, level, actor_id, action, comment)
  VALUES
    (v_request.id, v_request.current_level, v_actor,
     CASE WHEN v_status = 'cancelled' THEN 'cancel' ELSE 'recall' END::public.approval_action,
     'the ' || TG_TABLE_NAME || ' row was marked ' || NEW.status::text);

  UPDATE public.approval_requests
     SET status               = v_status,
         current_approver_ids = '{}',
         decided_at           = now(),
         decided_by           = COALESCE(v_actor, decided_by)
   WHERE id = v_request.id;

  /*
    The approver's notification, closed rather than deleted.

    `dismissed_at` is what the feed and the unread count read, so setting it takes
    the row out of both without pretending nobody was ever told. Only rows still
    queued or delivered — one already read stays read.
  */
  UPDATE public.notifications
     SET dismissed_at = now(),
         /*
           'cancelled', not 'dismissed' — `notification_status` has no such label
           (queued, sending, sent, delivered, opened, clicked, failed, bounced,
           suppressed, cancelled). A probe that actually withdrew a resignation is
           what found that; the migration applied cleanly with the wrong value in
           it, because a value inside a plpgsql body is only checked when the body
           runs.

           A queued one is cancelled outright: nobody has seen it and there is now
           nothing to see. One already sent or delivered keeps its status — it was
           genuinely sent — and only gains `dismissed_at`, which is what the feed
           and the unread count read.
         */
         status = CASE WHEN status = 'queued' THEN 'cancelled'::public.notification_status
                       ELSE status END
   WHERE payload->>'approval_request_id' = v_request.id::text
     AND dismissed_at IS NULL
     AND status IN ('queued','sent','delivered','opened');

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.settle_approval_for_detail() IS
  'AFTER trigger: when a detail row is withdrawn or cancelled, settle its approval request, record the recall in the trail and dismiss the approver''s notification. The mirror of raise_approval_for_detail.';

-- -----------------------------------------------------------------------------
-- 2. Attached to every detail table that can hold an approval request
-- -----------------------------------------------------------------------------
--
-- Guarded per table so this migration survives a deployment where one of them
-- has not been created yet, and so a table whose status vocabulary lacks
-- 'withdrawn' is skipped rather than breaking the trigger definition.

DO $$
DECLARE
  r record;
  v_has_withdrawn boolean;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'resignations', 'travel_requisitions', 'document_requests', 'asset_requests',
      'web_punch_requests', 'reimbursement_claims', 'leave_requests',
      'attendance_regularizations', 'overtime_preapprovals', 'shift_swaps',
      'income_tax_declarations', 'advance_requests'
    ]) AS tbl
  LOOP
    CONTINUE WHEN to_regclass('public.' || r.tbl) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = r.tbl
         AND c.column_name = 'approval_request_id');

    /*
      Every table here uses a status ENUM, and they are not the same enum:
      `leave_request_status` has 'withdrawn' and 'cancelled',
      `regularization_status` has 'cancelled' but no 'withdrawn'. The WHEN clause
      below is built from the labels the column's own type actually has, so a
      trigger is never created naming a value its table cannot hold.
    */
    SELECT bool_or(e.enumlabel = 'withdrawn') INTO v_has_withdrawn
      FROM information_schema.columns c
      JOIN pg_type ty ON ty.typname = c.udt_name
      JOIN pg_enum e ON e.enumtypid = ty.oid
     WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = 'status';

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                   'trg_' || r.tbl || '__settle_approval', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE OF status ON public.%I FOR EACH ROW '
      'WHEN (NEW.approval_request_id IS NOT NULL AND NEW.status::text IN (%s) '
      '      AND OLD.status IS DISTINCT FROM NEW.status) '
      'EXECUTE FUNCTION public.settle_approval_for_detail()',
      'trg_' || r.tbl || '__settle_approval', r.tbl,
      CASE WHEN COALESCE(v_has_withdrawn, false)
           THEN '''withdrawn'',''cancelled''' ELSE '''cancelled''' END);
    RAISE NOTICE 'withdrawal settles the approval request: %', r.tbl;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Catch up what is already stranded
-- -----------------------------------------------------------------------------
--
-- Requests whose detail row was withdrawn before this migration existed are
-- sitting `pending` on somebody's desk right now — including the resignation that
-- prompted this. Settling them by hand here rather than waiting for a second
-- edit that will never come.
--
-- `resignations` only: it is the one with a withdraw button today, so it is the
-- only table that can have produced this state. A blind sweep across twelve
-- tables would be a lot of writes to fix a problem only one of them has.

WITH stranded AS (
  SELECT ar.id, ar.current_level
    FROM public.approval_requests ar
    JOIN public.resignations r ON r.approval_request_id = ar.id
   WHERE r.status IN ('withdrawn','cancelled')
     AND ar.status IN ('pending','in_progress','escalated')
), logged AS (
  INSERT INTO public.approval_actions
    (approval_request_id, level, actor_id, action, comment)
  SELECT s.id, s.current_level, NULL, 'recall',
         'the resignation was withdrawn before migration 042300 taught the '
         || 'database to settle the request with it'
    FROM stranded s
  RETURNING approval_request_id
)
UPDATE public.approval_requests ar
   SET status               = 'withdrawn',
       current_approver_ids = '{}',
       decided_at           = now()
  FROM logged l
 WHERE ar.id = l.approval_request_id;

COMMIT;
