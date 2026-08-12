-- =============================================================================
-- 20260801042800 — HR publishes a policy, and the employee reads or signs it
-- =============================================================================
--
-- ASKED FOR: "HR/admin/super-admin will upload policies and employee have to
-- some time just read or sometime have to sign it to that document also".
--
-- ── WHAT WAS ALREADY BUILT, AND WHY IT SHOWED NOTHING ───────────────────────
--
-- Nearly all of it. A policy is a `documents` row with `subject_kind = 'policy'`
-- and a type whose `requires_acknowledgement` is set (POLICY and SOP are both
-- seeded); the per-employee assignment is a `document_acknowledgements` row; the
-- reader at /me/policies/:slug already measures scroll depth and dwell time
-- against `document_acknowledgements_ack_guard` — 90% scrolled, 8 seconds a page.
--
-- Three things were missing, and each one alone was enough to make the screen say
-- "No policies assigned to you yet" forever:
--
--   1. NOBODY COULD PUBLISH. There is no path in the application that inserts a
--      policy document or assigns it. The console screen says so in its own
--      header and calls itself a register rather than an uploader.
--
--   2. AN EMPLOYEE CANNOT READ A POLICY ROW. `documents__self__select` requires
--      `employee_id = app.current_employee_id()`, and a policy document has no
--      employee — it belongs to the company. So even a correctly assigned policy
--      was invisible: the assignment row was readable and the document it points
--      at was not.
--
--   3. AN EMPLOYEE CANNOT ACKNOWLEDGE. 025 wrote SELECT policies for
--      `document_acknowledgements` and left a comment saying the acknowledge
--      action "goes through a SECURITY DEFINER RPC per §4.4". That RPC was never
--      written. `policies.api.ts` carries the finding in its own error message:
--      "Self-acknowledgement needs an UPDATE policy … (migration 025 defines
--      SELECT only)". The button existed and the write was always going to be
--      refused.
--
-- ── READ, OR SIGN ───────────────────────────────────────────────────────────
--
-- Both, chosen per document, on `documents.requires_esign`:
--
--   false → reading it is the whole obligation. The gates still apply.
--   true  → the employee must additionally TYPE THEIR OWN NAME, and it must match
--           the name on their employee record. That is a typed signature: the
--           text, a SHA-256 of it, and the moment are all recorded.
--
-- A drawn signature was the alternative and is deliberately not this. It needs a
-- storage bucket, a canvas, and a mobile touch surface, and it proves no more
-- than a typed name does — `signature_image_path` stays NULL and available for
-- the day somebody genuinely needs ink.
--
-- ── ON THE GATES, HONESTLY ──────────────────────────────────────────────────
--
-- Scroll depth and dwell time are reported BY the reader. A determined person can
-- send 100 and 999. They are not a security control and this migration does not
-- pretend otherwise; they exist so that acknowledging is a deliberate act rather
-- than a reflex, and the trigger keeps the floor so no screen can lower it.
-- What IS evidential is the rest: who, when, from which assignment, with what
-- text, hashed.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042800: publish a policy to an audience, let an employee read the document they were assigned, and record an acknowledgement or a typed signature', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 0. "Sign this one" has to be a property of the DOCUMENT
-- -----------------------------------------------------------------------------
--
-- `requires_esign` exists on `document_types` and not on `documents`, so the
-- choice was per TYPE: every policy signed, or none. The ask is per document —
-- the code of conduct is signed, the canteen timings are read — and two document
-- types called POLICY and POLICY_SIGNED would encode a workflow question as a
-- taxonomy, then need a third the first time an SOP needs signing.
--
-- Found by a probe that published a policy, not by the migration: a column that
-- does not exist inside a plpgsql body is only discovered when the body runs, and
-- `db:validate` reported this file as fine with the reference already in it.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS requires_esign boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.documents.requires_esign IS
  'True when acknowledging this document requires the employee to type their own name as a signature. Per document, because the same policy TYPE covers both what must be signed and what must only be read.';

-- -----------------------------------------------------------------------------
-- 1. An employee may read a policy they have been given
-- -----------------------------------------------------------------------------
--
-- Scoped to the ASSIGNMENT rather than to `subject_kind = 'policy'` at large. The
-- broader rule reads well until the first policy that goes to one department:
-- everybody else would be able to open it, and "assigned to you" would stop
-- meaning anything.
--
-- No `visible_to_employee` test on the type, unlike the self policy. A policy is
-- circulated TO employees by definition, and POLICY/SOP would have to be flagged
-- visible for a reason that has nothing to do with the employee's own file.

DROP POLICY IF EXISTS documents__policy__select ON public.documents;
CREATE POLICY documents__policy__select ON public.documents
  FOR SELECT TO authenticated
  USING (
    subject_kind = 'policy'
    AND deleted_at IS NULL
    AND virus_scan_status <> 'infected'
    AND EXISTS (
      SELECT 1
        FROM public.document_acknowledgements a
       WHERE a.document_id = documents.id
         AND a.employee_id = app.current_employee_id()));

COMMENT ON POLICY documents__policy__select ON public.documents IS
  'An employee may read a policy document they have been assigned. Without this the assignment row was readable and the document it points at was not, so /me/policies was empty even after publication.';

-- -----------------------------------------------------------------------------
-- 2. Publishing: one document, one audience, one statement
-- -----------------------------------------------------------------------------
--
-- The `documents` row is inserted by the console under `documents__admin__all`,
-- because the bytes have to reach Storage first and only the browser holds them.
-- ASSIGNING is server-side: it is a fan-out across employees, it must not be able
-- to half-happen, and the audience is a question the database can answer better
-- than a client that would have to page through the directory to ask it.

CREATE OR REPLACE FUNCTION public.publish_policy(
  p_document_id   uuid,
  p_audience      text    DEFAULT 'everyone',
  p_department_id uuid    DEFAULT NULL,
  p_due_on        date    DEFAULT NULL,
  p_require_sign  boolean DEFAULT false
)
RETURNS TABLE (assigned integer, already integer, due_on date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_doc      public.documents%ROWTYPE;
  v_due      date;
  v_days     integer;
  v_assigned integer := 0;
  v_already  integer := 0;
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only HR can publish a policy.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_doc FROM public.documents
   WHERE id = p_document_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such document.' USING errcode = 'P0002';
  END IF;
  IF v_doc.subject_kind <> 'policy' THEN
    RAISE EXCEPTION
      'That document is filed as %, not as a policy, so it cannot be circulated for acknowledgement.',
      v_doc.subject_kind USING errcode = '23514';
  END IF;
  IF p_audience NOT IN ('everyone', 'department') THEN
    RAISE EXCEPTION 'Audience must be everyone or department.' USING errcode = '22023';
  END IF;
  IF p_audience = 'department' AND p_department_id IS NULL THEN
    RAISE EXCEPTION 'Choose which department this policy is for.' USING errcode = '22023';
  END IF;

  /*
    The deadline: the caller's date, else the document type's own
    `acknowledgement_deadline_days` from today. Both POLICY and SOP are seeded
    with 7. Falling back to the type rather than to a constant keeps the number
    in the one place HR can change it.
  */
  SELECT dt.acknowledgement_deadline_days INTO v_days
    FROM public.document_types dt WHERE dt.id = v_doc.document_type_id;
  v_due := COALESCE(p_due_on, util.ist_today() + COALESCE(v_days, 7));

  UPDATE public.documents
     SET requires_acknowledgement = true,
         acknowledgement_due_on   = v_due,
         requires_esign           = p_require_sign,
         status                   = 'approved'
   WHERE id = p_document_id;

  /*
    The audience, resolved here.

    `app.admin_scope_covers` is applied per employee so an administrator limited
    to one company or location cannot circulate a policy outside it — the same
    boundary every other admin write in this schema respects.
  */
  WITH audience AS (
    SELECT e.id
      FROM public.employees e
     WHERE e.deleted_at IS NULL
       AND e.employment_status = 'active'
       AND (p_audience = 'everyone' OR e.department_id = p_department_id)
       AND app.admin_scope_covers(e.id)
  ), fresh AS (
    INSERT INTO public.document_acknowledgements (document_id, employee_id, due_on, status)
    SELECT p_document_id, a.id, v_due, 'assigned'
      FROM audience a
     WHERE NOT EXISTS (
       SELECT 1 FROM public.document_acknowledgements x
        WHERE x.document_id = p_document_id AND x.employee_id = a.id)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM fresh),
         (SELECT count(*) FROM audience) - (SELECT count(*) FROM fresh)
    INTO v_assigned, v_already;

  IF v_assigned = 0 AND v_already = 0 THEN
    RAISE EXCEPTION
      'Nobody is in that audience, so the policy was not circulated. Check the department, and that its employees are active.'
      USING errcode = 'P0002';
  END IF;

  RETURN QUERY SELECT v_assigned, v_already, v_due;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.publish_policy(uuid, text, uuid, date, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.publish_policy(uuid, text, uuid, date, boolean) TO authenticated;

COMMENT ON FUNCTION public.publish_policy(uuid, text, uuid, date, boolean) IS
  'Circulate a policy document: sets the acknowledgement deadline and whether a signature is required, then assigns it to every active employee in the audience within the caller''s admin scope. Re-running it picks up joiners without disturbing anybody who has already acknowledged.';

-- -----------------------------------------------------------------------------
-- 3. Acknowledging — the RPC 025 promised and never wrote
-- -----------------------------------------------------------------------------

--
-- TWO TEXTS, NOT ONE, and the constraint is what makes the distinction:
--
--   `ck_da__acknowledged_fields` requires `acknowledgement_text` on every
--   acknowledged row, and its column comment calls it "the exact sentence agreed
--   to". That is the STATEMENT — "I have read and understood…" — which the reader
--   already displays beside the checkbox and sends.
--
-- A signature is a different fact: the employee's own name, typed. The first
-- draft of this function put the name in that column and a read-only policy then
-- had nothing to write there, so acknowledging one raised 23514. Found by the
-- probe, not by the migration.
--
-- So the statement is always recorded and the signature is appended to it when
-- the document demands one — one hashed text containing exactly what was agreed
-- and who signed it.

CREATE OR REPLACE FUNCTION public.acknowledge_document(
  p_ack_id         uuid,
  p_statement      text,
  p_signature_name text    DEFAULT NULL,
  p_scroll_pct     numeric DEFAULT 0,
  p_read_seconds   integer DEFAULT 0
)
RETURNS public.document_acknowledgements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_me    uuid := app.current_employee_id();
  v_ack   public.document_acknowledgements%ROWTYPE;
  v_doc   public.documents%ROWTYPE;
  v_name  text;
  v_signed text := btrim(COALESCE(p_signature_name, ''));
  /* Never empty: the constraint refuses an acknowledged row without it, and a
     screen that forgot to send the sentence must not be able to cause that. */
  v_said  text := NULLIF(btrim(COALESCE(p_statement, '')), '');
BEGIN
  v_said := COALESCE(v_said, 'I have read and understood this document.');
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Only an employee can acknowledge a policy.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_ack FROM public.document_acknowledgements
   WHERE id = p_ack_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such assignment.' USING errcode = 'P0002';
  END IF;
  IF v_ack.employee_id <> v_me THEN
    RAISE EXCEPTION 'That policy was assigned to somebody else.' USING errcode = '42501';
  END IF;
  IF v_ack.acknowledged_at IS NOT NULL THEN
    RETURN v_ack;  -- already done; a second press is not an error
  END IF;

  SELECT * INTO v_doc FROM public.documents WHERE id = v_ack.document_id;

  /*
    A SIGNATURE, WHERE THE DOCUMENT ASKS FOR ONE.

    The typed name must match the employee's own, compared with case and internal
    spacing folded away — somebody signing "  vinod   maurya " has signed. It is
    checked here rather than in the browser because a signature checked only by
    the screen that collects it is not a signature.
  */
  IF v_doc.requires_esign THEN
    SELECT e.display_name INTO v_name FROM public.employees e WHERE e.id = v_me;
    IF v_signed = '' THEN
      RAISE EXCEPTION 'This policy has to be signed. Type your full name to sign it.'
        USING errcode = '23514';
    END IF;
    IF lower(regexp_replace(v_signed, '\s+', ' ', 'g'))
       IS DISTINCT FROM lower(regexp_replace(COALESCE(v_name, ''), '\s+', ' ', 'g')) THEN
      RAISE EXCEPTION
        'The signature has to be your own name as it appears on your record: %.', v_name
        USING errcode = '23514';
    END IF;
    -- The signature becomes part of the agreed text, so one hash covers both.
    v_said := v_said || E'\n\nSigned: ' || v_signed;
  END IF;

  /*
    The gates are NOT re-checked here — `trg_document_acknowledgements__ack_guard`
    fires on this UPDATE and raises if 90% scroll or the per-page dwell has not
    been reported. One enforcer, and it is the one that has been there since 025.
  */
  UPDATE public.document_acknowledgements
     SET status                    = 'acknowledged',
         acknowledged_at           = now(),
         acknowledgement_text      = v_said,
         -- Tamper evidence for the words that were agreed to. sha256() is built
         -- in; no pgcrypto dependency.
         acknowledgement_text_hash = encode(sha256(convert_to(v_said, 'UTF8')), 'hex'),
         scroll_completion_pct     = GREATEST(scroll_completion_pct, COALESCE(p_scroll_pct, 0)),
         total_read_seconds        = GREATEST(total_read_seconds, COALESCE(p_read_seconds, 0)),
         first_opened_at           = COALESCE(first_opened_at, now())
   WHERE id = p_ack_id
  RETURNING * INTO v_ack;

  RETURN v_ack;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.acknowledge_document(uuid, text, text, numeric, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.acknowledge_document(uuid, text, text, numeric, integer) TO authenticated;

COMMENT ON FUNCTION public.acknowledge_document(uuid, text, text, numeric, integer) IS
  'Record that an employee has read — and where the document requires it, signed — a policy assigned to them. Refuses somebody else''s assignment and a signature that is not their own name; the scroll and dwell floors stay with the 025 trigger.';

-- -----------------------------------------------------------------------------
-- 4. Opening it, so the compliance screen can tell reading from ignoring
-- -----------------------------------------------------------------------------
--
-- `open_count`, `first_opened_at` and the running scroll high-water mark have
-- been columns since 025 with nothing able to write them, so "assigned, never
-- opened" and "read it three times and has not signed" looked identical to HR.

CREATE OR REPLACE FUNCTION public.record_document_progress(
  p_ack_id       uuid,
  p_scroll_pct   numeric DEFAULT 0,
  p_read_seconds integer DEFAULT 0,
  p_opened       boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_me uuid := app.current_employee_id();
BEGIN
  IF v_me IS NULL THEN
    RETURN;  -- nothing to record against; not worth an error on a progress ping
  END IF;

  UPDATE public.document_acknowledgements
     SET open_count            = open_count + CASE WHEN p_opened THEN 1 ELSE 0 END,
         first_opened_at       = COALESCE(first_opened_at, now()),
         /* High-water marks: closing the tab and coming back must not lose what
            was already read, which is the same rule the reader applies on screen. */
         scroll_completion_pct = GREATEST(scroll_completion_pct, COALESCE(p_scroll_pct, 0)),
         total_read_seconds    = GREATEST(total_read_seconds, COALESCE(p_read_seconds, 0))
   WHERE id = p_ack_id
     AND employee_id = v_me
     AND acknowledged_at IS NULL;   -- a settled acknowledgement is not re-opened
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_document_progress(uuid, numeric, integer, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_document_progress(uuid, numeric, integer, boolean) TO authenticated;

COMMENT ON FUNCTION public.record_document_progress(uuid, numeric, integer, boolean) IS
  'Records that an assigned policy was opened and how far it has been read. Silent no-op for somebody else''s row or one already acknowledged.';

COMMIT;
