/**
 * useRegularizationQueue — data layer for /admin/attendance/regularisations.
 *
 * The queue, its server counts (same predicate builder as the rows, DR-29),
 * the day-as-it-stands context, and the decision mutation. Deciding invalidates
 * the queue AND the admin attendance keys: approval creates punches and
 * recomputes the day, so the punch log, day records and exception queue all
 * changed in the same transaction.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  countRegularizationQueue,
  decideRegularization,
  fetchDaysNow,
  fetchRegularizationQueue,
  type DayNow,
  type DecideInput,
  type DecisionResult,
  type Regularization,
  type RegularizationQueueFilters,
} from "../api/regularizations-admin.api";

function queueKey(f: RegularizationQueueFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    kinds: [...(f.kinds ?? [])].sort(),
    employees: [...(f.employeeIds ?? [])].sort(),
    from: f.from ?? "",
    to: f.to ?? "",
  };
}

export function useRegularizationQueue(
  f: RegularizationQueueFilters,
): UseQueryResult<Regularization[], Error> {
  return useQuery({
    queryKey: qk.admin.regularizations({ ...queueKey(f), view: "rows" }),
    queryFn: ({ signal }) => fetchRegularizationQueue(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useRegularizationCount(
  f: RegularizationQueueFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.regularizations({ ...queueKey(f), view: "count" }),
    queryFn: ({ signal }) => countRegularizationQueue(f, signal),
    retry: shouldRetryQuery,
  });
}

/** The engine's CURRENT day per request on screen, indexed by employee|date. */
export function useDaysNow(rows: readonly Regularization[]): {
  query: UseQueryResult<DayNow[], Error>;
  byPair: ReadonlyMap<string, DayNow>;
} {
  const pairs = useMemo(
    () => rows.map((r) => ({ employeeId: r.employee_id, istDate: r.ist_date })),
    [rows],
  );
  const key = useMemo(
    () => pairs.map((p) => `${p.employeeId}|${p.istDate}`).sort(),
    [pairs],
  );
  const query = useQuery({
    queryKey: qk.admin.regularizations({ view: "days-now", pairs: key }),
    queryFn: ({ signal }) => fetchDaysNow(pairs, signal),
    enabled: pairs.length > 0,
    retry: shouldRetryQuery,
  });
  const byPair = useMemo(() => {
    const map = new Map<string, DayNow>();
    for (const d of query.data ?? []) map.set(`${d.employee_id}|${d.ist_date}`, d);
    return map;
  }, [query.data]);
  return { query, byPair };
}

export function useDecideRegularization(): AuditedMutationResult<DecisionResult, DecideInput> {
  return useAuditedMutation<DecisionResult, DecideInput>({
    mutationFn: (input, reason) => decideRegularization(input, reason),
    // Approval created punches and recomputed the day in the same transaction —
    // sweeping the whole admin attendance prefix refreshes the queue, the punch
    // log, the day records and the exception counts together.
    invalidate: [qk.admin.attendanceAll()],
    minReasonLength: 10,
  });
}
