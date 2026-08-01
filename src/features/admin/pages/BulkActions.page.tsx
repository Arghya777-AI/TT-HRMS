/**
 * §4 · /admin/attendance/bulk — Bulk Actions. Apply a correction across many
 * employee-days, one enumerated row at a time.
 *
 * ── The honest scope of this screen ─────────────────────────────────────────
 * There is exactly ONE bulk write primitive deployed for attendance: a COMMIT
 * recompute (`attendance-recompute` → `recompute_attendance_range`).
 * `attendance_days` is derived and SELECT-only for admins (migration 017 has
 * `attendance_days__admin_read` and no write policy), so a bulk status override,
 * a bulk time edit, a bulk void and a bulk regularisation approval are NOT
 * available from any client — no endpoint, no RLS policy, no RPC. This screen
 * therefore offers the one action that exists and says so, rather than shipping
 * four buttons that would each fail at 42501 after somebody typed a reason.
 *
 * ── The two guarantees ──────────────────────────────────────────────────────
 *  1. NOTHING IS APPLIED THAT WAS NOT ENUMERATED FIRST. The preview lists every
 *     employee-day in scope from `v_attendance_day_enriched`, and the scope sent
 *     to the engine is the SAME employee-id list and the SAME date range. Three
 *     things consequently DISABLE Apply, each with the reason stated on screen:
 *       · an org-wide scope, because the engine resolves its own employee list
 *         for one and that set is not the set on screen;
 *       · a review filter (exceptions / late / locked only), because the engine
 *         recomputes whole days for the whole range and would touch days the
 *         filter hid;
 *       · an enumeration that hit its cap, because the rest was never seen.
 *  2. THE RESULT IS PER ROW, NOT ONE TOAST. Every enumerated row gets an outcome
 *     from the server's own answer: updated (it is in `changedDays`), failed (it
 *     is in `errors`), skipped because the period is locked (the row's own
 *     `is_locked`, matching the engine's `daysSkippedLocked` total), or
 *     unchanged. When the response truncates its diff list, the rows it could not
 *     name say so instead of claiming to be unchanged.
 *
 * NO ARITHMETIC: the scope size is a `count=exact`, every total is a field of
 * `totals`, and every cell is a column.
 *
 * @route /admin/attendance/bulk
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Layers, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import {
  addIstDays,
  civilDayOffset,
  compareCivilDates,
  fmtCivilDate,
  fmtCivilDayMonthWeekday,
  fmtDurationHm,
  nowIstDate,
} from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { DayDiffLines, dayStatusLabel } from "../components/DayDiffLines";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  BULK_PREVIEW_CAP,
  diffIndex,
  errorIndex,
  recomputeScopeSignature,
  useBulkPreview,
  useDayScopeCount,
  useRecomputeCommit,
  useRecomputeDryRun,
  useResolvedScope,
  useScopeDepartmentOptions,
  type RecomputeReport,
  type RecomputeScope,
  type ScopeKind,
} from "../hooks/useAttendanceControls";
import type { DayFilters, DayRow } from "../api/attendance.api";

/** `MAX_RANGE_DAYS` in `supabase/functions/attendance-recompute/index.ts`. */
const MAX_RANGE_DAYS = 186;

/** A review filter narrows what is LISTED. It never narrows what is applied. */
type ReviewFilter = "all" | "exceptions" | "late" | "locked";

function isReviewFilter(value: string | null): value is ReviewFilter {
  return value === "all" || value === "exceptions" || value === "late" || value === "locked";
}

function isScopeKind(value: string | null): value is ScopeKind {
  return value === "everyone" || value === "employee" || value === "department";
}

function reviewOptions(): SelectOption[] {
  return [
    { value: "all", label: t("admin.bulk.review.all") },
    { value: "exceptions", label: t("admin.bulk.review.exceptions") },
    { value: "late", label: t("admin.bulk.review.late") },
    { value: "locked", label: t("admin.bulk.review.locked") },
  ];
}

function scopeKindOptions(): SelectOption[] {
  return [
    { value: "employee", label: t("admin.recompute.scope.oneEmployee") },
    { value: "department", label: t("admin.recompute.scope.oneDepartment") },
    { value: "everyone", label: t("admin.recompute.scope.everyone") },
  ];
}

/** The five outcomes a row can have, all of them from the server's answer. */
type Outcome = "updated" | "unchanged" | "skipped_locked" | "failed" | "unreported";

const OUTCOME_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  updated: { label: t("admin.bulk.outcome.updated"), tone: "success" },
  unchanged: { label: t("admin.bulk.outcome.unchanged"), tone: "neutral" },
  skipped_locked: { label: t("admin.bulk.outcome.skippedLocked"), tone: "warn" },
  failed: { label: t("admin.bulk.outcome.failed"), tone: "danger" },
  unreported: { label: t("admin.bulk.outcome.unreported"), tone: "info" },
};

interface FrozenScope {
  readonly signature: string;
  readonly filters: DayFilters;
  readonly scope: RecomputeScope;
}

export default function BulkActionsPage() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const profileId = user?.id ?? null;
  const today = nowIstDate();

  const rawKind = params.get("kind");
  const kind: ScopeKind = isScopeKind(rawKind) ? rawKind : "employee";
  const from = params.get("from") ?? addIstDays(today, -6);
  const to = params.get("to") ?? today;
  const employeeId = params.get("emp") ?? "";
  const departmentName = params.get("dept") ?? "";
  const rawReview = params.get("review");
  const review: ReviewFilter = isReviewFilter(rawReview) ? rawReview : "all";

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const departmentChoices = useScopeDepartmentOptions(labels.data);
  const resolved = useResolvedScope(kind, employeeId, departmentName, labels.data);

  const nameFor = (id: string): { name: string | null; code: string | null } => {
    const label = labels.data?.get(id);
    return { name: label?.name ?? null, code: label?.code ?? null };
  };

  // The enumeration predicate. The employee-id list is the SAME one the engine
  // will be given, so the rows on screen and the cells in scope are one set.
  const liveFilters = useMemo<DayFilters>(
    () => ({
      from,
      to,
      ...(resolved.employeeIds !== null ? { employeeIds: resolved.employeeIds } : {}),
      ...(review === "exceptions" ? { onlyExceptions: true } : {}),
      ...(review === "late" ? { onlyLate: true } : {}),
      ...(review === "locked" ? { onlyLocked: true } : {}),
    }),
    [from, to, resolved.employeeIds, review],
  );

  const liveScope = useMemo<RecomputeScope>(
    () => ({ from, to, employeeIds: resolved.employeeIds, overrideLock: false }),
    [from, to, resolved.employeeIds],
  );
  const liveSignature = `${recomputeScopeSignature(liveScope)}|${review}`;

  const [frozen, setFrozen] = useState<FrozenScope | null>(null);
  const [predicted, setPredicted] = useState<{ signature: string; report: RecomputeReport } | null>(
    null,
  );
  const [applied, setApplied] = useState<{ signature: string; report: RecomputeReport } | null>(
    null,
  );

  const previewFilters = frozen?.filters ?? liveFilters;
  const preview = useBulkPreview(previewFilters, frozen !== null);
  const scopeCount = useDayScopeCount(previewFilters, frozen !== null);

  const dryRun = useRecomputeDryRun(t("admin.bulk.dryRunReason"));
  const commit = useRecomputeCommit();

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  // ── Validation, all of it calendar facts ────────────────────────────────────
  const span = from !== "" && to !== "" ? civilDayOffset(from, to) + 1 : 0;
  const rangeError: string | null =
    from === "" || to === ""
      ? t("admin.recompute.error.rangeRequired")
      : compareCivilDates(to, from) < 0
        ? t("admin.recompute.error.reversed")
        : compareCivilDates(from, today) > 0
          ? t("admin.recompute.error.futureFrom")
          : span > MAX_RANGE_DAYS
            ? t("admin.recompute.error.tooLong", { max: MAX_RANGE_DAYS, days: span })
            : null;

  const scopeError: string | null =
    kind === "employee" && employeeId === ""
      ? t("admin.recompute.error.pickEmployee")
      : kind === "department" && departmentName === ""
        ? t("admin.recompute.error.pickDepartment")
        : kind === "department" && resolved.resolvedCount === 0
          ? t("admin.recompute.error.emptyDepartment")
          : null;

  const canPreview = rangeError === null && scopeError === null;
  const stale = frozen !== null && frozen.signature !== liveSignature;
  const previewed = frozen !== null && !stale;
  const rows = previewed ? (preview.data?.rows ?? []) : [];
  const enumerationComplete = preview.data?.complete ?? false;
  const predictedReport =
    predicted !== null && predicted.signature === liveSignature ? predicted.report : null;
  const appliedReport =
    applied !== null && applied.signature === liveSignature ? applied.report : null;

  const applyBlocked: string | null = !previewed
    ? t("admin.bulk.blocked.noPreview")
    : profileId === null
      ? t("admin.bulk.blocked.noSession")
      : kind === "everyone"
        ? t("admin.bulk.blocked.orgWide")
        : review !== "all"
          ? t("admin.bulk.blocked.reviewFilter")
          : preview.isPending
            ? t("admin.bulk.blocked.loading")
            : !enumerationComplete
              ? t("admin.bulk.blocked.capped", { cap: formatNumber(BULK_PREVIEW_CAP) })
              : rows.length === 0
                ? t("admin.bulk.blocked.empty")
                : predictedReport === null
                  ? t("admin.bulk.blocked.noDryRun")
                  : predictedReport.partial
                    ? t("admin.bulk.blocked.partial")
                    : appliedReport !== null
                      ? t("admin.bulk.blocked.alreadyApplied")
                      : null;

  const diffs = diffIndex(predictedReport ?? appliedReport);
  const resultDiffs = diffIndex(appliedReport);
  const resultErrors = errorIndex(appliedReport);

  function outcomeOf(row: DayRow): Outcome {
    const key = `${row.employee_id}|${row.ist_date}`;
    if (resultErrors.has(key)) return "failed";
    if (resultDiffs.has(key)) return "updated";
    if (row.is_locked) return "skipped_locked";
    if (appliedReport?.changedDaysTruncated === true) return "unreported";
    return "unchanged";
  }

  const columns: DataGridColumn<DayRow>[] = [
    {
      key: "display_name",
      header: t("admin.bulk.col.employee"),
      width: "14rem",
      sortable: true,
      render: (row) => (
        <PersonCell
          name={row.display_name}
          code={row.employee_code}
          secondary={row.department_name}
        />
      ),
    },
    {
      key: "ist_date",
      header: t("admin.bulk.col.date"),
      width: "9rem",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDayMonthWeekday(row.ist_date)}</span>,
    },
    {
      key: "status",
      header: t("admin.bulk.col.status"),
      width: "10rem",
      render: (row) => <span>{dayStatusLabel(row.status)}</span>,
    },
    {
      key: "worked_hm",
      header: t("admin.bulk.col.worked"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      // The view's own string first; its minutes column formatted otherwise.
      render: (row) => (
        <span className="num">{row.worked_hm ?? fmtDurationHm(row.payable_worked_minutes)}</span>
      ),
    },
    {
      key: "late_hm",
      header: t("admin.bulk.col.late"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        row.is_late ? (
          <span className="num text-warning">{row.late_hm ?? fmtDurationHm(row.late_minutes)}</span>
        ) : (
          <span className="text-muted-foreground">{dash(null)}</span>
        ),
    },
    {
      key: "is_locked",
      header: t("admin.bulk.col.locked"),
      width: "7rem",
      hideBelow: "md",
      render: (row) =>
        row.is_locked ? (
          <span className="text-xs font-medium text-warning">{t("admin.bulk.lockedYes")}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{dash(null)}</span>
        ),
    },
    {
      key: "wouldChange",
      header: appliedReport !== null ? t("admin.bulk.col.changed") : t("admin.bulk.col.wouldChange"),
      render: (row) => {
        const diff = diffs.get(`${row.employee_id}|${row.ist_date}`);
        if (diff === undefined) {
          return (
            <span className="text-xs text-muted-foreground">
              {predictedReport === null && appliedReport === null
                ? dash(null)
                : t("admin.bulk.noChange")}
            </span>
          );
        }
        return <DayDiffLines diff={diff} />;
      },
    },
    {
      key: "outcome",
      header: t("admin.bulk.col.outcome"),
      width: "12rem",
      render: (row) => {
        if (appliedReport === null) return dash(null);
        const outcome = outcomeOf(row);
        const error = resultErrors.get(`${row.employee_id}|${row.ist_date}`);
        return (
          <span className="flex flex-col items-start gap-1">
            <StatusChip status={outcome} map={OUTCOME_CHIP} />
            {error !== undefined ? (
              <span className="text-xs text-destructive">{error.message}</span>
            ) : null}
          </span>
        );
      },
    },
  ];

  const scopeSentence =
    kind === "employee"
      ? t("admin.recompute.commit.scopeEmployee", { name: nameFor(employeeId).name ?? employeeId })
      : kind === "department"
        ? t("admin.recompute.commit.scopeDepartment", {
            department: departmentName,
            n: formatNumber(resolved.resolvedCount ?? 0),
          })
        : t("admin.recompute.commit.scopeEveryone");

  return (
    <div className="container py-6">
      <PageHeader
        icon={Layers}
        title={t("admin.bulk.title")}
        subtitle={t("admin.bulk.subtitle")}
        actions={
          /* `text-left` because this label is a whole sentence; the Button base already lets
             it wrap on a phone. */
          <Button asChild variant="ghost" className="text-left">
            <Link to="/admin/attendance/recompute">{t("admin.bulk.openRecompute")}</Link>
          </Button>
        }
      />

      <Notice tone="info" className="mt-4">
        {t("admin.bulk.onlyPrimitive")}
      </Notice>

      {/* ── Scope ───────────────────────────────────────────────────────────── */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t("admin.bulk.scope.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.bulk.scope.hint")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <TextField
            label={t("admin.common.filter.from")}
            type="date"
            value={from}
            max={today}
            onChange={(value) => setParam("from", value)}
            {...(rangeError !== null ? { error: rangeError } : {})}
          />
          <TextField
            label={t("admin.common.filter.to")}
            type="date"
            value={to}
            onChange={(value) => setParam("to", value)}
          />
          <SelectField
            label={t("admin.recompute.scope.label")}
            value={kind}
            options={scopeKindOptions()}
            onChange={(value) => setParam("kind", value)}
          />
          {kind === "employee" ? (
            <SelectField
              label={t("admin.common.filter.employee")}
              value={employeeId}
              placeholder={t("admin.recompute.scope.pickEmployee")}
              options={employeeChoices}
              disabled={labels.isLoading}
              onChange={(value) => setParam("emp", value)}
              {...(scopeError !== null ? { error: scopeError } : {})}
            />
          ) : null}
          {kind === "department" ? (
            <SelectField
              label={t("admin.recompute.scope.department")}
              value={departmentName}
              placeholder={t("admin.recompute.scope.pickDepartment")}
              options={departmentChoices}
              disabled={labels.isLoading}
              onChange={(value) => setParam("dept", value)}
              {...(scopeError !== null ? { error: scopeError } : {})}
            />
          ) : null}
          <SelectField
            label={t("admin.bulk.review.label")}
            value={review}
            options={reviewOptions()}
            onChange={(value) => setParam("review", value === "all" ? "" : value)}
            hint={t("admin.bulk.review.hint")}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              const signature = liveSignature;
              setFrozen({ signature, filters: liveFilters, scope: liveScope });
              setApplied(null);
              setPredicted(null);
              dryRun.mutate(
                { input: liveScope },
                { onSuccess: (report) => setPredicted({ signature, report }) },
              );
            }}
            disabled={!canPreview || dryRun.isPending}
          >
            <ListChecks className="mr-2 size-4" aria-hidden />
            {dryRun.isPending ? t("admin.bulk.previewing") : t("admin.bulk.preview")}
          </Button>
          {stale ? (
            <span className="text-sm text-warning">{t("admin.bulk.stale")}</span>
          ) : null}
          {previewed ? (
            <span className="text-sm text-muted-foreground">
              {scopeCount.isSuccess
                ? t("admin.bulk.inScope", { n: formatNumber(scopeCount.data) })
                : t("admin.bulk.inScopeUnknown")}
            </span>
          ) : null}
        </div>

        {dryRun.userMessage !== null ? (
          <Notice tone="error" className="mt-4">
            {dryRun.userMessage}
          </Notice>
        ) : null}
      </section>

      {/* ── Preview + apply ─────────────────────────────────────────────────── */}
      {previewed && !enumerationComplete && !preview.isPending ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.bulk.cappedNotice", { cap: formatNumber(BULK_PREVIEW_CAP) })}
        </Notice>
      ) : null}

      {predictedReport !== null ? (
        <Notice tone="info" className="mt-4">
          {t("admin.bulk.predicted", {
            change: formatNumber(predictedReport.totals.daysChanged),
            cells: formatNumber(predictedReport.totals.cellsTargeted),
          })}
        </Notice>
      ) : null}

      {predictedReport !== null && predictedReport.totals.daysSkippedLocked > 0 ? (
        <Notice
          tone="warning"
          className="mt-4"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/attendance/locks">{t("admin.recompute.report.openLocks")}</Link>
            </Button>
          }
        >
          {t("admin.bulk.lockedSkipped", {
            n: formatNumber(predictedReport.totals.daysSkippedLocked),
          })}
        </Notice>
      ) : null}

      {predictedReport !== null && predictedReport.changedDaysTruncated ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.recompute.report.truncated", {
            shown: formatNumber(predictedReport.changedDays.length),
            total: formatNumber(predictedReport.totals.daysChanged),
          })}
        </Notice>
      ) : null}

      <section className="mt-4 rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t("admin.bulk.apply.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.bulk.apply.hint")}</p>

        {applyBlocked !== null ? (
          <Notice tone="warning" className="mt-4">
            {applyBlocked}
          </Notice>
        ) : (
          <Notice tone="warning" className="mt-4">
            {t("admin.bulk.apply.ready", {
              rows: formatNumber(rows.length),
              change: formatNumber(predictedReport?.totals.daysChanged ?? 0),
            })}
          </Notice>
        )}

        <div className="mt-4">
          <ReasonActionButton
            label={t("admin.bulk.apply.submit")}
            title={t("admin.bulk.apply.dialogTitle", { rows: formatNumber(rows.length) })}
            description={t("admin.bulk.apply.dialogDescription", {
              rows: formatNumber(rows.length),
              change: formatNumber(predictedReport?.totals.daysChanged ?? 0),
              from: fmtCivilDate(from),
              to: fmtCivilDate(to),
              scope: scopeSentence,
            })}
            confirmLabel={t("admin.bulk.apply.confirm")}
            minLength={SENSITIVE_REASON_LENGTH}
            variant="destructive"
            size="default"
            disabled={applyBlocked !== null || commit.isPending}
            {...(applyBlocked !== null ? { disabledHint: applyBlocked } : {})}
            onConfirm={async (reason) => {
              const signature = liveSignature;
              const report = await commit.saveAsync(liveScope, reason);
              setApplied({ signature, report });
              return report;
            }}
          />
        </div>

        {appliedReport !== null ? (
          <div className="mt-4 space-y-3">
            <Notice tone="success">
              {t("admin.bulk.apply.done", {
                changed: formatNumber(appliedReport.totals.daysChanged),
                unchanged: formatNumber(appliedReport.totals.daysUnchanged),
                locked: formatNumber(appliedReport.totals.daysSkippedLocked),
                failed: formatNumber(appliedReport.totals.errors),
              })}
            </Notice>
            {appliedReport.totals.errors > 0 ? (
              <Notice tone="error">
                {t("admin.bulk.apply.someFailed", {
                  n: formatNumber(appliedReport.totals.errors),
                })}
              </Notice>
            ) : null}
            {appliedReport.changedDaysTruncated ? (
              <Notice tone="warning">
                {t("admin.bulk.apply.truncatedOutcome", {
                  shown: formatNumber(appliedReport.changedDays.length),
                  total: formatNumber(appliedReport.totals.daysChanged),
                })}
              </Notice>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ── The enumerated rows ─────────────────────────────────────────────── */}
      <div className="mt-4">
        <StateBoundary
          loading={previewed && preview.isPending}
          error={preview.error}
          onRetry={() => void preview.refetch()}
          isEmpty={!previewed || rows.length === 0}
          empty={
            <EmptyState
              icon={ListChecks}
              title={
                previewed ? t("admin.bulk.empty.noneTitle") : t("admin.bulk.empty.notYetTitle")
              }
              hint={previewed ? t("admin.bulk.empty.noneHint") : t("admin.bulk.empty.notYetHint")}
            />
          }
          partialError={scopeCount.error ?? labels.error ?? undefined}
          partialLabel={t("admin.bulk.partial")}
          skeletonRows={6}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={50}
            emptyState={
              <EmptyState
                icon={ListChecks}
                title={t("admin.bulk.empty.noneTitle")}
                hint={t("admin.bulk.empty.noneHint")}
              />
            }
          />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-3">
        <Notice tone="info">{t("admin.bulk.footnote")}</Notice>
        <Notice tone="warning">{t("admin.bulk.gapNote")}</Notice>
      </div>
    </div>
  );
}
