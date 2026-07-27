/**
 * useFaceEnrolment.ts — TanStack hooks for the per-employee enrolment console
 * (`/admin/kiosk/enrolment`).
 *
 * Keys come from `qk.*` only. Every write goes through `useAuditedMutation`, so
 * the typed reason travels as an argument into the `x-reason` header of exactly
 * one request and the console refreshes from the server rather than from an
 * optimistic guess.
 *
 * The template read here is deliberately PER EMPLOYEE rather than the org-wide
 * `useFaceTemplates("all", 0)` the other two biometric screens use. `face-enrol`
 * stores one row per accepted SAMPLE — five rows per set — so a 50-row page
 * covers only ten sets and would silently report "no template" for the eleventh
 * employee onwards. Scoping the read also narrows the `data_access` row it writes
 * to the one subject an administrator actually opened.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import { TTApiError } from "@/shared/api/invoke";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  EMAIL_TRANSPORT_UNCONFIGURED,
  INVITATION_CANCELLED_STATUS,
  INVITATION_FULFILLED_STATUS,
  closeEnrolmentRequest,
  createEnrolmentInvitation,
  fetchEnrolmentRoster,
  fetchMyCapabilities,
  notifyEnrolmentRequired,
  revealEmployeeTemplates,
  type EnrolmentRosterRow,
  type TemplateRevealResult,
} from "../api/face-enrolment.api";
import { fetchFaceTemplates, type EnrolmentRequest, type TemplateListPage } from "../api/kiosk.api";

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** Every employee a face may be enrolled for, enrolled or not. */
export function useEnrolmentRoster(): UseQueryResult<EnrolmentRosterRow[], Error> {
  return useQuery({
    queryKey: qk.admin.employees({ scope: "face-enrolment-roster" }),
    queryFn: ({ signal }) => fetchEnrolmentRoster(500, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * One employee's template sets, through `face-template-admin list`.
 *
 * `enabled` is honoured because the call demands `biometric.template.manage` WITH
 * a step-up and writes a `data_access` row: it must happen because an
 * administrator asked to see this person's biometrics, never on navigation.
 * `retry: false` — a step-up refusal is a state this console renders, not a
 * transient failure to hammer.
 */
export function useEmployeeTemplates(
  employeeId: string | null,
  enabled: boolean,
): UseQueryResult<TemplateListPage, Error> {
  return useQuery({
    queryKey: qk.admin.employeeFaceTemplates(employeeId ?? "none"),
    queryFn: ({ signal }) =>
      fetchFaceTemplates({ state: "all", employeeId: employeeId ?? "", limit: 60 }, signal),
    enabled: enabled && employeeId !== null,
    retry: false,
  });
}

/**
 * The capabilities the caller's roles hold, for shaping this console's buttons.
 * Cached under the auth domain because it belongs to the session, not to a
 * screen — every admin surface that needs it should hit this one entry.
 */
export function useMyCapabilities(): UseQueryResult<string[], Error> {
  return useQuery({
    queryKey: qk.auth.detail("capabilities"),
    queryFn: ({ signal }) => fetchMyCapabilities(signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60 * 1_000,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/** Both spellings of the request list, so one write refreshes either grid. */
const REQUEST_KEYS = [
  qk.admin.enrolmentRequests(true),
  qk.admin.enrolmentRequests(false),
  qk.admin.enrolmentGaps(),
] as const;

/** What became of the email notice that accompanies an invitation. */
export type NoticeOutcome =
  | { readonly kind: "sent"; readonly total: number; readonly sent: number }
  | { readonly kind: "no_email" }
  | { readonly kind: "transport_unconfigured" }
  | { readonly kind: "failed"; readonly message: string };

export interface InitiateEnrolmentInput {
  readonly employeeId: string;
  /** From the directory row. No address ⇒ no send is attempted, and it says so. */
  readonly workEmail: string | null;
}

export interface InitiateEnrolmentResult {
  readonly request: EnrolmentRequest;
  readonly notice: NoticeOutcome;
}

function noticeFailure(error: unknown): NoticeOutcome {
  if (error instanceof TTApiError) {
    if (error.problem.code === EMAIL_TRANSPORT_UNCONFIGURED) {
      return { kind: "transport_unconfigured" };
    }
    return { kind: "failed", message: error.message };
  }
  return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Ask an employee to enrol: one durable, audited request row, then a best-effort
 * notice.
 *
 * The ORDER matters and the FAILURE MODE matters more. The request row is the
 * fact the employee and every later administrator can see; the email is a
 * courtesy that depends on a transport this project may not have provisioned. So
 * the row is written first and a failed notice is REPORTED, never thrown — a
 * rejected promise here would leave the console claiming nothing happened while
 * the request exists in the database.
 */
export function useInitiateEnrolmentMutation(): AuditedMutationResult<
  InitiateEnrolmentResult,
  InitiateEnrolmentInput
> {
  return useAuditedMutation<InitiateEnrolmentResult, InitiateEnrolmentInput>({
    mutationFn: async (input, reason) => {
      const request = await createEnrolmentInvitation(input.employeeId, reason);
      if (input.workEmail === null || input.workEmail.trim() === "") {
        return { request, notice: { kind: "no_email" } };
      }
      try {
        const result = await notifyEnrolmentRequired(input.employeeId);
        return {
          request,
          notice: {
            kind: "sent",
            total: result.recipients.total,
            sent: result.recipients.sent ?? 0,
          },
        };
      } catch (error) {
        return { request, notice: noticeFailure(error) };
      }
    },
    invalidate: [...REQUEST_KEYS],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/** Re-send the notice for a request that is already on file. */
export function useEnrolmentNoticeMutation(): AuditedMutationResult<NoticeOutcome, InitiateEnrolmentInput> {
  return useAuditedMutation<NoticeOutcome, InitiateEnrolmentInput>({
    mutationFn: async (input) => {
      if (input.workEmail === null || input.workEmail.trim() === "") {
        return { kind: "no_email" };
      }
      try {
        const result = await notifyEnrolmentRequired(input.employeeId);
        return { kind: "sent", total: result.recipients.total, sent: result.recipients.sent ?? 0 };
      } catch (error) {
        return noticeFailure(error);
      }
    },
    // Routine re-send of a notice whose justification is the request row itself.
    defaultReason: "admin console: re-sent the face enrolment notice",
  });
}

export interface CloseRequestInput {
  readonly requestId: string;
  readonly outcome: typeof INVITATION_FULFILLED_STATUS | typeof INVITATION_CANCELLED_STATUS;
}

/** Close an open enrolment request — fulfilled after a capture, or cancelled. */
export function useCloseEnrolmentRequestMutation(): AuditedMutationResult<
  EnrolmentRequest,
  CloseRequestInput
> {
  return useAuditedMutation<EnrolmentRequest, CloseRequestInput>({
    mutationFn: (input, reason) => closeEnrolmentRequest(input, reason),
    invalidate: [...REQUEST_KEYS],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/**
 * Reveal one employee's enrolment reference photo(s).
 *
 * A mutation rather than a query on purpose: the call mints a 60-second signed
 * URL and writes a `data_access` reveal row against this administrator for this
 * subject. That must happen because someone asked, once, with a reason — never
 * as a side effect of rendering.
 */
export function useTemplateRevealMutation(): AuditedMutationResult<TemplateRevealResult, string> {
  return useAuditedMutation<TemplateRevealResult, string>({
    mutationFn: (employeeId, reason) => revealEmployeeTemplates(employeeId, reason),
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}
