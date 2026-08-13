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
 * WHAT USED NOT TO EXIST, AND NOW DOES (migration 043100):
 *   1. `public.events`. For ninety migrations `/admin/org/events` was a route in
 *      the manifest with no table behind it. The table exists now, the register
 *      screen claims that route, and `fk_roster_slots__event` — registered in the
 *      004900 deferred sweep against a relation nobody had built, and skipped
 *      silently ever since — is finally attached.
 *   2. A REQUIRED-headcount figure. `event_labour_demand.required_headcount`
 *      states labour demand per event per department. Before 043100, grepping the
 *      migrations for `required_headcount`, `planned_headcount`, `min_staff` and
 *      `headcount_required` returned nothing at all, so "required" was not a
 *      column, a view or a function anywhere on this backend.
 *   3. A coverage view. `v_event_coverage` joins the two and emits
 *      `required_headcount`, `rostered_headcount` and `short_by` per event and
 *      department. `events.api.ts` reads it; nothing recomputes the subtraction.
 *
 * WHAT IS STILL TRUE, and is therefore still not invented here:
 *   * NOTHING ATTACHES A SLOT TO A BOOKING. `roster_slots.event_id` has its
 *     foreign key now but is NULL on every row, so an event's rostered headcount
 *     is genuinely zero until somebody links the two. The view reports that zero
 *     rather than guessing from dates — a slot on the same day as a wedding is
 *     not evidence that it is FOR the wedding.
 *   * PLANNED VERSUS PRESENT CANNOT BE JOINED. The engine writes
 *     `attendance_days.roster_slot_id`, but `v_attendance_day_enriched` does not
 *     project it and `roster_slots.attendance_day_id` is never written, so
 *     neither side of that join is readable from a browser.
 *   * `roster_slots` carries no department column (department lives on the parent
 *     `rosters` row), and PostgREST cannot filter a child by a parent column
 *     through this query layer. So the slot count in THIS module is offered for
 *     the whole company only; when a department filter is on, the screen shows
 *     "—" and says why rather than printing a company-wide number under a
 *     department heading. `v_event_coverage` does the parent join in SQL, which
 *     is why per-department coverage is read from the view and not assembled
 *     here.
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
  rpcAudited,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";

export const ROSTERS_TABLE = "rosters";
export const ROSTER_SLOTS_TABLE = "roster_slots";

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

// -----------------------------------------------------------------------------
// Publishing a week
// -----------------------------------------------------------------------------

export const PUBLISH_ROSTER_FN = "publish_roster";

/**
 * Move a draft week to published.
 *
 * Everything that decides whether this is allowed lives in the function, not
 * here: an administrator may publish any week, a manager only one where EVERY
 * slot belongs to one of their own reportees, and an empty week is refused
 * outright. That last rule is the reason this is not a plain `updateRow` — a
 * published roster is what the team reads to know when to come in, so publishing
 * nothing would quietly tell everybody they are not needed for a week.
 *
 * The whole-roster ownership rule is also why the server side is a function
 * rather than a widened RLS policy: RLS is evaluated per row, and row by row a
 * manager could publish a week where only their own slots are theirs.
 *
 * Returns the roster as it now stands, so the caller renders the server's row
 * rather than assuming the write took.
 */
export async function publishRoster(
  rosterId: string,
  reason: string,
  note?: string | null,
  signal?: AbortSignal,
): Promise<Roster> {
  const rows = await rpcAudited(
    PUBLISH_ROSTER_FN,
    {
      p_roster_id: rosterId,
      p_reason: note === undefined || note === null || note.trim() === "" ? null : note.trim(),
    },
    rosterSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("The roster was not returned after publishing.");
  }
  return row;
}
