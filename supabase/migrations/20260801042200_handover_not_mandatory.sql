-- =============================================================================
-- 20260801042200 — a named cover is no longer a condition of taking leave
-- =============================================================================
--
-- ASKED FOR: "but don't make mandatory who is covering...".
--
-- WHAT WAS HAPPENING
--
-- `leave_requests_submit_guard` (019 §10) refused any application from somebody in
-- a department flagged `is_operational` unless it named a colleague to cover:
--
--     handover_to_employee_id is mandatory for operational departments
--
-- Every seeded department carries `is_operational = true` (004200), so in practice
-- this applied to everybody — and it fired at SUBMIT, after the form was
-- complete, quoting a column name at the person who filled it.
--
-- The field is not removed. "Who is covering for you" stays on the leave form and
-- is still the right thing to fill in; it is no longer a condition of taking
-- leave. Whether a shift needs cover is a conversation between an employee and
-- their manager, and the manager sees the field on the request either way.
--
-- ── HOW THIS IS WRITTEN, AND WHY IT IS THE WHOLE FUNCTION ────────────────────
--
-- `leave_requests_submit_guard` is one function enforcing twenty rules, and
-- Postgres has no way to remove one branch from it — so the whole body is
-- restated with that branch replaced by a comment saying what used to be there.
-- The text below is 019's version verbatim apart from that block; it was extracted
-- from the migration rather than retyped, so no other rule can have drifted in
-- the copying.
--
-- Nothing else in the schema reads `departments.is_operational` — grep confirms
-- exactly one consumer, which is the branch being removed.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 042200: a named cover is no longer mandatory for leave in an operational department', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.leave_requests_submit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  lt            public.leave_types%ROWTYPE;
  e             public.employees%ROWTYPE;
  v_today       date := util.ist_today();
  v_total       numeric;
  v_self_serve  boolean;
  v_year        integer;
  v_available   numeric;
  v_have_co     numeric;
  v_times       integer;
  v_service_mo  integer;
BEGIN
  IF NOT (NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status = 'draft')) THEN
    RETURN NEW;   -- only the submission transition is validated here
  END IF;

  SELECT * INTO lt FROM public.leave_types WHERE id = NEW.leave_type_id;
  SELECT * INTO e  FROM public.employees   WHERE id = NEW.employee_id;
  v_self_serve := (NEW.employee_id = app.current_employee_id()) AND NOT app.is_admin();

  IF NOT lt.is_active OR lt.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'leave type % is not active', lt.code USING errcode = '23514';
  END IF;

  -- Structural checks (everyone).
  IF NEW.portion <> 'full_day' AND NOT lt.allow_half_day THEN
    RAISE EXCEPTION 'leave type % does not allow half days', lt.code USING errcode = '23514';
  END IF;
  IF lt.gender_restriction IS NOT NULL AND e.gender IS DISTINCT FROM lt.gender_restriction THEN
    RAISE EXCEPTION 'leave type % is restricted to % employees', lt.code, lt.gender_restriction
      USING errcode = '23514';
  END IF;
  IF lt.applies_to_employment_types IS NOT NULL
     AND NOT (e.employment_type = ANY (lt.applies_to_employment_types)) THEN
    RAISE EXCEPTION 'leave type % does not apply to % employees', lt.code, e.employment_type
      USING errcode = '23514';
  END IF;

  -- Recompute the day expansion from NEW values; totals are never client-set.
  v_total := public.rebuild_leave_request_days(
    NEW.id, NEW.employee_id, NEW.leave_type_id, NEW.from_date, NEW.to_date, NEW.portion, 'pending');
  NEW.total_days  := v_total;
  IF lt.is_paid THEN
    NEW.unpaid_days := LEAST(COALESCE(NEW.unpaid_days, 0), v_total);
    NEW.paid_days   := v_total - NEW.unpaid_days;
  ELSE
    NEW.paid_days   := 0;
    NEW.unpaid_days := v_total;
  END IF;

  IF v_total < lt.min_days_per_request THEN
    RAISE EXCEPTION 'request is % day(s); leave type % requires at least %',
      v_total, lt.code, lt.min_days_per_request USING errcode = '23514';
  END IF;
  IF lt.max_days_per_request IS NOT NULL AND v_total > lt.max_days_per_request THEN
    RAISE EXCEPTION 'request is % day(s); leave type % allows at most % per request',
      v_total, lt.code, lt.max_days_per_request USING errcode = '23514';
  END IF;
  IF lt.max_consecutive_days IS NOT NULL AND v_total > lt.max_consecutive_days THEN
    RAISE EXCEPTION 'request is % consecutive day(s); leave type % allows at most %',
      v_total, lt.code, lt.max_consecutive_days USING errcode = '23514';
  END IF;

  -- Venue rules (everyone): named cover for operational departments; contact
  -- address for long leaves (§3.7).
  /*
    THE HANDOVER RULE IS GONE — asked for directly: "don't make mandatory who is
    covering". It used to raise here:

        IF NEW.handover_to_employee_id IS NULL
           AND EXISTS (… d.is_operational) THEN
          RAISE EXCEPTION 'handover_to_employee_id is mandatory for operational
                           departments'

    which refused the whole application AFTER the employee had filled it in, and
    named a column at them while doing it. The field stays on the form and is
    still worth filling — a named cover is how a shift gets covered — it is simply
    no longer a condition of taking leave.

    `departments.is_operational` now has NO consumer anywhere in the schema. It is
    left in place rather than dropped: the column is a true fact about a
    department, and the next rule that needs it should not have to add it back.
  */
  IF v_total > 7 AND NULLIF(btrim(COALESCE(NEW.address_during_leave, '')), '') IS NULL THEN
    RAISE EXCEPTION 'address_during_leave is required for leave longer than 7 days'
      USING errcode = '23514';
  END IF;

  -- Policy-rule checks (self-service only; HR/admin/system entries bypass).
  IF v_self_serve THEN
    IF NEW.from_date < v_today AND (v_today - NEW.from_date) > lt.max_backdated_days THEN
      RAISE EXCEPTION 'leave type % may be backdated at most % day(s)',
        lt.code, lt.max_backdated_days USING errcode = '23514';
    END IF;
    IF NEW.from_date >= v_today AND (NEW.from_date - v_today) < lt.min_notice_days THEN
      RAISE EXCEPTION 'leave type % requires % day(s) notice', lt.code, lt.min_notice_days
        USING errcode = '23514';
    END IF;
    IF e.employment_status = 'on_probation' AND NOT lt.availing_allowed_during_probation THEN
      RAISE EXCEPTION 'leave type % cannot be availed during probation', lt.code
        USING errcode = '23514';
    END IF;
    IF lt.min_service_months > 0 THEN
      v_service_mo := (EXTRACT(YEAR  FROM age(NEW.from_date, e.date_of_join)) * 12
                     + EXTRACT(MONTH FROM age(NEW.from_date, e.date_of_join)))::integer;
      IF e.date_of_join IS NULL OR v_service_mo < lt.min_service_months THEN
        RAISE EXCEPTION 'leave type % requires % month(s) of service', lt.code, lt.min_service_months
          USING errcode = '23514';
      END IF;
    END IF;
    IF lt.max_times_in_service IS NOT NULL THEN
      SELECT count(*) INTO v_times
        FROM public.leave_requests lr
       WHERE lr.employee_id = NEW.employee_id
         AND lr.leave_type_id = NEW.leave_type_id
         AND lr.id <> NEW.id
         AND lr.status IN ('approved','partially_approved');
      IF v_times >= lt.max_times_in_service THEN
        RAISE EXCEPTION 'leave type % may be availed at most % time(s) in service',
          lt.code, lt.max_times_in_service USING errcode = '23514';
      END IF;
    END IF;
  END IF;

  -- Balance gate: the spendable figure is available_after_pending (§3.7).
  IF lt.is_comp_off THEN
    SELECT COALESCE(SUM(COALESCE(c.days_remaining, c.days)), 0) INTO v_have_co
      FROM public.comp_off_ledger c
     WHERE c.employee_id = NEW.employee_id
       AND c.entry_type = 'earned'
       AND c.status IN ('available','partially_used')
       AND (c.expires_on IS NULL OR c.expires_on >= NEW.from_date);
    IF NEW.paid_days > v_have_co THEN
      RAISE EXCEPTION 'insufficient comp-off balance: need %, have % unexpired day(s)',
        NEW.paid_days, v_have_co USING errcode = '23514';
    END IF;
  ELSIF lt.is_paid AND NOT lt.is_system_managed THEN
    v_year := public.leave_year_of(NEW.from_date);
    PERFORM public.recompute_leave_balance(NEW.employee_id, NEW.leave_type_id, v_year);
    SELECT lb.available_after_pending INTO v_available
      FROM public.leave_balances lb
     WHERE lb.employee_id = NEW.employee_id
       AND lb.leave_type_id = NEW.leave_type_id
       AND lb.leave_year = v_year;
    v_available := COALESCE(v_available, 0);
    -- The CASE must be parenthesised: plpgsql's IF parser terminates its
    -- condition at the first THEN token, which would otherwise be the CASE's.
    IF NEW.paid_days > v_available + (CASE WHEN lt.allow_negative_balance THEN lt.max_negative_days ELSE 0 END) THEN
      RAISE EXCEPTION
        'insufficient % balance: need % paid day(s), % available — reduce days or mark the overflow as unpaid (LWP)',
        lt.code, NEW.paid_days, v_available USING errcode = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.leave_requests_submit_guard() IS
  'Validates the draft -> pending transition and enforces the leave_types rulebook. The operational-department handover requirement was removed in 042200: a named cover is offered, not demanded.';

COMMIT;
