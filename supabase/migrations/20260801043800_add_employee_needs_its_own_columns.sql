-- =============================================================================
-- 20260801043800 — the Add Employee wizard collects six columns it may not write
-- =============================================================================
--
-- REPORTED FROM PRODUCTION: a SUPER-ADMIN pressing "Create employee" is told
--
--     "You do not have permission to make this change. Ask a super admin if you
--      believe you should."
--
-- which is a confusing thing to read when you ARE the super admin. Their role was
-- never the problem.
--
-- ── WHAT IS ACTUALLY HAPPENING ──────────────────────────────────────────────
--
-- Two separate mechanisms guard this table and only one of them was satisfied.
--
--   1. RLS — `employees__admin_insert` is `WITH CHECK (app.is_admin())`, and for
--      Suraj that passes.
--   2. COLUMN PRIVILEGES — 005100 granted INSERT on a NAMED LIST of 51 columns.
--      Postgres refuses an INSERT that touches any column outside it, with
--      SQLSTATE 42501, which the client renders as the sentence above.
--
-- The wizard collects 48 columns. SIX of them are not in that list:
--
--     allow_web_punch, allow_mobile_selfie_punch, restrict_punch_to_venue_ip,
--     exclude_from_attendance, attendance_regularize_from, confirmed_on
--
-- The first five are the wizard's "How this person punches" step — visible on the
-- review screen in the report, showing "Web punch from that device — No". They are
-- sent on every creation, so EVERY creation through the wizard has been refused
-- since 005100 shipped. It is not specific to one admin, and no amount of role
-- granting would have fixed it.
--
-- The venue's 81 existing employees came in through service_role — the seed and
-- the bulk import — which holds table-wide grants and never met this.
--
-- ── WHY GRANT RATHER THAN STOP SENDING THEM ─────────────────────────────────
--
-- These are legitimate creation-time facts. Whether somebody may punch from their
-- phone is decided when they are hired, not edited in afterwards, and the wizard
-- asks precisely because the answer differs between a manager and a kitchen hand.
-- Dropping them from the payload would move the problem to "why did the toggle I
-- set not stick".
--
-- ── WHAT IS DELIBERATELY STILL NOT GRANTED ──────────────────────────────────
--
-- The other eight columns without an INSERT grant stay that way, because none of
-- them is a fact about somebody being HIRED:
--
--     exit_type, exit_reason, resignation_date, last_working_day,
--     full_and_final_settled_on, is_rehire_eligible  — an exit, and one that
--       `employee_lifecycle_events` is supposed to write rather than a form.
--     exclude_from_payroll   — a payroll decision, made on the payroll screens.
--     primary_bank_account_id — a foreign key to a bank account that cannot
--       exist yet, since the employee it belongs to is being created by this very
--       statement.
--
-- Granting the full table would have closed the report in one line and quietly
-- undone the reason 005100 enumerated columns at all.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 043800: grant INSERT on the six employees columns the Add Employee wizard collects but 005100 omitted, which refused every creation with a permission error', true);
SELECT set_config('app.source', 'migration', true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    /*
      Additive. A column-level GRANT accumulates, so this neither restates nor
      disturbs the 51 columns 005100 already permits — and re-running it is a
      no-op rather than a reset.
    */
    GRANT INSERT (
      allow_web_punch,
      allow_mobile_selfie_punch,
      restrict_punch_to_venue_ip,
      exclude_from_attendance,
      attendance_regularize_from,
      confirmed_on
    ) ON public.employees TO authenticated;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assert it, rather than trusting the GRANT above
-- -----------------------------------------------------------------------------
--
-- The bug being fixed was invisible for months precisely because nothing checked
-- that the grant matched what the form sends. This states the six by name so a
-- future column-list edit that drops one fails HERE, loudly, instead of in a
-- dialog in front of somebody trying to hire a chef.

DO $verify$
DECLARE
  v_missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE 'no authenticated role in this database — grant assertion skipped';
    RETURN;
  END IF;

  SELECT string_agg(c.col, ', ') INTO v_missing
    FROM (VALUES
      ('allow_web_punch'), ('allow_mobile_selfie_punch'),
      ('restrict_punch_to_venue_ip'), ('exclude_from_attendance'),
      ('attendance_regularize_from'), ('confirmed_on')
    ) AS c(col)
   WHERE NOT has_column_privilege('authenticated', 'public.employees', c.col, 'INSERT');

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 043800: authenticated still cannot INSERT: %', v_missing;
  END IF;

  RAISE NOTICE 'migration 043800: the Add Employee wizard can now write every column it collects';
END $verify$;

COMMIT;
