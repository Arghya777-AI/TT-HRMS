/**
 * useEventRegister.ts — the hooks behind `/admin/org/events`.
 *
 * Keys live under `qk.admin.orgList("eventRegister", …)`, i.e. the
 * `["admin","org",…]` prefix, so editing the holiday calendar on
 * `/admin/time/holidays` (which invalidates `qk.admin.orgAll()`) refreshes this
 * register too — the two screens read the same rows and must never disagree.
 *
 * The hooks below the holiday ones read `public.events`, which migration 043100
 * created — this file predates it and said, correctly at the time, that there was
 * no table to write to. There is now, so there is a write hook.
 *
 * The holiday rows are still edited on `/admin/time/holidays`, which already owns
 * that prompt-and-audit flow; nothing here duplicates it.
 */
import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { useAuditedMutation, type AuditedMutationResult } from "@/shared/hooks/useAuditedMutation";
import { shouldRetryQuery } from "@/shared/api/query";
import type { Holiday } from "../api/org.api";
import {
  DEMAND_DATE_CAP,
  countCompOffDays,
  countEventDays,
  countEventTaggedSlots,
  countOptionalEventDays,
  fetchDemandByDate,
  fetchEventDays,
  countEvents,
  createEvent,
  fetchEventCoverage,
  fetchEvents,
  type CreateEventInput,
  type EventCoverageRow,
  type EventDayFilters,
  type EventFilters,
  type EventRow,
  attachRosterDayToEvent,
  detachRosterDayFromEvent,
  fetchRosterDayEvents,
  type RosterDayEvent,
} from "../api/events.api";

/** Query keys must be plain data; `EventDayFilters` is an interface. */
function dayKey(f: EventDayFilters, part: string): Record<string, unknown> {
  return {
    part,
    calendar: f.calendarId,
    eventDrivenOnly: f.eventDrivenOnly !== false,
    includeWithdrawn: f.includeWithdrawn === true,
    from: f.from ?? "",
    to: f.to ?? "",
  };
}

/**
 * The register rows. `enabled` waits for a calendar: with none chosen there is
 * nothing to ask for, and an unfiltered read of `holidays` would mix every year
 * the venue has ever loaded into one list.
 */
export function useEventDays(
  filters: EventDayFilters,
  enabled: boolean,
): UseQueryResult<Holiday[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", dayKey(filters, "list")),
    enabled,
    queryFn: ({ signal }) => fetchEventDays(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useEventDayCount(
  filters: EventDayFilters,
  enabled: boolean,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", dayKey(filters, "count")),
    enabled,
    queryFn: ({ signal }) => countEventDays(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useCompOffDayCount(
  filters: EventDayFilters,
  enabled: boolean,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", dayKey(filters, "comp-off")),
    enabled,
    queryFn: ({ signal }) => countCompOffDays(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useOptionalEventDayCount(
  filters: EventDayFilters,
  enabled: boolean,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", dayKey(filters, "optional")),
    enabled,
    queryFn: ({ signal }) => countOptionalEventDays(filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Roster slots planned on each of these dates — one server count per date.
 *
 * `enabled` refuses a list longer than `DEMAND_DATE_CAP` rather than firing a
 * request per row of a long register; the column then states that instead of
 * showing a figure it could not read.
 */
export function useDemandByDate(
  dates: readonly string[],
): UseQueryResult<ReadonlyMap<string, number>, Error> {
  const list = useMemo(() => [...dates], [dates]);
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", { part: "demand", dates: list }),
    enabled: list.length > 0 && list.length <= DEMAND_DATE_CAP,
    queryFn: ({ signal }) => fetchDemandByDate(list, signal),
    retry: shouldRetryQuery,
  });
}

/** Roster slots carrying an `event_id` — the register's own honesty check. */
export function useEventTaggedSlotCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", { part: "tagged-slots" }),
    queryFn: ({ signal }) => countEventTaggedSlots(signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// The register itself — `public.events`
// -----------------------------------------------------------------------------

/** Query keys must be plain data; `EventFilters` is an interface. */
function eventKey(f: EventFilters, part: string): Record<string, unknown> {
  return {
    part,
    from: f.from ?? "",
    to: f.to ?? "",
    statuses: (f.statuses ?? []).join(","),
    includeCancelled: f.includeCancelled === true,
  };
}

/** The diary, soonest first. */
export function useEvents(filters: EventFilters): UseQueryResult<EventRow[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", eventKey(filters, "events")),
    queryFn: ({ signal }) => fetchEvents(filters, 200, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The same predicate, counted by Postgres.
 *
 * Its own query rather than `events.data.length`, because the list is capped at
 * 200 and a tile reading "200" beside a register that is actually holding 340
 * bookings is the disagreement this codebase keeps designing out.
 */
export function useEventCount(filters: EventFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", eventKey(filters, "count")),
    queryFn: ({ signal }) => countEvents(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** Rostered against required, from `v_event_coverage`. */
export function useEventCoverage(
  filters: EventFilters,
): UseQueryResult<EventCoverageRow[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", eventKey(filters, "coverage")),
    queryFn: ({ signal }) => fetchEventCoverage(filters, 200, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Book an event.
 *
 * Invalidates the whole org branch rather than this screen's key: a new booking
 * changes `v_event_coverage`, the roster planner's event picker and the coverage
 * screen, and a register that is right while the screen beside it is stale is
 * the same defect as a wrong number.
 */
export function useCreateEvent(): UseMutationResult<EventRow, Error, CreateEventInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) => createEvent(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.admin.orgAll() });
    },
    retry: false,
  });
}

// -----------------------------------------------------------------------------
// Rostering against a booking (043500)
// -----------------------------------------------------------------------------

/** What each day of these rosters is working towards. */
export function useRosterDayEvents(
  rosterIds: readonly string[],
): UseQueryResult<RosterDayEvent[], Error> {
  const key = [...rosterIds].sort().join(",");
  return useQuery({
    queryKey: qk.admin.orgList("eventRegister", { part: "rosterDays", key }),
    queryFn: ({ signal }) => fetchRosterDayEvents(rosterIds, signal),
    enabled: rosterIds.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * Attach or clear one rostered day.
 *
 * Invalidates the org AND team branches: the same fact is read by the event
 * register, the coverage screen and both roster screens, and a coverage figure
 * that is right on one of them while stale on another is the disagreement this
 * codebase keeps designing out.
 */
export function useSetRosterDayEvent(): AuditedMutationResult<
  number,
  {
    readonly rosterId: string;
    readonly slotDate: string;
    /** Null clears the day — a different function server-side, deliberately. */
    readonly eventId: string | null;
  }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) =>
      input.eventId === null
        ? detachRosterDayFromEvent(input.rosterId, input.slotDate, reason)
        : attachRosterDayToEvent(input.rosterId, input.slotDate, input.eventId, reason),
    invalidate: [qk.admin.all, qk.team.all],
  });
}
