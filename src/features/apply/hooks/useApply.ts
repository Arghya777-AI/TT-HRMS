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
  fetchOpenResignation,
  submitAssetRequest,
  submitDocumentRequest,
  submitResignation,
  submitTravelRequisition,
  withdrawResignation,
  type SubmitAssetRequestInput,
  type SubmitDocumentRequestInput,
  type ResignationRow,
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
  countMyRequests,
  fetchMyOpenRequests,
  fetchMyRequests,
  fetchRequestTypes,
  NO_EMPLOYEE,
  type MyOpenRequests,
  type RequestSlice,
  type RequestType,
} from "../api/apply.api";
import { fetchApprovalTrail, type ApprovalTrail } from "@/features/team/api/team.api";
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
  fetchMyTaxDeclaration,
  saveTaxDeclaration,
  type SaveDeclarationInput,
  type TaxDeclaration,
} from "../api/tax-declaration.api";
import {
  fetchCertificationCatalogue,
  fetchMyCertificationClaims,
  submitCertificationClaim,
  type CertificationCatalogueEntry,
  type CertificationClaim,
  type SubmitCertificationClaimInput,
} from "../api/certification.api";
import {
  acknowledgeAsset,
  fetchMyCustody,
  fetchMyCustodyCounts,
  fetchMyPipelineAllocations,
  type AcknowledgeAssetInput,
  type AcknowledgedAllocation,
  type CustodyRow,
  type CustodyView,
  type MyCustodyCounts,
  type PipelineAllocation,
} from "@/features/assets/api/my-assets.api";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";

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

/**
 * Confirm an asset reached me.
 *
 * Invalidates the whole assets domain rather than patching the row: confirming
 * moves the allocation from `allocated` to `acknowledged`, which changes the
 * "To confirm" tile, the row's own badge and the custody list all at once. A
 * hand-patched row would leave the tile counting a confirmation that no longer
 * exists — the 7-vs-8 disagreement this codebase keeps designing out.
 */
export function useAcknowledgeAsset(): AuditedMutationResult<
  AcknowledgedAllocation,
  AcknowledgeAssetInput
> {
  return useAuditedMutation<AcknowledgedAllocation, AcknowledgeAssetInput>({
    mutationFn: (input, reason) => acknowledgeAsset(input, reason),
    invalidate: [qk.assets.all],
    defaultReason: "Confirming that this asset reached me.",
  });
}

/**
 * My investment declaration for one financial year.
 *
 * Enabled only with a financial year in hand: the table's unique index is
 * (employee, financial_year), so asking without one would either miss the row or
 * match the wrong year's.
 */
export function useMyTaxDeclaration(
  financialYear: string | null,
): UseQueryResult<TaxDeclaration | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.detail(`tax-declaration:${employeeId ?? NO_EMPLOYEE}:${financialYear ?? ""}`),
    queryFn: ({ signal }) =>
      fetchMyTaxDeclaration(requireEmployeeId(employeeId), financialYear ?? "", signal),
    enabled: employeeId !== null && financialYear !== null && financialYear !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * Save or submit the declaration.
 *
 * Invalidates the apply domain AND the approvals keys: submitting flips the
 * status to `pending`, and 042100's trigger raises the approval request in the
 * same transaction — so the employee's own tracking list gains a row the moment
 * this returns.
 */
export function useSaveTaxDeclaration(): AuditedMutationResult<
  TaxDeclaration,
  Omit<SaveDeclarationInput, "employeeId">
> {
  const employeeId = useEmployeeId();
  return useAuditedMutation<TaxDeclaration, Omit<SaveDeclarationInput, "employeeId">>({
    mutationFn: (input, reason) =>
      saveTaxDeclaration({ ...input, employeeId: requireEmployeeId(employeeId) }, reason),
    invalidate: [qk.apply.all, qk.approvals.all],
    defaultReason: "Filing my investment declaration for the financial year.",
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

// -----------------------------------------------------------------------------
// The employee's own register — every request, and where it got to
// -----------------------------------------------------------------------------

/** One slice of my requests, with the current approvers resolved to names. */
export function useMyRequests(
  slice: RequestSlice,
  requestTypeId?: string,
): UseQueryResult<MyOpenRequests, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: [
      ...qk.apply.openRequests(),
      "register",
      employeeId ?? NO_EMPLOYEE,
      slice,
      requestTypeId ?? "any",
    ],
    queryFn: ({ signal }) =>
      fetchMyRequests(requireEmployeeId(employeeId), slice, requestTypeId, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * `count=exact` for one slice.
 *
 * A separate query per tile, deliberately: one failing count shows a dash on its
 * own tile instead of blanking the row, and the number is Postgres's rather than
 * `rows.length`, which would report the page size.
 */
export function useMyRequestCount(
  slice: RequestSlice,
  requestTypeId?: string,
): UseQueryResult<number, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: [
      ...qk.apply.openRequests(),
      "register-count",
      employeeId ?? NO_EMPLOYEE,
      slice,
      requestTypeId ?? "any",
    ],
    queryFn: ({ signal }) =>
      countMyRequests(requireEmployeeId(employeeId), slice, requestTypeId, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * The append-only decision trail of one request.
 *
 * Reader borrowed from the team feature rather than rewritten: `approval_actions`
 * has one shape and one meaning, and `aa__via_request_read` already lets an
 * employee read the trail of a request they can see. Two copies of this would be
 * two chances to render the same evidence differently.
 */
export function useApprovalTrail(
  approvalRequestId: string | null,
): UseQueryResult<ApprovalTrail, Error> {
  return useQuery({
    queryKey: qk.approvals.detail(approvalRequestId ?? "none"),
    queryFn: ({ signal }) => fetchApprovalTrail(approvalRequestId ?? "", signal),
    enabled: approvalRequestId !== null,
    retry: shouldRetryQuery,
  });
}

/** The resignation currently blocking another, if there is one. */
export function useOpenResignation(): UseQueryResult<ResignationRow | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: [...qk.apply.list({ entity: "open-resignation" }), employeeId ?? NO_EMPLOYEE],
    queryFn: ({ signal }) => fetchOpenResignation(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Withdraw a resignation.
 *
 * Invalidates the apply domain so the form flips back from "you have one open"
 * to a blank form in the same render — the whole point of withdrawing is being
 * able to file again.
 */
export function useWithdrawResignation(): UseMutationResult<ResignationRow, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (resignationId: string) => withdrawResignation(resignationId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}

// -----------------------------------------------------------------------------
// Certification reimbursement (E-10.8)
// -----------------------------------------------------------------------------

/**
 * The certifications the venue funds.
 *
 * Cached for ten minutes like the other reference reads — a catalogue changes
 * when management decides it does, not between two page loads. An EMPTY list is
 * a real answer, not a failure: it means nobody has listed an offer yet, and the
 * screen still takes a claim, because `catalogue_id` is nullable.
 */
export function useCertificationCatalogue(): UseQueryResult<
  CertificationCatalogueEntry[],
  Error
> {
  return useQuery({
    queryKey: qk.apply.list({ entity: "certification-catalogue" }),
    queryFn: ({ signal }) => fetchCertificationCatalogue(signal),
    retry: shouldRetryQuery,
    staleTime: 10 * 60_000,
  });
}

/** My own certification claims, newest first. */
export function useMyCertificationClaims(): UseQueryResult<CertificationClaim[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.list({
      entity: "my-certification-claims",
      employeeId: employeeId ?? NO_EMPLOYEE,
    }),
    queryFn: ({ signal }) => fetchMyCertificationClaims(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export function useSubmitCertificationClaim(): UseMutationResult<
  { detailId: string; requestId: string },
  Error,
  Omit<SubmitCertificationClaimInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<SubmitCertificationClaimInput, "employeeId">) =>
      submitCertificationClaim({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}
