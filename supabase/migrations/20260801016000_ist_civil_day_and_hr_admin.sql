-- =============================================================================
-- Migration 160 — the IST civil day for authority windows, and HR == admin
--                 written down where the database itself can be asked.
--
-- Two audits produced this file.
--
-- AUDIT A — "HR is the admin role".
--   Confirmed, and nothing needed granting. `public.app_role` is exactly
--   ('employee','manager','admin','super_admin') (migration 003); there is no
--   `hr` value and no second HR table. The codebase already says so in
--   executable form: `public.resolve_approver_kind('hr_admin', …)` (migration
--   029 §8) resolves the HR approver set as `user_roles.role = 'admin'`.
--   `app.has_role()` (005) gives super_admin ⊃ admin ⊃ manager ⊃ employee, so
--   the 38 employee+manager+admin capability rows seeded in 050 §2 are ALL held
--   by `admin`; the 12 `super_admin` rows are reserved on purpose (role
--   granting, irreversible purge/delete, locked-period override, payroll-run
--   delete, off-platform audit export, security settings, device-secret
--   rotation, AI budget override). This migration therefore adds no capability
--   — it records the conclusion as COMMENTs so the next person can ask the
--   database instead of guessing.
--
-- AUDIT B — "IST everywhere".
--   The engines were already right: attendance, leave accrual, comp-off expiry,
--   payroll cutoffs and every view derive their day from `util.ist_today()` /
--   `util.ist_date()` / `util.business_date()`, and the pg_cron entries (041)
--   are UTC strings with IST intent plus `util.ist_today()` day guards.
--
--   TEN production sites did NOT: bare `CURRENT_DATE`. (An eleventh occurrence
--   lives in a demo seed and already COALESCEs a supplied date, so it is inert.)
--   The database timezone is UTC
--   — only `search_path` is set on it (001), and the audit engine pins its own
--   functions to UTC deliberately — so `CURRENT_DATE` is the UTC calendar day.
--   Between 00:00 and 05:29 IST that is YESTERDAY. Every one of these sites is
--   an authority window or an effective-date default:
--
--     * app.is_manager_of()        — delegation active window
--     * app.admin_scope_covers()   — scoped-admin assignment window (×2)
--     * public.resolve_approver_kind()  — location-head admin assignment window
--     * public.resolve_approvers()       — delegation expansion window
--     * public.act_on_approval()         — "acted as delegate" attribution
--     * employee_role_assignments.effective_from  DEFAULT
--     * employee_bank_accounts.effective_from     DEFAULT
--     * employee_swipe_cards.issued_on            DEFAULT
--     * employee_swipe_cards.valid_from           DEFAULT
--
--   Concretely, before this migration: a delegation dated to start today did
--   not take effect until 05:30 IST, and one that ended yesterday still
--   carried authority until 05:30 IST — during exactly the hours this venue
--   runs (a wedding shift ending at 02:00 IST is the normal case, not the edge
--   case). A bank account added at 01:00 IST was stamped effective the previous
--   day, which is a payroll input.
--
--   Fix, by function shape:
--     * the two small `app.*` SQL helpers are re-created with
--       `util.ist_today()` written out, because explicitness is worth more than
--       brevity in the two predicates every RLS policy leans on;
--     * the three large plpgsql workflow functions get
--       `SET timezone = 'Asia/Kolkata'`, which is what makes `CURRENT_DATE`
--       mean the IST civil day, with no 300-line body duplicated into a second
--       migration where it could silently drift from 029. Verified safe: none
--       of the three performs any other timezone-dependent operation — no
--       `to_char`, no `timestamptz::text`, no `::date`, no `AT TIME ZONE` —
--       `CURRENT_DATE` is the only expression the setting can reach. Migration
--       006 already establishes this pattern in the opposite direction
--       (`audit.write_row` / `audit.verify_chain` carry `SET timezone = 'UTC'`
--       so the hash payload is stable).
--
--   NOT changed, and why: `date_trunc('month'|'quarter', now())` in
--   `public.partition_maintenance`, migration 006 §partitions, 016 and 012 is
--   partition-bound arithmetic on a `timestamptz` key. UTC bounds there are
--   correct and contiguous — an IST-truncated bound would still be read as a
--   UTC instant, so it would move the seam without removing it. Storage seams
--   are not business days.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 070: authority windows and effective-date defaults must use the IST civil day, not the UTC one', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. app.is_manager_of — delegation window on the IST civil day
-- -----------------------------------------------------------------------------
-- Body identical to migration 005 apart from CURRENT_DATE -> util.ist_today().
CREATE OR REPLACE FUNCTION app.is_manager_of(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.reportee_ids(app.current_employee_id()) r WHERE r = p_employee_id
  )
  OR EXISTS (  -- active delegation of team view
    SELECT 1
    FROM public.delegations d
    JOIN public.employees me ON me.profile_id = d.delegator_profile_id
    WHERE d.delegate_profile_id = app.ctx_actor_id()
      AND d.is_active
      AND d.scope = 'approvals_and_team_view'
      AND util.ist_today() BETWEEN d.from_date AND COALESCE(d.to_date, util.ist_today())
      AND p_employee_id IN (SELECT app.reportee_ids(me.id))
  );
$$;

COMMENT ON FUNCTION app.is_manager_of(uuid) IS
  'Team-scope predicate: a real reporting line, or an active approvals_and_team_view delegation. The delegation window is compared against util.ist_today() — CURRENT_DATE would be the UTC day, which is yesterday between 00:00 and 05:29 IST.';

-- -----------------------------------------------------------------------------
-- 2. app.admin_scope_covers — scoped-admin window on the IST civil day
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.admin_scope_covers(p_employee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_super_admin()
      OR EXISTS (SELECT 1 FROM public.employee_role_assignments a
                 WHERE a.profile_id = app.ctx_actor_id() AND a.role = 'admin'
                   AND a.scope_kind = 'global'
                   AND util.ist_today() BETWEEN a.effective_from AND COALESCE(a.effective_to, util.ist_today()))
      OR EXISTS (SELECT 1
                 FROM public.employee_role_assignments a
                 JOIN public.employees e ON e.id = p_employee_id
                 WHERE a.profile_id = app.ctx_actor_id() AND a.role = 'admin'
                   AND util.ist_today() BETWEEN a.effective_from AND COALESCE(a.effective_to, util.ist_today())
                   AND (
                        (a.scope_kind = 'company'       AND a.company_id    = e.company_id)
                     OR (a.scope_kind = 'location'      AND a.location_id   = e.location_id)
                     OR (a.scope_kind = 'department'    AND a.department_id = e.department_id)
                     OR (a.scope_kind = 'section'       AND a.section_id    = e.section_id)
                     OR (a.scope_kind = 'employee_list' AND e.id = ANY(a.employee_ids))
                   ));
$$;

COMMENT ON FUNCTION app.admin_scope_covers(uuid) IS
  'Which employees this admin may touch. A super_admin covers everyone. Otherwise an employee_role_assignments row must be effective on the IST civil day (util.ist_today()) — a scope that started today must work at 01:00 IST, and one that ended yesterday must not.';

-- -----------------------------------------------------------------------------
-- 3. The three workflow functions: CURRENT_DATE means the IST civil day
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.resolve_approver_kind(text, public.app_role, uuid, uuid)
  SET timezone = 'Asia/Kolkata';
COMMENT ON FUNCTION public.resolve_approver_kind(text, public.app_role, uuid, uuid) IS
  'Approver set for one approver_kind. `hr_admin` IS `user_roles.role = ''admin''` — this venue has no separate HR role. Pinned to Asia/Kolkata so the CURRENT_DATE in the location-head branch is the IST civil day; it is the only timezone-dependent expression in the body.';

ALTER FUNCTION public.resolve_approvers(uuid, uuid, uuid, boolean)
  SET timezone = 'Asia/Kolkata';
COMMENT ON FUNCTION public.resolve_approvers(uuid, uuid, uuid, boolean) IS
  'Approver set for a chain level, with the hr_admin -> super_admin fallback ladder and depth-1 delegation expansion. Pinned to Asia/Kolkata so the delegation date window is the IST civil day, not the UTC one.';

ALTER FUNCTION public.act_on_approval(uuid, public.approval_action, text, jsonb)
  SET timezone = 'Asia/Kolkata';
COMMENT ON FUNCTION public.act_on_approval(uuid, public.approval_action, text, jsonb) IS
  'Records one approval action. Pinned to Asia/Kolkata so the delegation window that decides acted_as = delegate is the IST civil day; every instant it writes is still now() into timestamptz, i.e. UTC.';

-- -----------------------------------------------------------------------------
-- 4. Effective-date defaults: the IST civil day, not the UTC one
-- -----------------------------------------------------------------------------
-- A row inserted at 01:00 IST must be dated today, not yesterday. These are
-- payroll and access inputs, so the difference is not cosmetic.
ALTER TABLE public.employee_role_assignments
  ALTER COLUMN effective_from SET DEFAULT util.ist_today();

ALTER TABLE public.employee_bank_accounts
  ALTER COLUMN effective_from SET DEFAULT util.ist_today();

ALTER TABLE public.employee_swipe_cards
  ALTER COLUMN issued_on  SET DEFAULT util.ist_today(),
  ALTER COLUMN valid_from SET DEFAULT util.ist_today();

COMMENT ON COLUMN public.employee_role_assignments.effective_from IS
  'First IST civil day this scope is in force. Defaults to util.ist_today() — CURRENT_DATE would back-date a row created before 05:30 IST by one day.';
COMMENT ON COLUMN public.employee_bank_accounts.effective_from IS
  'First IST civil day this account is the payment target. Defaults to util.ist_today(); a UTC default would silently move a payroll input into the previous day.';

-- -----------------------------------------------------------------------------
-- 5. HR == admin, recorded where it can be queried
-- -----------------------------------------------------------------------------
COMMENT ON TYPE public.app_role IS
  'The complete role model: employee, manager, admin, super_admin. There is NO separate hr role and there never was — HR staff at Tamarind Tree hold `admin`, which is why public.resolve_approver_kind(''hr_admin'', …) resolves user_roles.role = ''admin''. app.has_role() applies the hierarchy super_admin > admin > manager > employee, so `admin` holds every employee, manager and admin capability in public.role_capabilities. `super_admin` is the technical safety tier, not a seniority tier: it adds only role granting, irreversible delete/purge, locked-period override, payroll-run delete, off-platform audit export, security settings, kiosk device-secret rotation and the AI budget override.';

COMMENT ON TABLE public.role_capabilities IS
  'Authorisation as data: what a ROLE may do (never who holds it). Read by app.has_cap(). Each role lists only what it ADDS — app.has_role() supplies the hierarchy, so `admin` (the HR role) effectively holds every employee + manager + admin row here. Writable by super_admin only, with a reason.';

COMMIT;
