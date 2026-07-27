/**
 * useRoster.ts — the ONLY hooks that read `roster_slots`, shared by the manager
 * roster week (/team/roster), the admin planner (/admin/attendance/roster) and
 * event coverage (/admin/attendance/coverage).
 *
 * Three rules this file holds so three screens cannot drift apart:
 *
 *  1. EVERY NUMBER IS POSTGRES'S. `useRosterSlotCount` passes the same
 *     `RosterSlotFilters` object as the list hook beside it, so a tile is the
 *     cardinality of exactly the rows the grid below it renders. Nothing here
 *     counts an array.
 *  2. THE HEADER READS ARE NOT REBUILT. `rosters` (one row per department-week,
 *     status, publisher) and the company-wide published-slot count already have
 *     hooks in `admin/hooks/useAttendanceRecords.ts` (`useRosters`,
 *     `useRosterCount`, `usePublishedRosterSlotCount`); the pages import those
 *     directly. This file adds slot-grain reads and nothing else.
 *  3. NO WRITE HOOK EXISTS, ON PURPOSE. There is no roster RPC and no roster edge
 *     function on this backend (migration 015 routes slot writes through one that
 *     was never deployed), so publishing a week is not offered anywhere. A
 *     mutation invented here would be the one thing worse than a missing button.
 *
 * Nothing in this file derives a business figure: it moves server rows and prints
 * server counts.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fetchShiftRefsByIds, type ShiftRef } from "../api/team.api";
import {
  countRosterSlots,
  fetchRosterSlots,
  ROSTER_SLOT_ROW_CAP,
  type RosterSlot,
  type RosterSlotFilters,
  type RosterSlotSlice,
} from "../api/roster.api";

/** One serialisable shape for the cache key, so two callers with the same
 * predicate share one entry (and one tile can never lag its own grid). */
function slotKey(f: RosterSlotFilters): Record<string, unknown> {
  return {
    view: "roster-slots",
    from: f.from,
    to: f.to,
    employees: [...(f.employeeIds ?? [])].sort(),
    roster: f.rosterId ?? null,
    slice: f.slice ?? "all",
  };
}

/**
 * Slot rows for a window.
 *
 * `enabled` is the caller's honesty switch, not an optimisation: a manager with
 * no reportees, or a planner with no roster selected, has nothing to ask for, and
 * an unscoped read would answer with whatever RLS happens to admit.
 */
export function useRosterSlots(
  filters: RosterSlotFilters,
  enabled: boolean,
  limit = ROSTER_SLOT_ROW_CAP,
): UseQueryResult<RosterSlot[], Error> {
  return useQuery({
    queryKey: qk.team.list({ ...slotKey(filters), limit }),
    enabled,
    queryFn: ({ signal }) => fetchRosterSlots(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * One tile's number. `slice` overrides whatever the filters carried, so a page
 * can render several tiles from a single base predicate.
 */
export function useRosterSlotCount(
  filters: RosterSlotFilters,
  slice: RosterSlotSlice | undefined,
  enabled: boolean,
): UseQueryResult<number, Error> {
  const withSlice: RosterSlotFilters = {
    from: filters.from,
    to: filters.to,
    ...(filters.employeeIds !== undefined ? { employeeIds: filters.employeeIds } : {}),
    ...(filters.rosterId !== undefined ? { rosterId: filters.rosterId } : {}),
    ...(slice !== undefined ? { slice } : {}),
  };
  return useQuery({
    queryKey: qk.team.list({ ...slotKey(withSlice), count: true }),
    enabled,
    queryFn: ({ signal }) => countRosterSlots(withSlice, signal),
    retry: shouldRetryQuery,
  });
}

export type ShiftRefMap = ReadonlyMap<string, ShiftRef>;

/**
 * `shift_id` → the shift master row, so a slot can print `BANQ-A` and its window
 * instead of a uuid. A join, not a computation; the shift master is small and
 * changes rarely, hence the long stale time.
 */
export function useRosterShifts(
  slots: readonly RosterSlot[] | undefined,
): UseQueryResult<ShiftRefMap, Error> {
  const shiftIds = useMemo(() => {
    const ids = new Set<string>();
    for (const slot of slots ?? []) if (slot.shift_id !== null) ids.add(slot.shift_id);
    return [...ids].sort();
  }, [slots]);

  return useQuery({
    queryKey: qk.team.list({ view: "roster-shifts", shifts: shiftIds }),
    enabled: shiftIds.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<ShiftRefMap> => {
      const rows = await fetchShiftRefsByIds(shiftIds, signal);
      const map = new Map<string, ShiftRef>();
      for (const row of rows) map.set(row.id, row);
      return map;
    },
  });
}

/**
 * Slots pivoted `employee_id → slot_date → slot`, for the week grid.
 *
 * This is PRESENTATION, the same call the team leave board makes when it groups
 * person-dates into a density strip: every rendered value is still the server's
 * own slot row, and no quantity is derived. `uq_roster_slots__employee_date`
 * guarantees one slot per person per date, so the inner map cannot lose a row.
 */
export interface RosterGrid {
  readonly byEmployee: ReadonlyMap<string, ReadonlyMap<string, RosterSlot>>;
  /** Employee ids present in the week, in the order the rows arrived. */
  readonly employeeIds: readonly string[];
}

export function useRosterGrid(slots: readonly RosterSlot[] | undefined): RosterGrid {
  return useMemo(() => {
    const byEmployee = new Map<string, Map<string, RosterSlot>>();
    const order: string[] = [];
    for (const slot of slots ?? []) {
      let row = byEmployee.get(slot.employee_id);
      if (row === undefined) {
        row = new Map<string, RosterSlot>();
        byEmployee.set(slot.employee_id, row);
        order.push(slot.employee_id);
      }
      row.set(slot.slot_date, slot);
    }
    return { byEmployee, employeeIds: order };
  }, [slots]);
}
