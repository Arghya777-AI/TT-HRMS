-- =============================================================================
-- 083 · First-login onboarding: the pack, the gate's record, and the two writes
--
-- WHAT THIS DOES NOT BUILD, ON PURPOSE
--
-- Almost nothing about "HR decides which fields and documents are required" is new.
-- `employee_custom_field_defs` already carries `is_required`, `is_employee_editable`,
-- `requires_approval`, `is_pii`, `field_type`, `validation_regex` and the
-- applies-to-employment-type/department scoping. `document_types` already carries
-- `is_required_for_onboarding` and its own scoping, and the seeded rows already match
-- what was asked for: AADHAAR, PAN, BANK_PROOF and PHOTO required, CANCELLED_CHEQUE
-- optional. Building a second configuration model beside those would give HR two places
-- to set one thing and guarantee they disagree.
--
-- What was missing is the RECORD the gate reads, one relation that answers "what does
-- this person still owe", and the two writes that close it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DECISIONS THIS ENCODES, AS GIVEN
--
--   * Instant access on submit, HR reviews afterwards. `submitted_at` opens the portal;
--     `reviewed_at` is separate and is not a gate.
--   * HR may WAIVE the documents for somebody who has none — a daily-wage joiner — but
--     an identity number is never waivable: Aadhaar OR PAN must be on file either way.
--     That is the one thing a waiver cannot buy.
--   * Name and phone are always required, whatever else is configured, and for a
--     delivery worker they are the ONLY requirements.
--   * Documents may be uploaded or replaced at any time, by the employee or by HR — not
--     only at first login. So the pack is a live view, never a snapshot taken at submit.
-- =============================================================================

SELECT set_config('app.reason', 'migration 083: first-login onboarding pack', true);

-- -----------------------------------------------------------------------------
-- 1. Which HR-tracked fields the new joiner is actually asked to fill
-- -----------------------------------------------------------------------------

/*
  `is_required` already means "HR must have this on the record". It does NOT mean "the new
  joiner types it" — a field HR fills from the offer letter is required and must never
  appear on the employee's form. One flag cannot carry both meanings, so onboarding gets
  its own.
*/
ALTER TABLE public.employee_custom_field_defs
  ADD COLUMN IF NOT EXISTS show_in_onboarding boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.employee_custom_field_defs.show_in_onboarding IS
  'Ask the employee for this on their first-login form. Separate from is_required, which means HR must hold the value however it arrives. A field is only ever shown when it is ALSO is_employee_editable.';

-- -----------------------------------------------------------------------------
-- 2. The gate's record
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_onboarding (
  employee_id   uuid PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  started_at    timestamptz,
  /* The ONLY thing the gate reads. Set by submit_onboarding or waive_onboarding. */
  submitted_at  timestamptz,
  /* HR's look afterwards. Deliberately NOT a gate — access is already granted. */
  reviewed_at   timestamptz,
  reviewed_by   uuid REFERENCES auth.users(id),
  review_note   text,
  waived_at     timestamptz,
  waived_by     uuid REFERENCES auth.users(id),
  waived_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  /* A waiver must say why; an un-waived row must not carry a reason. */
  CONSTRAINT ck_onboarding__waiver_reason
    CHECK ((waived_at IS NULL) = (waived_reason IS NULL)),
  CONSTRAINT ck_onboarding__waiver_len
    CHECK (waived_reason IS NULL OR length(btrim(waived_reason)) >= 10)
);

COMMENT ON TABLE public.employee_onboarding IS
  'First-login onboarding state, one row per employee. submitted_at is what FirstRunGate reads; reviewed_at is HR looking afterwards and never blocks access.';

ALTER TABLE public.employee_onboarding ENABLE ROW LEVEL SECURITY;

CREATE POLICY onboarding__self_read ON public.employee_onboarding
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id()
         OR app.is_manager_of(employee_id)
         OR (app.is_admin() AND app.admin_scope_covers(employee_id)));

/* No INSERT/UPDATE policy: every write goes through the definer functions below, so the
   completeness rule cannot be bypassed by PATCHing the row. */

-- -----------------------------------------------------------------------------
-- 3. One relation that answers "what do I still owe?"
-- -----------------------------------------------------------------------------

/*
  The CLIENT MUST NOT ASSEMBLE THIS LIST. If the form decided what was required, a crafted
  request could submit without it — so the same SQL that the form renders is the SQL that
  `submit_onboarding` checks. One definition, no second opinion.

  Rows are the union of two requirement sources, each already scoped by employment type:
  custom fields the joiner is asked for, and document types required at onboarding.
*/
CREATE OR REPLACE VIEW public.v_my_onboarding_pack
WITH (security_barrier = true) AS
WITH me AS (
  SELECT e.id, e.employment_type, e.department_id
    FROM public.employees e
   WHERE e.id = app.current_employee_id()
     AND e.deleted_at IS NULL
)
-- Fields the employee is asked to fill.
SELECT
  'field'::text                        AS kind,
  d.code,
  d.label,
  d.help_text,
  d.field_type::text                   AS field_type,
  d.options,
  d.is_required,
  d.section,
  d.sort_order,
  (v.id IS NOT NULL)                   AS is_done,
  NULL::uuid                           AS document_id
FROM me
JOIN public.employee_custom_field_defs d
  ON d.is_active
 AND d.deleted_at IS NULL
 AND d.show_in_onboarding
 AND d.is_employee_editable
 AND (d.applies_to_employment_types IS NULL
      OR me.employment_type = ANY (d.applies_to_employment_types))
 AND (d.applies_to_department_ids IS NULL
      OR me.department_id = ANY (d.applies_to_department_ids))
LEFT JOIN public.employee_custom_field_values v
  ON v.employee_id = me.id AND v.field_def_id = d.id
UNION ALL
-- Documents required (or offered) at onboarding.
SELECT
  'document'::text                     AS kind,
  t.code,
  t.name                               AS label,
  t.description                        AS help_text,
  'file'::text                         AS field_type,
  NULL::jsonb                          AS options,
  t.is_required_for_onboarding         AS is_required,
  COALESCE(t.category, 'Documents')    AS section,
  t.sort_order,
  EXISTS (
    SELECT 1 FROM public.documents ed
     WHERE ed.employee_id = me.id
       AND ed.document_type_id = t.id
       AND ed.deleted_at IS NULL
  )                                    AS is_done,
  (SELECT ed.id FROM public.documents ed
    WHERE ed.employee_id = me.id AND ed.document_type_id = t.id AND ed.deleted_at IS NULL
    ORDER BY ed.created_at DESC LIMIT 1) AS document_id
FROM me
JOIN public.document_types t
  ON t.is_active
 AND t.deleted_at IS NULL
 AND t.visible_to_employee
 AND (t.is_required_for_onboarding
      OR t.code IN ('CANCELLED_CHEQUE'))   -- recommended, shown but never blocking
 AND (t.required_for_employment_types IS NULL
      OR me.employment_type = ANY (t.required_for_employment_types))
 AND (t.required_for_department_ids IS NULL
      OR me.department_id = ANY (t.required_for_department_ids));

COMMENT ON VIEW public.v_my_onboarding_pack IS
  'What the signed-in employee still owes at onboarding: HR-configured fields plus required documents, each with is_required and is_done. The same requirement set submit_onboarding enforces — the client never derives it.';

GRANT SELECT ON public.v_my_onboarding_pack TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Submit — the completeness rule lives HERE
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_onboarding()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_me      uuid := app.current_employee_id();
  v_missing text[];
  v_row     public.employees;
  v_when    timestamptz;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Your account is not linked to an employee record' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_row FROM public.employees WHERE id = v_me;

  /*
    ALWAYS REQUIRED, whatever HR has configured: a name and a reachable phone. For a
    delivery worker these are the only two, which falls out naturally — no document type
    is scoped to them, so the pack contains nothing else.
  */
  IF coalesce(btrim(v_row.display_name), '') = '' THEN
    v_missing := v_missing || 'display_name';
  END IF;
  IF coalesce(btrim(v_row.mobile), '') = '' THEN
    v_missing := v_missing || 'mobile';
  END IF;

  -- Everything the pack says is required and not yet done.
  SELECT v_missing || COALESCE(array_agg(p.code), '{}')
    INTO v_missing
    FROM public.v_my_onboarding_pack p
   WHERE p.is_required AND NOT p.is_done;

  IF array_length(v_missing, 1) > 0 THEN
    -- 22023 so PostgREST answers 400, and the codes come back so the form can point at
    -- the exact rows rather than saying "something is missing".
    RAISE EXCEPTION 'onboarding_incomplete: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.reason', 'employee completed first-login onboarding form', true);

  INSERT INTO public.employee_onboarding (employee_id, started_at, submitted_at)
  VALUES (v_me, now(), now())
  ON CONFLICT (employee_id) DO UPDATE
     SET submitted_at = COALESCE(public.employee_onboarding.submitted_at, now()),
         updated_at   = now()
  RETURNING submitted_at INTO v_when;

  RETURN v_when;
END;
$$;

COMMENT ON FUNCTION public.submit_onboarding() IS
  'Close a joiner''s onboarding. Re-checks EVERY required item server-side against v_my_onboarding_pack, plus name and mobile which are always required, and raises 22023 listing what is missing. Access is granted on submit; HR review happens afterwards.';

REVOKE ALL ON FUNCTION public.submit_onboarding() FROM public;
GRANT EXECUTE ON FUNCTION public.submit_onboarding() TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Waive — for a joiner who genuinely has no paperwork
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.waive_onboarding(
  p_employee_id uuid,
  p_reason      text
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_when timestamptz;
  v_has_id boolean;
BEGIN
  IF NOT (app.is_admin() AND app.admin_scope_covers(p_employee_id)) THEN
    RAISE EXCEPTION 'Only an admin may waive onboarding' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A waiver must say why, in at least 10 characters' USING ERRCODE = '22023';
  END IF;

  /*
    THE ONE THING A WAIVER CANNOT BUY: an identity number. A daily-wage joiner may have no
    cheque book, no education certificate and no photograph, and that is a real situation
    worth waiving. Having NO identity at all is a different thing — it makes the record
    unverifiable and the payment unattributable — so Aadhaar OR PAN must be on file either
    way, and it may be HR who put it there.
  */
  -- `aadhaar_last4` counts too: a record may hold only the last four digits by design,
  -- and that is still an identity on file.
  SELECT (coalesce(btrim(s.aadhaar_number), '') <> ''
          OR coalesce(btrim(s.aadhaar_last4), '') <> ''
          OR coalesce(btrim(s.pan), '') <> '')
    INTO v_has_id
    FROM public.employee_statutory s
   WHERE s.employee_id = p_employee_id;

  IF NOT COALESCE(v_has_id, false) THEN
    RAISE EXCEPTION 'aadhaar_or_pan_required: a waiver still needs an Aadhaar or PAN number on file'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.reason', format('onboarding waived by admin: %s', btrim(p_reason)), true);

  INSERT INTO public.employee_onboarding
    (employee_id, started_at, submitted_at, waived_at, waived_by, waived_reason)
  VALUES (p_employee_id, now(), now(), now(), auth.uid(), btrim(p_reason))
  ON CONFLICT (employee_id) DO UPDATE
     SET submitted_at  = COALESCE(public.employee_onboarding.submitted_at, now()),
         waived_at     = now(),
         waived_by     = auth.uid(),
         waived_reason = btrim(p_reason),
         updated_at    = now()
  RETURNING waived_at INTO v_when;

  RETURN v_when;
END;
$$;

COMMENT ON FUNCTION public.waive_onboarding(uuid, text) IS
  'Admin waiver for a joiner with no paperwork — a daily-wage hire. Requires a reason of 10+ characters and STILL requires an Aadhaar or PAN number on file, which is the one requirement a waiver cannot remove.';

REVOKE ALL ON FUNCTION public.waive_onboarding(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.waive_onboarding(uuid, text) TO authenticated;
