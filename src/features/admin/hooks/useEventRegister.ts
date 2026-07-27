/**
 * useEventRegister.ts — the hooks behind `/admin/org/events`.
 *
 * Keys live under `qk.admin.orgList("eventRegister", …)`, i.e. the
 * `["admin","org",…]` prefix, so editing the holiday calendar on
 * `/admin/time/holidays` (which invalidates `qk.admin.orgAll()`) refreshes this
 * register too — the two screens read the same rows and must never disagree.
 *
 * Every hook here is a READ. There is no write hook because there is no
 * `public.events` table to write to (see the api module's header for the
 * evidence), and the holiday rows this screen renders are edited on
 * `/admin/time/holidays`, which already owns that prompt-and-audit flow.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
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
  type EventDayFilters,
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
