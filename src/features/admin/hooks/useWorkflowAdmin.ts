/**
 * useWorkflowAdmin — the query layer behind the five §12 screens
 * (/admin/workflow/inbox · designer · delegations · sla · overrides).
 *
 * Four rules kept HERE so that five pages cannot each get them slightly wrong:
 *
 *  1. EVERY TOTAL IS POSTGRES'S. Each count hook is handed the SAME filter
 *     object as the list hook beside it, and `workflow-admin.api.ts` builds both
 *     requests from one predicate builder (`inboxFilters`, `breachFilters`,
 *     `overrideFilters`, `delegationFilters`). A tile therefore cannot disagree
 *     with the grid it opens: the number IS the cardinality of those rows, not
 *     `rows.length` after a page, a cap or a slow fetch (DR-29).
 *  2. KEYSET PAGING, NEVER OFFSET. The inbox and the override log are written
 *     underneath the reader — `act_on_approval` and `sla_sweep` both append while
 *     an admin scrolls — and OFFSET paging over a shifting set repeats and skips
 *     rows.
 *  3. NO OPTIMISTIC WRITES. The decision mutation invalidates and re-reads.
 *     Status, level, `current_approver_ids`, the breach rows and (for leave) the
 *     balance are all rewritten by SECURITY DEFINER code inside the decision's
 *     own transaction; a client-side guess at the post-decision state is exactly
 *     how a console starts lying.
 *  4. LABELS ARE JOINS, NOT GUESSES. Actor and subject names resolve through
 *     `v_employee_ref`, keyed by ids already on screen. Nothing here derives,
 *     sums or averages a business figure.
 *
 * The query keys all descend from the ONE factory (`qk.admin.approvalInbox()` /
 * `qk.admin.approvalSla()`), including the shared `workflowRootKey` prefix that
 * a decision invalidates — no hand-written key arrays.
 */
import { useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { useAuth } from "@/app/auth/AuthProvider";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  BREACH_ID_CAP,
  DECIDED_BY_ME_CAP,
  fetchRequestIdsDecidedBy,
  countApprovalChains,
  countApprovalRequests,
  countApprovalSlaRows,
  countDelegations,
  countOverrideActions,
  countSlaBreaches,
  decideApproval,
  endDelegation,
  fetchApprovalChains,
  fetchApprovalRequests,
  fetchApprovalSla,
  fetchApprovalTrail,
  fetchChainLevels,
  fetchDelegations,
  fetchOpenBreachRequestIds,
  fetchOverrideActions,
  fetchPeopleByEmployeeIds,
  fetchPeopleByProfileIds,
  fetchRequestRefs,
  fetchRequestTypes,
  fetchSlaBreaches,
  INBOX_PAGE_SIZE,
  OVERRIDE_PAGE_SIZE,
  type ApprovalChain,
  type ApprovalChainLevel,
  type ApprovalDecisionInput,
  type ApprovalDecisionResult,
  type ApprovalRequestRow,
  type ApprovalSlaRow,
  type ApprovalTrail,
  type BreachFilters,
  type ChainFilters,
  type Delegation,
  type DelegationFilters,
  type EndDelegationInput,
  type InboxFilters,
  type OverrideAction,
  type OverrideFilters,
  type PersonRef,
  type RequestRef,
  type RequestType,
  type SlaBreach,
  type SlaFilters,
} from "../api/workflow-admin.api";

// -----------------------------------------------------------------------------
// Keys — all derived from the ONE factory, never hand-written
// -----------------------------------------------------------------------------

const INBOX_KEY = qk.admin.approvalInbox();
const SLA_KEY = qk.admin.approvalSla();

/**
 * `["admin", "workflow"]` — the widest prefix that is correct for all five
 * screens, taken from the factory's own inbox key rather than retyped. A
 * decision or a delegation change invalidates this, because the inbox, the SLA
 * register, the breach counts and the override log are all views of the rows
 * that transaction just wrote.
 */
export const workflowRootKey = [INBOX_KEY[0], INBOX_KEY[1]] as const;

/** A live console should not need a page reload; the sweep runs every 30 min. */
export const WORKFLOW_REFETCH_MS = 60_000;

// -----------------------------------------------------------------------------
// 1. Request types — the shared filter vocabulary
// -----------------------------------------------------------------------------

export function useRequestTypes(): UseQueryResult<RequestType[], Error> {
  return useQuery({
    queryKey: [...workflowRootKey, "request-types"],
    queryFn: ({ signal }) => fetchRequestTypes(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export type RequestTypeMap = ReadonlyMap<string, RequestType>;

/** `request_types.id` → the type, for the name beside every request. */
export function useRequestTypeMap(rows: readonly RequestType[] | undefined): RequestTypeMap {
  return useMemo(() => {
    const map = new Map<string, RequestType>();
    for (const row of rows ?? []) map.set(row.id, row);
    return map;
  }, [rows]);
}

// -----------------------------------------------------------------------------
// 2. People labels — an id on an evidence surface must resolve to a person
// -----------------------------------------------------------------------------

export type PersonRefMap = ReadonlyMap<string, PersonRef>;

function toMap(rows: readonly PersonRef[], key: (r: PersonRef) => string | null): PersonRefMap {
  const map = new Map<string, PersonRef>();
  for (const row of rows) {
    const k = key(row);
    if (k !== null) map.set(k, row);
  }
  return map;
}

/** `employees.id` → person. Used for subjects, approvers and escalation targets. */
export function usePeopleByEmployeeId(
  employeeIds: readonly string[],
): UseQueryResult<PersonRefMap, Error> {
  const ids = useMemo(() => [...new Set(employeeIds)].sort(), [employeeIds]);
  return useQuery({
    queryKey: [...workflowRootKey, "people-by-employee", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }) => toMap(await fetchPeopleByEmployeeIds(ids, signal), (r) => r.id),
  });
}

/** `profiles.id` → person. The only way to name an actor or a delegation end. */
export function usePeopleByProfileId(
  profileIds: readonly string[],
): UseQueryResult<PersonRefMap, Error> {
  const ids = useMemo(() => [...new Set(profileIds)].sort(), [profileIds]);
  return useQuery({
    queryKey: [...workflowRootKey, "people-by-profile", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }) =>
      toMap(await fetchPeopleByProfileIds(ids, signal), (r) => r.profile_id),
  });
}

// -----------------------------------------------------------------------------
// 3. The organisation-wide inbox
// -----------------------------------------------------------------------------

function inboxKeyParts(f: InboxFilters): Record<string, unknown> {
  return {
    slice: f.slice,
    requestTypeId: f.requestTypeId ?? "",
    status: f.status ?? "",
    priority: f.priority ?? "",
    approver: f.approverEmployeeId ?? "",
    // The breach slice's id set IS part of the predicate, so it is part of the key.
    breached: [...(f.breachedRequestIds ?? [])].sort(),
  };
}

export type InboxInfinite = UseInfiniteQueryResult<
  { pages: Page<ApprovalRequestRow>[]; pageParams: unknown[] },
  Error
>;

export function flattenInbox(
  data: { pages: Page<ApprovalRequestRow>[] } | undefined,
): readonly ApprovalRequestRow[] {
  if (data === undefined) return [];
  const out: ApprovalRequestRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

export function useApprovalRequests(
  f: InboxFilters,
  pageSize = INBOX_PAGE_SIZE,
): InboxInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    queryKey: [...INBOX_KEY, "rows", { ...inboxKeyParts(f), pageSize }],
    queryFn: ({ pageParam, signal }) => fetchApprovalRequests(f, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: WORKFLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** One tile, counted by Postgres over the tile's own predicate. */
export function useApprovalRequestCount(f: InboxFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...qk.admin.approvalInboxCount(), inboxKeyParts(f)],
    queryFn: ({ signal }) => countApprovalRequests(f, signal),
    refetchInterval: WORKFLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * The requests currently carrying an unresolved `sla_breaches` row.
 *
 * This is the ONLY honest org-wide "late" predicate available: `sla_sweep()`
 * records those rows on the server's clock (see the api header, gap 1). The
 * screen must say that the slice is as fresh as the last sweep.
 */
export function useOpenBreachRequestIds(): UseQueryResult<string[], Error> {
  return useQuery({
    queryKey: [...SLA_KEY, "open-breach-ids", BREACH_ID_CAP],
    queryFn: ({ signal }) => fetchOpenBreachRequestIds(BREACH_ID_CAP, signal),
    refetchInterval: WORKFLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * Every request the signed-in approver has acted on.
 *
 * Keyed by the PROFILE id, because `approval_actions.actor_id` is a profile —
 * the same person's employee id answers "waiting on me", and mixing the two is
 * how a slice silently returns nothing.
 */
export function useRequestIdsDecidedByMe(): UseQueryResult<string[], Error> {
  const { user } = useAuth();
  const profileId = user?.id ?? null;
  return useQuery({
    queryKey: [...SLA_KEY, "decided-by-me", profileId ?? "none", DECIDED_BY_ME_CAP],
    queryFn: ({ signal }) => fetchRequestIdsDecidedBy(profileId ?? "", signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
  });
}

/** The append-only trail of one request. Only fetched once a row is opened. */
export function useApprovalTrail(
  approvalRequestId: string | null,
): UseQueryResult<ApprovalTrail, Error> {
  return useQuery({
    queryKey: [...INBOX_KEY, "trail", approvalRequestId ?? "none"],
    enabled: approvalRequestId !== null,
    queryFn: ({ signal }) => fetchApprovalTrail(approvalRequestId ?? "", signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Approve or reject, with a typed reason of at least 15 characters.
 *
 * The write itself is `features/team`'s `decideApproval` — `act_on_approval`
 * plus the settled-outcome reporting — reused rather than reimplemented. The
 * server re-asserts authorisation inside the SECURITY DEFINER function: it
 * refuses a non-approver, a self-approval, a second approval of the same level
 * by the same actor, and a rejection with no comment. The console's own
 * per-row check is an AFFORDANCE, never the boundary.
 */
export function useDecideApproval(
  onDone: (result: ApprovalDecisionResult, input: ApprovalDecisionInput) => void,
): AuditedMutationResult<ApprovalDecisionResult, ApprovalDecisionInput> {
  return useAuditedMutation<ApprovalDecisionResult, ApprovalDecisionInput>({
    mutationFn: (input, reason) => decideApproval(input, reason),
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [
      workflowRootKey,
      qk.approvals.all,
      qk.team.all,
      qk.leave.all,
      qk.home.all,
      qk.admin.leaveAll(),
    ],
    onSuccess: (result, input) => onDone(result, input),
  });
}

/** The requests named by a register row (breach, override), keyed by id. */
export function useRequestRefs(ids: readonly string[]): UseQueryResult<
  ReadonlyMap<string, RequestRef>,
  Error
> {
  const keyIds = useMemo(() => [...new Set(ids)].sort(), [ids]);
  return useQuery({
    queryKey: [...INBOX_KEY, "request-refs", keyIds],
    enabled: keyIds.length > 0,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }) => {
      const rows = await fetchRequestRefs(keyIds, signal);
      const map = new Map<string, RequestRef>();
      for (const row of rows) map.set(row.id, row);
      return map as ReadonlyMap<string, RequestRef>;
    },
  });
}

// -----------------------------------------------------------------------------
// 4. Chains + levels — /admin/workflow/designer
// -----------------------------------------------------------------------------

function chainKeyParts(f: ChainFilters): Record<string, unknown> {
  return {
    requestTypeId: f.requestTypeId ?? "",
    includeInactive: f.includeInactive === true,
  };
}

export function useApprovalChains(f: ChainFilters): UseQueryResult<ApprovalChain[], Error> {
  return useQuery({
    queryKey: [...workflowRootKey, "chains", chainKeyParts(f)],
    queryFn: ({ signal }) => fetchApprovalChains(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useApprovalChainCount(f: ChainFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...workflowRootKey, "chains", "count", chainKeyParts(f)],
    queryFn: ({ signal }) => countApprovalChains(f, signal),
    retry: shouldRetryQuery,
  });
}

export interface ChainLevels {
  readonly levels: readonly ApprovalChainLevel[];
  /** `approval_chains.id` → its levels, in level order. */
  readonly byChain: ReadonlyMap<string, readonly ApprovalChainLevel[]>;
}

export function useChainLevels(
  chainIds: readonly string[],
): UseQueryResult<ChainLevels, Error> {
  const ids = useMemo(() => [...new Set(chainIds)].sort(), [chainIds]);
  return useQuery({
    queryKey: [...workflowRootKey, "chain-levels", ids],
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<ChainLevels> => {
      const levels = await fetchChainLevels(ids, signal);
      const byChain = new Map<string, ApprovalChainLevel[]>();
      for (const level of levels) {
        const bucket = byChain.get(level.approval_chain_id);
        if (bucket === undefined) byChain.set(level.approval_chain_id, [level]);
        else bucket.push(level);
      }
      return { levels, byChain };
    },
  });
}

// -----------------------------------------------------------------------------
// 5. Delegations — /admin/workflow/delegations
// -----------------------------------------------------------------------------

function delegationKeyParts(f: DelegationFilters): Record<string, unknown> {
  return {
    slice: f.slice,
    scope: f.scope ?? "",
    requestTypeId: f.requestTypeId ?? "",
  };
}

export function useDelegations(f: DelegationFilters): UseQueryResult<Delegation[], Error> {
  return useQuery({
    queryKey: [...workflowRootKey, "delegations", delegationKeyParts(f)],
    queryFn: ({ signal }) => fetchDelegations(f, undefined, signal),
    retry: shouldRetryQuery,
  });
}

export function useDelegationCount(f: DelegationFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...workflowRootKey, "delegations", "count", delegationKeyParts(f)],
    queryFn: ({ signal }) => countDelegations(f, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * End a delegation. 15 characters, because handing approval authority back is a
 * governance act and "done" is not a reason. The row is never deleted: the trail
 * (`approval_actions.delegated_from`) points at decisions taken under it.
 */
export function useEndDelegation(
  onDone: (row: Delegation) => void,
): AuditedMutationResult<Delegation, EndDelegationInput> {
  return useAuditedMutation<Delegation, EndDelegationInput>({
    mutationFn: (input, reason) => endDelegation(input, reason),
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [workflowRootKey],
    onSuccess: (row) => onDone(row),
  });
}

// -----------------------------------------------------------------------------
// 6. SLA compliance + the breach register — /admin/workflow/sla
// -----------------------------------------------------------------------------

function slaKeyParts(f: SlaFilters): Record<string, unknown> {
  return {
    requestTypeId: f.requestTypeId ?? "",
    approver: f.approverEmployeeId ?? "",
  };
}

export function useApprovalSla(f: SlaFilters): UseQueryResult<ApprovalSlaRow[], Error> {
  return useQuery({
    queryKey: [...SLA_KEY, "rows", slaKeyParts(f)],
    queryFn: ({ signal }) => fetchApprovalSla(f, undefined, signal),
    retry: shouldRetryQuery,
  });
}

export function useApprovalSlaCount(f: SlaFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...SLA_KEY, "rows", "count", slaKeyParts(f)],
    queryFn: ({ signal }) => countApprovalSlaRows(f, signal),
    retry: shouldRetryQuery,
  });
}

function breachKeyParts(f: BreachFilters): Record<string, unknown> {
  return { slice: f.slice, approver: f.approverEmployeeId ?? "" };
}

export function useSlaBreaches(f: BreachFilters): UseQueryResult<SlaBreach[], Error> {
  return useQuery({
    queryKey: [...SLA_KEY, "breaches", breachKeyParts(f)],
    queryFn: ({ signal }) => fetchSlaBreaches(f, undefined, signal),
    refetchInterval: WORKFLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

export function useSlaBreachCount(f: BreachFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...SLA_KEY, "breaches", "count", breachKeyParts(f)],
    queryFn: ({ signal }) => countSlaBreaches(f, signal),
    refetchInterval: WORKFLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 7. The Override Log — /admin/workflow/overrides
// -----------------------------------------------------------------------------

function overrideKeyParts(f: OverrideFilters): Record<string, unknown> {
  return { kind: f.kind, from: f.fromDate ?? "", to: f.toDate ?? "" };
}

export type OverrideInfinite = UseInfiniteQueryResult<
  { pages: Page<OverrideAction>[]; pageParams: unknown[] },
  Error
>;

export function flattenOverrides(
  data: { pages: Page<OverrideAction>[] } | undefined,
): readonly OverrideAction[] {
  if (data === undefined) return [];
  const out: OverrideAction[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

export function useOverrideActions(
  f: OverrideFilters,
  pageSize = OVERRIDE_PAGE_SIZE,
): OverrideInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    queryKey: [...workflowRootKey, "overrides", { ...overrideKeyParts(f), pageSize }],
    queryFn: ({ pageParam, signal }) => fetchOverrideActions(f, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    retry: shouldRetryQuery,
  });
}

export function useOverrideCount(f: OverrideFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...workflowRootKey, "overrides", "count", overrideKeyParts(f)],
    queryFn: ({ signal }) => countOverrideActions(f, signal),
    retry: shouldRetryQuery,
  });
}
