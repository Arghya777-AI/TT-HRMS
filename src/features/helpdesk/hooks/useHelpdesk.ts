/**
 * useHelpdesk.ts — hooks for `/me/helpdesk/:id`. Keys from `qk.helpdesk.*` only.
 *
 * Two rules this file follows, both learned the hard way elsewhere in this build:
 *
 *  1. Nothing is optimistic. A posted reply and a withdrawal both change server
 *     state the client cannot predict — `act_on_approval` may move the status,
 *     the level and `current_approver_ids` in the same transaction — so every
 *     write re-reads the thread instead of patching a local copy.
 *  2. One write invalidates every list the same request appears on: the thread
 *     itself, `/me/apply`'s open-requests grid and `/me/approvals`' tracking
 *     section all read `approval_requests`, and a withdrawn request that still
 *     shows as pending two screens away is the `7 vs 8` defect.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  fetchTicketThread,
  postTicketReply,
  withdrawTicket,
  type ActOnApprovalResult,
  type ReplyAction,
  type TicketThread,
} from "../api/ticket.api";

/**
 * One thread by the reference in the URL — a uuid or a `request_number`.
 *
 * `null` data is a real, final answer ("no such thread for you"), not a loading
 * state, so the page renders its not-found state rather than a spinner.
 */
export function useTicketThread(
  idOrNumber: string | undefined,
): UseQueryResult<TicketThread | null, Error> {
  const key = idOrNumber ?? "";
  return useQuery({
    queryKey: qk.helpdesk.detail(key),
    queryFn: ({ signal }) => fetchTicketThread(key, signal),
    enabled: key.length > 0,
    retry: shouldRetryQuery,
  });
}

export interface TicketReplyInput {
  readonly requestId: string;
  /** `comment`, or `provide_info` when an approver asked a question. */
  readonly action: ReplyAction;
  /** The request number, quoted back in any failure message. */
  readonly reference: string;
}

/**
 * Post a reply. The typed text is the audited reason AND the visible comment, so
 * `useAuditedMutation` carries it once and both land identical.
 */
export function usePostTicketReply(): AuditedMutationResult<
  ActOnApprovalResult,
  TicketReplyInput
> {
  return useAuditedMutation<ActOnApprovalResult, TicketReplyInput>({
    mutationFn: (input, reason) =>
      postTicketReply(input.requestId, input.action, reason, input.reference),
    invalidate: [qk.helpdesk.all, qk.apply.all, qk.approvals.all],
  });
}

export interface TicketWithdrawInput {
  readonly requestId: string;
  readonly reference: string;
}

/** Withdraw the request. Also invalidates leave, since most requests are leave. */
export function useWithdrawTicket(): AuditedMutationResult<
  ActOnApprovalResult,
  TicketWithdrawInput
> {
  return useAuditedMutation<ActOnApprovalResult, TicketWithdrawInput>({
    mutationFn: (input, reason) => withdrawTicket(input.requestId, reason, input.reference),
    invalidate: [qk.helpdesk.all, qk.apply.all, qk.approvals.all, qk.leave.all],
  });
}
