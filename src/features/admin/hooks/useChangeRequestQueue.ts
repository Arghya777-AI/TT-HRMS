/**
 * useChangeRequestQueue — data layer for /admin/people/changes.
 *
 * The queue, its server counts (the SAME predicate builder as the rows, DR-29),
 * the governing workflow rows, and the decision mutation.
 *
 * NO NEW QUERY KEYS ARE INVENTED — `shared/api/keys.ts` is shared and a feature
 * must not edit it. Every read here composes `qk.admin.employees({ area, … })`,
 * which sits under the `["admin","employees"]` prefix on purpose: deciding a
 * change request EDITS THE EMPLOYEE RECORD, so one
 * `invalidateQueries(qk.admin.employeesAll())` refreshes this queue, the
 * directory, the Employee 360 and that employee's field-level audit trail
 * together. A queue that says "applied" beside a 360 still showing the old
 * number is the `7 vs 8` defect.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  countChangeQueue,
  decideChangeRequest,
  fetchChangeQueue,
  fetchGoverningRequests,
  type ChangeDecisionResult,
  type ChangeQueueFilters,
  type ChangeRequestRow,
  type DecideChangeInput,
  type GoverningRequest,
} from "../api/change-requests.api";

/** Serialisable, order-stable shape of the filters — the cache key's body. */
function queueKey(f: ChangeQueueFilters): Record<string, unknown> {
  return {
    area: "change-requests",
    statuses: [...(f.statuses ?? [])].sort(),
    tables: [...(f.entityTables ?? [])].sort(),
    sensitive: f.sensitiveOnly === true,
    notApplied: f.notApplied === true,
    appliedOnly: f.appliedOnly === true,
    failedOnly: f.failedOnly === true,
    since: f.since ?? "",
  };
}

export function useChangeQueue(
  f: ChangeQueueFilters,
): UseQueryResult<ChangeRequestRow[], Error> {
  return useQuery({
    queryKey: qk.admin.employees({ ...queueKey(f), view: "rows" }),
    queryFn: ({ signal }) => fetchChangeQueue(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useChangeQueueCount(f: ChangeQueueFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.employees({ ...queueKey(f), view: "count" }),
    queryFn: ({ signal }) => countChangeQueue(f, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The workflow request governing each row on screen, indexed by change-request
 * id. Carries the employee's typed sentence (there is no reason column on
 * `employee_change_requests`) and whether the chain is still open — which is
 * what migration 062 checks before it will let a decision through.
 */
export function useGoverningRequests(rows: readonly ChangeRequestRow[]): {
  query: UseQueryResult<GoverningRequest[], Error>;
  byChangeRequest: ReadonlyMap<string, GoverningRequest>;
} {
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const key = useMemo(() => [...ids].sort(), [ids]);
  const query = useQuery({
    queryKey: qk.admin.employees({ area: "change-requests", view: "governing", ids: key }),
    queryFn: ({ signal }) => fetchGoverningRequests(ids, signal),
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
  });
  const byChangeRequest = useMemo(() => {
    const map = new Map<string, GoverningRequest>();
    // Newest submission wins: the read is ordered submitted_at DESC, so the
    // first row seen for a detail id is the current one.
    for (const row of query.data ?? []) {
      if (!map.has(row.detail_id)) map.set(row.detail_id, row);
    }
    return map;
  }, [query.data]);
  return { query, byChangeRequest };
}

/**
 * The decision. `decide_change_request` stamps the row and calls
 * `apply_change_request` in one transaction, so the employee master may have
 * changed — hence the widest correct prefix.
 */
export function useDecideChangeRequest(): AuditedMutationResult<
  ChangeDecisionResult,
  DecideChangeInput
> {
  return useAuditedMutation<ChangeDecisionResult, DecideChangeInput>({
    mutationFn: (input, reason) => decideChangeRequest(input, reason),
    // The governing-request read lives under the same prefix, so this one
    // invalidation refreshes the chain chips too. `approval_requests` itself is
    // never written here — 062 refuses to decide while a chain is still open.
    invalidate: [qk.admin.employeesAll()],
    // Matches the server floor in 062 and the regularisation queue's rule.
    minReasonLength: 10,
  });
}
