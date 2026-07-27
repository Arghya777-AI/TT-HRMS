/**
 * §2 · /admin/people/:code/attendance — one employee, one IST month: every
 * computed day, every scan pair, and the exceptions the engine flagged.
 *
 * This is the per-person view of the same engine output as /admin/attendance/days,
 * read through the same api module and the same summary function, so the two
 * screens cannot disagree:
 *
 *  1. THE STRIP IS `f_attendance_period_summary`, ONE ROW. Present, half, absent,
 *     pending, weekly off, holiday, leave, comp-off, paid days, working days, late
 *     days and minutes, early exits, overtime, worked minutes, the two averages
 *     and the two percentages are all columns of that function. Not one of them is
 *     added up here — including `paid_days`, which is a numeric the payroll engine
 *     also reads, and `attendance_pct`, which `fn_late_pct`'s sibling already
 *     clamped to [0,100] server-side.
 *  2. PENDING DAYS ARE NOT ABSENTS. The function counts days the engine has not
 *     processed separately, and this page keeps them separate — folding them into
 *     absents is the phantom-absent defect (DR-30), and for a venue whose guard
 *     operates one camera it would slander someone who was at work.
 *  3. THE DAY GRID IS KEYSET-PAGED AND SERVER-COUNTED. The total is a
 *     `count=exact` over the grid's own predicate; the status chips are that same
 *     predicate plus one status. `rows.length` is never a figure.
 *  4. THE FIRST SCAN IS ARRIVAL, THE LAST IS DEPARTURE, and `first_in_hm` /
 *     `last_out_hm` are pre-rendered IST wall clocks from
 *     `v_attendance_day_enriched` — never re-derived from an instant here.
 *
 * The month stepper cannot walk below the joining month: there is no attendance
 * before someone joined, and an empty grid for a month they had not started reads
 * as an outage rather than as a fact.
 *
 * @route /admin/people/:code/attendance
 */
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, Clock, Lock, ScanFace, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatDays, formatNumber, formatPercent } from "@/lib/format";
import {
  fmtCivilDate,
  fmtCivilDateWeekday,
  fmtDateTime,
  fmtDurationHm,
  fmtMonthLong,
  fmtTime,
  isIstMonthKey,
  istMonthOfDate,
  istMonthRange,
  nowIstMonth,
} from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { MonthStepper } from "../components/MonthStepper";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { useAdminEmployee } from "../hooks/usePeople";
import {
  DAY_RECORDS_PAGE_SIZE,
  flattenDayRecords,
  useDayDetail,
  useDayRecords,
  useDayRecordsCount,
  useDayStatusCounts,
} from "../hooks/useAttendanceRecords";
import { useEmployeeMonthSummary } from "../hooks/usePeopleLifecycle";
import {
  SINGLE_PUNCH_FLAG,
  attendanceStatusValues,
  type AttendanceStatus,
  type DayFilters,
  type DayRow,
  type PeriodSummary,
} from "../api/attendance.api";

/**
 * `public.attendance_status` → label + tone, exhaustive over the deployed enum so
 * no raw value can reach the screen (D-10). `absent` and `suspended` are danger
 * tones: an "Absent" badge in a calm colour was a reference-product defect (DR-45).
 */
const STATUS_CHIP: Readonly<Record<AttendanceStatus, StatusChipEntry>> = {
  present: { label: t("admin.days.status.present"), tone: "success" },
  half_day: { label: t("admin.days.status.halfDay"), tone: "warn" },
  absent: { label: t("admin.days.status.absent"), tone: "danger" },
  weekly_off: { label: t("admin.days.status.weeklyOff"), tone: "neutral" },
  holiday: { label: t("admin.days.status.holiday"), tone: "neutral" },
  on_leave: { label: t("admin.days.status.onLeave"), tone: "info" },
  on_leave_half: { label: t("admin.days.status.onLeaveHalf"), tone: "info" },
  weekly_off_worked: { label: t("admin.days.status.weeklyOffWorked"), tone: "success" },
  holiday_worked: { label: t("admin.days.status.holidayWorked"), tone: "success" },
  comp_off_availed: { label: t("admin.days.status.compOffAvailed"), tone: "info" },
  on_duty: { label: t("admin.days.status.onDuty"), tone: "info" },
  work_from_home: { label: t("admin.days.status.workFromHome"), tone: "info" },
  suspended: { label: t("admin.days.status.suspended"), tone: "danger" },
  not_yet_joined: { label: t("admin.days.status.notYetJoined"), tone: "neutral" },
  post_exit: { label: t("admin.days.status.postExit"), tone: "neutral" },
  pending: { label: t("admin.days.status.pending"), tone: "info" },
};

/**
 * The scope while the employee record is still loading: a syntactically valid uuid
 * that matches no row. Passing an EMPTY id list would drop the employee predicate
 * entirely and read every employee's days for the month — a scoped screen must
 * never widen its own scope, not even for one render.
 */
const NO_EMPLOYEE = "00000000-0000-0000-0000-000000000000";

function isAttendanceStatus(value: string | null): value is AttendanceStatus {
  return value !== null && attendanceStatusValues.some((s) => s === value);
}

export default function EmployeeAttendancePage() {
  const { code = "" } = useParams<{ code: string }>();
  const [params, setParams] = useSearchParams();

  const employee = useAdminEmployee(code);
  const employeeId = employee.data?.id ?? null;

  const monthParam = params.get("m");
  const month = monthParam !== null && isIstMonthKey(monthParam) ? monthParam : nowIstMonth();
  const statusParam = params.get("status");
  const status: AttendanceStatus | "" = isAttendanceStatus(statusParam) ? statusParam : "";
  const onlyExceptions = params.get("exceptions") === "true";
  const openDate = params.get("d");

  const range = useMemo(() => istMonthRange(month), [month]);

  const filters = useMemo<DayFilters>(
    () => ({
      from: range.from,
      to: range.to,
      employeeIds: [employeeId ?? NO_EMPLOYEE],
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(onlyExceptions ? { onlyExceptions: true } : {}),
    }),
    [range, employeeId, status, onlyExceptions],
  );

  // The breakdown is deliberately NOT narrowed by the selected status: a chip must
  // keep stating the size of its own slice of the month while one is chosen.
  const breakdownFilters = useMemo<DayFilters>(
    () => ({
      from: range.from,
      to: range.to,
      employeeIds: [employeeId ?? NO_EMPLOYEE],
      ...(onlyExceptions ? { onlyExceptions: true } : {}),
    }),
    [range, employeeId, onlyExceptions],
  );

  const summary = useEmployeeMonthSummary(employeeId, month);
  const days = useDayRecords(filters);
  const total = useDayRecordsCount(filters);
  const statusCounts = useDayStatusCounts(breakdownFilters, attendanceStatusValues);

  const rows = flattenDayRecords(days.data);
  const person = employee.data ?? null;
  const hasFilter = status !== "" || onlyExceptions;

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    // A day panel from the previous filter set must not survive the change.
    if (name !== "d") next.delete("d");
    setParams(next, { replace: true });
  }

  function setMonth(next: string): void {
    const p = new URLSearchParams(params);
    p.set("m", next);
    p.delete("d");
    setParams(p, { replace: true });
  }

  const columns: DataGridColumn<DayRow>[] = [
    {
      key: "ist_date",
      header: t("admin.pAtt.col.date"),
      width: "12rem",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDateWeekday(r.ist_date)}</span>,
    },
    {
      key: "status",
      header: t("admin.pAtt.col.status"),
      width: "10rem",
      render: (r) => <StatusChip status={r.status} map={STATUS_CHIP} />,
    },
    {
      key: "shift_code",
      header: t("admin.pAtt.col.shift"),
      width: "7rem",
      hideBelow: "md",
      // The bare code, never `shift_display_label`: the DB builds that with a
      // 12-hour clock, which is banned app-wide (DR-53).
      render: (r) => dash(r.shift_code),
    },
    {
      key: "first_in_hm",
      header: t("admin.pAtt.col.firstIn"),
      width: "7rem",
      align: "right",
      render: (r) => <span className="num font-medium">{dash(r.first_in_hm)}</span>,
    },
    {
      key: "last_out_hm",
      header: t("admin.pAtt.col.lastOut"),
      width: "7rem",
      align: "right",
      render: (r) =>
        r.last_out_hm === null && r.anomaly_flags.includes(SINGLE_PUNCH_FLAG) ? (
          <span className="text-xs text-warning">{t("admin.pAtt.noOutScan")}</span>
        ) : (
          <span className="num">{dash(r.last_out_hm)}</span>
        ),
    },
    {
      key: "total_worked_minutes",
      header: t("admin.pAtt.col.worked"),
      width: "7rem",
      align: "right",
      render: (r) => <span className="num">{fmtDurationHm(r.total_worked_minutes)}</span>,
    },
    {
      key: "payable_worked_minutes",
      header: t("admin.pAtt.col.payable"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => <span className="num">{fmtDurationHm(r.payable_worked_minutes)}</span>,
    },
    {
      key: "late_minutes",
      header: t("admin.pAtt.col.lateBy"),
      width: "7rem",
      align: "right",
      hideBelow: "md",
      render: (r) =>
        r.is_late ? (
          <span className="num text-warning">{fmtDurationHm(r.late_minutes)}</span>
        ) : (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ),
    },
    {
      key: "early_exit_minutes",
      header: t("admin.pAtt.col.earlyBy"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.is_early_exit ? (
          <span className="num text-warning">{fmtDurationHm(r.early_exit_minutes)}</span>
        ) : (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ),
    },
    {
      key: "overtime_minutes",
      header: t("admin.pAtt.col.overtime"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.overtime_minutes === 0 ? (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ) : (
          <span className="num">{fmtDurationHm(r.overtime_minutes)}</span>
        ),
    },
    {
      key: "day_fraction_paid",
      header: t("admin.pAtt.col.paidFraction"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => <span className="num">{formatDays(r.day_fraction_paid)}</span>,
    },
    {
      key: "is_locked",
      header: t("admin.pAtt.col.locked"),
      width: "6rem",
      hideBelow: "md",
      render: (r) =>
        r.is_locked ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <Lock className="h-3 w-3" aria-hidden />
            {t("admin.pAtt.lockedYes")}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Clock}
        title={t("admin.pAtt.title")}
        subtitle={
          person === null
            ? t("admin.pAtt.subtitle.plain", { month: fmtMonthLong(month) })
            : t("admin.pAtt.subtitle.person", {
                name: person.display_name,
                code: person.employee_code,
                month: fmtMonthLong(month),
              })
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <MonthStepper
              month={month}
              onChange={setMonth}
              {...(person !== null ? { minMonth: istMonthOfDate(person.date_of_join) } : {})}
            />
            <Button asChild variant="outline" size="sm">
              <Link to={`/admin/people/${encodeURIComponent(code)}`}>
                <ArrowLeft className="mr-2 size-4" aria-hidden />
                {t("admin.pAtt.backToPerson")}
              </Link>
            </Button>
          </div>
        }
      />

      <StateBoundary
        loading={employee.isPending}
        error={employee.error}
        onRetry={() => void employee.refetch()}
        isEmpty={person === null && !employee.isPending && employee.error === null}
        skeletonRows={2}
        empty={
          <EmptyState
            icon={CalendarClock}
            title={t("admin.pAtt.noPerson.title")}
            hint={t("admin.pAtt.noPerson.hint")}
          />
        }
      >
        {person !== null ? (
          <>
            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PersonCell
                  name={person.display_name}
                  code={person.employee_code}
                  secondary={person.designation_name}
                />
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>{dash(person.department_name)}</span>
                  <span>{dash(person.location_name)}</span>
                  <span className="num">
                    {t("admin.pAtt.joined", { date: fmtCivilDate(person.date_of_join) })}
                  </span>
                  <span className="num">{t("admin.pAtt.shift", { code: dash(person.shift_code) })}</span>
                </div>
              </div>
            </div>

            {person.exclude_from_attendance ? (
              <div className="mt-4">
                <Notice tone="warning">{t("admin.pAtt.excluded")}</Notice>
              </div>
            ) : null}

            {person.last_working_day !== null ? (
              <div className="mt-4">
                <Notice tone="info">
                  {t("admin.pAtt.leftOn", { date: fmtCivilDate(person.last_working_day) })}
                </Notice>
              </div>
            ) : null}

            <SummaryStrip
              summary={summary.data ?? null}
              isPending={summary.isPending}
              error={summary.error}
              onRetry={() => void summary.refetch()}
              month={month}
            />

            {/* Total + per-status breakdown, both counted by Postgres. */}
            <div className="mt-4 grid gap-3 lg:grid-cols-4">
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">{t("admin.pAtt.tile.total")}</p>
                <p className="num mt-1 font-display text-2xl font-semibold">
                  {total.isPending
                    ? "…"
                    : total.error !== null
                      ? t("common.empty")
                      : formatNumber(total.data)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t("admin.pAtt.tile.totalHint")}</p>
              </div>
              <div className="rounded-lg border bg-card p-4 lg:col-span-3">
                <p className="text-xs text-muted-foreground">{t("admin.pAtt.tile.breakdown")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {statusCounts
                    .filter((s) => (s.count ?? 0) > 0)
                    .map((s) => {
                      const active = status === s.status;
                      return (
                        <button
                          key={s.status}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setParam("status", active ? "" : s.status)}
                          className={cn(
                            "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active && "ring-2 ring-primary",
                          )}
                        >
                          <span>{STATUS_CHIP[s.status].label}</span>
                          <span className="num font-semibold">{formatNumber(s.count)}</span>
                        </button>
                      );
                    })}
                  {statusCounts.every((s) => !s.isPending && (s.count ?? 0) === 0) ? (
                    <p className="text-xs text-muted-foreground">
                      {t("admin.pAtt.tile.breakdownEmpty")}
                    </p>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={onlyExceptions ? "default" : "outline"}
                    aria-pressed={onlyExceptions}
                    onClick={() => setParam("exceptions", onlyExceptions ? "" : "true")}
                  >
                    {t("admin.pAtt.filter.exceptionsOnly")}
                  </Button>
                  {hasFilter ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMonth(month)}>
                      {t("admin.pAtt.filter.clear")}
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      to={`/admin/attendance/punches?employee=${encodeURIComponent(person.id)}`}
                    >
                      <ScanFace className="mr-2 size-4" aria-hidden />
                      {t("admin.pAtt.openScans")}
                    </Link>
                  </Button>
                </div>
              </div>
            </div>

            {openDate !== null ? (
              <DayPanel
                employeeId={person.id}
                isoDate={openDate}
                onClose={() => setParam("d", "")}
              />
            ) : null}

            <div className="mt-4">
              <StateBoundary
                loading={days.isPending}
                error={days.error}
                onRetry={() => void days.refetch()}
                isEmpty={rows.length === 0}
                partialError={total.error}
                partialLabel={t("admin.pAtt.partial.total")}
                empty={
                  <EmptyState
                    icon={CalendarClock}
                    title={t("admin.pAtt.empty.title")}
                    hint={
                      hasFilter ? t("admin.pAtt.empty.filteredHint") : t("admin.pAtt.empty.hint")
                    }
                    {...(hasFilter
                      ? {
                          action: (
                            <Button variant="outline" onClick={() => setMonth(month)}>
                              {t("admin.pAtt.filter.clear")}
                            </Button>
                          ),
                        }
                      : {})}
                  />
                }
              >
                <DataGrid
                  columns={columns}
                  rows={rows}
                  rowKey={(r) => r.id}
                  pageSize={DAY_RECORDS_PAGE_SIZE}
                  onRowClick={(r) => setParam("d", r.ist_date)}
                />
                {days.hasNextPage ? (
                  <div className="mt-4 flex justify-center">
                    <Button
                      variant="outline"
                      onClick={() => void days.fetchNextPage()}
                      disabled={days.isFetchingNextPage}
                    >
                      {days.isFetchingNextPage
                        ? t("admin.pAtt.loadingMore")
                        : t("admin.pAtt.loadMore")}
                    </Button>
                  </div>
                ) : null}
              </StateBoundary>
            </div>

            <div className="mt-4">
              <Notice tone="info">{t("admin.pAtt.footnote")}</Notice>
            </div>
          </>
        ) : null}
      </StateBoundary>
    </div>
  );
}

/** One labelled server figure. Never blank, never a plausible zero. */
function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num mt-1 font-display text-lg font-semibold">{value}</p>
      {hint === undefined ? null : <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The month strip — every figure a column of `f_attendance_period_summary`.
 *
 * `null` is the honest state for a month with no summary row: for an RLS-protected
 * function "no data" and "not in your scope" look the same at the wire.
 */
function SummaryStrip({
  summary,
  isPending,
  error,
  onRetry,
  month,
}: {
  summary: PeriodSummary | null;
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
  month: string;
}) {
  return (
    <div className="mt-4">
      <h2 className="font-display text-lg font-semibold">
        {t("admin.pAtt.strip.title", { month: fmtMonthLong(month) })}
      </h2>
      <div className="mt-2">
        <StateBoundary
          loading={isPending}
          error={error}
          onRetry={onRetry}
          isEmpty={summary === null}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={CalendarClock}
              title={t("admin.pAtt.strip.empty.title")}
              hint={t("admin.pAtt.strip.empty.hint")}
            />
          }
        >
          {summary !== null ? (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi
                label={t("admin.pAtt.kpi.present")}
                value={formatNumber(summary.present_days)}
                hint={t("admin.pAtt.kpi.presentHint", {
                  working: formatNumber(summary.working_days),
                })}
              />
              <Kpi label={t("admin.pAtt.kpi.half")} value={formatNumber(summary.half_days)} />
              <Kpi label={t("admin.pAtt.kpi.absent")} value={formatNumber(summary.absent_days)} />
              <Kpi
                label={t("admin.pAtt.kpi.pending")}
                value={formatNumber(summary.pending_days)}
                hint={t("admin.pAtt.kpi.pendingHint")}
              />
              <Kpi label={t("admin.pAtt.kpi.leave")} value={formatDays(summary.leave_days)} />
              <Kpi label={t("admin.pAtt.kpi.compOff")} value={formatNumber(summary.comp_off_days)} />
              <Kpi
                label={t("admin.pAtt.kpi.weeklyOff")}
                value={formatNumber(summary.weekly_off_days)}
              />
              <Kpi label={t("admin.pAtt.kpi.holiday")} value={formatNumber(summary.holiday_days)} />
              <Kpi
                label={t("admin.pAtt.kpi.paidDays")}
                value={formatDays(summary.paid_days)}
                hint={t("admin.pAtt.kpi.paidDaysHint", { total: formatNumber(summary.total_days) })}
              />
              <Kpi
                label={t("admin.pAtt.kpi.attendancePct")}
                value={formatPercent(summary.attendance_pct, { clamp: true })}
              />
              <Kpi
                label={t("admin.pAtt.kpi.late")}
                value={formatNumber(summary.late_days)}
                hint={t("admin.pAtt.kpi.lateHint", {
                  duration: fmtDurationHm(summary.late_minutes),
                  pct: formatPercent(summary.late_pct, { clamp: true }),
                })}
              />
              <Kpi
                label={t("admin.pAtt.kpi.earlyExit")}
                value={formatNumber(summary.early_exit_days)}
                hint={t("admin.pAtt.kpi.earlyExitHint", {
                  duration: fmtDurationHm(summary.early_exit_minutes),
                })}
              />
              <Kpi
                label={t("admin.pAtt.kpi.worked")}
                value={fmtDurationHm(summary.total_worked_minutes)}
              />
              <Kpi
                label={t("admin.pAtt.kpi.avgPerPresent")}
                value={fmtDurationHm(summary.avg_worked_minutes_per_present_day)}
                hint={t("admin.pAtt.kpi.avgPerPresentHint")}
              />
              <Kpi
                label={t("admin.pAtt.kpi.overtime")}
                value={fmtDurationHm(summary.overtime_minutes)}
                hint={t("admin.pAtt.kpi.overtimeHint", {
                  approved: fmtDurationHm(summary.approved_overtime_minutes),
                })}
              />
              <Kpi
                label={t("admin.pAtt.kpi.breaks")}
                value={fmtDurationHm(summary.break_minutes)}
                hint={t("admin.pAtt.kpi.breaksHint", { count: formatNumber(summary.break_count) })}
              />
              <Kpi
                label={t("admin.pAtt.kpi.extraWork")}
                value={fmtDurationHm(summary.extra_work_minutes)}
              />
              <Kpi
                label={t("admin.pAtt.kpi.lateDeduction")}
                value={formatDays(summary.late_deduction_leave_days)}
                hint={t("admin.pAtt.kpi.lateDeductionHint")}
              />
            </div>
          ) : null}
        </StateBoundary>
      </div>
    </div>
  );
}

/**
 * One day, read again by (employee, date) so a deep link works without the grid.
 * The single-scan case is spelled out in words because it is THE case at this
 * venue: one camera at the gate, and someone who walked out past a queue.
 */
function DayPanel({
  employeeId,
  isoDate,
  onClose,
}: {
  employeeId: string;
  isoDate: string;
  onClose: () => void;
}) {
  const day = useDayDetail(employeeId, isoDate);
  const row = day.data ?? null;
  const singleScan = row !== null && row.anomaly_flags.includes(SINGLE_PUNCH_FLAG);

  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">{t("admin.pAtt.detail.title")}</h2>
          <p className="num text-sm text-muted-foreground">{fmtCivilDateWeekday(isoDate)}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="mr-1 size-4" aria-hidden />
          {t("admin.pAtt.detail.close")}
        </Button>
      </div>

      <div className="mt-3">
        <StateBoundary
          loading={day.isPending}
          error={day.error}
          onRetry={() => void day.refetch()}
          isEmpty={row === null}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={CalendarClock}
              title={t("admin.pAtt.detail.empty.title")}
              hint={t("admin.pAtt.detail.empty.hint")}
            />
          }
        >
          {row !== null ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <StatusChip status={row.status} map={STATUS_CHIP} />
                {row.is_locked ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" aria-hidden />
                    {t("admin.pAtt.detail.lockedChip")}
                  </span>
                ) : null}
              </div>

              {singleScan ? (
                <div className="mt-3">
                  <Notice tone="warning">
                    {t("admin.pAtt.detail.singleScan", {
                      status: STATUS_CHIP[row.status].label,
                      paid: formatDays(row.day_fraction_paid),
                      time: dash(row.first_in_hm),
                    })}
                  </Notice>
                </div>
              ) : null}

              {row.manual_override_status || row.manual_override_times ? (
                <div className="mt-3">
                  <Notice tone="warning">
                    {t("admin.pAtt.detail.override", { reason: dash(row.manual_override_reason) })}
                  </Notice>
                </div>
              ) : null}

              {row.is_regularized ? (
                <div className="mt-3">
                  <Notice tone="info">{t("admin.pAtt.detail.regularized")}</Notice>
                </div>
              ) : null}

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                <Fact label={t("admin.pAtt.col.shift")} value={dash(row.shift_code)} />
                <Fact
                  label={t("admin.pAtt.detail.shiftWindow")}
                  value={
                    row.shift_start_at === null || row.shift_end_at === null
                      ? t("common.empty")
                      : `${fmtTime(row.shift_start_at)} – ${fmtTime(row.shift_end_at)}`
                  }
                />
                <Fact label={t("admin.pAtt.col.firstIn")} value={dash(row.first_in_hm)} />
                <Fact
                  label={t("admin.pAtt.col.lastOut")}
                  value={singleScan ? t("admin.pAtt.noOutScan") : dash(row.last_out_hm)}
                />
                <Fact label={t("admin.pAtt.detail.scans")} value={formatNumber(row.punch_count)} />
                <Fact
                  label={t("admin.pAtt.detail.grossSpan")}
                  value={fmtDurationHm(row.gross_span_minutes)}
                />
                <Fact
                  label={t("admin.pAtt.detail.breaks")}
                  value={t("admin.pAtt.detail.breaksValue", {
                    duration: fmtDurationHm(row.break_minutes),
                    count: formatNumber(row.break_count),
                  })}
                />
                <Fact
                  label={t("admin.pAtt.col.worked")}
                  value={fmtDurationHm(row.total_worked_minutes)}
                />
                <Fact
                  label={t("admin.pAtt.col.payable")}
                  value={fmtDurationHm(row.payable_worked_minutes)}
                />
                <Fact
                  label={t("admin.pAtt.col.lateBy")}
                  value={row.is_late ? fmtDurationHm(row.late_minutes) : t("common.empty")}
                />
                <Fact
                  label={t("admin.pAtt.col.earlyBy")}
                  value={
                    row.is_early_exit ? fmtDurationHm(row.early_exit_minutes) : t("common.empty")
                  }
                />
                <Fact
                  label={t("admin.pAtt.col.overtime")}
                  value={fmtDurationHm(row.overtime_minutes)}
                />
                <Fact
                  label={t("admin.pAtt.detail.otApproved")}
                  value={fmtDurationHm(row.approved_overtime_minutes)}
                />
                <Fact
                  label={t("admin.pAtt.col.paidFraction")}
                  value={formatDays(row.day_fraction_paid)}
                />
                <Fact label={t("admin.pAtt.detail.holiday")} value={dash(row.holiday_name)} />
                <Fact label={t("admin.pAtt.detail.leaveType")} value={dash(row.leave_type_name)} />
                <Fact
                  label={t("admin.pAtt.detail.statusSource")}
                  value={dash(row.status_source)}
                />
                <Fact
                  label={t("admin.pAtt.detail.computedAt")}
                  value={row.computed_at === null ? t("common.empty") : fmtDateTime(row.computed_at)}
                />
              </dl>

              {row.anomaly_flags.length > 0 ? (
                <div className="mt-4">
                  <p className="text-xs text-muted-foreground">{t("admin.pAtt.detail.flags")}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {row.anomaly_flags.map((f) => (
                      <StatusChip key={f} status={f} />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to={`/admin/attendance/punches?date=${row.ist_date}`}>
                    <ScanFace className="mr-2 size-4" aria-hidden />
                    {t("admin.pAtt.detail.openScans")}
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/admin/attendance/days?date=${row.ist_date}`}>
                    {t("admin.pAtt.detail.openDayRecords")}
                  </Link>
                </Button>
              </div>
            </>
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}

/** One labelled server value inside the day panel. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num truncate text-sm">{value}</dd>
    </div>
  );
}
