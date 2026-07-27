/**
 * usePunchConsole — the data layer behind /admin/attendance/punches and
 * /admin/attendance/punches/new.
 *
 * `attendance_punches` is the system of record for one camera at one gate, and
 * this file is shaped by the three consequences of that:
 *
 *  1. THE LOG IS EVIDENCE, SO NOTHING IS HIDDEN. `fetchPunchLog` defaults to
 *     excluding voided rows; the Punch Log passes `includeVoided: true` on every
 *     read and strikes them through instead. A void is a fifth column on an
 *     existing row, never a delete, so an admin who voids a scan can still see
 *     the scan, when it happened, and who voided it and why.
 *  2. THE TOTAL IS POSTGRES'S. `usePunchLogCount` is a `count=exact` over the
 *     SAME `PunchFilters` object the paged read gets, so the header figure and
 *     the rows cannot disagree no matter how far the admin has scrolled (DR-29).
 *     Nothing here reads `rows.length`.
 *  3. NO ARITHMETIC, AND NO DERIVED DIRECTION. `derived_direction` ('IN' on the
 *     first scan of the IST day, 'OUT' on the last when there is more than one,
 *     'SCAN' for everything between) is computed by
 *     `v_attendance_punch_detail`. This layer never decides which scan was
 *     arrival — that is precisely the rule the product exists to enforce.
 *
 * Keyset paging, not OFFSET: the log is being appended to while it is read, and
 * OFFSET over a growing relation repeats and skips rows.
 */
import { useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import { newIdempotencyKey } from "@/shared/api/invoke";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import { t } from "@/shared/i18n/en";
import {
  countPunchLog,
  fetchPunchLog,
  fetchPunchesForDay,
  voidPunch,
  voidReasonCodes,
  type PunchFilters,
  type PunchRow,
  type VoidReasonCode,
} from "../api/attendance.api";
import type { SelectOption } from "../components/Field";
import { useEmployeeLabels, type EmployeeLabel, type EmployeeLabelMap } from "./useEmployeeLabels";

export const PUNCH_LOG_PAGE_SIZE = 50;

// -----------------------------------------------------------------------------
// 1. The raw log
// -----------------------------------------------------------------------------

/**
 * Query keys must be plain comparable data. `PunchFilters` carries readonly
 * arrays, so it is flattened — two filter objects that mean the same thing then
 * share one cache entry instead of missing it.
 */
function punchLogKey(f: PunchFilters, pageSize: number): Record<string, unknown> {
  return {
    from: f.from,
    to: f.to,
    employeeIds: [...(f.employeeIds ?? [])].sort(),
    deviceIds: [...(f.deviceIds ?? [])].sort(),
    sources: [...(f.sources ?? [])].sort(),
    includeVoided: f.includeVoided === true,
    onlyVoided: f.onlyVoided === true,
    onlyNeedsReview: f.onlyNeedsReview === true,
    pageSize,
  };
}

export type PunchLogInfinite = UseInfiniteQueryResult<
  { pages: Page<PunchRow>[]; pageParams: unknown[] },
  Error
>;

export function usePunchLog(
  filters: PunchFilters,
  pageSize = PUNCH_LOG_PAGE_SIZE,
): PunchLogInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    retry: shouldRetryQuery,
    queryKey: qk.admin.punches(punchLogKey(filters, pageSize)),
    queryFn: ({ pageParam, signal }) => fetchPunchLog(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Flatten the loaded pages into the series the grid renders. */
export function flattenPunches(
  data: { pages: Page<PunchRow>[] } | undefined,
): readonly PunchRow[] {
  if (data === undefined) return [];
  const out: PunchRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/**
 * How many scans match, counted by the server. A separate query on purpose: a
 * failed count degrades the header to an em dash while the log still renders.
 */
export function usePunchLogCount(filters: PunchFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.punches({ ...punchLogKey(filters, 0), count: true }),
    queryFn: ({ signal }) => countPunchLog(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** Every scan behind one employee-day, oldest first — the day timeline. */
export function usePunchesForDay(
  employeeId: string | null,
  effectiveDate: string,
): UseQueryResult<PunchRow[], Error> {
  return useQuery({
    queryKey: qk.attendance.punches(employeeId ?? "none", effectiveDate),
    queryFn: ({ signal }) => fetchPunchesForDay(employeeId ?? "", effectiveDate, signal),
    enabled: employeeId !== null && employeeId !== "" && effectiveDate !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2. Voiding — a correction, never a deletion
// -----------------------------------------------------------------------------

export interface VoidPunchInput {
  readonly punchId: string;
  /**
   * The instant of the punch. `attendance_punches` is RANGE-partitioned on
   * `punched_at` with PK `(id, punched_at)`, so passing it prunes the UPDATE to
   * one partition instead of every month the venue has ever operated.
   */
  readonly punchedAt: string;
  readonly voidReasonCode: VoidReasonCode;
  /**
   * Minted once when the admin opens the dialog for THIS row and reused across
   * retries, so a refused-then-corrected reason cannot produce two audit rows
   * claiming two different people voided the same scan. A 409 replay is success.
   */
  readonly idempotencyKey: string;
}

/** One idempotency key per void attempt. Mint it when the dialog opens, not on send. */
export function newVoidIdempotencyKey(): string {
  return newIdempotencyKey();
}

/**
 * Void a scan. The write goes to the `void-punch` edge function, not to
 * PostgREST: migration 016 puts a BEFORE UPDATE/DELETE trigger on
 * `attendance_punches` that refuses every write unless
 * `app.allow_punch_void` is set in the same transaction, and no client role holds
 * UPDATE at all. The function sets the four void columns and writes the `void`
 * audit row in one transaction, then the day metrics recompute asynchronously.
 *
 * Reason floor is 15, not the database's 10: overriding the system of record is a
 * D-21 action.
 */
export function useVoidPunch(
  onDone?: (input: VoidPunchInput) => void,
): AuditedMutationResult<unknown, VoidPunchInput> {
  return useAuditedMutation<unknown, VoidPunchInput>({
    mutationFn: (input, reason) =>
      voidPunch(
        {
          punchId: input.punchId,
          punchedAt: input.punchedAt,
          voidReasonCode: input.voidReasonCode,
        },
        reason,
        input.idempotencyKey,
      ),
    // The widest correct prefix: the void changes the log, the day record the
    // scan belongs to, the live board and the exception queue. A stale sibling
    // grid is the same defect as a stale one.
    invalidate: [qk.admin.attendanceAll(), qk.attendance.all],
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone !== undefined ? { onSuccess: (_data, input) => onDone(input) } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Vocabularies — no raw enum reaches the screen (DR-53)
// -----------------------------------------------------------------------------

/**
 * `public.punch_source` (migration 003). The log itself renders the view's own
 * `source_label`; these labels exist for the FILTER, where there is no row to
 * read a label off.
 */
export const punchSourceValues = [
  "kiosk_face",
  "kiosk_fingerprint",
  "kiosk_card",
  "kiosk_manual",
  "web",
  "mobile",
  "biometric_device",
  "manual_admin",
  "import",
  "system_regularization",
] as const;
export type PunchSource = (typeof punchSourceValues)[number];

export function punchSourceLabel(source: PunchSource): string {
  switch (source) {
    case "kiosk_face":
      return t("admin.punch.source.kioskFace");
    case "kiosk_fingerprint":
      return t("admin.punch.source.kioskFingerprint");
    case "kiosk_card":
      return t("admin.punch.source.kioskCard");
    case "kiosk_manual":
      return t("admin.punch.source.kioskManual");
    case "web":
      return t("admin.punch.source.web");
    case "mobile":
      return t("admin.punch.source.mobile");
    case "biometric_device":
      return t("admin.punch.source.biometric");
    case "manual_admin":
      return t("admin.punch.source.manualAdmin");
    case "import":
      return t("admin.punch.source.import");
    case "system_regularization":
      return t("admin.punch.source.regularization");
  }
}

export function usePunchSourceOptions(): SelectOption[] {
  return useMemo(
    () => punchSourceValues.map((value) => ({ value, label: punchSourceLabel(value) })),
    [],
  );
}

/**
 * The six codes the DEPLOYED `void-punch` function accepts. Three are the ones an
 * admin picks by hand; three (`debounce`, `rate_limit_day`, `spoof_rejected`) are
 * what the kiosk writes when it auto-voids, and are offered here because an admin
 * cleaning up after a device fault should be able to file the void under the same
 * code the machine would have used.
 */
export function voidReasonCodeLabel(code: VoidReasonCode): string {
  switch (code) {
    case "admin_void":
      return t("admin.punch.voidCode.adminVoid");
    case "reassigned":
      return t("admin.punch.voidCode.reassigned");
    case "import_correction":
      return t("admin.punch.voidCode.importCorrection");
    case "debounce":
      return t("admin.punch.voidCode.debounce");
    case "rate_limit_day":
      return t("admin.punch.voidCode.rateLimitDay");
    case "spoof_rejected":
      return t("admin.punch.voidCode.spoofRejected");
  }
}

export function useVoidReasonCodeOptions(): SelectOption[] {
  return useMemo(
    () => voidReasonCodes.map((value) => ({ value, label: voidReasonCodeLabel(value) })),
    [],
  );
}

/**
 * `public.punch_direction`. The kiosk always writes 'undetermined' and the day
 * engine derives arrival from the FIRST scan and departure from the LAST — so a
 * direction on a manual punch is provenance ("the guard said he was leaving"),
 * never the thing that decides the day.
 */
export const punchDirectionValues = ["in", "out", "undetermined"] as const;
export type ManualPunchDirection = (typeof punchDirectionValues)[number];

export function punchDirectionLabel(direction: string): string {
  switch (direction) {
    case "in":
      return t("admin.punch.direction.in");
    case "out":
      return t("admin.punch.direction.out");
    case "break_start":
      return t("admin.punch.direction.breakStart");
    case "break_end":
      return t("admin.punch.direction.breakEnd");
    case "undetermined":
      return t("admin.punch.direction.undetermined");
    default:
      return direction;
  }
}

export function useDirectionOptions(): SelectOption[] {
  return useMemo(
    () => punchDirectionValues.map((value) => ({ value, label: punchDirectionLabel(value) })),
    [],
  );
}

// -----------------------------------------------------------------------------
// 4. Manual punch — resolving a code to a PERSON before anything is submitted
// -----------------------------------------------------------------------------

/**
 * Employee code → the person, from the directory read six other admin screens
 * already share. Looking a code up in a map that is already loaded is a join,
 * not a computation, and it means the confirm step is instant rather than a
 * round trip the admin will click through.
 *
 * Keyed on the UPPER-CASED, trimmed code: a guard typing `tt-014` must resolve
 * to the same person as `TT-014`, and silently failing to match on case is how a
 * manual punch gets filed against nobody.
 */
export function useEmployeeCodeIndex(): {
  readonly index: ReadonlyMap<string, EmployeeLabel>;
  readonly isLoading: boolean;
  readonly error: Error | null;
} {
  const labels = useEmployeeLabels();
  const index = useMemo(() => buildCodeIndex(labels.data), [labels.data]);
  return { index, isLoading: labels.isLoading, error: labels.error };
}

function buildCodeIndex(labels: EmployeeLabelMap | undefined): ReadonlyMap<string, EmployeeLabel> {
  const map = new Map<string, EmployeeLabel>();
  if (labels === undefined) return map;
  for (const label of labels.values()) map.set(label.code.trim().toUpperCase(), label);
  return map;
}

/** Normalise what the admin typed into the form the index is keyed on. */
export function normaliseEmployeeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Whether this build can actually WRITE a manual punch.
 *
 * It cannot, and that is a server fact rather than a UI decision, so it is
 * stated here once instead of being discovered by an admin at the end of a form:
 *
 *  - `attendance_punches` has no INSERT policy for any client role, and migration
 *    016 explicitly REVOKEs INSERT/UPDATE/DELETE from them. A PostgREST insert
 *    returns 42501, so it is not an option however the form is written.
 *  - `supabase/functions/` holds exactly two writers of that table. `void-punch`
 *    only voids. `kiosk-punch` is auth model D+O — it requires a device HMAC and
 *    an open operator session, its body demands a 128-float face descriptor with
 *    `mode: 'face'` under a `.strict()` schema, and it hard-codes
 *    `source = 'kiosk_face'`. An admin browser session cannot satisfy any of
 *    that, and it is the wrong provenance regardless: a manual punch must be
 *    `source = 'manual_admin'`, which is a value nothing currently writes.
 *
 * So the form collects and validates the whole payload and refuses to pretend it
 * was recorded. The missing piece is one edge function.
 */
export const MANUAL_PUNCH_WRITE_AVAILABLE = false;

/** The endpoint that has to exist before the form can submit. */
export const MANUAL_PUNCH_FN = "manual-punch";
