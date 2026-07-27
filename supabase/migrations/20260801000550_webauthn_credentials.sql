-- =============================================================================
-- Migration 004b — webauthn_credentials (passkeys / platform fingerprints)
-- Source: docs/plan/04-data-model.md §3.1 (lines 572–594).
--
-- Gap-fill: §3.1's fifth table, missed by migration 004. Passkeys serve login
-- AND the alternative attendance biometric. Registration/verification happen
-- exclusively in the webauthn-register / webauthn-login / kiosk-punch edge
-- functions against server-issued challenges (secure.webauthn_challenges,
-- migration 012) — the client never writes here. Removal is an UPDATE of
-- revoked_at through an RPC, never a DELETE.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  credential_id   text NOT NULL,
  public_key      text NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0,
  transports      text[],
  aaguid          text,
  device_label    text,
  purpose         text NOT NULL DEFAULT 'login',
  backup_eligible boolean NOT NULL DEFAULT false,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_wc__purpose CHECK (purpose IN ('login', 'attendance', 'both'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webauthn_credentials__credential_id
  ON public.webauthn_credentials (credential_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials__profile
  ON public.webauthn_credentials (profile_id);

CREATE TRIGGER trg_webauthn_credentials__stamp BEFORE INSERT ON public.webauthn_credentials
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_webauthn_credentials__touch BEFORE UPDATE ON public.webauthn_credentials
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;

-- P1 select-self (see and revoke your own passkeys); admin visibility for the
-- security console; NO client insert/update — the edge functions hold the pen.
DROP POLICY IF EXISTS webauthn_credentials__self_read ON public.webauthn_credentials;
CREATE POLICY webauthn_credentials__self_read ON public.webauthn_credentials
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS webauthn_credentials__admin_read ON public.webauthn_credentials;
CREATE POLICY webauthn_credentials__admin_read ON public.webauthn_credentials
  FOR SELECT TO authenticated
  USING (app.is_admin());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.webauthn_credentials TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.webauthn_credentials TO service_role;
  END IF;
END $$;

COMMIT;
