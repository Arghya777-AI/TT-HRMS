-- =============================================================================
-- Migration 068 — make two seeded admin capabilities TRUE at the RLS boundary.
--
-- WHY
-- ---
-- An earlier audit concluded "admin holds every capability, nothing needed
-- granting" from `app.has_cap()` alone. An adversarial re-check showed that was
-- under-proved: `app.has_cap()` is only a lookup in `role_capabilities`. RLS is
-- what actually permits a write. Two capabilities were granted in the matrix and
-- refused by the policies:
--
--   1. `attendance.lock.manage` — seeded for `admin`, described as
--      "Lock or unlock an attendance period". The policies are
--        attendance_locks__read           (read)
--        attendance_locks__admin_insert   (admin may CREATE a lock)   ← works
--        attendance_locks__super_update   (only super_admin may UPDATE)
--      Unlocking is an UPDATE (unlocked_by / unlocked_at / unlock_reason), so an
--      admin could lock a period and then not unlock it. The capability text
--      promised both.
--
--   2. `kiosk.device.manage` — seeded for `admin`, described as
--      "Manage kiosk devices and operators". Operators genuinely work
--      (kiosk_operators__admin_all is FOR ALL), and the kiosk-provision edge
--      function runs service-role so activation codes and operator PINs work.
--      But `public.kiosk_devices` had only kiosk_devices__admin_read (SELECT) and
--      kiosk_devices__super_admin_write, so an admin could not register or
--      rename a device from the admin console at all.
--
-- THE DECISION, and why this direction
-- ------------------------------------
-- The alternative was to narrow both capability DESCRIPTIONS to match the
-- policies. I chose to widen the policies instead, for two reasons:
--   * the client's instruction is explicit — HR *is* the admin role, and an admin
--     is expected to control the platform; and
--   * both actions are ordinary, reversible operations. Locking and
--     unlocking a period is routine month-end HR work: an admin who cannot
--     unlock cannot correct an attendance error before payroll, which turns a
--     five-minute fix into an escalation.
--
-- WHAT STAYS RESERVED TO super_admin, deliberately unchanged
-- ---------------------------------------------------------
--   * `attendance.lock.override` — writing INTO a locked period. That is the
--     genuinely dangerous power (it mutates figures a payroll run has already
--     used) and it stays super-only, with step-up. Unlocking is visible and
--     audited; overriding a lock silently is not the same thing at all.
--   * `kiosk.device.secret.rotate` — rotating a device's HMAC secret changes
--     which physical tablet can post punches, i.e. attribution of attendance.
--   * `employee.hard_delete`, `employee.data.purge`, `biometric.template.purge`,
--     `payroll.run.delete`, `audit.export`, `role.grant`/`revoke`,
--     `settings.security.write`, `ai.budget.override`, `admin.super`.
--
-- Admin scope still applies: an admin may only act within
-- `app.admin_scope_covers()`, so a location-scoped admin cannot unlock another
-- location's period. The reason requirement is untouched — `attendance_locks` is
-- in `audit.reason_required_tables`, and `ck_attendance_locks` already demands an
-- `unlock_reason` of real length whenever `unlocked_at` is set.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 068: let an admin unlock an attendance period and manage kiosk device rows, matching the seeded capability matrix', true);
SELECT set_config('app.source', 'migration', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. attendance_locks — an admin may UNLOCK within their scope.
--    The super_admin policy is LEFT IN PLACE: multiple permissive policies are
--    OR-ed, so a super admin keeps the unrestricted path and nothing narrows.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS attendance_locks__admin_update ON public.attendance_locks;
CREATE POLICY attendance_locks__admin_update ON public.attendance_locks
  FOR UPDATE TO authenticated
  USING (
    app.is_admin()
    AND app.has_cap('attendance.lock.manage')
    AND (employee_id IS NULL OR app.admin_scope_covers(employee_id))
  )
  WITH CHECK (
    app.is_admin()
    AND app.has_cap('attendance.lock.manage')
    AND (employee_id IS NULL OR app.admin_scope_covers(employee_id))
  );

COMMENT ON POLICY attendance_locks__admin_update ON public.attendance_locks IS
  'Lets an admin UNLOCK (and amend) a period, which attendance.lock.manage already promised — previously only super_admin could UPDATE, so an admin could lock a period and not unlock it. Writing INTO a locked period remains attendance.lock.override, super_admin only. The mandatory unlock_reason and the audit reason are unchanged (migration 068).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. kiosk_devices — an admin may register and maintain a device row.
--    `authenticated` already holds SELECT, INSERT, UPDATE on this table
--    (migration 013), so only the policy was missing; no grant change is needed.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS kiosk_devices__admin_write ON public.kiosk_devices;
CREATE POLICY kiosk_devices__admin_write ON public.kiosk_devices
  FOR INSERT TO authenticated
  WITH CHECK (app.is_admin() AND app.has_cap('kiosk.device.manage'));

DROP POLICY IF EXISTS kiosk_devices__admin_update ON public.kiosk_devices;
CREATE POLICY kiosk_devices__admin_update ON public.kiosk_devices
  FOR UPDATE TO authenticated
  USING (app.is_admin() AND app.has_cap('kiosk.device.manage'))
  WITH CHECK (app.is_admin() AND app.has_cap('kiosk.device.manage'));

COMMENT ON POLICY kiosk_devices__admin_write ON public.kiosk_devices IS
  'Lets an admin register a kiosk device, which kiosk.device.manage already promised — the table previously had only an admin READ policy plus a super_admin write, so the admin console could list devices it could not create (migration 068). Rotating a device secret remains kiosk.device.secret.rotate, super_admin only.';

COMMIT;
