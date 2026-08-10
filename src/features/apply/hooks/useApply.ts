/**
 * useApply.ts — hooks for E-10 (the launcher and the four per-request screens),
 * plus E-11 (`/me/assets`). Keys from `qk.apply.*` / `qk.assets.*` only.
 *
 * `useMyOpenRequests` is deliberately shared with E-12's Tracking section: one
 * key, one payload, so the launcher and the approvals screen cannot show
 * different counts for the same requests.
 *
 * E-11's hooks live here rather than in a second file because this is the one
 * hook module this build owns; the reads themselves sit in
 * `features/assets/api/my-assets.api.ts` where they belong.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import {
  submitAssetRequest,
  submitDocumentRequest,
  submitResignation,
  submitTravelRequisition,
  type SubmitAssetRequestInput,
  type SubmitDocumentRequestInput,
  type SubmitResignationInput,
  type SubmitTravelInput,
} from "../api/simple-requests.api";
import {
  submitWebPunchRequest,
  type SubmittedWebPunch,
  type SubmitWebPunchInput,
} from "../api/web-punch-submit.api";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchMyOpenRequests,
  fetchRequestTypes,
  NO_EMPLOYEE,
  type MyOpenRequests,
  type RequestType,
} from "../api/apply.api";
import {
  fetchAssetCategories,
  fetchMyOpenRequestsOfType,
  fetchRequestRouting,
  fetchRequestTypeByCode,
  fetchWebPunchEntitlement,
  type AssetCategoryRef,
  type RequestRouting,
  type WebPunchEntitlement,
} from "../api/apply-requests.api";
import {
  fetchMyClaims,
  submitLocalClaim,
  type ClaimRow,
  type SubmitClaimInput,
  type SubmittedClaim,
} from "../api/claim-submit.api";
import {
  fetchMyCustody,
  fetchMyCustodyCounts,
  fetchMyPipelineAllocations,
  type CustodyRow,
  type CustodyView,
  type MyCustodyCounts,
  type PipelineAllocation,
} from "@/features/assets/api/my-assets.api";

/** The request types HR has switched on — the launcher tiles. */
export function useRequestTypes(): UseQueryResult<RequestType[], Error> {
  return useQuery({
    queryKey: qk.apply.list({ entity: "request-types" }),
    queryFn: ({ signal }) => fetchRequestTypes(signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/** Everything I have sent that nobody has decided yet. */
export function useMyOpenRequests(): UseQueryResult<MyOpenRequests, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: [...qk.apply.openRequests(), employeeId ?? NO_EMPLOYEE],
    queryFn: ({ signal }) => fetchMyOpenRequests(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// One request type, and the routing behind it
// -----------------------------------------------------------------------------

/**
 * The `request_types` row for one code, or `null` when HR has not switched it on
 * (`CERTIFICATION` has never existed to switch on). `null` is DATA — the screens
 * render it as the finding, not as a loading state.
 */
export function useRequestTypeByCode(code: string): UseQueryResult<RequestType | null, Error> {
  return useQuery({
    queryKey: qk.apply.detail(code),
    queryFn: ({ signal }) => fetchRequestTypeByCode(code, signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/**
 * Every approval chain configured for one request type, with its levels. An
 * empty `chains` array means `create_approval_request` cannot resolve a chain and
 * would raise — the screens prove that by reading, not by asserting.
 */
export function useRequestRouting(
  requestTypeId: string | undefined,
): UseQueryResult<RequestRouting, Error> {
  const id = requestTypeId ?? "";
  return useQuery({
    queryKey: qk.apply.list({ entity: "routing", requestTypeId: id }),
    queryFn: ({ signal }) => fetchRequestRouting(id, signal),
    enabled: id.length > 0,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/** My undecided requests of ONE type — the per-screen slice of the launcher list. */
export function useMyOpenRequestsOfType(
  requestTypeId: string | undefined,
): UseQueryResult<MyOpenRequests, Error> {
  const employeeId = useEmployeeId();
  const id = requestTypeId ?? "";
  return useQuery({
    queryKey: [...qk.apply.openRequests(), employeeId ?? NO_EMPLOYEE, id],
    queryFn: ({ signal }) =>
      fetchMyOpenRequestsOfType(requireEmployeeId(employeeId), id, signal),
    enabled: employeeId !== null && id.length > 0,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Web punch (E-10.1) — entitlement only; there is no request path to offer
// -----------------------------------------------------------------------------

/** Both server switches that a web punch would be checked against. */
export function useWebPunchEntitlement(): UseQueryResult<WebPunchEntitlement | null, Error> {
  return useQuery({
    queryKey: qk.apply.list({ entity: "web-punch-entitlement" }),
    queryFn: ({ signal }) => fetchWebPunchEntitlement(signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

// -----------------------------------------------------------------------------
// Asset request (E-10.4) — what Stores stocks
// -----------------------------------------------------------------------------

export function useAssetCategories(): UseQueryResult<AssetCategoryRef[], Error> {
  return useQuery({
    queryKey: qk.assets.list({ entity: "categories" }),
    queryFn: ({ signal }) => fetchAssetCategories(signal),
    retry: shouldRetryQuery,
    staleTime: 10 * 60_000,
  });
}

// -----------------------------------------------------------------------------
// Local claim (E-10.2) — the one submittable request of the four
// -----------------------------------------------------------------------------

/** My own claims, newest first, for the history strip under the form. */
export function useMyClaims(): UseQueryResult<ClaimRow[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.list({ entity: "my-claims", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyClaims(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Raise a local claim: claim row → line → `create_approval_request` → back-link.
 *
 * Invalidates the whole `apply` domain because one submit changes three lists —
 * my claims, my open requests of this type, and the launcher's open-request grid.
 * Nothing is patched optimistically: the claim number and the request number are
 * both minted by the server and only the server can report them.
 */
export function useSubmitLocalClaim(): UseMutationResult<
  SubmittedClaim,
  Error,
  Omit<SubmitClaimInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitClaimInput, "employeeId">) =>
      submitLocalClaim({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}

// -----------------------------------------------------------------------------
// My assets (E-11)
// -----------------------------------------------------------------------------

/** My open custody rows for one section of E-11. */
export function useMyCustody(view: CustodyView): UseQueryResult<CustodyRow[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.assets.list({ entity: "my-custody", employeeId: employeeId ?? NO_EMPLOYEE, view }),
    queryFn: ({ signal }) => fetchMyCustody(requireEmployeeId(employeeId), view, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** The four tile numbers, each `count=exact` from Postgres. */
export function useMyCustodyCounts(): UseQueryResult<MyCustodyCounts, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.assets.list({ entity: "my-custody-counts", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyCustodyCounts(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Allocations raised for me that Stores has not handed over yet. */
export function useMyPipelineAllocations(): UseQueryResult<PipelineAllocation[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.assets.list({ entity: "my-pipeline", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyPipelineAllocations(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Raise a web-punch request.
 *
 * Invalidates the whole `apply` domain: one submit changes this screen's own
 * list and the launcher's open-request grid. Nothing is patched optimistically —
 * the request number is minted by the server and only the server can report it.
 */
export function useSubmitWebPunchRequest(): UseMutationResult<
  SubmittedWebPunch,
  Error,
  Omit<SubmitWebPunchInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitWebPunchInput, "employeeId">) =>
      submitWebPunchRequest({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}

/** Raise a resignation. Same invalidation reasoning as every other request. */
export function useSubmitResignation(): UseMutationResult<
  { detailId: string; requestId: string },
  Error,
  Omit<SubmitResignationInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitResignationInput, "employeeId">) =>
      submitResignation({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}

/** Raise a travel requisition. */
export function useSubmitTravelRequisition(): UseMutationResult<
  { detailId: string; requestId: string },
  Error,
  Omit<SubmitTravelInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitTravelInput, "employeeId">) =>
      submitTravelRequisition({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}

/** Raise a document or payslip request. Routed by kind — see the api module. */
export function useSubmitDocumentRequest(): UseMutationResult<
  { detailId: string; requestId: string },
  Error,
  Omit<SubmitDocumentRequestInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitDocumentRequestInput, "employeeId">) =>
      submitDocumentRequest({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}

/** Raise an asset request against a category Stores actually stocks. */
export function useSubmitAssetRequest(): UseMutationResult<
  { detailId: string; requestId: string },
  Error,
  Omit<SubmitAssetRequestInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitAssetRequestInput, "employeeId">) =>
      submitAssetRequest({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}
