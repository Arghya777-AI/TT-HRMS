/**
 * useMeSettings.ts — hooks for E-18 (/me/settings/notifications and
 * /me/settings/security). Keys from `qk.settings.*`.
 *
 * Two rules this file follows:
 *
 *  1. GoTrue state is cached like any other read. `listFactors` and the assurance
 *     level are network calls, so they are `useQuery` entries under
 *     `qk.settings.*` and every enrol/unenrol invalidates them. A component that
 *     kept the factor list in local state would show a stale "no authenticator"
 *     row straight after enrolling one.
 *  2. Nothing here is optimistic. A password change, a verified factor and a
 *     preference toggle are all re-read from the server afterwards; the screen
 *     never draws the state it hopes it achieved.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Factor } from "@supabase/supabase-js";
import { qk } from "@/shared/api/keys";
import { QueryError, shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import {
  countByChannel,
  type NotificationChannel,
} from "@/features/notifications/api/notifications.api";
import {
  changePassword,
  enrolTotp,
  fetchAssuranceLevel,
  fetchMyBiometricStatus,
  fetchMyFaceEnrolmentRequests,
  fetchMyPasskeys,
  fetchMySessionEvents,
  listMfaFactors,
  signOutOtherSessions,
  unenrolFactor,
  verifyTotp,
  type BiometricStatus,
  type FaceEnrolmentRequest,
  type Passkey,
  type SessionAuditEntry,
  type TotpEnrolment,
} from "../api/security.api";
import {
  fetchMyPreferences,
  setPreferenceDigest,
  setPreferenceEnabled,
  type DigestFrequency,
  type NotificationPreference,
} from "../api/settings.api";

const NO_PROFILE = "no-profile";

function requireProfileId(profileId: string | null): string {
  if (profileId === null || profileId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "This account has no signed-in profile, so there are no account settings to read.",
    );
  }
  return profileId;
}

// -----------------------------------------------------------------------------
// 1. Notification preferences (E-18.1)
// -----------------------------------------------------------------------------

export function useMyNotificationPreferences(): UseQueryResult<NotificationPreference[], Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "notification-preferences", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => fetchMyPreferences(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

/**
 * Per-channel counts of the notices that actually reached me — one `count=exact`
 * per channel, so the tiles are Postgres's cardinalities and not a client tally
 * of a page of rows.
 */
export function useMyChannelCounts(): UseQueryResult<
  Readonly<Record<NotificationChannel, number>>,
  Error
> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "channel-counts", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => countByChannel(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

export interface PreferenceToggleInput {
  readonly id: string;
  readonly isEnabled: boolean;
}

export function useSetPreferenceEnabled(): UseMutationResult<
  NotificationPreference,
  Error,
  PreferenceToggleInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PreferenceToggleInput) => setPreferenceEnabled(input.id, input.isEnabled),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

export interface PreferenceDigestInput {
  readonly id: string;
  readonly digest: DigestFrequency;
}

export function useSetPreferenceDigest(): UseMutationResult<
  NotificationPreference,
  Error,
  PreferenceDigestInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PreferenceDigestInput) => setPreferenceDigest(input.id, input.digest),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

// -----------------------------------------------------------------------------
// 2. Password (E-18.2)
// -----------------------------------------------------------------------------

export interface ChangePasswordInput {
  readonly password: string;
  /** Sign every other session out once the password is rotated. */
  readonly signOutOthers: boolean;
}

export function useChangePassword(): UseMutationResult<void, Error, ChangePasswordInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChangePasswordInput) => {
      await changePassword(input.password);
      if (input.signOutOthers) await signOutOtherSessions();
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

export function useSignOutOtherSessions(): UseMutationResult<void, Error, void> {
  return useMutation({ mutationFn: () => signOutOtherSessions() });
}

// -----------------------------------------------------------------------------
// 3. Authenticator factors (E-18.2)
// -----------------------------------------------------------------------------

export function useMfaFactors(): UseQueryResult<readonly Factor[], Error> {
  return useQuery({
    queryKey: qk.settings.list({ what: "mfa-factors" }),
    queryFn: () => listMfaFactors(),
    retry: false,
    staleTime: 30_000,
  });
}

export function useAssuranceLevel(): UseQueryResult<
  { current: string | null; next: string | null },
  Error
> {
  return useQuery({
    queryKey: qk.settings.list({ what: "mfa-aal" }),
    queryFn: () => fetchAssuranceLevel(),
    retry: false,
    staleTime: 30_000,
  });
}

export interface EnrolTotpInput {
  readonly friendlyName: string;
  readonly issuer: string;
}

/** Starts enrolment; the factor exists (unverified) as soon as this resolves. */
export function useEnrolTotp(): UseMutationResult<TotpEnrolment, Error, EnrolTotpInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EnrolTotpInput) => enrolTotp(input.friendlyName, input.issuer),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

export interface VerifyTotpInput {
  readonly factorId: string;
  readonly code: string;
}

export function useVerifyTotp(): UseMutationResult<void, Error, VerifyTotpInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: VerifyTotpInput) => verifyTotp(input.factorId, input.code),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

export function useUnenrolFactor(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (factorId: string) => unenrolFactor(factorId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

// -----------------------------------------------------------------------------
// 4. What Postgres records about the account (E-18.2)
// -----------------------------------------------------------------------------

export function useMyPasskeys(): UseQueryResult<Passkey[], Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "passkeys", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => fetchMyPasskeys(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

export function useMySessionEvents(): UseQueryResult<SessionAuditEntry[], Error> {
  const profileId = useProfileId();
  return useQuery({
    queryKey: qk.settings.list({ what: "session-events", profileId: profileId ?? NO_PROFILE }),
    queryFn: ({ signal }) => fetchMySessionEvents(requireProfileId(profileId), signal),
    enabled: profileId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

export function useMyBiometricStatus(): UseQueryResult<BiometricStatus | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.settings.list({ what: "biometric-status", employeeId: employeeId ?? "none" }),
    queryFn: ({ signal }) => fetchMyBiometricStatus(signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

export function useMyFaceEnrolmentRequests(): UseQueryResult<FaceEnrolmentRequest[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.settings.list({ what: "face-enrolment", employeeId: employeeId ?? "none" }),
    queryFn: ({ signal }) =>
      fetchMyFaceEnrolmentRequests(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}
