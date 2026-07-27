/**
 * leave-config.api.ts — the reads behind leave CONFIGURATION and the balance
 * LEDGER (spec-admin §7.1, §7.2, §7.3 rollover + encashment).
 *
 * `leave.api.ts` already owns the four grid screens (types list, balances,
 * requests, comp-off). This module adds only what those screens do not need,
 * and it exists as a separate file for one structural reason: every figure on
 * `/admin/leave/rollover` and `/admin/leave/encashment` is a `count=exact` over
 * a predicate, and a count is only trustworthy when it is built from the SAME
 * filter array as the rows underneath it. So each read here comes in pairs —
 * `…Filters()` builds the predicate, the fetch and the count both consume it
 * (the `7 vs 8` defect, DR-29, cannot then occur).
 *
 * What the deployed backend does and does not allow, verified against migration
 * 019 (`supabase/migrations/20260801001900_leave.sql`) rather than assumed:
 *
 *   * `leave_types` — INSERT/UPDATE granted to `authenticated`, policy
 *     `leave_types__admin_write` (`app.is_admin()`). The table is in
 *     `audit.reason_required_tables` (006 §79-95), so EVERY write carries
 *     `X-Reason`; `leave_types_guard()` refuses to soft-delete a
 *     `is_system_managed` row (LWP / CO / OD) with SQLSTATE 0A000.
 *   * `leave_ledger` — SELECT only for `authenticated`; INSERT is `service_role`,
 *     `leave_ledger_guard_mutation()` refuses client UPDATE/DELETE outright, and
 *     `balance_after` is stamped by `leave_ledger_before_insert()`. The running
 *     balance on the statement is therefore READ, never accumulated here.
 *   * `leave_year_rollovers` — SELECT for `app.is_admin()`, INSERT/UPDATE for
 *     `app.is_super_admin()` only, and NO rollover function is deployed (019
 *     ships `accrue_leave`, `expire_comp_off`, `recompute_leave_balance`,
 *     `consume_comp_off`, `calc_leave_days`, `rebuild_leave_request_days` — no
 *     `rollover_leave_year`). The rollover screen therefore reads history and
 *     exposure and offers no commit button; see `ROLLOVER_ENGINE_MISSING`.
 *
 * Money is deliberately absent from the encashment screen's reads: the payout is
 * `days × (basic + DA) / 26` and belongs to the payroll engine (component 140,
 * spec-admin §8.1). Multiplying it in a browser is the arithmetic this build
 * refuses to do.
 */
import { z } from "zod";
import {
  dbInt,
  dbNumeric,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  lte,
  paginate,
  selectCount,
  selectMany,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import {
  LEAVE_TYPES_TABLE,
  V_BALANCE_CURRENT,
  V_LEAVE_CALENDAR,
  V_LEDGER_STATEMENT,
  leaveCalendarRowSchema,
  leaveTypeSchema,
  ledgerEntryTypeSchema,
  ledgerRowSchema,
  type LeaveCalendarRow,
  type LeaveRequestStatus,
  type LeaveType,
  type LedgerRow,
} from "./leave.api";

// Re-exported deliberately: the hooks and pages of this feature import these two
// row types from THIS module (it is their api surface), not from ./leave.api.
export type { LeaveCalendarRow, LedgerRow };

export const LEAVE_ROLLOVERS_TABLE = "leave_year_rollovers";

// -----------------------------------------------------------------------------
// 0. The rulebook itself (`/admin/leave/types`)
// -----------------------------------------------------------------------------

/**
 * Every leave type an administrator may see, INCLUDING retired ones.
 *
 * `leave.api.fetchLeaveTypes` always filters `deleted_at IS NULL` — correct for
 * a picker, wrong for the master screen, whose "show retired" toggle would
 * otherwise silently show the live list twice. Retirement is a soft delete
 * (D-23) precisely so historical ledger rows keep their type name, so the master
 * has to be able to read the retired rows back.
 */
export function fetchLeaveTypeRulebook(
  opts: { readonly archived?: boolean } = {},
  signal?: AbortSignal,
): Promise<LeaveType[]> {
  return selectMany(LEAVE_TYPES_TABLE, leaveTypeSchema, {
    filters: [opts.archived === true ? isNotNull("deleted_at") : isNull("deleted_at")],
    order: [{ column: "sort_order", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Why `/admin/leave/rollover` has no commit button, in one exported constant so
 * the screen and this module cannot drift apart: 019 grants INSERT on
 * `leave_ledger` to `service_role` only, the append-only guard refuses client
 * mutation, and no rollover function or edge function is deployed.
 */
export const ROLLOVER_ENGINE_MISSING = "public.rollover_leave_year" as const;

/** `public.ledger_entry_type` (003), as a value type for exhaustive maps. */
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

/** The credits and debits a year-end rollover writes (spec-admin §7.3). */
export const ROLLOVER_ENTRY_TYPES: readonly LedgerEntryType[] = [
  "carry_forward_in",
  "carry_forward_out",
  "lapse",
  "encashment",
];

/** Encashment movements: a run's debit, and an exit settlement's (019 §8.2). */
export const ENCASHMENT_ENTRY_TYPES: readonly LedgerEntryType[] = ["encashment", "settlement"];

/** Hard row cap on every org-wide grid in this module. Keyset paging, never OFFSET. */
export const LEAVE_CONFIG_ROW_CAP = 500;

// -----------------------------------------------------------------------------
// 1. Balance ledger (`/admin/leave/ledger/:code`)
// -----------------------------------------------------------------------------

export interface LedgerFilters {
  readonly employeeId: string;
  readonly leaveTypeId?: string | null;
  /** `leave_ledger.leave_year` — the FY start year, per `public.leave_year_of`. */
  readonly leaveYear?: number | null;
  readonly entryTypes?: readonly LedgerEntryType[];
  readonly from?: string;
  readonly to?: string;
}

/**
 * The ONE predicate the statement grid, its total and its entry-kind counts all
 * share. `leave.api.fetchLeaveLedger` cannot be reused here because it has no
 * `entry_type` filter and no matching count — and a filter the count does not
 * apply is how a header says 61 above a grid of 12.
 */
export function ledgerFilters(f: LedgerFilters): Filter[] {
  const filters: Filter[] = [eq("employee_id", f.employeeId)];
  if (f.leaveTypeId != null && f.leaveTypeId !== "") filters.push(eq("leave_type_id", f.leaveTypeId));
  if (f.leaveYear != null) filters.push(eq("leave_year", f.leaveYear));
  if (f.entryTypes !== undefined && f.entryTypes.length > 0)
    filters.push(inList("entry_type", [...f.entryTypes]));
  if (f.from !== undefined && f.from !== "") filters.push(gte("effective_date", f.from));
  if (f.to !== undefined && f.to !== "") filters.push(lte("effective_date", f.to));
  return filters;
}

/**
 * One keyset page of `v_leave_ledger_statement`, newest movement first.
 *
 * `balance_after` comes back exactly as the ledger stamped it at insert time, so
 * the statement reads as a bank statement does: the running balance belongs to
 * the row, not to the reader's scroll position.
 */
export function fetchEmployeeLedgerPage(
  f: LedgerFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<LedgerRow>> {
  return paginate(V_LEDGER_STATEMENT, ledgerRowSchema, {
    orderBy: "effective_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: ledgerFilters(f),
    ...(signal ? { signal } : {}),
  });
}

/** How many movements match the grid's own predicate, counted by Postgres. */
export function countEmployeeLedgerRows(f: LedgerFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_LEDGER_STATEMENT, ledgerFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * The leave years this person actually has ledger rows in — so the year picker
 * offers the years that exist instead of a browser-invented range. One column,
 * capped; the distinct set is taken from the returned rows, which is a set
 * operation and not a business figure.
 */
export const ledgerYearRowSchema = z.object({ leave_year: dbInt });

export function fetchLedgerYears(employeeId: string, signal?: AbortSignal): Promise<number[]> {
  return selectMany(V_LEDGER_STATEMENT, ledgerYearRowSchema, {
    columns: "leave_year",
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "leave_year", ascending: false }],
    limit: 2000,
    ...(signal ? { signal } : {}),
  }).then((rows) => [...new Set(rows.map((row) => row.leave_year))]);
}

// -----------------------------------------------------------------------------
// 2. Balance-record counts (`/admin/leave/rollover`, `/admin/leave/encashment`)
// -----------------------------------------------------------------------------

/**
 * A slice of `v_leave_balance_current` a tile or a per-type row counts.
 *
 * The view is one row per employee × leave type, pinned to the CURRENT leave
 * year (`WHERE lb.leave_year = leave_year_of(ist_today())`), so every count here
 * is "records", never "days" — no relation deployed anywhere sums days by type,
 * and a browser-side sum is exactly what this build refuses.
 */
export interface BalanceSlice {
  readonly leaveTypeIds?: readonly string[];
  /** `available_days > this`. 0 means "holds anything at all". */
  readonly availableAbove?: number;
  /** `encashed_days > 0` — already encashed inside the current leave year. */
  readonly encashedOnly?: boolean;
}

export function balanceSliceFilters(slice: BalanceSlice): Filter[] {
  const filters: Filter[] = [];
  if (slice.leaveTypeIds !== undefined && slice.leaveTypeIds.length > 0)
    filters.push(inList("leave_type_id", [...slice.leaveTypeIds]));
  if (slice.availableAbove !== undefined) filters.push(gt("available_days", slice.availableAbove));
  if (slice.encashedOnly === true) filters.push(gt("encashed_days", 0));
  return filters;
}

/** How many employee × type balance records fall in this slice. */
export function countBalanceRecords(slice: BalanceSlice, signal?: AbortSignal): Promise<number> {
  return selectCount(V_BALANCE_CURRENT, balanceSliceFilters(slice), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Rollover history (`/admin/leave/rollover`)
// -----------------------------------------------------------------------------

/**
 * `leave_year_rollovers` (019 §7). `dry_run` and `status` are the run's own
 * columns; `days_carried` / `days_lapsed` / `days_encashed` are what the run
 * WROTE, recorded by the job — not a projection of what a future run might do.
 */
export const rolloverRunSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  from_leave_year: dbInt,
  to_leave_year: dbInt,
  leave_type_id: dbUuidNullable,
  run_at: dbTimestamp,
  run_by: dbUuidNullable,
  status: z.enum(["running", "succeeded", "failed", "skipped", "timed_out", "cancelled"]),
  employees_processed: dbInt,
  days_carried: dbNumeric,
  days_lapsed: dbNumeric,
  days_encashed: dbNumeric,
  dry_run: z.boolean(),
  error_detail: z.string().nullable(),
});
export type RolloverRun = z.infer<typeof rolloverRunSchema>;

const ROLLOVER_COLUMNS =
  "id, company_id, from_leave_year, to_leave_year, leave_type_id, run_at, run_by, status, " +
  "employees_processed, days_carried, days_lapsed, days_encashed, dry_run, error_detail";

/** Every rollover this company has run, newest first. */
export function fetchRolloverRuns(
  limit = 100,
  signal?: AbortSignal,
): Promise<RolloverRun[]> {
  return selectMany(LEAVE_ROLLOVERS_TABLE, rolloverRunSchema, {
    columns: ROLLOVER_COLUMNS,
    order: [{ column: "run_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Org leave calendar (`/admin/leave/calendar`)
// -----------------------------------------------------------------------------

export interface OrgCalendarFilters {
  readonly from: string;
  readonly to: string;
  readonly departmentId?: string | null;
  readonly leaveTypeId?: string | null;
  readonly statuses?: readonly LeaveRequestStatus[];
}

/**
 * `v_leave_calendar` already restricts itself to the live statuses
 * (`pending`, `approved`, `partially_approved`, `cancellation_pending`) and to
 * `leave_request_days.is_counted`, so a day on this calendar is a day that
 * actually costs the venue a person.
 */
export function orgCalendarFilters(f: OrgCalendarFilters): Filter[] {
  const filters: Filter[] = [gte("leave_date", f.from), lte("leave_date", f.to)];
  if (f.departmentId != null && f.departmentId !== "")
    filters.push(eq("department_id", f.departmentId));
  if (f.leaveTypeId != null && f.leaveTypeId !== "") filters.push(eq("leave_type_id", f.leaveTypeId));
  if (f.statuses !== undefined && f.statuses.length > 0)
    filters.push(inList("status", [...f.statuses]));
  return filters;
}

/** The month's counted leave days, employee by employee, date-ordered. */
export function fetchOrgLeaveCalendar(
  f: OrgCalendarFilters,
  limit = LEAVE_CONFIG_ROW_CAP,
  signal?: AbortSignal,
): Promise<LeaveCalendarRow[]> {
  return selectMany(V_LEAVE_CALENDAR, leaveCalendarRowSchema, {
    filters: orgCalendarFilters(f),
    order: [
      { column: "leave_date", ascending: true },
      { column: "display_name", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The month's total, counted by Postgres over the SAME predicate. It is also the
 * truncation check: when it exceeds the rows the grid received, the screen says
 * so instead of quietly drawing a thinner month than the one that exists.
 */
export function countOrgLeaveCalendar(
  f: OrgCalendarFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_LEAVE_CALENDAR, orgCalendarFilters(f), { ...(signal ? { signal } : {}) });
}

/** The statuses the calendar's two "state" tiles count, per `v_leave_calendar`. */
export const CALENDAR_APPROVED_STATUSES: readonly LeaveRequestStatus[] = [
  "approved",
  "partially_approved",
];
export const CALENDAR_PENDING_STATUSES: readonly LeaveRequestStatus[] = [
  "pending",
  "cancellation_pending",
];

// -----------------------------------------------------------------------------
// 5. Encashment movements (`/admin/leave/encashment`)
// -----------------------------------------------------------------------------

export interface EncashmentLedgerFilters {
  readonly leaveTypeIds?: readonly string[];
  readonly leaveYear?: number | null;
}

/**
 * Encashment is a DEBIT on the ledger (`ck_ll__sign`: `encashment` must be
 * negative), written by the payroll/rollover path with the run it was paid in.
 * These are the movements that actually happened; nothing on the screen predicts
 * one.
 */
export function encashmentLedgerFilters(f: EncashmentLedgerFilters): Filter[] {
  const filters: Filter[] = [inList("entry_type", [...ENCASHMENT_ENTRY_TYPES])];
  if (f.leaveTypeIds !== undefined && f.leaveTypeIds.length > 0)
    filters.push(inList("leave_type_id", [...f.leaveTypeIds]));
  if (f.leaveYear != null) filters.push(eq("leave_year", f.leaveYear));
  return filters;
}

export function fetchEncashmentLedger(
  f: EncashmentLedgerFilters,
  limit = LEAVE_CONFIG_ROW_CAP,
  signal?: AbortSignal,
): Promise<LedgerRow[]> {
  return selectMany(V_LEDGER_STATEMENT, ledgerRowSchema, {
    filters: encashmentLedgerFilters(f),
    order: [{ column: "effective_date", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countEncashmentLedger(
  f: EncashmentLedgerFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_LEDGER_STATEMENT, encashmentLedgerFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/* Re-exported so a calendar screen importing this module does not also have to
 * reach into `leave.api` for the status union its tiles are keyed by. */
export type { LeaveRequestStatus };
