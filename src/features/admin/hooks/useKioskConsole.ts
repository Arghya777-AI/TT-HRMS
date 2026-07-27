/**
 * useKioskConsole.ts — TanStack hooks for `/admin/kiosk/**`.
 *
 * Keys come from `qk.admin.*` only. Every write goes through
 * `useAuditedMutation`, so the reason travels as an argument into the
 * `x-reason` header of exactly one request and the grid refreshes from the
 * server afterwards rather than from an optimistic guess.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  fetchEnrolmentGaps,
  fetchKioskDevices,
  fetchKioskHealth,
  type EnrolmentGap,
  type KioskDevice,
  type KioskHealthRow,
} from "../api/system.api";
import {
  approveFaceTemplate,
  deactivateFaceTemplate,
  fetchEnrolmentRequests,
  fetchFaceMatchAudit,
  fetchFaceTemplates,
  fetchKioskOperators,
  forceReenrol,
  restoreKioskDevicePairing,
  revealFaceMatchCandidates,
  revokeKioskDevicePairing,
  revokeKioskOperator,
  setDeviceMatchThreshold,
  updateKioskOperator,
  REASON_OPERATOR_EDIT,
  type CandidateReveal,
  type EnrolmentRequest,
  type FaceMatchAudit,
  type KioskOperator,
  type MatchAuditFilters,
  type OperatorPatch,
  type TemplateListPage,
  type TemplateListState,
  addKioskDevice,
  enrolFaceFromConsole,
  issueActivationCode,
  recordBiometricConsent,
  setOperatorPin,
  type AddDeviceResult,
  type ConsentResult,
  type ConsoleEnrolResult,
  type EnrolSampleInput,
  type ActivationCodeResult,
  type SetPinResult,
} from "../api/kiosk.api";

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export function useKioskDevices(): UseQueryResult<KioskDevice[], Error> {
  return useQuery({
    queryKey: qk.admin.kioskDevices(),
    queryFn: ({ signal }) => fetchKioskDevices(signal),
    retry: shouldRetryQuery,
  });
}

/** v_kiosk_health rows for an inclusive IST date range (device × day). */
export function useKioskHealth(from: string, to: string): UseQueryResult<KioskHealthRow[], Error> {
  return useQuery({
    queryKey: qk.admin.kioskHealth(from, to),
    queryFn: ({ signal }) => fetchKioskHealth(from, to, signal),
    retry: shouldRetryQuery,
  });
}

export function useKioskOperators(): UseQueryResult<KioskOperator[], Error> {
  return useQuery({
    queryKey: qk.admin.kioskOperators(),
    queryFn: ({ signal }) => fetchKioskOperators(signal),
    retry: shouldRetryQuery,
  });
}

/** The operational gap list — who cannot use the gate yet, and why (§9.3). */
export function useEnrolmentGaps(): UseQueryResult<EnrolmentGap[], Error> {
  return useQuery({
    queryKey: qk.admin.enrolmentGaps(),
    queryFn: ({ signal }) => fetchEnrolmentGaps(signal),
    retry: shouldRetryQuery,
  });
}

export function useEnrolmentRequests(onlyPending: boolean): UseQueryResult<EnrolmentRequest[], Error> {
  return useQuery({
    queryKey: qk.admin.enrolmentRequests(onlyPending),
    queryFn: ({ signal }) => fetchEnrolmentRequests({ onlyPending }, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Template metadata via the `face-template-admin` edge function.
 *
 * `enabled` is honoured because the function demands `biometric.template.manage`
 * WITH an MFA step-up: firing it on a screen the admin only glanced at would
 * write a `bulk_view` data-access row for nothing.
 */
export function useFaceTemplates(
  state: TemplateListState,
  offset = 0,
  enabled = true,
): UseQueryResult<TemplateListPage, Error> {
  return useQuery({
    queryKey: qk.admin.faceTemplates(state, offset),
    queryFn: ({ signal }) => fetchFaceTemplates({ state, offset }, signal),
    enabled,
    retry: false,
  });
}

export function useFaceMatchAudit(
  filters: MatchAuditFilters,
): UseQueryResult<FaceMatchAudit[], Error> {
  return useQuery({
    queryKey: qk.admin.faceMatchAudit({
      from: filters.from,
      to: filters.to,
      outcomes: filters.outcomes ?? null,
      deviceIds: filters.deviceIds ?? null,
    }),
    queryFn: ({ signal }) => fetchFaceMatchAudit(filters, 300, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface DevicePairingInput {
  readonly deviceId: string;
  readonly action: "revoke" | "restore";
}

/**
 * Revoke or restore a device pairing. Both are super-admin writes at the policy
 * layer and reason-required by the audit trigger, so the floor is the fuller
 * D-21 sentence rather than the database's 10 characters.
 */
export function useDevicePairingMutation(): AuditedMutationResult<KioskDevice, DevicePairingInput> {
  return useAuditedMutation<KioskDevice, DevicePairingInput>({
    mutationFn: (input, reason) =>
      input.action === "revoke"
        ? revokeKioskDevicePairing(input.deviceId, reason)
        : restoreKioskDevicePairing(input.deviceId, reason),
    invalidate: [qk.admin.kioskDevices()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface ThresholdInput {
  readonly deviceId: string;
  readonly minMatchConfidence: number;
}

/** §5.9 threshold governance: super-admin plus a typed reason, never a default. */
export function useDeviceThresholdMutation(): AuditedMutationResult<KioskDevice, ThresholdInput> {
  return useAuditedMutation<KioskDevice, ThresholdInput>({
    mutationFn: (input, reason) =>
      setDeviceMatchThreshold(input.deviceId, input.minMatchConfidence, reason),
    invalidate: [qk.admin.kioskDevices()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface OperatorInput {
  readonly id: string;
  readonly patch: OperatorPatch;
}

/**
 * Routine permission edits on a guard row carry a specific default sentence;
 * revoking access does not — that goes through `useOperatorRevokeMutation`,
 * which has no `defaultReason` at all, so a missing reason fails loudly.
 */
export function useOperatorMutation(): AuditedMutationResult<KioskOperator, OperatorInput> {
  return useAuditedMutation<KioskOperator, OperatorInput>({
    mutationFn: (input, reason) => updateKioskOperator(input.id, input.patch, reason),
    invalidate: [qk.admin.kioskOperators()],
    defaultReason: REASON_OPERATOR_EDIT,
  });
}

export function useOperatorRevokeMutation(): AuditedMutationResult<KioskOperator, string> {
  return useAuditedMutation<KioskOperator, string>({
    mutationFn: (id, reason) => revokeKioskOperator(id, reason),
    invalidate: [qk.admin.kioskOperators()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface TemplateDecisionInput {
  readonly templateId: string;
  readonly idempotencyKey: string;
  readonly comment?: string;
}

/**
 * Approve a pending template set. The idempotency key is generated once per
 * dialog open and reused across retries, so a double-click cannot approve twice.
 */
export function useTemplateApproveMutation(): AuditedMutationResult<
  { employeeCode: string },
  TemplateDecisionInput
> {
  return useAuditedMutation<{ employeeCode: string }, TemplateDecisionInput>({
    mutationFn: (input, reason) =>
      approveFaceTemplate(
        {
          templateId: input.templateId,
          idempotencyKey: input.idempotencyKey,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        },
        reason,
      ),
    invalidate: [qk.admin.faceTemplatesAll(), qk.admin.enrolmentGaps(), qk.admin.employeesAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export function useTemplateRetireMutation(): AuditedMutationResult<
  { employeeCode: string },
  TemplateDecisionInput
> {
  return useAuditedMutation<{ employeeCode: string }, TemplateDecisionInput>({
    mutationFn: (input, reason) =>
      deactivateFaceTemplate(
        { templateId: input.templateId, idempotencyKey: input.idempotencyKey },
        reason,
      ),
    invalidate: [qk.admin.faceTemplatesAll(), qk.admin.enrolmentGaps()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface ForceReenrolInput {
  readonly employeeId: string;
  readonly idempotencyKey: string;
}

export function useForceReenrolMutation(): AuditedMutationResult<
  { employeeCode: string },
  ForceReenrolInput
> {
  return useAuditedMutation<{ employeeCode: string }, ForceReenrolInput>({
    mutationFn: (input, reason) =>
      forceReenrol({ employeeId: input.employeeId, idempotencyKey: input.idempotencyKey }, reason),
    invalidate: [qk.admin.faceTemplatesAll(), qk.admin.enrolmentGaps()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/**
 * Reveal the top-5 candidate scores behind one attempt. Super-admin only, and
 * the RPC itself writes the `data_access` reveal row — the client never decides
 * whether the reveal was audited.
 */
export function useCandidateRevealMutation(): AuditedMutationResult<CandidateReveal | null, string> {
  return useAuditedMutation<CandidateReveal | null, string>({
    mutationFn: (matchId, reason) => revealFaceMatchCandidates(matchId, reason),
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

// -----------------------------------------------------------------------------
// Provisioning mutations (kiosk-provision)
// -----------------------------------------------------------------------------

/** Mint a pairing code. The result is displayed once and never persisted. */
export function useIssueActivationCode(): AuditedMutationResult<ActivationCodeResult, string> {
  return useAuditedMutation<ActivationCodeResult, string>({
    mutationFn: (deviceId, reason) => issueActivationCode(deviceId, reason),
    invalidate: [qk.admin.kioskDevices()],
  });
}

/**
 * Add a gate device and get its first pairing code.
 *
 * `label` is optional — the person pairing names the device from the kiosk screen,
 * so the admin does not have to decide in advance which phone it will be.
 */
export function useAddKioskDevice(): AuditedMutationResult<
  AddDeviceResult,
  { label?: string; locationId?: string }
> {
  return useAuditedMutation<AddDeviceResult, { label?: string; locationId?: string }>({
    mutationFn: (input, reason) => addKioskDevice(input, reason),
    invalidate: [qk.admin.kioskDevices()],
  });
}

/** Set or rotate a guard PIN. */
export function useSetOperatorPin(): AuditedMutationResult<
  SetPinResult,
  { operatorId: string; pin: string }
> {
  return useAuditedMutation<SetPinResult, { operatorId: string; pin: string }>({
    mutationFn: (input, reason) => setOperatorPin(input, reason),
    invalidate: [qk.admin.kioskOperators()],
  });
}

/** Console camera enrolment (U+). The result is a PENDING set awaiting approval. */
export function useConsoleEnrolMutation(): AuditedMutationResult<
  ConsoleEnrolResult,
  { employeeId: string; samples: readonly EnrolSampleInput[] }
> {
  return useAuditedMutation<
    ConsoleEnrolResult,
    { employeeId: string; samples: readonly EnrolSampleInput[] }
  >({
    mutationFn: (input, reason) => enrolFaceFromConsole(input, reason),
    invalidate: [qk.admin.faceTemplatesAll(), qk.admin.enrolmentGaps()],
    // Building a biometric template is a D-21 action, so the floor is 15 — the
    // same number `EnrolCapture`'s dialog asks for. Leaving it at the default 10
    // let the dialog and the mutation disagree about what a valid reason is.
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/** Record biometric consent before capture; supersedes older notice versions. */
export function useRecordConsentMutation(): AuditedMutationResult<ConsentResult, string> {
  return useAuditedMutation<ConsentResult, string>({
    mutationFn: (employeeId, reason) => recordBiometricConsent(employeeId, reason),
    invalidate: [qk.admin.enrolmentGaps()],
  });
}
