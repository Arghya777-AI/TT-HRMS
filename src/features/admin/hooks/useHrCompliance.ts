/**
 * useHrCompliance.ts — TanStack hooks for the Compliance & Operations panel.
 *
 * WHY THIS IS ELEVEN QUERIES AND NOT ONE
 * --------------------------------------
 * `useAnalytics.ts` gives every attendance panel the SAME query key and differs
 * only in `select`, because all four panels are projections of one array of day
 * rows. That is the right pattern there and the wrong one here: these sections
 * read nine different relations at five different grains, so there is no shared
 * page to project.
 *
 * The pattern IS applied wherever it holds — the four workforce measures
 * (statutory applicability, tax regime, profile completeness, biometric stamps)
 * are one read behind one key, and the document tiles and their drill-through
 * share one predicate builder in the api module so they cannot disagree.
 *
 * SEPARATE KEYS ALSO BUY PARTIAL FAILURE. A compliance panel that blanks
 * entirely because `v_kiosk_health` is unreachable has hidden nine working
 * sections to report one broken one. Each section wraps its own `StateBoundary`,
 * so a failure is contained to the block that failed and says which relation.
 *
 * EVERY KEY HANGS OFF AN EXISTING INVALIDATION PREFIX (`qk.admin.auditAll()`,
 * `systemAll()`, `employeesAll()`, `attendanceAll()`, `qk.assets.all`), so
 * verifying a document, approving an enrolment or returning an asset refreshes
 * this panel along with the screen that caused the change — instead of leaving a
 * compliance dashboard one refresh behind the compliance action.
 *
 * Nothing here mutates. A compliance panel reads.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { filtersToParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import {
  fetchApprovalBreaches,
  fetchAssetCustody,
  fetchDocumentComplianceSummary,
  fetchEnrolmentGaps,
  fetchExpiringDocuments,
  fetchGateHealth,
  fetchOpenExceptions,
  fetchOwnOverdueApprovals,
  fetchPolicyAcknowledgement,
  fetchUnacknowledgedPolicies,
  fetchWorkforceCompliance,
  type ApprovalBreachResult,
  type CustodyResult,
  type DocumentComplianceResult,
  type EnrolmentGapResult,
  type ExceptionResult,
  type ExpiringDocumentsResult,
  type GateHealthResult,
  type OwnOverdueResult,
  type PolicyAckResult,
  type UnacknowledgedResult,
  type WorkforceComplianceResult,
} from "../api/hr-compliance.api";

/**
 * A compliance snapshot is a report: it refetches when you come back to it, not
 * on a timer. The two genuinely operational sections — the exception queue and
 * the gate — get a shorter window because they answer "right now".
 */
const SNAPSHOT_STALE_MS = 60_000;
const OPERATIONAL_STALE_MS = 20_000;

/**
 * One key shape for the whole panel.
 *
 * `filtersToParams` is the SAME serialisation the URL uses, so two admins
 * looking at the same filtered view share a cache entry and a support engineer
 * can read the cache key off the address bar. `part` keeps the sections apart
 * under one prefix; passing `null` for filters marks a section the filter bar
 * cannot reach (see the api module's per-relation `DimensionSupport`).
 */
function panelKey(
  prefix: readonly unknown[],
  part: string,
  filters: AnalyticsFilters | null,
): readonly unknown[] {
  return [...prefix, "hr-compliance", part, filters === null ? null : filtersToParams(filters)];
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

/** Complete / missing / expired / expiring — five `count=exact` HEADs. */
export function useDocumentCompliance(
  filters: AnalyticsFilters,
): UseQueryResult<DocumentComplianceResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.auditAll(), "documents", filters),
    queryFn: ({ signal }) => fetchDocumentComplianceSummary(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** The action list: required documents lapsing inside the view's 60-day window. */
export function useExpiringDocuments(
  filters: AnalyticsFilters,
): UseQueryResult<ExpiringDocumentsResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.auditAll(), "documents-expiring", filters),
    queryFn: ({ signal }) => fetchExpiringDocuments(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Policies
// -----------------------------------------------------------------------------

/** Pooled acknowledgement rate + the worst-acknowledged policies. */
export function usePolicyAcknowledgement(
  filters: AnalyticsFilters,
): UseQueryResult<PolicyAckResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.auditAll(), "policy-ack", filters),
    queryFn: ({ signal }) => fetchPolicyAcknowledgement(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** WHO has not acknowledged — the per-person grain, soonest deadline first. */
export function useUnacknowledgedPolicies(
  filters: AnalyticsFilters,
): UseQueryResult<UnacknowledgedResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.auditAll(), "policy-open", filters),
    queryFn: ({ signal }) => fetchUnacknowledgedPolicies(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Biometrics + the gate
// -----------------------------------------------------------------------------

/** Who cannot use the gate and why — the view's own `gap_kind`, bucketed. */
export function useEnrolmentGaps(
  filters: AnalyticsFilters,
): UseQueryResult<EnrolmentGapResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.systemAll(), "enrolment-gaps", filters),
    queryFn: ({ signal }) => fetchEnrolmentGaps(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * Match rate, latency and offline replays over the selected period. The one
 * section the period filter actually narrows, and the shorter stale time is
 * because a gate that started failing ten minutes ago is news.
 */
export function useGateHealth(
  filters: AnalyticsFilters,
): UseQueryResult<GateHealthResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.systemAll(), "gate-health", filters),
    queryFn: ({ signal }) => fetchGateHealth(filters, { signal }),
    staleTime: OPERATIONAL_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Approvals
// -----------------------------------------------------------------------------

/**
 * SLA breaches per approver × request type. Keyed WITHOUT the filters: the
 * relation carries no date and no dimension the bar can reach, so keying by
 * filters would mint a fresh cache entry per period for an identical answer.
 */
export function useApprovalBreaches(
  filters: AnalyticsFilters,
): UseQueryResult<ApprovalBreachResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.approvalSla(), "breaches", null),
    queryFn: ({ signal }) => fetchApprovalBreaches(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** The CALLER'S own overdue decisions — `v_approval_inbox` is one person's queue. */
export function useOwnOverdueApprovals(): UseQueryResult<OwnOverdueResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.approvalInbox(), "own-overdue", null),
    queryFn: ({ signal }) => fetchOwnOverdueApprovals({ signal }),
    staleTime: OPERATIONAL_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Exceptions
// -----------------------------------------------------------------------------

/** The open queue: an exact total from Postgres plus a capped page to bucket. */
export function useOpenExceptions(
  filters: AnalyticsFilters,
): UseQueryResult<ExceptionResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.attendanceAll(), "exceptions", filters),
    queryFn: ({ signal }) => fetchOpenExceptions(filters, { signal }),
    staleTime: OPERATIONAL_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Workforce + assets
// -----------------------------------------------------------------------------

/**
 * ONE read of `v_admin_employee` behind FOUR measures — statutory applicability,
 * tax regime, profile completeness and biometric stamps. This is the shared-key
 * discipline of `useAnalytics.ts` applied where it actually holds: four
 * projections of one population, which therefore cannot disagree about how many
 * people there are.
 */
export function useWorkforceCompliance(
  filters: AnalyticsFilters,
): UseQueryResult<WorkforceComplianceResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.admin.employeesAll(), "workforce-compliance", filters),
    queryFn: ({ signal }) => fetchWorkforceCompliance(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** Open allocations tagged with whether the holder has left. Two reads, one key. */
export function useAssetCustody(
  filters: AnalyticsFilters,
): UseQueryResult<CustodyResult, Error> {
  return useQuery({
    queryKey: panelKey(qk.assets.all, "custody-holders", filters),
    queryFn: ({ signal }) => fetchAssetCustody(filters, { signal }),
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}
