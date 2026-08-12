-- =============================================================================
-- 20260801042600 — a decision reaches the thing that was decided
-- =============================================================================
--
-- REPORTED, from the admin approval inbox:
--
--   "ASSET_REQUEST-000024 decided and the decision is on the trail, but this
--    request type has no client-side path to update its own record, so that row
--    is untouched."
--
-- The banner is telling the truth, which is the only good thing about it.
--
-- ── THE SHAPE OF IT, WHICH IS 042100 AND 042300 A THIRD TIME ────────────────
--
-- `act_on_approval` writes `approval_requests` and `approval_actions` and stops.
-- Projecting that decision onto the detail row was left to the CLIENT, and the
-- client learned to do it for exactly one table:
--
--   · `leave_requests`   — `decideLeaveRequest`, from three inboxes.
--   · everything else    — nothing. The banner above.
--
-- Two tables were rescued one at a time by triggers that each name their table in
-- their own function body (`trg_ar__apply_claim` in 040500, `trg_ar__apply_travel`
-- shortly after). That is the right mechanism and the wrong granularity: it fixes
-- the table somebody complained about, and the eleventh table waits for an
-- eleventh complaint.
--
-- So: ONE trigger, for every detail table the engine can point at, that reads the
-- target's own catalogue at run time. A request type added next year is applied
-- the day it is added, by nobody remembering anything.
--
-- ── WHY A TRIGGER AND NOT A CALL FROM THE SCREEN ────────────────────────────
--
-- A decision arrives from six places: the team inbox, the admin inbox, the
-- reimbursement register, an admin override, an SLA escalation, and
-- `advance_approval` settling a chain on its own when the last level is skipped.
-- A client-side apply step runs for the first three. The other three are exactly
-- the paths nobody watches.
--
-- ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────────────
--
-- The detail tables do NOT share one status vocabulary. Probed, not assumed:
--
--   `approval_status`        12 labels, on 12 of the tables — direct copy
--   `leave_request_status`   no 'expired', no 'auto_approved'
--   `regularization_status`  no 'in_progress', 'withdrawn', 'expired',
--                            'auto_approved', 'escalated' or 'failed'
--
-- and they do not share one set of decision columns: `asset_requests` and
-- `document_requests` have no `decided_by` at all, while nine others carry
-- `decided_by` / `decided_at` / `decided_comment`. Every `decided_by` and
-- `approved_by` in the schema references `profiles` — checked across all sixteen
-- tables, because copying a profile id into a column expecting an employee id
-- would apply cleanly here and raise 23503 on the first real approval.
--
-- So the function asks the catalogue what the row can be told, maps into that
-- vocabulary, and records `apply_error` when it cannot — it never invents a label
-- and never aborts the approval. The decision is the record; the projection is a
-- convenience, and a convenience must not be able to destroy the record.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042600: one trigger projects every settled approval onto its own detail row, replacing the per-table triggers that each had to be asked for', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The projector
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_approval_to_detail()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tbl    text := NEW.detail_table;
  v_labels text[];
  v_target text;
  v_sets   text[];
  v_rows   integer;
BEGIN
  IF v_tbl IS NULL OR NEW.detail_id IS NULL THEN
    RETURN NULL;  -- a request type with no detail row: the trail IS the record
  END IF;

  IF to_regclass('public.' || v_tbl) IS NULL THEN
    UPDATE public.approval_requests
       SET apply_error = format('detail_table %L is not a table in this database', v_tbl)
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  /*
    What can this row's status column actually be told?

    Read every time rather than cached in a constant, because the constant is the
    thing that goes stale: `regularization_status` gained 'applied' in a later
    migration and any hard-coded list written before it would still be missing it.
  */
  SELECT array_agg(e.enumlabel::text)
    INTO v_labels
    FROM information_schema.columns c
    JOIN pg_catalog.pg_type ty ON ty.typname = c.udt_name
    JOIN pg_catalog.pg_enum e  ON e.enumtypid = ty.oid
   WHERE c.table_schema = 'public'
     AND c.table_name   = v_tbl
     AND c.column_name  = 'status';

  IF v_labels IS NULL THEN
    -- No status column, or one that is not an enum. Nothing to project onto.
    UPDATE public.approval_requests
       SET apply_error = format('%I has no enum status column to apply a decision to', v_tbl)
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  /*
    The mapping, in one CASE, narrowest first.

    'auto_approved' is an approval that skipped a level — to the employee it is an
    approval, and a table without the label should not lose the fact.
    'withdrawn' and 'expired' both end in 'cancelled' where the vocabulary is
    smaller, because "it is over and nobody granted it" is the fact both carry.
  */
  v_target := CASE
    WHEN NEW.status::text = ANY (v_labels)                      THEN NEW.status::text
    WHEN NEW.status = 'auto_approved'
         AND 'approved'  = ANY (v_labels)                       THEN 'approved'
    WHEN NEW.status IN ('withdrawn', 'expired', 'failed')
         AND 'cancelled' = ANY (v_labels)                       THEN 'cancelled'
    WHEN NEW.status = 'escalated'
         AND 'pending'   = ANY (v_labels)                       THEN 'pending'
    ELSE NULL
  END;

  IF v_target IS NULL THEN
    UPDATE public.approval_requests
       SET apply_error = format('%I cannot be told %L — its status accepts only: %s',
                                v_tbl, NEW.status::text, array_to_string(v_labels, ', '))
     WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  /*
    The decision columns, included only where the table has them.

    `%L` throughout rather than EXECUTE ... USING: the parameter count would have
    to match the columns that happen to exist, and format() renders a NULL as the
    NULL keyword correctly, which is the only value needing care here.
  */
  v_sets := ARRAY[format('status = %L', v_target)];

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=v_tbl AND column_name='decided_by') THEN
    v_sets := v_sets || format('decided_by = %L', NEW.decided_by);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=v_tbl AND column_name='decided_at') THEN
    v_sets := v_sets || format('decided_at = %L', COALESCE(NEW.decided_at, now()));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=v_tbl AND column_name='decided_comment') THEN
    v_sets := v_sets || format('decided_comment = %L', NEW.decision_comment);
  END IF;

  /*
    `status IS DISTINCT FROM` in the WHERE, so re-running this over a row already
    carrying the decision touches nothing — no audit row, no `updated_at` churn,
    and no second firing of whatever the detail table's own status trigger does
    (leave posts a ledger entry from there).
  */
  EXECUTE format(
    'UPDATE public.%I SET %s WHERE id = %L AND status IS DISTINCT FROM %L',
    v_tbl, array_to_string(v_sets, ', '), NEW.detail_id, v_target);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class WHERE false)  -- placeholder, see below
  THEN
    NULL;
  END IF;

  /*
    Zero rows means one of two things and they are not the same:
      · the row already said this — nothing to do, and not an error;
      · there is no such row — the approval points at something that is gone.
    Only the second is worth recording, so it is checked rather than assumed.
  */
  IF v_rows = 0 THEN
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id = %L', v_tbl, NEW.detail_id)
       INTO v_rows;
    IF v_rows = 0 THEN
      UPDATE public.approval_requests
         SET apply_error = format('no %I row with id %s', v_tbl, NEW.detail_id)
       WHERE id = NEW.id;
      RETURN NULL;
    END IF;
  END IF;

  -- Does not touch `status`, so this cannot re-enter the trigger.
  UPDATE public.approval_requests
     SET applied_at = now(), apply_error = NULL
   WHERE id = NEW.id;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.apply_approval_to_detail() IS
  'Projects a settled approval_request onto whatever detail row it points at, mapping into that table''s own status vocabulary and writing only the decision columns it has. Generic by design: the per-table version had to be written again for every table somebody noticed.';

-- -----------------------------------------------------------------------------
-- 2. Attached once, for every table the two specific triggers do not already own
-- -----------------------------------------------------------------------------
--
-- `reimbursement_claims` and `travel_requisitions` keep theirs: both do MORE than
-- set a status — the claim writes `total_approved_paise`, which the payslip
-- computation reads — and two triggers writing one row is how you get a race
-- nobody can reproduce.
--
-- `leave_requests` is excluded too, and this one is a judgement rather than a
-- conflict: `decideLeaveRequest` has applied it from the client for months, it
-- posts to `leave_ledger` through the detail table's own trigger, and quietly
-- taking that over in the same release as everything else would put the one
-- working path at risk to fix the ten that never worked. It stays on the client
-- until that move can be made on its own.

DROP TRIGGER IF EXISTS trg_ar__apply_detail ON public.approval_requests;
CREATE TRIGGER trg_ar__apply_detail
  AFTER UPDATE OF status ON public.approval_requests
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
        AND NEW.status IN ('approved','rejected','cancelled','withdrawn',
                           'expired','auto_approved','failed')
        AND NEW.detail_table IS NOT NULL
        AND NEW.detail_table NOT IN ('reimbursement_claims','travel_requisitions','leave_requests'))
  EXECUTE FUNCTION public.apply_approval_to_detail();

-- -----------------------------------------------------------------------------
-- 3. Everything already decided under the old behaviour
-- -----------------------------------------------------------------------------
--
-- ASSET_REQUEST-000024 is sitting decided-but-untouched right now, and it is not
-- alone. Without this the fix appears not to work for precisely the people who
-- used the system first.
--
-- Done as a loop over the settled requests rather than one UPDATE per table: the
-- mapping and the column list are already solved above, and re-solving them in
-- static SQL is where the two would drift apart.

DO $$
DECLARE
  r        record;
  v_before text;
  v_done   integer := 0;
  v_skip   integer := 0;
BEGIN
  FOR r IN
    SELECT ar.id, ar.request_number, ar.detail_table, ar.detail_id, ar.status
      FROM public.approval_requests ar
     WHERE ar.detail_table IS NOT NULL
       AND ar.detail_id    IS NOT NULL
       AND ar.status IN ('approved','rejected','cancelled','withdrawn',
                         'expired','auto_approved','failed')
       AND ar.detail_table NOT IN ('reimbursement_claims','travel_requisitions','leave_requests')
       AND to_regclass('public.' || ar.detail_table) IS NOT NULL
     ORDER BY ar.decided_at NULLS LAST
  LOOP
    EXECUTE format('SELECT status::text FROM public.%I WHERE id = %L', r.detail_table, r.detail_id)
       INTO v_before;

    CONTINUE WHEN v_before IS NULL;                    -- the row is gone
    IF v_before NOT IN ('draft','pending','in_progress','escalated') THEN
      v_skip := v_skip + 1;                            -- already settled somehow
      CONTINUE;
    END IF;

    /*
      Re-stating the status is what fires the trigger above, so the backfill uses
      exactly the code the live path uses. `UPDATE ... SET status = status` would
      not: the trigger's WHEN clause requires the value to change.
    */
    UPDATE public.approval_requests SET status = 'pending' WHERE id = r.id;
    UPDATE public.approval_requests SET status = r.status WHERE id = r.id;
    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE 'decisions projected onto their detail row: % (already settled: %)', v_done, v_skip;
END $$;

COMMIT;
