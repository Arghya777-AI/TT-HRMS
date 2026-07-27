/**
 * useAttendanceControls.ts — the data layer behind the three screens that can
 * MOVE a figure payroll depends on: the Recompute Console, Period Locks and
 * Bulk Actions.
 *
 * Five things this file exists to guarantee:
 *
 *  1. THE REPORT IS PARSED, NOT TRUSTED. `recomputeAttendance` in
 *     `attendance.api.ts` declares a deliberately loose `.passthrough()` schema,
 *     so its result is a bag of `unknown`. A screen that renders a before/after
 *     diff cannot work from `unknown`, and casting it would mean the first
 *     shape change in the edge function surfaces as a blank cell rather than an
 *     error. `recomputeReportSchema` below is the strict contract of
 *     `supabase/functions/attendance-recompute/index.ts` — one zod parse at this
 *     boundary, no `as`.
 *  2. DRY RUN AND COMMIT ARE DIFFERENT REQUESTS. They are two mutations with
 *     two idempotency keys. Sharing one key would make the commit REPLAY the
 *     dry run's stored response — a screen reporting a write that never
 *     happened.
 *  3. THE IDEMPOTENCY KEY IS DERIVED FROM THE REQUEST, NOT THE MOUNT. The
 *     functions' idempotency layer answers `same key + different body → 409`
 *     (`_shared/idempotency.ts`), and the reason sentence is part of the body.
 *     So the key is minted per (mode + scope + reason) and cached: retrying the
 *     identical request replays and is success; editing the reason mints a new
 *     key instead of colliding.
 *  4. NO ARITHMETIC. Every figure here is a column or a server total —
 *     `totals.daysChanged`, `totals.daysSkippedLocked`, `countDayRecords`'s
 *     `count=exact`. Nothing is summed, averaged or predicted in the browser.
 *     A scope's employee list IS resolved here, because scope membership is a
 *     set of ids, not an attendance number.
 *  5. LOCKS ARE READ WHOLE. `fetchLocks` returns released locks as well as live
 *     ones, because a lock that was lifted is the evidence that somebody lifted
 *     it. Filtering to "open only" is a view of that list, never a narrower read
 *     that hides the release.
 */
import { useCallback, useMemo, useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import { newIdempotencyKey } from "@/shared/api/invoke";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import { fetchActorNames, type ActorProfile } from "../api/audit-registers.api";
import {
  countDayRecords,
  createLock,
  fetchDayRecords,
  fetchLocks,
  recomputeAttendance,
  unlockPeriod,
  type AttendanceLock,
  type CreateLockInput,
  type DayFilters,
  type DayRow,
} from "../api/attendance.api";
import type { EmployeeLabelMap } from "./useEmployeeLabels";
import type { SelectOption } from "../components/Field";

// -----------------------------------------------------------------------------
// 1. The recompute report — the strict shape of the edge function's answer
// -----------------------------------------------------------------------------

/**
 * The fields an operator is deciding about, in the order the console shows them.
 * This is the edge function's own `FINGERPRINT_FIELDS` list: `computed_at` and
 * `computed_version` are deliberately NOT in it, because they change on every
 * run and would make every day look changed.
 */
export const FINGERPRINT_FIELDS = [
  "status",
  "statusSource",
  "dayFractionPaid",
  "punchCount",
  "grossSpanMinutes",
  "breakMinutes",
  "totalWorkedMinutes",
  "payableWorkedMinutes",
  "isLate",
  "lateMinutes",
  "earlyExitMinutes",
  "overtimeMinutes",
  "extraWorkMinutes",
  "leaveDayFraction",
  "firstInAt",
  "lastOutAt",
  "anomalyFlags",
] as const;
export type FingerprintField = (typeof FINGERPRINT_FIELDS)[number];

const dayFingerprintSchema = z.object({
  status: z.string().nullable(),
  statusSource: z.string().nullable(),
  dayFractionPaid: z.number().nullable(),
  punchCount: z.number().nullable(),
  grossSpanMinutes: z.number().nullable(),
  breakMinutes: z.number().nullable(),
  totalWorkedMinutes: z.number().nullable(),
  payableWorkedMinutes: z.number().nullable(),
  isLate: z.boolean().nullable(),
  lateMinutes: z.number().nullable(),
  earlyExitMinutes: z.number().nullable(),
  overtimeMinutes: z.number().nullable(),
  extraWorkMinutes: z.number().nullable(),
  leaveDayFraction: z.number().nullable(),
  firstInAt: z.string().nullable(),
  lastOutAt: z.string().nullable(),
  anomalyFlags: z.array(z.string()),
});
export type DayFingerprint = z.infer<typeof dayFingerprintSchema>;

const dayDiffSchema = z.object({
  employeeId: z.string(),
  employeeCode: z.string().nullable(),
  istDate: z.string(),
  /** Field names from FINGERPRINT_FIELDS, or the sentinel 'created'/'removed'. */
  changedFields: z.array(z.string()),
  before: dayFingerprintSchema.nullable(),
  after: dayFingerprintSchema.nullable(),
});
export type DayDiff = z.infer<typeof dayDiffSchema>;

const cellErrorSchema = z.object({
  employeeId: z.string(),
  istDate: z.string().nullable(),
  message: z.string(),
});
export type CellError = z.infer<typeof cellErrorSchema>;

const recomputeReportSchema = z.object({
  mode: z.enum(["dry_run", "commit"]),
  /** False on a dry run — the transaction was rolled back. */
  committed: z.boolean(),
  scope: z.object({
    from: z.string(),
    /** The range actually worked. The server clamps a future `to` to today. */
    to: z.string(),
    requestedTo: z.string(),
    days: z.number(),
    employeeCount: z.number(),
    employeesProcessed: z.number(),
    overrideLock: z.boolean(),
    /** Ids that resolved to no attendance-tracked employee — never silent. */
    unresolvedEmployeeIds: z.array(z.string()),
  }),
  totals: z.object({
    cellsTargeted: z.number(),
    /** Dry run: "would change". Commit: "did change". */
    daysChanged: z.number(),
    daysUnchanged: z.number(),
    daysNoRow: z.number(),
    /** Cells a hard lock removed from scope. Surface this, never swallow it. */
    daysSkippedLocked: z.number(),
    errors: z.number(),
  }),
  changedDays: z.array(dayDiffSchema),
  /** True when more days changed than the response was allowed to enumerate. */
  changedDaysTruncated: z.boolean(),
  errors: z.array(cellErrorSchema),
  /** `attendance_recompute_runs` ids — the evidence a commit leaves behind. */
  runIds: z.array(z.string()),
  /** True when the work loop hit its time budget before finishing the scope. */
  partial: z.boolean(),
  resume: z.object({ employeeIndex: z.number() }).nullable(),
});
export type RecomputeReport = z.infer<typeof recomputeReportSchema>;

/** What both recompute mutations take. `employeeIds: null` = the whole org. */
export interface RecomputeScope {
  readonly from: string;
  readonly to: string;
  readonly employeeIds: readonly string[] | null;
  readonly overrideLock: boolean;
}

/**
 * A stable string for a scope, so a page can tell "the dry run I am looking at
 * was produced for the scope now in the form" from "the form has moved on".
 * That comparison is what makes REFUSING to commit an unreviewed scope possible.
 */
export function recomputeScopeSignature(scope: RecomputeScope): string {
  const ids = scope.employeeIds === null ? "all" : [...scope.employeeIds].sort().join(",");
  return `${scope.from}|${scope.to}|${scope.overrideLock ? "override" : "respect"}|${ids}`;
}

/** Keys minted per request signature and reused on retry — see rule 3 above. */
function useIdempotencyKeys(): (signature: string) => string {
  const keys = useRef<Map<string, string>>(new Map());
  return useCallback((signature: string) => {
    const existing = keys.current.get(signature);
    if (existing !== undefined) return existing;
    const fresh = newIdempotencyKey();
    keys.current.set(signature, fresh);
    return fresh;
  }, []);
}

async function runRecompute(
  mode: "dry_run" | "commit",
  scope: RecomputeScope,
  reason: string,
  idempotencyKey: string,
): Promise<RecomputeReport> {
  const raw = await recomputeAttendance(
    {
      from: scope.from,
      to: scope.to,
      mode,
      overrideLock: scope.overrideLock,
      ...(scope.employeeIds !== null && scope.employeeIds.length > 0
        ? { employeeIds: scope.employeeIds }
        : {}),
    },
    reason,
    idempotencyKey,
  );
  // Second, strict parse of the same payload. Not a cast: an unexpected shape
  // fails loudly here instead of rendering as a row of em dashes.
  return recomputeReportSchema.parse(raw);
}

/**
 * STEP ONE. Computes every cell in scope inside a transaction the function then
 * ROLLS BACK, and answers with the diff. Nothing is written — not a day row, not
 * a comp-off credit, not an audit row.
 *
 * It still needs a reason, because the endpoint requires one on every call. A
 * fixed sentence is therefore correct here and only here: there is no audit row
 * for a human to justify, and asking for a typed justification to look at
 * something trains people to type nothing in particular. The COMMIT below has no
 * `defaultReason` at all.
 */
export function useRecomputeDryRun(
  dryRunReason: string,
): AuditedMutationResult<RecomputeReport, RecomputeScope> {
  const keyFor = useIdempotencyKeys();
  return useAuditedMutation<RecomputeReport, RecomputeScope>({
    defaultReason: dryRunReason,
    mutationFn: (scope, reason) =>
      runRecompute(
        "dry_run",
        scope,
        reason,
        keyFor(`dry_run|${recomputeScopeSignature(scope)}|${reason}`),
      ),
  });
}

/**
 * STEP TWO. Applies the same scope for real. No `defaultReason`: this moves
 * figures payroll pays on, so the sentence is typed by the human who decided to
 * move them.
 */
export function useRecomputeCommit(
  onDone?: (report: RecomputeReport) => void,
): AuditedMutationResult<RecomputeReport, RecomputeScope> {
  const keyFor = useIdempotencyKeys();
  return useAuditedMutation<RecomputeReport, RecomputeScope>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.attendanceAll()],
    mutationFn: (scope, reason) =>
      runRecompute(
        "commit",
        scope,
        reason,
        keyFor(`commit|${recomputeScopeSignature(scope)}|${reason}`),
      ),
    ...(onDone ? { onSuccess: (report: RecomputeReport) => onDone(report) } : {}),
  });
}

/** `employeeId|istDate` → the diff the server reported for that cell. */
export function diffIndex(report: RecomputeReport | null): ReadonlyMap<string, DayDiff> {
  const map = new Map<string, DayDiff>();
  for (const diff of report?.changedDays ?? []) {
    map.set(`${diff.employeeId}|${diff.istDate}`, diff);
  }
  return map;
}

/** `employeeId|istDate` → the failure the server reported for that cell. */
export function errorIndex(report: RecomputeReport | null): ReadonlyMap<string, CellError> {
  const map = new Map<string, CellError>();
  for (const cell of report?.errors ?? []) {
    if (cell.istDate !== null) map.set(`${cell.employeeId}|${cell.istDate}`, cell);
  }
  return map;
}

// -----------------------------------------------------------------------------
// 2. Scope resolution — which employees a scope names
// -----------------------------------------------------------------------------

export type ScopeKind = "everyone" | "employee" | "department";

export interface ResolvedScope {
  /** null = let the engine resolve every attendance-tracked employee it can see. */
  readonly employeeIds: readonly string[] | null;
  /** How many employees this client resolved, or null for an org-wide scope. */
  readonly resolvedCount: number | null;
}

/**
 * Turn the scope form into the id list the endpoint takes.
 *
 * `attendance-recompute` accepts `employeeIds` and nothing else — there is no
 * department parameter — so a department scope has to be resolved to ids before
 * the call. The resolution runs against the directory list this console already
 * loaded, matching on the DEPARTMENT NAME, because that is the column
 * `v_attendance_day_enriched` exposes (`DayFilters.departmentIds` filters
 * `department_name`). Using the name on both sides is what makes the enumerated
 * rows and the applied scope the same set rather than two nearly-identical ones.
 */
export function useResolvedScope(
  kind: ScopeKind,
  employeeId: string,
  departmentName: string,
  labels: EmployeeLabelMap | undefined,
): ResolvedScope {
  return useMemo<ResolvedScope>(() => {
    if (kind === "employee") {
      if (employeeId === "") return { employeeIds: [], resolvedCount: 0 };
      return { employeeIds: [employeeId], resolvedCount: 1 };
    }
    if (kind === "department") {
      if (departmentName === "" || labels === undefined) {
        return { employeeIds: [], resolvedCount: 0 };
      }
      const ids = [...labels.values()]
        .filter((label) => label.department === departmentName)
        .map((label) => label.id);
      return { employeeIds: ids, resolvedCount: ids.length };
    }
    return { employeeIds: null, resolvedCount: null };
  }, [kind, employeeId, departmentName, labels]);
}

/**
 * The department names that actually appear on the directory list, as picker
 * options. Built from the same list the scope resolves against, so a department
 * an admin can pick can never resolve to zero employees by name mismatch.
 */
export function useScopeDepartmentOptions(labels: EmployeeLabelMap | undefined): SelectOption[] {
  return useMemo(() => {
    const names = new Set<string>();
    for (const label of labels?.values() ?? []) {
      if (label.department !== null && label.department !== "") names.add(label.department);
    }
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [labels]);
}

// -----------------------------------------------------------------------------
// 3. Period locks
// -----------------------------------------------------------------------------

/** `fetchLocks` reads at most this many rows; the screen says so when it fills. */
export const LOCK_ROW_CAP = 200;

/** Every lock, live and released, newest period first. */
export function useAttendanceLocks(): UseQueryResult<AttendanceLock[], Error> {
  return useQuery({
    queryKey: qk.admin.locks(),
    queryFn: ({ signal }) => fetchLocks({}, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * `locked_by` / `unlocked_by` are `profiles.id` (migration
 * `attendance_days.sql`: `REFERENCES public.profiles(id)`), not employee ids.
 * Resolving them through `profiles` is the only way the grid can name a person
 * instead of printing a uuid.
 */
export function useLockActorNames(
  locks: readonly AttendanceLock[] | undefined,
): UseQueryResult<ReadonlyMap<string, ActorProfile>, Error> {
  const ids = useMemo(() => {
    const set = new Set<string>();
    for (const lock of locks ?? []) {
      set.add(lock.locked_by);
      if (lock.unlocked_by !== null) set.add(lock.unlocked_by);
    }
    return [...set].sort();
  }, [locks]);

  return useQuery({
    queryKey: qk.admin.auditActorNames(ids),
    queryFn: ({ signal }) => fetchActorNames(ids, signal),
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * Take a lock. `attendance_locks` is in `audit.reason_required_tables` AND has a
 * NOT NULL `reason` column with a ≥10 CHECK, so the sentence is written twice:
 * once as the data the grid renders, once as the audit row. Never defaulted.
 */
export function useCreateLock(
  onDone?: (lock: AttendanceLock) => void,
): AuditedMutationResult<AttendanceLock, CreateLockInput> {
  return useAuditedMutation<AttendanceLock, CreateLockInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.attendanceAll()],
    mutationFn: (input, reason) => createLock(input, reason),
    ...(onDone ? { onSuccess: (lock: AttendanceLock) => onDone(lock) } : {}),
  });
}

export interface UnlockInput {
  readonly lockId: string;
  readonly unlockedBy: string;
  /** Only for the confirmation copy — never sent. */
  readonly fromDate: string;
  readonly toDate: string;
}

/**
 * Release a lock. RLS restricts the UPDATE to `super_admin`
 * (`attendance_locks__super_update`), so an ordinary admin's attempt matches
 * zero rows and surfaces as `not_found`. The screen therefore hides the action
 * behind `admin.super` and says why rather than offering a button that fails.
 */
export function useUnlockPeriod(
  onDone?: (lock: AttendanceLock) => void,
): AuditedMutationResult<AttendanceLock, UnlockInput> {
  return useAuditedMutation<AttendanceLock, UnlockInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.attendanceAll()],
    mutationFn: (input, reason) => unlockPeriod(input.lockId, input.unlockedBy, reason),
    ...(onDone ? { onSuccess: (lock: AttendanceLock) => onDone(lock) } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Bulk preview — enumerate the employee-days before anything is applied
// -----------------------------------------------------------------------------

/** Rows per keyset page while enumerating. */
const BULK_PAGE_SIZE = 200;
/** The most employee-days one preview will enumerate. */
export const BULK_PREVIEW_CAP = 1_000;

export interface BulkPreview {
  readonly rows: readonly DayRow[];
  /**
   * False when the scope holds more rows than the cap. The screen must refuse to
   * apply on an incomplete enumeration — "never apply anything not enumerated"
   * is the whole point of this screen.
   */
  readonly complete: boolean;
}

function dayFilterKey(filters: DayFilters): Record<string, unknown> {
  return {
    from: filters.from,
    to: filters.to,
    employeeIds: [...(filters.employeeIds ?? [])].sort(),
    departmentIds: [...(filters.departmentIds ?? [])].sort(),
    statuses: [...(filters.statuses ?? [])].sort(),
    onlyExceptions: filters.onlyExceptions ?? false,
    onlyLate: filters.onlyLate ?? false,
    onlyLocked: filters.onlyLocked ?? false,
    anomalyFlags: [...(filters.anomalyFlags ?? [])].sort(),
  };
}

/**
 * Every employee-day in scope, walked with the keyset cursor until the scope is
 * exhausted or the cap is reached. Paging is not arithmetic — no figure is
 * derived here, the rows are printed as the view returned them.
 */
export function useBulkPreview(
  filters: DayFilters,
  enabled: boolean,
): UseQueryResult<BulkPreview, Error> {
  return useQuery({
    queryKey: qk.admin.attendanceDays({ ...dayFilterKey(filters), preview: true }),
    queryFn: async ({ signal }) => {
      const rows: DayRow[] = [];
      let cursor = null as Awaited<ReturnType<typeof fetchDayRecords>>["nextCursor"];
      let hasMore = true;
      while (hasMore && rows.length < BULK_PREVIEW_CAP) {
        const page = await fetchDayRecords(filters, BULK_PAGE_SIZE, cursor, signal);
        rows.push(...page.rows);
        cursor = page.nextCursor;
        hasMore = page.hasMore && cursor !== null;
      }
      const preview: BulkPreview = { rows, complete: !hasMore };
      return preview;
    },
    enabled,
    retry: shouldRetryQuery,
  });
}

/**
 * How many employee-days the scope holds, counted by Postgres over the SAME
 * predicate as the enumeration. Kept a separate query so a failed count degrades
 * the header to an em dash while the list still renders.
 */
export function useDayScopeCount(
  filters: DayFilters,
  enabled: boolean,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.attendanceDays({ ...dayFilterKey(filters), count: true }),
    queryFn: ({ signal }) => countDayRecords(filters, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}
