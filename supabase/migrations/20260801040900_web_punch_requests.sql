-- =============================================================================
-- 20260801040900 — web_punch_requests: the table WEB_LOGIN has always pointed at
-- =============================================================================
--
-- `request_types.code = 'WEB_LOGIN'` was seeded by 004500 with
-- `detail_table = 'web_punch_requests'`, and that string has existed in exactly
-- two places ever since — that seed row and the `ck_request_types__detail_table`
-- CHECK list in 002900. NO MIGRATION EVER CREATED THE TABLE. Because
-- `approval_requests.detail_id` is NOT NULL, a WEB_LOGIN request has always
-- needed a detail row with nowhere to live, so the route could not be raised at
-- all; `WebPunchRequest.page.tsx` says so in prose and proves it on screen.
-- 004500 also seeded no chain for the type, so even with a detail row
-- `create_approval_request` would have raised `no approval chain matches request
-- type WEB_LOGIN`. This file closes both halves of that gap.
--
-- WHAT A WEB PUNCH REQUEST CARRIES, AND WHY EACH COLUMN IS HERE
--
--  1. `requested_punch_at timestamptz` — the instant being asked for, not a
--     date. A punch IS an instant; storing the wall clock separately would make
--     two columns disagree the first time somebody edits one. The IST civil day
--     is DERIVED from it (`ist_date`, generated, `util.ist_date`), never typed —
--     the same decision `attendance_punches` made in 001600, and the reason this
--     file contains no `CURRENT_DATE` and no `now()::date`: at 04:00 IST those
--     name yesterday, and an attendance row filed against the wrong civil day is
--     a day's pay argued about a month later.
--
--  2. `direction` — `public.punch_direction`, narrowed by CHECK to ('in','out').
--     The enum also carries break_start/break_end/undetermined; a break
--     correction is a `break_correction` REGULARIZATION (001700) and
--     'undetermined' is what the engine writes when it cannot tell, which is not
--     something a person may request. Reusing the enum rather than inventing a
--     text column means the value copies straight into `attendance_punches`
--     when the request is applied.
--
--  3. `employee_reason`, NOT NULL, ≥ 15 characters — the same floor
--     `ck_ar__employee_reason` puts on a regularization (001700). This route
--     exists precisely for the punch nobody witnessed, so the sentence is the
--     only evidence an approver has. "ok" is not evidence.
--
--  4. Geo and network evidence (`lat`, `lng`, `location_accuracy_m`,
--     `geofence_ok`, `ip`, `user_agent`, `device_id`) — same names, same types
--     as `attendance_punches` (001600, extended by 037100 and 037500). The
--     screen does not collect them TODAY, which is why every one is NULLABLE and
--     none is asserted by a CHECK. They are here because applying an approved
--     request must be a column copy into the punch row rather than a
--     re-derivation from whatever the apply function can still see — by then the
--     browser that knew the location is long gone. A half-coordinate is refused
--     (`ck_wpr__geo_pair`): a latitude with no longitude is not a location, it is
--     a number that will be plotted off the coast of Africa.
--
-- NO MONEY COLUMNS. Nothing on this table is a currency amount, so the paise
-- convention has nothing to bind; `lat`/`lng`/`location_accuracy_m` are numeric
-- because they are measurements copied verbatim from `attendance_punches`, not
-- because anyone is storing rupees in a numeric.
--
-- THE ENTITLEMENT IS ENFORCED HERE, NOT ONLY IN THE BROWSER
--
-- The screen reads two server-owned switches — `employees.allow_web_punch`
-- (000800) and `attendance_policies.allow_web_punch` (001400, switched on by
-- 031000) — and 031000 records that `attendance-self-punch` requires BOTH. A
-- direct PostgREST insert would have honoured neither. A rule that only the form
-- enforces is a rule the form's author enforces, not the company, so
-- `web_punch_requests_entitlement_guard` re-asks both questions on the row.
--
-- REFUSALS RAISE 23514, because `WRITE_CODE_KIND` in `src/shared/api/write.ts`
-- maps that to `conflict` and `isRuleRejection` renders it to the user verbatim.
-- The messages below are written for the employee who pressed the button.
--
-- AC-WEBPUNCH: ONE LEVEL, THE REPORTING MANAGER
--
-- The person who knows whether you were at the venue is the person you report
-- to. `finance` is deliberately NOT used anywhere in this file: 040600 recorded
-- that `resolve_approver_kind('finance')` needs a department coded `FIN`, that
-- FIN is inactive with zero staff on this deployment, and that the level
-- therefore falls through to hr_admin at runtime while claiming to be a finance
-- stage. A label that lies is worse than no label. Admin override at any level
-- already works through `act_on_approval`'s `v_is_admin` branch and is untouched.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 040900: create web_punch_requests, the detail table WEB_LOGIN points at, and seed AC-WEBPUNCH so the route can be raised', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.web_punch_requests (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id           uuid        NOT NULL,
  requested_punch_at    timestamptz NOT NULL,
  -- Derived, never typed. `util.ist_date` is IMMUTABLE (000200), which is what
  -- makes it legal in a generated column and what keeps this value and the
  -- punch's own `ist_date` from ever disagreeing.
  ist_date              date        NOT NULL GENERATED ALWAYS AS (util.ist_date(requested_punch_at)) STORED,
  direction             public.punch_direction NOT NULL,
  employee_reason       text        NOT NULL,
  -- Evidence the browser may attach; see header note 4. All nullable.
  lat                   numeric(10,7) NULL,
  lng                   numeric(10,7) NULL,
  location_accuracy_m   numeric(8,2)  NULL,
  geofence_ok           boolean     NULL,
  ip                    inet        NULL,
  user_agent            text        NULL,
  device_id             text        NULL,
  status                public.approval_status NOT NULL DEFAULT 'draft',
  approval_request_id   uuid        NULL,   -- FK added by the guarded block below
  decided_by            uuid        NULL,
  decided_at            timestamptz NULL,
  decision_comment      text        NULL,
  applied_at            timestamptz NULL,
  -- No FK: `attendance_punches` is RANGE-partitioned on punched_at and its
  -- primary key is (id, punched_at), so a single-column reference is not
  -- expressible. 001600 records the same limitation for duplicate_of_punch_id.
  created_punch_id      uuid        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NULL,
  CONSTRAINT pk_web_punch_requests PRIMARY KEY (id),
  CONSTRAINT fk_wpr__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wpr__decided_by
    FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_wpr__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_wpr__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Only the two directions a person can ask for; see header note 2.
  CONSTRAINT ck_wpr__direction CHECK (direction IN ('in','out')),
  -- Same floor as ck_ar__employee_reason (001700); see header note 3.
  CONSTRAINT ck_wpr__employee_reason CHECK (length(btrim(employee_reason)) >= 15),
  -- Mirrors ck_ap__not_future (001600) exactly, including the 5-minute skew
  -- allowance: whatever this row becomes must satisfy the punch table's own
  -- guard, and finding that out at apply time means an approved request that
  -- cannot be applied.
  -- It also subsumes the sentinel guard the rest of the build spells out
  -- separately (ck_rc__no_sentinel_dates, 002400): a '9999-12-31' arriving
  -- through an import is already in the future, so one constraint catches both
  -- and a second would be noise.
  CONSTRAINT ck_wpr__not_future CHECK (requested_punch_at <= now() + interval '5 minutes'),
  -- A latitude without a longitude is not a location; see header note 4.
  CONSTRAINT ck_wpr__geo_pair CHECK ((lat IS NULL) = (lng IS NULL)),
  CONSTRAINT ck_wpr__geo_range CHECK (
    (lat IS NULL OR (lat >= -90  AND lat <= 90))
    AND (lng IS NULL OR (lng >= -180 AND lng <= 180))
    AND (location_accuracy_m IS NULL OR location_accuracy_m >= 0)),
  -- A decision without a decider is an unattributable decision. Same pair as
  -- ck_bi__approved_fields (002400). 'auto_approved' is deliberately NOT in this
  -- list: the SLA sweeper decides with no human, so demanding a decided_by would
  -- either fail that path or invite a fake profile id into the column.
  CONSTRAINT ck_wpr__decided_fields CHECK (
    status NOT IN ('approved','rejected')
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- Same rule as ck_ar__rejection_comment (001700): a refusal the employee
  -- cannot read is a refusal they will re-file tomorrow.
  CONSTRAINT ck_wpr__rejection_comment CHECK (
    status <> 'rejected' OR length(btrim(coalesce(decision_comment, ''))) > 0),
  -- 'applied' means a punch exists. Without this the status can claim an
  -- attendance effect no row anywhere backs up.
  CONSTRAINT ck_wpr__applied_fields CHECK (
    status <> 'applied' OR (applied_at IS NOT NULL AND created_punch_id IS NOT NULL))
);

COMMENT ON TABLE public.web_punch_requests IS
  'Detail rows for request_types.code = ''WEB_LOGIN'' (detail_table = ''web_punch_requests'', seeded 004500). One row = one requested in/out punch from outside the gate, awaiting approval. Approved rows are what an apply step turns into an attendance_punches row.';
COMMENT ON COLUMN public.web_punch_requests.requested_punch_at IS
  'The instant being requested. Timestamptz because a punch is an instant; the IST civil day is derived into ist_date, never typed.';
COMMENT ON COLUMN public.web_punch_requests.ist_date IS
  'IST civil day of requested_punch_at, via util.ist_date. Generated so it cannot drift from the instant it describes.';
COMMENT ON COLUMN public.web_punch_requests.direction IS
  'in or out only. Breaks are corrected through a break_correction regularization; ''undetermined'' is an engine value, not a request.';
COMMENT ON COLUMN public.web_punch_requests.created_punch_id IS
  'The attendance_punches row this request produced. No FK — that table is partitioned and keyed (id, punched_at).';

-- Attached in a guarded block rather than inline, following the deferred-FK
-- sweep in 004900: `CREATE TABLE IF NOT EXISTS` is a no-op on a cluster where an
-- earlier partial run already made the table, and an inline constraint would
-- then never appear. This form lands the FK either way.
DO $$ BEGIN
  ALTER TABLE public.web_punch_requests
    ADD CONSTRAINT fk_wpr__approval_request
    FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_wpr__employee_date
  ON public.web_punch_requests (employee_id, ist_date);
CREATE INDEX IF NOT EXISTS idx_wpr__status_created
  ON public.web_punch_requests (status, created_at DESC)
  WHERE status IN ('draft','pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_wpr__approval
  ON public.web_punch_requests (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- One open request per employee, instant and direction. `approval_requests`
-- points at exactly one detail row, so two open requests for the same punch
-- become two approvals and, on apply, two punches for one event — which the
-- attendance engine reads as an in with no out.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wpr__one_open_per_instant
  ON public.web_punch_requests (employee_id, requested_punch_at, direction)
  WHERE status IN ('draft','pending','in_progress');

-- -----------------------------------------------------------------------------
-- 2. The entitlement guard
-- -----------------------------------------------------------------------------
--
-- SECURITY DEFINER because an employee filing their own request cannot read
-- `attendance_policies` or `policy_assignments` under their own grants, and the
-- policy switch must still be consulted.
--
-- Policy resolution order: `resolve_policy` first — that is the assignment table
-- the attendance engine itself obeys — then `employees.attendance_policy_id`,
-- which is the column `WebPunchRequest.page.tsx` reads to draw the switch. If the
-- two ever disagree the screen and the database would give different answers to
-- the same question, so the fallback is explicit rather than implied.
--
-- NO POLICY RESOLVES = NO PERMISSION. `allow_web_punch` is `NOT NULL DEFAULT
-- false` on both tables; an unassigned employee has nobody who said yes, and
-- reading absence as consent is how a switch that was never turned on ends up
-- admitting punches.
--
-- ADMINISTRATORS PASS. An admin already has a direct punch path (admin-punch)
-- and is recording a correction knowingly; refusing them here would only push
-- the same correction into a channel that captures less evidence than this one.
CREATE OR REPLACE FUNCTION public.web_punch_requests_entitlement_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_emp_allows  boolean;
  v_excluded    boolean;
  v_policy_id   uuid;
  v_pol_allows  boolean;
BEGIN
  IF app.is_admin() THEN
    RETURN NEW;
  END IF;

  SELECT e.allow_web_punch, e.exclude_from_attendance, e.attendance_policy_id
    INTO v_emp_allows, v_excluded, v_policy_id
    FROM public.employees e
   WHERE e.id = NEW.employee_id;

  IF v_excluded THEN
    RAISE EXCEPTION
      'Your record is marked as excluded from attendance, so there is no punch for this request to become. Ask HR if that is wrong.'
      USING errcode = '23514';
  END IF;

  IF NOT COALESCE(v_emp_allows, false) THEN
    RAISE EXCEPTION
      'Web punching is not enabled on your employee record. Ask HR to switch it on, or file an attendance regularization for this day instead.'
      USING errcode = '23514';
  END IF;

  v_policy_id := COALESCE(
    public.resolve_policy('attendance_policy', NEW.employee_id, util.ist_date(NEW.requested_punch_at)),
    v_policy_id);

  SELECT ap.allow_web_punch INTO v_pol_allows
    FROM public.attendance_policies ap
   WHERE ap.id = v_policy_id;

  IF NOT COALESCE(v_pol_allows, false) THEN
    RAISE EXCEPTION
      'Your attendance policy does not allow punching from the portal, so this request cannot be raised. File an attendance regularization for this day instead.'
      USING errcode = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.web_punch_requests_entitlement_guard() IS
  'Re-asks, on the row, the two switches WebPunchRequest.page.tsx shows: employees.allow_web_punch and attendance_policies.allow_web_punch. Both must be true, as attendance-self-punch has required since migration 031000.';

DROP TRIGGER IF EXISTS trg_wpr__entitlement ON public.web_punch_requests;
CREATE TRIGGER trg_wpr__entitlement
  BEFORE INSERT OR UPDATE OF employee_id, requested_punch_at ON public.web_punch_requests
  FOR EACH ROW EXECUTE FUNCTION public.web_punch_requests_entitlement_guard();

-- -----------------------------------------------------------------------------
-- 3. Stamp / touch / audit
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_wpr__stamp ON public.web_punch_requests;
CREATE TRIGGER trg_wpr__stamp
  BEFORE INSERT ON public.web_punch_requests
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_wpr__touch ON public.web_punch_requests;
CREATE TRIGGER trg_wpr__touch
  BEFORE UPDATE ON public.web_punch_requests
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Attached here rather than by editing 003800, which has already run everywhere.
-- Same shape as every entry in that file's §10. This IS an audited table: it is
-- an attendance assertion made with no witness, and the audit row is the only
-- record of who changed the requested time after an approver looked at it.
DROP TRIGGER IF EXISTS trg_web_punch_requests__audit ON public.web_punch_requests;
CREATE TRIGGER trg_web_punch_requests__audit
  AFTER INSERT OR UPDATE OR DELETE ON public.web_punch_requests
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
--
-- Without this the table would be world-readable to every authenticated session
-- the moment the grants below land, and the post-flight audit fails any public
-- table with RLS off.

ALTER TABLE public.web_punch_requests ENABLE ROW LEVEL SECURITY;

-- P1 self: read own; raise own; edit while it is still yours to edit. The
-- `(SELECT …)` wrapping is the form migration 20260807091000 rewrote every other
-- policy into — an uncorrelated subquery becomes one InitPlan per statement
-- instead of one opaque function call per row, and it lets the planner use
-- idx_wpr__employee_date.
DROP POLICY IF EXISTS wpr__self__select ON public.web_punch_requests;
CREATE POLICY wpr__self__select ON public.web_punch_requests
  FOR SELECT TO authenticated
  USING (employee_id = (SELECT app.current_employee_id()));

DROP POLICY IF EXISTS wpr__self__insert ON public.web_punch_requests;
CREATE POLICY wpr__self__insert ON public.web_punch_requests
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = (SELECT app.current_employee_id())
              AND status IN ('draft','pending'));

-- The USING clause closes the moment an approver has the row, so an employee
-- cannot move the requested time after it was looked at. WITH CHECK additionally
-- admits cancelled/withdrawn so pulling your own request back is a self action
-- and not an admin errand.
DROP POLICY IF EXISTS wpr__self__update ON public.web_punch_requests;
CREATE POLICY wpr__self__update ON public.web_punch_requests
  FOR UPDATE TO authenticated
  USING (employee_id = (SELECT app.current_employee_id()) AND status IN ('draft','pending'))
  WITH CHECK (employee_id = (SELECT app.current_employee_id())
              AND status IN ('draft','pending','cancelled','withdrawn'));

-- P5 manager: team read. Decisions go through the approval RPC, never a direct
-- UPDATE, which is why there is no manager write policy.
-- `app.can_see_employee`, NOT `app.visible_employee_ids()`.
--
-- The hashed set is the better predicate and it IS where this policy ends up —
-- but it is created by 20260806120000, four months of migration numbers AFTER
-- this file. Writing it here fails the whole migration with
-- `function app.visible_employee_ids() does not exist` on any from-scratch
-- replay, which is exactly what `npm run db:validate` reported. A migration may
-- only use what already exists at its own point in the ordering; the sweep in
-- 20260806120200 will substitute this policy along with every other.
DROP POLICY IF EXISTS wpr__manager__select ON public.web_punch_requests;
CREATE POLICY wpr__manager__select ON public.web_punch_requests
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- P8 admin.
DROP POLICY IF EXISTS wpr__admin__select ON public.web_punch_requests;
CREATE POLICY wpr__admin__select ON public.web_punch_requests
  FOR SELECT TO authenticated
  USING ((SELECT app.is_admin()) AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS wpr__admin__insert ON public.web_punch_requests;
CREATE POLICY wpr__admin__insert ON public.web_punch_requests
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT app.is_admin()) AND app.admin_scope_covers(employee_id));

DROP POLICY IF EXISTS wpr__admin__update ON public.web_punch_requests;
CREATE POLICY wpr__admin__update ON public.web_punch_requests
  FOR UPDATE TO authenticated
  USING ((SELECT app.is_admin()) AND app.admin_scope_covers(employee_id))
  WITH CHECK ((SELECT app.is_admin()) AND app.admin_scope_covers(employee_id));

-- DELETE is revoked, not policy-gated: an attendance assertion is withdrawn by
-- status, never erased, or the audit trail has a hole exactly where the argument
-- will be.
GRANT SELECT, INSERT, UPDATE ON public.web_punch_requests TO authenticated;
REVOKE DELETE ON public.web_punch_requests FROM authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.web_punch_requests TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. AC-WEBPUNCH — the chain WEB_LOGIN never had
-- -----------------------------------------------------------------------------
--
-- No amount or day bands: a punch request has no amount and no duration, so
-- banding it would leave `create_approval_request` selecting on columns that are
-- always NULL. `is_default = true` and `priority 10` so it is chosen ahead of
-- anything a future migration adds beside it.

INSERT INTO public.approval_chains
  (company_id, request_type_id, code, name, description, sort_order,
   amount_from, amount_to, days_from, days_to, priority, is_default)
SELECT c.id, rt.id,
       'AC-WEBPUNCH', 'Web punch — reporting manager',
       'Level 1 the employee''s reporting manager: the person who knows whether they were at the venue. No finance level — FIN is empty on this deployment (see 040600).',
       15,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       10::smallint, true
FROM public.companies c
JOIN public.request_types rt ON rt.code = 'WEB_LOGIN' AND rt.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

-- skip_if_same_as_previous is the house default on every seeded level and costs
-- nothing at level 1; it is set so a later level added above this one cannot
-- make the same person approve twice.
INSERT INTO public.approval_chain_levels
  (approval_chain_id, level, approver_kind, is_optional, skip_if_same_as_previous)
SELECT ac.id, 1, 'reporting_manager', false, true
FROM public.approval_chains ac
WHERE ac.code = 'AC-WEBPUNCH' AND ac.deleted_at IS NULL
ON CONFLICT (approval_chain_id, level) DO NOTHING;

-- `create_approval_request` falls back to `default_approval_chain_id` when no
-- chain matches on selectors. WEB_LOGIN's is NULL today — 004500's wiring UPDATE
-- only touched types that had a default chain, and this one had none — so
-- without this the fallback path still raises `no approval chain matches request
-- type WEB_LOGIN` even with the chain above in place.
UPDATE public.request_types rt
   SET default_approval_chain_id = ac.id
  FROM public.approval_chains ac
 WHERE ac.code = 'AC-WEBPUNCH'
   AND ac.deleted_at IS NULL
   AND rt.code = 'WEB_LOGIN'
   AND rt.deleted_at IS NULL
   AND rt.default_approval_chain_id IS DISTINCT FROM ac.id;

COMMIT;
