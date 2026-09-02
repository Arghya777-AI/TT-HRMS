-- ============================================================================
-- Every employee can see who is on leave, and whether it is a half day.
--
-- ── THE DECISION, AND WHOSE IT IS ───────────────────────────────────────────
-- Asked for by the venue, after being told plainly what it discloses: the leave
-- TYPE is visible to every colleague, so Sick Leave and Maternity Leave are visible
-- to every colleague. That is the venue's call to make and it has been made.
--
-- ── WHY A NEW VIEW AND NOT A WIDER RLS POLICY ───────────────────────────────
-- The obvious implementation is to relax `leave_requests__scope_read`, which today
-- restricts rows to `app.visible_employee_ids()`. That would deliver what was asked
-- and a great deal more, because `leave_requests` also carries:
--
--     reason, contact_during_leave, address_during_leave, handover_notes,
--     decision_comment, cancellation_reason, supporting_document_id
--
-- Home addresses, personal phone numbers, the free text somebody typed to explain a
-- bereavement, and the pointer to a medical certificate. "Names and leave type" does
-- not mean any of that, and a policy is a blunt instrument: once the rows are
-- readable, every column on them is readable, including columns added later by
-- somebody who never saw this note.
--
-- So the widening is a VIEW with exactly the columns that were asked for, running as
-- its owner (`security_invoker = false`) so the base-table policies do not apply to
-- it. `leave_requests` itself stays scoped as it is. What a colleague can see is
-- therefore the list below and cannot grow by accident.
--
-- ── APPROVED ONLY, WHICH IS A CORRECTNESS POINT NOT A PRIVACY ONE ───────────
-- The admin calendars show pending requests too. This one does not, because a
-- pending request is not a fact yet: rendering "Ravi is on leave" for a day nobody
-- has granted would be wrong information on a screen people plan around, and it
-- would also disclose a request that may be refused.
--
-- ── PEOPLE OUTSIDE LEAVE TRACKING ARE ABSENT FROM IT ────────────────────────
-- `exclude_from_leave_tracking` already marks the accounts that are administrators
-- rather than venue staff. They do not belong on a roster of who is off.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_leave_roster
WITH (security_invoker = false, security_barrier = true) AS
SELECT
  lrd.id                AS leave_request_day_id,
  e.id                  AS employee_id,
  e.employee_code,
  e.display_name,
  e.photo_path,
  e.department_id,
  d.name                AS department_name,
  lrd.leave_date,
  lrd.portion::text     AS portion,
  lt.code               AS leave_type_code,
  lt.name               AS leave_type_name,
  lt.colour_hex
FROM public.leave_request_days lrd
JOIN public.leave_requests lr ON lr.id = lrd.leave_request_id
JOIN public.employees      e  ON e.id  = lr.employee_id
LEFT JOIN public.departments d ON d.id = e.department_id
JOIN public.leave_types     lt ON lt.id = lr.leave_type_id
WHERE lr.status IN ('approved', 'partially_approved')
  AND e.deleted_at IS NULL
  AND NOT e.exclude_from_leave_tracking;

COMMENT ON VIEW public.v_leave_roster IS
  'Who is on approved leave, company-wide, readable by any authenticated employee. Deliberately narrow: name, department, leave type and portion only — never the reason, address, contact, handover notes or supporting document that live on leave_requests. Runs as owner so leave_requests keeps its own row scope.';

-- ── GRANTS, AND WHY THEY ARE SPELLED OUT ROLE BY ROLE ───────────────────────
-- `REVOKE ALL ... FROM PUBLIC` is not enough here and the first version of this file
-- got it wrong. Supabase ships ALTER DEFAULT PRIVILEGES that grant the full set to
-- `anon` and `authenticated` on every new object in `public`, and those are grants to
-- named roles — revoking from PUBLIC does not touch them. The view was created
-- readable by `anon`, which is the UNAUTHENTICATED role: the leave roster of the
-- whole venue, including who is on sick leave, exposed to anybody holding the
-- publishable anon key.
--
-- That is the exact opposite of the decision being implemented. The decision was to
-- show this to COLLEAGUES.
--
-- So every role is revoked explicitly and only `authenticated` is granted back, and
-- only SELECT. The write grants are revoked too: this view has joins so Postgres
-- will not auto-update it today, but a future simplification could make it
-- auto-updatable and inherit a grant nobody meant to give.
REVOKE ALL ON public.v_leave_roster FROM PUBLIC;
REVOKE ALL ON public.v_leave_roster FROM anon;
REVOKE ALL ON public.v_leave_roster FROM authenticated;
GRANT SELECT ON public.v_leave_roster TO authenticated;
