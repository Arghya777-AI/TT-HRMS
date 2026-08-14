/**
 * clearance.api.ts — the leaver's no-dues checklist.
 *
 * /admin/people/exits has said for its whole life that "no table holds clearance
 * line items". Migration 043700 built two: a template, and a per-leaver SNAPSHOT
 * of it. This is the client half.
 *
 * ── THE SNAPSHOT IS THE POINT, AND IT SHAPES THIS MODULE ────────────────────
 *
 * `employee_clearance` carries its own `label`, `owner_hint` and `is_mandatory`,
 * copied when the checklist was opened. So nothing here joins back to
 * `clearance_items` to render a line — a template renamed in November must not
 * restate what somebody signed off in June. `clearance_item_id` is read only for
 * tracing, and is nullable precisely because the template row may be gone.
 *
 * ── NO MONEY ────────────────────────────────────────────────────────────────
 *
 * There is no amount on a clearance line and none is computed here. Notice
 * shortfall and full-and-final are payroll arithmetic on a salary figure, and
 * `employees.full_and_final_settled_on` is where payroll records the answer.
 */
import { z } from "zod";
import {
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  isNull,
  isTrue,
  rpcAudited,
  selectMany,
} from "@/shared/api/query";

export const CLEARANCE_ITEMS_TABLE = "clearance_items";
export const EMPLOYEE_CLEARANCE_TABLE = "employee_clearance";
export const CLEARANCE_PROGRESS_VIEW = "v_exit_clearance_progress";
export const OPEN_CLEARANCE_FN = "open_exit_clearance";
export const SET_CLEARANCE_FN = "set_clearance_status";

/** `ck_empclr__status`, restated. */
export const clearanceStatusValues = ["pending", "cleared", "waived", "blocked"] as const;
export type ClearanceStatus = (typeof clearanceStatusValues)[number];

/** Both statuses that need a sentence — `ck_empclr__note` and the RPC agree. */
export const CLEARANCE_REASON_STATUSES: readonly ClearanceStatus[] = ["waived", "blocked"];
export const CLEARANCE_REASON_MIN_LENGTH = 10;

export const clearanceItemSchema = z.object({
  id: dbUuid,
  code: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  owner_hint: z.string().nullable(),
  is_mandatory: z.boolean(),
  sort_order: dbInt,
  is_active: z.boolean(),
});
export type ClearanceItem = z.infer<typeof clearanceItemSchema>;

export const employeeClearanceSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  clearance_item_id: dbUuidNullable,
  label: z.string(),
  owner_hint: z.string().nullable(),
  is_mandatory: z.boolean(),
  sort_order: dbInt,
  status: z.string(),
  note: z.string().nullable(),
  cleared_by: dbUuidNullable,
  cleared_at: dbTimestampNullable,
  created_at: dbTimestamp,
});
export type EmployeeClearance = z.infer<typeof employeeClearanceSchema>;

export const clearanceProgressSchema = z.object({
  employee_id: dbUuid,
  total_items: dbInt,
  settled_items: dbInt,
  blocked_items: dbInt,
  mandatory_outstanding: dbInt,
  /* Every MANDATORY line settled. An optional line left pending does not hold up
     a settlement — computed in the view, never re-derived here. */
  is_clear: z.boolean(),
});
export type ClearanceProgress = z.infer<typeof clearanceProgressSchema>;

const LINE_COLUMNS =
  "id, employee_id, clearance_item_id, label, owner_hint, is_mandatory, sort_order, " +
  "status, note, cleared_by, cleared_at, created_at";

/** The template, for the settings screen and for saying what an exit will ask. */
export function fetchClearanceItems(signal?: AbortSignal): Promise<ClearanceItem[]> {
  return selectMany(CLEARANCE_ITEMS_TABLE, clearanceItemSchema, {
    filters: [isNull("deleted_at"), isTrue("is_active")],
    order: [{ column: "sort_order", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/** One leaver's lines, in the order the template put them. */
export function fetchEmployeeClearance(
  employeeId: string,
  signal?: AbortSignal,
): Promise<EmployeeClearance[]> {
  return selectMany(EMPLOYEE_CLEARANCE_TABLE, employeeClearanceSchema, {
    columns: LINE_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "sort_order", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/** Progress for one leaver, counted by Postgres. */
export async function fetchClearanceProgress(
  employeeId: string,
  signal?: AbortSignal,
): Promise<ClearanceProgress | null> {
  const rows = await selectMany(CLEARANCE_PROGRESS_VIEW, clearanceProgressSchema, {
    filters: [eq("employee_id", employeeId)],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  /* No row means no checklist has been opened — which is different from an empty
     one, and the screen says so rather than drawing 0 of 0. */
  return rows[0] ?? null;
}

/** Copy the template onto a leaver. Returns how many lines were added. */
export async function openExitClearance(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<number> {
  const rows = await rpcAudited(
    OPEN_CLEARANCE_FN,
    { p_employee_id: employeeId },
    dbInt,
    { reason, ...(signal ? { signal } : {}) },
  );
  return rows[0] ?? 0;
}

export async function setClearanceStatus(
  clearanceId: string,
  status: ClearanceStatus,
  note: string | null,
  reason: string,
  signal?: AbortSignal,
): Promise<EmployeeClearance> {
  const rows = await rpcAudited(
    SET_CLEARANCE_FN,
    {
      p_clearance_id: clearanceId,
      p_status: status,
      p_note: note === null || note.trim() === "" ? null : note.trim(),
    },
    employeeClearanceSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
  const row = rows[0];
  if (row === undefined) throw new Error("The clearance line was not returned after saving.");
  return row;
}

/**
 * Does this status need a sentence before it will be accepted?
 *
 * The same rule as `ck_empclr__note` and the RPC's own guard, restated so the
 * refusal arrives before the round trip rather than as a constraint name.
 */
export function needsReason(status: ClearanceStatus, note: string): boolean {
  return (
    CLEARANCE_REASON_STATUSES.includes(status) &&
    note.trim().length < CLEARANCE_REASON_MIN_LENGTH
  );
}
