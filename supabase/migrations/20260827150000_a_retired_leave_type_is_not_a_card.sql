-- =============================================================================
-- 20260827150000 — a retired leave type stops rendering as a card
-- =============================================================================
--
-- REPORTED, on /me/leave, alongside Earned and Sick:
--
--   "you have not removed casual leave"
--
--   Casual Leave — AVAILABLE TO USE — -0.5
--
-- ── CASUAL LEAVE IS ALREADY RETIRED, AND THAT IS THE PROBLEM ────────────────
--
-- 20260801039600 merged Casual Leave into Week-off and retired the row. Whether it
-- is INACTIVE or SOFT-DELETED depends on the deployment, and the fork is one I
-- introduced when fixing that migration: it soft-deletes only when an actor can be
-- named, because `ck_lt__deletion_reason` exists to stop an unattributable delete.
-- On this venue an actor resolved, so `deleted_at` is set — which is why Casual
-- Leave is absent from a `deleted_at IS NULL` listing of the types. On a fresh
-- replay no actor resolves, so it is merely inactive. BOTH have to be handled, and
-- assuming only the first is what a probe caught here.
--
-- Either way nothing can be applied for. What still exists is a `leave_balances`
-- row holding -0.5 days, left behind by the merge. And
-- `v_leave_balance_current` — what the employee''s "Your balances" cards read —
-- joined `leave_types` with NO predicate at all:
--
--     JOIN public.leave_types lt ON lt.id = lb.leave_type_id
--
-- So a deleted type with a stale balance came straight through, and the screen drew
-- a card for it. Every consumer of this view has had the same hole: 039000 fixed
-- the identical omission for archived EMPLOYEES ("these views never referenced
-- employees AT ALL") and did not look at the type side of the same join.
--
-- ── WHY THE JOIN AND NOT A CLIENT FILTER ────────────────────────────────────
--
-- Four screens read this view. A predicate in one of them fixes one screen and
-- leaves the others drawing history as though it were current — which is exactly
-- how this defect survived 039000. A deleted leave type is not a row any caller
-- wants; the join is where that belongs.
--
-- INACTIVE IS TREATED DIFFERENTLY FROM DELETED, deliberately, and it takes TWO
-- layers to cover both:
--
--   DELETED  filtered in the view. The type does not exist; no caller wants it.
--   INACTIVE exposed as `leave_type_active` and left to the caller. A retired type
--            may still hold days somebody is owed, and silently hiding those would
--            be worse than showing them.
--
-- The employee''s own cards drop the inactive ones — a card you cannot apply from is
-- furniture. The admin balances register keeps them, because that is where somebody
-- goes to settle the leftover. Fixing only the view would have left Casual Leave on
-- screen anywhere 039600 had not soft-deleted it.
--
-- `CREATE OR REPLACE VIEW` may only append columns, which is why
-- `leave_type_active` is last rather than beside the other type columns.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 150000: v_leave_balance_current joined leave_types with no predicate, so a soft-deleted type with a stale balance rendered as a card on every screen reading the view', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE VIEW public.v_leave_balance_current
WITH (security_invoker = true) AS
SELECT
  lb.employee_id,
  lb.leave_type_id,
  lt.code            AS leave_type_code,
  lt.name            AS leave_type_name,
  lt.colour_hex,
  lt.is_paid,
  lt.is_comp_off,
  lt.allow_half_day,
  lb.leave_year,
  lb.opening_days,
  lb.accrued_days,
  lb.carried_forward_days,
  lb.adjusted_days,
  (lb.opening_days + lb.accrued_days + lb.carried_forward_days + lb.adjusted_days)
                     AS entitlement_days,
  lb.availed_days,
  lb.pending_days,
  lb.encashed_days,
  lb.lapsed_days,
  lb.available_days,
  lb.available_after_pending,
  COALESCE(exp30.expiring_soon_days, 0) AS expiring_soon_days,
  exp30.nearest_expiry,
  lb.last_recomputed_at,
  lt.is_active AS leave_type_active
FROM public.leave_balances lb
JOIN public.leave_types lt ON lt.id = lb.leave_type_id AND lt.deleted_at IS NULL
JOIN public.employees   e  ON e.id = lb.employee_id AND e.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(COALESCE(col.days_remaining, col.days)), 0) AS expiring_soon_days,
    MIN(col.expires_on)                                      AS nearest_expiry
  FROM public.comp_off_ledger col
  WHERE lt.is_comp_off
    AND col.employee_id = lb.employee_id
    AND col.entry_type = 'earned'
    AND col.status IN ('available','partially_used')
    AND col.expires_on IS NOT NULL
    AND col.expires_on BETWEEN util.ist_today() AND util.ist_today() + 30
) exp30 ON true
WHERE lb.leave_year = public.leave_year_of(util.ist_today());

DO $verify$
DECLARE v_deleted int;
BEGIN
  /* The view must no longer be able to show a deleted type, whatever balances
     survive against one. */
  SELECT count(*) INTO v_deleted
    FROM public.v_leave_balance_current v
    JOIN public.leave_types lt ON lt.id = v.leave_type_id
   WHERE lt.deleted_at IS NOT NULL;

  IF v_deleted > 0 THEN
    RAISE EXCEPTION '% row(s) for deleted leave types are still visible', v_deleted;
  END IF;

  RAISE NOTICE 'no deleted leave type reaches the balances view';
  RAISE NOTICE 'retired but still visible to admins: %', COALESCE((
    SELECT string_agg(DISTINCT lt.code, ', ')
      FROM public.v_leave_balance_current v
      JOIN public.leave_types lt ON lt.id = v.leave_type_id
     WHERE NOT lt.is_active), 'none');
END $verify$;

COMMIT;
