/**
 * coverage.api.ts — the reads behind §4 `/admin/attendance/coverage` (Event
 * Coverage), and an honest register of what this backend cannot answer.
 *
 * WHAT THE SCREEN WAS ASKED FOR: "required vs rostered vs actually-present
 * headcount per department per event" (docs/plan/03-prd-admin.md §5.12).
 *
 * WHAT IS ACTUALLY DEPLOYED, verified against supabase/migrations:
 *   * `public.rosters` (migration 015) — one row per department-week, with
 *     `week_start_date` (an IST Monday), `status` in draft/published/locked, and
 *     the publisher + publish instant. THIS EXISTS and is read here.
 *   * `public.roster_slots` (015) — one row per employee-date inside a roster,
 *     carrying `shift_id`, `section_id`, `planned_start_at/end_at`, `role_label`
 *     and `is_published`. THIS EXISTS and is counted here.
 *   * `public.roster_slots.event_id` — a bare `uuid` column with NO foreign key.
 *     Migration 015 line 89 says "FK added by deferred sweep (event register)",
 *     and the sweep in 049 lists `('public.roster_slots', …, 'public.events')`
 *     but is guarded on `to_regclass(ref_table) IS NOT NULL`, so it SKIPS.
 *
 * WHAT DOES NOT EXIST — and is therefore not invented anywhere in this module:
 *   1. `public.events`. No migration creates it. `/admin/org/events` ("Event
 *      Register") is a route in the manifest with no table behind it, so there
 *      are no event names, dates or venues to group by, and `event_id` is NULL
 *      on every seeded slot.
 *   2. A REQUIRED-headcount figure. Nothing in the schema states labour demand:
 *      grepping the migrations for `required_headcount`, `planned_headcount`,
 *      `min_staff` and `headcount_required` returns nothing. "Required" is not a
 *      column, a view or a function anywhere on this backend.
 *   3. A coverage view. There is no `v_event_coverage` / `v_roster_coverage`;
 *      the only `*_coverage` relation deployed is `v_enrolment_coverage`, which
 *      is the face-enrolment gap list and has nothing to do with staffing.
 *
 * Consequences held deliberately:
 *   * A shortfall (required − rostered) is NOT computed here or on the screen.
 *     With no required figure, any number in that column would be fiction, and a
 *     fabricated shortfall is worse than an empty one because it looks actionable.
 *   * `roster_slots` carries no department column (department lives on the parent
 *     `rosters` row), and PostgREST cannot filter a child by a parent column
 *     through this query layer. So the slot count is offered for the whole
 *     company only; when a department filter is on, the screen shows "—" and says
 *     why rather than printing a company-wide number under a department heading.
 */
import { z } from "zod";
import {
  dbDate,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  gte,
  inList,
  isNull,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";

export const ROSTERS_TABLE = "rosters";
export const ROSTER_SLOTS_TABLE = "roster_slots";

/** Named so the screen can say exactly what is missing, in one place. */
export const MISSING_EVENTS_TABLE = "public.events";
export const MISSING_COVERAGE_VIEW = "public.v_event_coverage";

/** `ck_rosters__status` (migration 015). */
export const rosterStatusValues = ["draft", "published", "locked"] as const;
export type RosterStatus = (typeof rosterStatusValues)[number];

export const rosterSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  location_id: dbUuidNullable,
  department_id: dbUuid,
  /** An IST Monday — `ck_rosters__monday` enforces it. */
  week_start_date: dbDate,
  title: z.string().nullable(),
  status: z.string(),
  published_by: dbUuidNullable,
  published_at: dbTimestampNullable,
  notes: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type Roster = z.infer<typeof rosterSchema>;

export interface RosterFilters {
  /** Inclusive IST civil dates bounding `week_start_date`. */
  readonly from: string;
  readonly to: string;
  readonly departmentIds?: readonly string[];
  readonly statuses?: readonly string[];
}

/** One predicate builder, shared by the list and its server COUNT. */
function rosterFilters(f: RosterFilters): Filter[] {
  const filters: Filter[] = [
    isNull("deleted_at"),
    gte("week_start_date", f.from),
    lte("week_start_date", f.to),
  ];
  if (f.departmentIds && f.departmentIds.length > 0)
    filters.push(inList("department_id", f.departmentIds));
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  return filters;
}

/**
 * Weekly rosters whose week BEGINS inside the window, newest first.
 *
 * "Begins inside" is stated on the screen rather than smoothed over: a roster is
 * a week, and a week that starts on 29-Jun covers two days of July. Widening the
 * predicate to "overlaps the month" would need `week_start_date + 6` — server
 * arithmetic this table does not offer — so the honest label is the narrow one.
 */
export function fetchRosters(
  f: RosterFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<Roster[]> {
  return selectMany(ROSTERS_TABLE, rosterSchema, {
    filters: rosterFilters(f),
    order: [{ column: "week_start_date", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** How many rosters match — the same predicate, counted by Postgres. */
export function countRosters(f: RosterFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(ROSTERS_TABLE, rosterFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * Published employee-days planned in the window, company-wide.
 *
 * This is the only "planned staffing" quantity the database actually holds: a
 * count of published slots. It is a row count, not a derivation — and it cannot
 * be narrowed to a department (see the module header), which is why the caller
 * must not display it beside a department filter.
 */
export function countPublishedRosterSlots(
  range: { readonly from: string; readonly to: string },
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    ROSTER_SLOTS_TABLE,
    [
      isNull("deleted_at"),
      gte("slot_date", range.from),
      lte("slot_date", range.to),
      isTrue("is_published"),
    ],
    { ...(signal ? { signal } : {}) },
  );
}
