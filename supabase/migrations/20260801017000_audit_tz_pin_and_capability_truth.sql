-- =============================================================================
-- Migration 170 — two corrections to migration 160's audit (review follow-up).
--
-- 160 was right about the bug class and right about the fix shape. Two things
-- it asserted were not fully checked, and both are corrected here without
-- changing a single grant or predicate.
--
-- ---------------------------------------------------------------------------
-- 1. `SET timezone` on a function LEAKS into the triggers its writes fire.
-- ---------------------------------------------------------------------------
--   160 pinned `public.act_on_approval` to Asia/Kolkata and justified it with
--   "none of the three performs any other timezone-dependent operation — no
--   to_char, no timestamptz::text, no ::date, no AT TIME ZONE". That is true of
--   the three BODIES. It is not true of the transaction: `act_on_approval` is
--   the only one of the three that WRITES (INSERT approval_actions, UPDATE
--   approval_requests, plus `advance_approval`), and those writes fire
--   `audit.log_changes()`, which carries `SET search_path = ''` but NO
--   `SET timezone`. A `SET` on the caller is inherited by a called function
--   that does not override it, so `log_changes` ran under Asia/Kolkata and its
--   `to_jsonb(NEW)` / `to_jsonb(OLD)` (migration 006 §log_changes, lines
--   490-499) rendered every `timestamptz` field with a +05:30 offset.
--
--   Measured, not assumed — same instant, same trigger, two callers:
--     via a caller pinned to Asia/Kolkata : "2026-07-27T05:00:00+05:30"
--     via an unpinned caller (session UTC): "2026-07-26T23:30:00+00:00"
--
--   What this did NOT break, so nobody goes looking: the hash chain is intact.
--   `audit.write_row` hashes the jsonb it is HANDED, and `audit.verify_chain`
--   re-reads that same stored jsonb — and `jsonb::text` of an already-rendered
--   string is timezone-independent (verified: md5 of the stored payload is
--   stable across three session zones). `audit_log.ist_date` / `ist_timestamp`
--   are GENERATED from `util.ist_date(occurred_at)`, so audit-log partitioning
--   and day-bucketing never depended on the ambient zone either.
--
--   What it DID break is representational consistency: approval rows written
--   through `act_on_approval` stored their field diffs in a different offset
--   from every other row in `audit_log`, so a diff viewer, an export, or a
--   `old_value->>'submitted_at'` comparison would see two formats in one column.
--
--   Fix: pin the writer, not the callers. `audit.log_changes()` is the feeder
--   for `audit.write_row`, which migration 006 already pins to UTC for exactly
--   this reason ("the ::text serialisation in the hash payload is
--   reproducible"). Pinning the feeder to UTC as well makes the audit engine
--   independent of whatever zone a calling function chose — which is the
--   property 006 was reaching for and the property 160 needed.
--
-- ---------------------------------------------------------------------------
-- 2. Two capability descriptions promised more than RLS grants.
-- ---------------------------------------------------------------------------
--   160's audit concluded "admin holds all 38 non-super capabilities, nothing
--   needed granting", and proved it with `app.has_cap()`. `app.has_cap()` is
--   not the boundary — RLS is. For two of the 20 admin rows the row-level
--   policies are strictly narrower than the description, and since
--   `/admin/settings/roles` now renders these descriptions to HR as
--   "read straight from the database", the matrix was telling an administrator
--   they could do things the server refuses:
--
--     attendance.lock.manage — described as "Lock or unlock an attendance
--       period". Enforced (migration 017 §attendance_locks):
--         attendance_locks__admin_insert  WITH CHECK (app.is_admin()
--             AND (lock_kind = 'soft' OR app.is_super_admin()))
--         attendance_locks__super_update  USING/WITH CHECK app.is_super_admin()
--       So an admin may take a SOFT lock and nothing else. An unlock is an
--       UPDATE stamping `unlocked_at`, so an admin cannot unlock at all, and a
--       HARD lock is super-admin too. This matches spec-admin §4 ("Unlock =
--       super_admin, reason >= 15, Critical alert") — the spec and the policies
--       agree; only the description was wrong.
--
--     kiosk.device.manage — described as "Manage kiosk devices and operators".
--       `kiosk_operators__admin_all` does give an admin FOR ALL on operators,
--       and `kiosk-provision` (which gates on this capability and runs
--       service-role) does let an admin issue activation codes and set operator
--       PINs. But `kiosk_devices` has only `kiosk_devices__admin_read`
--       (SELECT) + `kiosk_devices__super_admin_write` (FOR ALL, super only), so
--       editing a device row — including `min_match_confidence`, the face-match
--       threshold — is super-admin. `KioskDevices.page.tsx` and
--       `system.api.ts` already document that split correctly.
--
--   Description text only. No row is added, removed or re-roled; nothing gates
--   on `attendance.lock.manage` in any migration, edge function or screen, and
--   `kiosk.device.manage` keeps exactly the authority it had. Whether an admin
--   SHOULD be able to release a period lock or edit a gate tablet is a policy
--   question for the client, not something a description edit may decide — it is
--   raised in the review notes rather than answered here.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 170: pin the audit trigger to UTC so a caller''s timezone cannot reach the field diff, and make two capability descriptions match the RLS that enforces them', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The audit trigger renders its diffs in UTC, whoever calls it
-- -----------------------------------------------------------------------------
ALTER FUNCTION audit.log_changes() SET timezone = 'UTC';

COMMENT ON FUNCTION audit.log_changes() IS
  'Field-level audit trigger: diffs to_jsonb(OLD) against to_jsonb(NEW) and hands each changed field to audit.write_row. Pinned to UTC because a `SET timezone` on a CALLING function is inherited here, and to_jsonb() renders timestamptz in the ambient zone — public.act_on_approval carries SET timezone = Asia/Kolkata (migration 160) so that its CURRENT_DATE means the IST civil day, and without this pin every field diff it produced was stored at +05:30 while the rest of audit_log was at +00:00. The chain itself was never at risk (write_row/verify_chain hash the stored jsonb, whose ::text is zone-independent); the consistency of audit_log.old_value/new_value was.';

-- -----------------------------------------------------------------------------
-- 2. Descriptions that match the policies
-- -----------------------------------------------------------------------------
UPDATE public.role_capabilities
   SET description = 'Take a soft attendance-period lock. Releasing a lock, and taking a hard lock, are super_admin (attendance_locks__super_update / __admin_insert; spec-admin §4)'
 WHERE role = 'admin' AND capability = 'attendance.lock.manage';

UPDATE public.role_capabilities
   SET description = 'Manage kiosk operators, issue device activation codes and set operator PINs. Editing the device row itself (including min_match_confidence) is super_admin (kiosk_devices__super_admin_write)'
 WHERE role = 'admin' AND capability = 'kiosk.device.manage';

COMMIT;
