/**
 * useNotifications.ts — hooks for E-16. Keys from `qk.notifications.*`.
 *
 * Every key carries the PROFILE id (not the employee id): the feed is addressed
 * to `notifications.profile_id`, and an admin who switches accounts must not see
 * the previous account's cached feed.
 *
 * The mark-read mutations invalidate `qk.notifications.all`, which is the prefix
 * of both the list and the unread count, so the badge and the rows can never
 * disagree about what was just read.
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
import { useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import {
  countEmployeeOnlyUnlisted,
  countNotifications,
  countUnread,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  type FeedFilters,
  type Notification,
} from "../api/notifications.api";

const NO_PROFILE = "no-profile";

/** Same refusal shape the shared scope helper raises for a missing employee. */
function requireProfileId(profileId: string | null): string {
  if (profileId === null || profileId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "This account has no signed-in profile, so there is no notification feed to read.",
    );
  }
  return profileId;
}

/** The capped, newest-first feed for the current filters. */
export function useNotificationFeed(
  filters: FeedFilters,
): UseQueryResult<Notification[], Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.notifications.list({ profileId: profileId ?? NO_PROFILE, ...filters }),
    queryFn: ({ signal }) => fetchNotifications(requireProfileId(profileId), filters, signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 30_000,
  });
}

/** Server COUNT over the same filters as the feed. */
export function useNotificationCount(filters: FeedFilters): UseQueryResult<number, Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.notifications.list({
      profileId: profileId ?? NO_PROFILE,
      ...filters,
      count: true,
    }),
    queryFn: ({ signal }) => countNotifications(requireProfileId(profileId), filters, signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 30_000,
  });
}

export function useUnreadCount(): UseQueryResult<number, Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.notifications.unreadCount(),
    queryFn: ({ signal }) => countUnread(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 30_000,
  });
}

/**
 * How many rows are addressed to my EMPLOYEE row without a profile id — the ones
 * the profile-scoped feed cannot list. Live this is zero; the screen states it
 * rather than assuming.
 */
export function useEmployeeOnlyUnlisted(): UseQueryResult<number, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.notifications.list({ employeeId: employeeId ?? "none", unlisted: true }),
    queryFn: ({ signal }) =>
      employeeId === null ? Promise.resolve(0) : countEmployeeOnlyUnlisted(employeeId, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

export interface MarkReadInput {
  readonly id: string;
  readonly read: boolean;
}

/** Mark one row read (or back to unread). */
export function useMarkNotification(): UseMutationResult<Notification, Error, MarkReadInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkReadInput) =>
      input.read ? markNotificationRead(input.id) : markNotificationUnread(input.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.notifications.all });
    },
  });
}

/** Mark everything unread as read, in one statement. */
export function useMarkAllRead(): UseMutationResult<Notification | null, Error, void> {
  const client = useQueryClient();
  const profileId = useProfileId();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(requireProfileId(profileId)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.notifications.all });
    },
  });
}
