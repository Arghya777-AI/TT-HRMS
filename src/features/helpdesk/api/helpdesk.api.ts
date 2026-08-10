/**
 * helpdesk.api.ts — the E-14 ticket queue.
 *
 * `helpdesk_tickets` and `helpdesk_messages` landed in migration 041500. Until
 * then this feature had no table at all and `/me/helpdesk` said so; that page's
 * header records the whole history.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not compute a status, a due time, an author, or a first-response
 * stamp. Every one of those is server-owned:
 *
 *   · `trg_hdt__number` mints the ticket number,
 *   · `trg_hdt__sla` stamps both due-times from `settings`,
 *   · `trg_hdm__author` stamps the message author from the session,
 *   · `trg_hdm__first_response` stops the first clock when the desk replies.
 *
 * So the inserts below are deliberately thin: subject, description, desk,
 * priority. Anything else sent from here would either be overwritten or
 * rejected, and a field the browser sends that the server ignores is a field
 * somebody will later believe.
 *
 * ── BREACH IS DERIVED, NOT STORED ────────────────────────────────────────────
 *
 * `isBreached` below compares a due-time against the clock. There is no
 * `is_breached` column, on purpose: a stored boolean would be true only until
 * someone changed the deadline, and then it would be a fact about the past
 * pretending to be a fact about now.
 */
import { z } from "zod";
import {
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  eq,
  selectMany,
} from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";

export const HELPDESK_TICKETS_TABLE = "helpdesk_tickets";
export const HELPDESK_MESSAGES_TABLE = "helpdesk_messages";

/** `ck_hdt__desk` — the four desks spec-employee §5 E-14 names. */
export const helpdeskDeskValues = ["hr", "payroll", "stores", "it"] as const;
export type HelpdeskDesk = (typeof helpdeskDeskValues)[number];

/** `ck_hdt__priority`. */
export const helpdeskPriorityValues = ["low", "normal", "high", "urgent"] as const;
export type HelpdeskPriority = (typeof helpdeskPriorityValues)[number];

/** `ck_hdt__status`. */
export const helpdeskStatusValues = [
  "open",
  "in_progress",
  "waiting_on_requester",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type HelpdeskStatus = (typeof helpdeskStatusValues)[number];

/** Statuses in which the requester may still write on the ticket. */
export const HELPDESK_LIVE_STATUSES: readonly HelpdeskStatus[] = [
  "open",
  "in_progress",
  "waiting_on_requester",
  "resolved",
];

export const helpdeskTicketSchema = z.object({
  id: dbUuid,
  ticket_number: z.string(),
  desk: z.string(),
  subject: z.string(),
  description: z.string(),
  priority: z.string(),
  status: z.string(),
  assigned_to: dbUuid.nullable(),
  first_response_due_at: dbTimestampNullable,
  resolution_due_at: dbTimestampNullable,
  first_responded_at: dbTimestampNullable,
  resolved_at: dbTimestampNullable,
  resolution_note: z.string().nullable(),
  closed_at: dbTimestampNullable,
  reopened_count: z.number().int(),
  created_at: dbTimestamp,
});
export type HelpdeskTicket = z.infer<typeof helpdeskTicketSchema>;

export const helpdeskMessageSchema = z.object({
  id: dbUuid,
  ticket_id: dbUuid,
  author_profile_id: dbUuid,
  body: z.string(),
  is_internal: z.boolean(),
  created_at: dbTimestamp,
});
export type HelpdeskMessage = z.infer<typeof helpdeskMessageSchema>;

const TICKET_COLUMNS =
  "id, ticket_number, desk, subject, description, priority, status, assigned_to, " +
  "first_response_due_at, resolution_due_at, first_responded_at, resolved_at, " +
  "resolution_note, closed_at, reopened_count, created_at";

const MESSAGE_COLUMNS = "id, ticket_id, author_profile_id, body, is_internal, created_at";

/** A venue employee raises a handful of tickets a year, not a thousand. */
const TICKET_CAP = 50;
const MESSAGE_CAP = 200;

/** My own tickets, newest first. RLS is the boundary. */
export function fetchMyTickets(
  employeeId: string,
  signal?: AbortSignal,
): Promise<HelpdeskTicket[]> {
  return selectMany(HELPDESK_TICKETS_TABLE, helpdeskTicketSchema, {
    columns: TICKET_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "created_at", ascending: false }],
    limit: TICKET_CAP,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The conversation on one ticket, oldest first.
 *
 * No `is_internal` filter here: `hdm__participant__select` already hides the
 * desk's internal notes from the requester, and re-filtering in the browser
 * would mean two rules that can disagree — with the browser's being the one that
 * cannot be trusted.
 */
export function fetchTicketMessages(
  ticketId: string,
  signal?: AbortSignal,
): Promise<HelpdeskMessage[]> {
  return selectMany(HELPDESK_MESSAGES_TABLE, helpdeskMessageSchema, {
    columns: MESSAGE_COLUMNS,
    filters: [eq("ticket_id", ticketId)],
    order: [{ column: "created_at", ascending: true }],
    limit: MESSAGE_CAP,
    ...(signal ? { signal } : {}),
  });
}

export interface RaiseTicketInput {
  readonly employeeId: string;
  readonly desk: HelpdeskDesk;
  readonly subject: string;
  readonly description: string;
  readonly priority: HelpdeskPriority;
}

/**
 * Raise a ticket.
 *
 * `status: 'open'` is stated rather than left to the column default, because
 * `hdt__self__insert` tests it in its WITH CHECK: relying on a default here
 * would make the policy pass or fail depending on a value the client never sent,
 * which is the kind of coupling that breaks the day the default changes.
 */
export function raiseTicket(
  input: RaiseTicketInput,
  signal?: AbortSignal,
): Promise<HelpdeskTicket> {
  return insertOne(
    HELPDESK_TICKETS_TABLE,
    helpdeskTicketSchema,
    {
      employee_id: input.employeeId,
      desk: input.desk,
      subject: input.subject.trim(),
      description: input.description.trim(),
      priority: input.priority,
      status: "open",
    },
    { columns: TICKET_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Add a reply. `is_internal` is never sent: the policy refuses it from here. */
export function postTicketMessage(
  ticketId: string,
  body: string,
  signal?: AbortSignal,
): Promise<HelpdeskMessage> {
  return insertOne(
    HELPDESK_MESSAGES_TABLE,
    helpdeskMessageSchema,
    { ticket_id: ticketId, body: body.trim() },
    { columns: MESSAGE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/**
 * Cancel or reopen.
 *
 * The two transitions `trg_hdt__guard` allows a requester. Anything else raises
 * 23514 with the server's own wording, which `isRuleRejection` shows verbatim —
 * so this does not pre-judge which are legal beyond naming the two.
 */
export function setMyTicketStatus(
  ticketId: string,
  status: "cancelled" | "open",
  signal?: AbortSignal,
): Promise<HelpdeskTicket> {
  return updateOne(
    HELPDESK_TICKETS_TABLE,
    helpdeskTicketSchema,
    { status },
    { id: ticketId },
    { columns: TICKET_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/**
 * Is a clock overdue?
 *
 * `nowMs` is passed in rather than read here so the caller owns the clock — the
 * repo's rule for anything a test has to pin down.
 */
export function isBreached(dueAt: string | null, metAt: string | null, nowMs: number): boolean {
  if (dueAt === null) return false;
  if (metAt !== null) return Date.parse(metAt) > Date.parse(dueAt);
  return nowMs > Date.parse(dueAt);
}

/** Whether the requester may still add a message. Mirrors hdm__participant__insert. */
export function canReply(status: string): boolean {
  return status !== "closed" && status !== "cancelled";
}
