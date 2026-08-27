-- ============================================================================
-- 20260824120000_the_gate_opens_without_a_guard.sql
--
-- The gate terminal is now UNATTENDED. No guard signs in; employees walk up and scan.
--
-- ── NOTHING DEPENDS ON THIS MIGRATION ANY MORE. IT IS DATA HYGIENE. ──────────
-- When this was written the flag was load-bearing: `kiosk-punch` branched on the row and
-- refused a punch without a guard session, so the gate could not work until the row was
-- flipped. It could not be applied — the remote migration ledger has diverged from the
-- local files, so `db push` demands `--include-all` and would replay ~31 old migrations —
-- and a terminal nobody can run is not an acceptable place to leave the client. So the
-- dependency was removed instead: `kiosk-punch` now treats the operator session as optional
-- on every request and requires liveness unconditionally, and the gate client has no guard
-- screen at all.
--
-- What is left here is worth applying and safe to skip. Applying it makes
-- `/admin/kiosk/devices` stop describing every gate as attended, which is now false. It
-- changes no behaviour in either direction.
--
-- `kiosk_devices.require_operator` has defaulted to TRUE since migration 20260801001300,
-- and the client honours it, so every paired tablet still demanded a PIN before it would
-- scan anybody. The flag was the right mechanism and the wrong value: nothing in the client
-- can override it, because `kiosk-punch` reads the ROW —
--
--     const operator = device.requireOperator
--       ? await requireOperatorSession(req, deviceAuth, client)   -- hard requirement
--       : await requireOperatorSession(req, deviceAuth, client).catch(() => null);
--
-- so a device whose row says true refuses the punch no matter what the screen does. This
-- flips the value, and the default with it.
--
-- ── WHAT THIS GIVES UP, STATED PLAINLY ──────────────────────────────────────
-- Migration 20260801035000 listed the four controls protecting the gate after the IP fence
-- was removed. One of them was this: "A GUARD PIN SESSION. `require_operator` is true, so
-- no punch is accepted until a named guard has signed in; the punch records who was on the
-- door." That control is now gone. Two consequences, both real:
--
--   1. PUNCHES LOSE OPERATOR ATTRIBUTION. `attendance_punches.recorded_by` and
--      `secure.face_match_log.operator_id` become NULL for gate scans. A disputed punch can
--      still be traced to a device, a time and a face, but not to a human who was present.
--
--   2. NOBODY RESOLVES AN AMBIGUOUS MATCH. When two people score too close together the
--      server offers the top three for a guard to confirm. With no guard the scan simply
--      fails and lands in `/admin/kiosk/match-review`, which is the correct outcome but a
--      slower one for the person at the door.
--
-- ── WHAT REPLACES IT ────────────────────────────────────────────────────────
-- The defence a guard was actually providing at an unattended door is LIVENESS — a human
-- watching cannot be fooled by a phone held up to the lens. That is now measured on the
-- device over two descriptor frames 500 ms apart and enforced server-side in `kiosk-punch`
-- against `attendance.liveness_pass_threshold`, before the 1:N runs. A printed photograph
-- scores ~0 and is refused.
--
-- Still standing from that list of four: pairing, the request HMAC with its 120-second skew
-- window, and the single-use nonce. This removes one control and adds another; it does not
-- leave the gate open.
--
-- ── SCOPE ───────────────────────────────────────────────────────────────────
-- Every live device, and the column default so a newly paired tablet is unattended too —
-- which is the whole point, since the alternative is an admin remembering to flip a flag
-- for every gate. A site that wants an attended gate sets the flag back on that row; this
-- migration is the new baseline, not a lock.
-- ============================================================================

BEGIN;

/*
  Every migration that writes a row states why, because `reason_required` refuses
  an UPDATE without it. This one flips `require_operator` on existing gates in the
  DO block below, and shipped without the preamble — so it has never applied, in
  validation or in the live project. The gate has been demanding a guard the whole
  time.
*/
SELECT set_config('app.reason', 'migration 20260824120000: the gate terminal is unattended, so require_operator defaults to false and existing gates are flipped to match — liveness on the device replaces the guard', true);
SELECT set_config('app.source', 'migration', true);

ALTER TABLE public.kiosk_devices
  ALTER COLUMN require_operator SET DEFAULT false;

COMMENT ON COLUMN public.kiosk_devices.require_operator IS
  'When true, kiosk-punch refuses a scan until a named guard has an open operator session. '
  'Defaults to FALSE since 20260824120000: the gate terminal is unattended and liveness, '
  'measured on device and enforced in kiosk-punch, replaces the guard as the check that the '
  'face in front of the camera is a live one. Set true on a row for a staffed gate.';

DO $$
DECLARE
  v_flipped int;
  v_remaining int;
BEGIN
  UPDATE public.kiosk_devices
     SET require_operator = false
   WHERE deleted_at IS NULL
     AND require_operator;
  GET DIAGNOSTICS v_flipped = ROW_COUNT;

  /*
    NO SESSIONS ARE CLOSED HERE, AND NONE NEED TO BE.

    An earlier draft of this migration closed open guard sessions. There is no table to
    close: `_shared/auth.ts` records that the spec names a `kiosk_operator_session` table
    which the migrations never created, so an operator session is a STATELESS token signed
    with the device secret. It is device-bound by construction, it expires on its own
    within ninety minutes, and every use re-reads the operator row — so a token still in a
    tablet's storage simply stops being asked for. Writing an UPDATE against a table that
    does not exist, even guarded by an exception handler, would have left a reader of this
    file believing there was state being cleaned up.
  */

  SELECT count(*) INTO v_remaining
    FROM public.kiosk_devices
   WHERE deleted_at IS NULL
     AND require_operator;

  RAISE NOTICE 'devices switched to unattended: %', v_flipped;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      'migration 20260824120000: % live device(s) still require an operator — refusing to '
      'report success while a gate would still ask for a PIN', v_remaining;
  END IF;
END $$;

COMMIT;
