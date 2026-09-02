/**
 * useAttendanceRecords — the data layer behind three §4 screens:
 * `/admin/attendance/days`, `/admin/attendance/exceptions` and
 * `/admin/attendance/coverage`.
 *
 * Four rules this file exists to keep:
 *
 *  1. EVERY FIGURE IS A SERVER COUNT OVER THE LIST'S OWN PREDICATE. The header
 *     total, each status chip and each exception-kind chip are
 *     `count=exact` requests built from the SAME filter object handed to the
 *     paged read (`countDayRecords`/`countExceptionQueue` re-use the api
 *     module's own predicate builders). `rows.length` is never a total: the day
 *     grid is keyset-paged and the queue is capped at 200 rows, so counting
 *     loaded rows would make a figure depend on how far someone scrolled — the
 *     `7 vs 8` defect (DR-29).
 *  2. NOTHING IS DERIVED. Worked, payable, late, early, overtime and the day's
 *     status are columns of `v_attendance_day_enriched`, already carrying the
 *     unpaid break, the grace period and the day status. This file moves rows.
 *  3. KEYSET PAGING, NOT OFFSET. The attendance engine writes
 *     `attendance_days` while an admin scrolls a month of it; OFFSET paging over
 *     a shifting set repeats and skips rows.
 *  4. THE SINGLE-SCAN CASE IS SELECTED BY THE SERVER. "Scanned in and never
 *     out" is `anomaly_flags @> {single_punch_only}` — a structured predicate
 *     (`DayFilters.anomalyFlags`), not a substring match on the sentence
 *     `v_exception_queue.description` builds. So its count, its list and the
 *     engine agree by construction.
 */
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import {
  type PendingApprovalPunch,
  decideOffHoursPunch,
  fetchPendingApprovalPunches,
  SINGLE_PUNCH_FLAG,
  countDayRecords,
  countExceptionQueue,
  fetchDay,
  fetchDayRecords,
  fetchExceptionQueue,
  type AttendanceStatus,
  type DayFilters,
  type DayRow,
  type ExceptionFilters,
  type ExceptionRow,
} from "../api/attendance.api";
import {
  countPublishedRosterSlots,
  countRosters,
  fetchRosters,
  publishRoster,
  type Roster,
  type RosterFilters,
} from "../api/coverage.api";
import { useAuditedMutation, type AuditedMutationResult } from "@/shared/hooks/useAuditedMutation";

export const DAY_RECORDS_PAGE_SIZE = 50;
/** Hard cap on one read of the queue. The screen states it when it bites. */
export const EXCEPTION_QUEUE_LIMIT = 200;
/** Hard cap on the featured single-scan list; its COUNT is unbounded. */
export const SINGLE_SCAN_LIMIT = 100;
export const ROSTER_LIST_LIMIT = 200;

// -----------------------------------------------------------------------------
// 1. Day Records
// -----------------------------------------------------------------------------

/**
 * Query keys must be plain comparable data. `DayFilters` holds readonly arrays,
 * so it is flattened into a literal — two filter objects that mean the same
 * thing then share a cache entry instead of missing it.
 */
function dayKey(f: DayFilters, pageSize: number): Record<string, unknown> {
  return {
    from: f.from,
    to: f.to,
    employeeIds: [...(f.employeeIds ?? [])].sort(),
    departmentIds: [...(f.departmentIds ?? [])].sort(),
    statuses: [...(f.statuses ?? [])].sort(),
    anomalyFlags: [...(f.anomalyFlags ?? [])].sort(),
    onlyExceptions: f.onlyExceptions === true,
    onlyLate: f.onlyLate === true,
    onlyLocked: f.onlyLocked === true,
    pageSize,
  };
}

export type DayRecordsInfinite = UseInfiniteQueryResult<
  { pages: Page<DayRow>[]; pageParams: unknown[] },
  Error
>;

export function useDayRecords(
  filters: DayFilters,
  pageSize = DAY_RECORDS_PAGE_SIZE,
): DayRecordsInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    retry: shouldRetryQuery,
    queryKey: qk.admin.attendanceDays(dayKey(filters, pageSize)),
    queryFn: ({ pageParam, signal }) => fetchDayRecords(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Flatten loaded pages into the series the grid renders. */
export function flattenDayRecords(
  data: { pages: Page<DayRow>[] } | undefined,
): readonly DayRow[] {
  if (data === undefined) return [];
  const out: DayRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/**
 * How many employee-days match, counted by Postgres. A SEPARATE query from the
 * list on purpose: a failed count degrades to "—" in the header while the grid
 * still renders — the partial state, not a dead screen.
 */
export function useDayRecordsCount(filters: DayFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.attendanceDays({ ...dayKey(filters, 0), count: true }),
    queryFn: ({ signal }) => countDayRecords(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** One status's slice of the same period, as the database counts it. */
export interface StatusCount {
  readonly status: AttendanceStatus;
  readonly count: number | undefined;
  readonly error: Error | null;
  readonly isPending: boolean;
}

/**
 * The per-status breakdown: one `count=exact` per status, each using the page's
 * filters PLUS that status — i.e. exactly the predicate the chip drills into.
 *
 * `useQueries` rather than a hand-written list of `useQuery` calls because the
 * status vocabulary is the deployed enum (16 values) and a hook cannot be called
 * in a loop; this keeps the breakdown exhaustive instead of a curated subset
 * that would silently hide a status nobody thought of.
 */
export function useDayStatusCounts(
  filters: DayFilters,
  statuses: readonly AttendanceStatus[],
): StatusCount[] {
  const results = useQueries({
    queries: statuses.map((status) => {
      const scoped: DayFilters = { ...filters, statuses: [status] };
      return {
        queryKey: qk.admin.attendanceDays({ ...dayKey(scoped, 0), count: true }),
        queryFn: ({ signal }: { signal: AbortSignal }) => countDayRecords(scoped, signal),
        retry: shouldRetryQuery,
      };
    }),
  });

  const out: StatusCount[] = [];
  results.forEach((result, index) => {
    const status = statuses[index];
    if (status === undefined) return;
    out.push({
      status,
      count: result.data,
      error: result.error,
      isPending: result.isPending,
    });
  });
  return out;
}

/**
 * One computed day for one employee — the day-detail panel.
 *
 * `null` (rather than an error) when the view has no such row: for an
 * RLS-protected view "no such day" and "not in your admin scope" are
 * indistinguishable at the wire, and the panel says so instead of guessing.
 */
export function useDayDetail(
  employeeId: string | null,
  isoDate: string | null,
): UseQueryResult<DayRow | null, Error> {
  return useQuery({
    queryKey: qk.admin.attendanceDay(employeeId ?? "none", isoDate ?? "none"),
    queryFn: ({ signal }) => fetchDay(employeeId ?? "", isoDate ?? "", signal),
    enabled: employeeId !== null && employeeId !== "" && isoDate !== null && isoDate !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2. Exception dashboard
// -----------------------------------------------------------------------------

function exceptionKey(f: ExceptionFilters, limit: number): Record<string, unknown> {
  return {
    from: f.from ?? "",
    to: f.to ?? "",
    kinds: [...(f.kinds ?? [])].sort(),
    severities: [...(f.severities ?? [])].sort(),
    limit,
  };
}

/** The open queue, newest first — `v_exception_queue`'s own ordering. */
export function useExceptionQueue(
  filters: ExceptionFilters,
  limit = EXCEPTION_QUEUE_LIMIT,
): UseQueryResult<ExceptionRow[], Error> {
  return useQuery({
    queryKey: qk.admin.exceptions(exceptionKey(filters, limit)),
    queryFn: ({ signal }) => fetchExceptionQueue(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

/** The whole queue's size under the current filters, counted by Postgres. */
export function useExceptionCount(filters: ExceptionFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.exceptions({ ...exceptionKey(filters, 0), count: true }),
    queryFn: ({ signal }) => countExceptionQueue(filters, signal),
    retry: shouldRetryQuery,
  });
}

export interface KindCount {
  readonly kind: string;
  readonly count: number | undefined;
  readonly error: Error | null;
  readonly isPending: boolean;
}

/**
 * One server count per exception kind, carrying whatever date/severity filter is
 * in force — so a chip is the size of the list it opens, never the length of the
 * capped page.
 */
export function useExceptionKindCounts(
  filters: ExceptionFilters,
  kinds: readonly string[],
): KindCount[] {
  const results = useQueries({
    queries: kinds.map((kind) => {
      const scoped: ExceptionFilters = { ...filters, kinds: [kind] };
      return {
        queryKey: qk.admin.exceptions({ ...exceptionKey(scoped, 0), count: true }),
        queryFn: ({ signal }: { signal: AbortSignal }) => countExceptionQueue(scoped, signal),
        retry: shouldRetryQuery,
      };
    }),
  });

  const out: KindCount[] = [];
  results.forEach((result, index) => {
    const kind = kinds[index];
    if (kind === undefined) return;
    out.push({ kind, count: result.data, error: result.error, isPending: result.isPending });
  });
  return out;
}

/** The filter that selects "one scan and no other" over a date window. */
export function singleScanFilters(range: { from: string; to: string }): DayFilters {
  return { from: range.from, to: range.to, anomalyFlags: [SINGLE_PUNCH_FLAG] };
}

/**
 * The signature case, as a first page of at most `SINGLE_SCAN_LIMIT` days. The
 * page reads `hasMore` off the returned `Page` so it can say "showing the first
 * 100" instead of implying the list is complete.
 */
export function useSingleScanDays(
  range: { from: string; to: string },
  limit = SINGLE_SCAN_LIMIT,
): UseQueryResult<Page<DayRow>, Error> {
  const filters = singleScanFilters(range);
  return useQuery({
    queryKey: qk.admin.attendanceDays({ ...dayKey(filters, limit), singleScan: true }),
    queryFn: ({ signal }) => fetchDayRecords(filters, limit, null, signal),
    retry: shouldRetryQuery,
  });
}

/** How many single-scan days there are in the window — unbounded by the list cap. */
export function useSingleScanCount(range: {
  from: string;
  to: string;
}): UseQueryResult<number, Error> {
  const filters = singleScanFilters(range);
  return useQuery({
    queryKey: qk.admin.attendanceDays({ ...dayKey(filters, 0), singleScan: true, count: true }),
    queryFn: ({ signal }) => countDayRecords(filters, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. Event coverage — the roster half, which is the half that exists
// -----------------------------------------------------------------------------

function rosterKey(f: RosterFilters): Record<string, unknown> {
  return {
    from: f.from,
    to: f.to,
    departmentIds: [...(f.departmentIds ?? [])].sort(),
    statuses: [...(f.statuses ?? [])].sort(),
  };
}

/** Weekly rosters whose week begins inside the window, newest first. */
export function useRosters(
  filters: RosterFilters,
  limit = ROSTER_LIST_LIMIT,
): UseQueryResult<Roster[], Error> {
  return useQuery({
    queryKey: qk.admin.rosters({ ...rosterKey(filters), limit }),
    queryFn: ({ signal }) => fetchRosters(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

export function useRosterCount(filters: RosterFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.rosters({ ...rosterKey(filters), count: true }),
    queryFn: ({ signal }) => countRosters(filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Published employee-days planned in the window, company-wide.
 *
 * `enabled` is the caller's honesty switch: `roster_slots` has no department
 * column, so when a department filter is on this query is not run at all and the
 * screen shows "—" with the reason, rather than a company-wide number sitting
 * under a department heading (a tile disagreeing with its own list).
 */
export function usePublishedRosterSlotCount(
  range: { from: string; to: string },
  enabled: boolean,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.rosters({ from: range.from, to: range.to, slots: true, count: true }),
    queryFn: ({ signal }) => countPublishedRosterSlots(range, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

/**
 * Publish one draft week.
 *
 * `publish_roster` decides who may — an administrator, or the manager whose own
 * people the whole week rosters. The reason sentence is required because this is
 * the moment a plan becomes what the team is told to turn up for, and "who
 * published Saturday, and why" is a question that gets asked afterwards.
 */
export function usePublishRoster(): AuditedMutationResult<
  Roster,
  { readonly rosterId: string; readonly note?: string | null }
> {
  return useAuditedMutation({
    mutationFn: (input, reason) => publishRoster(input.rosterId, reason, input.note ?? null),
    /* The week's headers AND the slot counts: `is_published` on the slots is
       what the employee-facing screens read, so a tile that still says draft
       after a successful publish would be the screen disagreeing with itself. */
    invalidate: [qk.admin.all, qk.team.all],
  });
}

/**
 * Off-hours punches waiting on an administrator.
 *
 * A short `staleTime`, because two administrators may be working the same queue and the second
 * one should not be offered a punch the first has just decided. The decision itself refuses a
 * repeat, so the worst case is a clear refusal rather than a double decision — but being told
 * "already approved" is a worse experience than the row simply being gone.
 */
export function usePendingApprovalPunches(
  enabled = true,
): UseQueryResult<PendingApprovalPunch[], Error> {
  return useQuery({
    queryKey: qk.admin.pendingApprovalPunches(),
    queryFn: ({ signal }) => fetchPendingApprovalPunches(signal),
    enabled,
    staleTime: 15_000,
    retry: shouldRetryQuery,
  });
}

/**
 * Approve or reject one, with the reason the function insists on.
 *
 * Invalidates everything under `admin`: a decision moves the day's worked figure, the pending
 * minutes, the monthly total and the roster's star, and enumerating those keys here would be a
 * list that goes stale the next time one is added.
 */
export function useDecideOffHoursPunch(): AuditedMutationResult<
  unknown,
  { readonly punchId: string; readonly approve: boolean }
> {
  return useAuditedMutation<unknown, { readonly punchId: string; readonly approve: boolean }>({
    mutationFn: (input, reason) => decideOffHoursPunch(input, reason),
    invalidate: [qk.admin.all],
    minReasonLength: 10,
  });
}
