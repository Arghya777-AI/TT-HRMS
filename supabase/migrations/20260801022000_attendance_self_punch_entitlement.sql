-- =============================================================================
-- Migration 20260801022000 — switch ON employee self-punch, and give the
-- `attendance-self-punch` edge function the configuration it reads.
--
-- WHAT THE CLIENT ASKED FOR
-- -------------------------
-- "When the employee is giving attendance / trying to log in for the day, there
-- will be a Login button in their portal. They click Login, show their face, the
-- face is recognized, location is registered, and attendance is taken. Same goes
-- for the outward also."
--
-- Every piece of schema that needs already exists: `public.punch_source` has
-- 'web' and 'mobile'; `attendance_punches` already carries lat/lng/
-- location_accuracy_m/geofence_ok/ip/user_agent/device_id/match_distance/
-- match_confidence/face_match_log_id/needs_review; `role_capabilities` already
-- seeds ('employee','attendance.punch.web'); `public.employees` already has
-- `allow_web_punch` and `allow_mobile_selfie_punch`; `public.locations` already
-- has `geofence_radius_m NOT NULL DEFAULT 300`. So this migration adds NO
-- columns, NO tables, NO functions and NO enum values. It does exactly two
-- things: it turns the per-employee entitlement ON for the demo staff, and it
-- writes down the numbers the function currently only has as fallbacks.
--
-- 1. WHY THE ENTITLEMENT IS A DATA CHANGE, NOT A DEFAULT
-- ------------------------------------------------------
-- `employees.allow_web_punch` is `NOT NULL DEFAULT false`, and it stays that way.
-- Self-punch is the one attendance channel with no second person on the scene —
-- no guard, no tablet, no gate — so "who may use it" has to be an explicit,
-- per-person, auditable decision by HR rather than something every new joiner
-- silently inherits. This migration flips it for the SEEDED DEMO STAFF ONLY, and
-- it is guarded by `settings.seed_demo_data`: on a production project that flag
-- is false and the whole block is a no-op, exactly like migration 047.
--
-- `restrict_punch_to_venue_ip` is deliberately NOT touched. It is HR's stated
-- intent about a person and it is not this migration's to reinterpret; §2 below
-- is what makes it safe to leave alone.
--
-- 2. THE SETTINGS, AND WHY EACH ONE IS HERE
-- -----------------------------------------
-- `app.setting()` returns NULL for an absent key and every reader falls back to a
-- documented constant, so nothing here CHANGES behaviour today. What it changes
-- is that the numbers become visible and administrable in /admin/settings instead
-- of living only inside a Deno bundle.
--
--   kiosk.descriptor_model                     'faceapi-rn34-128d-v1'
--       Already read by `face-enrol` and `face-login`, and never seeded — both
--       default to this exact string, so writing it down is behaviour-preserving
--       and makes a future model upgrade a data change plus a redeploy rather
--       than a hunt through three files.
--
--   attendance.face_review_threshold           0.38
--       spec-kiosk §3.3 `T_review`. `face-login` already reads this key with the
--       same default. `attendance-self-punch` reads it as its ACCEPT CEILING: a
--       1:1 confirmation has no runner-up, so there is no margin to lean on and
--       the distance ceiling has to carry the decision alone. Lowering this value
--       makes both face sign-in and self-punch stricter; raising it above ~0.5
--       would start admitting lookalikes and is why the row is super-admin only.
--
--   attendance.liveness_pass_threshold         0.70
--       spec-kiosk §1.2. Same key `face-login` already reads, same default.
--
--   attendance.face_punch_min_detection_score  0.60
--       spec-kiosk §1.1, scan column. Named to sit beside
--       `attendance.face_enrol_min_detection_score`, which `face-enrol` reads:
--       enrolment demands a better capture than a punch does, so the two gates
--       are two keys on purpose and must not be collapsed into one.
--
--   attendance.venue_ip_cidrs                  []   (EMPTY — not enforced)
--       `employees.restrict_punch_to_venue_ip` is `NOT NULL DEFAULT true` on
--       every row, and until now NOTHING read it, because the venue's networks
--       are written down nowhere: `allowed_ip_cidrs` exists only on
--       `kiosk_devices`. This is that missing list. It is seeded EMPTY, which the
--       function reads as "not configured, not enforced" — the same decision
--       migration 046 records for the kiosk geofence ("venue lat/lng are captured
--       on site; geofence_ok is recorded, not enforced, until then"). When ops
--       fills it in, a self-punch from outside those networks is FLAGGED
--       (`needs_review = true`), never refused: losing the punch would be a person
--       who cannot prove they came to work. Editable by an admin because it is an
--       ops fact, not a security threshold. `value_kind = 'json'`: a JSON array of
--       address or CIDR strings, e.g. ["49.207.0.0/16","2405:201::/32"]. A
--       malformed value degrades to "not evaluated" in the function rather than
--       blocking attendance.
--
-- Values are `scope='company'` + `company_id = TT` so the partial unique index
-- `uq_settings__key_scope (company_id, key, scope, coalesce(scope_id, zero-uuid))`
-- makes the seed idempotent — a NULL `company_id` would never conflict on re-run,
-- which is the trap migration 046's header calls out.
--
-- SCHEMA FACTS VERIFIED FIRST (against migrations, not memory)
-- -----------------------------------------------------------
--   * `ck_settings__group` admits 'attendance' and 'kiosk'; `ck_settings__value_kind`
--     admits 'number', 'string' and 'json'. Every row below is inside both.
--   * `public.employees` is in `audit.reason_required_tables` (migration 038 §57),
--     so `trg_employees__audit` demands `app.reason` ≥ 10 characters on UPDATE.
--     It is set below, together with `app.source = 'migration'` — 'migration' is a
--     real member of `public.actor_source`.
--   * `allow_web_punch` is an ordinary boolean column with no trigger of its own;
--     the only trigger the UPDATE fires besides the audit chain is
--     `trg_employees__touch` (util.touch_row).
--   * `settings` seeds are matched on `companies.code = 'TT'`, which is how every
--     seed migration from 042 onward resolves the company.
-- =============================================================================

BEGIN;

-- Reason/source context for audit.log_changes(): public.employees is in
-- audit.reason_required_tables and demands a reason on UPDATE.
SELECT set_config(
  'app.reason',
  'migration 20260801022000: enable employee self-punch (attendance.punch.web) for the seeded demo staff and record the face/venue thresholds the attendance-self-punch function reads',
  true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Settings the attendance-self-punch function reads
-- -----------------------------------------------------------------------------
INSERT INTO public.settings
  (company_id, key, value, value_kind, scope, group_name, label,
   is_sensitive, is_editable_by_admin)
SELECT c.id, v.key, v.value::jsonb, v.kind, 'company', v.grp, v.label,
       false, v.editable
FROM public.companies c
CROSS JOIN (VALUES
  ('kiosk.descriptor_model',                    '"faceapi-rn34-128d-v1"', 'string', 'kiosk',
   'Face descriptor model enrolment and matching must agree on',                        false),
  ('attendance.face_review_threshold',          '0.38',   'number', 'attendance',
   'Face match: maximum distance accepted without review (T_review)',                   false),
  ('attendance.liveness_pass_threshold',        '0.70',   'number', 'attendance',
   'Face match: minimum passive liveness score',                                        false),
  ('attendance.face_punch_min_detection_score', '0.60',   'number', 'attendance',
   'Self-punch: minimum face detector confidence for a usable capture',                 false),
  ('attendance.venue_ip_cidrs',                 '[]',     'json',   'attendance',
   'Venue networks for restrict_punch_to_venue_ip (empty = recorded, not enforced)',    true)
) AS v(key, value, kind, grp, label, editable)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, key, scope,
             coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Turn the entitlement ON for the seeded demo staff
-- -----------------------------------------------------------------------------
-- Guarded exactly as migration 047 is: with settings.seed_demo_data false this
-- block writes nothing and says so. Only employees who could actually produce a
-- punch are touched — `exclude_from_attendance` employees have no attendance to
-- mark (compute_attendance_day returns NULL for them) and the statuses excluded
-- here are the ones the function itself refuses, so granting them the flag would
-- be granting a permission that can never be exercised.
DO $self_punch$
DECLARE
  v_enabled  boolean;
  v_company  uuid;
  v_granted  integer := 0;
BEGIN
  IF to_regclass('public.settings') IS NULL THEN
    RAISE NOTICE 'self-punch entitlement skipped: public.settings does not exist';
    RETURN;
  END IF;

  SELECT (s.value #>> '{}')::boolean INTO v_enabled
  FROM public.settings s
  WHERE s.key = 'seed_demo_data'
  ORDER BY (s.scope = 'company') DESC
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RAISE NOTICE 'self-punch entitlement skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  SELECT id INTO v_company
  FROM public.companies WHERE code = 'TT' AND deleted_at IS NULL;

  IF v_company IS NULL THEN
    RAISE NOTICE 'self-punch entitlement skipped: company TT not present';
    RETURN;
  END IF;

  -- Plain UPDATE + GET DIAGNOSTICS rather than a data-modifying CTE with
  -- SELECT … INTO: the row count is what is wanted and this form cannot be
  -- misread by plpgsql's INTO handling.
  UPDATE public.employees e
     SET allow_web_punch = true
   WHERE e.company_id = v_company
     AND e.deleted_at IS NULL
     AND e.allow_web_punch = false
     AND e.exclude_from_attendance = false
     AND e.employment_status IN (
           'active', 'on_probation', 'confirmed', 'on_notice', 'rehired',
           'on_long_leave', 'absconding');
  GET DIAGNOSTICS v_granted = ROW_COUNT;

  RAISE NOTICE 'self-punch entitlement: allow_web_punch turned on for % employee(s)', v_granted;

  -- allow_mobile_selfie_punch is left OFF on purpose. The function's entitlement
  -- gate is `allow_web_punch OR allow_mobile_selfie_punch`, so a phone browser
  -- already works for these employees (recorded with source = 'mobile', which is
  -- the truth about the device). The two flags are not enforced per-channel
  -- because the only thing that distinguishes the channels is the User-Agent,
  -- which the caller controls — see the function header. The `mobile_selfie_punch`
  -- feature flag from migration 046 stays off; it belongs to the native selfie
  -- flow, not to this one.
END $self_punch$;

COMMIT;
