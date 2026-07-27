-- ============================================================================
-- Migration 024: reimbursement claims & bonus/incentives
--   reimbursement_claims, claim_lines, bonus_incentives; RLS.
-- Source: docs/plan/04-data-model.md §3.8 (lines 2194–2207), §4.3/§4.4.
-- Money convention: integer paise columns suffixed _paise (matches 020–023).
-- Forward FKs (added by 20260801004900_deferred_fks.sql):
--   reimbursement_claims.approval_request_id -> approval_requests (029)
--   claim_lines.receipt_document_id          -> documents (025)
--   bonus_incentives.approval_request_id     -> approval_requests (029)
-- No FK on reimbursement_claims.travel_requisition_id: no travel_requisitions
-- table exists anywhere in the §13 plan (settlements link by id only).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. reimbursement_claims
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reimbursement_claims (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  claim_number             text        NOT NULL,   -- CLM-2026-000045
  employee_id              uuid        NOT NULL,
  claim_type               text        NOT NULL,
  claim_kind               text        NOT NULL DEFAULT 'local_claim',
  travel_requisition_id    uuid        NULL,       -- no FK: see header note
  period_from              date        NULL,
  period_to                date        NULL,
  total_claimed_paise      bigint      NOT NULL DEFAULT 0,
  total_approved_paise     bigint      NULL,
  currency                 text        NOT NULL DEFAULT 'INR',
  status                   public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id      uuid        NULL,       -- FK via deferred sweep (029)
  decided_by               uuid        NULL,
  decided_at               timestamptz NULL,
  decided_comment          text        NULL,
  payment_mode             public.payment_mode NULL,
  paid_via_payroll_run_id  uuid        NULL,
  paid_via_payslip_id      uuid        NULL,
  paid_on                  date        NULL,
  payment_reference        text        NULL,
  advance_adjusted_paise   bigint      NOT NULL DEFAULT 0,
  cost_centre_id           uuid        NULL,
  event_reference          text        NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NULL,
  CONSTRAINT pk_reimbursement_claims PRIMARY KEY (id),
  CONSTRAINT fk_rc__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rc__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_rc__paid_via_payroll_run_id
    FOREIGN KEY (paid_via_payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  CONSTRAINT fk_rc__paid_via_payslip_id
    FOREIGN KEY (paid_via_payslip_id) REFERENCES public.payslips(id) ON DELETE SET NULL,
  CONSTRAINT fk_rc__cost_centre_id
    FOREIGN KEY (cost_centre_id) REFERENCES public.cost_centres(id) ON DELETE SET NULL,
  CONSTRAINT fk_rc__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_rc__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT uq_rc__claim_number UNIQUE (claim_number),
  CONSTRAINT ck_rc__claim_type CHECK (claim_type IN
    ('local_conveyance','travel','food','medical','telephone','uniform','fuel',
     'guest_hospitality','misc')),
  CONSTRAINT ck_rc__claim_kind CHECK (claim_kind IN
    ('local_claim','travel_requisition_settlement')),
  CONSTRAINT ck_rc__settlement_link CHECK
    (claim_kind <> 'travel_requisition_settlement' OR travel_requisition_id IS NOT NULL),
  CONSTRAINT ck_rc__currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_rc__period CHECK
    (period_from IS NULL OR period_to IS NULL OR period_to >= period_from),
  CONSTRAINT ck_rc__no_sentinel_dates CHECK (
    (period_from IS NULL OR period_from <= DATE '2100-01-01')
    AND (period_to IS NULL OR period_to <= DATE '2100-01-01')
    AND (paid_on IS NULL OR paid_on <= DATE '2100-01-01')),
  CONSTRAINT ck_rc__amounts CHECK (
    total_claimed_paise >= 0 AND advance_adjusted_paise >= 0
    AND (total_approved_paise IS NULL OR total_approved_paise >= 0)),
  CONSTRAINT ck_rc__approved_le_claimed CHECK
    (total_approved_paise IS NULL OR total_approved_paise <= total_claimed_paise)
);

COMMENT ON TABLE public.reimbursement_claims IS 'Employee expense claims (local claims and travel-requisition settlements). Paid out through payroll (paid_via_payroll_run_id/paid_via_payslip_id) or directly.';

CREATE INDEX IF NOT EXISTS idx_rc__employee       ON public.reimbursement_claims (employee_id);
CREATE INDEX IF NOT EXISTS idx_rc__status         ON public.reimbursement_claims (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_rc__payroll_run    ON public.reimbursement_claims (paid_via_payroll_run_id)
  WHERE paid_via_payroll_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rc__payslip        ON public.reimbursement_claims (paid_via_payslip_id)
  WHERE paid_via_payslip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rc__cost_centre    ON public.reimbursement_claims (cost_centre_id)
  WHERE cost_centre_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rc__approval       ON public.reimbursement_claims (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- Claim-number generator: CLM-<IST year>-<zero-padded 6-digit sequence>.
CREATE OR REPLACE FUNCTION public.generate_claim_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_year text := to_char(util.ist_date(now()), 'YYYY');
  v_next integer;
BEGIN
  IF NEW.claim_number IS NULL OR btrim(NEW.claim_number) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('reimbursement_claims.claim_number'));
    SELECT COALESCE(MAX(substring(rc.claim_number FROM '[0-9]+$')::integer), 0) + 1
      INTO v_next
      FROM public.reimbursement_claims rc
     WHERE rc.claim_number LIKE 'CLM-' || v_year || '-%';
    NEW.claim_number := 'CLM-' || v_year || '-' || lpad(v_next::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rc__claim_number ON public.reimbursement_claims;
CREATE TRIGGER trg_rc__claim_number
  BEFORE INSERT ON public.reimbursement_claims
  FOR EACH ROW EXECUTE FUNCTION public.generate_claim_number();

DROP TRIGGER IF EXISTS trg_rc__stamp ON public.reimbursement_claims;
CREATE TRIGGER trg_rc__stamp
  BEFORE INSERT ON public.reimbursement_claims
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_rc__touch ON public.reimbursement_claims;
CREATE TRIGGER trg_rc__touch
  BEFORE UPDATE ON public.reimbursement_claims
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.reimbursement_claims ENABLE ROW LEVEL SECURITY;

-- P1 self: read own; raise own; edit while draft/pending.
DROP POLICY IF EXISTS rc__self__select ON public.reimbursement_claims;
CREATE POLICY rc__self__select ON public.reimbursement_claims
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS rc__self__insert ON public.reimbursement_claims;
CREATE POLICY rc__self__insert ON public.reimbursement_claims
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending'));

DROP POLICY IF EXISTS rc__self__update ON public.reimbursement_claims;
CREATE POLICY rc__self__update ON public.reimbursement_claims
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('draft','pending'))
  WITH CHECK (employee_id = app.current_employee_id()
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- P5 manager: team read; decisions go through the approval RPC (029).
DROP POLICY IF EXISTS rc__manager__select ON public.reimbursement_claims;
CREATE POLICY rc__manager__select ON public.reimbursement_claims
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- P8 admin.
DROP POLICY IF EXISTS rc__admin__select ON public.reimbursement_claims;
CREATE POLICY rc__admin__select ON public.reimbursement_claims
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS rc__admin__insert ON public.reimbursement_claims;
CREATE POLICY rc__admin__insert ON public.reimbursement_claims
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS rc__admin__update ON public.reimbursement_claims;
CREATE POLICY rc__admin__update ON public.reimbursement_claims
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

GRANT SELECT, INSERT, UPDATE ON public.reimbursement_claims TO authenticated;
REVOKE DELETE ON public.reimbursement_claims FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.reimbursement_claims TO service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. claim_lines
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_lines (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  claim_id              uuid        NOT NULL,
  line_date             date        NULL,
  expense_head          text        NULL,
  description           text        NULL,
  from_location         text        NULL,
  to_location           text        NULL,
  distance_km           numeric(8,2) NULL,
  rate_per_km_paise     bigint      NULL,
  amount_claimed_paise  bigint      NOT NULL DEFAULT 0,
  amount_approved_paise bigint      NULL,
  receipt_document_id   uuid        NULL,   -- FK via deferred sweep (025)
  is_receipt_required   boolean     NOT NULL DEFAULT false,
  rejection_reason      text        NULL,
  tax_amount_paise      bigint      NULL,
  gst_number            text        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NULL,
  CONSTRAINT pk_claim_lines PRIMARY KEY (id),
  CONSTRAINT fk_claim_lines__claim_id
    FOREIGN KEY (claim_id) REFERENCES public.reimbursement_claims(id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_lines__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_claim_lines__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_claim_lines__approved_le_claimed
    CHECK (amount_approved_paise IS NULL OR amount_approved_paise <= amount_claimed_paise),
  CONSTRAINT ck_claim_lines__amounts CHECK (
    amount_claimed_paise >= 0
    AND (amount_approved_paise IS NULL OR amount_approved_paise >= 0)
    AND (tax_amount_paise IS NULL OR tax_amount_paise >= 0)
    AND (rate_per_km_paise IS NULL OR rate_per_km_paise >= 0)
    AND (distance_km IS NULL OR distance_km >= 0)),
  CONSTRAINT ck_claim_lines__gst CHECK (gst_number IS NULL OR
    gst_number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  CONSTRAINT ck_claim_lines__no_sentinel_dates
    CHECK (line_date IS NULL OR line_date <= DATE '2100-01-01')
);

CREATE INDEX IF NOT EXISTS idx_claim_lines__claim ON public.claim_lines (claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_lines__receipt ON public.claim_lines (receipt_document_id)
  WHERE receipt_document_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_claim_lines__stamp ON public.claim_lines;
CREATE TRIGGER trg_claim_lines__stamp
  BEFORE INSERT ON public.claim_lines
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_claim_lines__touch ON public.claim_lines;
CREATE TRIGGER trg_claim_lines__touch
  BEFORE UPDATE ON public.claim_lines
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.claim_lines ENABLE ROW LEVEL SECURITY;

-- Visibility/write follows the parent claim: the EXISTS runs under the
-- caller's own RLS on reimbursement_claims (self / manager / scoped admin).
DROP POLICY IF EXISTS claim_lines__via_parent__select ON public.claim_lines;
CREATE POLICY claim_lines__via_parent__select ON public.claim_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.reimbursement_claims rc WHERE rc.id = claim_id));

DROP POLICY IF EXISTS claim_lines__self__insert ON public.claim_lines;
CREATE POLICY claim_lines__self__insert ON public.claim_lines
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.reimbursement_claims rc
    WHERE rc.id = claim_id
      AND ((rc.employee_id = app.current_employee_id() AND rc.status IN ('draft','pending'))
           OR (app.is_admin() AND app.admin_scope_covers(rc.employee_id)))));

DROP POLICY IF EXISTS claim_lines__self__update ON public.claim_lines;
CREATE POLICY claim_lines__self__update ON public.claim_lines
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.reimbursement_claims rc
    WHERE rc.id = claim_id
      AND ((rc.employee_id = app.current_employee_id() AND rc.status IN ('draft','pending'))
           OR (app.is_admin() AND app.admin_scope_covers(rc.employee_id)))))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.reimbursement_claims rc
    WHERE rc.id = claim_id
      AND ((rc.employee_id = app.current_employee_id() AND rc.status IN ('draft','pending'))
           OR (app.is_admin() AND app.admin_scope_covers(rc.employee_id)))));

GRANT SELECT, INSERT, UPDATE ON public.claim_lines TO authenticated;
REVOKE DELETE ON public.claim_lines FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_lines TO service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. bonus_incentives
--    service_charge_share matters for a venue: the basis jsonb records the
--    pool, the points and the divisor so any staff member can be shown the
--    arithmetic.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bonus_incentives (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id             uuid        NOT NULL,
  bonus_kind              text        NOT NULL,
  financial_year          text        NULL,   -- '2026-27'
  period_from             date        NULL,
  period_to               date        NULL,
  basis                   jsonb       NULL,   -- {"events_served":12,"guest_score_avg":4.6}
  amount_paise            bigint      NOT NULL,
  is_taxable              boolean     NOT NULL DEFAULT true,
  status                  public.approval_status NOT NULL DEFAULT 'pending',
  approval_request_id     uuid        NULL,   -- FK via deferred sweep (029)
  approved_by             uuid        NULL,
  approved_at             timestamptz NULL,
  paid_via_payroll_run_id uuid        NULL,
  paid_via_payslip_id     uuid        NULL,
  salary_component_id     uuid        NULL,
  reason                  text        NULL,
  recommended_by          uuid        NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        NULL,
  CONSTRAINT pk_bonus_incentives PRIMARY KEY (id),
  CONSTRAINT fk_bi__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bi__approved_by
    FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_bi__paid_via_payroll_run_id
    FOREIGN KEY (paid_via_payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  CONSTRAINT fk_bi__paid_via_payslip_id
    FOREIGN KEY (paid_via_payslip_id) REFERENCES public.payslips(id) ON DELETE SET NULL,
  CONSTRAINT fk_bi__salary_component_id
    FOREIGN KEY (salary_component_id) REFERENCES public.salary_components(id) ON DELETE SET NULL,
  CONSTRAINT fk_bi__recommended_by
    FOREIGN KEY (recommended_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_bi__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_bi__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_bi__kind CHECK (bonus_kind IN
    ('statutory_bonus','diwali_bonus','performance','retention','referral',
     'event_incentive','service_charge_share','spot_award')),
  CONSTRAINT ck_bi__fy CHECK (financial_year IS NULL OR financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT ck_bi__period CHECK
    (period_from IS NULL OR period_to IS NULL OR period_to >= period_from),
  CONSTRAINT ck_bi__no_sentinel_dates CHECK (
    (period_from IS NULL OR period_from <= DATE '2100-01-01')
    AND (period_to IS NULL OR period_to <= DATE '2100-01-01')),
  CONSTRAINT ck_bi__amount_nonneg CHECK (amount_paise >= 0),
  CONSTRAINT ck_bi__approved_fields
    CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_bi__employee    ON public.bonus_incentives (employee_id);
CREATE INDEX IF NOT EXISTS idx_bi__status      ON public.bonus_incentives (status)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_bi__payroll_run ON public.bonus_incentives (paid_via_payroll_run_id)
  WHERE paid_via_payroll_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bi__payslip     ON public.bonus_incentives (paid_via_payslip_id)
  WHERE paid_via_payslip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bi__component   ON public.bonus_incentives (salary_component_id)
  WHERE salary_component_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bi__approval    ON public.bonus_incentives (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bi__stamp ON public.bonus_incentives;
CREATE TRIGGER trg_bi__stamp
  BEFORE INSERT ON public.bonus_incentives
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_bi__touch ON public.bonus_incentives;
CREATE TRIGGER trg_bi__touch
  BEFORE UPDATE ON public.bonus_incentives
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.bonus_incentives ENABLE ROW LEVEL SECURITY;

-- P6: self read own, once approved (or paid); draft/pending proposals about
-- an employee are not visible to that employee.
DROP POLICY IF EXISTS bi__self__select ON public.bonus_incentives;
CREATE POLICY bi__self__select ON public.bonus_incentives
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id() AND status IN ('approved','applied'));

-- Manager: team read (recommendations flow through the approval RPC).
DROP POLICY IF EXISTS bi__manager__select ON public.bonus_incentives;
CREATE POLICY bi__manager__select ON public.bonus_incentives
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

-- P8 admin.
DROP POLICY IF EXISTS bi__admin__select ON public.bonus_incentives;
CREATE POLICY bi__admin__select ON public.bonus_incentives
  FOR SELECT TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS bi__admin__insert ON public.bonus_incentives;
CREATE POLICY bi__admin__insert ON public.bonus_incentives
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS bi__admin__update ON public.bonus_incentives;
CREATE POLICY bi__admin__update ON public.bonus_incentives
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

GRANT SELECT, INSERT, UPDATE ON public.bonus_incentives TO authenticated;
REVOKE DELETE ON public.bonus_incentives FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.bonus_incentives TO service_role;
  END IF;
END $$;

COMMIT;
