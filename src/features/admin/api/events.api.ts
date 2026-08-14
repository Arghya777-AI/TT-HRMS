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
import { z } from "zod";
import {
  dbDate,
  dbInt,
  dbIntNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  isNotNull,
  isNull,
  isTrue,
  lte,
  rpcAudited,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import { compareCivilDates } from "@/lib/datetime";
import { HOLIDAYS_TABLE, holidaySchema, type Holiday } from "./org.api";
import { ROSTER_SLOTS_TABLE } from "./coverage.api";
import { countRosterSlots } from "@/features/team/api/roster.api";

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

// -----------------------------------------------------------------------------
// 3. The register itself — `public.events`, which now exists
// -----------------------------------------------------------------------------
//
// Everything above this line was written when `public.events` did not exist, and
// it is all still true and still used: the event-driven holiday calendar and the
// per-date roster counts are what turn a booking into overtime, comp-off and
// double pay. What changed is that there is now a booking to attach them to.
//
// Migration 043100 created `events`, `event_labour_demand` and `v_event_coverage`,
// and attached `fk_roster_slots__event` — the constraint the 004900 sweep had been
// silently skipping since it was registered against a table nobody had built.

export const EVENTS_TABLE = "events";
export const EVENT_LABOUR_DEMAND_TABLE = "event_labour_demand";
export const EVENT_COVERAGE_VIEW = "v_event_coverage";

/** `ck_events__status`, restated. */
export const eventStatusValues = ["enquiry", "confirmed", "completed", "cancelled"] as const;
export type EventStatus = (typeof eventStatusValues)[number];

/** `ck_events__type`, restated. */
export const eventTypeValues = [
  "wedding",
  "reception",
  "corporate",
  "conference",
  "birthday",
  "photoshoot",
  "other",
] as const;
export type EventType = (typeof eventTypeValues)[number];

/** The statuses that actually oblige the venue to staff something. */
export const EVENT_LIVE_STATUSES: readonly EventStatus[] = ["enquiry", "confirmed"];

export const eventSchema = z.object({
  id: dbUuid,
  event_code: z.string(),
  title: z.string(),
  client_name: z.string().nullable(),
  event_type: z.string(),
  location_id: dbUuidNullable,
  guest_count_expected: dbIntNullable,
  guest_count_actual: dbIntNullable,
  call_time_at: dbTimestampNullable,
  starts_at: dbTimestamp,
  ends_at: dbTimestamp,
  status: z.string(),
  notes: z.string().nullable(),
  created_at: dbTimestamp,
});
export type EventRow = z.infer<typeof eventSchema>;

export const eventCoverageSchema = z.object({
  event_id: dbUuid,
  event_code: z.string(),
  title: z.string(),
  status: z.string(),
  starts_at: dbTimestamp,
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  required_headcount: dbInt,
  rostered_headcount: dbInt,
  /* GREATEST(required - rostered, 0) in Postgres — never negative, and never
     recomputed here. Over-rostering is not a shortfall. */
  short_by: dbInt,
});
export type EventCoverageRow = z.infer<typeof eventCoverageSchema>;

const EVENT_COLUMNS =
  "id, event_code, title, client_name, event_type, location_id, guest_count_expected, " +
  "guest_count_actual, call_time_at, starts_at, ends_at, status, notes, created_at";

export interface EventFilters {
  /** Inclusive instants bounding `starts_at`. */
  readonly from?: string;
  readonly to?: string;
  readonly statuses?: readonly string[];
  /** Cancelled bookings are hidden unless asked for — they staff nobody. */
  readonly includeCancelled?: boolean;
}

/** The ONE predicate builder. Tiles and grid share it, so they cannot disagree. */
export function eventFilters(f: EventFilters): Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.from !== undefined) filters.push(gte("starts_at", f.from));
  if (f.to !== undefined) filters.push(lte("starts_at", f.to));
  if (f.statuses !== undefined && f.statuses.length > 0) {
    filters.push(inList("status", f.statuses));
  } else if (f.includeCancelled !== true) {
    filters.push(inList("status", ["enquiry", "confirmed", "completed"]));
  }
  return filters;
}

/**
 * The diary, soonest first.
 *
 * Ascending, unlike most registers in this product: an event register is read to
 * find out what is coming, and burying next Saturday under last March's wedding
 * would make the screen useless for the one job it has.
 */
export function fetchEvents(
  f: EventFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<EventRow[]> {
  return selectMany(EVENTS_TABLE, eventSchema, {
    columns: EVENT_COLUMNS,
    filters: eventFilters(f),
    order: [{ column: "starts_at", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countEvents(f: EventFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(EVENTS_TABLE, eventFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * Rostered against required, per event and department.
 *
 * Read from `v_event_coverage` rather than joined here: the department lives on
 * the PARENT roster, not on the slot, and attributing a slot to a department
 * through the wrong side of that join is how a coverage figure ends up counting
 * the whole venue against one department's requirement. One definition, in the
 * database, for every screen that needs it.
 */
export function fetchEventCoverage(
  f: EventFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<EventCoverageRow[]> {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("starts_at", f.from));
  if (f.to !== undefined) filters.push(lte("starts_at", f.to));
  if (f.includeCancelled !== true) {
    filters.push(inList("status", ["enquiry", "confirmed", "completed"]));
  }
  return selectMany(EVENT_COVERAGE_VIEW, eventCoverageSchema, {
    filters,
    order: [{ column: "starts_at", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export interface CreateEventInput {
  readonly companyId: string;
  readonly eventCode: string;
  readonly title: string;
  readonly clientName: string | null;
  readonly eventType: string;
  readonly locationId: string | null;
  readonly guestCountExpected: number | null;
  readonly callTimeAt: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly notes: string | null;
}

/**
 * Book an event.
 *
 * A plain insert, because `events__admin_write` is `FOR ALL` to an admin and
 * every rule worth enforcing is a CHECK on the table — the span, the call time
 * ordering, the guest counts, the status and type vocabularies. There is nothing
 * left for an RPC to decide, and an RPC that only repeated the constraints would
 * be a second place for them to drift.
 *
 * No `x-reason`: `events` is not in `audit.reason_required_tables`, and adding a
 * mandatory sentence to booking a wedding would be friction with no reader. Who
 * created it and when are stamped by `util.stamp_row` either way.
 */
export function createEvent(input: CreateEventInput, signal?: AbortSignal): Promise<EventRow> {
  return insertOne(
    EVENTS_TABLE,
    eventSchema,
    {
      company_id: input.companyId,
      event_code: input.eventCode.trim(),
      title: input.title.trim(),
      client_name: input.clientName === null ? null : input.clientName.trim(),
      event_type: input.eventType,
      location_id: input.locationId,
      guest_count_expected: input.guestCountExpected,
      call_time_at: input.callTimeAt,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      status: input.status,
      notes: input.notes === null ? null : input.notes.trim(),
    },
    { columns: EVENT_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 4. Rostering against a booking
// -----------------------------------------------------------------------------
//
// Migration 043500. Until it ran, `roster_slots.event_id` had a foreign key and
// no writer, so every `rostered_headcount` in `v_event_coverage` was zero and
// four screens said so.

export const ATTACH_ROSTER_DAY_FN = "attach_roster_day_to_event";
export const DETACH_ROSTER_DAY_FN = "detach_roster_day_from_event";
export const ROSTER_DAY_EVENTS_VIEW = "v_roster_day_events";

export const rosterDayEventSchema = z.object({
  roster_id: dbUuid,
  slot_date: dbDate,
  event_id: dbUuid,
  event_code: z.string(),
  title: z.string(),
  status: z.string(),
  slots_attached: dbInt,
});
export type RosterDayEvent = z.infer<typeof rosterDayEventSchema>;

/** What each day of one roster is working towards, grouped by Postgres. */
export function fetchRosterDayEvents(
  rosterIds: readonly string[],
  signal?: AbortSignal,
): Promise<RosterDayEvent[]> {
  if (rosterIds.length === 0) return Promise.resolve([]);
  return selectMany(ROSTER_DAY_EVENTS_VIEW, rosterDayEventSchema, {
    filters: [inList("roster_id", rosterIds)],
    order: [{ column: "slot_date", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Attach every working slot on one rostered day to one event.
 *
 * Returns how many slots moved, which the caller reports — "12 people are now on
 * the Sharma wedding" is the confirmation, and a zero means they already were.
 *
 * A day, not a slot: a venue says "everyone on Saturday is on the wedding", and
 * doing that forty times is forty chances to stop halfway and leave a roster
 * half-attributed. The function does the whole day in one statement.
 */
export async function attachRosterDayToEvent(
  rosterId: string,
  slotDate: string,
  eventId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<number> {
  const rows = await rpcAudited(
    ATTACH_ROSTER_DAY_FN,
    { p_roster_id: rosterId, p_slot_date: slotDate, p_event_id: eventId },
    dbInt,
    { reason, ...(signal ? { signal } : {}) },
  );
  return rows[0] ?? 0;
}

/** Clear the event from every slot on one rostered day. */
export async function detachRosterDayFromEvent(
  rosterId: string,
  slotDate: string,
  reason: string,
  signal?: AbortSignal,
): Promise<number> {
  const rows = await rpcAudited(
    DETACH_ROSTER_DAY_FN,
    { p_roster_id: rosterId, p_slot_date: slotDate },
    dbInt,
    { reason, ...(signal ? { signal } : {}) },
  );
  return rows[0] ?? 0;
}
