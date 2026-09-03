/**
 * regularizations-admin.api.ts — the admin/decision side of the correction
 * queue behind /admin/attendance/regularisations.
 *
 * The EMPLOYEE side (schemas, kind vocabulary, the quota/window policy read)
 * lives in `features/attendance/api/regularizations.api.ts` and is imported,
 * not duplicated — one schema, or the two surfaces drift.
 *
 * What is admin-specific here:
 *  * the org-wide queue read (`attendance_regularizations__admin_all` RLS row
 *    scope; managers get their team through the manager_read policy — the SAME
 *    query serves both, RLS decides the rows);
 *  * the decision, `public.decide_regularization` (migration 056): a definer
 *    that re-asserts authorisation, creates the `system_regularization` punches
 *    on approval, stamps `created_punch_ids`/`applied_at`, and recomputes the
 *    day SYNCHRONOUSLY — the caller gets the corrected day back in the same
 *    round trip. Rejection demands a comment the requester will read.
 *  * the day-as-it-stands read, so the screen can show "what the day looks
 *    like now" beside "what they claim" without computing anything.
 */
import { z } from "zod";
import {
  dbDate,
  dbInt,
  dbTimestampNullable,
  dbUuid,
  gte,
  inList,
  lte,
  rpcAudited,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import {
  regularizationKindSchema,
  regularizationSchema,
  regularizationStatusSchema,
  type Regularization,
  type RegularizationKind,
  type RegularizationStatus,
} from "@/features/attendance/api/regularizations.api";

export type { Regularization, RegularizationKind, RegularizationStatus };
export { regularizationKindSchema, regularizationSchema, regularizationStatusSchema };

export const REGULARIZATIONS_TABLE = "attendance_regularizations";
export const DECIDE_FN = "decide_regularization";
export const V_DAY_ENRICHED = "v_attendance_day_enriched";

const ADMIN_REG_COLUMNS =
  "id, employee_id, ist_date, attendance_day_id, regularization_kind, " +
  "requested_first_in_at, requested_last_out_at, requested_status, employee_reason, " +
  "supporting_document_id, status, approval_request_id, decided_at, decision_comment, " +
  "applied_at, month_quota_counter, created_at";

export const QUEUE_ROW_CAP = 300;

export interface RegularizationQueueFilters {
  /** Default is the decidable state; history slices are explicit. */
  readonly statuses?: readonly RegularizationStatus[];
  readonly kinds?: readonly RegularizationKind[];
  readonly employeeIds?: readonly string[];
  readonly from?: string;
  readonly to?: string;
}

/** One predicate builder feeds both the rows and the count (DR-29). */
function queueFilters(f: RegularizationQueueFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.kinds && f.kinds.length > 0) filters.push(inList("regularization_kind", f.kinds));
  if (f.employeeIds && f.employeeIds.length > 0)
    filters.push(inList("employee_id", f.employeeIds));
  if (f.from !== undefined) filters.push(gte("ist_date", f.from));
  if (f.to !== undefined) filters.push(lte("ist_date", f.to));
  return filters;
}

export function fetchRegularizationQueue(
  f: RegularizationQueueFilters,
  signal?: AbortSignal,
): Promise<Regularization[]> {
  return selectMany(REGULARIZATIONS_TABLE, regularizationSchema, {
    columns: ADMIN_REG_COLUMNS,
    filters: queueFilters(f),
    // Oldest pending first: the queue is a debt, and the debt ages.
    order: [{ column: "created_at", ascending: true }],
    limit: QUEUE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/**
 * One regularisation by id — for the Approval Inbox, which knows only
 * `approval_requests.detail_id`.
 *
 * WHY THE INBOX NEEDS THIS AT ALL. The generic approval panel showed dates, days, an amount
 * and the trail, and nothing of the request itself: an approver looking at a regularisation
 * saw no requested times, no kind, and not the reason the employee typed. HR said so
 * plainly — "I'm not able to see any details, just given the request and it is showing
 * nothing. I just approved it." Approving a correction to somebody's attendance without
 * seeing the correction is not an approval.
 *
 * A list rather than a single id so the panel can be opened on several rows without a
 * request each; `inList` is the form the rest of this file uses.
 */
export function fetchRegularizationsByIds(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Regularization[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return selectMany(REGULARIZATIONS_TABLE, regularizationSchema, {
    columns: ADMIN_REG_COLUMNS,
    filters: [inList("id", ids)],
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
}

export function countRegularizationQueue(
  f: RegularizationQueueFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(REGULARIZATIONS_TABLE, queueFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The day as the engine currently has it, for the requests on screen — so the
 * queue can print "now: 09:12 → (no out scan), half day" beside the claim.
 * Keyed per (employee, date) by the caller; every figure is a view column.
 */
export const dayNowSchema = z.object({
  employee_id: dbUuid,
  ist_date: dbDate,
  status: z.string().nullable(),
  first_in_hm: z.string().nullable(),
  last_out_hm: z.string().nullable(),
  worked_hm: z.string().nullable(),
  punch_count: dbInt.nullable(),
  is_locked: z.boolean().nullable(),
});
export type DayNow = z.infer<typeof dayNowSchema>;

export function fetchDaysNow(
  pairs: readonly { employeeId: string; istDate: string }[],
  signal?: AbortSignal,
): Promise<DayNow[]> {
  if (pairs.length === 0) return Promise.resolve([]);
  const employeeIds = [...new Set(pairs.map((p) => p.employeeId))];
  const dates = [...new Set(pairs.map((p) => p.istDate))];
  // A rectangle over (employees × dates) can over-fetch a few rows; the page
  // indexes by the exact pair, so extras are ignored — one round trip wins.
  return selectMany(V_DAY_ENRICHED, dayNowSchema, {
    columns: "employee_id, ist_date, status, first_in_hm, last_out_hm, worked_hm, punch_count, is_locked",
    filters: [inList("employee_id", employeeIds), inList("ist_date", dates)],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

/** What migration 056 hands back on approval — the corrected day, immediately. */
export const decisionResultSchema = z.object({
  regularization_id: dbUuid,
  decision: z.enum(["applied", "rejected"]),
  punch_ids: z.array(dbUuid),
  day_status_after: z.string().nullable().optional(),
  first_in_after: dbTimestampNullable.optional(),
  last_out_after: dbTimestampNullable.optional(),
  worked_minutes_after: dbInt.nullable().optional(),
});
export type DecisionResult = z.infer<typeof decisionResultSchema>;

export interface DecideInput {
  readonly regularizationId: string;
  readonly decision: "approve" | "reject";
  /** Mandatory on reject (the requester reads it); optional context on approve. */
  readonly comment?: string;
}

export async function decideRegularization(
  input: DecideInput,
  reason: string,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  const rows = await rpcAudited(
    DECIDE_FN,
    {
      p_regularization_id: input.regularizationId,
      p_decision: input.decision,
      ...(input.comment !== undefined && input.comment.trim() !== ""
        ? { p_comment: input.comment.trim() }
        : {}),
    },
    decisionResultSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error("decide_regularization returned no result row");
  }
  return first;
}
