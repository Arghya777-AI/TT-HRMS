-- ============================================================================
-- One reader for the record behind ANY approval request.
--
-- ── WHAT HR ASKED FOR, IN THEIR WORDS ───────────────────────────────────────
-- "No details are showing properly, but every detail should be shown properly.
--  Every detail should be coming — images, what they applied for, what is the
--  reason, and at what time they applied. Right now only the times are coming,
--  but not the reason or the purpose. If they have attached a document or not,
--  nothing is coming. This is happening in approvals, and also in workflow, and
--  in reimbursement as well."
--
-- All of it true. The Approval Inbox rendered `approval_requests` — dates, days,
-- an amount, the SLA clocks — and never opened the row it names through
-- `detail_table` / `detail_id`. So a leave request showed no reason, and the
-- `leave_requests.supporting_document_id` attachment had no reader ANYWHERE in
-- the app. There are 19 request types over 13 detail tables; leave alone accounts
-- for 25 requests.
--
-- ── WHY ONE DYNAMIC READER AND NOT 13 HAND-WRITTEN ONES ─────────────────────
-- Thirteen bespoke readers is thirteen chances to forget the reason column, and a
-- fourteenth request type ships with an empty panel by default — which is exactly
-- the state being complained about. This reads whatever the detail row holds, so a
-- new request type is covered the day its table exists.
--
-- Every reason column in the schema today, found rather than assumed:
--   reason, employee_reason, decision_comment, decided_comment, purpose,
--   travel_purpose, notes, note, declaration_note, handover_notes, remark,
--   reason_category, waiver_reason, consent_comment, cancellation_reason
-- and every attachment column:
--   supporting_document_id, proof_document_ids, letter_document_id,
--   fulfilled_document_id, receipt_document_id (on claim_lines)
--
-- ── SECURITY: RLS ANSWERS, NOT THIS FUNCTION ────────────────────────────────
-- SECURITY INVOKER (plpgsql's default, stated explicitly below so nobody "fixes"
-- it to DEFINER). Both reads — the approval request and the detail row — run as
-- the caller, so an approver sees exactly the rows their policies allow. A detail
-- row that does not come back returns `readable: false`, which the screen must
-- render as "outside what you can read" and NEVER as "no details" — those are
-- different facts and conflating them is how an approver concludes an employee
-- attached nothing.
--
-- The table name reaches dynamic SQL only after being matched against
-- `request_types.detail_table`, and is quoted with %I regardless.
-- ============================================================================

SELECT set_config('app.reason',
  'one reader for the record behind any approval request: reasons, purposes, times and attachments were invisible to approvers across all 19 request types',
  true);

/*
  Plumbing keys. Dropped so the panel shows the REQUEST, not the row's
  bookkeeping. Audit ids, tenancy and the approval linkage are all either shown
  elsewhere on the panel already or meaningless to a human approver.

  `employee_id` goes because the panel already names the subject in its heading.
  The *_document_id keys go from `fields` because they are returned separately in
  `documents`, where the screen can attach an open button to each.
*/
CREATE OR REPLACE FUNCTION public.approval_evidence_is_plumbing(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $fn$
  SELECT p_key IN (
      'id', 'company_id', 'employee_id', 'approval_request_id',
      'created_at', 'created_by', 'updated_at', 'updated_by',
      'deleted_at', 'deleted_by', 'search_vector'
    )
    -- Attachments come back separately, in `documents`, so the screen can hang an
    -- open button on each rather than printing a uuid.
    OR p_key LIKE '%\_document\_id'
    OR p_key LIKE '%\_document\_ids'
    /*
      EVERY OTHER FOREIGN KEY AND ACTOR COLUMN. A raw uuid is not a detail, it is a
      detail an approver cannot read: `leave_type_id`, `application_group_id`,
      `created_punch_ids`, `decided_by`. The ones that carry meaning are resolved to
      names before this filter runs (see `leave_type` below), and the actors are
      already on the panel's action trail with their names.
    */
    OR p_key LIKE '%\_id'
    OR p_key LIKE '%\_ids'
    OR p_key LIKE '%\_by';
$fn$;

CREATE OR REPLACE FUNCTION public.approval_request_evidence(p_approval_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER          -- deliberate: RLS decides what this returns
SET search_path TO ''
AS $fn$
DECLARE
  v_table  text;
  v_detail uuid;
  v_row    jsonb;
  v_fields jsonb := '{}'::jsonb;
  v_docs   uuid[] := '{}';
  v_lines  jsonb := '[]'::jsonb;
  k        text;
  v        jsonb;
BEGIN
  /*
    The approval request first, under the caller's own policies. An approver who
    cannot see the request gets nothing — not a hint that it exists.
  */
  SELECT ar.detail_table, ar.detail_id
    INTO v_table, v_detail
    FROM public.approval_requests ar
   WHERE ar.id = p_approval_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- The whitelist. `detail_table` is admin-managed data, not user input, and it
  -- still does not reach dynamic SQL without matching a registered type.
  IF NOT EXISTS (SELECT 1 FROM public.request_types rt
                  WHERE rt.detail_table = v_table AND rt.deleted_at IS NULL)
     OR to_regclass('public.' || quote_ident(v_table)) IS NULL THEN
    RETURN jsonb_build_object('found', true, 'detail_table', v_table,
                              'readable', false, 'unknown_table', true);
  END IF;

  BEGIN
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_table)
       INTO v_row USING v_detail;
  EXCEPTION WHEN insufficient_privilege THEN
    v_row := NULL;
  END;

  /*
    NULL here is an ACCESS outcome, not an empty request. The row is named by an
    approval this caller can read; RLS simply did not hand it over.
  */
  IF v_row IS NULL THEN
    RETURN jsonb_build_object('found', true, 'detail_table', v_table,
                              'detail_id', v_detail, 'readable', false);
  END IF;

  /*
    ── RESOLVE THE KEYS THAT CARRY MEANING, BEFORE THE UUID FILTER ──────────
    `leave_type_id` is the single most important label on the highest-volume request
    type: an approver deciding leave has to know WHICH leave. The type name is not on
    `leave_requests`, and the panel's heading says only "Leave", so without this the
    one fact that distinguishes a week-off from sick leave never reaches the screen.

    Added as its own key so it survives the `%_id` filter below.
  */
  IF v_row ? 'leave_type_id' THEN
    v_fields := v_fields || jsonb_build_object('leave_type',
      (SELECT lt.name FROM public.leave_types lt
        WHERE lt.id = (v_row->>'leave_type_id')::uuid));
  END IF;

  -- ── Split the row into shown fields and attachments ──────────────────────
  FOR k, v IN SELECT key, value FROM jsonb_each(v_row) LOOP
    IF k LIKE '%\_document\_id' AND jsonb_typeof(v) = 'string' THEN
      v_docs := v_docs || (v #>> '{}')::uuid;
    ELSIF k LIKE '%\_document\_ids' AND jsonb_typeof(v) = 'array' THEN
      v_docs := v_docs || ARRAY(SELECT (e #>> '{}')::uuid
                                  FROM jsonb_array_elements(v) e
                                 WHERE jsonb_typeof(e) = 'string');
    ELSIF NOT public.approval_evidence_is_plumbing(k) AND jsonb_typeof(v) <> 'null' THEN
      v_fields := v_fields || jsonb_build_object(k, v);
    END IF;
  END LOOP;

  /*
    Claims keep their money on CHILD rows, so a row dump alone would show an
    approver a claim with no lines and no bill — the original complaint. Every
    other detail table in the schema is flat.
  */
  IF v_table = 'reimbursement_claims' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(cl) ORDER BY cl.line_date), '[]'::jsonb)
      INTO v_lines
      FROM public.claim_lines cl
     WHERE cl.claim_id = v_detail;

    v_docs := v_docs || ARRAY(
      SELECT cl.receipt_document_id FROM public.claim_lines cl
       WHERE cl.claim_id = v_detail AND cl.receipt_document_id IS NOT NULL);
  END IF;

  RETURN jsonb_build_object(
    'found',        true,
    'readable',     true,
    'detail_table', v_table,
    'detail_id',    v_detail,
    'fields',       v_fields,
    'lines',        v_lines,
    -- Deduplicated: a claim whose two lines cite one bill must not offer it twice.
    'documents',    to_jsonb(ARRAY(SELECT DISTINCT unnest(v_docs))));
END;
$fn$;

REVOKE ALL ON FUNCTION public.approval_request_evidence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_evidence(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.approval_request_evidence(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.approval_evidence_is_plumbing(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_evidence_is_plumbing(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.approval_evidence_is_plumbing(text) TO authenticated;

COMMENT ON FUNCTION public.approval_request_evidence(uuid) IS
  'The detail row behind an approval request, as fields plus attachment ids, for every request type. SECURITY INVOKER so RLS decides; readable=false means the row exists and the caller may not read it, which is not the same as an empty request.';
