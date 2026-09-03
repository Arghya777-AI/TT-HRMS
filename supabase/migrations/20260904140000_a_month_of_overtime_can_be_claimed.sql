-- ============================================================================
-- A month of overtime can be claimed, and somebody has to approve it.
--
-- ── WHAT THE VENUE ASKED FOR ────────────────────────────────────────────────
-- "If they have completed one month attendance, and there are certain days where
--  they have worked extra — it should show summarised, whatever the extra work is.
--  Can they download that and submit it to me saying, okay, the overtime I want to
--  claim? For that they have to give me proofs — I have attended this meeting,
--  screenshot or something. It should come as an approval to me." And on what
--  happens next: "either you can be compensated, or you can keep it and carry
--  forward, and we can give it as a compensatory off."
--
-- ── WHY THE EXISTING OVERTIME TABLE DOES NOT FIT ────────────────────────────
-- `overtime_preapprovals` is per-DATE with `expected_hours`: permission asked for
-- BEFORE working late. This is the opposite direction — a month's surplus already
-- worked, claimed after the fact — and squeezing both into one table would make
-- every reader ask which kind a row was. It has 0 rows and is left alone.
--
-- ── THE FIGURE IS THE SERVER'S, NEVER THE CLIENT'S ──────────────────────────
-- `submit_overtime_claim` takes a month and a compensation mode. It does NOT take a
-- number of minutes. The claimable figure is summed from `attendance_days` inside
-- the function, so a claim cannot assert hours the engine never credited — which is
-- the whole reason an approver would otherwise have to verify by hand, the thing HR
-- explicitly said they did not want to do.
--
-- ── AND A DAY WITH AN UNAPPROVED PUNCH IS NOT CLAIMABLE YET ─────────────────
-- `overtime_minutes` is derived from `payable_worked_minutes`, which includes
-- minutes still awaiting a punch decision. Letting those into a claim would ask an
-- administrator to approve payment for hours they have not yet accepted as worked —
-- the same decision twice, in the wrong order.
--
-- So a day carrying `pending_approval_minutes > 0` is EXCLUDED and reported
-- separately as `withheld_minutes`, with the reason stated on the claim. Approve the
-- punches first; the hours then become claimable next time.
-- ============================================================================

SELECT set_config('app.reason',
  'a month of credited overtime can be claimed for payment or comp-off, with the figure computed server-side and days holding unapproved punches excluded',
  true);

-- ---------------------------------------------------------------------------
-- 1. The claim
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.overtime_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,

  /* The first of the month claimed. One claim per employee per month. */
  period_month  date NOT NULL,

  /*
    What the engine had credited when this was filed, and what it was withholding.
    Both stored: the claim has to remain explicable months later, when the days
    behind it may have been recomputed.
  */
  claimed_minutes  integer NOT NULL,
  withheld_minutes integer NOT NULL DEFAULT 0,

  /* "Either you can be compensated, or we can give it as a compensatory off." */
  compensation  text NOT NULL,

  reason        text NOT NULL,

  status        public.approval_status NOT NULL DEFAULT 'pending',
  approval_request_id uuid REFERENCES public.approval_requests(id),
  decided_by    uuid REFERENCES public.profiles(id),
  decided_at    timestamptz,
  decided_comment text,
  /* Set when the decision has actually taken effect — comp-off credited, or the
     minutes marked for payroll. Never a synonym for `decided_at`. */
  applied_at    timestamptz,
  comp_off_ledger_id uuid REFERENCES public.comp_off_ledger(id),

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES public.profiles(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES public.profiles(id),

  CONSTRAINT ck_otc__month      CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT ck_otc__minutes    CHECK (claimed_minutes > 0 AND withheld_minutes >= 0),
  CONSTRAINT ck_otc__mode       CHECK (compensation IN ('paid', 'comp_off')),
  /* Long enough to say what the extra work was. The same floor the off-hours punch
     reason uses, for the same reason: somebody reads this months later. */
  CONSTRAINT ck_otc__reason     CHECK (length(btrim(reason)) >= 15)
);

/* One live claim per employee per month. A withdrawn or rejected one may be refiled. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_otc__live_per_month
  ON public.overtime_claims (employee_id, period_month)
  WHERE status IN ('pending', 'in_progress', 'escalated', 'approved');

CREATE INDEX IF NOT EXISTS ix_otc__employee ON public.overtime_claims (employee_id, period_month DESC);

COMMENT ON TABLE public.overtime_claims IS
  'A month of credited overtime claimed for payment or comp-off. claimed_minutes is summed from attendance_days by submit_overtime_claim, never supplied by the caller. Days with unapproved punches are excluded and reported as withheld_minutes.';

-- ---------------------------------------------------------------------------
-- 2. What a month actually offers
-- ---------------------------------------------------------------------------
/*
  Readable by the employee for themselves and by an administrator in scope, so the
  screen that offers the claim and the function that files it agree by construction —
  the figure is computed in one place and read in both.
*/
CREATE OR REPLACE FUNCTION public.overtime_claimable(p_employee_id uuid, p_month date)
RETURNS TABLE (
  period_month      date,
  claimable_minutes integer,
  withheld_minutes  integer,
  days_with_overtime integer,
  days_withheld     integer,
  already_claimed   boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- RLS on attendance_days decides whose month this is
SET search_path TO ''
AS $fn$
  WITH m AS (SELECT date_trunc('month', p_month)::date AS start_date),
  d AS (
    SELECT ad.overtime_minutes, ad.pending_approval_minutes
      FROM public.attendance_days ad, m
     WHERE ad.employee_id = p_employee_id
       AND ad.ist_date >= m.start_date
       AND ad.ist_date <  (m.start_date + interval '1 month')::date
       AND COALESCE(ad.overtime_minutes, 0) > 0
  )
  SELECT
    (SELECT start_date FROM m),
    COALESCE(sum(d.overtime_minutes) FILTER (WHERE COALESCE(d.pending_approval_minutes,0) = 0), 0)::integer,
    COALESCE(sum(d.overtime_minutes) FILTER (WHERE COALESCE(d.pending_approval_minutes,0) > 0), 0)::integer,
    COALESCE(count(*) FILTER (WHERE COALESCE(d.pending_approval_minutes,0) = 0), 0)::integer,
    COALESCE(count(*) FILTER (WHERE COALESCE(d.pending_approval_minutes,0) > 0), 0)::integer,
    EXISTS (SELECT 1 FROM public.overtime_claims c, m
             WHERE c.employee_id = p_employee_id
               AND c.period_month = m.start_date
               AND c.status IN ('pending','in_progress','escalated','approved'))
  FROM d;
$fn$;

REVOKE ALL ON FUNCTION public.overtime_claimable(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.overtime_claimable(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.overtime_claimable(uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Filing one
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_overtime_claim(
  p_month        date,
  p_compensation text,
  p_reason       text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_emp   uuid := app.current_employee_id();
  v_start date := date_trunc('month', p_month)::date;
  v_c     record;
  v_id    uuid;
BEGIN
  IF v_emp IS NULL THEN
    RAISE EXCEPTION 'no employee record for the signed-in account' USING errcode = '42501';
  END IF;
  IF p_compensation NOT IN ('paid', 'comp_off') THEN
    RAISE EXCEPTION 'compensation must be paid or comp_off, not %', p_compensation
      USING errcode = '22023';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 15 THEN
    RAISE EXCEPTION 'Say what the extra work was, in at least 15 characters — an approver reads this months from now.'
      USING errcode = '23514';
  END IF;

  /*
    A month still running cannot be claimed. HR's own framing was "if they have
    completed one month attendance": claiming halfway through would need a second
    claim for the rest, and the unique index permits only one live claim per month.
  */
  IF v_start >= date_trunc('month', util.ist_today())::date THEN
    RAISE EXCEPTION 'The month has not finished yet. Claim it once % is over.',
      to_char(v_start, 'Month YYYY') USING errcode = '23514';
  END IF;

  SELECT * INTO v_c FROM public.overtime_claimable(v_emp, v_start);

  IF v_c.already_claimed THEN
    RAISE EXCEPTION 'There is already a live claim for %.', to_char(v_start, 'Month YYYY')
      USING errcode = '23505';
  END IF;

  IF COALESCE(v_c.claimable_minutes, 0) <= 0 THEN
    IF COALESCE(v_c.withheld_minutes, 0) > 0 THEN
      /*
        The one refusal worth a sentence of its own: there IS overtime, and it is
        waiting on punch approvals rather than absent. Telling somebody they have no
        overtime when they can see it on their own screen would be the wrong answer.
      */
      RAISE EXCEPTION
        'Your % overtime is still waiting on % day(s) of punch approvals. Once those are approved it can be claimed.',
        to_char(v_start, 'Month YYYY'), v_c.days_withheld
        USING errcode = '23514';
    END IF;
    RAISE EXCEPTION 'No credited overtime in %.', to_char(v_start, 'Month YYYY')
      USING errcode = '23514';
  END IF;

  /*
    ── COMP-OFF THAT WOULD ROUND TO NOTHING IS REFUSED HERE ─────────────────
    `ck_col__granularity` permits only half-day steps, so a claim under half a
    comp-off day credits zero. Accepting it would take an approval, spend an
    administrator's attention, and give the employee nothing — with no error anywhere
    to explain where their hours went. Better to say so before they file, and point
    at the mode that does pay out.
  */
  IF p_compensation = 'comp_off' THEN
    DECLARE
      v_full integer;
    BEGIN
      SELECT GREATEST(COALESCE(ap.comp_off_full_day_minutes, 480), 1) INTO v_full
        FROM public.attendance_policies ap
       WHERE ap.id = public.resolve_policy('attendance_policy', v_emp, v_start);
      IF floor((v_c.claimable_minutes::numeric / COALESCE(v_full, 480)) * 2) / 2 < 0.5 THEN
        RAISE EXCEPTION
          'That is % minutes, and a compensatory off is credited in half-days of % minutes — it would round to nothing. Claim it as paid instead.',
          v_c.claimable_minutes, v_full
          USING errcode = '23514';
      END IF;
    END;
  END IF;

  INSERT INTO public.overtime_claims
    (employee_id, period_month, claimed_minutes, withheld_minutes,
     compensation, reason, created_by, updated_by)
  VALUES
    (v_emp, v_start, v_c.claimable_minutes, COALESCE(v_c.withheld_minutes, 0),
     p_compensation, btrim(p_reason), app.ctx_actor_id(), app.ctx_actor_id())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.submit_overtime_claim(date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_overtime_claim(date, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_overtime_claim(date, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Approving one has to DO something
-- ---------------------------------------------------------------------------
/*
  The lesson from the regularisation defect, applied before it can happen again: the
  effect belongs to the ROW, not to whichever screen took the decision. Any route
  that marks a claim approved applies it.
*/
CREATE OR REPLACE FUNCTION public.apply_approved_overtime_claim(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  c        public.overtime_claims%ROWTYPE;
  v_pol    public.attendance_policies%ROWTYPE;
  v_full   integer;
  v_days   numeric;
  v_ledger uuid;
BEGIN
  SELECT * INTO c FROM public.overtime_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'overtime claim % not found', p_claim_id USING errcode = 'P0002';
  END IF;
  IF c.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('claim_id', c.id, 'decision', 'already_applied');
  END IF;
  IF c.status <> 'approved' THEN
    RETURN jsonb_build_object('claim_id', c.id, 'decision', 'not_approved', 'status', c.status::text);
  END IF;

  IF c.compensation = 'comp_off' THEN
    SELECT * INTO v_pol FROM public.attendance_policies ap
     WHERE ap.id = public.resolve_policy('attendance_policy', c.employee_id, c.period_month);
    v_full := GREATEST(COALESCE(v_pol.comp_off_full_day_minutes, 480), 1);

    /*
      `ck_col__granularity` permits only half-day steps, so the credit is rounded DOWN
      to the nearest half day. Rounding up would invent time nobody worked; the
      remainder stays on the claim in `claimed_minutes`, which is what was approved.
    */
    v_days := floor((c.claimed_minutes::numeric / v_full) * 2) / 2;

    IF v_days >= 0.5 THEN
      INSERT INTO public.comp_off_ledger
        (employee_id, entry_type, days, earned_on_date, earned_minutes, earn_source,
         status, days_remaining, approved_by, approved_at, reason, recorded_by,
         expires_on)
      VALUES
        (c.employee_id, 'earned', v_days,
         (c.period_month + interval '1 month - 1 day')::date,
         c.claimed_minutes, 'event_overtime',
         'available', v_days, c.decided_by, c.decided_at,
         format('overtime claim %s for %s', c.id, to_char(c.period_month, 'Mon YYYY')),
         c.decided_by,
         ((c.period_month + interval '1 month - 1 day')::date
            + make_interval(days => COALESCE(v_pol.comp_off_expiry_days, 90)))::date)
      RETURNING id INTO v_ledger;
    END IF;
  END IF;

  UPDATE public.overtime_claims
     SET applied_at = now(),
         comp_off_ledger_id = v_ledger,
         updated_by = app.ctx_actor_id()
   WHERE id = c.id;

  RETURN jsonb_build_object(
    'claim_id',   c.id,
    'decision',   'applied',
    'compensation', c.compensation,
    'comp_off_days', v_days,
    'comp_off_ledger_id', v_ledger);
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_approved_overtime_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_approved_overtime_claim(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.apply_approved_overtime_claim(uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.overtime_claims_apply_on_approve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    PERFORM public.apply_approved_overtime_claim(NEW.id);
  END IF;
  RETURN NULL;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Triggers: stamps, the approval, the settle, the apply
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_otc__stamp            ON public.overtime_claims;
DROP TRIGGER IF EXISTS trg_otc__touch            ON public.overtime_claims;
DROP TRIGGER IF EXISTS trg_otc__raise_approval   ON public.overtime_claims;
DROP TRIGGER IF EXISTS trg_otc__settle_approval  ON public.overtime_claims;
DROP TRIGGER IF EXISTS trg_otc__apply_on_approve ON public.overtime_claims;
DROP TRIGGER IF EXISTS trg_otc__audit            ON public.overtime_claims;

/*
  `util.stamp_row`, `util.touch_row`, `audit.log_changes` — the schemas the existing
  detail tables actually use, read off `attendance_regularizations` rather than
  assumed. A first draft said `public.` for all three and failed on `log_changes`,
  which exists only in `audit`.
*/
CREATE TRIGGER trg_otc__stamp BEFORE INSERT ON public.overtime_claims
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_otc__touch BEFORE UPDATE ON public.overtime_claims
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();
CREATE TRIGGER trg_otc__audit AFTER INSERT OR UPDATE ON public.overtime_claims
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

/* The generic raiser, which reads employee_id and `reason` off the row itself. */
CREATE TRIGGER trg_otc__raise_approval AFTER INSERT ON public.overtime_claims
  FOR EACH ROW EXECUTE FUNCTION public.raise_approval_for_detail('OT_CLAIM');

/*
  ── THE `WHEN` CLAUSE IS NOT OPTIONAL ──────────────────────────────────────
  `settle_approval_for_detail` ends its status mapping with `ELSE 'withdrawn'`, so it
  treats ANY detail status it is handed as a withdrawal. It is only ever meant to run
  when the subject takes the request back.

  Without the guard this fired on the back-link UPDATE that
  `raise_approval_for_detail` performs — status still 'pending' — and promptly
  withdrew the approval request it had just created. The claim came back
  `status = withdrawn` seconds after being filed, and because 'withdrawn' is outside
  `uq_otc__live_per_month`'s status list, the month was immediately claimable again.
  Both were caught in a rolled-back dry run before this ever applied.

  Every other detail table carries the same guard; this one now matches
  `advance_requests` and `certification_claims` exactly.
*/
CREATE TRIGGER trg_otc__settle_approval AFTER UPDATE OF status ON public.overtime_claims
  FOR EACH ROW
  WHEN (NEW.approval_request_id IS NOT NULL
        AND NEW.status::text = ANY (ARRAY['withdrawn', 'cancelled'])
        AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.settle_approval_for_detail();

/* Sorts after `__settle_approval` by name, which is the order Postgres fires them in. */
CREATE TRIGGER trg_otc__apply_on_approve AFTER UPDATE OF status ON public.overtime_claims
  FOR EACH ROW EXECUTE FUNCTION public.overtime_claims_apply_on_approve();

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.overtime_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overtime_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS otc__self_select    ON public.overtime_claims;
DROP POLICY IF EXISTS otc__manager_select ON public.overtime_claims;
DROP POLICY IF EXISTS otc__admin_all      ON public.overtime_claims;

/* Their own, always — somebody must be able to see the claim they filed. */
CREATE POLICY otc__self_select ON public.overtime_claims
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

CREATE POLICY otc__manager_select ON public.overtime_claims
  FOR SELECT TO authenticated
  USING (app.is_manager_of(employee_id));

CREATE POLICY otc__admin_all ON public.overtime_claims
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

/*
  NO SELF-INSERT POLICY, deliberately. `submit_overtime_claim` is SECURITY DEFINER and
  is the only way in, which is what keeps `claimed_minutes` the server's figure. A
  direct INSERT grant would let a browser assert its own number.
*/
REVOKE ALL ON TABLE public.overtime_claims FROM PUBLIC;
REVOKE ALL ON TABLE public.overtime_claims FROM anon;
REVOKE ALL ON TABLE public.overtime_claims FROM authenticated;
GRANT SELECT ON TABLE public.overtime_claims TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. The request type
-- ---------------------------------------------------------------------------
/*
  `ck_request_types__detail_table` is a WHITELIST of the eighteen tables an approval
  may point at, and it refused this row until `overtime_claims` was added — which is
  the constraint doing its job: it is what stops a request type naming a table that
  does not exist, and it is the same registry `approval_request_evidence` trusts
  before it will read a detail row through dynamic SQL.

  Rebuilt with the existing eighteen verbatim from the deployed definition, plus the
  new one. NOT VALID is unnecessary: nothing stored can violate a widened list.
*/
ALTER TABLE public.request_types DROP CONSTRAINT IF EXISTS ck_request_types__detail_table;
ALTER TABLE public.request_types
  ADD CONSTRAINT ck_request_types__detail_table CHECK (
    detail_table IS NULL OR detail_table = ANY (ARRAY[
      'leave_requests', 'attendance_regularizations', 'employee_change_requests',
      'reimbursement_claims', 'comp_off_ledger', 'asset_allocations', 'contracts',
      'employee_salary_revisions', 'resignations', 'travel_requisitions',
      'overtime_preapprovals', 'shift_swaps', 'web_punch_requests',
      'income_tax_declarations', 'document_requests', 'advance_requests',
      'asset_requests', 'certification_claims',
      'overtime_claims'
    ]));

/*
  AC-CLAIM-STD — reporting manager, then admin. The venue's requirement was that it
  "come as an approval to me", and Sunil is an administrator, so the standard claim
  chain routes to him after the manager has seen it. AC-OT is the PRE-approval chain
  and stays with its own request type.
*/
INSERT INTO public.request_types
  (code, name, description, sort_order, is_active, detail_table,
   default_approval_chain_id, sla_hours, escalation_hours,
   allows_withdrawal, allows_partial_approval, requires_attachment)
SELECT
  'OT_CLAIM', 'Overtime claim',
  'A month of credited overtime, claimed for payment or as compensatory off.',
  330, true, 'overtime_claims',
  (SELECT id FROM public.approval_chains WHERE code = 'AC-CLAIM-STD' AND deleted_at IS NULL),
  72, 120,
  true, false, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.request_types WHERE code = 'OT_CLAIM' AND deleted_at IS NULL);
