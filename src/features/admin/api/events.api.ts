/**
 * events.api.ts — the reads behind §3 `/admin/org/events` (Event Register).
 *
 * WHAT THE ROUTE WAS ASKED FOR. The manifest calls this "Booked events that drive
 * staffing requirements", and spec-admin §3 describes an `events` row as
 * `event_code` `EVT-2026-0143`, client, type, halls[], guest counts, call time,
 * `labour_demand[]`, cost centre, sales owner and status.
 *
 * WHAT IS DEPLOYED. `public.events` DOES NOT EXIST. Verified, not assumed:
 *   * No migration in supabase/migrations creates it — the only mention of the
 *     relation anywhere is in the 049 deferred-FK sweep, which lists
 *     `('public.roster_slots', 'fk_roster_slots__event', 'event_id',
 *     'public.events', 'SET NULL')` and is guarded on
 *     `to_regclass(ref_table) IS NOT NULL`, so it SKIPS.
 *   * `roster_slots.event_id` (migration 015 line 89) is therefore a bare uuid
 *     with no foreign key and no register behind it. This module counts how many
 *     slots carry one, so the screen can state the number instead of implying it.
 *   * `required_headcount` / `planned_headcount` / `min_staff` /
 *     `headcount_required` appear in NO migration, so labour demand is not a
 *     column anywhere and no shortfall is computed on this screen or any other
 *     (the same finding `coverage.api.ts` records for Event Coverage).
 * Consequently NOTHING here invents a booking. There is no client name, no hall,
 * no guest count and no create form, because there is no table to write to — and
 * an empty "New event" button that fails at PostgREST is worse than an absent one.
 *
 * WHAT IS REAL, AND IS WHAT THIS SCREEN SHOWS. The venue's event-driven operating
 * calendar is genuinely in this database, in two places:
 *
 *  1. `public.holidays.working_if_event_booked` (migration 014). Seed 043 loads
 *     the KA-2026 calendar with 19 dates and sets this flag on the ones where the
 *     operational departments work if an event is booked — with
 *     `applies_to_department_ids` naming the departments that DO get the day off,
 *     `compensatory_off_if_worked` and `pay_multiplier_if_worked` (2.0). Those are
 *     the dates that turn a booking into overtime, comp-off and double pay, so
 *     they are the register's spine.
 *  2. `public.roster_slots` (migration 015) — the staffing actually planned for a
 *     date. This module does not re-read slot rows: `features/team/api/roster.api`
 *     already owns that predicate, and its `countRosterSlots` is reused here so a
 *     per-date figure on this screen equals the one on the roster planner by
 *     construction.
 *
 * Every number is a `count=exact` from Postgres over the same predicate as the
 * list beside it. Nothing is summed or divided in the browser.
 */
import {
  eq,
  gte,
  isNotNull,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { compareCivilDates } from "@/lib/datetime";
import { HOLIDAYS_TABLE, holidaySchema, type Holiday } from "./org.api";
import { ROSTER_SLOTS_TABLE } from "./coverage.api";
import { countRosterSlots } from "@/features/team/api/roster.api";

/** Named once so the screen can say exactly what is missing, in one place. */
export const MISSING_EVENTS_TABLE = "public.events";
export const MISSING_EVENT_FK = "fk_roster_slots__event";

/** A calendar year is ≤ 40 rows even with every restricted holiday listed. */
export const EVENT_DAY_ROW_CAP = 100;

/**
 * How many dates may get a per-date roster COUNT in one pass. Each date is its
 * own `count=exact` (the shape Event Coverage uses for its seven-day strip);
 * beyond this the screen shows the register without the demand column rather than
 * firing a request per row.
 */
export const DEMAND_DATE_CAP = 12;

// -----------------------------------------------------------------------------
// 1. Event-driven operating days — `public.holidays`
// -----------------------------------------------------------------------------

export interface EventDayFilters {
  readonly calendarId: string;
  /**
   * Only the dates a booked event turns into a working day. Default true — that
   * is the whole point of this register; false shows the calendar entire.
   */
  readonly eventDrivenOnly?: boolean;
  /** Withdrawn (`is_active = false`) rows are excluded unless asked for. */
  readonly includeWithdrawn?: boolean;
  /** Inclusive civil-date window, when the admin narrows to a season. */
  readonly from?: string;
  readonly to?: string;
}

/** The ONE predicate builder — tiles and grid share it, so they cannot disagree. */
export function eventDayFilters(f: EventDayFilters): Filter[] {
  const filters: Filter[] = [eq("holiday_calendar_id", f.calendarId)];
  if (f.eventDrivenOnly !== false) filters.push(isTrue("working_if_event_booked"));
  if (f.includeWithdrawn !== true) filters.push(isTrue("is_active"));
  if (f.from !== undefined) filters.push(gte("holiday_date", f.from));
  if (f.to !== undefined) filters.push(lte("holiday_date", f.to));
  return filters;
}

/**
 * The register rows, earliest date first.
 *
 * `holidays` has no view over it; RLS (`holidays__ref_read`) admits active rows to
 * everyone and every row to an admin, which is exactly the scope this screen
 * wants. The schema is `org.api`'s `holidaySchema` — reused, not re-declared, so
 * a column added there cannot go missing here.
 */
export function fetchEventDays(f: EventDayFilters, signal?: AbortSignal): Promise<Holiday[]> {
  return selectMany(HOLIDAYS_TABLE, holidaySchema, {
    filters: eventDayFilters(f),
    order: [{ column: "holiday_date", ascending: true }],
    limit: EVENT_DAY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countEventDays(f: EventDayFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(HOLIDAYS_TABLE, eventDayFilters(f), { ...(signal ? { signal } : {}) });
}

/** Dates that also grant a compensatory off to whoever works them. */
export function countCompOffDays(f: EventDayFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(
    HOLIDAYS_TABLE,
    [...eventDayFilters(f), isTrue("compensatory_off_if_worked")],
    { ...(signal ? { signal } : {}) },
  );
}

/** Optional/restricted dates — an employee may choose these, up to the quota. */
export function countOptionalEventDays(
  f: EventDayFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(HOLIDAYS_TABLE, [...eventDayFilters(f), isTrue("is_optional")], {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The next few event-driven dates, from `today` forward.
 *
 * A slice of an already-ordered server list, not a re-sort: `fetchEventDays`
 * returns `holiday_date ASC`, and `compareCivilDates` is the sanctioned IST
 * comparison (never `new Date(a) < new Date(b)`, which would compare in UTC).
 */
export function upcomingEventDays(
  rows: readonly Holiday[],
  today: string,
  max: number,
): Holiday[] {
  return rows.filter((row) => compareCivilDates(row.holiday_date, today) >= 0).slice(0, max);
}

// -----------------------------------------------------------------------------
// 2. Staffing planned against those dates — `public.roster_slots`
// -----------------------------------------------------------------------------

/**
 * Slots planned per date: one `count=exact` per date, through the roster module's
 * own predicate builder.
 *
 * Deliberately N counts rather than one read divided N ways — the figure for
 * 15 August here is the same figure the roster planner shows for 15 August,
 * because it is literally the same query.
 */
export async function fetchDemandByDate(
  dates: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, number>> {
  if (dates.length === 0) return new Map<string, number>();
  if (dates.length > DEMAND_DATE_CAP) {
    throw new Error(
      `fetchDemandByDate refuses ${dates.length} dates: the cap is ${DEMAND_DATE_CAP} per pass.`,
    );
  }
  const counts = await Promise.all(
    dates.map((date) => countRosterSlots({ from: date, to: date }, signal)),
  );
  const out = new Map<string, number>();
  dates.forEach((date, index) => {
    const count = counts[index];
    if (count !== undefined) out.set(date, count);
  });
  return out;
}

/**
 * How many roster slots carry an `event_id` at all.
 *
 * This is the register's own honesty check: the column exists, nothing populates
 * it, and the screen prints the count rather than describing the gap in prose
 * only. When `public.events` and its FK land, this number starts moving.
 */
export function countEventTaggedSlots(signal?: AbortSignal): Promise<number> {
  return selectCount(ROSTER_SLOTS_TABLE, [isNotNull("event_id")], {
    ...(signal ? { signal } : {}),
  });
}
