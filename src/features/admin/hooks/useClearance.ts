/**
 * useClearance.ts — the leaver's no-dues checklist.
 *
 * Keys sit under `qk.admin.orgList("clearance", …)`. Every mutation invalidates
 * the whole org branch rather than one key: the exits register, the progress bar
 * and the panel all read the same lines, and a checklist that is right in one
 * place and stale in another is the disagreement this codebase keeps designing
 * out.
 */
import {
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { useAuditedMutation, type AuditedMutationResult } from "@/shared/hooks/useAuditedMutation";
import {
  fetchClearanceItems,
  fetchClearanceProgress,
  fetchEmployeeClearance,
  openExitClearance,
  setClearanceStatus,
  type ClearanceItem,
  type ClearanceProgress,
  type ClearanceStatus,
  type EmployeeClearance,
} from "../api/clearance.api";

/** The template — what an exit will ask for, before one is opened. */
export function useClearanceItems(): UseQueryResult<ClearanceItem[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("clearance", { part: "template" }),
    queryFn: ({ signal }) => fetchClearanceItems(signal),
    retry: shouldRetryQuery,
    staleTime: 10 * 60_000,
  });
}

export function useEmployeeClearance(
  employeeId: string | null,
): UseQueryResult<EmployeeClearance[], Error> {
  const id = employeeId ?? "";
  return useQuery({
    queryKey: qk.admin.orgList("clearance", { part: "lines", id }),
    queryFn: ({ signal }) => fetchEmployeeClearance(id, signal),
    enabled: id !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * Progress for one leaver.
 *
 * `null` means no checklist has been opened, which is a different state from an
 * empty one — the screen offers to open it rather than drawing "0 of 0".
 */
export function useClearanceProgress(
  employeeId: string | null,
): UseQueryResult<ClearanceProgress | null, Error> {
  const id = employeeId ?? "";
  return useQuery({
    queryKey: qk.admin.orgList("clearance", { part: "progress", id }),
    queryFn: ({ signal }) => fetchClearanceProgress(id, signal),
    enabled: id !== "",
    retry: shouldRetryQuery,
  });
}

export function useOpenClearance(): AuditedMutationResult<number, { readonly employeeId: string }> {
  return useAuditedMutation({
    mutationFn: (input, reason) => openExitClearance(input.employeeId, reason),
    invalidate: [qk.admin.all],
  });
}

export function useSetClearanceStatus(): AuditedMutationResult<
  EmployeeClearance,
  {
    readonly clearanceId: string;
    readonly status: ClearanceStatus;
    readonly note: string | null;
  }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) =>
      setClearanceStatus(input.clearanceId, input.status, input.note, reason),
    invalidate: [qk.admin.all],
  });
}
