-- ============================================================================
-- 20260801039700_leave_application_groups.sql
--
-- ONE APPLICATION, SEVERAL LEAVE TYPES (product instruction, option 2).
--
-- "They can combine any leave with other leave. For example, if they have a balance
-- of 0.5 in week offs and they want to take 2 days holiday, then that 0.5 can be
-- taken from any other thing except sick leave."
--
-- WHY GROUPED REQUESTS AND NOT TYPED DAYS. `leave_request_days` carries no
-- `leave_type_id` — the type lives on the request — so a mixed application is not
-- expressible on one row. The alternative (option 1) was to move the type onto the
-- day, and that would mean rewriting all five triggers around `leave_requests`
-- (`submit_guard`, `no_overlap`, `apply_ledger`, `recompute_balance`,
-- `generate_request_number`) plus `v_leave_calendar`, every one of which reads the
-- type off the request. Each rewrite is a chance to compute a balance wrongly, and a
-- wrong leave balance is invisible until somebody is refused leave they thought they
-- had.
--
-- So an application becomes N single-type requests sharing an `application_group_id`.
-- Every existing guard keeps working UNCHANGED, per request, per type — including the
-- per-type balance check, which is the one that matters most. What the group adds is
-- the ability to present and decide them together.
--
-- ── SICK LEAVE CANNOT BE COMBINED ────────────────────────────────────────────
-- "Sick leave is the only thing that cannot be balanced with something else. You
-- have to take a full day sick leave. Give an option for half-day, but they cannot
-- combine it with some other thing."
--
-- So `allows_combination` is a COLUMN on `leave_types`, not a hardcoded 'SL' check:
-- the rule is a property of the leave type and the next type that needs it should be
-- a data change, not a migration. Sick Leave is set false; everything else true.
--
-- Half days remain allowed for Sick Leave — `allow_half_day` is already true and is
-- untouched. The restriction is on MIXING, not on duration: half a day of sick leave
-- alone is fine; half sick plus half week-off is not.
--
-- ENFORCED BY ITS OWN TRIGGER, deliberately not by editing `leave_requests_submit_guard`.
-- That function is ~140 lines enforcing twenty rules and is the single most
-- consequential piece of leave logic here; adding to it means re-deploying all of it
-- to change one thing. A separate constraint trigger fails just as hard and can be
-- read, tested and reverted on its own.
-- ============================================================================

BEGIN;

-- `audit.reason_required_tables` includes leave_types, so the UPDATE below needs a reason
-- before the audit trigger will accept it. That guard is why a leave type cannot change
-- silently, and a migration is no more exempt from it than a screen.
SELECT set_config(
  'app.reason',
  'marking Sick Leave as non-combinable so a grouped application cannot mix it with another type',
  true
);

-- ── 1. The group ────────────────────────────────────────────────────────────
ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS application_group_id uuid;

COMMENT ON COLUMN public.leave_requests.application_group_id IS
  'Requests filed as ONE application by the employee, one row per leave type. NULL for a '
  'single-type application, which is every request written before migration 039700. The '
  'group is a presentation and decision unit; each row is still independently guarded.';

-- Partial: only grouped rows are worth indexing, and most rows are not grouped.
CREATE INDEX IF NOT EXISTS idx_leave_requests__application_group
  ON public.leave_requests (application_group_id)
  WHERE application_group_id IS NOT NULL;

-- ── 2. Which types may be combined ──────────────────────────────────────────
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS allows_combination boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.leave_types.allows_combination IS
  'False when this type must be taken alone — a grouped application may not mix it with any '
  'other type. Sick Leave is the case this exists for. A property of the type, so adding '
  'another is a data change rather than a migration.';

UPDATE public.leave_types
   SET allows_combination = false
 WHERE code = 'SL';

-- ── 3. The rule ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.leave_requests_combination_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_exclusive_name text;
  v_type_count     integer;
BEGIN
  -- Ungrouped requests are single-type by definition and cannot violate anything.
  IF NEW.application_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- How many DISTINCT types the group holds once this row is counted. Distinct types,
  -- not rows: two Week-off rows in one group (a half day plus full days) is a legitimate
  -- shape and not a combination at all.
  SELECT count(DISTINCT lr.leave_type_id) INTO v_type_count
  FROM public.leave_requests lr
  WHERE lr.application_group_id = NEW.application_group_id
    AND lr.status <> 'draft';

  IF v_type_count <= 1 THEN
    RETURN NEW;
  END IF;

  -- More than one type: no member may be a type that refuses to be combined.
  SELECT lt.name INTO v_exclusive_name
  FROM public.leave_requests lr
  JOIN public.leave_types lt ON lt.id = lr.leave_type_id
  WHERE lr.application_group_id = NEW.application_group_id
    AND lr.status <> 'draft'
    AND NOT lt.allows_combination
  LIMIT 1;

  IF v_exclusive_name IS NOT NULL THEN
    RAISE EXCEPTION
      '% must be taken on its own and cannot be combined with another leave type',
      v_exclusive_name
      USING errcode = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- AFTER, not BEFORE: the rule is about the group as a whole, so it can only be judged
-- once this row is visible to the count. A BEFORE trigger would see the group without
-- the row that breaks it.
DROP TRIGGER IF EXISTS trg_leave_requests__combination ON public.leave_requests;
CREATE CONSTRAINT TRIGGER trg_leave_requests__combination
  AFTER INSERT OR UPDATE OF status, application_group_id, leave_type_id
  ON public.leave_requests
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_combination_guard();

COMMENT ON FUNCTION public.leave_requests_combination_guard() IS
  'Refuses a grouped application that mixes a non-combinable leave type (allows_combination '
  'false — Sick Leave) with any other type. Its own trigger rather than an edit to '
  'leave_requests_submit_guard, which enforces twenty rules in 140 lines and should not be '
  're-deployed to add one.';

COMMIT;
