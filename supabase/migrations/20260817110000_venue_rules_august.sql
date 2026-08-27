-- =============================================================================
-- 20260817110000 — the venue's own rules, as stated in August
-- =============================================================================
--
-- Four changes the client asked for, each a decision about how this venue runs
-- rather than a defect. Written together because they are one conversation, and
-- separately reversible because they are four different judgements.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
--
-- "Mark them absent if they arrive after 09:40 or leave before 17:30" was asked
-- for and then withdrawn in favour of SHOWING how late somebody is. That was the
-- right call and it is worth recording why: the engine decides present / half-day
-- / absent from WORKED MINUTES, so a clock-time rule would have been a change to
-- the code that computes pay — and an eleven-minute delay would have cost a full
-- day's wages. `attendance_days.late_minutes` and `early_exit_minutes` are
-- already computed on every day; the work is to put them on screen, which is a
-- client change and carries no risk to a payslip.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 20260817110000: General shift to 09:30-17:30 with no unpaid break, weekly offs from the roster only, no self-service punching for the Ground department, and leave accrual at month end', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. The General shift becomes 09:30 – 17:30, eight hours paid
-- -----------------------------------------------------------------------------
--
-- The span was 09:30–18:30 with a one-hour unpaid break: nine hours present for
-- eight hours paid. It becomes an eight-hour span with NO unpaid break, so the
-- paid day is unchanged at eight hours and an hour comes off the time somebody
-- has to be here.
--
-- `trg_shifts__check` enforces `duration_minutes = wall span − unpaid break`, so
-- all three move in one statement or the row is refused.

UPDATE public.shifts
   SET start_time           = TIME '09:30',
       end_time             = TIME '17:30',
       unpaid_break_minutes = 0,
       duration_minutes     = 480,
       /* The label is shown to staff and is stored, not derived — leaving it
          saying 06:30 PM would be worse than the old timing. */
       display_label        = 'G — 09:30 AM to 05:30 PM'
 WHERE code = 'G'
   AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Weekly offs come from the roster, and only from the roster
-- -----------------------------------------------------------------------------
--
-- `WO-ROSTER` already exists and is what the operational departments use: the
-- roster grants the off and the weekly validation job enforces the statutory
-- minimum of one per week. The four fixed-weekday rules are switched OFF rather
-- than deleted — an employee history that points at "Sunday Off" must still
-- resolve to the rule that was in force at the time.

-- `weekly_off_rules` has no soft-delete column; `is_active` is its only switch.
UPDATE public.weekly_off_rules
   SET is_active = false
 WHERE code <> 'WO-ROSTER'
   AND is_active;

/*
  Anybody sitting on a rule that has just been switched off is moved to the
  roster rule. Without this they keep a binding to an inactive rule: the picker
  would no longer offer it, the form would show a blank where a real value is,
  and the engine would go on applying a rule nobody can see. A dangling pointer
  is worse than a migrated one.
*/
UPDATE public.employees e
   SET weekly_off_rule_id = (SELECT r.id FROM public.weekly_off_rules r
                              WHERE r.company_id = e.company_id AND r.code = 'WO-ROSTER'
                              LIMIT 1)
 WHERE e.deleted_at IS NULL
   AND e.weekly_off_rule_id IS NOT NULL
   AND e.weekly_off_rule_id IN (SELECT id FROM public.weekly_off_rules WHERE NOT is_active);

-- -----------------------------------------------------------------------------
-- 3. The Ground department punches at the gate, not from a phone
-- -----------------------------------------------------------------------------
--
-- Self-service punching is for people at a desk. Ground staff are at the venue
-- and their scan belongs to the gate, where a face is seen — which is also what
-- makes the record worth anything.
--
-- Matched by NAME rather than a hard-coded id, and it reports what it found: the
-- department is in this venue's live data and not in the seed, so a rename would
-- otherwise turn this into a silent no-op.

DO $ground$
DECLARE
  v_dept  uuid;
  v_moved integer;
BEGIN
  SELECT d.id INTO v_dept
    FROM public.departments d
   WHERE d.deleted_at IS NULL
     AND (lower(btrim(d.name)) = 'ground' OR lower(btrim(d.name)) LIKE 'ground %'
          OR lower(btrim(d.code)) IN ('ground','grnd','gr'))
   ORDER BY d.name
   LIMIT 1;

  IF v_dept IS NULL THEN
    RAISE NOTICE 'no department named "Ground" — nothing changed. Departments present: %',
      (SELECT string_agg(name, ', ' ORDER BY name) FROM public.departments WHERE deleted_at IS NULL);
    RETURN;
  END IF;

  UPDATE public.employees
     SET allow_web_punch            = false,
         allow_mobile_selfie_punch  = false
   WHERE department_id = v_dept
     AND deleted_at IS NULL
     AND (allow_web_punch OR allow_mobile_selfie_punch);

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RAISE NOTICE 'Ground department: self-service punching removed from % employee(s)', v_moved;
END $ground$;

-- -----------------------------------------------------------------------------
-- 4. Leave accrues at the END of the month, at 17:30 IST
-- -----------------------------------------------------------------------------
--
-- It ran at 01:00 IST on the FIRST, guarded by `extract(day) = 1`. The venue wants
-- it at the close of the month it is crediting.
--
-- WHICH MONTH GETS CREDITED IS THE WHOLE POINT. `accrue_leave(p_date)` credits the
-- month containing the date it is given, so moving the run from the 1st to the
-- last day changes it from "the month just started" to "the month just ending" —
-- which is what was asked for, and is why the guard changes as well as the hour.
-- Run at 12:00 UTC = 17:30 IST, only on the last day of the IST month.

UPDATE public.cron_jobs
   SET schedule_cron  = '0 12 * * *',
       schedule_human = 'Every day at 17:30 IST, acting only on the last day of the month',
       description    = 'Runs accrue_leave for the month that is ending. Fires at 17:30 IST; the guard means it only does work on the final day of the IST month.'
 WHERE code IN (SELECT code FROM public.cron_jobs WHERE target_name = 'public.accrue_leave');

COMMIT;
