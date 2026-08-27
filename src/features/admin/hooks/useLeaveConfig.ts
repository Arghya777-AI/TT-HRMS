/**
 * useLeaveConfig.ts — TanStack hooks for the five leave CONFIGURATION screens:
 * the type master, one employee's balance ledger, year-end rollover, the org
 * calendar and encashment.
 *
 * The rules this file exists to keep (same three as `useAdminLeave.ts`, which
 * owns the other four leave screens):
 *
 *  1. Keys come from `qk.*` only. Everything that a leave write could invalidate
 *    lives under the `["admin","leave",…]` prefix, so one
 *    `invalidateQueries(qk.admin.leaveAll())` after a type edit refreshes the
 *    type grid, the balance counts and the rollover exposure together.
 *  2. Writes go through `useAuditedMutation`, never `useMutation`:
 *    `leave_types` is in `audit.reason_required_tables`, so a save without
 *    `X-Reason` is refused by the database with SQLSTATE 22023. The reason is
 *    validated in the browser first and travels on that one request.
 *  3. No hook returns a derived figure. Balances come from
 *    `v_leave_balance_current` (GENERATED columns over the append-only ledger),
 *    totals come from `count=exact`, and the ledger's running balance is the
 *    `balance_after` the database stamped. This layer moves rows.
 */
import { useMemo } from "react";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import {
  SENSITIVE_REASON_LENGTH,
  shouldRetryQuery,
  type Cursor,
  type Page,
} from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  archiveLeaveType,
  fetchLeaveBalances,
  insertLeaveType,
  updateLeaveType,
  type LeaveBalance,
  type LeaveType,
} from "../api/leave.api";
import {
  LEAVE_CONFIG_ROW_CAP,
  countBalanceRecords,
  countEmployeeLedgerRows,
  countEncashmentLedger,
  countOrgLeaveCalendar,
  fetchEmployeeLedgerPage,
  fetchEncashmentLedger,
  fetchLeaveTypeRulebook,
  fetchLedgerYears,
  fetchOrgLeaveCalendar,
  fetchRolloverRuns,
  type BalanceSlice,
  type EncashmentLedgerFilters,
  type LedgerFilters,
  type LeaveCalendarRow,
  type LedgerRow,
  type OrgCalendarFilters,
  type RolloverRun,
  rolloverLeaveYear,
  type RolloverResult,
} from "../api/leave-config.api";

/** One page of a ledger statement. 50 keeps a year of movements to two pages. */
export const LEDGER_PAGE_SIZE = 50;

/** Reference data changes rarely; a rulebook read every keystroke is waste. */
const CONFIG_STALE_MS = 5 * 60 * 1000;

// -----------------------------------------------------------------------------
// 1. Leave type master (`/admin/leave/types`)
// -----------------------------------------------------------------------------

/**
 * The rulebook, live rows or retired rows. Two separate cache entries rather than
 * one filtered client-side, because "retired" is a server predicate
 * (`deleted_at IS NOT NULL`) and a soft-deleted row is never in the live read at
 * all — filtering a list that cannot contain them would show the live list twice.
 *
 * The key is `qk.admin.leaveType(<variant>)` — the factory's per-row key given a
 * variant name instead of a uuid. Deliberate: it keeps BOTH lists under the
 * `["admin","leave",…]` prefix, so the single `qk.admin.leaveAll()` invalidation
 * after a save refreshes whichever list is on screen, and a variant name can
 * never collide with a uuid.
 */
export function useLeaveTypeRulebook(archived: boolean): UseQueryResult<LeaveType[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveType(archived ? "retired" : "live"),
    queryFn: ({ signal }) => fetchLeaveTypeRulebook({ archived }, signal),
    staleTime: CONFIG_STALE_MS,
    retry: shouldRetryQuery,
  });
}

export interface LeaveTypeSaveInput {
  /** Null on create. */
  readonly id: string | null;
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Create or edit a leave type.
 *
 * No `defaultReason`, and the floor is D-21's 15 characters rather than the
 * database's 10: changing `max_carry_forward_days` or `encashment_allowed`
 * silently re-prices every employee's entitlement, so the UI must ask a human
 * WHY. One audit row per changed field carries that sentence.
 */
export function useSaveLeaveType(): AuditedMutationResult<LeaveType, LeaveTypeSaveInput> {
  return useAuditedMutation<LeaveType, LeaveTypeSaveInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll()],
    mutationFn: (input, reason) =>
      input.id === null
        ? insertLeaveType(input.values, reason)
        : updateLeaveType(input.id, input.values, reason),
  });
}

export interface LeaveTypeArchiveInput {
  readonly id: string;
  readonly name: string;
}

/**
 * Retire a leave type (soft delete, D-23) so historical ledger rows keep their
 * name. `leave_types_guard()` raises 0A000 for a `is_system_managed` row —
 * LWP / CO / OD are written by the engine — and the screen disables the action
 * for those rows rather than letting the refusal be the explanation.
 */
export function useArchiveLeaveType(): AuditedMutationResult<void, LeaveTypeArchiveInput> {
  return useAuditedMutation<void, LeaveTypeArchiveInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll()],
    mutationFn: (input, reason) => archiveLeaveType(input.id, reason),
  });
}

// -----------------------------------------------------------------------------
// 2. Balance ledger (`/admin/leave/ledger/:code`)
// -----------------------------------------------------------------------------

function ledgerKeyParts(f: LedgerFilters): Record<string, unknown> {
  return {
    leaveTypeId: f.leaveTypeId ?? null,
    leaveYear: f.leaveYear ?? null,
    entryTypes: f.entryTypes === undefined ? null : [...f.entryTypes],
    from: f.from ?? null,
    to: f.to ?? null,
  };
}

export type LedgerInfinite = UseInfiniteQueryResult<
  { pages: Page<LedgerRow>[]; pageParams: unknown[] },
  Error
>;

/**
 * One employee's statement, keyset-paged newest movement first. Keyset and not
 * OFFSET because the accrual job and every approval write to `leave_ledger`
 * while an administrator reads it, and OFFSET over a growing table both repeats
 * and skips rows.
 */
export function useEmployeeLedger(f: LedgerFilters, enabled: boolean): LedgerInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    enabled,
    retry: shouldRetryQuery,
    queryKey: qk.admin.leaveLedger(f.employeeId, ledgerKeyParts(f)),
    queryFn: ({ pageParam, signal }) =>
      fetchEmployeeLedgerPage(f, LEDGER_PAGE_SIZE, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Flatten the loaded pages into the statement the grid renders. */
export function flattenLedger(
  data: { pages: Page<LedgerRow>[] } | undefined,
): readonly LedgerRow[] {
  if (data === undefined) return [];
  const out: LedgerRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/**
 * The statement's total, over the grid's own predicate. A SEPARATE query on
 * purpose: a failed count degrades to "—" in the header while the movements still
 * render, and `rows.length` would make the total depend on how far someone
 * pressed "load more" (DR-29).
 */
export function useEmployeeLedgerCount(
  f: LedgerFilters,
  enabled: boolean,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.leaveLedger(f.employeeId, { ...ledgerKeyParts(f), count: true }),
    queryFn: ({ signal }) => countEmployeeLedgerRows(f, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

/** The leave years this person has movements in, newest first. */
export function useLedgerYears(employeeId: string | null): UseQueryResult<number[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveLedger(employeeId ?? "", { years: true }),
    queryFn: ({ signal }) => fetchLedgerYears(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    staleTime: CONFIG_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * Every current-leave-year balance row for one employee — the statement's header
 * strip. `v_leave_balance_current` is pinned to the current leave year, so this
 * is the same relation `/admin/leave/balances` and the payroll engine read.
 */
export function useEmployeeBalances(
  employeeId: string | null,
): UseQueryResult<LeaveBalance[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveBalances({ employeeId: employeeId ?? null, statement: true }),
    queryFn: ({ signal }) => fetchLeaveBalances({ employeeIds: [employeeId ?? ""] }, 100, signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. Rollover (`/admin/leave/rollover`)
// -----------------------------------------------------------------------------

/** Every rollover recorded in `leave_year_rollovers`, newest first. */
export function useRolloverRuns(): UseQueryResult<RolloverRun[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ screen: "leave-rollover", runs: true }),
    queryFn: ({ signal }) => fetchRolloverRuns(100, signal),
    retry: shouldRetryQuery,
  });
}

/** One server count over `v_leave_balance_current`, for a tile. */
export function useBalanceRecordCount(
  slice: BalanceSlice,
  label: string,
  enabled = true,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.leaveBalances({
      slice: label,
      leaveTypeIds: slice.leaveTypeIds === undefined ? null : [...slice.leaveTypeIds],
      availableAbove: slice.availableAbove ?? null,
      encashedOnly: slice.encashedOnly === true,
    }),
    queryFn: ({ signal }) => countBalanceRecords(slice, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

/**
 * Per leave type, the two counts a rollover review needs:
 *
 *   · `withBalance` — records carrying anything at all into the year end;
 *   · `aboveCap`    — records whose balance EXCEEDS that type's own
 *     `max_carry_forward_days`, i.e. the people who will lose days unless the
 *     balance is encashed first.
 *
 * `aboveCap` is a SERVER predicate (`available_days > cap`) with the cap taken
 * from the type row, not a comparison performed over a loaded grid — and it is
 * absent (null) for a type with no cap, because there is nothing to exceed.
 * One `useQueries` call, so no hook is ever created inside a loop.
 */
export interface RolloverTypeCounts {
  readonly type: LeaveType;
  readonly withBalance: UseQueryResult<number, Error>;
  readonly aboveCap: UseQueryResult<number, Error> | null;
}

interface CountSpec {
  readonly typeId: string;
  readonly kind: "withBalance" | "aboveCap";
  readonly slice: BalanceSlice;
}

/** The carry-forward cap in force for a type, or null when it has none. */
export function carryForwardCap(type: LeaveType): number | null {
  if (!type.carry_forward_allowed) return null;
  return type.max_carry_forward_days;
}

export function useRolloverTypeCounts(
  types: readonly LeaveType[],
): readonly RolloverTypeCounts[] {
  const specs = useMemo<readonly CountSpec[]>(() => {
    const out: CountSpec[] = [];
    for (const type of types) {
      out.push({
        typeId: type.id,
        kind: "withBalance",
        slice: { leaveTypeIds: [type.id], availableAbove: 0 },
      });
      const cap = carryForwardCap(type);
      if (cap !== null) {
        out.push({
          typeId: type.id,
          kind: "aboveCap",
          slice: { leaveTypeIds: [type.id], availableAbove: cap },
        });
      }
    }
    return out;
  }, [types]);

  const results = useQueries({
    queries: specs.map((spec) => ({
      queryKey: qk.admin.leaveBalances({
        rollover: spec.kind,
        typeId: spec.typeId,
        availableAbove: spec.slice.availableAbove ?? null,
      }),
      queryFn: ({ signal }: { signal: AbortSignal }) => countBalanceRecords(spec.slice, signal),
      staleTime: CONFIG_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });

  return useMemo(() => {
    const byKey = new Map<string, UseQueryResult<number, Error>>();
    specs.forEach((spec, index) => {
      const result = results[index];
      if (result !== undefined) byKey.set(`${spec.typeId}:${spec.kind}`, result);
    });
    return types.flatMap((type) => {
      const withBalance = byKey.get(`${type.id}:withBalance`);
      if (withBalance === undefined) return [];
      return [
        {
          type,
          withBalance,
          aboveCap: byKey.get(`${type.id}:aboveCap`) ?? null,
        },
      ];
    });
  }, [types, specs, results]);
}

// -----------------------------------------------------------------------------
// 4. Org leave calendar (`/admin/leave/calendar`)
// -----------------------------------------------------------------------------

function calendarKeyParts(f: OrgCalendarFilters): Record<string, unknown> {
  return {
    screen: "leave-calendar",
    from: f.from,
    to: f.to,
    departmentId: f.departmentId ?? null,
    leaveTypeId: f.leaveTypeId ?? null,
    statuses: f.statuses === undefined ? null : [...f.statuses],
  };
}

/**
 * The month's counted leave days. Keyed through `qk.admin.list` rather than
 * `qk.admin.leaveCalendar(from, to)` on purpose: the factory's calendar key
 * carries no filter slot, and the grid, its total and its per-status tiles must
 * all key off the SAME filter shape or they will disagree by a department.
 */
export function useOrgLeaveCalendar(
  f: OrgCalendarFilters,
): UseQueryResult<LeaveCalendarRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list(calendarKeyParts(f)),
    queryFn: ({ signal }) => fetchOrgLeaveCalendar(f, LEAVE_CONFIG_ROW_CAP, signal),
    retry: shouldRetryQuery,
  });
}

/** A server count over the calendar, for a tile or the truncation check. */
export function useOrgLeaveCalendarCount(
  f: OrgCalendarFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ ...calendarKeyParts(f), count: true }),
    queryFn: ({ signal }) => countOrgLeaveCalendar(f, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 5. Encashment (`/admin/leave/encashment`)
// -----------------------------------------------------------------------------

/** Balance rows for the encashable types only — the encashable exposure. */
export function useEncashableBalances(
  leaveTypeIds: readonly string[],
): UseQueryResult<LeaveBalance[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveBalances({ encashable: true, leaveTypeIds: [...leaveTypeIds] }),
    queryFn: ({ signal }) =>
      fetchLeaveBalances({ leaveTypeIds }, LEAVE_CONFIG_ROW_CAP, signal),
    enabled: leaveTypeIds.length > 0,
    retry: shouldRetryQuery,
  });
}

function encashmentKeyParts(f: EncashmentLedgerFilters): Record<string, unknown> {
  return {
    screen: "leave-encashment",
    leaveTypeIds: f.leaveTypeIds === undefined ? null : [...f.leaveTypeIds],
    leaveYear: f.leaveYear ?? null,
  };
}

/** The encashment and settlement debits that were actually written. */
export function useEncashmentLedger(
  f: EncashmentLedgerFilters,
): UseQueryResult<LedgerRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list(encashmentKeyParts(f)),
    queryFn: ({ signal }) => fetchEncashmentLedger(f, LEAVE_CONFIG_ROW_CAP, signal),
    retry: shouldRetryQuery,
  });
}

export function useEncashmentLedgerCount(
  f: EncashmentLedgerFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ ...encashmentKeyParts(f), count: true }),
    queryFn: ({ signal }) => countEncashmentLedger(f, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// The year-end rollover
// -----------------------------------------------------------------------------

export interface RolloverInput {
  readonly fromLeaveYear: number;
  /** False only when an administrator has read the preview and meant it. */
  readonly dryRun: boolean;
}

/**
 * Preview or commit a year-end close.
 *
 * `SENSITIVE_REASON_LENGTH` for the same reason `useSaveLeaveType` uses it, only
 * more so: this writes a carry, a lapse and a zeroed year for every employee at
 * once, and the sentence is the only thing that will explain it to somebody
 * reading their own ledger next April.
 *
 * A DRY RUN IS STILL AN AUDITED WRITE, because it is: it inserts a
 * `leave_year_rollovers` row with `dry_run = true`, which is what the history
 * panel on this screen reads. Treating it as a plain read would have left those
 * rows with no author.
 */
export function useRolloverLeaveYear(): AuditedMutationResult<RolloverResult, RolloverInput> {
  return useAuditedMutation<RolloverResult, RolloverInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll()],
    mutationFn: (input, reason) =>
      rolloverLeaveYear({
        fromLeaveYear: input.fromLeaveYear,
        reason,
        dryRun: input.dryRun,
      }),
  });
}
