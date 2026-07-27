/**
 * useSignInActivity.ts — the reads behind the employee-visible sign-in trail.
 *
 * Keys live under `qk.settings.*` beside `useMeSettings.ts` and `useMyActivity.ts`,
 * with a `what` discriminator so the trail, the renewals and the summary each have
 * their own cache entry and none of them invalidates the security tab's own reads.
 *
 * Three deliberate choices:
 *  1. The renewals read is `enabled` only when the viewer actually asks for it. It
 *     is the one event class nothing writes in this build, so fetching it eagerly
 *     would spend a request on a list that is empty by construction.
 *  2. Nothing here is refetched on an interval. This is an audit record, not a
 *     live board; a stale-time of a minute matches the security tab.
 *  3. No mutation exists in this file and none can: `authenticated` holds SELECT
 *     only on `sessions_audit` (migration 000400 §5 grants), so the trail is
 *     append-only from the browser's point of view.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { QueryError, shouldRetryQuery } from "@/shared/api/query";
import { useProfileId } from "@/shared/api/employee-scope";
import {
  SIGNIN_TRAIL_LIMIT,
  fetchMySessionRenewals,
  fetchMySignInSummary,
  fetchMySignInTrail,
  type SignInEventRow,
  type SignInSummary,
} from "../api/signin-activity.api";

const NO_PROFILE = "no-profile";

/**
 * Narrow the signed-in `profiles.id` inside a `queryFn`. `useMeSettings.ts` and
 * `useMyActivity.ts` each keep an identical private guard; this one is separate so
 * that no settings hook file depends on another.
 */
function requireProfileId(profileId: string | null): string {
  if (profileId === null || profileId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "This account has no signed-in profile, so there is no sign-in history to show.",
    );
  }
  return profileId;
}

/** My auth events (renewals excluded), newest first, capped at `SIGNIN_TRAIL_LIMIT`. */
export function useMySignInTrail(): UseQueryResult<SignInEventRow[], Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({
      what: "signin-trail",
      profileId: profileId ?? NO_PROFILE,
      limit: SIGNIN_TRAIL_LIMIT,
    }),
    queryFn: ({ signal }) =>
      fetchMySignInTrail(requireProfileId(profileId), SIGNIN_TRAIL_LIMIT, signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

/** The background `token_refresh` rows, fetched only when the viewer asks. */
export function useMySessionRenewals(enabled: boolean): UseQueryResult<SignInEventRow[], Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "signin-renewals", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => fetchMySessionRenewals(requireProfileId(profileId), 100, signal),
    enabled: enabled && profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

/** The four server counts and the newest recorded success. */
export function useMySignInSummary(): UseQueryResult<SignInSummary, Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "signin-summary", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => fetchMySignInSummary(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}
