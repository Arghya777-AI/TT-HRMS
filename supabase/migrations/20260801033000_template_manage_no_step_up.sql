-- =============================================================================
-- Migration 071 — let an admin activate the capture they just took.
--
-- WHY, IN THE CLIENT'S WORDS
-- --------------------------
-- "When it is happening from admin, then it is already approved, right? Where are
--  the approvals coming from? There is no clear notification on that."
--
-- Both halves of that are correct, and the second is the sharper point.
--
-- WHAT THE APPROVAL STEP ACTUALLY WAS
-- -----------------------------------
-- `face-enrol` writes every template `is_active = false` and returns
-- `status: 'pending_approval'` — for BOTH paths, the admin one and the kiosk one,
-- with no distinction. Activating it needs `face-template-admin op=approve`, which
-- requires `biometric.template.manage`, which requires step-up.
--
-- And `approve` contains NO self-approval check: the same admin who captured can
-- approve their own capture. So the "second pair of eyes" was not a two-person
-- rule at all — it was one extra click, by the same person, plus an MFA prompt
-- that an admin without an authenticator cannot satisfy. Meanwhile nothing
-- notifies anybody that a template is waiting, so captures simply sat inactive
-- (TT0007 and TT0008 were in exactly that state when this was written) and the
-- face silently did not work at the gate.
--
-- A control that the actor can satisfy alone, that nobody is told about, and that
-- blocks the happy path is not a control. It is a bug with a security-sounding
-- name.
--
-- WHAT THIS CHANGES
-- -----------------
-- `biometric.template.manage` no longer requires step-up, so the console can
-- activate a capture in the same action that took it. The capability is unchanged
-- and still admin-only; RLS, the mandatory audit reason, and every other gate stay
-- exactly as they were.
--
-- WHAT STILL PROTECTS THE TEMPLATE — all of it measured, none of it a click:
--   * only an admin holds `biometric.enrol` and `biometric.template.manage`;
--   * consent must exist, un-withdrawn, for the current notice version;
--   * the anti-cross-enrolment scan refuses a face already belonging to somebody
--     else (`FACE_DUPLICATE_IDENTITY`);
--   * the samples must agree with each other (`cohesionReject`, 0.35);
--   * the template must clear `minTemplateQuality` (0.70);
--   * every write is audited with a reason and the previous version is retired,
--     not overwritten, so an enrolment can always be traced and undone.
--
-- STILL super_admin AND still step-up: `biometric.template.purge`. Erasing
-- biometric data is irreversible and is the one operation here where a stolen
-- session is the threat model.
--
-- REVERSIBLE:
--   UPDATE public.role_capabilities SET requires_step_up = true
--    WHERE capability = 'biometric.template.manage';
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 071: admin can activate a face capture in one action; the approval step was self-satisfiable, unnotified and blocking', true);
SELECT set_config('app.source', 'migration', true);

UPDATE public.role_capabilities
   SET requires_step_up = false
 WHERE capability = 'biometric.template.manage';

DO $verify$
DECLARE
  v_rows  integer;
  v_still integer;
  v_purge integer;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.role_capabilities WHERE capability = 'biometric.template.manage';
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'migration 071: biometric.template.manage is not seeded';
  END IF;

  SELECT count(*) INTO v_still
    FROM public.role_capabilities
   WHERE capability = 'biometric.template.manage' AND requires_step_up;
  IF v_still > 0 THEN
    RAISE EXCEPTION 'migration 071: % row(s) still require step-up', v_still;
  END IF;

  -- The purge must NOT have been loosened by this migration.
  SELECT count(*) INTO v_purge
    FROM public.role_capabilities
   WHERE capability = 'biometric.template.purge' AND requires_step_up;
  IF v_purge = 0 THEN
    RAISE EXCEPTION 'migration 071: biometric.template.purge lost its step-up requirement — refusing';
  END IF;

  RAISE NOTICE 'migration 071: template.manage no longer needs step-up; purge still does';
END
$verify$;

COMMIT;
