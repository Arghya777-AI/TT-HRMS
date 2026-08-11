-- =============================================================================
-- 20260801042100 — every request raised from /me/apply reaches an approver
-- =============================================================================
--
-- ASKED FOR: "i send request but HR can't see it … make possible for all which
-- are inside /apply".
--
-- ── THE SHAPE OF THE BUG, FOR THE THIRD TIME ────────────────────────────────
--
-- HR's inbox is not broken. `/admin/workflow/inbox` reads `approval_requests`
-- directly and `ar__admin_read` lets an administrator see every request in their
-- scope. The request was not hidden from HR — it was never created.
--
-- `submitRegularization` inserts an `attendance_regularizations` row and stops,
-- exactly as leave did before 041600. `request_types.ATT_REGULARIZATION` names
-- that table, `AC-REG-STD` routes it, and nothing has ever called
-- `create_approval_request` for one. So the row exists, the employee sees
-- "pending" on their own screen, and no approver — manager or HR — has anything
-- in front of them.
--
-- ── WHY THIS IS A TRIGGER AND NOT SIX MORE CLIENT CALLS ─────────────────────
--
-- Because the client is where this keeps going wrong. Six detail tables carry an
-- `approval_request_id` and a `status`, and each one relies on whichever module
-- happens to write it remembering to raise the request afterwards. Claims
-- remember, resignations remember, regularizations do not, and nothing anywhere
-- notices the difference — the row looks filed from every angle except the one
-- that matters.
--
-- One trigger function, attached per table with the request-type code as an
-- argument, makes "a pending detail row has an approval request" a property of
-- the DATABASE. A new screen that inserts the row correctly gets the routing for
-- free, and cannot forget.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
-- It does not notify anybody. 041600's leave trigger writes an in-app
-- notification, and until the dispatcher has an age cap (see the 11-Aug backlog
-- incident) nothing new should be queued for email. Routing first; telling
-- people second.
--
-- It also does not touch `comp_off_ledger`: that table has no
-- `approval_request_id` at all, so there is nowhere to record the link. Comp-off
-- is credited by the engine rather than requested, and giving it a request would
-- be inventing a workflow, not connecting one.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042100: raise the approval request from the detail row, so every /me/apply request reaches an approver', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The generic raiser
-- -----------------------------------------------------------------------------
--
-- TG_ARGV[0] is the `request_types.code`. Everything else is read from the row
-- and the type, so the function knows nothing about any particular table beyond
-- the two columns every one of them has: `employee_id` and `id`.
--
-- `to_jsonb(NEW)` is how the summary is built without naming columns. It is
-- stored whole under `detail`, so an approver's screen can show whatever that
-- request type happens to carry — a date for a regularization, an amount for an
-- advance — without this function having an opinion about either.
--
-- FAILURES WARN, THEY DO NOT REFUSE. If no chain is configured, the employee's
-- request must still be filed: they cannot fix a chain and should not lose their
-- submission to one. The warning names the request so an administrator can find
-- it in the Postgres log, and the detail row is still visible on the admin
-- register for that table.

CREATE OR REPLACE FUNCTION public.raise_approval_for_detail()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code       text := TG_ARGV[0];
  v_rt         public.request_types%ROWTYPE;
  v_request_id uuid;
  v_row        jsonb := to_jsonb(NEW);
  v_subject    uuid;
  v_title      text;
BEGIN
  v_subject := (v_row ->> 'employee_id')::uuid;
  IF v_subject IS NULL THEN
    RAISE WARNING 'raise_approval_for_detail(%): row has no employee_id', v_code;
    RETURN NULL;
  END IF;

  SELECT * INTO v_rt
    FROM public.request_types
   WHERE code = v_code AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE WARNING 'raise_approval_for_detail(%): no such request type', v_code;
    RETURN NULL;
  END IF;

  v_title := v_rt.name || COALESCE(' · ' || (v_row ->> 'ist_date'), '');

  BEGIN
    v_request_id := public.create_approval_request(
      p_request_type_code   => v_code,
      p_subject_employee_id => v_subject,
      p_detail_id           => NEW.id,
      p_title               => v_title,
      p_summary             => jsonb_build_object(
                                 'summary', COALESCE(v_row ->> 'employee_reason',
                                                     v_row ->> 'reason',
                                                     v_row ->> 'note'),
                                 'detail',  v_row),
      p_amount              => NULL,
      p_days                => NULL,
      p_priority            => 'normal',
      p_on_behalf_of        => NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'detail row % (%) filed but no approval request could be raised: %',
      NEW.id, v_code, SQLERRM;
    RETURN NULL;
  END;

  /*
    The back-link, written dynamically because the column is on a different table
    each time. `format(%I)` on TG_TABLE_NAME/TG_TABLE_SCHEMA, never string
    concatenation: the identifiers come from the trigger definition rather than
    from data, but quoting them is what keeps it that way.
  */
  EXECUTE format(
    'UPDATE %I.%I SET approval_request_id = $1 WHERE id = $2',
    TG_TABLE_SCHEMA, TG_TABLE_NAME)
  USING v_request_id, NEW.id;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.raise_approval_for_detail() IS
  'AFTER trigger: raise the approval_requests row for a detail row that has just become pending. TG_ARGV[0] is the request_types.code. Attached per detail table so no client module can forget to route a request.';

-- -----------------------------------------------------------------------------
-- 2. Attendance regularization — the one that was reported
-- -----------------------------------------------------------------------------
--
-- `regularization_status` is its own enum ('draft','pending','approved',…), so
-- the WHEN clause names the value rather than sharing `approval_status`.

DROP TRIGGER IF EXISTS trg_ar_reg__raise_approval ON public.attendance_regularizations;
CREATE TRIGGER trg_ar_reg__raise_approval
  AFTER INSERT OR UPDATE OF status ON public.attendance_regularizations
  FOR EACH ROW
  WHEN (NEW.status = 'pending' AND NEW.approval_request_id IS NULL)
  EXECUTE FUNCTION public.raise_approval_for_detail('ATT_REGULARIZATION');

-- -----------------------------------------------------------------------------
-- 3. The four tables 041200/041300 created and nothing has raised for yet
-- -----------------------------------------------------------------------------
--
-- These have detail rows, chains and screens in various states of completeness.
-- Attaching the trigger now means that whenever a row IS written — by a screen
-- that exists or one built later — it routes. A table with no screen simply
-- never fires it.
--
-- Guarded per table: this migration must not fail on a deployment where one of
-- them has not been created yet.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
        ('overtime_preapprovals',   'OVERTIME'),
        ('shift_swaps',             'SHIFT_SWAP'),
        ('income_tax_declarations', 'IT_DECLARATION'),
        ('advance_requests',        'ADVANCE_REQUEST')
      ) AS v(tbl, code)
  LOOP
    CONTINUE WHEN to_regclass('public.' || r.tbl) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.request_types rt
       WHERE rt.code = r.code AND rt.deleted_at IS NULL);
    -- Only where the table can actually hold the link.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = r.tbl
         AND c.column_name = 'approval_request_id');

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                   'trg_' || r.tbl || '__raise_approval', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OF status ON public.%I '
      'FOR EACH ROW WHEN (NEW.status = ''pending'' AND NEW.approval_request_id IS NULL) '
      'EXECUTE FUNCTION public.raise_approval_for_detail(%L)',
      'trg_' || r.tbl || '__raise_approval', r.tbl, r.code);
    RAISE NOTICE 'routing attached: % → %', r.tbl, r.code;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Backfill what has already been filed and never routed
-- -----------------------------------------------------------------------------
--
-- Regularizations submitted before this migration are sitting pending with no
-- approval request — including the one that prompted the report. Touching
-- `status` to its own value fires the trigger without changing the row.
--
-- Bounded to rows that are still open: a request settled months ago does not
-- need an approver now.

UPDATE public.attendance_regularizations
   SET status = status
 WHERE status = 'pending'
   AND approval_request_id IS NULL;

COMMIT;
