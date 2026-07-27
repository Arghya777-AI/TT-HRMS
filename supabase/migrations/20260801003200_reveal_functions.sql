-- =============================================================================
-- Migration 032 — reveal functions (§4.7)
-- Source: docs/plan/04-data-model.md §4.7 (masked by default, revealed with a
--         reason), §4.4 (table × role matrix), §9 catalogue.
--
-- Sensitive identifiers (PAN / Aadhaar / UAN / bank account / salary / face
-- match candidate scores) are NEVER selectable by any client role: the base
-- tables carry column-scoped grants (009/021) or zero grants (secure.*, 012).
-- The ONLY unmasked read path is these SECURITY DEFINER functions, each of
-- which (a) verifies the caller's role and scope, (b) demands a written
-- reason of >= 10 characters, and (c) writes public.data_access_log BEFORE
-- returning a single value. The admin UI's "Reveal" affordance calls these.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Shared guard: admin + scope + reason, then the data_access_log entry.
--    Factored so all five reveals log identically (§4.7).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.assert_reveal_allowed(
  p_employee_id     uuid,
  p_reason          text,
  p_require_super   boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_require_super THEN
    IF NOT app.is_super_admin() THEN
      RAISE EXCEPTION 'insufficient_privilege' USING errcode = '42501';
    END IF;
  ELSE
    IF NOT (app.is_admin() OR app.is_super_admin()) THEN
      RAISE EXCEPTION 'insufficient_privilege' USING errcode = '42501';
    END IF;
  END IF;

  IF p_employee_id IS NOT NULL AND NOT app.admin_scope_covers(p_employee_id) THEN
    RAISE EXCEPTION 'out_of_scope' USING errcode = '42501';
  END IF;

  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'reason_required: provide at least 10 characters explaining why'
      USING errcode = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.assert_reveal_allowed(uuid, text, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.log_reveal(
  p_entity_table        text,
  p_entity_id           uuid,
  p_subject_employee_id uuid,
  p_fields              text[],
  p_reason              text,
  p_record_count        integer DEFAULT 1)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.data_access_log (
    actor_id, actor_role, actor_source, entity_table, entity_id, subject_employee_id,
    fields, access_kind, purpose, record_count, ip, user_agent, device_id, request_id)
  VALUES (
    app.ctx_actor_id(),
    CASE WHEN app.is_super_admin() THEN 'super_admin'::public.app_role ELSE 'admin'::public.app_role END,
    COALESCE(app.ctx('source'), 'web_admin')::public.actor_source,
    p_entity_table, p_entity_id, p_subject_employee_id,
    p_fields, 'reveal', btrim(p_reason), p_record_count,
    nullif(app.ctx('ip'), '')::inet, app.ctx('user_agent'), app.ctx('device_id'),
    nullif(app.ctx('request_id'), '')::uuid);
END;
$$;

REVOKE ALL ON FUNCTION app.log_reveal(text, uuid, uuid, text[], text, integer) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 1. reveal_employee_statutory — §4.7 verbatim
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reveal_employee_statutory(p_employee_id uuid, p_reason text)
RETURNS TABLE (pan text, aadhaar_number text, uan text, pf_number text, esi_number text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_admin() AND NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'insufficient_privilege' USING errcode = '42501';
  END IF;
  IF NOT app.admin_scope_covers(p_employee_id) THEN
    RAISE EXCEPTION 'out_of_scope' USING errcode = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'reason_required: provide at least 10 characters explaining why'
      USING errcode = '22023';
  END IF;

  INSERT INTO public.data_access_log (
    actor_id, actor_role, actor_source, entity_table, entity_id, subject_employee_id,
    fields, access_kind, purpose, record_count, ip, user_agent, device_id, request_id)
  VALUES (
    app.ctx_actor_id(),
    CASE WHEN app.is_super_admin() THEN 'super_admin'::public.app_role ELSE 'admin'::public.app_role END,
    COALESCE(app.ctx('source'), 'web_admin')::public.actor_source,
    'public.employee_statutory', p_employee_id, p_employee_id,
    ARRAY['pan','aadhaar_number','uan','pf_number','esi_number'],
    'reveal', btrim(p_reason), 1,
    nullif(app.ctx('ip'),'')::inet, app.ctx('user_agent'), app.ctx('device_id'),
    nullif(app.ctx('request_id'),'')::uuid);

  RETURN QUERY
  SELECT es.pan, es.aadhaar_number, es.uan, es.pf_number, es.esi_number
  FROM public.employee_statutory es
  WHERE es.employee_id = p_employee_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. reveal_employee_bank_account — full account number + IFSC, logged
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reveal_employee_bank_account(p_employee_id uuid, p_reason text)
RETURNS TABLE (
  id uuid, beneficiary_name text, bank_name text, branch text, ifsc text,
  account_number text, account_type text, upi_id text,
  is_verified boolean, is_active boolean, effective_from date, effective_to date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_reveal_allowed(p_employee_id, p_reason);
  PERFORM app.log_reveal(
    'public.employee_bank_accounts', NULL, p_employee_id,
    ARRAY['account_number','ifsc','upi_id','beneficiary_name'], p_reason,
    (SELECT count(*)::integer FROM public.employee_bank_accounts b
      WHERE b.employee_id = p_employee_id));

  RETURN QUERY
  SELECT b.id, b.beneficiary_name, b.bank_name, b.branch, b.ifsc,
         b.account_number, b.account_type, b.upi_id,
         b.is_verified, b.is_active, b.effective_from, b.effective_to
  FROM public.employee_bank_accounts b
  WHERE b.employee_id = p_employee_id
  ORDER BY b.is_active DESC, b.effective_from DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. reveal_identity_document — one document row, full number, logged
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reveal_identity_document(p_identity_document_id uuid, p_reason text)
RETURNS TABLE (
  id uuid, employee_id uuid, document_kind public.id_document_kind,
  document_number text, name_on_document text, issue_date date, expiry_date date,
  issuing_country text, issuing_authority text, place_of_issue text,
  is_verified boolean, is_current boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_employee_id uuid;
BEGIN
  SELECT d.employee_id INTO v_employee_id
  FROM public.employee_identity_documents d
  WHERE d.id = p_identity_document_id;
  IF v_employee_id IS NULL THEN
    RAISE EXCEPTION 'identity document % not found', p_identity_document_id
      USING errcode = 'P0002';
  END IF;

  PERFORM app.assert_reveal_allowed(v_employee_id, p_reason);
  PERFORM app.log_reveal(
    'public.employee_identity_documents', p_identity_document_id, v_employee_id,
    ARRAY['document_number','name_on_document'], p_reason, 1);

  RETURN QUERY
  SELECT d.id, d.employee_id, d.document_kind,
         d.document_number, d.name_on_document, d.issue_date, d.expiry_date,
         d.issuing_country, d.issuing_authority, d.place_of_issue,
         d.is_verified, d.is_current
  FROM public.employee_identity_documents d
  WHERE d.id = p_identity_document_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. reveal_employee_salary — full revision history + component lines, logged
--    (§4.7: "returns the full revision lines and logs it")
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reveal_employee_salary(p_employee_id uuid, p_reason text)
RETURNS TABLE (
  revision_id uuid, revision_number integer, revision_kind text,
  effective_from date, effective_to date, status public.approval_status,
  monthly_gross_paise bigint, monthly_employer_contribution_paise bigint,
  monthly_ctc_paise bigint, annual_ctc_paise bigint,
  previous_monthly_ctc_paise bigint, increment_amount_paise bigint,
  increment_pct numeric, months_since_previous integer,
  component_code text, component_name text, line_kind public.payslip_line_kind,
  ctc_bucket text, monthly_amount_paise bigint, annual_amount_paise bigint,
  line_sequence integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_reveal_allowed(p_employee_id, p_reason);
  PERFORM app.log_reveal(
    'public.employee_salary_revisions', NULL, p_employee_id,
    ARRAY['monthly_gross_paise','monthly_employer_contribution_paise',
          'monthly_ctc_paise','annual_ctc_paise','revision_lines'], p_reason,
    (SELECT count(*)::integer FROM public.employee_salary_revisions r
      WHERE r.employee_id = p_employee_id));

  RETURN QUERY
  SELECT r.id, r.revision_number, r.revision_kind,
         r.effective_from, r.effective_to, r.status,
         r.monthly_gross_paise, r.monthly_employer_contribution_paise,
         r.monthly_ctc_paise, r.annual_ctc_paise,
         r.previous_monthly_ctc_paise, r.increment_amount_paise,
         r.increment_pct, r.months_since_previous,
         sc.code, sc.name, sc.line_kind,
         sc.ctc_bucket, l.monthly_amount_paise, l.annual_amount_paise,
         l.sequence
  FROM public.employee_salary_revisions r
  LEFT JOIN public.employee_salary_revision_lines l ON l.revision_id = r.id
  LEFT JOIN public.salary_components sc ON sc.id = l.salary_component_id
  WHERE r.employee_id = p_employee_id
  ORDER BY r.revision_number DESC, l.sequence;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. reveal_face_match_candidates — super-admin only (§4.4: secure.face_match_log
--    "S + reveal candidates"); candidate_scores are excluded from
--    v_face_match_audit (012) on purpose.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reveal_face_match_candidates(p_face_match_log_id uuid, p_reason text)
RETURNS TABLE (
  id uuid, attempted_at timestamptz, outcome text,
  matched_employee_id uuid, best_confidence numeric, margin numeric,
  candidate_scores jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_subject uuid;
BEGIN
  SELECT fml.matched_employee_id INTO v_subject
  FROM secure.face_match_log fml
  WHERE fml.id = p_face_match_log_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'face match log entry % not found', p_face_match_log_id
      USING errcode = 'P0002';
  END IF;

  -- super-admin only; scope check is global for super-admin by definition
  PERFORM app.assert_reveal_allowed(NULL, p_reason, true);
  PERFORM app.log_reveal(
    'secure.face_match_log', p_face_match_log_id, v_subject,
    ARRAY['candidate_scores'], p_reason, 1);

  RETURN QUERY
  SELECT fml.id, fml.attempted_at, fml.outcome,
         fml.matched_employee_id, fml.best_confidence, fml.margin,
         fml.candidate_scores
  FROM secure.face_match_log fml
  WHERE fml.id = p_face_match_log_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants: callable by authenticated (the functions gate internally),
--    never by anon. Helpers stay locked down.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- default EXECUTE to PUBLIC is stripped first
  REVOKE ALL ON FUNCTION public.reveal_employee_statutory(uuid, text)        FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reveal_employee_bank_account(uuid, text)     FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reveal_identity_document(uuid, text)         FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reveal_employee_salary(uuid, text)           FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reveal_face_match_candidates(uuid, text)     FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.reveal_employee_statutory(uuid, text)      FROM anon;
    REVOKE ALL ON FUNCTION public.reveal_employee_bank_account(uuid, text)   FROM anon;
    REVOKE ALL ON FUNCTION public.reveal_identity_document(uuid, text)       FROM anon;
    REVOKE ALL ON FUNCTION public.reveal_employee_salary(uuid, text)         FROM anon;
    REVOKE ALL ON FUNCTION public.reveal_face_match_candidates(uuid, text)   FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.reveal_employee_statutory(uuid, text)      TO authenticated;
    GRANT EXECUTE ON FUNCTION public.reveal_employee_bank_account(uuid, text)   TO authenticated;
    GRANT EXECUTE ON FUNCTION public.reveal_identity_document(uuid, text)       TO authenticated;
    GRANT EXECUTE ON FUNCTION public.reveal_employee_salary(uuid, text)         TO authenticated;
    GRANT EXECUTE ON FUNCTION public.reveal_face_match_candidates(uuid, text)   TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.reveal_employee_statutory(uuid, text)      TO service_role;
    GRANT EXECUTE ON FUNCTION public.reveal_employee_bank_account(uuid, text)   TO service_role;
    GRANT EXECUTE ON FUNCTION public.reveal_identity_document(uuid, text)       TO service_role;
    GRANT EXECUTE ON FUNCTION public.reveal_employee_salary(uuid, text)         TO service_role;
    GRANT EXECUTE ON FUNCTION public.reveal_face_match_candidates(uuid, text)   TO service_role;
  END IF;
END $$;

COMMIT;
