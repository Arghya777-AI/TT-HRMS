/**
 * usePolicies.ts — hooks for E-13. Keys from `qk.policies.*`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  acknowledgePolicy,
  fetchPolicyDetail,
  fetchPolicyList,
  type AcknowledgePolicyInput,
  type PolicyDetail,
  type PolicyList,
} from "../api/policies.api";

const NO_EMPLOYEE = "no-employee";

/** Every policy assigned or published to me. */
export function usePolicyList(): UseQueryResult<PolicyList, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.policies.list({ employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchPolicyList(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** One policy plus my own acknowledgement row. */
export function usePolicyDetail(documentId: string | null): UseQueryResult<PolicyDetail, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.policies.detail(documentId ?? "none"),
    queryFn: ({ signal }) => {
      if (documentId === null) throw new Error("policy detail requested without an id");
      return fetchPolicyDetail(documentId, requireEmployeeId(employeeId), signal);
    },
    enabled: employeeId !== null && documentId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Record an acknowledgement. On success the whole policies domain is
 * invalidated (the list badge, the reader and E-12's action list all move), plus
 * the approvals inbox and the documents "Signed" tab.
 */
export function useAcknowledgePolicy(): UseMutationResult<void, Error, AcknowledgePolicyInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcknowledgePolicyInput) => acknowledgePolicy(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.policies.all });
      void queryClient.invalidateQueries({ queryKey: qk.approvals.all });
      void queryClient.invalidateQueries({ queryKey: qk.docs.all });
    },
  });
}
