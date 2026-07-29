-- =============================================================================
-- 088 · HR hears about it when an employee changes their own details
--
-- REPORTED: "HR/admin is not getting any notification when somebody has changed
-- something. That audit trail — where is that?"
--
-- Two separate facts sat behind that one sentence, and only one of them was a bug.
--
--   THE AUDIT TRAIL WAS NEVER MISSING. `audit.log_changes()` has been on all of
--   these tables from the start, and `document_access_log` now records every file
--   opened (migration 086/087 work). Nothing was going unrecorded.
--
--   THE NOTIFICATIONS GENUINELY WERE. A count of notify triggers across
--   `employees`, `employee_change_requests`, `employee_statutory`,
--   `employee_bank_accounts` and `employee_custom_field_values` returned ZERO on
--   every one. Only documents notified (migration 084). So an employee could submit
--   a change request or replace their bank account and HR would find out by
--   happening to open the queue.
--
-- An audit trail answers "what happened?" AFTER you know to ask. A notification is
-- what makes you ask. They are not substitutes, which is why this adds the second
-- one and leaves the first alone.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 088: notify admins when an employee changes their own record', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. One place that decides who to tell
-- -----------------------------------------------------------------------------

/*
  Every notify trigger below funnels through this, so "who is HR" is defined once.
  It is the same test migration 084 used for documents: an unrevoked admin or
  super_admin role.

  DELIBERATELY NOT SCOPE-FILTERED. `app.admin_scope_covers` is a per-caller test and
  there is no caller here — the trigger runs as the employee. Telling every admin is
  the safe direction to be wrong in: the alternative is a change nobody is told
  about because the one admin who covers that employee could not be resolved.
*/
CREATE OR REPLACE FUNCTION app.notify_admins(
  p_event_code  text,
  p_title       text,
  p_body        text,
  p_deep_link   text,
  p_employee_id uuid,
  p_priority    text DEFAULT 'normal'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.notifications
    (profile_id, employee_id, event_code, channel, status, priority, title, body, deep_link)
  SELECT DISTINCT ur.user_id,
         p_employee_id,
         p_event_code,
         'in_app'::public.notification_channel,
         'queued'::public.notification_status,
         p_priority,
         p_title,
         p_body,
         p_deep_link
    FROM public.user_roles ur
   WHERE ur.role IN ('admin', 'super_admin') AND ur.revoked_at IS NULL;
END;
$$;

COMMENT ON FUNCTION app.notify_admins(text, text, text, text, uuid, text) IS
  'Queue one in-app notification per active admin. The single definition of "tell HR" used by the employee-change triggers.';

-- -----------------------------------------------------------------------------
-- 2. A change request was submitted
-- -----------------------------------------------------------------------------

/*
  This is the DESIGNED path for an employee editing their own details: the edit
  becomes a row here for HR to decide. It notified nobody, so the queue only worked
  for an admin who thought to look at it.

  Fires on INSERT only. The decision path is HR's own action and does not need to
  notify HR about itself; the employee is told separately by the approval flow.

  `field_label` is used rather than `field_name` — the notification is read by a
  person, and "Bank account number" is what they need to see, not
  `account_number_last4`.
*/
CREATE OR REPLACE FUNCTION public.change_request_notify_hr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text;
  v_self boolean;
BEGIN
  SELECT e.display_name, (e.profile_id = NEW.requested_by)
    INTO v_name, v_self
    FROM public.employees e WHERE e.id = NEW.employee_id;

  -- Only when the EMPLOYEE asked. HR editing on someone's behalf does not need to
  -- notify HR — that is the noise that trains people to ignore the channel.
  IF NOT COALESCE(v_self, false) THEN RETURN NEW; END IF;

  BEGIN
    PERFORM app.notify_admins(
      'employee.change_requested',
      'A change is waiting for your approval',
      format('%s asked to change %s.%s',
             COALESCE(v_name, 'An employee'),
             COALESCE(NULLIF(btrim(NEW.field_label), ''), NEW.field_name),
             CASE WHEN NEW.is_sensitive THEN ' This field is marked sensitive.' ELSE '' END),
      '/admin/people/changes',
      NEW.employee_id,
      -- A sensitive field (statutory id, bank, salary) outranks a phone number.
      CASE WHEN NEW.is_sensitive THEN 'high' ELSE 'normal' END
    );
  EXCEPTION WHEN OTHERS THEN
    -- Fail open, always: a notification fault must never stop an employee
    -- submitting a correction to their own record.
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ecr__notify_hr ON public.employee_change_requests;
CREATE TRIGGER trg_ecr__notify_hr
AFTER INSERT ON public.employee_change_requests
FOR EACH ROW EXECUTE FUNCTION public.change_request_notify_hr();

-- -----------------------------------------------------------------------------
-- 3. Bank details moved
-- -----------------------------------------------------------------------------

/*
  THE ONE THAT MATTERS MOST. Salary is paid to whatever account is active, so a
  changed account number moves money. Even though the change should arrive as a
  change request, a direct write is possible for HR and for any future path, and
  this is the last thing that should depend on a code path being followed correctly.

  So it notifies on ANY insert or account change here, by ANYBODY — including HR
  itself, unlike the rule above. When the destination of somebody's salary changes,
  every admin should know, whoever did it.

  `account_number_last4` is what goes in the body. The full number is never put in a
  notification: notifications are read on lock screens and forwarded to email, and
  the point is to prompt somebody to look, not to relocate a bank account number
  into a less protected table.
*/
CREATE OR REPLACE FUNCTION public.bank_account_notify_hr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text;
BEGIN
  SELECT e.display_name INTO v_name FROM public.employees e WHERE e.id = NEW.employee_id;

  BEGIN
    PERFORM app.notify_admins(
      'employee.bank_changed',
      'Bank details changed',
      format('The salary account for %s now ends %s at %s. Verify it before the next payroll run.',
             COALESCE(v_name, 'an employee'),
             COALESCE(NEW.account_number_last4, '????'),
             COALESCE(NULLIF(btrim(NEW.bank_name), ''), 'an unnamed bank')),
      '/admin/payroll/bank-advice',
      NEW.employee_id,
      'high'
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank__notify_hr ON public.employee_bank_accounts;
CREATE TRIGGER trg_bank__notify_hr
AFTER INSERT OR UPDATE OF account_number, ifsc, beneficiary_name, is_active
ON public.employee_bank_accounts
FOR EACH ROW EXECUTE FUNCTION public.bank_account_notify_hr();

-- -----------------------------------------------------------------------------
-- 4. Statutory identity changed
-- -----------------------------------------------------------------------------

/*
  Aadhaar, PAN, UAN, ESI. These drive statutory filing, so a change here has
  consequences outside this system and HR has to re-verify against the document.
*/
CREATE OR REPLACE FUNCTION public.statutory_notify_hr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text;
BEGIN
  SELECT e.display_name INTO v_name FROM public.employees e WHERE e.id = NEW.employee_id;
  BEGIN
    PERFORM app.notify_admins(
      'employee.statutory_changed',
      'Statutory identity changed',
      format('A statutory identifier for %s was added or changed. Check it against the document on file.',
             COALESCE(v_name, 'an employee')),
      '/admin/people/directory',
      NEW.employee_id,
      'high'
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_statutory__notify_hr ON public.employee_statutory;
CREATE TRIGGER trg_statutory__notify_hr
AFTER INSERT OR UPDATE OF aadhaar_number, aadhaar_last4, pan, uan, esi_number
ON public.employee_statutory
FOR EACH ROW EXECUTE FUNCTION public.statutory_notify_hr();

COMMIT;
