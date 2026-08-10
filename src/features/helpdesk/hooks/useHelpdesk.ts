/**
 * useHelpdesk.ts — hooks for both things the help desk feature holds.
 *
 * `/me/helpdesk/:id` reads a REQUEST THREAD (an `approval_requests` row). The
 * bottom half of this file reads the TICKET QUEUE (`helpdesk_tickets`, migration
 * 041500). They are separate objects — one has an approver and a decision, the
 * other an assignee and a conversation — and they take separate query keys for
 * that reason; see the comment on `qk.helpdesk`.
 *
 * Keys from `qk.helpdesk.*` only.
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
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
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
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchMyTickets,
  fetchTicketMessages,
  postTicketMessage,
  raiseTicket,
  setMyTicketStatus,
  type HelpdeskMessage,
  type HelpdeskTicket,
  type RaiseTicketInput,
} from "../api/helpdesk.api";

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


// -----------------------------------------------------------------------------
// The ticket queue (helpdesk_tickets / helpdesk_messages, migration 041500)
// -----------------------------------------------------------------------------

/** My tickets, newest first. RLS is the boundary. */
export function useMyTickets(): UseQueryResult<HelpdeskTicket[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.helpdesk.myTickets(),
    queryFn: ({ signal }) => fetchMyTickets(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * One ticket's conversation.
 *
 * `enabled` on a null id rather than a separate hook: the detail row opens and
 * closes, and a hook that must not be called conditionally is a hook that ends
 * up called with an empty string instead.
 */
export function useTicketMessages(
  ticketId: string | null,
): UseQueryResult<HelpdeskMessage[], Error> {
  return useQuery({
    queryKey: qk.helpdesk.ticketMessages(ticketId ?? "none"),
    queryFn: ({ signal }) => fetchTicketMessages(ticketId ?? "", signal),
    enabled: ticketId !== null,
    retry: shouldRetryQuery,
  });
}

/*
  These three are plain useMutation, not useAuditedMutation, and that is a fact
  about the database rather than a shortcut: neither `helpdesk_tickets` nor
  `helpdesk_messages` is in `audit.reason_required_tables`, so no `x-reason`
  header is demanded and inventing one would put a second, unread copy of the
  message into the audit log. The two hooks above them in this file DO use it,
  because `approval_requests` is on that list.
*/

export function useRaiseTicket(): UseMutationResult<
  HelpdeskTicket,
  Error,
  Omit<RaiseTicketInput, "employeeId">
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<RaiseTicketInput, "employeeId">) =>
      raiseTicket({ ...input, employeeId: requireEmployeeId(employeeId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.helpdesk.myTickets() });
    },
    retry: false,
  });
}

/**
 * Post a reply.
 *
 * Invalidates the TICKET LIST as well as the conversation: `trg_hdm__first_response`
 * stamps `first_responded_at` on the ticket when the desk writes, so a message
 * insert changes a row the list is showing.
 */
export function usePostTicketMessage(): UseMutationResult<
  HelpdeskMessage,
  Error,
  { ticketId: string; body: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ticketId: string; body: string }) =>
      postTicketMessage(input.ticketId, input.body),
    onSuccess: (_row, input) => {
      void client.invalidateQueries({ queryKey: qk.helpdesk.ticketMessages(input.ticketId) });
      void client.invalidateQueries({ queryKey: qk.helpdesk.myTickets() });
    },
    retry: false,
  });
}

/** Cancel or reopen — the two transitions `trg_hdt__guard` allows a requester. */
export function useSetTicketStatus(): UseMutationResult<
  HelpdeskTicket,
  Error,
  { ticketId: string; status: "cancelled" | "open" }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ticketId: string; status: "cancelled" | "open" }) =>
      setMyTicketStatus(input.ticketId, input.status),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.helpdesk.myTickets() });
    },
    retry: false,
  });
}
