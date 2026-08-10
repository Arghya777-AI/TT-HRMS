/**
 * useHelpdeskDesk — the queue behind `/admin/comms/helpdesk`.
 *
 * Same three conventions as `useCommsAdmin`, for the same reasons:
 *
 *  1. ONE FILTER SET, TWO QUERIES. The tile count and the grid are handed the
 *     same `(slice, desk, myProfileId)` triple, which `helpdesk-desk.api.ts`
 *     turns into one predicate array. The header total is Postgres's count of
 *     exactly the rows the grid is paging — never `rows.length`.
 *  2. KEYS COME FROM THE ROOT FACTORY. `qk.admin.list({ area: "helpdesk", … })`;
 *     nothing here invents an inline key array.
 *  3. WRITES ARE PLAIN MUTATIONS. Neither `helpdesk_tickets` nor
 *     `helpdesk_messages` is in `audit.reason_required_tables`, so no `x-reason`
 *     header is demanded — and `useAuditedMutation` would imply one that never
 *     gets sent. The audit trigger on the ticket table records the change
 *     regardless; what it would not carry is a typed reason, and the desk's
 *     reason is the message they just wrote.
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
import { useAuth } from "@/app/auth/AuthProvider";
import {
  countDeskTickets,
  fetchDeskMessages,
  fetchDeskTickets,
  postDeskMessage,
  runDeskAction,
  type DeskAction,
  type DeskActionResult,
  type DeskSlice,
  type DeskTicket,
  type HelpdeskDesk,
  type HelpdeskMessage,
} from "../api/helpdesk-desk.api";

/** Invalidation prefix for everything this screen reads. */
const DESK_AREA = { area: "helpdesk" } as const;

/**
 * My profile id — `profiles.id` is `auth.users.id`, so the session carries it
 * and no extra read is needed to answer "assigned to me".
 */
export function useMyProfileId(): string | null {
  const { user } = useAuth();
  return user?.id ?? null;
}

export function useDeskTickets(
  slice: DeskSlice,
  desk: HelpdeskDesk | null,
): UseQueryResult<DeskTicket[], Error> {
  const myProfileId = useMyProfileId();
  return useQuery({
    queryKey: qk.admin.list({ ...DESK_AREA, slice, desk: desk ?? "all", me: myProfileId ?? "none" }),
    queryFn: ({ signal }) => fetchDeskTickets(slice, desk, myProfileId, signal),
    retry: shouldRetryQuery,
  });
}

export function useDeskTicketCount(
  slice: DeskSlice,
  desk: HelpdeskDesk | null,
): UseQueryResult<number, Error> {
  const myProfileId = useMyProfileId();
  return useQuery({
    queryKey: qk.admin.list({
      ...DESK_AREA,
      entity: "count",
      slice,
      desk: desk ?? "all",
      me: myProfileId ?? "none",
    }),
    queryFn: ({ signal }) => countDeskTickets(slice, desk, myProfileId, signal),
    retry: shouldRetryQuery,
  });
}

export function useDeskMessages(
  ticketId: string | null,
): UseQueryResult<HelpdeskMessage[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ ...DESK_AREA, entity: "messages", ticketId: ticketId ?? "none" }),
    queryFn: ({ signal }) => fetchDeskMessages(ticketId ?? "", signal),
    enabled: ticketId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Reply or leave an internal note.
 *
 * Invalidates the ticket LISTS too, not just the thread:
 * `trg_hdm__first_response` stamps `first_responded_at` on the ticket when the
 * desk writes, so a message insert changes a row the grid is showing and the
 * breach badge on it.
 */
export function usePostDeskMessage(): UseMutationResult<
  HelpdeskMessage,
  Error,
  { ticketId: string; body: string; isInternal: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ticketId: string; body: string; isInternal: boolean }) =>
      postDeskMessage(input.ticketId, input.body, input.isInternal),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.admin.lists() });
      // The requester's own screens read the same rows under a different domain.
      void client.invalidateQueries({ queryKey: qk.helpdesk.all });
    },
    retry: false,
  });
}

export function useDeskAction(): UseMutationResult<
  DeskActionResult,
  Error,
  { ticketId: string; action: DeskAction; note: string | null }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ticketId: string; action: DeskAction; note: string | null }) =>
      runDeskAction(input.ticketId, input.action, input.note),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.admin.lists() });
      void client.invalidateQueries({ queryKey: qk.helpdesk.all });
    },
    retry: false,
  });
}
