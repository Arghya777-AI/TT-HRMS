-- =============================================================================
-- Migration 074 — a guard's PIN works at whichever gate they are standing at.
--
-- THE BUG, EXACTLY
-- ----------------
-- The client set a PIN for TT0002, opened the kiosk link, typed the code and the
-- PIN, and got:
--
--     "That code and PIN do not match. Try again, or ask a supervisor."
--
-- The PIN was correct. `kiosk-operator-auth` resolves the operator with
--
--     WHERE o.is_active
--       AND (o.kiosk_device_id IS NULL OR o.kiosk_device_id = <this device>)
--       AND e.employee_code = <typed code>
--
-- and BOTH seeded operators carry `kiosk_device_id = <TT-GATE-01>`. The client had
-- just paired a NEW device (GATE-CMB5N2, 15:21 IST) using the "Add a gate device"
-- button, so on that device the query matched no row, `operator` came back NULL,
-- and the code fell through to the same refusal it uses for a wrong PIN. No amount
-- of retyping could ever have worked.
--
-- This was introduced by making "add a device" possible: before that there was one
-- device, every operator was pinned to it, and the pin was invisible. The moment a
-- second gate could exist, per-device operators meant every new gate shipped with
-- nobody able to sign into it.
--
-- WHAT THIS CHANGES
-- -----------------
-- Active operators become device-agnostic (`kiosk_device_id = NULL`), which
-- migration 013 already defines as "authorised on every device":
--
--     -- NULL kiosk_device_id = authorised on every device (migration 013).
--
-- So a guard can start their shift at whatever phone or tablet is at the door,
-- including one added minutes earlier. That is what the product is: a link opened
-- on whatever device is to hand, and a named guard signing in on it.
--
-- WHY THIS IS THE RIGHT DEFAULT AND NOT A LOOSENING
-- ------------------------------------------------
-- Per-device operators would be a meaningful control at a site with separate
-- gatehouses under separate supervisors. This venue has ONE location
-- (`TTT-VENUE`) and gates that are phones. Pinning a guard to a device hard-codes
-- which handset they may hold, which is not a security property — it is a
-- scheduling accident that fails closed with a misleading message.
--
-- What still stands between a face and a punch, none of it touched here:
--   * the device must be PAIRED (one-time code, Argon2id, 15-minute TTL);
--   * every request is HMAC-signed with the device secret and carries a single-use
--     nonce;
--   * the guard must present a PIN (Argon2id, 5 attempts then a lockout);
--   * the operator row must be `is_active` and their profile active;
--   * the employee must be in an employment status the gate accepts.
--
-- An admin who later wants a guard bound to one gate can still set
-- `kiosk_operators.kiosk_device_id`, and `kiosk-operator-auth` enforces it
-- unchanged — the ORDER BY in that query even prefers a device-specific row over a
-- device-agnostic one, so a deliberate binding still wins.
--
-- SCOPE: active, non-deleted operator rows only. A deactivated operator is left
-- exactly as it is.
--
-- REVERSIBLE:
--   UPDATE public.kiosk_operators SET kiosk_device_id = '<device uuid>'
--    WHERE id = '<operator uuid>';
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 074: let an active kiosk operator sign in at any gate; both operators were pinned to TT-GATE-01 so a PIN could never work on a newly added device', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.kiosk_operators
   SET kiosk_device_id = NULL
 WHERE is_active
   AND kiosk_device_id IS NOT NULL;

DO $verify$
DECLARE
  v_total    integer;
  v_pinned   integer;
  v_dupes    integer;
BEGIN
  SELECT count(*) INTO v_total FROM public.kiosk_operators WHERE is_active;
  /*
    A NOTICE, NOT AN EXCEPTION — corrected after this migration spent months as a
    permanent red line in `npm run db:validate`.

    The two checks below are real post-conditions: they assert that what this
    migration DID actually took (nothing left pinned, no duplicate device-agnostic
    rows). This one asserted something else entirely — that somebody had seeded
    operators — which is not this migration's business and is not true of a fresh
    database. Unpinning zero operators from their devices is a successful no-op,
    not a failure.

    It mattered because a validator that is always red is a validator nobody
    reads, and the next genuine failure hides behind the two everybody has learned
    to scroll past.
  */
  IF v_total = 0 THEN
    RAISE NOTICE 'migration 074: no active kiosk operators to unpin (an empty or freshly built database)';
  END IF;

  SELECT count(*) INTO v_pinned
    FROM public.kiosk_operators
   WHERE is_active AND kiosk_device_id IS NOT NULL;
  IF v_pinned > 0 THEN
    RAISE EXCEPTION 'migration 074: % active operator(s) are still pinned to one device', v_pinned;
  END IF;

  -- `uq_kiosk_operators__profile_device` is UNIQUE on
  -- (profile_id, coalesce(kiosk_device_id, '000…0')), so collapsing several rows
  -- for the SAME profile onto NULL would violate it. Postgres would have raised
  -- already; this asserts the intent so the reason is on record rather than
  -- inferred from a constraint name.
  SELECT count(*) INTO v_dupes FROM (
    SELECT profile_id FROM public.kiosk_operators
     WHERE is_active AND kiosk_device_id IS NULL
     GROUP BY profile_id HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'migration 074: % profile(s) hold more than one device-agnostic operator row', v_dupes;
  END IF;

  RAISE NOTICE 'migration 074: % active operator(s) may now sign in at any gate', v_total;
END
$verify$;

COMMIT;
