/**
 * §4 · /admin/attendance/recompute — Recompute Console. Re-run the attendance
 * engine over a scope, in two deliberate steps.
 *
 * This is the most dangerous screen in the product: `attendance_days` is what
 * payroll pays on, and this is the only sanctioned way to change what a day
 * means. So it is built as two separate acts, not one button:
 *
 *   STEP 1 · DRY RUN. `attendance-recompute` computes every cell in scope inside
 *     a transaction it then ROLLS BACK, and answers with the per-day diff. Not a
 *     day row, not a comp-off credit, not an audit row is written. The engine
 *     itself produces the prediction — a dry run that guessed the answer in
 *     TypeScript would be a second engine, and the two would drift.
 *   STEP 2 · COMMIT. The SAME scope, applied for real, with a reason the operator
 *     types (≥15 characters, D-21). Commit is DISABLED until a dry run for the
 *     scope currently in the form has come back, and it re-disables the moment
 *     any field of the scope changes: a review of yesterday's range is not a
 *     review of today's.
 *
 * Three refusals worth stating out loud:
 *  - A LOCKED PERIOD IS NEVER SILENTLY SKIPPED. `totals.daysSkippedLocked` is
 *    surfaced as a warning on both steps, with the number of employee-days a
 *    lock removed from scope and a link to the screen that can release it.
 *  - A PARTIAL DRY RUN DOES NOT UNLOCK COMMIT. The function stops at a 45-second
 *    work budget and answers `partial: true`; that report describes part of the
 *    scope, so it has not been reviewed. Narrow the scope instead.
 *  - NO ARITHMETIC. Every number on this page is a field of `totals` or a
 *    fingerprint value formatted for display. The page never counts rows.
 *
 * @route /admin/attendance/recompute
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Cog, ListChecks, Lock, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import {
  addIstDays,
  civilDayOffset,
  compareCivilDates,
  fmtCivilDate,
  fmtCivilDateWeekday,
  nowIstDate,
} from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField } from "../components/Field";
import { DayDiffLines } from "../components/DayDiffLines";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  recomputeScopeSignature,
  useRecomputeCommit,
  useRecomputeDryRun,
  useResolvedScope,
  useScopeDepartmentOptions,
  type DayDiff,
  type RecomputeReport,
  type RecomputeScope,
  type ScopeKind,
} from "../hooks/useAttendanceControls";

/** `MAX_RANGE_DAYS` in `supabase/functions/attendance-recompute/index.ts`. */
const MAX_RANGE_DAYS = 186;

function isScopeKind(value: string | null): value is ScopeKind {
  return value === "everyone" || value === "employee" || value === "department";
}

function scopeKindOptions(): { value: ScopeKind; label: string }[] {
  return [
    { value: "everyone", label: t("admin.recompute.scope.everyone") },
    { value: "employee", label: t("admin.recompute.scope.oneEmployee") },
    { value: "department", label: t("admin.recompute.scope.oneDepartment") },
  ];
}

/** A numbered step frame, so the order of the two acts is visible, not implied. */
function Step({
  index,
  title,
  hint,
  children,
}: {
  index: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <span
          className="num mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
          aria-hidden
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold leading-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

function TotalCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn" | "danger";
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "num mt-1 font-display text-xl font-semibold",
          tone === "warn" && value > 0 && "text-warning",
          tone === "danger" && value > 0 && "text-destructive",
        )}
      >
        {formatNumber(value)}
      </p>
    </div>
  );
}

/**
 * The report of one run. Identical renderer for the dry run and the commit, so
 * "what would change" and "what changed" cannot be presented differently.
 */
function ReportCard({
  report,
  nameFor,
}: {
  report: RecomputeReport;
  nameFor: (employeeId: string) => { name: string | null; code: string | null };
}) {
  const committed = report.committed;
  const totals = report.totals;

  const columns: DataGridColumn<DayDiff>[] = [
    {
      key: "employee",
      header: t("admin.recompute.col.employee"),
      width: "14rem",
      render: (row) => {
        const label = nameFor(row.employeeId);
        return <PersonCell name={label.name} code={row.employeeCode ?? label.code} />;
      },
    },
    {
      key: "istDate",
      header: t("admin.recompute.col.date"),
      width: "12rem",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDateWeekday(row.istDate)}</span>,
    },
    {
      key: "changes",
      header: committed
        ? t("admin.recompute.col.changed")
        : t("admin.recompute.col.wouldChange"),
      render: (row) => <DayDiffLines diff={row} />,
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("admin.recompute.report.scope", {
          from: fmtCivilDate(report.scope.from),
          to: fmtCivilDate(report.scope.to),
          days: formatNumber(report.scope.days),
          employees: formatNumber(report.scope.employeeCount),
        })}
      </p>

      {report.scope.requestedTo !== report.scope.to ? (
        <Notice tone="info">
          {t("admin.recompute.report.clamped", {
            requested: fmtCivilDate(report.scope.requestedTo),
            used: fmtCivilDate(report.scope.to),
          })}
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <TotalCell label={t("admin.recompute.total.cells")} value={totals.cellsTargeted} />
        <TotalCell
          label={
            committed ? t("admin.recompute.total.changed") : t("admin.recompute.total.wouldChange")
          }
          value={totals.daysChanged}
        />
        <TotalCell label={t("admin.recompute.total.unchanged")} value={totals.daysUnchanged} />
        <TotalCell label={t("admin.recompute.total.noRow")} value={totals.daysNoRow} />
        <TotalCell
          label={t("admin.recompute.total.skippedLocked")}
          value={totals.daysSkippedLocked}
          tone="warn"
        />
        <TotalCell label={t("admin.recompute.total.errors")} value={totals.errors} tone="danger" />
      </div>

      {/* A lock is never allowed to disappear into a total nobody reads. */}
      {totals.daysSkippedLocked > 0 ? (
        <Notice
          tone="warning"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/attendance/locks">{t("admin.recompute.report.openLocks")}</Link>
            </Button>
          }
        >
          {report.scope.overrideLock
            ? t("admin.recompute.report.lockedDespiteOverride", {
                n: formatNumber(totals.daysSkippedLocked),
              })
            : t("admin.recompute.report.lockedSkipped", {
                n: formatNumber(totals.daysSkippedLocked),
              })}
        </Notice>
      ) : null}

      {report.scope.overrideLock ? (
        <Notice tone="warning">{t("admin.recompute.report.overrideUsed")}</Notice>
      ) : null}

      {report.partial ? (
        <Notice tone="warning">
          {t("admin.recompute.report.partial", {
            done: formatNumber(report.scope.employeesProcessed),
            total: formatNumber(report.scope.employeeCount),
          })}
        </Notice>
      ) : null}

      {report.scope.unresolvedEmployeeIds.length > 0 ? (
        <Notice tone="warning">
          {t("admin.recompute.report.unresolved", {
            n: formatNumber(report.scope.unresolvedEmployeeIds.length),
          })}
        </Notice>
      ) : null}

      {report.changedDaysTruncated ? (
        <Notice tone="warning">
          {t("admin.recompute.report.truncated", {
            shown: formatNumber(report.changedDays.length),
            total: formatNumber(totals.daysChanged),
          })}
        </Notice>
      ) : null}

      {report.errors.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium">{t("admin.recompute.report.errorsTitle")}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {report.errors.map((cell, index) => {
              const label = nameFor(cell.employeeId);
              return (
                <li key={`${cell.employeeId}-${cell.istDate ?? "range"}-${index}`}>
                  <span className="num">{fmtCivilDate(cell.istDate)}</span>{" "}
                  <span className="font-medium">{label.name ?? label.code ?? cell.employeeId}</span>
                  {" — "}
                  {cell.message}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {committed && report.runIds.length > 0 ? (
        <Notice tone="success">
          {t("admin.recompute.report.runIds", { n: formatNumber(report.runIds.length) })}
        </Notice>
      ) : null}

      {report.changedDays.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={
            committed
              ? t("admin.recompute.report.noneChangedTitle")
              : t("admin.recompute.report.noneWouldChangeTitle")
          }
          hint={t("admin.recompute.report.noneHint")}
        />
      ) : (
        <DataGrid
          columns={columns}
          rows={report.changedDays}
          rowKey={(row) => `${row.employeeId}|${row.istDate}`}
          pageSize={25}
        />
      )}
    </div>
  );
}

export default function RecomputeConsolePage() {
  const [params, setParams] = useSearchParams();
  const { user, can } = useAuth();
  const profileId = user?.id ?? null;
  const isSuper = can("admin.super");
  const today = nowIstDate();

  const rawKind = params.get("kind");
  const kind: ScopeKind = isScopeKind(rawKind) ? rawKind : "everyone";
  const from = params.get("from") ?? addIstDays(today, -6);
  const to = params.get("to") ?? today;
  const employeeId = params.get("emp") ?? "";
  const departmentName = params.get("dept") ?? "";
  const overrideLock = params.get("override") === "1" && isSuper;

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const departmentChoices = useScopeDepartmentOptions(labels.data);
  const resolved = useResolvedScope(kind, employeeId, departmentName, labels.data);

  const nameFor = (id: string): { name: string | null; code: string | null } => {
    const label = labels.data?.get(id);
    return { name: label?.name ?? null, code: label?.code ?? null };
  };

  const scope = useMemo<RecomputeScope>(
    () => ({ from, to, employeeIds: resolved.employeeIds, overrideLock }),
    [from, to, resolved.employeeIds, overrideLock],
  );
  const signature = recomputeScopeSignature(scope);

  /** The dry run currently on screen, with the scope it was produced for. */
  const [seen, setSeen] = useState<{ signature: string; report: RecomputeReport } | null>(null);
  const [committed, setCommitted] = useState<RecomputeReport | null>(null);

  const dryRun = useRecomputeDryRun(t("admin.recompute.dryRunReason"));
  const commit = useRecomputeCommit((report) => setCommitted(report));

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
    // Any change of scope invalidates the review, and therefore the commit.
    setSeen(null);
    setCommitted(null);
  }

  // ── Scope validation, all of it calendar facts ──────────────────────────────
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

  const canRun = rangeError === null && scopeError === null;
  const reviewed = seen !== null && seen.signature === signature;
  const staleReview = seen !== null && seen.signature !== signature;

  const commitBlockedReason: string | null = !canRun
    ? t("admin.recompute.commit.blocked.invalid")
    : profileId === null
      ? t("admin.recompute.commit.blocked.noSession")
      : !reviewed
        ? t("admin.recompute.commit.blocked.noDryRun")
        : seen.report.partial
          ? t("admin.recompute.commit.blocked.partial")
          : null;

  const scopeSentence =
    kind === "everyone"
      ? t("admin.recompute.commit.scopeEveryone")
      : kind === "employee"
        ? t("admin.recompute.commit.scopeEmployee", {
            name: nameFor(employeeId).name ?? employeeId,
          })
        : t("admin.recompute.commit.scopeDepartment", {
            department: departmentName,
            n: formatNumber(resolved.resolvedCount ?? 0),
          });

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("admin.recompute.title")}
        subtitle={t("admin.recompute.subtitle")}
      />

      <Notice tone="info" className="mt-4">
        {t("admin.recompute.intro")}
      </Notice>

      {/* ── STEP 1 · Scope ──────────────────────────────────────────────────── */}
      <Step
        index={1}
        title={t("admin.recompute.step1.title")}
        hint={t("admin.recompute.step1.hint")}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            hint={t("admin.recompute.step1.toHint")}
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
              {...(resolved.resolvedCount !== null
                ? {
                    hint: t("admin.recompute.scope.resolved", {
                      n: formatNumber(resolved.resolvedCount),
                    }),
                  }
                : {})}
              {...(scopeError !== null ? { error: scopeError } : {})}
            />
          ) : null}
        </div>

        {/* No shadcn checkbox atom exists in this repo — native input, as
            MasterFormSheet does. Gated on admin.super because the capability
            behind it (`attendance.lock.override`) is. */}
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={overrideLock}
            disabled={!isSuper}
            onChange={(event) => setParam("override", event.target.checked ? "1" : "")}
            className="mt-0.5 h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span>
            <span className="font-medium">{t("admin.recompute.override.label")}</span>
            <span className="block text-xs text-muted-foreground">
              {isSuper
                ? t("admin.recompute.override.hint")
                : t("admin.recompute.override.notSuper")}
            </span>
          </span>
        </label>

        {kind === "everyone" ? (
          <Notice tone="info" className="mt-4">
            {t("admin.recompute.scope.everyoneNote")}
          </Notice>
        ) : null}
        {kind === "department" ? (
          <Notice tone="info" className="mt-4">
            {t("admin.recompute.scope.departmentNote")}
          </Notice>
        ) : null}
      </Step>

      {/* ── STEP 2 · Dry run ────────────────────────────────────────────────── */}
      <Step
        index={2}
        title={t("admin.recompute.step2.title")}
        hint={t("admin.recompute.step2.hint")}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              setCommitted(null);
              const target = signature;
              dryRun.mutate(
                { input: scope },
                { onSuccess: (report) => setSeen({ signature: target, report }) },
              );
            }}
            disabled={!canRun || dryRun.isPending}
          >
            <PlayCircle className="mr-2 size-4" aria-hidden />
            {dryRun.isPending
              ? t("admin.recompute.step2.running")
              : t("admin.recompute.step2.run")}
          </Button>
          {staleReview ? (
            <span className="text-sm text-warning">{t("admin.recompute.step2.stale")}</span>
          ) : null}
        </div>

        {dryRun.userMessage !== null ? (
          <Notice tone="error" className="mt-4">
            {dryRun.userMessage}
          </Notice>
        ) : null}

        <div className="mt-4">
          <StateBoundary
            loading={dryRun.isPending}
            isEmpty={!reviewed}
            empty={
              <EmptyState
                icon={ListChecks}
                title={t("admin.recompute.step2.empty.title")}
                hint={t("admin.recompute.step2.empty.hint")}
              />
            }
            partialError={labels.error ?? undefined}
            partialLabel={t("admin.common.partial.names")}
            skeletonRows={4}
          >
            {reviewed ? <ReportCard report={seen.report} nameFor={nameFor} /> : null}
          </StateBoundary>
        </div>
      </Step>

      {/* ── STEP 3 · Commit ─────────────────────────────────────────────────── */}
      <Step
        index={3}
        title={t("admin.recompute.step3.title")}
        hint={t("admin.recompute.step3.hint")}
      >
        {commitBlockedReason !== null ? (
          <Notice tone="warning" className="mb-4">
            {commitBlockedReason}
          </Notice>
        ) : (
          <Notice tone="warning" className="mb-4">
            {t("admin.recompute.step3.ready", {
              days: formatNumber(seen?.report.totals.daysChanged ?? 0),
              from: fmtCivilDate(from),
              to: fmtCivilDate(to),
            })}
          </Notice>
        )}

        <ReasonActionButton
          label={t("admin.recompute.step3.commit")}
          title={t("admin.recompute.step3.dialogTitle")}
          description={t("admin.recompute.step3.dialogDescription", {
            days: formatNumber(seen?.report.totals.daysChanged ?? 0),
            from: fmtCivilDate(from),
            to: fmtCivilDate(to),
            scope: scopeSentence,
          })}
          confirmLabel={t("admin.recompute.step3.confirm")}
          minLength={SENSITIVE_REASON_LENGTH}
          variant="destructive"
          size="default"
          disabled={commitBlockedReason !== null || commit.isPending}
          {...(commitBlockedReason !== null ? { disabledHint: commitBlockedReason } : {})}
          onConfirm={(reason) => commit.saveAsync(scope, reason)}
        />

        {committed !== null ? (
          <div className="mt-4">
            <Notice tone="success" className="mb-4">
              {t("admin.recompute.step3.done", {
                days: formatNumber(committed.totals.daysChanged),
              })}
            </Notice>
            <ReportCard report={committed} nameFor={nameFor} />
          </div>
        ) : null}
      </Step>

      <div className="mt-4 space-y-3">
        <Notice tone="info">{t("admin.recompute.footnote")}</Notice>
        <Notice tone="warning">
          <span className="flex flex-wrap items-baseline gap-1">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("admin.recompute.gapNote")}
          </span>
        </Notice>
      </div>
    </div>
  );
}
