/**
 * comms.api.ts — the read/write layer behind the seven `/admin/comms/*` screens
 * (spec-admin §14 Communications).
 *
 * Every relation named here was verified against the live project
 * (`xfoeudhwxlbkkwetncjb`) as the HR-admin persona before a line of UI was
 * written, because "the screen is honest about what the backend has" is the
 * whole brief:
 *
 *   announcements                     200, 0 rows  (admin FOR ALL; insert/update
 *                                                   /publish/soft-delete all
 *                                                   verified end to end)
 *   notification_templates            206, 58 rows (26 event codes × channels)
 *   notifications                     206,  6 rows (KIOSK_OFFLINE, queued)
 *   communications                    200, 0 rows
 *   communication_recipients          200, 0 rows
 *   communication_events              200, 0 rows
 *   document_acknowledgements         200, 0 rows
 *   documents                         200, 0 rows
 *   v_policy_acknowledgement_status   200, 0 rows
 *   helpdesk_tickets                  404 PGRST205 — NOT DEPLOYED. There is no
 *                                     ticketing table in any migration; the
 *                                     module is a `feature_flags` row
 *                                     (`help_desk`, planned 2027-04-01). So
 *                                     there is no read function for it here and
 *                                     the screen says so instead of guessing.
 *
 * Three rules this file keeps:
 *  1. One predicate builder per register feeds BOTH the rows and `selectCount`,
 *     so a header total and its grid can never disagree (DR-29).
 *  2. Nothing is computed. `communications.delivered_count`,
 *     `v_policy_acknowledgement_status.acknowledged_pct` and the notification
 *     status counts are server columns / server COUNTs.
 *  3. `recorded_at` windows are built with `istRangeInstantBounds` — comparing a
 *     timestamptz against a bare 'YYYY-MM-DD' would silently drop the first
 *     05:30 of every IST day.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbPercentNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  ilike,
  inList,
  isNotNull,
  isNull,
  isTrue,
  lt,
  restoreRow,
  selectCount,
  selectMany,
  softDelete,
  updateRow,
  insertRow,
  type Filter,
} from "@/shared/api/query";
import { invokeEdgeFn } from "@/shared/api/invoke";
import { istRangeInstantBounds, nowInstantIso } from "@/lib/datetime";
import { featureFlagSchema, type FeatureFlag } from "./system.api";

export const ANNOUNCEMENTS_TABLE = "announcements";
export const NOTIFICATION_TEMPLATES_TABLE = "notification_templates";
export const NOTIFICATIONS_TABLE = "notifications";
export const COMMUNICATIONS_TABLE = "communications";
export const COMMUNICATION_RECIPIENTS_TABLE = "communication_recipients";
export const COMMUNICATION_EVENTS_TABLE = "communication_events";
export const DOCUMENT_ACKNOWLEDGEMENTS_TABLE = "document_acknowledgements";
export const DOCUMENTS_TABLE = "documents";
export const DOCUMENT_TYPES_TABLE = "document_types";
export const V_POLICY_ACK_STATUS = "v_policy_acknowledgement_status";
export const FEATURE_FLAGS_TABLE = "feature_flags";
export const COMMUNICATION_SEND_FN = "communication-send";

/** The table the Help Desk screen would need. Probed live: 404 / PGRST205. */
export const HELPDESK_TICKETS_TABLE = "helpdesk_tickets";
/** `feature_flags.key` that governs the ticketing module. */
export const HELPDESK_FLAG_KEY = "help_desk";

/** Row caps. Every register here is append-only or slow-growing. */
export const ANNOUNCEMENT_ROW_CAP = 200;
export const TEMPLATE_ROW_CAP = 300;
export const NOTIFICATION_ROW_CAP = 300;
export const ACK_ROW_CAP = 300;
export const POLICY_ROW_CAP = 200;
export const SEND_ROW_CAP = 100;
export const EVENT_ROW_CAP = 300;

// -----------------------------------------------------------------------------
// 1. announcements — the noticeboard (migration 027 §1)
// -----------------------------------------------------------------------------

/** `ck_announcements__status`. */
export const announcementStatusSchema = z.enum(["draft", "scheduled", "published", "archived"]);
export type AnnouncementStatus = z.infer<typeof announcementStatusSchema>;

/** `ck_announcements__kind`. */
export const announcementKindSchema = z.enum([
  "general",
  "policy_change",
  "event_briefing",
  "celebration",
  "safety_alert",
  "roster_published",
  "holiday_notice",
]);
export type AnnouncementKind = z.infer<typeof announcementKindSchema>;

/** `ck_announcements__priority`. */
export const announcementPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export type AnnouncementPriority = z.infer<typeof announcementPrioritySchema>;

/**
 * `announcements.audience` — the shape the column COMMENT documents and the
 * shape `app.announcement_visible()` matches against. Unknown keys are kept:
 * this screen must not silently drop an audience selector some other surface
 * wrote.
 */
export const audienceSchema = z
  .object({
    all: z.boolean().optional(),
    department_ids: z.array(z.string()).optional(),
    location_ids: z.array(z.string()).optional(),
    employment_types: z.array(z.string()).optional(),
    employee_ids: z.array(z.string()).optional(),
  })
  .passthrough();
export type Audience = z.infer<typeof audienceSchema>;

export const announcementSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  title: z.string(),
  body_markdown: z.string(),
  announcement_kind: z.string(),
  priority: z.string(),
  publish_at: dbTimestampNullable,
  expires_at: dbTimestampNullable,
  audience: audienceSchema,
  pinned: z.boolean(),
  requires_acknowledgement: z.boolean(),
  document_id: dbUuidNullable,
  published_by: dbUuidNullable,
  published_at: dbTimestampNullable,
  /** Stamped by the noticeboard read path, never by this console. */
  view_count: dbInt,
  status: z.string(),
  created_at: dbTimestamp,
  created_by: dbUuidNullable,
  updated_at: dbTimestamp,
  deleted_at: dbTimestampNullable,
  deletion_reason: z.string().nullable(),
});
export type Announcement = z.infer<typeof announcementSchema>;

const ANNOUNCEMENT_COLUMNS =
  "id, company_id, title, body_markdown, announcement_kind, priority, publish_at, " +
  "expires_at, audience, pinned, requires_acknowledgement, document_id, published_by, " +
  "published_at, view_count, status, created_at, created_by, updated_at, deleted_at, " +
  "deletion_reason";

export interface AnnouncementFilters {
  readonly statuses?: readonly AnnouncementStatus[];
  readonly kinds?: readonly AnnouncementKind[];
  readonly priorities?: readonly AnnouncementPriority[];
  readonly pinnedOnly?: boolean;
  readonly ackOnly?: boolean;
  readonly titleLike?: string;
  /**
   * `announcements__admin__all` carries NO `deleted_at` predicate, so an admin
   * sees archived rows unless the screen excludes them. Default: live rows only;
   * `archived: true` shows ONLY the soft-deleted ones — that is the archive view
   * and it is labelled as such.
   */
  readonly archived?: boolean;
}

function announcementFilters(f: AnnouncementFilters): readonly Filter[] {
  const filters: Filter[] = [f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at")];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.kinds && f.kinds.length > 0) filters.push(inList("announcement_kind", f.kinds));
  if (f.priorities && f.priorities.length > 0) filters.push(inList("priority", f.priorities));
  if (f.pinnedOnly === true) filters.push(isTrue("pinned"));
  if (f.ackOnly === true) filters.push(isTrue("requires_acknowledgement"));
  const term = (f.titleLike ?? "").trim();
  if (term !== "") filters.push(ilike("title", `%${term}%`));
  return filters;
}

export function fetchAnnouncements(
  f: AnnouncementFilters,
  signal?: AbortSignal,
): Promise<Announcement[]> {
  return selectMany(ANNOUNCEMENTS_TABLE, announcementSchema, {
    columns: ANNOUNCEMENT_COLUMNS,
    filters: announcementFilters(f),
    // Pinned first, then newest — the order the noticeboard itself reads in.
    order: [
      { column: "pinned", ascending: false },
      { column: "created_at", ascending: false },
    ],
    limit: ANNOUNCEMENT_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countAnnouncements(
  f: AnnouncementFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(ANNOUNCEMENTS_TABLE, announcementFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/** What the compose sheet sends. Absent fields are simply not written. */
export interface AnnouncementDraft {
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly kind: AnnouncementKind;
  readonly priority: AnnouncementPriority;
  readonly pinned: boolean;
  readonly requiresAcknowledgement: boolean;
  /** Instant, built by the form with `istWallClockToInstant`. */
  readonly publishAt?: string | null;
  readonly expiresAt?: string | null;
  readonly audience: Audience;
}

export interface CreateAnnouncementInput extends AnnouncementDraft {
  readonly companyId: string;
  /** `draft` or `scheduled`; publishing is its own, separately-reasoned act. */
  readonly status: Extract<AnnouncementStatus, "draft" | "scheduled">;
}

export function createAnnouncement(
  input: CreateAnnouncementInput,
  reason: string,
): Promise<Announcement> {
  return insertRow(
    ANNOUNCEMENTS_TABLE,
    {
      company_id: input.companyId,
      title: input.title,
      body_markdown: input.bodyMarkdown,
      announcement_kind: input.kind,
      priority: input.priority,
      pinned: input.pinned,
      requires_acknowledgement: input.requiresAcknowledgement,
      publish_at: input.publishAt ?? null,
      expires_at: input.expiresAt ?? null,
      audience: input.audience,
      status: input.status,
    },
    announcementSchema,
    { reason, columns: ANNOUNCEMENT_COLUMNS },
  );
}

export interface UpdateAnnouncementInput extends AnnouncementDraft {
  readonly id: string;
}

export function updateAnnouncement(
  input: UpdateAnnouncementInput,
  reason: string,
): Promise<Announcement> {
  return updateRow(
    ANNOUNCEMENTS_TABLE,
    [eq("id", input.id)],
    {
      title: input.title,
      body_markdown: input.bodyMarkdown,
      announcement_kind: input.kind,
      priority: input.priority,
      pinned: input.pinned,
      requires_acknowledgement: input.requiresAcknowledgement,
      publish_at: input.publishAt ?? null,
      expires_at: input.expiresAt ?? null,
      audience: input.audience,
    },
    announcementSchema,
    { reason, columns: ANNOUNCEMENT_COLUMNS },
  );
}

/**
 * Publish. `published_at`/`published_by` are stamped explicitly: no trigger
 * fills them, and a published notice with no publisher is not an audit trail.
 * The actor is the signed-in `profiles.id`.
 */
export function publishAnnouncement(
  input: { readonly id: string; readonly actorProfileId: string },
  reason: string,
): Promise<Announcement> {
  return updateRow(
    ANNOUNCEMENTS_TABLE,
    [eq("id", input.id)],
    {
      status: "published",
      published_at: nowInstantIso(),
      published_by: input.actorProfileId,
    },
    announcementSchema,
    { reason, columns: ANNOUNCEMENT_COLUMNS },
  );
}

/** Take a published notice off the board (status only — the row stays readable). */
export function archiveAnnouncementStatus(
  input: { readonly id: string },
  reason: string,
): Promise<Announcement> {
  return updateRow(
    ANNOUNCEMENTS_TABLE,
    [eq("id", input.id)],
    { status: "archived" },
    announcementSchema,
    { reason, columns: ANNOUNCEMENT_COLUMNS },
  );
}

/** Soft delete (D-23). `DELETE` is revoked on this table for `authenticated`. */
export function deleteAnnouncement(
  input: { readonly id: string },
  reason: string,
): Promise<{ readonly id: string }> {
  return softDelete(ANNOUNCEMENTS_TABLE, input.id, { reason }).then(() => ({ id: input.id }));
}

export function restoreAnnouncement(
  input: { readonly id: string },
  reason: string,
): Promise<{ readonly id: string }> {
  return restoreRow(ANNOUNCEMENTS_TABLE, input.id, { reason }).then(() => ({ id: input.id }));
}

// -----------------------------------------------------------------------------
// 2. notification_templates — the message copy register (migration 027 §2)
// -----------------------------------------------------------------------------

export const templateSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  channel: z.string(),
  subject_template: z.string().nullable(),
  body_template: z.string(),
  sms_template: z.string().nullable(),
  dlt_template_id: z.string().nullable(),
  whatsapp_template_name: z.string().nullable(),
  /** jsonb: the merge tokens this template declares. Rendered, never evaluated. */
  variables: z.unknown(),
  locale: z.string(),
  is_active: z.boolean(),
  is_transactional: z.boolean(),
  is_system: z.boolean(),
  updated_at: dbTimestamp,
});
export type CommsTemplate = z.infer<typeof templateSchema>;

const TEMPLATE_COLUMNS =
  "id, code, name, description, channel, subject_template, body_template, sms_template, " +
  "dlt_template_id, whatsapp_template_name, variables, locale, is_active, " +
  "is_transactional, is_system, updated_at";

/** `ck_notification_templates__sms_length` — TRAI/DLT registered copy. */
export const SMS_TEMPLATE_MAX_LENGTH = 160;

export interface TemplateFilters {
  readonly channels?: readonly string[];
  readonly activeOnly?: boolean;
  readonly transactionalOnly?: boolean;
  /** Matches the event code, e.g. 'LEAVE'. */
  readonly codeLike?: string;
}

function templateFilters(f: TemplateFilters): readonly Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.channels && f.channels.length > 0) filters.push(inList("channel", f.channels));
  if (f.activeOnly === true) filters.push(isTrue("is_active"));
  if (f.transactionalOnly === true) filters.push(isTrue("is_transactional"));
  const term = (f.codeLike ?? "").trim();
  if (term !== "") filters.push(ilike("code", `%${term}%`));
  return filters;
}

export function fetchCommsTemplates(
  f: TemplateFilters,
  signal?: AbortSignal,
): Promise<CommsTemplate[]> {
  return selectMany(NOTIFICATION_TEMPLATES_TABLE, templateSchema, {
    columns: TEMPLATE_COLUMNS,
    filters: templateFilters(f),
    order: [
      { column: "code", ascending: true },
      { column: "channel", ascending: true },
    ],
    limit: TEMPLATE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countCommsTemplates(f: TemplateFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(NOTIFICATION_TEMPLATES_TABLE, templateFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Rewrite the copy of one template row.
 *
 * `GRANT SELECT, INSERT, UPDATE ON public.notification_templates TO
 * authenticated` with a P8 `FOR ALL` policy, so an admin may edit any column —
 * including a seeded `is_system` row. There is NO template-version table in the
 * schema: the audit trigger on this table (migration 038) is the whole history,
 * which is why the screen shows the old value in the reason dialog and says
 * where the previous wording can be found.
 */
export interface TemplateCopyInput {
  readonly id: string;
  readonly subjectTemplate: string | null;
  readonly bodyTemplate: string;
  readonly smsTemplate: string | null;
}

export function updateTemplateCopy(
  input: TemplateCopyInput,
  reason: string,
): Promise<CommsTemplate> {
  return updateRow(
    NOTIFICATION_TEMPLATES_TABLE,
    [eq("id", input.id)],
    {
      subject_template: input.subjectTemplate,
      body_template: input.bodyTemplate,
      sms_template: input.smsTemplate,
    },
    templateSchema,
    { reason, columns: TEMPLATE_COLUMNS },
  );
}

// -----------------------------------------------------------------------------
// 3. notifications — the per-user delivery feed (migration 027 §6)
// -----------------------------------------------------------------------------

/** `public.notification_status` (migration 003). */
export const notificationStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "failed",
  "bounced",
  "suppressed",
  "cancelled",
]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

/** `public.notification_channel` (migration 003). */
export const notificationChannelSchema = z.enum([
  "in_app",
  "email",
  "sms",
  "whatsapp",
  "push",
  "kiosk_display",
]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationSchema = z.object({
  id: dbUuid,
  employee_id: dbUuidNullable,
  profile_id: dbUuidNullable,
  event_code: z.string(),
  channel: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  deep_link: z.string().nullable(),
  priority: z.string(),
  status: z.string(),
  scheduled_for: dbTimestampNullable,
  sent_at: dbTimestampNullable,
  delivered_at: dbTimestampNullable,
  read_at: dbTimestampNullable,
  dismissed_at: dbTimestampNullable,
  provider_message_id: z.string().nullable(),
  failure_detail: z.string().nullable(),
  retry_count: dbInt,
  recorded_at: dbTimestamp,
});
export type NotificationRow = z.infer<typeof notificationSchema>;

const NOTIFICATION_COLUMNS =
  "id, employee_id, profile_id, event_code, channel, title, body, deep_link, priority, " +
  "status, scheduled_for, sent_at, delivered_at, read_at, dismissed_at, " +
  "provider_message_id, failure_detail, retry_count, recorded_at";

export interface NotificationFilters {
  readonly statuses?: readonly NotificationStatus[];
  readonly channels?: readonly NotificationChannel[];
  readonly eventCode?: string;
  readonly priorities?: readonly string[];
  /** IST civil dates, inclusive. Converted to a half-open instant window. */
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly unreadOnly?: boolean;
}

function notificationFilters(f: NotificationFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.channels && f.channels.length > 0) filters.push(inList("channel", f.channels));
  if (f.priorities && f.priorities.length > 0) filters.push(inList("priority", f.priorities));
  const code = (f.eventCode ?? "").trim();
  if (code !== "") filters.push(eq("event_code", code));
  if (f.fromDate !== undefined && f.toDate !== undefined) {
    const { fromInstant, toInstantExclusive } = istRangeInstantBounds(f.fromDate, f.toDate);
    filters.push(gte("recorded_at", fromInstant));
    // Upper bound is EXCLUSIVE — see istRangeInstantBounds.
    filters.push(lt("recorded_at", toInstantExclusive));
  }
  if (f.unreadOnly === true) filters.push(isNull("read_at"));
  return filters;
}

export function fetchNotifications(
  f: NotificationFilters,
  signal?: AbortSignal,
): Promise<NotificationRow[]> {
  return selectMany(NOTIFICATIONS_TABLE, notificationSchema, {
    columns: NOTIFICATION_COLUMNS,
    filters: notificationFilters(f),
    order: [{ column: "recorded_at", ascending: false }],
    limit: NOTIFICATION_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countNotifications(f: NotificationFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(NOTIFICATIONS_TABLE, notificationFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. communications + communication_events — the outbound email trail (§3–5)
// -----------------------------------------------------------------------------

export const communicationSchema = z.object({
  id: dbUuid,
  communication_number: z.string(),
  subject: z.string(),
  communication_kind: z.string(),
  channels: z.array(z.string()),
  requires_signing: z.boolean(),
  send_mode: z.string(),
  scheduled_at: dbTimestampNullable,
  sent_at: dbTimestampNullable,
  status: z.string(),
  /** Server counters, maintained by `communication-send` txn 2. Never summed here. */
  recipient_count: dbInt,
  delivered_count: dbInt,
  opened_count: dbInt,
  signed_count: dbInt,
  failed_count: dbInt,
  from_email: z.string().nullable(),
  created_at: dbTimestamp,
});
export type Communication = z.infer<typeof communicationSchema>;

const COMMUNICATION_COLUMNS =
  "id, communication_number, subject, communication_kind, channels, requires_signing, " +
  "send_mode, scheduled_at, sent_at, status, recipient_count, delivered_count, " +
  "opened_count, signed_count, failed_count, from_email, created_at";

export function fetchCommunications(signal?: AbortSignal): Promise<Communication[]> {
  return selectMany(COMMUNICATIONS_TABLE, communicationSchema, {
    columns: COMMUNICATION_COLUMNS,
    order: [{ column: "created_at", ascending: false }],
    limit: SEND_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countCommunications(signal?: AbortSignal): Promise<number> {
  return selectCount(COMMUNICATIONS_TABLE, [], { ...(signal ? { signal } : {}) });
}

/** `ck_communication_events__event` — the provider vocabulary, verbatim. */
export const communicationEventSchema = z.object({
  id: dbUuid,
  communication_id: dbUuid,
  recipient_id: dbUuidNullable,
  event: z.string(),
  provider: z.string().nullable(),
  occurred_at: dbTimestamp,
});
export type CommunicationEvent = z.infer<typeof communicationEventSchema>;

export interface EventFilters {
  readonly events?: readonly string[];
}

function eventFilters(f: EventFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.events && f.events.length > 0) filters.push(inList("event", f.events));
  return filters;
}

export function fetchCommunicationEvents(
  f: EventFilters,
  signal?: AbortSignal,
): Promise<CommunicationEvent[]> {
  return selectMany(COMMUNICATION_EVENTS_TABLE, communicationEventSchema, {
    columns: "id, communication_id, recipient_id, event, provider, occurred_at",
    filters: eventFilters(f),
    order: [{ column: "occurred_at", ascending: false }],
    limit: EVENT_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countCommunicationEvents(f: EventFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(COMMUNICATION_EVENTS_TABLE, eventFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Acknowledgement compliance (migration 025 §5, view 037 §6)
// -----------------------------------------------------------------------------

export const policyAckStatusSchema = z.object({
  document_id: dbUuid,
  document_title: z.string(),
  document_type_code: z.string(),
  document_type_name: z.string(),
  /** All five are server COUNTs inside the view. */
  assigned: dbInt,
  opened: dbInt,
  acknowledged: dbInt,
  waived: dbInt,
  overdue: dbInt,
  /** The view already multiplied and rounded; the client must not. */
  acknowledged_pct: dbPercentNullable,
  earliest_open_due_on: dbDateNullable,
});
export type PolicyAckStatus = z.infer<typeof policyAckStatusSchema>;

export function fetchPolicyAckStatus(signal?: AbortSignal): Promise<PolicyAckStatus[]> {
  return selectMany(V_POLICY_ACK_STATUS, policyAckStatusSchema, {
    order: [{ column: "document_title", ascending: true }],
    limit: POLICY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** `ck_da__status`. */
export const ackStatusSchema = z.enum(["assigned", "opened", "acknowledged", "overdue", "waived"]);
export type AckStatus = z.infer<typeof ackStatusSchema>;

export const acknowledgementSchema = z.object({
  id: dbUuid,
  document_id: dbUuid,
  employee_id: dbUuid,
  assigned_at: dbTimestamp,
  due_on: dbDateNullable,
  first_opened_at: dbTimestampNullable,
  open_count: dbInt,
  /** The informed-consent evidence pair the ack guard enforces (>=90%, dwell). */
  total_read_seconds: dbInt,
  scroll_completion_pct: dbPercentNullable,
  acknowledged_at: dbTimestampNullable,
  acknowledgement_text: z.string().nullable(),
  status: z.string(),
  waived_at: dbTimestampNullable,
  waived_reason: z.string().nullable(),
  reminder_count: dbInt,
  last_reminder_at: dbTimestampNullable,
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

const ACK_COLUMNS =
  "id, document_id, employee_id, assigned_at, due_on, first_opened_at, open_count, " +
  "total_read_seconds, scroll_completion_pct, acknowledged_at, acknowledgement_text, " +
  "status, waived_at, waived_reason, reminder_count, last_reminder_at";

export interface AckFilters {
  readonly statuses?: readonly AckStatus[];
  readonly documentId?: string;
  /** Open (not acknowledged/waived) AND past due — the compliance debt. */
  readonly overdueOnly?: boolean;
  /** IST civil date used as "today" for the overdue predicate. */
  readonly today?: string;
}

function ackFilters(f: AckFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.documentId !== undefined && f.documentId !== "") {
    filters.push(eq("document_id", f.documentId));
  }
  if (f.overdueOnly === true && f.today !== undefined) {
    filters.push(inList("status", ["assigned", "opened", "overdue"]));
    filters.push(lt("due_on", f.today));
  }
  return filters;
}

export function fetchAcknowledgements(
  f: AckFilters,
  signal?: AbortSignal,
): Promise<Acknowledgement[]> {
  return selectMany(DOCUMENT_ACKNOWLEDGEMENTS_TABLE, acknowledgementSchema, {
    columns: ACK_COLUMNS,
    filters: ackFilters(f),
    order: [{ column: "due_on", ascending: true }],
    limit: ACK_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countAcknowledgements(f: AckFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENT_ACKNOWLEDGEMENTS_TABLE, ackFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 6. Policy publication — policies ARE documents (migration 025 §2)
// -----------------------------------------------------------------------------
//
// There is no `policies` table anywhere in the schema. A policy is a row in
// `documents` with `subject_kind = 'policy'` (or a company-wide document of a
// type whose `requires_acknowledgement` is set) and it is circulated with
// `communication-send` in `mode: "policy"`, which mints the single-use ack link.
// So this register reads `documents` and `document_types`, and the screen says
// where a new version comes from rather than offering an upload it does not have.

export const policyDocumentSchema = z.object({
  id: dbUuid,
  title: z.string(),
  document_type_id: dbUuid,
  subject_kind: z.string(),
  employee_id: dbUuidNullable,
  status: z.string(),
  issue_date: dbDateNullable,
  expiry_date: dbDateNullable,
  page_count: dbIntNullable,
  current_version: dbInt,
  requires_acknowledgement: z.boolean(),
  acknowledgement_due_on: dbDateNullable,
  is_confidential: z.boolean(),
  tags: z.array(z.string()),
  uploaded_at: dbTimestamp,
  archived_at: dbTimestampNullable,
});
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

const POLICY_DOCUMENT_COLUMNS =
  "id, title, document_type_id, subject_kind, employee_id, status, issue_date, expiry_date, " +
  "page_count, current_version, requires_acknowledgement, acknowledgement_due_on, " +
  "is_confidential, tags, uploaded_at, archived_at";

export interface PolicyFilters {
  /** 'policy' | 'company' | … from `ck_documents__subject_kind`. */
  readonly subjectKind?: string;
  readonly documentTypeId?: string;
  readonly ackRequiredOnly?: boolean;
  readonly titleLike?: string;
}

function policyFilters(f: PolicyFilters): readonly Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.subjectKind !== undefined && f.subjectKind !== "") {
    filters.push(eq("subject_kind", f.subjectKind));
  }
  if (f.documentTypeId !== undefined && f.documentTypeId !== "") {
    filters.push(eq("document_type_id", f.documentTypeId));
  }
  if (f.ackRequiredOnly === true) filters.push(isTrue("requires_acknowledgement"));
  const term = (f.titleLike ?? "").trim();
  if (term !== "") filters.push(ilike("title", `%${term}%`));
  return filters;
}

export function fetchPolicyDocuments(
  f: PolicyFilters,
  signal?: AbortSignal,
): Promise<PolicyDocument[]> {
  return selectMany(DOCUMENTS_TABLE, policyDocumentSchema, {
    columns: POLICY_DOCUMENT_COLUMNS,
    filters: policyFilters(f),
    order: [{ column: "uploaded_at", ascending: false }],
    limit: POLICY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countPolicyDocuments(f: PolicyFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENTS_TABLE, policyFilters(f), { ...(signal ? { signal } : {}) });
}

export const ackDocumentTypeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  requires_acknowledgement: z.boolean(),
  acknowledgement_deadline_days: dbIntNullable,
  requires_esign: z.boolean(),
  is_active: z.boolean(),
});
export type AckDocumentType = z.infer<typeof ackDocumentTypeSchema>;

/**
 * The document TYPES that demand an acknowledgement. Live: POLICY and SOP, both
 * with a 7-day deadline — that is the rulebook the register is measured against,
 * and it is real even while `documents` is empty.
 */
export function fetchAckDocumentTypes(signal?: AbortSignal): Promise<AckDocumentType[]> {
  return selectMany(DOCUMENT_TYPES_TABLE, ackDocumentTypeSchema, {
    columns:
      "id, code, name, category, requires_acknowledgement, acknowledgement_deadline_days, " +
      "requires_esign, is_active",
    filters: [isNull("deleted_at"), isTrue("requires_acknowledgement")],
    order: [{ column: "code", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 7. `communication-send` — the broadcast console's one edge function (§4 #13)
// -----------------------------------------------------------------------------

/**
 * The audience selectors the function's `Audience` zod schema accepts. They are
 * OR-ed with each other and intersected with `include_statuses`; `all` short-
 * circuits the employee selectors.
 */
export interface SendAudience {
  readonly all?: boolean;
  readonly department_ids?: readonly string[];
  readonly location_ids?: readonly string[];
  readonly employment_types?: readonly string[];
  readonly emails?: readonly string[];
}

/**
 * The function's `mode` enum, minus `send_pending` — resuming a half-delivered
 * send is a server-side recovery path (its own cron), not a console action.
 */
export type BroadcastMode = "transactional" | "broadcast" | "policy";

export interface SendRequest {
  readonly mode: BroadcastMode;
  readonly communicationKind: string;
  readonly audience: SendAudience;
  readonly subject?: string;
  readonly bodyText?: string;
  readonly templateCode?: string;
  readonly documentId?: string;
  readonly dryRun: boolean;
  readonly maxRecipients?: number;
}

/** The `dry_run: true` reply — a server-resolved audience, not a client guess. */
export const dryRunResultSchema = z.object({
  dry_run: z.literal(true),
  mode: z.string(),
  subject: z.string(),
  recipients: z.object({
    total: dbInt,
    without_email: dbInt,
    truncated: z.boolean(),
  }),
  /** Ten names, per spec-admin §14's "live count + 10 names". */
  preview: z.array(z.object({ name: z.string(), email: z.string().nullable() })),
});
export type DryRunResult = z.infer<typeof dryRunResultSchema>;

/** The committed reply (200) and the staged reply (202) share this shape. */
export const sendResultSchema = z.object({
  communication_id: dbUuid,
  communication_number: z.string(),
  status: z.string(),
  mode: z.string().optional(),
  scheduled_at: z.string().optional(),
  audience_truncated: z.boolean().optional(),
  recipients: z.object({
    total: dbInt,
    sent: dbInt.optional(),
    failed: dbInt.optional(),
    deferred: dbInt.optional(),
    suppressed: dbInt.optional(),
    queued: dbInt.optional(),
  }),
});
export type SendResult = z.infer<typeof sendResultSchema>;

function sendBody(req: SendRequest): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  if (req.subject !== undefined && req.subject !== "") message.subject = req.subject;
  if (req.bodyText !== undefined && req.bodyText !== "") message.body_text = req.bodyText;
  if (req.templateCode !== undefined && req.templateCode !== "") {
    message.template_code = req.templateCode;
  }
  const audience: Record<string, unknown> = {};
  if (req.audience.all === true) audience.all = true;
  if (req.audience.department_ids && req.audience.department_ids.length > 0) {
    audience.department_ids = [...req.audience.department_ids];
  }
  if (req.audience.location_ids && req.audience.location_ids.length > 0) {
    audience.location_ids = [...req.audience.location_ids];
  }
  if (req.audience.employment_types && req.audience.employment_types.length > 0) {
    audience.employment_types = [...req.audience.employment_types];
  }
  if (req.audience.emails && req.audience.emails.length > 0) {
    audience.emails = [...req.audience.emails];
  }
  return {
    mode: req.mode,
    communication_kind: req.communicationKind,
    audience,
    message,
    dry_run: req.dryRun,
    ...(req.documentId !== undefined && req.documentId !== ""
      ? { document_id: req.documentId }
      : {}),
    ...(req.maxRecipients !== undefined ? { max_recipients: req.maxRecipients } : {}),
  };
}

/**
 * Resolve the audience server-side WITHOUT touching the transport.
 *
 * This is the half of the console that works today: the function reads its
 * Resend key only when `dry_run` is false (`const apiKey = apiKeyNeeded ? …`),
 * so a preview returns the real count, the real "no email address on file"
 * count, and ten real names even though `RESEND_API_KEY` is unset on this
 * project.
 */
export function previewBroadcast(
  req: Omit<SendRequest, "dryRun">,
  opts: { readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {},
): Promise<DryRunResult> {
  return invokeEdgeFn(COMMUNICATION_SEND_FN, sendBody({ ...req, dryRun: true }), dryRunResultSchema, {
    ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/**
 * Commit the send.
 *
 * On this project this call is EXPECTED to fail with 503 /
 * `EMAIL_TRANSPORT_UNCONFIGURED`: the function secret `RESEND_API_KEY` is unset
 * and there is no SMTP failover in the secret inventory. That is a
 * provisioning gap, not a bug, and the screen says exactly that instead of
 * pretending the mail went out.
 */
export function sendBroadcast(
  req: Omit<SendRequest, "dryRun">,
  opts: { readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {},
): Promise<SendResult> {
  return invokeEdgeFn(COMMUNICATION_SEND_FN, sendBody({ ...req, dryRun: false }), sendResultSchema, {
    ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** The machine code the function raises when no email transport is provisioned. */
export const EMAIL_TRANSPORT_UNCONFIGURED = "EMAIL_TRANSPORT_UNCONFIGURED";

// -----------------------------------------------------------------------------
// 8. Help Desk — the flag, because the table does not exist
// -----------------------------------------------------------------------------

export type { FeatureFlag };

/**
 * The `help_desk` feature flag. Read live so the screen quotes the project's own
 * register rather than a hard-coded sentence: seeded disabled with an expiry of
 * 2027-04-01, which is when the ticketing module is planned.
 */
export function fetchHelpdeskFlag(signal?: AbortSignal): Promise<FeatureFlag[]> {
  return selectMany(FEATURE_FLAGS_TABLE, featureFlagSchema, {
    filters: [eq("key", HELPDESK_FLAG_KEY), isNull("deleted_at")],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
}
