/**
 * helpdesk-desk.api.ts — the desk's side of the E-14 ticket queue.
 *
 * `/admin/comms/helpdesk` was a gap screen: it probed `helpdesk_tickets` live,
 * got PGRST205, and said so rather than rendering an empty queue that would read
 * as "nobody has asked for anything". Migration 041500 created the table, so
 * this is the read and the write that screen was waiting for.
 *
 * ── EVERY STATE CHANGE GOES THROUGH ONE RPC ──────────────────────────────────
 *
 * `helpdesk_desk_action` and nothing else. Not squeamishness about UPDATE: the
 * status and its timestamp move together (`ck_hdt__resolved_status`,
 * `ck_hdt__closed_status`), so a browser that sets `status = 'resolved'` must
 * also send `resolved_at` — and that is the number every SLA report is judged
 * on. It is the server's clock or it is nobody's.
 *
 * ── WHAT IS COUNTED, AND BY WHOM ─────────────────────────────────────────────
 *
 * The tiles read `count=exact` from Postgres through `selectCount`, with the
 * SAME predicate builder the list uses. A tile computed from `rows.length` shows
 * the page size, not the queue — that is the `7 vs 8` defect this codebase names
 * explicitly.
 */
import { z } from "zod";
import {
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  eq,
  inList,
  isNull,
  rpcOne,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import {
  HELPDESK_MESSAGES_TABLE,
  HELPDESK_TICKETS_TABLE,
  helpdeskMessageSchema,
  helpdeskTicketSchema,
  type HelpdeskDesk,
  type HelpdeskMessage,
  type HelpdeskTicket,
} from "@/features/helpdesk/api/helpdesk.api";

export { HELPDESK_TICKETS_TABLE };

/** The one RPC. See the header for why there is only one. */
export const HELPDESK_DESK_ACTION_FN = "helpdesk_desk_action";

/** What a desk member may do. Mirrors the RPC's own branch list exactly. */
export const deskActionValues = [
  "claim",
  "start",
  "wait",
  "resolve",
  "close",
  "reopen",
] as const;
export type DeskAction = (typeof deskActionValues)[number];

/**
 * The queue slices.
 *
 * `unassigned` is not a status — it is the state that produces a ticket nobody
 * is working, which is the single most useful thing for a desk to see and the
 * one no status column records.
 */
export const deskSliceValues = ["live", "unassigned", "mine", "resolved", "all"] as const;
export type DeskSlice = (typeof deskSliceValues)[number];

export function isDeskSlice(value: string | null): value is DeskSlice {
  return value !== null && (deskSliceValues as readonly string[]).includes(value);
}

const LIVE_STATUSES = ["open", "in_progress", "waiting_on_requester"];

/** Row cap. Every list here grows forever; an unbounded read is a defect. */
export const DESK_ROW_CAP = 200;

/**
 * ONE predicate builder, used by both the count and the list.
 *
 * `myProfileId` is passed in rather than read from a session here, so the
 * "assigned to me" slice is a pure function of its inputs and the count and the
 * grid cannot end up asking about two different people.
 */
export function deskFilters(
  slice: DeskSlice,
  desk: HelpdeskDesk | null,
  myProfileId: string | null,
): readonly Filter[] {
  const base: Filter[] = [];
  if (desk !== null) base.push(eq("desk", desk));

  if (slice === "live") return [...base, inList("status", LIVE_STATUSES)];
  if (slice === "unassigned") {
    return [...base, inList("status", LIVE_STATUSES), isNull("assigned_to")];
  }
  if (slice === "mine") {
    /*
      No profile id means no session, which must mean NO ROWS — not "every row",
      which is what dropping the filter would silently produce. The impossible
      uuid is how the rest of this codebase spells an empty id set.
    */
    return [
      ...base,
      eq("assigned_to", myProfileId ?? "00000000-0000-0000-0000-000000000000"),
      inList("status", LIVE_STATUSES),
    ];
  }
  if (slice === "resolved") return [...base, inList("status", ["resolved", "closed"])];
  return base;
}

const TICKET_COLUMNS =
  "id, ticket_number, employee_id, desk, subject, description, priority, status, assigned_to, " +
  "first_response_due_at, resolution_due_at, first_responded_at, resolved_at, " +
  "resolution_note, closed_at, reopened_count, created_at";

/** The desk's view of a ticket carries the requester id; the employee's does not. */
export const deskTicketSchema = helpdeskTicketSchema.extend({
  employee_id: dbUuid,
});
export type DeskTicket = z.infer<typeof deskTicketSchema>;

export function fetchDeskTickets(
  slice: DeskSlice,
  desk: HelpdeskDesk | null,
  myProfileId: string | null,
  signal?: AbortSignal,
): Promise<DeskTicket[]> {
  return selectMany(HELPDESK_TICKETS_TABLE, deskTicketSchema, {
    columns: TICKET_COLUMNS,
    filters: deskFilters(slice, desk, myProfileId),
    // Oldest first: the ticket most likely to have breached is at the top.
    order: [{ column: "created_at", ascending: true }],
    limit: DESK_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countDeskTickets(
  slice: DeskSlice,
  desk: HelpdeskDesk | null,
  myProfileId: string | null,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    HELPDESK_TICKETS_TABLE,
    deskFilters(slice, desk, myProfileId),
    signal ? { signal } : {},
  );
}

/**
 * The whole conversation, internal notes included.
 *
 * Same call the employee makes — `hdm__participant__select` is what decides
 * whether the internal ones come back, and it decides differently for an admin.
 * A separate "admin" query would be a second rule that could disagree with the
 * first.
 */
export function fetchDeskMessages(
  ticketId: string,
  signal?: AbortSignal,
): Promise<HelpdeskMessage[]> {
  return selectMany(HELPDESK_MESSAGES_TABLE, helpdeskMessageSchema, {
    columns: "id, ticket_id, author_profile_id, body, is_internal, created_at",
    filters: [eq("ticket_id", ticketId)],
    order: [{ column: "created_at", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Reply, or leave a note the requester will never see. */
export function postDeskMessage(
  ticketId: string,
  body: string,
  isInternal: boolean,
  signal?: AbortSignal,
): Promise<HelpdeskMessage> {
  return insertOne(
    HELPDESK_MESSAGES_TABLE,
    helpdeskMessageSchema,
    { ticket_id: ticketId, body: body.trim(), is_internal: isInternal },
    {
      columns: "id, ticket_id, author_profile_id, body, is_internal, created_at",
      ...(signal ? { signal } : {}),
    },
  );
}

/**
 * The RPC returns the whole updated row, so the caller never has to guess what
 * the server did — including the fields it filled in that were not asked for
 * (`resolved_at` on a close, the reopen counter).
 */
const deskActionResultSchema = z.object({
  id: dbUuid,
  ticket_number: z.string(),
  status: z.string(),
  assigned_to: dbUuid.nullable(),
  resolved_at: dbTimestampNullable,
  closed_at: dbTimestampNullable,
  reopened_count: z.number().int(),
  updated_at: dbTimestamp,
});
export type DeskActionResult = z.infer<typeof deskActionResultSchema>;

export async function runDeskAction(
  ticketId: string,
  action: DeskAction,
  note: string | null,
  signal?: AbortSignal,
): Promise<DeskActionResult> {
  const row = await rpcOne(
    HELPDESK_DESK_ACTION_FN,
    { p_ticket_id: ticketId, p_action: action, p_note: note },
    deskActionResultSchema,
    signal ? { signal } : {},
  );
  if (row === null) {
    throw new Error("The ticket was not found, or it is outside your admin scope.");
  }
  return row;
}

/** Re-exported so the page imports one module rather than two. */
export type { HelpdeskDesk, HelpdeskMessage, HelpdeskTicket };
