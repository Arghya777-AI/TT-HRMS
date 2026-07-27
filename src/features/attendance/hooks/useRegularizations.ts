/**
 * useRegularizations.ts — TanStack Query hooks for E-04.
 *
 * Keys come from `qk.attendance.*` only. Every quota/policy key is a child of
 * `qk.attendance.regularizations()`, so one invalidation after a submit or
 * withdrawal refreshes the list, the quota and the policy in one go.
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
  fetchMyRegularizations,
  fetchRegularizationPolicy,
  fetchRegularizationPreview,
  fetchRegularizationsForMonth,
  monthBounds,
  submitRegularization,
  withdrawRegularization,
  QUOTA_COUNTING_STATUSES,
  type Regularization,
  type RegularizationPolicy,
  type RegularizationPreview,
  type RegularizationPreviewInput,
  type SubmitRegularizationInput,
} from "../api/regularizations.api";

const NO_EMPLOYEE = "no-employee";

/** My correction requests, newest first. */
export function useMyRegularizations(): UseQueryResult<Regularization[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.regularizations(),
    queryFn: ({ signal }) => fetchMyRegularizations(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * The monthly quota state for the month containing `isoDate`.
 *
 * `used` is `rows.length` of the EXACT series the caller can also see, and `cap`
 * comes from the server-resolved attendance policy. When the policy cannot be
 * resolved, `cap` is null and the UI says the cap is unknown — it never
 * substitutes a number the database might disagree with.
 */
export interface RegularizationQuota {
  readonly month: string;
  readonly used: number;
  readonly cap: number | null;
  readonly rows: readonly Regularization[];
  readonly countedStatuses: readonly string[];
}

export function useRegularizationQuota(
  isoDate: string,
): UseQueryResult<RegularizationQuota, Error> {
  const employeeId = useEmployeeId();
  const bounds = monthBounds(isoDate);
  return useQuery({
    queryKey: qk.attendance.regularizationQuota(bounds.month),
    queryFn: async ({ signal }) => {
      const id = requireEmployeeId(employeeId);
      const [rows, policy] = await Promise.all([
        fetchRegularizationsForMonth(id, bounds.from, bounds.to, signal),
        fetchRegularizationPolicy(id, isoDate, signal),
      ]);
      return {
        month: bounds.month,
        used: rows.length,
        cap: policy?.max_regularizations_per_month ?? null,
        rows,
        countedStatuses: QUOTA_COUNTING_STATUSES,
      } satisfies RegularizationQuota;
    },
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** The attendance policy in force on `isoDate` — window days + cap + routing. */
export function useRegularizationPolicy(
  isoDate: string,
): UseQueryResult<RegularizationPolicy | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.regularizationPolicy(isoDate),
    queryFn: ({ signal }) =>
      fetchRegularizationPolicy(requireEmployeeId(employeeId), isoDate, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * The server dry-run. `enabled` should be false until the form is complete, so
 * we never ask the server to price an incomplete request.
 *
 * `retry: false` — the endpoint is either deployed or it is not; retrying a 404
 * three times per keystroke only slows the honest fallback down.
 */
export function useRegularizationPreview(
  input: RegularizationPreviewInput | null,
): UseQueryResult<RegularizationPreview, Error> {
  const hash = input
    ? [
        input.istDate,
        input.kind,
        input.requestedFirstInAt ?? "",
        input.requestedLastOutAt ?? "",
        input.requestedStatus ?? "",
      ].join("|")
    : "none";
  return useQuery({
    queryKey: qk.attendance.regularizationPreview(hash),
    queryFn: ({ signal }) => {
      if (input === null) throw new Error("preview requested without an input");
      return fetchRegularizationPreview(input, signal);
    },
    enabled: input !== null,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Submit. A `23505` unique violation is the structural replay guard
 * (`uq_ar__one_open_per_day`) and is reported to the caller as a conflict so the
 * UI can say "you already have an open request for that date" instead of
 * inventing a second one.
 */
export function useSubmitRegularization(): UseMutationResult<
  Regularization,
  Error,
  SubmitRegularizationInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitRegularizationInput) => submitRegularization(input),
    onSuccess: (row) => {
      void queryClient.invalidateQueries({ queryKey: qk.attendance.regularizations() });
      void queryClient.invalidateQueries({ queryKey: qk.apply.openRequests() });
      void queryClient.invalidateQueries({ queryKey: qk.approvals.all });
      void queryClient.invalidateQueries({
        queryKey: qk.attendance.day(row.employee_id, row.ist_date),
      });
    },
  });
}

/** Withdraw a pending request. RLS refuses anything already decided. */
export function useWithdrawRegularization(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => withdrawRegularization(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.attendance.regularizations() });
      void queryClient.invalidateQueries({ queryKey: qk.apply.openRequests() });
    },
  });
}

export { NO_EMPLOYEE };
