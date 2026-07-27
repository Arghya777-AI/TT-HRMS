-- =============================================================================
-- Migration 073 — the gate link has to work on whatever device opens it.
--
-- WHY, IN THE CLIENT'S WORDS
-- --------------------------
-- "Some kiosk will have a link that will be deployed in a laptop or a mobile. Use
--  that device's IP address for that, and I want to create it as a public link.
--  Public link means that link will be available in the dashboard. They can copy
--  it and send it to the security person."
--
-- THE DEAD END THIS REMOVES
-- -------------------------
-- `kiosk_devices.allowed_ip_cidrs` on TT-GATE-01 was ['49.207.57.255/32'] — a
-- single consumer IP, captured on the day the device was paired. That address had
-- already changed by the next morning, and `verifyDevice` answers
--
--     403 KIOSK_DEVICE_NETWORK  "This device is calling from an unapproved network."
--
-- to EVERY request, so the gate refused each guard sign-in before a camera ever
-- opened. A control pinned to a value that changes on its own is not a control; it
-- is a scheduled outage. And it cannot be reconciled with what the product is
-- meant to be — a link that is copied to whatever phone or laptop is at the door,
-- whose address nobody knows in advance.
--
-- WHAT STILL PROTECTS THE GATE — four controls, none of which the network was
-- doing any of:
--   * PAIRING. The device cannot authenticate until an admin issues a one-time
--     activation code (`kiosk-provision`) and it is entered on that device once.
--     Opening the link on its own yields a pairing prompt and nothing else.
--   * HMAC. Every request is signed with the device secret held in Vault
--     (`deviceCanonicalString` = timestamp.nonce.body), and the timestamp must be
--     inside a 120-second skew window.
--   * SINGLE-USE NONCE. `secure.kiosk_nonces` has PK (device_id, nonce), so a
--     captured request replays exactly once and then answers 409.
--   * A GUARD PIN SESSION. `require_operator` is true, so no punch is accepted
--     until a named guard has signed in; the punch records who was on the door.
-- Plus the 1:N face match itself, which is the actual subject of the decision.
--
-- The IP check was the only one of the five that a legitimate user trips over and
-- an attacker with the device secret would not. Removing it is a real reduction in
-- defence in depth, and it is the client's decision, made explicitly.
--
-- SCOPE: TT-GATE-01 only, by device code. Any device an admin fences deliberately
-- in future is untouched, and a blanket `SET allowed_ip_cidrs = NULL` would have
-- silently undone such a decision the moment somebody made one.
--
-- REVERSIBLE, once the venue's fixed line is known:
--   UPDATE public.kiosk_devices
--      SET allowed_ip_cidrs = ARRAY['<venue.cidr>']::cidr[]
--    WHERE device_code = 'TT-GATE-01';
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 073: clear the gate tablet IP allowlist so the public kiosk link works from any device; it was pinned to a stale consumer IP and refused every guard sign-in', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.kiosk_devices
   SET allowed_ip_cidrs = NULL
 WHERE device_code = 'TT-GATE-01'
   AND deleted_at IS NULL
   AND allowed_ip_cidrs IS NOT NULL;

DO $verify$
DECLARE
  v_exists    integer;
  v_restricted integer;
BEGIN
  SELECT count(*) INTO v_exists
    FROM public.kiosk_devices
   WHERE device_code = 'TT-GATE-01' AND deleted_at IS NULL;
  IF v_exists = 0 THEN
    RAISE EXCEPTION 'migration 073: TT-GATE-01 does not exist — the device code is wrong';
  END IF;

  SELECT count(*) INTO v_restricted
    FROM public.kiosk_devices
   WHERE device_code = 'TT-GATE-01'
     AND deleted_at IS NULL
     AND allowed_ip_cidrs IS NOT NULL;
  IF v_restricted > 0 THEN
    RAISE EXCEPTION 'migration 073: TT-GATE-01 still carries an IP allowlist';
  END IF;

  -- The pairing requirement is what makes the link safe to hand out. If this
  -- device were somehow not operator-gated, clearing the network check would be a
  -- materially different decision from the one described above — so refuse rather
  -- than quietly ship a weaker posture than the comment claims.
  PERFORM 1
     FROM public.kiosk_devices
    WHERE device_code = 'TT-GATE-01' AND deleted_at IS NULL AND require_operator;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration 073: TT-GATE-01 has require_operator = false — refusing to also drop the network check';
  END IF;

  RAISE NOTICE 'migration 073: TT-GATE-01 accepts any network; pairing, HMAC, nonce and guard PIN unchanged';
END
$verify$;

COMMIT;
