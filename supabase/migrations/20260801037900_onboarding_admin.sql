-- =============================================================================
-- 084 · The HR side of onboarding: the queue, the review write, and the notice
--
-- Completes migration 083. That one gave the joiner a pack and a way to close it; this
-- gives HR the list to work from, a way to record that they looked, and a notice when a
-- document is replaced AFTER onboarding — which was explicitly asked for, because a
-- document can be changed at any time, not only on day one.
-- =============================================================================

SELECT set_config('app.reason', 'migration 084: onboarding review queue and document notice', true);

-- -----------------------------------------------------------------------------
-- 1. The queue
-- -----------------------------------------------------------------------------

/*
  Row scope is manager-or-scoped-admin, matching every other people view. `can_manage` is
  admin-only, because waiving and reviewing are HR acts — a manager may see that their new
  joiner has not finished, which is useful, without being able to sign it off.

  `outstanding_documents` counts REQUIRED document types with nothing uploaded. It is the
  substantive part of what HR chases. Custom-field completeness is deliberately NOT counted
  here: `submit_onboarding` already refuses while any configured field is missing, so a
  submitted row cannot be missing one, and computing it again per-employee would be a second
  implementation of a rule that already has one.
*/
CREATE OR REPLACE VIEW public.v_onboarding_queue
WITH (security_barrier = true) AS
SELECT
  e.id                                   AS employee_id,
  e.employee_code,
  e.display_name,
  e.date_of_join,
  d.name                                 AS department_name,
  e.employment_type::text                AS employment_type,
  o.submitted_at,
  o.reviewed_at,
  o.review_note,
  o.waived_at,
  o.waived_reason,
  /* The one word HR sorts by. */
  CASE
    WHEN o.submitted_at IS NULL      THEN 'not_started'
    WHEN o.waived_at    IS NOT NULL  THEN 'waived'
    WHEN o.reviewed_at  IS NULL      THEN 'awaiting_review'
    ELSE 'reviewed'
  END                                    AS state,
  (
    SELECT count(*)
      FROM public.document_types t
     WHERE t.is_active AND t.deleted_at IS NULL
       AND t.is_required_for_onboarding
       AND (t.required_for_employment_types IS NULL
            OR e.employment_type = ANY (t.required_for_employment_types))
       AND NOT EXISTS (
         SELECT 1 FROM public.documents dd
          WHERE dd.employee_id = e.id
            AND dd.document_type_id = t.id
            AND dd.deleted_at IS NULL
       )
  )::integer                             AS outstanding_documents,
  (app.is_admin() AND app.admin_scope_covers(e.id)) AS can_manage
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
LEFT JOIN public.employee_onboarding o ON o.employee_id = e.id
WHERE e.deleted_at IS NULL
  AND (app.is_manager_of(e.id) OR (app.is_admin() AND app.admin_scope_covers(e.id)));

COMMENT ON VIEW public.v_onboarding_queue IS
  'Who has finished first-login onboarding and who has not, with the count of required documents still missing. Visible to a manager for their team and to a scoped admin; can_manage is admin-only because waiving and reviewing are HR acts.';

GRANT SELECT ON public.v_onboarding_queue TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Recording that HR looked
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.review_onboarding(
  p_employee_id uuid,
  p_note        text DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE v_when timestamptz;
BEGIN
  IF NOT (app.is_admin() AND app.admin_scope_covers(p_employee_id)) THEN
    RAISE EXCEPTION 'Only an admin may review onboarding' USING ERRCODE = '42501';
  END IF;
  /*
    Reviewing does NOT grant anything — access was granted at submit, which is what "instant
    access, review afterwards" means. This only records that a human looked, so an unreviewed
    submission is a task rather than a blocked employee.
  */
  IF NOT EXISTS (SELECT 1 FROM public.employee_onboarding
                  WHERE employee_id = p_employee_id AND submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'That employee has not submitted their onboarding yet' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.reason', 'onboarding reviewed by admin after submission', true);

  UPDATE public.employee_onboarding
     SET reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_note = NULLIF(btrim(coalesce(p_note, '')), ''),
         updated_at  = now()
   WHERE employee_id = p_employee_id
  RETURNING reviewed_at INTO v_when;

  RETURN v_when;
END;
$$;

COMMENT ON FUNCTION public.review_onboarding(uuid, text) IS
  'Record that HR has checked a submitted onboarding. Admin-within-scope only. Grants nothing — access was already given at submit.';

REVOKE ALL ON FUNCTION public.review_onboarding(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.review_onboarding(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Tell HR when a document changes after the fact
-- -----------------------------------------------------------------------------

/*
  A document may be uploaded or replaced at any time, by the employee or by HR. When the
  EMPLOYEE does it after they have already submitted, somebody needs to know — otherwise a
  bank proof can be swapped for a different account and nothing announces it.

  Three deliberate narrowings:

    * Only AFTER submit. During onboarding the whole point is that they are uploading; a
      notice per upload on day one would be noise that trains people to ignore the channel.
    * Only when the EMPLOYEE is the actor. HR replacing a document does not need to notify HR.
    * FAIL-OPEN. The insert is wrapped so a notification problem can never stop a joiner
      uploading their Aadhaar. The upload is the thing that matters; the notice is
      best-effort, and the audit row is written regardless by the existing audit trigger.
*/
CREATE OR REPLACE FUNCTION public.documents_notify_hr_on_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_submitted timestamptz;
  v_actor     uuid := app.ctx_actor_id();
  v_self      boolean;
BEGIN
  IF NEW.employee_id IS NULL THEN RETURN NEW; END IF;

  SELECT o.submitted_at INTO v_submitted
    FROM public.employee_onboarding o WHERE o.employee_id = NEW.employee_id;
  IF v_submitted IS NULL THEN RETURN NEW; END IF;   -- still onboarding: expected, no notice

  SELECT (e.profile_id = v_actor) INTO v_self
    FROM public.employees e WHERE e.id = NEW.employee_id;
  IF NOT COALESCE(v_self, false) THEN RETURN NEW; END IF;  -- HR's own change

  BEGIN
    /*
      Real column names, checked against the deployed table rather than assumed: the
      recipient is `profile_id`, the kind is `event_code`, and the link is `deep_link`.
      `channel` is the notification_channel enum and `in_app` is the only one that needs no
      provider; a queued email would sit unsent unless the dispatcher picks this event up.
    */
    INSERT INTO public.notifications
      (profile_id, employee_id, event_code, channel, status, priority, title, body, deep_link)
    SELECT ur.user_id,
           NEW.employee_id,
           'document.changed_after_onboarding',
           'in_app'::public.notification_channel,
           'queued'::public.notification_status,
           'normal',
           'A document was changed after onboarding',
           format('%s uploaded or replaced a document (%s) after their onboarding was submitted.',
                  (SELECT e2.display_name FROM public.employees e2 WHERE e2.id = NEW.employee_id),
                  (SELECT t.name FROM public.document_types t WHERE t.id = NEW.document_type_id)),
           '/admin/documents/vault'
      FROM public.user_roles ur
     WHERE ur.role IN ('admin', 'super_admin') AND ur.revoked_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    -- See the header: never block the upload for the sake of the notice.
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents__notify_hr ON public.documents;
CREATE TRIGGER trg_documents__notify_hr
AFTER INSERT OR UPDATE OF document_type_id, deleted_at ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.documents_notify_hr_on_change();

COMMENT ON FUNCTION public.documents_notify_hr_on_change() IS
  'Notifies admins when an EMPLOYEE changes a document AFTER their onboarding was submitted. Silent during onboarding and for HR''s own changes, and fails open so a notification fault can never block an upload.';
