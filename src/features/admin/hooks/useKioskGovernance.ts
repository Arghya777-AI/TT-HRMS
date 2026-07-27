/**
 * useKioskGovernance.ts — TanStack hooks for `/admin/kiosk/{abuse,policy,purge}`.
 *
 * Sits beside `useKioskConsole` for the same reason `useSettingsExtra` sits
 * beside `useSettingsConsole`: one hook file per screen group keeps the
 * invalidation story local. Two rules are honoured here:
 *
 *  * Keys come from `qk.admin.*` only. The abuse reads use `qk.admin.punches(…)`
 *    so a void performed anywhere in the console (Punch Log, Day detail, this
 *    queue) refreshes all three through the one `qk.admin.attendanceAll()`
 *    prefix — the queue must never keep showing a scan as undecided after
 *    somebody voided it.
 *  * The purge read is keyed under `qk.admin.faceTemplates(…)` so a completed
 *    purge invalidates it together with every Face Templates tab. A purged
 *    template that still shows as active on a sibling screen is the same defect
 *    as a stale grid, and here it is a defect about biometrics.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  fetchAbusePunches,
  fetchAbuseSignalCounts,
  purgeFaceTemplates,
  purgeReason,
  PURGE_REASON_MIN_LENGTH,
  type AbuseBucket,
  type AbusePunch,
  type AbuseSignalCounts,
  type PurgeInput,
  type PurgeLegalBasis,
  type PurgeResult,
} from "../api/kiosk-governance.api";
import { fetchFaceTemplates, type TemplateListPage } from "../api/kiosk.api";

/** Rows pulled per bucket. A month at one venue does not reach this. */
export const ABUSE_ROW_LIMIT = 200;
/** Template metadata pulled for the purge register (the op's own ceiling is 200). */
export const PURGE_REGISTER_LIMIT = 200;

// -----------------------------------------------------------------------------
// Abuse review queue
// -----------------------------------------------------------------------------

export interface AbuseRange {
  readonly from: string;
  readonly to: string;
}

export function useAbusePunches(
  bucket: AbuseBucket,
  range: AbuseRange,
): UseQueryResult<AbusePunch[], Error> {
  return useQuery({
    queryKey: qk.admin.punches({
      scope: "abuse",
      bucket,
      from: range.from,
      to: range.to,
      limit: ABUSE_ROW_LIMIT,
    }),
    queryFn: ({ signal }) =>
      fetchAbusePunches({ bucket, from: range.from, to: range.to }, ABUSE_ROW_LIMIT, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * All five bucket totals, from Postgres, in one query. Kept separate from the
 * rows so a failed count degrades the tab labels to an em dash while the queue
 * itself still renders (the PARTIAL state).
 */
export function useAbuseSignalCounts(range: AbuseRange): UseQueryResult<AbuseSignalCounts, Error> {
  return useQuery({
    queryKey: qk.admin.punches({ scope: "abuse-counts", from: range.from, to: range.to }),
    queryFn: ({ signal }) => fetchAbuseSignalCounts(range, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Purge register + the purge itself
// -----------------------------------------------------------------------------

/**
 * Every template set in admin scope, metadata only, for the purge register.
 *
 * `enabled` is opt-in exactly as on Face Templates: the `face-template-admin`
 * list op demands `biometric.template.manage` WITH a step-up and writes a
 * `bulk_view` data-access row, so it must not fire because somebody opened the
 * screen to read the warning at the top of it.
 */
export function usePurgeRegister(enabled: boolean): UseQueryResult<TemplateListPage, Error> {
  return useQuery({
    // Under the `kiosk-templates` prefix on purpose — see the file header.
    queryKey: qk.admin.faceTemplates("purge-register", 0),
    queryFn: ({ signal }) =>
      fetchFaceTemplates({ state: "all", limit: PURGE_REGISTER_LIMIT }, signal),
    enabled,
    retry: false,
  });
}

export interface PurgeMutationInput extends PurgeInput {
  readonly basis: PurgeLegalBasis;
  readonly counterSignerName: string;
}

/**
 * Destroy biometric material for one employee (or one version of it).
 *
 * The typed sentence arrives as `reason`; `purgeReason` prefixes the legal basis
 * and appends the counter-authorising super admin before it reaches the wire, so
 * the audit row carries all three parts of the decision and not just the prose.
 *
 * `minReasonLength` is the op's own floor of 20 rather than the console's 15: the
 * server refuses less, and refusing here saves the admin a round trip.
 */
export function usePurgeMutation(): AuditedMutationResult<PurgeResult, PurgeMutationInput> {
  return useAuditedMutation<PurgeResult, PurgeMutationInput>({
    mutationFn: (input, reason) =>
      purgeFaceTemplates(
        {
          scope: input.scope,
          employeeId: input.employeeId,
          ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
          confirmEmployeeCode: input.confirmEmployeeCode,
          idempotencyKey: input.idempotencyKey,
        },
        purgeReason({
          basis: input.basis,
          typed: reason,
          counterSignerName: input.counterSignerName,
        }),
      ),
    invalidate: [
      qk.admin.faceTemplatesAll(),
      qk.admin.enrolmentGaps(),
      qk.admin.enrolmentRequests(true),
      qk.admin.employeesAll(),
    ],
    minReasonLength: PURGE_REASON_MIN_LENGTH,
  });
}
