-- =============================================================================
-- Migration 064 (20260801012200_face_login_auth_channel) — make a
-- FACE-authenticated web session recordable.
--
-- WHY THIS EXISTS
-- ---------------
-- The `face-login` edge function signs an employee in by verifying a 128-D face
-- descriptor against their enrolled `secure.face_templates` row and then minting
-- a Supabase session. Every other sign-in path writes `public.sessions_audit`,
-- and that table's CHECK constraints do not admit this one:
--
--   ck_sessions_audit__auth_method  password | passkey | magic_link | otp | kiosk_pin
--   ck_sessions_audit__event        … | passkey_registered | passkey_used | …
--
-- There are exactly two honest options: label a face login as one of the five
-- existing methods, or extend the list. The first is not an option — the whole
-- point of `auth_method` is that a forensic reader can tell HOW an account was
-- opened, and recording a biometric login as `passkey` would put a false
-- statement into an append-only table that nobody may later correct
-- (`audit.refuse_mutation` allows INSERT only). So ONE value is added:
--
--   auth_method += 'face'   the credential presented was a face descriptor
--
-- AND NO NEW `event` VALUE, WHICH IS ALSO A DECISION. The obvious symmetry with
-- the passkey path would be a `face_used` event beside `passkey_used`. It is not
-- added, for two reasons:
--
--   1. It would carry no information. `passkey_used` is meaningful on its own
--      because a passkey can be presented for step-up without a login;
--      `face-login` only ever verifies a face IN ORDER TO open a session, so
--      `login_success` + `auth_method = 'face'` already states the whole fact.
--   2. It would break a screen. Four files under src/ hardcode the ten-value
--      `event` vocabulary as "the DEPLOYED vocabulary, verbatim", and
--      `src/features/settings/api/security.api.ts` parses the column with a
--      STRICT `z.enum([…])`. An eleventh value would throw in the employee's own
--      Security page for exactly the employees who used the new feature. The
--      `auth_method` column is read as an open `z.string()` by every current
--      consumer, and `signin/analysis.ts` humanises an unrecognised method
--      ("Face") and falls back to "You signed in" — so the value below lands
--      gracefully everywhere, today, with no cross-cutting edit.
--
-- If a future step-up or re-authentication flow ever verifies a face WITHOUT
-- opening a session, that is the moment to add `face_used` — together with the
-- one-line addition to each of those consumers, in the same change.
--
-- THE LOCKOUT COUNTER IS WHY A FAILED FACE LOGIN IS NOT IN THIS TABLE AT ALL.
-- `login_failed` deactivates an account after ten rows. A face descriptor is not
-- a secret: anyone who knows an employee's code can post ten arbitrary vectors,
-- so writing `login_failed` from `face-login` would turn the endpoint into a
-- remote "deactivate any employee" button. Failures are recorded on the audit
-- CHAIN (`public.audit_log`, action `login_failed`) and in
-- `secure.face_match_log` instead — which is where the security console and any
-- DPDP enquiry actually look. Same decision, same reasoning, as
-- `webauthn-login/index.ts`.
--
-- 2. A SINGLE-USE CHALLENGE FOR THE FACE CEREMONY
-- -----------------------------------------------
-- `secure.webauthn_challenges` already is the project's server-issued,
-- single-use, 3-minute, cron-reaped challenge store (the reaper in migration 031
-- deletes by `expires_at` and does not look at `purpose`, so a new purpose needs
-- no new job). `ck_webauthn_challenges__purpose` gains `'face_login'` so the
-- face ceremony gets its own namespace: `webauthn-login` consumes
-- `purpose = 'login'` and can never eat a face challenge, and vice versa.
--
-- A challenge cannot make a biometric a secret — an attacker who once captured a
-- valid descriptor can always ask for a fresh challenge and replay the vector.
-- What it does buy is worth the row: a recorded HTTP body is useless after one
-- use or three minutes, and every attempt must first ask this server for a
-- token, so "one attempt" is enforceable in the database rather than only in a
-- token bucket.
--
-- 3. AN OFF SWITCH THAT DOES NOT NEED A REDEPLOY
-- ----------------------------------------------
-- Face sign-in ships ENABLED (the function is complete, not scaffolding) behind
-- the `face_login` feature flag, so a super_admin can kill it from
-- /admin/settings the moment it misbehaves — `is_enabled = false` or
-- `kill_switch = true` and the endpoint answers 503 on the next request. The
-- flag also acts as an interlock: a project that deployed the function but not
-- this migration has no flag row, reads "disabled", and refuses — which is the
-- correct answer, because without the CHECK changes above it could not record
-- the login it was about to grant.
--
-- Per migration 046's rule ("every flag expires; nothing becomes permanent
-- scaffolding") it carries an expiry.
--
-- SCHEMA FACTS VERIFIED FIRST
-- ---------------------------
--  * Constraint names are exactly `ck_sessions_audit__auth_method`,
--    `ck_sessions_audit__event` and `ck_webauthn_challenges__purpose`
--    (migrations 004 and 012). DROP … IF EXISTS + ADD keeps this re-runnable.
--  * Every existing row satisfies the WIDER list, so the re-ADD validates
--    without a table rewrite. `sessions_audit` is append-only for DML; a CHECK
--    constraint is DDL and is not affected by `audit.refuse_mutation`.
--  * `public.feature_flags` has the partial unique index
--    `uq_feature_flags__key … WHERE deleted_at IS NULL`, so the ON CONFLICT
--    target must name that predicate (migration 031), and `ck_ff__expires`
--    requires any expiry to be before 2100-01-01.
--  * `secure.face_match_log` needs NOTHING here: `kiosk_device_id` and
--    `operator_id` are already nullable and `outcome` already admits
--    'matched' / 'no_match' / 'ambiguous' / 'liveness_failed' / 'low_quality',
--    which is the full set `face-login` writes.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason',
  'migration 20260801012200: record face-authenticated sessions honestly — add auth_method ''face'', the face_login challenge purpose and the face_login kill switch',
  true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. public.sessions_audit — 'face' is a real authentication method
-- -----------------------------------------------------------------------------

ALTER TABLE public.sessions_audit
  DROP CONSTRAINT IF EXISTS ck_sessions_audit__auth_method;
ALTER TABLE public.sessions_audit
  ADD CONSTRAINT ck_sessions_audit__auth_method CHECK (
    auth_method IS NULL OR auth_method IN (
      'password', 'passkey', 'magic_link', 'otp', 'kiosk_pin', 'face'));

-- `ck_sessions_audit__event` is RE-ASSERTED at its documented ten values, not
-- extended. An earlier revision of this file briefly added `face_used` and was
-- pushed to the project before the decision above was taken, so the deployed
-- CHECK is wider than the four src/ consumers that call these ten "the DEPLOYED
-- vocabulary, verbatim". Re-stating the list here converges any database that got
-- the wider version back onto the migrations, which are the source of truth.
-- Narrowing is safe: nothing has ever written an eleventh value (the only writer
-- would have been `face-login`, which does not).
ALTER TABLE public.sessions_audit
  DROP CONSTRAINT IF EXISTS ck_sessions_audit__event;
ALTER TABLE public.sessions_audit
  ADD CONSTRAINT ck_sessions_audit__event CHECK (
    event IN (
      'login_success', 'login_failed', 'logout', 'token_refresh',
      'password_reset_requested', 'password_changed', 'passkey_registered',
      'passkey_used', 'mfa_challenge', 'session_revoked'));

COMMENT ON COLUMN public.sessions_audit.auth_method IS
  'How the session was opened: password | passkey | magic_link | otp | kiosk_pin | face. '
  'Never re-labelled — a face login is recorded as ''face'' so a forensic reader is not misled.';

-- -----------------------------------------------------------------------------
-- 2. secure.webauthn_challenges — a namespace for the face ceremony
-- -----------------------------------------------------------------------------

ALTER TABLE secure.webauthn_challenges
  DROP CONSTRAINT IF EXISTS ck_webauthn_challenges__purpose;
ALTER TABLE secure.webauthn_challenges
  ADD CONSTRAINT ck_webauthn_challenges__purpose CHECK (
    purpose IN ('register', 'login', 'attendance', 'face_login'));

COMMENT ON COLUMN secure.webauthn_challenges.purpose IS
  'register | login (WebAuthn) | attendance (kiosk fingerprint) | face_login (face-login edge fn). '
  'Each purpose is its own namespace: a consumer filters on it, so one ceremony can never spend another''s challenge.';

-- -----------------------------------------------------------------------------
-- 3. The kill switch
-- -----------------------------------------------------------------------------
-- rollout_pct / enabled_for_* are deliberately NOT consulted by the function: a
-- sign-in path must be deterministic, and a 50 % rollout would mean an employee
-- can sign in on one attempt and not the next.

INSERT INTO public.feature_flags
  (key, name, description, is_enabled, rollout_pct, owner, expires_at)
VALUES (
  'face_login',
  'Face sign-in',
  'Employee web sign-in by 1:1 face verification against the enrolled template, '
  || 'via the face-login edge function. Turn off (or trip the kill switch) to force '
  || 'password/passkey sign-in for everyone with no redeploy.',
  true,
  100,
  'platform',
  TIMESTAMPTZ '2027-04-01 00:00:00+05:30')
ON CONFLICT (key) WHERE (deleted_at IS NULL) DO NOTHING;

COMMIT;
