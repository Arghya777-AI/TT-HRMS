/**
 * §4 · /admin/attendance/exceptions — Exception Dashboard: everything the
 * attendance engine could not settle on its own, grouped by kind, newest first.
 *
 * THE SIGNATURE CASE IS FIRST, AND IT IS EXPLAINED. One camera at the gate means
 * the commonest failure is a single scan: someone scans on the way in and walks
 * out past a queue. The engine's rule is stated in migration 018 and is worth
 * saying in words on the screen, because an admin's next action depends on it —
 * with one scan the day keeps its arrival, gets NO departure, records no worked
 * time, and takes the status the employee's attendance policy prescribes for a
 * single punch (seeded `AP-OPS`: half day, flagged for review).
 *
 * Four rules held here:
 *
 *  1. THE SINGLE-SCAN LIST IS A SERVER PREDICATE, NOT A TEXT MATCH.
 *     `anomaly_flags @> {single_punch_only}` over `v_attendance_day_enriched`
 *     (`DayFilters.anomalyFlags`) — so the headline count, the list under it and
 *     the engine cannot disagree. `v_exception_queue` exposes those flags only
 *     inside a prose sentence, and sniffing that string would be a guess.
 *  2. EVERY COUNT IS POSTGRES'S. One `count=exact` per kind, carrying whatever
 *     severity/date filter is in force — the same predicate the list uses. The
 *     queue read is capped at 200 rows, so `rows.length` would plateau at 200
 *     and a growing problem would look stable.
 *  3. NO RAW SERVER SENTENCE REACHES THE SCREEN. `v_exception_queue.description`
 *     is built for a log, not a UI: it embeds internal tokens
 *     ('Anomalies: single_punch_only'), source enums ('(kiosk_face)'), decimal
 *     hours ('overdue by 5.5 h'), rupees as a bare float and 'DD Mon' dates —
 *     every one of which this product bans (DR-14/21/53). Each row therefore
 *     states, in the catalogue's own English, what that KIND means and where it
 *     is fixed. Nothing is invented: the facts shown (who, which business date,
 *     when it was recorded, severity) are the view's own columns.
 *  4. THE QUEUE IS UNDATED BY DEFAULT. It is a list of things that are wrong
 *     NOW and it self-clears when they are fixed. `ist_date` means a different
 *     thing per branch (a punch's business date, a document's expiry, today for
 *     an offline gate), so a date filter is offered and explained rather than
 *     imposed.
 *
 * @route /admin/attendance/exceptions
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ScanFace, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import {
  addIstDays,
  fmtCivilDate,
  fmtCivilDateWeekday,
  fmtDateTime,
  fmtDurationHm,
  nowIstDate,
} from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels, type EmployeeLabelMap } from "../hooks/useEmployeeLabels";
import {
  useExceptionCount,
  useExceptionKindCounts,
  useExceptionQueue,
  useSingleScanCount,
  useSingleScanDays,
} from "../hooks/useAttendanceRecords";
import {
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  alertRowKey,
  type ExceptionRow,
} from "../api/command.api";
import { SEVERITY_CHIP, alertKindLabel, alertKindOptions, alertRoute } from "../command-vocab";
import type { AttendanceStatus, DayRow, ExceptionFilters } from "../api/attendance.api";

/** Lookback presets for the single-scan list — civil-date arithmetic, not a metric. */
const WINDOWS = [7, 30, 90] as const;
const DEFAULT_WINDOW = 30;

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What each kind MEANS, in the catalogue's English. This replaces the view's
 * `description`, which cannot be shown (see rule 3 in the header).
 */
const KIND_MEANING: Readonly<Record<string, MessageKey>> = {
  punch_needs_review: "admin.exceptions.meaning.punchNeedsReview",
  attendance_anomaly: "admin.exceptions.meaning.attendanceAnomaly",
  unapproved_overtime: "admin.exceptions.meaning.unapprovedOvertime",
  missing_bank_account: "admin.exceptions.meaning.missingBankAccount",
  document_expired: "admin.exceptions.meaning.documentExpired",
  sla_breach: "admin.exceptions.meaning.slaBreach",
  kiosk_offline: "admin.exceptions.meaning.kioskOffline",
  negative_net_pay: "admin.exceptions.meaning.negativeNetPay",
};

function kindMeaning(kind: string): string {
  const key = KIND_MEANING[kind];
  return key === undefined ? t("admin.exceptions.meaning.unknown") : t(key);
}

/** Day statuses a single-scan day can land on, per `single_punch_treatment`. */
const SINGLE_SCAN_STATUS: Readonly<Record<string, StatusChipEntry>> = {
  present: { label: t("admin.days.status.present"), tone: "success" },
  half_day: { label: t("admin.days.status.halfDay"), tone: "warn" },
  absent: { label: t("admin.days.status.absent"), tone: "danger" },
};

function asKnown(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : "";
}

/**
 * Where a row is fixed. Attendance-day rows go to THIS product's day detail
 * (which opens the exact employee-day), everything else uses the shared
 * `alertRoute` map so a kind can never be a dead end.
 */
function rowRoute(row: ExceptionRow, employeeCode: string | null): string {
  if (row.entity_table === "attendance_days" && row.employee_id !== null && row.ist_date !== null) {
    const p = new URLSearchParams({
      date: row.ist_date,
      openEmployee: row.employee_id,
      openDate: row.ist_date,
    });
    return `/admin/attendance/days?${p.toString()}`;
  }
  return alertRoute(row, employeeCode);
}

function dayRoute(row: DayRow): string {
  const p = new URLSearchParams({
    date: row.ist_date,
    openEmployee: row.employee_id,
    openDate: row.ist_date,
  });
  return `/admin/attendance/days?${p.toString()}`;
}

export default function AttendanceExceptionsPage() {
  const [params, setParams] = useSearchParams();

  const kind = asKnown(params.get("kind"), EXCEPTION_KINDS);
  const severity = asKnown(params.get("severity"), EXCEPTION_SEVERITIES);
  const dateParam = params.get("date");
  const onDate = dateParam !== null && CIVIL_DATE.test(dateParam) ? dateParam : null;
  const windowParam = Number(params.get("window"));
  const lookback = WINDOWS.some((w) => w === windowParam) ? windowParam : DEFAULT_WINDOW;

  const filters = useMemo<ExceptionFilters>(
    () => ({
      ...(kind !== "" ? { kinds: [kind] } : {}),
      ...(severity !== "" ? { severities: [severity] } : {}),
      ...(onDate !== null ? { from: onDate, to: onDate } : {}),
    }),
    [kind, severity, onDate],
  );

  /**
   * The single-scan window. A date deep link pins it to that one business date;
   * otherwise it is the last N IST days ending today — a calendar range built by
   * `addIstDays`, never `Date.now() - n*86400000` in the browser's own zone.
   */
  const scanRange = useMemo(() => {
    if (onDate !== null) return { from: onDate, to: onDate };
    const today = nowIstDate();
    return { from: addIstDays(today, -(lookback - 1)), to: today };
  }, [onDate, lookback]);

  const queue = useExceptionQueue(filters);
  const queueTotal = useExceptionCount(filters);
  const kindCounts = useExceptionKindCounts(
    useMemo<ExceptionFilters>(
      () => ({
        ...(severity !== "" ? { severities: [severity] } : {}),
        ...(onDate !== null ? { from: onDate, to: onDate } : {}),
      }),
      [severity, onDate],
    ),
    EXCEPTION_KINDS,
  );
  const singleScans = useSingleScanDays(scanRange);
  const singleScanTotal = useSingleScanCount(scanRange);
  const labels = useEmployeeLabels();

  const rows = queue.data ?? [];
  const scanRows = singleScans.data?.rows ?? [];
  const hasFilter = kind !== "" || severity !== "" || onDate !== null;

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  function clearFilters(): void {
    setParams(new URLSearchParams(), { replace: true });
  }

  const queueColumns: DataGridColumn<ExceptionRow>[] = [
    {
      key: "exception_kind",
      header: t("admin.exceptions.col.kind"),
      width: "12rem",
      render: (r) => (
        <span className="flex flex-col gap-1">
          <span className="font-medium">{alertKindLabel(r.exception_kind)}</span>
          <StatusChip status={r.severity} map={SEVERITY_CHIP} />
        </span>
      ),
    },
    {
      key: "employee_id",
      header: t("admin.exceptions.col.who"),
      width: "14rem",
      render: (r) => renderWho(r, labels.data),
    },
    {
      key: "ist_date",
      header: t("admin.exceptions.col.businessDate"),
      width: "9rem",
      align: "right",
      render: (r) => <span className="num">{fmtCivilDate(r.ist_date)}</span>,
    },
    {
      key: "occurred_at",
      header: t("admin.exceptions.col.recorded"),
      width: "13rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <span className="num">{fmtDateTime(r.occurred_at)}</span>,
    },
    {
      key: "meaning",
      header: t("admin.exceptions.col.meaning"),
      render: (r) => <span className="text-sm">{kindMeaning(r.exception_kind)}</span>,
    },
    {
      key: "route",
      header: t("admin.exceptions.col.where"),
      width: "9rem",
      render: (r) => (
        <Button asChild variant="outline" size="sm">
          <Link to={rowRoute(r, labels.data?.get(r.employee_id ?? "")?.code ?? null)}>
            {t("admin.exceptions.open")}
          </Link>
        </Button>
      ),
    },
  ];

  const scanColumns: DataGridColumn<DayRow>[] = [
    {
      key: "ist_date",
      header: t("admin.days.col.date"),
      width: "11rem",
      render: (r) => <span className="num">{fmtCivilDateWeekday(r.ist_date)}</span>,
    },
    {
      key: "display_name",
      header: t("admin.days.col.employee"),
      width: "15rem",
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.department_name} />
      ),
    },
    {
      key: "shift_code",
      header: t("admin.days.col.shift"),
      width: "7rem",
      hideBelow: "lg",
      render: (r) => dash(r.shift_code),
    },
    {
      key: "first_in_hm",
      header: t("admin.exceptions.col.theOneScan"),
      width: "8rem",
      align: "right",
      render: (r) => <span className="num font-medium">{dash(r.first_in_hm)}</span>,
    },
    {
      key: "last_out_hm",
      header: t("admin.days.col.lastOut"),
      width: "9rem",
      align: "right",
      render: () => <span className="text-xs text-warning">{t("admin.days.noOutScan")}</span>,
    },
    {
      key: "total_worked_minutes",
      header: t("admin.days.col.worked"),
      width: "7rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <span className="num">{fmtDurationHm(r.total_worked_minutes)}</span>,
    },
    {
      key: "status",
      header: t("admin.exceptions.col.engineVerdict"),
      width: "9rem",
      render: (r) => <StatusChip status={r.status} map={SINGLE_SCAN_STATUS} />,
    },
    {
      key: "route",
      header: t("admin.exceptions.col.where"),
      width: "8rem",
      render: (r) => (
        <Button asChild variant="outline" size="sm">
          <Link to={dayRoute(r)}>{t("admin.exceptions.openDay")}</Link>
        </Button>
      ),
    },
  ];

  const scanRangeLabel =
    scanRange.from === scanRange.to
      ? fmtCivilDateWeekday(scanRange.from)
      : t("admin.exceptions.rangeLabel", {
          from: fmtCivilDate(scanRange.from),
          to: fmtCivilDate(scanRange.to),
        });

  return (
    <div className="container py-6">
      <PageHeader
        icon={TriangleAlert}
        title={t("admin.exceptions.title")}
        subtitle={
          queueTotal.isSuccess
            ? t("admin.exceptions.subtitle", { n: formatNumber(queueTotal.data) })
            : t("admin.exceptions.subtitlePlain")
        }
        actions={
          hasFilter ? (
            <Button variant="ghost" onClick={clearFilters}>
              {t("admin.exceptions.filter.clear")}
            </Button>
          ) : null
        }
      />

      {onDate !== null ? (
        <div className="mb-4">
          <Notice tone="info">
            {t("admin.exceptions.dateNotice", { date: fmtCivilDateWeekday(onDate) })}
          </Notice>
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* The signature case, first and explained.                           */}
      {/* ------------------------------------------------------------------ */}
      <section className="rounded-lg border border-warning/50 bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <ScanFace className="h-5 w-5 text-warning" aria-hidden />
              {t("admin.exceptions.singleScan.title")}
            </h2>
            <p className="num mt-0.5 text-sm text-muted-foreground">{scanRangeLabel}</p>
          </div>
          <div className="text-right">
            <p className="num font-display text-3xl font-semibold">
              {singleScanTotal.isPending
                ? "…"
                : singleScanTotal.error !== null
                  ? t("common.empty")
                  : formatNumber(singleScanTotal.data)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("admin.exceptions.singleScan.countLabel")}
            </p>
          </div>
        </div>

        <div className="mt-3">
          <Notice tone="warning">{t("admin.exceptions.singleScan.explainer")}</Notice>
        </div>

        {onDate === null ? (
          <div className="mt-3 max-w-xs">
            <SelectField
              label={t("admin.exceptions.singleScan.window")}
              value={String(lookback)}
              options={WINDOWS.map((w) => ({
                value: String(w),
                label: t("admin.exceptions.singleScan.windowOption", { n: w }),
              }))}
              onChange={(v) => setParam("window", v)}
            />
          </div>
        ) : null}

        <div className="mt-4">
          <StateBoundary
            loading={singleScans.isPending}
            error={singleScans.error}
            onRetry={() => void singleScans.refetch()}
            isEmpty={scanRows.length === 0}
            partialError={singleScanTotal.error}
            partialLabel={t("admin.exceptions.singleScan.partial")}
            skeletonRows={2}
            empty={
              <EmptyState
                icon={ScanFace}
                title={t("admin.exceptions.singleScan.empty.title")}
                hint={t("admin.exceptions.singleScan.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={scanColumns}
              rows={scanRows}
              rowKey={(r) => r.id}
              pageSize={25}
            />
            {singleScans.data?.hasMore === true ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("admin.exceptions.singleScan.capped", {
                  shown: formatNumber(scanRows.length),
                })}
              </p>
            ) : null}
          </StateBoundary>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Everything else, by kind.                                          */}
      {/* ------------------------------------------------------------------ */}
      <h2 className="mt-8 font-display text-lg font-semibold">
        {t("admin.exceptions.byKind.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("admin.exceptions.byKind.hint")}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kindCounts.map((k) => {
          const active = kind === k.kind;
          const count = k.count ?? 0;
          return (
            <button
              key={k.kind}
              type="button"
              aria-pressed={active}
              onClick={() => setParam("kind", active ? "" : k.kind)}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                k.error === null && count > 0 ? "border-warning/50" : "border-border",
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{alertKindLabel(k.kind)}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {k.isPending
                  ? "…"
                  : k.error !== null
                    ? t("common.empty")
                    : formatNumber(k.count)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.exceptions.filter.kind")}
          value={kind}
          placeholder={t("admin.exceptions.filter.anyKind")}
          options={alertKindOptions(EXCEPTION_KINDS)}
          onChange={(v) => setParam("kind", v)}
        />
        <SelectField
          label={t("admin.exceptions.filter.severity")}
          value={severity}
          placeholder={t("admin.exceptions.filter.anySeverity")}
          options={EXCEPTION_SEVERITIES.map((s) => ({
            value: s,
            label: SEVERITY_CHIP[s]?.label ?? s,
          }))}
          onChange={(v) => setParam("severity", v)}
        />
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {queueTotal.isSuccess
              ? t("admin.exceptions.matching", { n: formatNumber(queueTotal.data) })
              : t("admin.exceptions.matchingUnknown")}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={queue.isPending}
          error={queue.error}
          onRetry={() => void queue.refetch()}
          isEmpty={rows.length === 0}
          partialError={queueTotal.error ?? labels.error}
          partialLabel={t("admin.exceptions.partial.total")}
          empty={
            <EmptyState
              icon={TriangleAlert}
              title={
                hasFilter
                  ? t("admin.exceptions.empty.filtered.title")
                  : t("admin.exceptions.empty.title")
              }
              hint={
                hasFilter
                  ? t("admin.exceptions.empty.filtered.hint")
                  : t("admin.exceptions.empty.hint")
              }
              {...(hasFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearFilters}>
                        {t("admin.exceptions.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        >
          <DataGrid
            columns={queueColumns}
            rows={rows}
            rowKey={(r) => alertRowKey(r)}
            pageSize={50}
          />
          {rows.length >= 200 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("admin.exceptions.capped")}</p>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.exceptions.footnote")}</Notice>
      </div>
    </div>
  );
}

/** The person a row is about — resolved through the console's one id → name map. */
function renderWho(row: ExceptionRow, labels: EmployeeLabelMap | undefined) {
  if (row.employee_id === null) {
    return <span className="text-xs text-muted-foreground">{t("admin.exceptions.noPerson")}</span>;
  }
  const label = labels?.get(row.employee_id);
  if (label === undefined) {
    // An id we cannot resolve is stated as unresolved — never printed as a uuid.
    return <PersonCell name={null} code={null} />;
  }
  return <PersonCell name={label.name} code={label.code} secondary={label.department} />;
}

/** Kept exported-free on purpose: this module's only export is the page. */
export type { AttendanceStatus };
