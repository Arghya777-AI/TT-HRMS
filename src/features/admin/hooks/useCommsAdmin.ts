/**
 * useCommsAdmin — the data layer behind the seven `/admin/comms/*` screens.
 *
 * Three conventions, each of which exists because the alternative produced a
 * defect somewhere else in this console:
 *
 *  1. ONE FILTER OBJECT, TWO QUERIES. Every register exposes a `use…` rows hook
 *     and a `use…Count` hook, handed the SAME filters object, which
 *     `comms.api.ts` turns into one predicate array. The header total is then
 *     Postgres's count of exactly the rows the grid is paging (DR-29) — never
 *     `rows.length`.
 *  2. KEYS COME FROM THE ROOT FACTORY. `qk.admin.list({ area: "comms", … })`,
 *     so nothing here invents an inline key array. `COMMS_PREFIX`
 *     (`["admin","list"]`) is the invalidation prefix; nothing outside this
 *     feature uses `qk.admin.list`, so a comms write cannot sweep another
 *     screen's cache.
 *  3. WRITES ARE AUDITED, SENDS ARE NOT WRITES. Announcement and template
 *     changes go through `useAuditedMutation` (reason validated in the browser,
 *     `x-reason` header on the one request). The broadcast console calls an edge
 *     function, which owns its own audit row and idempotency key, so those two
 *     are plain mutations — wrapping them in the audited helper would imply a
 *     reason header that `invokeEdgeFn` does not send.
 */
import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery, SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { newIdempotencyKey } from "@/shared/api/invoke";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  archiveAnnouncementStatus,
  countAcknowledgements,
  countAnnouncements,
  countCommsTemplates,
  countCommunicationEvents,
  countCommunications,
  countNotifications,
  countPolicyDocuments,
  createAnnouncement,
  deleteAnnouncement,
  fetchAckDocumentTypes,
  fetchAcknowledgements,
  fetchAnnouncements,
  fetchCommsTemplates,
  fetchCommunicationEvents,
  fetchCommunications,
  fetchHelpdeskFlag,
  fetchNotifications,
  fetchPolicyAckStatus,
  fetchPolicyDocuments,
  previewBroadcast,
  publishAnnouncement,
  restoreAnnouncement,
  sendBroadcast,
  updateAnnouncement,
  updateTemplateCopy,
  type AckDocumentType,
  type AckFilters,
  type Acknowledgement,
  type Announcement,
  type AnnouncementFilters,
  type Communication,
  type CommunicationEvent,
  type CommsTemplate,
  type CreateAnnouncementInput,
  type DryRunResult,
  type EventFilters,
  type FeatureFlag,
  type NotificationFilters,
  type NotificationRow,
  type PolicyAckStatus,
  type PolicyDocument,
  type PolicyFilters,
  type SendRequest,
  type SendResult,
  type TemplateCopyInput,
  type TemplateFilters,
  type UpdateAnnouncementInput,
} from "../api/comms.api";

/** Every comms key is `["admin","list",{area:"comms",…}]`. */
function commsKey(entity: string, params: Record<string, unknown> = {}) {
  return qk.admin.list({ area: "comms", entity, ...params });
}

/** Invalidation prefix for the whole comms area. */
export const COMMS_PREFIX = qk.admin.lists();

// -----------------------------------------------------------------------------
// Announcements
// -----------------------------------------------------------------------------

/** Filters flattened to plain comparable data, so equal filters share a cache entry. */
function announcementKeyParams(f: AnnouncementFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    kinds: [...(f.kinds ?? [])].sort(),
    priorities: [...(f.priorities ?? [])].sort(),
    pinnedOnly: f.pinnedOnly === true,
    ackOnly: f.ackOnly === true,
    titleLike: f.titleLike ?? "",
    archived: f.archived === true,
  };
}

export function useAnnouncements(
  f: AnnouncementFilters,
): UseQueryResult<Announcement[], Error> {
  return useQuery({
    queryKey: commsKey("announcements", { ...announcementKeyParams(f), view: "rows" }),
    queryFn: ({ signal }) => fetchAnnouncements(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useAnnouncementCount(f: AnnouncementFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("announcements", { ...announcementKeyParams(f), view: "count" }),
    queryFn: ({ signal }) => countAnnouncements(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useCreateAnnouncement(
  onDone?: (row: Announcement) => void,
): AuditedMutationResult<Announcement, CreateAnnouncementInput> {
  return useAuditedMutation<Announcement, CreateAnnouncementInput>({
    mutationFn: (input, reason) => createAnnouncement(input, reason),
    invalidate: [COMMS_PREFIX],
    ...(onDone ? { onSuccess: (row) => onDone(row) } : {}),
  });
}

export function useUpdateAnnouncement(
  onDone?: (row: Announcement) => void,
): AuditedMutationResult<Announcement, UpdateAnnouncementInput> {
  return useAuditedMutation<Announcement, UpdateAnnouncementInput>({
    mutationFn: (input, reason) => updateAnnouncement(input, reason),
    invalidate: [COMMS_PREFIX],
    ...(onDone ? { onSuccess: (row) => onDone(row) } : {}),
  });
}

export interface PublishAnnouncementInput {
  readonly id: string;
  readonly actorProfileId: string;
}

/**
 * Publishing is the moment the whole venue can read it, so it carries the D-21
 * floor of 15 characters rather than the database's 10.
 */
export function usePublishAnnouncement(
  onDone?: (row: Announcement) => void,
): AuditedMutationResult<Announcement, PublishAnnouncementInput> {
  return useAuditedMutation<Announcement, PublishAnnouncementInput>({
    mutationFn: (input, reason) => publishAnnouncement(input, reason),
    invalidate: [COMMS_PREFIX],
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone ? { onSuccess: (row) => onDone(row) } : {}),
  });
}

export function useArchiveAnnouncement(): AuditedMutationResult<
  Announcement,
  { readonly id: string }
> {
  return useAuditedMutation<Announcement, { readonly id: string }>({
    mutationFn: (input, reason) => archiveAnnouncementStatus(input, reason),
    invalidate: [COMMS_PREFIX],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export function useDeleteAnnouncement(): AuditedMutationResult<
  { readonly id: string },
  { readonly id: string }
> {
  return useAuditedMutation<{ readonly id: string }, { readonly id: string }>({
    mutationFn: (input, reason) => deleteAnnouncement(input, reason),
    invalidate: [COMMS_PREFIX],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export function useRestoreAnnouncement(): AuditedMutationResult<
  { readonly id: string },
  { readonly id: string }
> {
  return useAuditedMutation<{ readonly id: string }, { readonly id: string }>({
    mutationFn: (input, reason) => restoreAnnouncement(input, reason),
    invalidate: [COMMS_PREFIX],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

// -----------------------------------------------------------------------------
// Message templates
// -----------------------------------------------------------------------------

function templateKeyParams(f: TemplateFilters): Record<string, unknown> {
  return {
    channels: [...(f.channels ?? [])].sort(),
    activeOnly: f.activeOnly === true,
    transactionalOnly: f.transactionalOnly === true,
    codeLike: f.codeLike ?? "",
  };
}

export function useCommsTemplates(f: TemplateFilters): UseQueryResult<CommsTemplate[], Error> {
  return useQuery({
    queryKey: commsKey("templates", { ...templateKeyParams(f), view: "rows" }),
    queryFn: ({ signal }) => fetchCommsTemplates(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useCommsTemplateCount(f: TemplateFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("templates", { ...templateKeyParams(f), view: "count" }),
    queryFn: ({ signal }) => countCommsTemplates(f, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Rewriting transactional copy is a D-21-grade change — every employee reads it
 * and there is no version table to roll back to — so the floor is 15 characters
 * and the audit log is the history.
 */
export function useUpdateTemplateCopy(
  onDone?: (row: CommsTemplate) => void,
): AuditedMutationResult<CommsTemplate, TemplateCopyInput> {
  return useAuditedMutation<CommsTemplate, TemplateCopyInput>({
    mutationFn: (input, reason) => updateTemplateCopy(input, reason),
    invalidate: [COMMS_PREFIX, qk.admin.notificationTemplates()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone ? { onSuccess: (row) => onDone(row) } : {}),
  });
}

// -----------------------------------------------------------------------------
// Delivery log
// -----------------------------------------------------------------------------

function notificationKeyParams(f: NotificationFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    channels: [...(f.channels ?? [])].sort(),
    priorities: [...(f.priorities ?? [])].sort(),
    eventCode: f.eventCode ?? "",
    fromDate: f.fromDate ?? "",
    toDate: f.toDate ?? "",
    unreadOnly: f.unreadOnly === true,
  };
}

export function useNotificationFeed(
  f: NotificationFilters,
): UseQueryResult<NotificationRow[], Error> {
  return useQuery({
    queryKey: commsKey("notifications", { ...notificationKeyParams(f), view: "rows" }),
    queryFn: ({ signal }) => fetchNotifications(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useNotificationCount(f: NotificationFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("notifications", { ...notificationKeyParams(f), view: "count" }),
    queryFn: ({ signal }) => countNotifications(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useCommunicationEvents(
  f: EventFilters,
): UseQueryResult<CommunicationEvent[], Error> {
  return useQuery({
    queryKey: commsKey("comm-events", { events: [...(f.events ?? [])].sort(), view: "rows" }),
    queryFn: ({ signal }) => fetchCommunicationEvents(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useCommunicationEventCount(f: EventFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("comm-events", { events: [...(f.events ?? [])].sort(), view: "count" }),
    queryFn: ({ signal }) => countCommunicationEvents(f, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Broadcasts
// -----------------------------------------------------------------------------

export function useCommunications(): UseQueryResult<Communication[], Error> {
  return useQuery({
    queryKey: commsKey("communications", { view: "rows" }),
    queryFn: ({ signal }) => fetchCommunications(signal),
    retry: shouldRetryQuery,
  });
}

export function useCommunicationCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("communications", { view: "count" }),
    queryFn: ({ signal }) => countCommunications(signal),
    retry: shouldRetryQuery,
  });
}

export type BroadcastInput = Omit<SendRequest, "dryRun">;

/**
 * The audience preview. Writes nothing, needs no idempotency key server-side,
 * and works with no email transport provisioned — so it is the honest way to
 * show an admin who a broadcast would reach.
 */
export function useBroadcastPreview(): UseMutationResult<DryRunResult, Error, BroadcastInput> {
  return useMutation<DryRunResult, Error, BroadcastInput>({
    mutationFn: (input) => previewBroadcast(input),
    retry: false,
  });
}

/**
 * The commit. One idempotency key per mount, reused on every retry of the same
 * dispatch, so a refused-then-retried send cannot mail twice. On success the
 * comms area is invalidated: `communications`, its recipients and its events all
 * gained rows inside the function's own two transactions.
 */
export function useBroadcastSend(): UseMutationResult<SendResult, Error, BroadcastInput> {
  const queryClient = useQueryClient();
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);
  return useMutation<SendResult, Error, BroadcastInput>({
    mutationFn: (input) => sendBroadcast(input, { idempotencyKey }),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COMMS_PREFIX });
    },
  });
}

// -----------------------------------------------------------------------------
// Acknowledgement compliance
// -----------------------------------------------------------------------------

export function usePolicyAckStatus(): UseQueryResult<PolicyAckStatus[], Error> {
  return useQuery({
    queryKey: commsKey("policy-ack-status"),
    queryFn: ({ signal }) => fetchPolicyAckStatus(signal),
    retry: shouldRetryQuery,
  });
}

function ackKeyParams(f: AckFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    documentId: f.documentId ?? "",
    overdueOnly: f.overdueOnly === true,
    today: f.today ?? "",
  };
}

export function useAcknowledgements(f: AckFilters): UseQueryResult<Acknowledgement[], Error> {
  return useQuery({
    queryKey: commsKey("acknowledgements", { ...ackKeyParams(f), view: "rows" }),
    queryFn: ({ signal }) => fetchAcknowledgements(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useAcknowledgementCount(f: AckFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("acknowledgements", { ...ackKeyParams(f), view: "count" }),
    queryFn: ({ signal }) => countAcknowledgements(f, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Policy publication
// -----------------------------------------------------------------------------

function policyKeyParams(f: PolicyFilters): Record<string, unknown> {
  return {
    subjectKind: f.subjectKind ?? "",
    documentTypeId: f.documentTypeId ?? "",
    ackRequiredOnly: f.ackRequiredOnly === true,
    titleLike: f.titleLike ?? "",
  };
}

export function usePolicyDocuments(f: PolicyFilters): UseQueryResult<PolicyDocument[], Error> {
  return useQuery({
    queryKey: commsKey("policy-documents", { ...policyKeyParams(f), view: "rows" }),
    queryFn: ({ signal }) => fetchPolicyDocuments(f, signal),
    retry: shouldRetryQuery,
  });
}

export function usePolicyDocumentCount(f: PolicyFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: commsKey("policy-documents", { ...policyKeyParams(f), view: "count" }),
    queryFn: ({ signal }) => countPolicyDocuments(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useAckDocumentTypes(): UseQueryResult<AckDocumentType[], Error> {
  return useQuery({
    queryKey: commsKey("ack-document-types"),
    queryFn: ({ signal }) => fetchAckDocumentTypes(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Help Desk
// -----------------------------------------------------------------------------

/**
 * The `help_desk` feature-flag row.
 *
 * The Help Desk screen used to read this INSTEAD of a queue, because
 * `helpdesk_tickets` did not exist (404 / PGRST205) and the flag was the only
 * real thing to show. Migration 041500 created the tables and flipped the flag,
 * and the screen now reads the queue itself — so nothing calls this today. It is
 * kept because the flag row is still the register's answer to "is the ticketing
 * module on", and the feature-flag screen is the natural next caller.
 */
export function useHelpdeskFlag(): UseQueryResult<FeatureFlag | null, Error> {
  return useQuery({
    queryKey: commsKey("helpdesk-flag"),
    queryFn: async ({ signal }) => {
      const rows = await fetchHelpdeskFlag(signal);
      return rows[0] ?? null;
    },
    retry: shouldRetryQuery,
  });
}
