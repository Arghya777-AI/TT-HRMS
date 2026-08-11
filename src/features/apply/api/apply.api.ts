/**
 * apply.api.ts — the E-10 launcher reads, and the ONE definition of "what I have
 * sent that nobody has decided yet".
 *
 * spec-employee §5 E-10 names a view `v_my_open_requests`. It is NOT deployed
 * (no migration defines it), so the same list is read from the table it would
 * have unioned: `approval_requests`, which every request type already routes
 * through (`public.create_approval_request`). Reading the routing table instead
 * of nine detail tables means:
 *   - one status vocabulary (`public.approval_status`), not nine;
 *   - the server-issued `request_number` is the reference, so nothing is minted
 *     in the browser;
 *   - E-10's "My open requests" and E-12's "Tracking" call the SAME function and
 *     cannot disagree.
 *
 * Detail-table rows that never reached the workflow engine (a draft leave
 * request, a regularization inserted directly) are therefore absent here by
 * construction — they are not waiting on anybody yet.
 */
import { z } from "zod";
import {
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  eq,
  inList,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { nowInstantIso, type Instant } from "@/lib/datetime";

export const REQUEST_TYPES_TABLE = "request_types";
export const APPROVAL_REQUESTS_TABLE = "approval_requests";
export const EMPLOYEE_DIRECTORY_VIEW = "v_employee_directory";

/** `public.approval_status` (migration 003). */
export const approvalStatusSchema = z.enum([
  "draft",
  "pending",
  "in_progress",
  "approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "expired",
  "auto_approved",
  "escalated",
  "applied",
  "failed",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Statuses where somebody still owes the employee a decision. */
export const OPEN_APPROVAL_STATUSES = ["pending", "in_progress", "escalated"] as const;

// -----------------------------------------------------------------------------
// 1. The launcher tiles
// -----------------------------------------------------------------------------

export const requestTypeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: z.number().int(),
  detail_table: z.string(),
  /** Hours the approver has, from `request_types.sla_hours`. Never guessed. */
  sla_hours: z.number().int(),
  escalation_hours: z.number().int().nullable(),
  allows_withdrawal: z.boolean(),
  requires_attachment: z.boolean(),
  icon: z.string().nullable(),
});

export type RequestType = z.infer<typeof requestTypeSchema>;

const REQUEST_TYPE_COLUMNS =
  "id, code, name, description, sort_order, detail_table, sla_hours, escalation_hours, " +
  "allows_withdrawal, requires_attachment, icon";

/**
 * Every request type switched on for this company, in the order HR configured.
 * RLS (`request_types__all_read`) already limits this to active, undeleted rows.
 */
export async function fetchRequestTypes(signal?: AbortSignal): Promise<RequestType[]> {
  return selectMany(REQUEST_TYPES_TABLE, requestTypeSchema, {
    columns: REQUEST_TYPE_COLUMNS,
    filters: [eq("is_active", true)],
    order: [{ column: "sort_order", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. My open requests
// -----------------------------------------------------------------------------

export const openRequestSchema = z.object({
  id: dbUuid,
  /** Server-issued, e.g. `LR-2026-0142`. The reference we quote (DR-53). */
  request_number: z.string(),
  request_type_id: dbUuid,
  detail_table: z.string(),
  detail_id: dbUuid,
  subject_employee_id: dbUuid,
  title: z.string(),
  /** Server-rendered summary object; rendered as text only when it is a string. */
  summary: z.unknown(),
  /** numeric(14,2) RUPEES on this table — not paise. */
  amount: dbNumericNullable,
  days: dbNumericNullable,
  status: approvalStatusSchema,
  current_level: z.number().int(),
  total_levels: z.number().int(),
  current_approver_ids: z.array(dbUuid),
  submitted_at: dbTimestamp,
  sla_due_at: dbTimestamp,
  decided_at: dbTimestampNullable,
  priority: z.enum(["low", "normal", "high", "urgent"]),
  request_types: z
    .object({ code: z.string(), name: z.string(), icon: z.string().nullable() })
    .nullable(),
});

export type OpenRequest = z.infer<typeof openRequestSchema>;

const OPEN_REQUEST_COLUMNS =
  "id, request_number, request_type_id, detail_table, detail_id, subject_employee_id, title, " +
  "summary, amount, days, status, current_level, total_levels, current_approver_ids, " +
  "submitted_at, sla_due_at, decided_at, priority, request_types(code, name, icon)";

export const directoryEntrySchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  designation_name: z.string().nullable(),
});

export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export interface MyOpenRequests {
  readonly rows: OpenRequest[];
  /** employee id → display name, for the "With" column. */
  readonly approvers: Readonly<Record<string, DirectoryEntry>>;
}

/**
 * Everything the employee has in flight, newest first, with the current
 * approvers resolved to names.
 *
 * Names come from `v_employee_directory` (code + name + designation and nothing
 * else — the directory allowlist), so rendering "With Priya Rao" never leaks a
 * column the employee may not see. When the lookup returns nothing the UI says
 * "your manager" rather than printing a uuid.
 */
export async function fetchMyOpenRequests(
  employeeId: string,
  signal?: AbortSignal,
): Promise<MyOpenRequests> {
  const rows = await selectMany(APPROVAL_REQUESTS_TABLE, openRequestSchema, {
    columns: OPEN_REQUEST_COLUMNS,
    filters: [
      eq("subject_employee_id", employeeId),
      inList("status", OPEN_APPROVAL_STATUSES),
    ],
    order: [{ column: "submitted_at", ascending: false }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });

  const ids = [...new Set(rows.flatMap((r) => r.current_approver_ids))];
  if (ids.length === 0) return { rows, approvers: {} };

  const people = await selectMany(EMPLOYEE_DIRECTORY_VIEW, directoryEntrySchema, {
    columns: "id, employee_code, display_name, designation_name",
    filters: [inList("id", ids)],
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });

  const approvers: Record<string, DirectoryEntry> = {};
  for (const person of people) approvers[person.id] = person;
  return { rows, approvers };
}

/*
  ── THE EMPLOYEE'S OWN REGISTER ─────────────────────────────────────────────

  `fetchMyOpenRequests` above answers "what is in flight". It cannot answer the
  questions actually asked — "which were approved or rejected", "who has mine
  now", "what happened to the one from last month" — because it filters to the
  three open statuses and a settled request simply vanishes from the screen the
  moment it is decided.

  Same reader, same schema, same approver-name resolution; the slice is the only
  difference. Sharing the reader is the point: a register that computed its own
  status or level would be a second opinion about a row the server already
  describes completely.
*/

/** The slices an employee can ask for. `all` is the register; the rest filter it. */
export const requestSliceValues = ["open", "approved", "rejected", "all"] as const;
export type RequestSlice = (typeof requestSliceValues)[number];

export function isRequestSlice(value: string | null): value is RequestSlice {
  return value !== null && (requestSliceValues as readonly string[]).includes(value);
}

/**
 * `approved` deliberately covers `auto_approved` and `applied` as well.
 *
 * All three mean "you got it" to the person who asked: `auto_approved` is the
 * SLA engine deciding on nobody's behalf, and `applied` is a decision that has
 * also been written onto the detail row. Showing them as three different words
 * on an employee's screen would invite three different questions with the same
 * answer.
 *
 * `cancelled` and `withdrawn` are the employee's own doing and appear only under
 * `all` — a register of what happened, not a list of things to worry about.
 */
const SLICE_STATUSES: Readonly<Record<Exclude<RequestSlice, "all">, readonly string[]>> = {
  open: ["pending", "in_progress", "escalated"],
  approved: ["approved", "auto_approved", "applied"],
  rejected: ["rejected", "expired", "failed"],
};

/**
 * ONE predicate builder, so a tile count and the grid below it cannot disagree.
 *
 * The type filter is applied HERE rather than by filtering rows in the browser,
 * which is what makes the tiles mean what they say: with "Leave" selected, the
 * Approved tile counts approved LEAVE, not approved everything. A client-side
 * filter would have left five tiles describing a different set from the grid
 * under them.
 */
export function myRequestFilters(
  employeeId: string,
  slice: RequestSlice,
  requestTypeId?: string,
): readonly Filter[] {
  const out: Filter[] = [eq("subject_employee_id", employeeId)];
  if (slice !== "all") out.push(inList("status", SLICE_STATUSES[slice]));
  if (requestTypeId !== undefined && requestTypeId !== "") {
    out.push(eq("request_type_id", requestTypeId));
  }
  return out;
}

/** One slice of the employee's register, with the current approvers named. */
export async function fetchMyRequests(
  employeeId: string,
  slice: RequestSlice,
  requestTypeId?: string,
  signal?: AbortSignal,
): Promise<MyOpenRequests> {
  const rows = await selectMany(APPROVAL_REQUESTS_TABLE, openRequestSchema, {
    columns: OPEN_REQUEST_COLUMNS,
    filters: myRequestFilters(employeeId, slice, requestTypeId),
    order: [{ column: "submitted_at", ascending: false }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });

  const ids = [...new Set(rows.flatMap((r) => r.current_approver_ids))];
  if (ids.length === 0) return { rows, approvers: {} };

  const people = await selectMany(EMPLOYEE_DIRECTORY_VIEW, directoryEntrySchema, {
    columns: "id, employee_code, display_name, designation_name",
    filters: [inList("id", ids)],
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
  const approvers: Record<string, DirectoryEntry> = {};
  for (const person of people) approvers[person.id] = person;
  return { rows, approvers };
}

/** `count=exact` from Postgres for one slice — never `rows.length`. */
export function countMyRequests(
  employeeId: string,
  slice: RequestSlice,
  requestTypeId?: string,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    APPROVAL_REQUESTS_TABLE,
    myRequestFilters(employeeId, slice, requestTypeId),
    signal ? { signal } : {},
  );
}

/**
 * The subset of an approval summary we are willing to render: a plain string
 * under a known key. `summary` is `jsonb` written by whichever detail table
 * raised the request, so anything else is shown as the request title instead of
 * being stringified into `[object Object]`.
 */
export function summaryText(summary: unknown): string | null {
  if (typeof summary === "string") return summary.length > 0 ? summary : null;
  if (summary === null || typeof summary !== "object") return null;
  const record = summary as Record<string, unknown>;
  for (const key of ["summary", "text", "description", "reason", "label"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Placeholder used in query keys when identity has not resolved yet. */
export const NO_EMPLOYEE = "no-employee";

/** `current_approver_ids` → names, in the order the server listed them. */
export function approverNames(
  row: OpenRequest,
  approvers: Readonly<Record<string, DirectoryEntry>>,
): string[] {
  const names: string[] = [];
  for (const id of row.current_approver_ids) {
    const person = approvers[id];
    if (person) names.push(person.display_name);
  }
  return names;
}

/**
 * True when the server's own SLA deadline has passed. A timestamp comparison,
 * not a derived metric — `sla_due_at` is computed and stored by
 * `create_approval_request`, and nothing here recalculates it.
 */
export function isPastSla(row: OpenRequest, now: Instant = nowInstantIso()): boolean {
  return new Date(row.sla_due_at).getTime() < new Date(now).getTime();
}
