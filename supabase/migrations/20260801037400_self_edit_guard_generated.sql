-- =============================================================================
-- 079 · employees_self_edit_guard: stop a GENERATED column refusing every
--       self-edit, and let an employee own their face sign-in switch
--
-- THE BUG, WHICH IS OLDER THAN THIS FEATURE
--
-- `public.employees.confirmation_due_date` is GENERATED ALWAYS AS
-- ((date_of_join + make_interval(months => probation_months))::date).
--
-- In a BEFORE UPDATE trigger a generated column is NOT yet computed: `NEW` carries
-- NULL for it while `OLD` carries the stored date. The guard compared every key of
-- to_jsonb(NEW) against to_jsonb(OLD), so `confirmation_due_date` read as CHANGED on
-- every single update — and being absent from the self-editable whitelist, it raised.
--
-- The consequence was not subtle. An employee editing `about`, `photo_path`,
-- `cover_photo_path` or `food_preference` — the four columns the whitelist exists to
-- permit — was refused with
--
--     self_edit_not_allowed: change confirmation_due_date through a profile change request
--
-- naming a column they had not touched and cannot see. The whitelist has therefore
-- never worked: ALL employee self-service profile editing was blocked. Proven against
-- this database by PATCHing `about` as a real employee and getting a 403.
--
-- THE FIX
--
-- Exclude generated columns from the comparison. They are not writable by anybody —
-- Postgres itself rejects an attempt — so a generated column can never be the change
-- a guard needs to refuse. `TG_RELID` is used rather than a hardcoded table so the
-- rule stays correct if the guard is ever reused, and so adding another generated
-- column later cannot resurrect this.
--
-- `search_path = ''` is preserved from the original. `pg_catalog` is always searched
-- implicitly, so `pg_attribute`, `to_jsonb` and `array_agg` resolve; everything else
-- stays schema-qualified.
--
-- AND ONE ADDITION TO THE WHITELIST
--
-- `allow_face_login` becomes self-editable. It is a preference about the reader's OWN
-- sign-in credential — the same category as choosing to register a passkey — not an
-- HR-verified fact like a date of birth or a bank account. Nobody needs to approve
-- somebody deciding not to use their face to log in, and routing it through a profile
-- CHANGE REQUEST would mean an employee could not turn off their own biometric
-- sign-in without waiting for an approver. That is the wrong way round for a
-- credential.
--
-- The manager and admin paths do not rely on this: they are not the subject, so the
-- guard's `NEW.profile_id = app.ctx_actor_id()` branch never fires for them.
-- =============================================================================

SELECT set_config('app.reason', 'migration', true);

CREATE OR REPLACE FUNCTION public.employees_self_edit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_allowed text[] := ARRAY[
    'about', 'photo_path', 'cover_photo_path', 'food_preference',
    -- The reader's own sign-in preference — see this migration's header.
    'allow_face_login',
    'updated_at', 'updated_by', 'profile_completeness_pct', 'search_tsv'];
  v_changed text[];
BEGIN
  IF NEW.profile_id IS NOT NULL
     AND NEW.profile_id = app.ctx_actor_id()
     AND NOT app.is_admin() THEN
    SELECT array_agg(k) INTO v_changed
    FROM (
      SELECT jsonb_object_keys(to_jsonb(NEW)) AS k
    ) keys
    WHERE (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k)
      AND k <> ALL (v_allowed)
      /*
        GENERATED columns are unset in NEW during a BEFORE trigger, so they always
        compare as changed. They are also not writable by anybody, which means a
        generated column can never be the edit this guard exists to refuse — so
        excluding it removes a false positive without weakening the check.
      */
      AND NOT EXISTS (
        SELECT 1
          FROM pg_attribute a
         WHERE a.attrelid = TG_RELID
           AND a.attname = k
           AND a.attgenerated <> ''
      );
    IF v_changed IS NOT NULL THEN
      RAISE EXCEPTION 'self_edit_not_allowed: change % through a profile change request',
        array_to_string(v_changed, ', ') USING errcode = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.employees_self_edit_guard() IS
  'When the actor IS the subject and not an admin, only the self-editable whitelist may change. GENERATED columns are excluded from the comparison: they are unset in NEW during a BEFORE trigger and are not writable by anyone, so before migration 079 confirmation_due_date read as changed on every update and refused every self-edit — including the whitelisted ones.';
