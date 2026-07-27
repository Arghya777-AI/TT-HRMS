/**
 * useGovernance.ts — hooks for the DPDP pack (§13.7) and the retention console
 * (§13.8).
 *
 * Keys sit under `qk.admin.auditAll()` (`["admin","audit",…]`) for the DPDP reads
 * and under `qk.admin.jobRuns(...)` for the sweep history, so nothing here
 * invents a key prefix and one audit-domain invalidation refreshes the pack.
 *
 * `retry: shouldRetryQuery` throughout: `/admin/audit/retention` is a super-admin
 * surface, and a plain admin's `no_permission` on `export_log` (whose RLS hides
 * `subject = 'audit_log'` rows) is an honest answer that three more attempts will
 * not improve.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  fetchAccessKindCounts,
  fetchDocumentRetentionCounts,
  fetchDocumentsDueForPurge,
  fetchEgressCounts,
  fetchRetentionClasses,
  fetchRetentionRuns,
  type AccessKindCounts,
  type DocumentRetentionCounts,
  type EgressCounts,
  type RetentionClass,
  type RetentionDueDocument,
  type RetentionRun,
} from "../api/governance.api";

// -----------------------------------------------------------------------------
// 1. Retention
// -----------------------------------------------------------------------------

/** The per-document-type retention schedule — the only one held as data. */
export function useRetentionClasses(): UseQueryResult<RetentionClass[], Error> {
  return useQuery({
    queryKey: [...qk.admin.auditAll(), "retention", "classes"],
    queryFn: ({ signal }) => fetchRetentionClasses(100, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * Live / due / unstamped / archived document counts. `today` is the IST civil
 * date the caller resolved through `nowIstDate()`; it is part of the key so the
 * numbers cannot be served from yesterday's cache after the cutover.
 */
export function useDocumentRetentionCounts(
  today: string,
): UseQueryResult<DocumentRetentionCounts, Error> {
  return useQuery({
    queryKey: [...qk.admin.auditAll(), "retention", "document-counts", today],
    queryFn: ({ signal }) => fetchDocumentRetentionCounts(today, signal),
    retry: shouldRetryQuery,
  });
}

/** The purge candidates themselves, oldest retention date first. */
export function useDocumentsDueForPurge(
  today: string,
): UseQueryResult<RetentionDueDocument[], Error> {
  return useQuery({
    queryKey: [...qk.admin.auditAll(), "retention", "due", today],
    queryFn: ({ signal }) => fetchDocumentsDueForPurge(today, 100, signal),
    retry: shouldRetryQuery,
  });
}

/** Sweep history WITH the `result` payload — the evidence half of the screen. */
export function useRetentionRuns(
  jobCodes: readonly string[],
): UseQueryResult<RetentionRun[], Error> {
  return useQuery({
    queryKey: qk.admin.jobRuns({ codes: [...jobCodes].sort(), withResult: true }),
    queryFn: ({ signal }) => fetchRetentionRuns(jobCodes, 50, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2. DPDP
// -----------------------------------------------------------------------------

/**
 * Purpose-logged accesses by kind over an IST civil-date window. Five server
 * COUNTs; nothing is summed in the browser, and each tile's number is the
 * cardinality of exactly the predicate its drill-through link carries.
 */
export function useAccessKindCounts(
  from: string,
  to: string,
): UseQueryResult<AccessKindCounts, Error> {
  return useQuery({
    queryKey: [...qk.admin.dataAccess({ from, to }), "kind-counts"],
    queryFn: ({ signal }) => fetchAccessKindCounts(from, to, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Exports in the window and how many carried PII, salary or biometric data.
 * Bounds are INSTANTS (`exported_at` is a timestamptz) — see the api module.
 */
export function useEgressCounts(
  fromInstant: string,
  toInstant: string,
): UseQueryResult<EgressCounts, Error> {
  return useQuery({
    queryKey: [...qk.admin.auditExports({ fromInstant, toInstant }), "flag-counts"],
    queryFn: ({ signal }) => fetchEgressCounts(fromInstant, toInstant, signal),
    retry: shouldRetryQuery,
  });
}
