/**
 * §4 · /admin/attendance/days — Day Records: the computed day, per employee.
 *
 * This is the screen the whole engine exists to produce. One camera at the gate,
 * a guard operating it: the FIRST scan of the IST day becomes arrival, the LAST
 * becomes departure, and the scans in between change neither. Everything else on
 * a row — worked, payable, late by, early by, overtime, the day's status — was
 * decided by `f_recompute_attendance_day` against the shift, the grace period,
 * the unpaid break and the day's leave/holiday context, and is read here as a
 * column of `v_attendance_day_enriched`.
 *
 * Four rules held on this page:
 *
 *  1. NO ARITHMETIC. Not one figure is computed in the browser. Durations are
 *     `fmtDurationHm` applied to the SERVER's minute columns
 *     (`total_worked_minutes`, `payable_worked_minutes`, `late_minutes`,
 *     `early_exit_minutes`, `overtime_minutes`) — one duration format app-wide,
 *     never a decimal hour, and never a client-side subtraction of two clocks.
 *  2. THE TOTAL AND THE BREAKDOWN ARE POSTGRES'S. The header total is a
 *     `count=exact` over the same filter object as the grid; each status chip is
 *     that same predicate plus one status. Counting the loaded rows would make
 *     both depend on how far the admin scrolled (DR-29, the `7 vs 8` defect), and
 *     the grid is keyset-paged precisely because the engine writes underneath it.
 *  3. THE PERIOD AND EVERY FILTER LIVE IN THE URL. `?date=` + `?late=true` and
 *     `?status=absent` are the links the Command Centre already emits
 *     (`command-vocab.ts`), so they are honoured here rather than reinvented.
 *  4. A ROW OPENS THE DAY. `?openEmployee=&openDate=` re-reads that single day
 *     through `fetchDay` and shows every remaining field — including what the
 *     engine did with a day that has one scan and no other.
 *
 * @route /admin/attendance/days
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarClock, Lock, ScanFace, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatDays, formatNumber } from "@/lib/format";
import {
  fmtCivilDate,
  fmtCivilDateWeekday,
  fmtDateTime,
  fmtDurationHm,
  fmtTime,
} from "@/lib/datetime";
import { PERIOD_PARAM_KEYS } from "@/lib/period";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { PeriodBar } from "../components/PeriodBar";
import { periodLabel } from "../analyticsFilterBar";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { useRefOptions } from "../hooks/useMasters";
import {
  DAY_RECORDS_PAGE_SIZE,
  flattenDayRecords,
  useDayDetail,
  useDayRecords,
  useDayRecordsCount,
  useDayStatusCounts,
} from "../hooks/useAttendanceRecords";
import {
  SINGLE_PUNCH_FLAG,
  attendanceStatusValues,
  type AttendanceStatus,
  type DayFilters,
  type DayRow,
} from "../api/attendance.api";

/**
 * `public.attendance_status` → label + tone. Exhaustive over the deployed enum,
 * so no raw value can reach the screen (D-10), and the two an admin must never
 * miss in a scan of the grid — `absent` and `suspended` — are the danger tones
 * (DR-45: an "Absent" badge in calm blue was a reference-product defect).
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

const STATUS_OPTIONS = attendanceStatusValues.map((value) => ({
  value,
  label: STATUS_CHIP[value].label,
}));

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isAttendanceStatus(value: string | null): value is AttendanceStatus {
  return value !== null && attendanceStatusValues.some((s) => s === value);
}

export default function DayRecordsPage() {
  const [params, setParams] = useSearchParams();

  // A single business date beats the month when present: that is the shape of
  // the Command Centre's own links (`?date=…&late=true`).
  const dateParam = params.get("date");
  const singleDate = dateParam !== null && CIVIL_DATE.test(dateParam) ? dateParam : null;

  /*
    THE PERIOD IS SHARED, not private to this page. `useAnalyticsFilters` reads the
    same url parameters the analytics dashboard writes, so a period chosen there
    survives the click through to this grid — which is what "the same filters apply
    on every details page" has to mean in practice. Named `analytics` because
    `filters` below is this page's own `DayFilters`.
  */
  const { filters: analytics } = useAnalyticsFilters();

  const employeeId = params.get("employee") ?? "";
  // `DayFilters.departmentIds` filters `department_name`: the day view exposes the
  // department's NAME, not its id, so the picker's value is the name.
  const departmentName = params.get("department") ?? "";
  const statusParam = params.get("status");
  const status: AttendanceStatus | "" = isAttendanceStatus(statusParam) ? statusParam : "";
  const onlyExceptions = params.get("exceptions") === "true";
  const onlyLate = params.get("late") === "true";
  const onlyLocked = params.get("locked") === "true";
  const openEmployee = params.get("openEmployee");
  const openDate = params.get("openDate");

  const labels = useEmployeeLabels();
  const employeeOptions = useEmployeeOptions(labels.data);
  const departments = useRefOptions("departments");

  /*
    A single-date deep link still wins — that is the shape of the Command Centre's
    own links (`?date=…&late=true`) and a link that named one day must not silently
    widen to a period. Otherwise the range is the SHARED period, so this grid
    answers day, week, month, year or a custom range rather than only a month.
    `v_attendance_day_enriched` is per employee-day, so every one of those is a
    predicate it can honour honestly.
  */
  const range = useMemo(
    () =>
      singleDate !== null
        ? { from: singleDate, to: singleDate }
        : { from: analytics.period.from, to: analytics.period.to },
    [singleDate, analytics.period.from, analytics.period.to],
  );

  const filters = useMemo<DayFilters>(
    () => ({
      from: range.from,
      to: range.to,
      ...(employeeId !== "" ? { employeeIds: [employeeId] } : {}),
      ...(departmentName !== "" ? { departmentIds: [departmentName] } : {}),
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(onlyExceptions ? { onlyExceptions: true } : {}),
      ...(onlyLate ? { onlyLate: true } : {}),
      ...(onlyLocked ? { onlyLocked: true } : {}),
    }),
    [range, employeeId, departmentName, status, onlyExceptions, onlyLate, onlyLocked],
  );

  const days = useDayRecords(filters);
  const total = useDayRecordsCount(filters);
  // The breakdown is deliberately NOT scoped by the status filter — a chip has to
  // keep stating the size of its own slice of the period while one is selected.
  const breakdownFilters = useMemo<DayFilters>(
    () => ({
      from: range.from,
      to: range.to,
      ...(employeeId !== "" ? { employeeIds: [employeeId] } : {}),
      ...(departmentName !== "" ? { departmentIds: [departmentName] } : {}),
      ...(onlyExceptions ? { onlyExceptions: true } : {}),
      ...(onlyLate ? { onlyLate: true } : {}),
      ...(onlyLocked ? { onlyLocked: true } : {}),
    }),
    [range, employeeId, departmentName, onlyExceptions, onlyLate, onlyLocked],
  );
  const statusCounts = useDayStatusCounts(breakdownFilters, attendanceStatusValues);

  const rows = flattenDayRecords(days.data);
  const hasFilter =
    employeeId !== "" ||
    departmentName !== "" ||
    status !== "" ||
    onlyExceptions ||
    onlyLate ||
    onlyLocked;

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    // Changing what the grid shows must not leave a detail panel from the old
    // filter set open above it.
    next.delete("openEmployee");
    next.delete("openDate");
    setParams(next, { replace: true });
  }

  /**
   * Drop a single-date deep link and fall back to the shared period.
   *
   * It does NOT write a period of its own: the period lives in the analytics
   * parameters that `PeriodBar` owns, and re-setting it here would fight the bar
   * for the same url.
   */
  function clearSingleDate(): void {
    const params2 = new URLSearchParams(params);
    params2.delete("date");
    params2.delete("openEmployee");
    params2.delete("openDate");
    setParams(params2, { replace: true });
  }

  /**
   * Clear this page's OWN narrowing (employee, department, status, the flags) and
   * nothing else. The period parameters are deliberately carried over: "clear the
   * filters" means the ones on this screen, and resetting somebody's chosen period
   * as a side effect of clearing a status chip is the kind of surprise that makes a
   * reader stop trusting the controls.
   */
  function clearFilters(): void {
    const next = new URLSearchParams();
    if (singleDate !== null) next.set("date", singleDate);
    for (const key of PERIOD_PARAM_KEYS) {
      const held = params.get(key);
      if (held !== null) next.set(key, held);
    }
    setParams(next, { replace: true });
  }

  function openDay(row: DayRow): void {
    const next = new URLSearchParams(params);
    next.set("openEmployee", row.employee_id);
    next.set("openDate", row.ist_date);
    setParams(next, { replace: true });
  }

  function closeDay(): void {
    const next = new URLSearchParams(params);
    next.delete("openEmployee");
    next.delete("openDate");
    setParams(next, { replace: true });
  }

  const columns: DataGridColumn<DayRow>[] = [
    {
      key: "ist_date",
      header: t("admin.days.col.date"),
      width: "11rem",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDateWeekday(r.ist_date)}</span>,
    },
    {
      key: "display_name",
      header: t("admin.days.col.employee"),
      width: "15rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.department_name} />
      ),
    },
    {
      key: "shift_code",
      header: t("admin.days.col.shift"),
      width: "7rem",
      // The bare code, never `shift_display_label` — the DB builds that as
      // "G — 09:30 AM to 06:30 PM" and a 12-hour clock is banned (DR-53).
      render: (r) => dash(r.shift_code),
    },
    {
      key: "first_in_hm",
      header: t("admin.days.col.firstIn"),
      width: "7rem",
      align: "right",
      // Pre-rendered IST wall clock from the view — not re-derived from the instant.
      render: (r) => <span className="num font-medium">{dash(r.first_in_hm)}</span>,
    },
    {
      key: "last_out_hm",
      header: t("admin.days.col.lastOut"),
      width: "7rem",
      align: "right",
      render: (r) =>
        r.last_out_hm === null && r.anomaly_flags.includes(SINGLE_PUNCH_FLAG) ? (
          <span className="text-xs text-warning">{t("admin.days.noOutScan")}</span>
        ) : (
          <span className="num">{dash(r.last_out_hm)}</span>
        ),
    },
    {
      key: "total_worked_minutes",
      header: t("admin.days.col.worked"),
      width: "7rem",
      align: "right",
      sortable: true,
      render: (r) => <span className="num">{fmtDurationHm(r.total_worked_minutes)}</span>,
    },
    {
      key: "payable_worked_minutes",
      header: t("admin.days.col.payable"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => <span className="num">{fmtDurationHm(r.payable_worked_minutes)}</span>,
    },
    {
      key: "late_minutes",
      header: t("admin.days.col.lateBy"),
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
      header: t("admin.days.col.earlyBy"),
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
      header: t("admin.days.col.overtime"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.overtime_minutes === 0 ? (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ) : (
          <span className="flex flex-col items-end leading-tight">
            <span className="num">{fmtDurationHm(r.overtime_minutes)}</span>
            {r.approved_overtime_minutes < r.overtime_minutes ? (
              <span className="num text-xs text-warning">
                {t("admin.days.otApproved", {
                  approved: fmtDurationHm(r.approved_overtime_minutes),
                })}
              </span>
            ) : null}
          </span>
        ),
    },
    {
      key: "status",
      header: t("admin.days.col.status"),
      width: "9rem",
      render: (r) => <StatusChip status={r.status} map={STATUS_CHIP} />,
    },
    {
      key: "is_locked",
      header: t("admin.days.col.locked"),
      width: "7rem",
      hideBelow: "md",
      render: (r) =>
        r.is_locked ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <Lock className="h-3 w-3" aria-hidden />
            {t("admin.days.lockedYes")}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ),
    },
  ];

  /*
    The subtitle names the period the grid is ACTUALLY showing. It used to say
    "whole month" unconditionally, which became a plain untruth the moment this
    screen started honouring a week or a year — the header would claim a month while
    the counts below covered seven days. `periodLabel` is the same formatter the
    filter bar's own chip uses, so the two cannot disagree.
  */
  const shownPeriod =
    singleDate !== null ? fmtCivilDateWeekday(singleDate) : periodLabel(analytics.period);

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarClock}
        title={t("admin.days.title")}
        subtitle={t("admin.days.subtitle", { period: shownPeriod })}
      />

      <PeriodBar className="mb-4" />

      {singleDate !== null ? (
        <div className="mb-4">
          <Notice
            tone="info"
            action={
              <Button variant="outline" size="sm" onClick={clearSingleDate}>
                {t("admin.days.showWholePeriod")}
              </Button>
            }
          >
            {t("admin.days.singleDateNotice", { date: fmtCivilDateWeekday(singleDate) })}
          </Notice>
        </div>
      ) : null}

      {/* The period total — counted by Postgres over the grid's own predicate. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("admin.days.tile.total")}</p>
          <p className="num mt-1 font-display text-2xl font-semibold">
            {total.isPending ? "…" : total.error !== null ? t("common.empty") : formatNumber(total.data)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("admin.days.tile.totalHint")}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 sm:col-span-1 lg:col-span-3">
          <p className="text-xs text-muted-foreground">{t("admin.days.tile.breakdown")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {statusCounts
              .filter((s) => s.isPending || s.error !== null || (s.count ?? 0) > 0)
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
                    <span className="num font-semibold">
                      {s.isPending
                        ? "…"
                        : s.error !== null
                          ? t("common.empty")
                          : formatNumber(s.count)}
                    </span>
                  </button>
                );
              })}
            {statusCounts.every((s) => !s.isPending && s.error === null && (s.count ?? 0) === 0) ? (
              <p className="text-xs text-muted-foreground">{t("admin.days.tile.breakdownEmpty")}</p>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("admin.days.tile.breakdownHint")}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.days.filter.employee")}
          value={employeeId}
          placeholder={t("admin.days.filter.anyEmployee")}
          options={employeeOptions}
          onChange={(v) => setParam("employee", v)}
        />
        <SelectField
          label={t("admin.days.filter.department")}
          value={departmentName}
          placeholder={t("admin.days.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.name, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <SelectField
          label={t("admin.days.filter.status")}
          value={status}
          placeholder={t("admin.days.filter.anyStatus")}
          options={STATUS_OPTIONS}
          onChange={(v) => setParam("status", v)}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Button
            type="button"
            variant={onlyExceptions ? "default" : "outline"}
            aria-pressed={onlyExceptions}
            onClick={() => setParam("exceptions", onlyExceptions ? "" : "true")}
          >
            {t("admin.days.filter.exceptionsOnly")}
          </Button>
          <Button
            type="button"
            variant={onlyLate ? "default" : "outline"}
            aria-pressed={onlyLate}
            onClick={() => setParam("late", onlyLate ? "" : "true")}
          >
            {t("admin.days.filter.lateOnly")}
          </Button>
          <Button
            type="button"
            variant={onlyLocked ? "default" : "outline"}
            aria-pressed={onlyLocked}
            onClick={() => setParam("locked", onlyLocked ? "" : "true")}
          >
            {t("admin.days.filter.lockedOnly")}
          </Button>
          {hasFilter ? (
            <Button type="button" variant="ghost" onClick={clearFilters}>
              {t("admin.days.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {openEmployee !== null && openDate !== null ? (
        <DayDetailPanel employeeId={openEmployee} isoDate={openDate} onClose={closeDay} />
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={days.isPending}
          error={days.error}
          onRetry={() => void days.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? labels.error}
          partialLabel={t("admin.days.partial.total")}
          empty={
            <EmptyState
              icon={CalendarClock}
              title={
                hasFilter ? t("admin.days.empty.filtered.title") : t("admin.days.empty.title")
              }
              hint={hasFilter ? t("admin.days.empty.filtered.hint") : t("admin.days.empty.hint")}
              {...(hasFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearFilters}>
                        {t("admin.days.filter.clear")}
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
            onRowClick={openDay}
          />

          {days.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void days.fetchNextPage()}
                disabled={days.isFetchingNextPage}
              >
                {days.isFetchingNextPage
                  ? t("admin.days.loadingMore")
                  : t("admin.days.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.days.footnote")}</Notice>
      </div>
    </div>
  );
}

/** One labelled server value. Never blank, never a plausible zero. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num truncate text-sm">{value}</dd>
    </div>
  );
}

/**
 * The day detail — the same row, read again by (employee, date) so a deep link
 * works without the grid, plus the fields the grid has no room for.
 *
 * The single-scan explanation is written in plain words here because it is THE
 * case this venue hits: one camera, one guard, and someone who scanned on the
 * way in and walked out past a queue.
 */
function DayDetailPanel({
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
          <h2 className="font-display text-lg font-semibold">{t("admin.days.detail.title")}</h2>
          <p className="num text-sm text-muted-foreground">{fmtCivilDateWeekday(isoDate)}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="mr-1 size-4" aria-hidden />
          {t("admin.days.detail.close")}
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
              title={t("admin.days.detail.empty.title")}
              hint={t("admin.days.detail.empty.hint")}
            />
          }
        >
          {row !== null ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <PersonCell
                  name={row.display_name}
                  code={row.employee_code}
                  secondary={row.designation_name}
                />
                <StatusChip status={row.status} map={STATUS_CHIP} />
                {row.is_locked ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" aria-hidden />
                    {t("admin.days.detail.lockedChip")}
                  </span>
                ) : null}
              </div>

              {singleScan ? (
                <div className="mt-3">
                  <Notice tone="warning">
                    {t("admin.days.detail.singleScan", {
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
                    {t("admin.days.detail.override", { reason: dash(row.manual_override_reason) })}
                  </Notice>
                </div>
              ) : null}

              {row.is_regularized ? (
                <div className="mt-3">
                  <Notice tone="info">{t("admin.days.detail.regularized")}</Notice>
                </div>
              ) : null}

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                <Fact label={t("admin.days.col.shift")} value={dash(row.shift_code)} />
                <Fact
                  label={t("admin.days.detail.shiftWindow")}
                  value={
                    row.shift_start_at === null || row.shift_end_at === null
                      ? t("common.empty")
                      : `${fmtTime(row.shift_start_at)} – ${fmtTime(row.shift_end_at)}`
                  }
                />
                <Fact label={t("admin.days.col.firstIn")} value={dash(row.first_in_hm)} />
                <Fact
                  label={t("admin.days.col.lastOut")}
                  value={singleScan ? t("admin.days.noOutScan") : dash(row.last_out_hm)}
                />
                <Fact label={t("admin.days.detail.scans")} value={formatNumber(row.punch_count)} />
                <Fact
                  label={t("admin.days.detail.grossSpan")}
                  value={fmtDurationHm(row.gross_span_minutes)}
                />
                <Fact
                  label={t("admin.days.detail.breaks")}
                  value={t("admin.days.detail.breaksValue", {
                    duration: fmtDurationHm(row.break_minutes),
                    count: formatNumber(row.break_count),
                  })}
                />
                <Fact
                  label={t("admin.days.col.worked")}
                  value={fmtDurationHm(row.total_worked_minutes)}
                />
                <Fact
                  label={t("admin.days.col.payable")}
                  value={fmtDurationHm(row.payable_worked_minutes)}
                />
                <Fact
                  label={t("admin.days.col.lateBy")}
                  value={row.is_late ? fmtDurationHm(row.late_minutes) : t("common.empty")}
                />
                <Fact
                  label={t("admin.days.col.earlyBy")}
                  value={
                    row.is_early_exit ? fmtDurationHm(row.early_exit_minutes) : t("common.empty")
                  }
                />
                <Fact
                  label={t("admin.days.col.overtime")}
                  value={fmtDurationHm(row.overtime_minutes)}
                />
                <Fact
                  label={t("admin.days.detail.otApprovedLabel")}
                  value={fmtDurationHm(row.approved_overtime_minutes)}
                />
                <Fact
                  label={t("admin.days.detail.paidFraction")}
                  value={formatDays(row.day_fraction_paid)}
                />
                <Fact
                  label={t("admin.days.detail.lateDeduction")}
                  value={formatDays(row.late_deduction_leave_days)}
                />
                <Fact label={t("admin.days.detail.holiday")} value={dash(row.holiday_name)} />
                <Fact label={t("admin.days.detail.leaveType")} value={dash(row.leave_type_name)} />
                <Fact label={t("admin.days.detail.manager")} value={dash(row.manager_name)} />
                <Fact label={t("admin.days.detail.section")} value={dash(row.section_name)} />
                <Fact label={t("admin.days.detail.location")} value={dash(row.location_name)} />
                <Fact
                  label={t("admin.days.detail.statusSource")}
                  value={dash(row.status_source)}
                />
                <Fact
                  label={t("admin.days.detail.computedAt")}
                  value={
                    row.computed_at === null ? t("common.empty") : fmtDateTime(row.computed_at)
                  }
                />
                <Fact
                  label={t("admin.days.detail.businessDate")}
                  value={fmtCivilDate(row.ist_date)}
                />
              </dl>

              {row.anomaly_flags.length > 0 ? (
                <div className="mt-4">
                  <p className="text-xs text-muted-foreground">
                    {t("admin.days.detail.flags")}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {row.anomaly_flags.map((flag) => (
                      // StatusChip humanises an unmapped value, so an engine flag
                      // reaches the screen as "Single punch only", never as a token.
                      <StatusChip key={flag} status={flag} />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to={`/admin/attendance/punches?date=${row.ist_date}`}>
                    <ScanFace className="mr-2 size-4" aria-hidden />
                    {t("admin.days.detail.openScans")}
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/admin/people/${encodeURIComponent(row.employee_code)}`}>
                    {t("admin.days.detail.openPerson")}
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
