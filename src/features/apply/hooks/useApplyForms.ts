/**
 * useApplyForms.ts — hooks for the three remaining E-10 request screens
 * (`/me/apply/travel`, `/me/apply/resignation`, `/me/apply/tax`).
 *
 * A SECOND hook module in this feature rather than an append to `useApply.ts`,
 * for the same reason the i18n catalogues were split into `keys/*.ts`: a shared
 * file that several authors append to concurrently loses whichever write lands
 * first. The shared hooks — `useRequestTypeByCode`, `useRequestRouting`,
 * `useMyOpenRequestsOfType` — are IMPORTED from there and never duplicated, so
 * a per-type screen and `/me/apply` still read the same rows under the same key.
 *
 * Keys come from `qk.apply.*` only.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { QueryError, shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import { NO_EMPLOYEE } from "../api/apply.api";
import {
  fetchCurrentTaxRateSet,
  fetchMyLifecycleEvents,
  fetchMyRegimeElections,
  fetchMyTaxProfile,
  fetchMyTravelClaims,
  fetchNoticeFacts,
  submitRegimeElection,
  type LifecycleEvent,
  type MyTaxProfile,
  type NoticeFacts,
  type RegimeElection,
  type SubmitRegimeElectionInput,
  type SubmittedRegimeElection,
  type TaxRateSet,
  type TravelClaim,
} from "../api/apply-forms.api";

/**
 * Narrow the possibly-null profile id inside a mutation. A signed-in user always
 * has one; a missing one means the session has not resolved, which is a
 * no-permission state rather than an empty write.
 */
function requireProfileId(profileId: string | null): string {
  if (profileId === null || profileId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "This account has no signed-in profile, so no request can be raised in your name.",
    );
  }
  return profileId;
}

// -----------------------------------------------------------------------------
// Travel (E-10.4)
// -----------------------------------------------------------------------------

/** My travel-head claims — the money route that travel spend actually takes. */
export function useMyTravelClaims(): UseQueryResult<TravelClaim[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.list({ entity: "my-travel-claims", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyTravelClaims(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Resignation (E-10.3)
// -----------------------------------------------------------------------------

/**
 * Notice period, exit block, grade, signed contract and gratuity date in one
 * payload. `null` is DATA — an account with no employee row of its own.
 */
export function useNoticeFacts(): UseQueryResult<NoticeFacts | null, Error> {
  return useQuery({
    queryKey: qk.apply.list({ entity: "notice-facts" }),
    queryFn: ({ signal }) => fetchNoticeFacts(signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/** My own lifecycle record — where a resignation would appear once HR files it. */
export function useMyLifecycleEvents(): UseQueryResult<LifecycleEvent[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.list({ entity: "my-lifecycle", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyLifecycleEvents(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Income tax (E-10.6)
// -----------------------------------------------------------------------------

/** The regime on file for me, plus the statutory flags that ride with it. */
export function useMyTaxProfile(): UseQueryResult<MyTaxProfile | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.list({ entity: "my-tax-profile", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyTaxProfile(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/** The rate set in force today — the slabs an employee's TDS is computed from. */
export function useCurrentTaxRateSet(): UseQueryResult<TaxRateSet | null, Error> {
  return useQuery({
    queryKey: qk.apply.list({ entity: "tax-rate-set" }),
    queryFn: ({ signal }) => fetchCurrentTaxRateSet(signal),
    retry: shouldRetryQuery,
    staleTime: 30 * 60_000,
  });
}

/** Every regime election I have ever raised, newest first. */
export function useMyRegimeElections(): UseQueryResult<RegimeElection[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.apply.list({ entity: "my-regime-elections", employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyRegimeElections(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Raise a regime election: change request → `create_approval_request`.
 *
 * Invalidates the whole `apply` domain and the approvals domain because one
 * submit changes three lists — my elections, my open requests of the
 * `PROFILE_CHANGE` type, and the launcher's open-request grid. Nothing is
 * patched optimistically: `request_number` is minted by the server and only the
 * server can report it.
 */
export function useSubmitRegimeElection(): UseMutationResult<
  SubmittedRegimeElection,
  Error,
  Omit<SubmitRegimeElectionInput, "employeeId" | "profileId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  const profileId = useProfileId();
  return useMutation({
    mutationFn: (input: Omit<SubmitRegimeElectionInput, "employeeId" | "profileId">) =>
      submitRegimeElection({
        ...input,
        employeeId: requireEmployeeId(employeeId),
        profileId: requireProfileId(profileId),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.apply.all });
      void client.invalidateQueries({ queryKey: qk.approvals.all });
    },
    retry: false,
  });
}
