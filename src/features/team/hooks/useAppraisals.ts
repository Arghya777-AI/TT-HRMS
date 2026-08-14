/**
 * useAppraisals.ts — the review cycle.
 *
 * Every mutation invalidates the team AND approvals branches: an appraisal is
 * read by the manager's list, the employee's own page and the cycle progress
 * counts, and a review that is submitted in one place while another still says
 * "not started" is the disagreement this codebase keeps designing out.
 */
import {
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { useAuditedMutation, type AuditedMutationResult } from "@/shared/hooks/useAuditedMutation";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import { NO_EMPLOYEE } from "@/features/apply/api/apply.api";
import {
  acknowledgeAppraisal,
  fetchAppraisalCycles,
  fetchAppraisalRatings,
  fetchAppraisals,
  fetchMyAppraisals,
  saveRating,
  shareAppraisal,
  submitManagerReview,
  submitSelfAssessment,
  type Appraisal,
  type AppraisalCycle,
  type AppraisalRating,
} from "../api/appraisals.api";

export function useAppraisalCycles(): UseQueryResult<AppraisalCycle[], Error> {
  return useQuery({
    queryKey: qk.team.list({ entity: "appraisal-cycles" }),
    queryFn: ({ signal }) => fetchAppraisalCycles(signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/** Everybody in this cycle the caller may see — RLS decides who that is. */
export function useAppraisals(cycleId: string | null): UseQueryResult<Appraisal[], Error> {
  const id = cycleId ?? "";
  return useQuery({
    queryKey: qk.team.list({ entity: "appraisals", cycleId: id }),
    queryFn: ({ signal }) => fetchAppraisals(id, signal),
    enabled: id !== "",
    retry: shouldRetryQuery,
  });
}

/** My own — only ever the shared ones, because that is all the policy returns. */
export function useMyAppraisals(): UseQueryResult<Appraisal[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.team.list({ entity: "my-appraisals", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyAppraisals(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export function useAppraisalRatings(
  appraisalId: string | null,
): UseQueryResult<AppraisalRating[], Error> {
  const id = appraisalId ?? "";
  return useQuery({
    queryKey: qk.team.list({ entity: "appraisal-ratings", appraisalId: id }),
    queryFn: ({ signal }) => fetchAppraisalRatings(id, signal),
    enabled: id !== "",
    retry: shouldRetryQuery,
  });
}

export function useSaveRating(): AuditedMutationResult<
  AppraisalRating,
  {
    readonly ratingId: string;
    readonly patch: {
      self_rating?: number | null;
      manager_rating?: number | null;
      manager_note?: string | null;
    };
  }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) => saveRating(input.ratingId, input.patch, reason),
    invalidate: [qk.team.all],
  });
}

export function useSubmitSelfAssessment(): AuditedMutationResult<
  Appraisal,
  { readonly appraisalId: string; readonly comment: string }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) => submitSelfAssessment(input, reason),
    invalidate: [qk.team.all],
  });
}

export function useSubmitManagerReview(): AuditedMutationResult<
  Appraisal,
  { readonly appraisalId: string; readonly comment: string; readonly overallRating: number }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) => submitManagerReview(input, reason),
    invalidate: [qk.team.all],
  });
}

export function useShareAppraisal(): AuditedMutationResult<
  Appraisal,
  { readonly appraisalId: string }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) => shareAppraisal(input.appraisalId, reason),
    invalidate: [qk.team.all],
  });
}

export function useAcknowledgeAppraisal(): AuditedMutationResult<
  Appraisal,
  { readonly appraisalId: string; readonly note: string }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) => acknowledgeAppraisal(input.appraisalId, input.note, reason),
    invalidate: [qk.team.all],
  });
}
