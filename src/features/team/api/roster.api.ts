/**
 * roster.api.ts — the SLOT-grain reads behind /team/roster,
 * /admin/attendance/roster and /admin/attendance/coverage, plus the IST week
 * arithmetic those three screens share.
 *
 * WHY A SECOND ROSTER MODULE. `../../admin/api/coverage.api.ts` already owns the
 * roster HEADER reads (`rosters`: one row per department-week, its status and its
 * publisher) and the company-wide published-slot COUNT. It deliberately reads no
 * slot rows, so nothing here duplicates it — this module is imported alongside
 * it and adds exactly one thing: the `roster_slots` rows themselves.
 *
 * WHAT IS DEPLOYED, verified against supabase/migrations/…001500_rosters.sql:
 *   * `public.roster_slots` — one row per employee-date inside a roster, with
 *     `shift_id`, `section_id`, `planned_start_at/end_at`, `role_label`,
 *     `is_weekly_off`, `is_published`, the swap columns and `attendance_day_id`.
 *   * RLS, and it is the scope: an employee sees only their own PUBLISHED slots;
 *     a manager sees their reportees' slots INCLUDING drafts (that is what makes
 *     a planning view legitimate on a manager screen); an admin sees their scope.
 *     Narrowing a read to reportee ids here is a correctness filter, never a
 *     security claim.
 *   * Seed 047 publishes exactly ONE week: the Banquet department, the Monday
 *     after the seed ran, seven slots each for TT0003 and TT0004 with Tuesday as
 *     the weekly off. Every other week in this database is genuinely empty, and
 *     the screens say so rather than drawing an empty grid as if it were a plan.
 *
 * WHAT DOES NOT EXIST, and is therefore never invented here:
 *   1. `public.events` — no migration creates it. `roster_slots.event_id` is a
 *      bare uuid whose FK the 049 sweep skips (`to_regclass` guard), and it is
 *      NULL on every seeded row. So there is no event name, date or venue to
 *      group a roster by.
 *   2. A REQUIRED-headcount figure anywhere in the schema, hence no shortfall.
 *   3. Any write path. Migration 015's header states slot writes go through the
 *      roster edge functions / RPCs — and `supabase/functions/` contains no
 *      roster function, while `publish_roster`/`upsert_roster` exist nowhere in
 *      the migrations. `capabilities` does carry `roster.publish` for the manager
 *      role, so the CAPABILITY is modelled and the endpoint is not. This module
 *      exports read functions only; the screens offer no publish control and name
 *      the missing endpoint instead of poking the table directly.
 *
 * One thing this module CAN do that `coverage.api.ts` cannot: narrow a slot count
 * to a department-week, because `roster_id` IS that narrowing (one roster = one
 * department × one week, `uq_rosters__department_week`). A per-roster count is
 * therefore honest where a per-department slot count is not.
 */
import { z } from "zod";
import { addIstDays, fmtCivilWeekday } from "@/lib/datetime";
import {
  dbDate,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  isNull,
  isFalse,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { ROSTER_SLOTS_TABLE } from "@/features/admin/api/coverage.api";

/** Row cap: a department-week is 7 × headcount, so 700 covers a 100-person week. */
export const ROSTER_SLOT_ROW_CAP = 700;

// -----------------------------------------------------------------------------
// 1. The IST week, derived from the sanctioned date helpers only
// -----------------------------------------------------------------------------

/** `ck_rosters__monday` — a roster week starts on an IST Monday, always. */
const WEEKDAY_OFFSET: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/**
 * The Monday of the IST week containing `isoDate`.
 *
 * Built from `fmtCivilWeekday` + `addIstDays` rather than local `Date` maths, so
 * the answer is the same in Bengaluru and in a browser set to UTC−7 — the whole
 * reason those two helpers exist.
 */
export function istWeekStart(isoDate: string): string {
  return addIstDays(isoDate, -(WEEKDAY_OFFSET[fmtCivilWeekday(isoDate)] ?? 0));
}

/** The seven civil dates of a roster week, Monday first. */
export function istWeekDates(weekStart: string): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addIstDays(weekStart, offset));
}

/** The inclusive civil-date window a roster week covers. */
export function istWeekRange(weekStart: string): { from: string; to: string } {
  return { from: weekStart, to: addIstDays(weekStart, 6) };
}

/** Previous/next week for a stepper — Monday to Monday, never ±30 days. */
export function shiftIstWeek(weekStart: string, deltaWeeks: number): string {
  return addIstDays(weekStart, deltaWeeks * 7);
}

// -----------------------------------------------------------------------------
// 2. roster_slots
// -----------------------------------------------------------------------------

export const rosterSlotSchema = z.object({
  id: dbUuid,
  roster_id: dbUuid,
  employee_id: dbUuid,
  slot_date: dbDate,
  shift_id: dbUuidNullable,
  section_id: dbUuidNullable,
  /** Always NULL on this backend — `public.events` does not exist (see header). */
  event_id: dbUuidNullable,
  planned_start_at: dbTimestampNullable,
  planned_end_at: dbTimestampNullable,
  role_label: z.string().nullable(),
  is_weekly_off: z.boolean(),
  is_published: z.boolean(),
  swap_requested_with_employee_id: dbUuidNullable,
  swap_status: z.string().nullable(),
  /** Set by the attendance engine once the day is computed against this slot. */
  attendance_day_id: dbUuidNullable,
  notes: z.string().nullable(),
});
export type RosterSlot = z.infer<typeof rosterSlotSchema>;

const ROSTER_SLOT_COLUMNS =
  "id, roster_id, employee_id, slot_date, shift_id, section_id, event_id, " +
  "planned_start_at, planned_end_at, role_label, is_weekly_off, is_published, " +
  "swap_requested_with_employee_id, swap_status, attendance_day_id, notes";

/**
 * The slot slices. Each key is a predicate array, and the SAME array goes to
 * `selectMany` and `selectCount`, so a tile is the cardinality of exactly the
 * rows its grid shows.
 *
 * There is no `unstaffed` slice: "an employee with no slot this week" is the
 * ABSENCE of a row, which no filter over `roster_slots` can express. The screens
 * print who does have slots and say that plainly.
 */
export const ROSTER_SLOT_SLICE_FILTERS = {
  all: [] as readonly Filter[],
  published: [isTrue("is_published")] as readonly Filter[],
  draft: [isFalse("is_published")] as readonly Filter[],
  working: [isFalse("is_weekly_off")] as readonly Filter[],
  weekly_off: [isTrue("is_weekly_off")] as readonly Filter[],
  swap: [eq("swap_status", "requested")] as readonly Filter[],
} as const;

export type RosterSlotSlice = keyof typeof ROSTER_SLOT_SLICE_FILTERS;

export function isRosterSlotSlice(value: string | null): value is RosterSlotSlice {
  return (
    value !== null && Object.prototype.hasOwnProperty.call(ROSTER_SLOT_SLICE_FILTERS, value)
  );
}

export interface RosterSlotFilters {
  /** Inclusive IST civil-date window on `slot_date`. */
  readonly from: string;
  readonly to: string;
  /**
   * Reportee ids, for the manager surface. Empty ⇒ no narrowing is applied and
   * RLS alone decides the row set (which is what the admin planner wants).
   */
  readonly employeeIds?: readonly string[];
  /** One department-week. The only honest way to narrow slots by department. */
  readonly rosterId?: string;
  readonly slice?: RosterSlotSlice;
}

/** The one place slot predicates are built, so rows and counts cannot disagree. */
export function rosterSlotFilters(f: RosterSlotFilters): readonly Filter[] {
  const filters: Filter[] = [
    isNull("deleted_at"),
    gte("slot_date", f.from),
    lte("slot_date", f.to),
  ];
  if (f.employeeIds !== undefined && f.employeeIds.length > 0)
    filters.push(inList("employee_id", f.employeeIds));
  if (f.rosterId !== undefined) filters.push(eq("roster_id", f.rosterId));
  for (const extra of ROSTER_SLOT_SLICE_FILTERS[f.slice ?? "all"]) filters.push(extra);
  return filters;
}

/** Slots in the window, date-ordered. Names are joined in by the caller's hook. */
export function fetchRosterSlots(
  f: RosterSlotFilters,
  limit = ROSTER_SLOT_ROW_CAP,
  signal?: AbortSignal,
): Promise<RosterSlot[]> {
  return selectMany(ROSTER_SLOTS_TABLE, rosterSlotSchema, {
    columns: ROSTER_SLOT_COLUMNS,
    filters: rosterSlotFilters(f),
    order: [
      { column: "slot_date", ascending: true },
      { column: "id", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** The same predicate, counted by Postgres. Never `rows.length`. */
export function countRosterSlots(
  f: RosterSlotFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(ROSTER_SLOTS_TABLE, rosterSlotFilters(f), {
    ...(signal ? { signal } : {}),
  });
}
