-- =============================================================================
-- Migration 028 — assets
-- Source: docs/plan/04-data-model.md §3.12 (lines 2368–2385); spec-migrations
--         §2 row 028. Tables: asset_categories, assets, asset_allocations,
--         asset_history. RLS.
--
-- Enum public.asset_allocation_status already exists (003) — not recreated.
-- Money convention: purchase_cost / recovery_amount are integer paise
-- (bigint, *_paise) per the build money rule, not the doc's numeric(14,2).
-- Forward FK deferred to 20260801004900_deferred_fks.sql:
--   asset_allocations.approval_request_id -> approval_requests (029)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. asset_categories (lookup shape)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.asset_categories (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL,
  code                      text        NOT NULL,
  name                      text        NOT NULL,
  description               text        NULL,
  sort_order                integer     NOT NULL DEFAULT 100,
  is_active                 boolean     NOT NULL DEFAULT true,
  is_consumable             boolean     NOT NULL DEFAULT false,
  default_return_required   boolean     NOT NULL DEFAULT true,
  default_useful_life_months integer    NULL,
  requires_serial           boolean     NOT NULL DEFAULT false,
  requires_acknowledgement  boolean     NOT NULL DEFAULT false,
  depreciation_pct_per_year numeric(9,4) NULL,
  parent_category_id        uuid        NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NULL,
  deleted_at                timestamptz NULL,
  deleted_by                uuid        NULL,
  deletion_reason           text        NULL,
  CONSTRAINT pk_asset_categories PRIMARY KEY (id),
  CONSTRAINT fk_asset_categories__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_categories__parent_category_id
    FOREIGN KEY (parent_category_id) REFERENCES public.asset_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_categories__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_categories__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_categories__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_asset_categories__useful_life
    CHECK (default_useful_life_months IS NULL OR default_useful_life_months > 0),
  CONSTRAINT ck_asset_categories__depreciation
    CHECK (depreciation_pct_per_year IS NULL OR depreciation_pct_per_year BETWEEN 0 AND 100),
  CONSTRAINT ck_asset_categories__not_own_parent
    CHECK (parent_category_id IS NULL OR parent_category_id <> id),
  CONSTRAINT ck_asset_categories__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE public.asset_categories IS
  'Venue seed (046): Uniforms (consumable), Chef Knives, Walkie-Talkies, Access Cards, Mobile Phones, Laptops, Tablets (kiosk devices), Keys, Tool Kits, Safety Shoes (consumable), PPE (consumable), Gardening Equipment, Serving Trolleys, Sound Equipment, Vehicle Keys. is_consumable drives the Consumable / Non-Consumable tabs.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_categories__company_code
  ON public.asset_categories (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asset_categories__company_id
  ON public.asset_categories (company_id);
CREATE INDEX IF NOT EXISTS idx_asset_categories__parent_category_id
  ON public.asset_categories (parent_category_id);

DROP TRIGGER IF EXISTS trg_asset_categories__stamp ON public.asset_categories;
CREATE TRIGGER trg_asset_categories__stamp
  BEFORE INSERT ON public.asset_categories
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_asset_categories__touch ON public.asset_categories;
CREATE TRIGGER trg_asset_categories__touch
  BEFORE UPDATE ON public.asset_categories
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.asset_categories ENABLE ROW LEVEL SECURITY;

-- P7 read / P8 write.
DROP POLICY IF EXISTS asset_categories__authenticated__select ON public.asset_categories;
CREATE POLICY asset_categories__authenticated__select ON public.asset_categories
  FOR SELECT TO authenticated
  USING (is_active AND deleted_at IS NULL);

DROP POLICY IF EXISTS asset_categories__admin__select ON public.asset_categories;
CREATE POLICY asset_categories__admin__select ON public.asset_categories
  FOR SELECT TO authenticated
  USING (app.is_admin());

DROP POLICY IF EXISTS asset_categories__admin__insert ON public.asset_categories;
CREATE POLICY asset_categories__admin__insert ON public.asset_categories
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin());

DROP POLICY IF EXISTS asset_categories__admin__update ON public.asset_categories;
CREATE POLICY asset_categories__admin__update ON public.asset_categories
  FOR UPDATE TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.asset_categories TO authenticated;
REVOKE DELETE ON public.asset_categories FROM authenticated;

-- -----------------------------------------------------------------------------
-- 2. assets
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.assets (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  asset_tag             text        NOT NULL,
  asset_category_id     uuid        NOT NULL,
  company_id            uuid        NOT NULL,
  location_id           uuid        NULL,
  name                  text        NOT NULL,
  description           text        NULL,
  make                  text        NULL,
  model                 text        NULL,
  serial_number         text        NULL,
  imei                  text        NULL,
  purchase_date         date        NULL,
  purchase_cost_paise   bigint      NULL,
  vendor                text        NULL,
  invoice_document_id   uuid        NULL,
  warranty_expiry       date        NULL,
  insurance_expiry      date        NULL,
  condition             text        NOT NULL DEFAULT 'good',
  status                text        NOT NULL DEFAULT 'in_stock',
  quantity              numeric(12,3) NOT NULL DEFAULT 1,
  unit                  text        NOT NULL DEFAULT 'each',
  reorder_level         numeric(12,3) NULL,
  custodian_employee_id uuid        NULL,
  photo_document_id     uuid        NULL,
  qr_payload            text        NULL,
  notes                 text        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NULL,
  deleted_at            timestamptz NULL,
  deleted_by            uuid        NULL,
  deletion_reason       text        NULL,
  CONSTRAINT pk_assets PRIMARY KEY (id),
  CONSTRAINT fk_assets__asset_category_id
    FOREIGN KEY (asset_category_id) REFERENCES public.asset_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assets__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assets__location_id
    FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assets__invoice_document_id
    FOREIGN KEY (invoice_document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_assets__custodian_employee_id
    FOREIGN KEY (custodian_employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assets__photo_document_id
    FOREIGN KEY (photo_document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_assets__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_assets__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_assets__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_assets__condition CHECK (condition IN
    ('new','good','fair','poor','unserviceable')),
  CONSTRAINT ck_assets__status CHECK (status IN
    ('in_stock','allocated','in_repair','lost','retired','written_off')),
  CONSTRAINT ck_assets__unit CHECK (unit IN ('each','pair','set','litre')),
  CONSTRAINT ck_assets__quantity CHECK (quantity > 0),
  CONSTRAINT ck_assets__reorder_level CHECK (reorder_level IS NULL OR reorder_level >= 0),
  CONSTRAINT ck_assets__purchase_cost CHECK (purchase_cost_paise IS NULL OR purchase_cost_paise >= 0),
  -- §1.6: sentinel dates banned; open-ended = NULL.
  CONSTRAINT ck_assets__no_sentinel_dates CHECK (
    (purchase_date    IS NULL OR purchase_date    < DATE '2100-01-01') AND
    (warranty_expiry  IS NULL OR warranty_expiry  < DATE '2100-01-01') AND
    (insurance_expiry IS NULL OR insurance_expiry < DATE '2100-01-01')),
  CONSTRAINT ck_assets__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON COLUMN public.assets.asset_tag IS 'Unique, e.g. TT-AST-00142.';
COMMENT ON COLUMN public.assets.quantity IS 'Consumables issue in quantity (numeric 12,3).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_assets__asset_tag
  ON public.assets (asset_tag) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assets__serial
  ON public.assets (serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets__category_status
  ON public.assets (asset_category_id, status);
CREATE INDEX IF NOT EXISTS idx_assets__company_id            ON public.assets (company_id);
CREATE INDEX IF NOT EXISTS idx_assets__location_id           ON public.assets (location_id);
CREATE INDEX IF NOT EXISTS idx_assets__custodian_employee_id ON public.assets (custodian_employee_id);
CREATE INDEX IF NOT EXISTS idx_assets__invoice_document_id   ON public.assets (invoice_document_id);
CREATE INDEX IF NOT EXISTS idx_assets__photo_document_id     ON public.assets (photo_document_id);

DROP TRIGGER IF EXISTS trg_assets__stamp ON public.assets;
CREATE TRIGGER trg_assets__stamp
  BEFORE INSERT ON public.assets
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_assets__touch ON public.assets;
CREATE TRIGGER trg_assets__touch
  BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

-- P5 read policies for `assets` reference asset_allocations, which is created
-- further down this file — Postgres resolves policy expressions at CREATE
-- POLICY time, so they are declared in §3b once that table exists.
DROP POLICY IF EXISTS assets__admin__all ON public.assets;
CREATE POLICY assets__admin__all ON public.assets
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.assets TO authenticated;
REVOKE DELETE ON public.assets FROM authenticated;

-- -----------------------------------------------------------------------------
-- 3. asset_allocations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.asset_allocations (
  id                              uuid        NOT NULL DEFAULT gen_random_uuid(),
  asset_id                        uuid        NOT NULL,
  employee_id                     uuid        NOT NULL,
  allocation_number               text        NOT NULL,
  quantity                        numeric(12,3) NOT NULL DEFAULT 1,
  status                          public.asset_allocation_status NOT NULL DEFAULT 'requested',
  requested_at                    timestamptz NULL,
  approved_by                     uuid        NULL,
  approved_at                     timestamptz NULL,
  allocated_by                    uuid        NULL,
  allocated_at                    timestamptz NULL,
  expected_return_date            date        NULL,
  acknowledged_at                 timestamptz NULL,
  acknowledgement_signature_path  text        NULL,
  returned_at                     timestamptz NULL,
  received_by                     uuid        NULL,
  return_condition                text        NULL,
  recall_requested_by             uuid        NULL,
  recall_requested_at             timestamptz NULL,
  recall_reason                   text        NULL,
  loss_reported_at                timestamptz NULL,
  loss_report_document_id         uuid        NULL,
  recovery_amount_paise           bigint      NULL,
  recovery_payslip_id             uuid        NULL,
  handover_notes                  text        NULL,
  approval_request_id             uuid        NULL,  -- FK deferred (approval_requests, 029)
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NULL,
  CONSTRAINT pk_asset_allocations PRIMARY KEY (id),
  CONSTRAINT fk_asset_allocations__asset_id
    FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_allocations__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_allocations__approved_by
    FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__allocated_by
    FOREIGN KEY (allocated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__received_by
    FOREIGN KEY (received_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__recall_requested_by
    FOREIGN KEY (recall_requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__loss_report_document_id
    FOREIGN KEY (loss_report_document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__recovery_payslip_id
    FOREIGN KEY (recovery_payslip_id) REFERENCES public.payslips(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_allocations__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_asset_allocations__quantity CHECK (quantity > 0),
  CONSTRAINT ck_asset_allocations__return_condition CHECK (return_condition IS NULL OR
    return_condition IN ('new','good','fair','poor','unserviceable')),
  CONSTRAINT ck_asset_allocations__recovery CHECK (
    recovery_amount_paise IS NULL OR recovery_amount_paise >= 0),
  CONSTRAINT ck_asset_allocations__no_sentinel_dates CHECK (
    expected_return_date IS NULL OR expected_return_date < DATE '2100-01-01'),
  CONSTRAINT ck_asset_allocations__recall_reason CHECK (
    recall_requested_at IS NULL OR
    (recall_requested_by IS NOT NULL AND length(btrim(recall_reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_allocations__allocation_number
  ON public.asset_allocations (allocation_number);
CREATE INDEX IF NOT EXISTS idx_aa__employee_status
  ON public.asset_allocations (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_aa__asset_open
  ON public.asset_allocations (asset_id)
  WHERE status IN ('allocated','acknowledged','return_requested');
-- One live holder at a time for single-unit assets.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa__asset_single_holder
  ON public.asset_allocations (asset_id)
  WHERE status IN ('allocated','acknowledged') AND quantity = 1;
CREATE INDEX IF NOT EXISTS idx_aa__asset_id ON public.asset_allocations (asset_id);
CREATE INDEX IF NOT EXISTS idx_aa__loss_report_document_id
  ON public.asset_allocations (loss_report_document_id);
CREATE INDEX IF NOT EXISTS idx_aa__recovery_payslip_id
  ON public.asset_allocations (recovery_payslip_id);
CREATE INDEX IF NOT EXISTS idx_aa__approval_request_id
  ON public.asset_allocations (approval_request_id);

DROP TRIGGER IF EXISTS trg_asset_allocations__stamp ON public.asset_allocations;
CREATE TRIGGER trg_asset_allocations__stamp
  BEFORE INSERT ON public.asset_allocations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_asset_allocations__touch ON public.asset_allocations;
CREATE TRIGGER trg_asset_allocations__touch
  BEFORE UPDATE ON public.asset_allocations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.asset_allocations ENABLE ROW LEVEL SECURITY;

-- P1: self read + self request (insert only in 'requested' state, for self).
DROP POLICY IF EXISTS asset_allocations__self__select ON public.asset_allocations;
CREATE POLICY asset_allocations__self__select ON public.asset_allocations
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS asset_allocations__self__insert ON public.asset_allocations;
CREATE POLICY asset_allocations__self__insert ON public.asset_allocations
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id() AND status = 'requested');

-- P5: manager reads team allocations (approve goes through the workflow RPC).
DROP POLICY IF EXISTS asset_allocations__manager__select ON public.asset_allocations;
CREATE POLICY asset_allocations__manager__select ON public.asset_allocations
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

-- P8: admin all, scoped.
DROP POLICY IF EXISTS asset_allocations__admin__all ON public.asset_allocations;
CREATE POLICY asset_allocations__admin__all ON public.asset_allocations
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

GRANT SELECT, INSERT, UPDATE ON public.asset_allocations TO authenticated;
REVOKE DELETE ON public.asset_allocations FROM authenticated;

-- -----------------------------------------------------------------------------
-- 3b. `assets` read policies that depend on asset_allocations
-- -----------------------------------------------------------------------------
-- Declared here (not in §2) because a policy expression is resolved when the
-- policy is created, and asset_allocations did not exist yet at that point.
-- asset_allocations' own policies never reference `assets`, so there is no
-- mutual recursion.

DROP POLICY IF EXISTS assets__self__select ON public.assets;
CREATE POLICY assets__self__select ON public.assets
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      custodian_employee_id = app.current_employee_id()
      OR EXISTS (
        SELECT 1 FROM public.asset_allocations aa
        WHERE aa.asset_id = assets.id
          AND aa.employee_id = app.current_employee_id()
          AND aa.status IN ('requested','approved','allocated','acknowledged','return_requested'))));

DROP POLICY IF EXISTS assets__manager__select ON public.assets;
CREATE POLICY assets__manager__select ON public.assets
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      (custodian_employee_id IS NOT NULL AND app.is_manager_of(custodian_employee_id))
      OR EXISTS (
        SELECT 1 FROM public.asset_allocations aa
        WHERE aa.asset_id = assets.id
          AND aa.status IN ('allocated','acknowledged','return_requested')
          AND app.is_manager_of(aa.employee_id))));

-- -----------------------------------------------------------------------------
-- 4. asset_history — append-only custody trail
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.asset_history (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  asset_id           uuid        NOT NULL,
  allocation_id      uuid        NULL,
  employee_id        uuid        NULL,
  event              text        NOT NULL,
  from_employee_id   uuid        NULL,
  to_employee_id     uuid        NULL,
  quantity           numeric(12,3) NULL,
  condition_before   text        NULL,
  condition_after    text        NULL,
  location_id        uuid        NULL,
  notes              text        NULL,
  document_id        uuid        NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid        NULL,
  CONSTRAINT pk_asset_history PRIMARY KEY (id),
  CONSTRAINT fk_asset_history__asset_id
    FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_history__allocation_id
    FOREIGN KEY (allocation_id) REFERENCES public.asset_allocations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_history__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_history__from_employee_id
    FOREIGN KEY (from_employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_history__to_employee_id
    FOREIGN KEY (to_employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_history__location_id
    FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_history__document_id
    FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE RESTRICT,
  CONSTRAINT ck_asset_history__event CHECK (event IN
    ('created','stock_in','requested','approved','handed_over','acknowledged',
     'transferred','return_requested','returned','recalled','repaired','lost',
     'damaged','written_off','audited')),
  CONSTRAINT ck_asset_history__quantity CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT ck_asset_history__conditions CHECK (
    (condition_before IS NULL OR condition_before IN ('new','good','fair','poor','unserviceable')) AND
    (condition_after  IS NULL OR condition_after  IN ('new','good','fair','poor','unserviceable')))
);

COMMENT ON TABLE public.asset_history IS
  'Append-only chronological custody trail: handovers, returns, recalls. Written by the allocation RPCs / edge functions, never by clients.';

CREATE INDEX IF NOT EXISTS idx_asset_history__asset_time
  ON public.asset_history (asset_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_asset_history__allocation_id ON public.asset_history (allocation_id);
CREATE INDEX IF NOT EXISTS idx_asset_history__employee_id   ON public.asset_history (employee_id);
CREATE INDEX IF NOT EXISTS idx_asset_history__from_employee_id ON public.asset_history (from_employee_id);
CREATE INDEX IF NOT EXISTS idx_asset_history__to_employee_id ON public.asset_history (to_employee_id);
CREATE INDEX IF NOT EXISTS idx_asset_history__location_id   ON public.asset_history (location_id);
CREATE INDEX IF NOT EXISTS idx_asset_history__document_id   ON public.asset_history (document_id);
CREATE INDEX IF NOT EXISTS idx_asset_history__recorded_at_brin
  ON public.asset_history USING brin (recorded_at);

DROP TRIGGER IF EXISTS trg_asset_history__immutable ON public.asset_history;
CREATE TRIGGER trg_asset_history__immutable
  BEFORE UPDATE OR DELETE ON public.asset_history
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.asset_history ENABLE ROW LEVEL SECURITY;

-- P1 self read (own custody events), P5 manager read, P8 admin read.
DROP POLICY IF EXISTS asset_history__self__select ON public.asset_history;
CREATE POLICY asset_history__self__select ON public.asset_history
  FOR SELECT TO authenticated
  USING (
    (employee_id      IS NOT NULL AND employee_id      = app.current_employee_id()) OR
    (from_employee_id IS NOT NULL AND from_employee_id = app.current_employee_id()) OR
    (to_employee_id   IS NOT NULL AND to_employee_id   = app.current_employee_id()));

DROP POLICY IF EXISTS asset_history__manager__select ON public.asset_history;
CREATE POLICY asset_history__manager__select ON public.asset_history
  FOR SELECT TO authenticated
  USING (employee_id IS NOT NULL AND app.is_manager_of(employee_id));

DROP POLICY IF EXISTS asset_history__admin__select ON public.asset_history;
CREATE POLICY asset_history__admin__select ON public.asset_history
  FOR SELECT TO authenticated
  USING (app.is_admin());

GRANT SELECT ON public.asset_history TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.asset_history FROM authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.asset_history TO service_role;
    REVOKE UPDATE, DELETE ON public.asset_history FROM service_role;
  END IF;
END $$;

COMMIT;
