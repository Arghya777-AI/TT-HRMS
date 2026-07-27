/**
 * useMyActivity.ts — the two count hooks `/me/activity` and `/me/settings` need.
 * Keys from `qk.settings.*`, alongside `useMeSettings.ts`, which owns the
 * preference/security hooks those screens reuse rather than re-declare.
 *
 * Deliberately small: the ROW reads for both screens already exist
 * (`useRecordHistory`, `useChangeRequests`, `useMyDataAccess` in the profile
 * domain; `useMySessionEvents` next door), so this file adds only what did not
 * exist — the server counts. Nothing here is optimistic and nothing is derived
 * from a fetched list.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { QueryError, shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import {
  fetchActivityCounts,
  fetchSettingsSummaryCounts,
  type ActivityCounts,
  type SettingsSummaryCounts,
} from "../api/activity.api";

const NO_PROFILE = "no-profile";
const NO_EMPLOYEE = "no-employee";

/**
 * Narrow the signed-in `profiles.id` inside a `queryFn`. `useMeSettings.ts` keeps
 * an identical private guard; this one is separate rather than exported from
 * there so that neither file becomes a dependency of the other.
 */
function requireProfileId(profileId: string | null): string {
  if (profileId === null || profileId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "This account has no signed-in profile, so there is no activity to count.",
    );
  }
  return profileId;
}

/** The four numbers on `/me/activity`, each a `count=exact` over my own rows. */
export function useMyActivityCounts(): UseQueryResult<ActivityCounts, Error> {
  const employeeId = useEmployeeId();
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({
      what: "activity-counts",
      employeeId: employeeId ?? NO_EMPLOYEE,
      profileId: profileId ?? NO_PROFILE,
    }),
    queryFn: ({ signal }) =>
      fetchActivityCounts(requireEmployeeId(employeeId), requireProfileId(profileId), signal),
    enabled: employeeId !== null && profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

/** Preference and passkey counts for the `/me/settings` landing. */
export function useMySettingsCounts(): UseQueryResult<SettingsSummaryCounts, Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "settings-counts", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => fetchSettingsSummaryCounts(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}
