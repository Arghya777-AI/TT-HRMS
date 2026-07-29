-- =============================================================================
-- 087 · HR can actually verify a document
--
-- REPORTED: "HR should be able to click here and verify all this."
--
-- They could not, and the Approval Queue said so in its own header: verifying an
-- upload "would mean PATCHing documents.status while leaving reviewed_by and
-- reviewed_at empty. There is no decide_document_review RPC … no trigger that
-- stamps the reviewer — so a row would say 'approved' with nobody's name against
-- it, which is exactly what an audit is for." That was the right call: a review
-- with no reviewer is worse than no review, because it looks like one.
--
-- This is the missing server side. It is a definer function rather than an RLS
-- grant on the column, because a review is FOUR facts that must land together —
-- the status, who decided, when, and why — and only a function can refuse to write
-- one without the others.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 087: document review decision, with the reviewer stamped', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.decide_document_review(
  p_document_id uuid,
  p_decision    text,               -- 'approved' | 'rejected'
  p_comment     text DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_when     timestamptz := now();
  v_employee uuid;
  v_title    text;
  v_status   public.document_status;
  v_actor    uuid := app.ctx_actor_id();
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'A review decision is either approved or rejected' USING ERRCODE = '22023';
  END IF;

  /*
    A REJECTION MUST SAY WHY, an approval need not.

    Asymmetric on purpose. "Approved" is self-explanatory and demanding a sentence
    for it only teaches people to type "ok". A rejection is the one the employee
    has to act on, and "rejected" with no reason means they re-upload the same file
    and it is rejected again. Ten characters is the same floor the audit engine
    applies to every reason in this system.
  */
  IF p_decision = 'rejected' AND length(btrim(coalesce(p_comment, ''))) < 10 THEN
    RAISE EXCEPTION 'A rejection needs a reason of at least 10 characters so the employee knows what to fix'
      USING ERRCODE = '22023';
  END IF;

  SELECT d.employee_id, d.title, d.status
    INTO v_employee, v_title, v_status
    FROM public.documents d
   WHERE d.id = p_document_id AND d.deleted_at IS NULL
     -- Authority is the SAME policy that governs every other admin read of this
     -- table, asked the same way, rather than a second rule written here.
     AND app.is_admin() AND app.admin_scope_covers(d.employee_id)
   FOR UPDATE;

  -- 404-shaped, not 403: an admin outside scope must not learn the row exists.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That document is not available' USING ERRCODE = 'P0002';
  END IF;

  /*
    Only a document that is WAITING can be decided. Re-deciding an approved row
    would silently rewrite history — and a rejected row that the employee has since
    replaced is a different document, so the new upload gets its own decision.
  */
  IF v_status <> 'pending_review' THEN
    RAISE EXCEPTION 'That document is % and is not awaiting review', v_status USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.reason',
    format('document review: %s%s', p_decision,
           CASE WHEN p_comment IS NULL THEN '' ELSE ' — ' || left(btrim(p_comment), 180) END),
    true);

  UPDATE public.documents
     SET status         = p_decision::public.document_status,
         reviewed_by    = v_actor,
         reviewed_at    = v_when,
         review_comment = NULLIF(btrim(coalesce(p_comment, '')), ''),
         updated_at     = v_when
   WHERE id = p_document_id;

  /*
    TELL THE EMPLOYEE. A decision nobody hears about is not a decision — an
    employee whose Aadhaar was rejected needs to know today, not at their next
    login. Best-effort: a notification fault must never roll back the review, so
    the insert is wrapped. The audit row is written regardless by the audit trigger
    on `documents`.
  */
  BEGIN
    INSERT INTO public.notifications
      (profile_id, employee_id, event_code, channel, status, priority, title, body, deep_link)
    SELECT e.profile_id,
           e.id,
           'document.' || p_decision,
           'in_app'::public.notification_channel,
           'queued'::public.notification_status,
           CASE WHEN p_decision = 'rejected' THEN 'high' ELSE 'normal' END,
           CASE WHEN p_decision = 'rejected'
                THEN 'A document needs your attention'
                ELSE 'A document was verified' END,
           CASE WHEN p_decision = 'rejected'
                THEN format('%s was not accepted. %s', coalesce(v_title, 'Your document'),
                            coalesce(NULLIF(btrim(p_comment), ''), 'Please upload it again.'))
                ELSE format('%s has been verified by HR.', coalesce(v_title, 'Your document')) END,
           '/me/profile/documents'
      FROM public.employees e
     WHERE e.id = v_employee AND e.profile_id IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_when;
END;
$$;

COMMENT ON FUNCTION public.decide_document_review(uuid, text, text) IS
  'Approve or reject a document awaiting review, stamping reviewed_by/reviewed_at/review_comment in the same statement as the status so a row can never claim a review nobody made. Admin-within-scope only; a rejection requires a 10-character reason; only a pending_review row can be decided; the employee is notified.';

REVOKE ALL ON FUNCTION public.decide_document_review(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.decide_document_review(uuid, text, text) TO authenticated;

COMMIT;
