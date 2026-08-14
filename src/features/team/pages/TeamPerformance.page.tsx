/**
 * /team/performance — Performance. The review-period record this backend
 * actually holds, plus the one performance decision a manager owns in P1.
 *
 * WHAT IS NOT HERE, AND WHY IT IS NOT A STUB
 * -----------------------------------------
 * There are no appraisal tables on this database. `goals`, `one_on_one_notes`,
 * `feedback_notes`, ratings, cycles and calibration are named in
 * spec-manager §11 and exist in NONE of the 59 migrations — spec-manager itself
 * defers them (D-02-22: "no appraisal/ratings/calibration/360", team matrix
 * behind a flag that is OFF). So there is no rating to show, and inventing a
 * five-point score out of attendance would be the worst possible thing this
 * screen could do: a number that looks like a judgement, computed by a browser,
 * that no policy stands behind.
 *
 * What DOES exist for a review conversation is the record of how somebody worked
 * over the period, and it exists at exactly the right grain:
 *
 *  * `f_attendance_period_summary(p_from, p_to, p_employee_id)` — the ONE
 *    implementation of the §9.2 metric dictionary — takes an ARBITRARY inclusive
 *    range. One call therefore returns a quarter (or a year) already aggregated
 *    BY POSTGRES, per employee. `/team/analytics` calls the same function one
 *    month at a time for its charts; this screen calls it once for the whole
 *    period, so the two cannot disagree and nothing is summed in the browser.
 *  * The exception tiles are `count=exact` reads over `v_attendance_day_enriched`
 *    using `TEAM_DAY_SLICE_FILTERS` — the SAME predicate arrays
 *    `/team/attendance` counts and lists with. A "late days" figure here opens
 *    the same rows there.
 *  * Confirmation duties come from the manager allow-list view: `on_probation`
 *    plus `confirmation_due_date`. Recommending confirmation is the one
 *    performance act spec-manager §11 gives a direct manager in P1; the
 *    recommendation itself has no table, so this screen surfaces the DUTY and its
 *    dates rather than pretending to capture a decision.
 *
 * TWO HONESTIES THE FIGURES NEED
 * ------------------------------
 *  1. `attendance_pct` is `paid_days ÷ every calendar day in the window`, which
 *     is the server's definition and not the one a reader assumes. It is
 *     therefore absent from the scorecard grid (where it would be read as
 *     "attendance") and present in the review card WITH its denominator spelled
 *     out beside it, next to `total_days` and `pending_days`.
 *  2. A reportee with no computed day in the window has NO summary row. That is
 *     "the engine wrote nothing", not "zero" — those rows print em dashes and the
 *     card says how many there are.
 *
 * The manager's own record is not on this screen: `useTeamRoster` is the
 * downward closure only (D-02-06), and their own month lives on /me/attendance.
 *
 * @route /team/performance
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BarChart3, CalendarClock, ClipboardList, Gauge, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StatusChip, type StatusTone } from "@/shared/ui/StatusChip";
import { dash, formatDays, formatNumber, formatPercent } from "@/lib/format";
import { fmtCivilDate, fmtDurationHm } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "@/features/admin/components/PersonCell";
import { Notice } from "@/features/admin/components/Notice";
import { AppraisalPanel } from "../components/AppraisalPanel";
import { Fact, FactCard, FactGrid, YesNo } from "../components/TeamFacts";
import { useIstToday, useMyEmployeeId } from "../hooks/useTeamToday";
import { useTeamRoster } from "../hooks/useTeamDecisions";
import {
  CONFIRMATION_HORIZON_DAYS,
  DEFAULT_REVIEW_WINDOW,
  isReviewWindow,
  reviewRange,
  reviewWindows,
  useTeamConfirmationCount,
  useTeamConfirmations,
  useTeamRangeDayCount,
  useTeamReviewSummaries,
  type ReviewWindow,
} from "../hooks/useTeamReview";
import {
  EMPLOYMENT_STATUS_CHIP,
  EMPLOYMENT_TYPE_LABELS,
  type TeamMember,
  type TeamReviewSummary,
} from "../api/team.api";

/** One scorecard row: the person, and their period record if the engine has one. */
interface ReviewRow {
  readonly member: TeamMember;
  readonly summary: TeamReviewSummary | undefined;
}

function windowLabel(window: ReviewWindow): string {
  switch (window) {
    case "1m":
      return t("teamExtra.perf.window.1m");
    case "3m":
      return t("teamExtra.perf.window.3m");
    case "6m":
      return t("teamExtra.perf.window.6m");
    case "12m":
      return t("teamExtra.perf.window.12m");
  }
}

/** A minute figure the function returned; '—' when it returned nothing at all. */
const minutes = (value: number | null | undefined): string =>
  value === null || value === undefined ? dash(null) : fmtDurationHm(value);

const count = (value: number | null | undefined): string =>
  value === null || value === undefined ? dash(null) : formatNumber(value);

const days = (value: number | null | undefined): string =>
  value === null || value === undefined ? dash(null) : formatDays(value);

const percent = (value: number | null | undefined): string =>
  value === null || value === undefined ? dash(null) : formatPercent(value);

export default function TeamPerformancePage() {
  const [params, setParams] = useSearchParams();
  const myEmployeeId = useMyEmployeeId();
  const istToday = useIstToday();

  /** Both the period and the opened reportee live in the URL (RT-NAV-DEEPLINK). */
  const rawWindow = params.get("period");
  const period: ReviewWindow = isReviewWindow(rawWindow) ? rawWindow : DEFAULT_REVIEW_WINDOW;
  const openedCode = params.get("emp");

  const range = useMemo(() => reviewRange(period, istToday), [period, istToday]);

  const team = useTeamRoster();
  const members = useMemo(() => team.data?.members ?? [], [team.data]);
  const employeeIds = useMemo(() => team.data?.employeeIds ?? [], [team.data]);

  const summaries = useTeamReviewSummaries(range, employeeIds);

  // The exception tiles for the period. One call per slice, written out because
  // hooks may not be called in a loop, and each is independently cached.
  const lateDays = useTeamRangeDayCount(range, employeeIds, "late");
  const earlyExitDays = useTeamRangeDayCount(range, employeeIds, "early_exit");
  const absentDays = useTeamRangeDayCount(range, employeeIds, "absent");
  const exceptionDays = useTeamRangeDayCount(range, employeeIds, "exceptions");

  // Confirmation duties. `on_probation` is the denominator of the other two.
  const onProbation = useTeamConfirmationCount(employeeIds, "on_probation", istToday);
  const dueSoon = useTeamConfirmationCount(employeeIds, "due_soon", istToday);
  const overdue = useTeamConfirmationCount(employeeIds, "overdue", istToday);
  const probationList = useTeamConfirmations(employeeIds, "on_probation", istToday);

  const summaryByEmployee = useMemo(() => {
    const map = new Map<string, TeamReviewSummary>();
    for (const row of summaries.data ?? []) map.set(row.employee_id, row);
    return map;
  }, [summaries.data]);

  const rows = useMemo<ReviewRow[]>(
    () => members.map((member) => ({ member, summary: summaryByEmployee.get(member.id) })),
    [members, summaryByEmployee],
  );

  /** People the metric function had no row for — stated, never rendered as 0. */
  const withoutRecord = rows.filter((row) => row.summary === undefined).length;

  const opened = useMemo(
    () => rows.find((row) => row.member.employee_code === openedCode) ?? null,
    [rows, openedCode],
  );

  const setPeriod = (next: ReviewWindow): void => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("period", next);
    setParams(nextParams, { replace: true });
  };

  const openRow = (row: ReviewRow): void => {
    const nextParams = new URLSearchParams(params);
    if (row.member.employee_code === openedCode) nextParams.delete("emp");
    else nextParams.set("emp", row.member.employee_code);
    setParams(nextParams, { replace: true });
  };

  const columns: DataGridColumn<ReviewRow>[] = [
    {
      key: "display_name",
      header: t("teamExtra.perf.col.employee"),
      width: "15rem",
      sortable: true,
      sortValue: (row) => row.member.display_name,
      render: (row) => (
        <PersonCell
          name={row.member.display_name}
          code={row.member.employee_code}
          secondary={row.member.designation_name}
        />
      ),
    },
    {
      key: "working_days",
      header: t("teamExtra.perf.col.workingDays"),
      width: "7rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.summary?.working_days ?? -1,
      render: (row) => <span className="num">{count(row.summary?.working_days)}</span>,
    },
    {
      key: "present_days",
      header: t("teamExtra.perf.col.present"),
      width: "7rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.summary?.present_days ?? -1,
      render: (row) => <span className="num">{count(row.summary?.present_days)}</span>,
    },
    {
      key: "paid_days",
      header: t("teamExtra.perf.col.paid"),
      width: "7rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{days(row.summary?.paid_days)}</span>,
    },
    {
      key: "absent_days",
      header: t("teamExtra.perf.col.absent"),
      width: "6rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.summary?.absent_days ?? -1,
      render: (row) => <span className="num">{count(row.summary?.absent_days)}</span>,
    },
    {
      key: "leave_days",
      header: t("teamExtra.perf.col.leave"),
      width: "6rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{days(row.summary?.leave_days)}</span>,
    },
    {
      key: "late_days",
      header: t("teamExtra.perf.col.late"),
      width: "6rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.summary?.late_days ?? -1,
      render: (row) => <span className="num">{count(row.summary?.late_days)}</span>,
    },
    {
      key: "late_pct",
      header: t("teamExtra.perf.col.latePct"),
      width: "7rem",
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.summary?.late_pct ?? -1,
      // Already ×100 and clamped by `fn_late_pct` — only the '%' is added here.
      render: (row) => <span className="num">{percent(row.summary?.late_pct)}</span>,
    },
    {
      key: "early_exit_days",
      header: t("teamExtra.perf.col.earlyExit"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{count(row.summary?.early_exit_days)}</span>,
    },
    {
      key: "avg_worked",
      header: t("teamExtra.perf.col.avgWorked"),
      width: "8rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.summary?.avg_worked_minutes_per_working_day ?? -1,
      // Averaged by Postgres over the working days IT decided were working days.
      render: (row) => (
        <span className="num">{minutes(row.summary?.avg_worked_minutes_per_working_day)}</span>
      ),
    },
    {
      key: "overtime",
      header: t("teamExtra.perf.col.overtime"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      // Both figures side by side: the gap between recorded and approved OT is
      // visible without anybody subtracting one from the other.
      render: (row) => (
        <span className="num">
          {row.summary === undefined
            ? dash(null)
            : t("teamExtra.perf.value.overtime", {
                approved: fmtDurationHm(row.summary.approved_overtime_minutes),
                recorded: fmtDurationHm(row.summary.overtime_minutes),
              })}
        </span>
      ),
    },
  ];

  const probationColumns: DataGridColumn<TeamMember>[] = [
    {
      key: "display_name",
      header: t("teamExtra.perf.col.employee"),
      width: "16rem",
      render: (member) => (
        <PersonCell
          name={member.display_name}
          code={member.employee_code}
          secondary={member.designation_name}
        />
      ),
    },
    {
      key: "department_name",
      header: t("teamExtra.perf.col.department"),
      hideBelow: "md",
      render: (member) => dash(member.department_name),
    },
    {
      key: "date_of_join",
      header: t("teamExtra.perf.col.joined"),
      width: "9rem",
      align: "right",
      render: (member) => <span className="num">{fmtCivilDate(member.date_of_join)}</span>,
    },
    {
      key: "confirmation_due_date",
      header: t("teamExtra.perf.col.confirmationDue"),
      width: "10rem",
      align: "right",
      render: (member) =>
        member.confirmation_due_date === null ? (
          dash(null)
        ) : (
          // Two civil dates compared as strings — ISO dates sort lexically, so
          // this is an ordering, not a computed interval.
          <span
            className={member.confirmation_due_date < istToday ? "num text-warning" : "num"}
          >
            {fmtCivilDate(member.confirmation_due_date)}
          </span>
        ),
    },
    {
      key: "employment_status",
      header: t("teamExtra.perf.col.status"),
      width: "9rem",
      hideBelow: "md",
      render: (member) => (
        <StatusChip status={member.employment_status} map={EMPLOYMENT_STATUS_CHIP} />
      ),
    },
  ];

  if (myEmployeeId === null) {
    return (
      <div className="container py-6">
        <PageHeader
          icon={BarChart3}
          title={t("teamExtra.perf.title")}
          subtitle={t("teamExtra.perf.subtitle.plain")}
        />
        <EmptyState
          icon={Users}
          title={t("teamExtra.perf.noRecord.title")}
          hint={t("teamExtra.perf.noRecord.hint")}
        />
      </div>
    );
  }

  const noTeam = team.data?.isEmpty === true;

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("teamExtra.perf.title")}
        subtitle={t("teamExtra.perf.subtitle.period", {
          n: formatNumber(employeeIds.length),
          from: fmtCivilDate(range.from),
          to: fmtCivilDate(range.to),
        })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {reviewWindows.map((option) => (
              <Button
                key={option}
                variant={option === period ? "default" : "outline"}
                size="sm"
                aria-pressed={option === period}
                onClick={() => setPeriod(option)}
              >
                {windowLabel(option)}
              </Button>
            ))}
          </div>
        }
      />

      {noTeam ? (
        <EmptyState
          icon={Users}
          title={t("teamExtra.perf.noTeam.title")}
          hint={t("teamExtra.perf.noTeam.hint")}
        />
      ) : (
        <div className="space-y-4">
          {/* --- The period's exceptions, each counted by Postgres --- */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label={t("teamExtra.perf.tile.late")}
              hint={t("teamExtra.perf.tile.lateHint")}
              query={lateDays}
            />
            <Tile
              label={t("teamExtra.perf.tile.earlyExit")}
              hint={t("teamExtra.perf.tile.earlyExitHint")}
              query={earlyExitDays}
            />
            <Tile
              label={t("teamExtra.perf.tile.absent")}
              hint={t("teamExtra.perf.tile.absentHint")}
              query={absentDays}
            />
            <Tile
              label={t("teamExtra.perf.tile.exceptions")}
              hint={t("teamExtra.perf.tile.exceptionsHint")}
              query={exceptionDays}
            />
          </div>

          {/* --- The scorecard: one server row per reportee for the period --- */}
          <FactCard
            icon={Gauge}
            title={t("teamExtra.perf.scorecard.title")}
            description={t("teamExtra.perf.scorecard.desc", {
              from: fmtCivilDate(range.from),
              to: fmtCivilDate(range.to),
            })}
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/team/attendance">{t("teamExtra.perf.openAttendance")}</Link>
              </Button>
            }
          >
            <StateBoundary
              loading={team.isPending || summaries.isPending}
              error={team.error ?? summaries.error}
              onRetry={() => {
                void team.refetch();
                void summaries.refetch();
              }}
              isEmpty={rows.length === 0}
              empty={
                <EmptyState
                  icon={Gauge}
                  title={t("teamExtra.perf.scorecard.empty.title")}
                  hint={t("teamExtra.perf.scorecard.empty.hint")}
                />
              }
              skeletonRows={5}
            >
              <DataGrid
                columns={columns}
                rows={rows}
                rowKey={(row) => row.member.id}
                pageSize={25}
                onRowClick={openRow}
              />
            </StateBoundary>
            {withoutRecord > 0 ? (
              <Notice tone="warning">
                {t("teamExtra.perf.scorecard.noRecord", {
                  n: formatNumber(withoutRecord),
                })}
              </Notice>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("teamExtra.perf.scorecard.hint")}</p>
          </FactCard>

          {/* --- One person's full period record, opened from the grid --- */}
          {opened === null ? (
            <Notice tone="info">{t("teamExtra.perf.detail.pick")}</Notice>
          ) : (
            <ReviewRecordCard row={opened} />
          )}

          {/* --- The one performance decision a manager owns in P1 --- */}
          <FactCard
            icon={CalendarClock}
            title={t("teamExtra.perf.confirm.title")}
            description={t("teamExtra.perf.confirm.desc", {
              days: formatNumber(CONFIRMATION_HORIZON_DAYS),
            })}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile
                label={t("teamExtra.perf.tile.onProbation")}
                hint={t("teamExtra.perf.tile.onProbationHint")}
                query={onProbation}
              />
              <Tile
                label={t("teamExtra.perf.tile.dueSoon")}
                hint={t("teamExtra.perf.tile.dueSoonHint")}
                query={dueSoon}
                toneFor={(value) => (value > 0 ? "warn" : "neutral")}
              />
              <Tile
                label={t("teamExtra.perf.tile.overdue")}
                hint={t("teamExtra.perf.tile.overdueHint")}
                query={overdue}
                toneFor={(value) => (value > 0 ? "danger" : "neutral")}
              />
            </div>
            <StateBoundary
              loading={probationList.isPending}
              error={probationList.error}
              onRetry={() => void probationList.refetch()}
              isEmpty={(probationList.data ?? []).length === 0}
              partialError={onProbation.error ?? dueSoon.error ?? overdue.error}
              partialLabel={t("teamExtra.perf.confirm.partial")}
              empty={
                <EmptyState
                  icon={CalendarClock}
                  title={t("teamExtra.perf.confirm.empty.title")}
                  hint={t("teamExtra.perf.confirm.empty.hint")}
                />
              }
              skeletonRows={2}
            >
              <DataGrid
                columns={probationColumns}
                rows={probationList.data ?? []}
                rowKey={(member) => member.id}
                pageSize={10}
              />
            </StateBoundary>
            <Notice tone="info">{t("teamExtra.perf.confirm.notice")}</Notice>
          </FactCard>

          {/*
            THE REVIEW SITS BELOW THE EVIDENCE, deliberately. A manager scrolls
            past the hours, the lateness and the overtime before typing a
            judgement — and nothing on this screen turns one into the other.
          */}
          <AppraisalPanel
            nameOf={(id) =>
              members.find((m) => m.id === id)?.display_name ?? t("teamExtra.appr.unknownPerson")
            }
          />

          <div className="space-y-2">
            <Notice tone="note">{t("teamExtra.perf.evidence")}</Notice>
            <Notice tone="info">{t("teamExtra.perf.footnote.oneSource")}</Notice>
            <Notice tone="info">{t("teamExtra.perf.footnote.excludesMe")}</Notice>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A tile whose number is a server `count=exact`.
 *
 * Built on the shared `KpiTile` rather than on `admin/CountTile`, for one
 * reason: `CountTile` REQUIRES a drill route, and there is no honest one here. A
 * "late days over three months" figure can only open `/team/attendance`, which
 * shows ONE month — so the tile would promise rows it cannot show, and the
 * period card's own link says where the month view lives instead.
 *
 * A read that failed shows an em dash and never a plausible `0`: on this screen a
 * zero means "the database counted zero rows", and it has to keep meaning that.
 */
function Tile({
  label,
  hint,
  query,
  toneFor,
}: {
  label: string;
  hint: string;
  query: { data: number | undefined; error: Error | null; isPending: boolean };
  toneFor?: (value: number) => StatusTone;
}) {
  if (query.isPending) {
    return <KpiTile label={label} value={<Skeleton className="h-7 w-12" />} hint={hint} />;
  }
  if (query.error !== null) {
    return <KpiTile label={label} value={t("common.empty")} hint={t("teamExtra.perf.tile.unreadable")} />;
  }
  const value = query.data ?? 0;
  return (
    <KpiTile
      label={label}
      value={formatNumber(value)}
      hint={hint}
      {...(toneFor ? { tone: toneFor(value) } : {})}
    />
  );
}

/**
 * The full metric dictionary for ONE reportee over the period, as facts.
 *
 * Every value is a column of the summary row. `attendance_pct` carries its
 * denominator in the hint, because "paid days ÷ every calendar day in the
 * window" is the server's definition and not the one the phrase suggests.
 */
function ReviewRecordCard({ row }: { row: ReviewRow }) {
  const { member, summary } = row;

  return (
    <FactCard
      icon={ClipboardList}
      title={t("teamExtra.perf.detail.title", { name: member.display_name })}
      description={
        summary === undefined
          ? t("teamExtra.perf.detail.descNoRecord")
          : t("teamExtra.perf.detail.desc", {
              from: fmtCivilDate(summary.from_date),
              to: fmtCivilDate(summary.to_date),
              days: formatNumber(summary.total_days),
            })
      }
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to={`/team/people/${member.employee_code}`}>
            {t("teamExtra.perf.detail.openProfile")}
          </Link>
        </Button>
      }
    >
      {summary === undefined ? (
        <EmptyState
          icon={ClipboardList}
          title={t("teamExtra.perf.detail.empty.title")}
          hint={t("teamExtra.perf.detail.empty.hint")}
        />
      ) : (
        <>
          <FactGrid>
            <Fact
              label={t("teamExtra.perf.field.workingDays")}
              value={<span className="num">{formatNumber(summary.working_days)}</span>}
              hint={t("teamExtra.perf.field.workingDaysHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.present")}
              value={<span className="num">{formatNumber(summary.present_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.halfDays")}
              value={<span className="num">{formatNumber(summary.half_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.absent")}
              value={<span className="num">{formatNumber(summary.absent_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.pending")}
              value={<span className="num">{formatNumber(summary.pending_days)}</span>}
              hint={t("teamExtra.perf.field.pendingHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.weeklyOff")}
              value={<span className="num">{formatNumber(summary.weekly_off_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.holidays")}
              value={<span className="num">{formatNumber(summary.holiday_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.leave")}
              value={<span className="num">{formatDays(summary.leave_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.compOff")}
              value={<span className="num">{formatNumber(summary.comp_off_days)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.paid")}
              value={<span className="num">{formatDays(summary.paid_days)}</span>}
              hint={t("teamExtra.perf.field.paidHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.attendancePct")}
              value={<span className="num">{percent(summary.attendance_pct)}</span>}
              hint={t("teamExtra.perf.field.attendancePctHint", {
                paid: formatDays(summary.paid_days),
                total: formatNumber(summary.total_days),
              })}
            />
            <Fact
              label={t("teamExtra.perf.field.latePct")}
              value={<span className="num">{percent(summary.late_pct)}</span>}
              hint={t("teamExtra.perf.field.latePctHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.lateDays")}
              value={
                <span className="num">
                  {t("teamExtra.perf.value.lateDays", {
                    days: formatNumber(summary.late_days),
                    time: fmtDurationHm(summary.late_minutes),
                  })}
                </span>
              }
            />
            <Fact
              label={t("teamExtra.perf.field.earlyExit")}
              value={
                <span className="num">
                  {t("teamExtra.perf.value.lateDays", {
                    days: formatNumber(summary.early_exit_days),
                    time: fmtDurationHm(summary.early_exit_minutes),
                  })}
                </span>
              }
            />
            <Fact
              label={t("teamExtra.perf.field.lateDeduction")}
              value={<span className="num">{formatDays(summary.late_deduction_leave_days)}</span>}
              hint={t("teamExtra.perf.field.lateDeductionHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.worked")}
              value={<span className="num">{fmtDurationHm(summary.total_worked_minutes)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.avgWorkingDay")}
              value={
                <span className="num">
                  {minutes(summary.avg_worked_minutes_per_working_day)}
                </span>
              }
              hint={t("teamExtra.perf.field.avgWorkingDayHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.avgPresentDay")}
              value={
                <span className="num">
                  {minutes(summary.avg_worked_minutes_per_present_day)}
                </span>
              }
              hint={t("teamExtra.perf.field.avgPresentDayHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.overtime")}
              value={
                <span className="num">
                  {t("teamExtra.perf.value.overtime", {
                    approved: fmtDurationHm(summary.approved_overtime_minutes),
                    recorded: fmtDurationHm(summary.overtime_minutes),
                  })}
                </span>
              }
              hint={t("teamExtra.perf.field.overtimeHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.extraWork")}
              value={<span className="num">{fmtDurationHm(summary.extra_work_minutes)}</span>}
              hint={t("teamExtra.perf.field.extraWorkHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.breaks")}
              value={
                <span className="num">
                  {t("teamExtra.perf.value.breaks", {
                    time: fmtDurationHm(summary.break_minutes),
                    n: formatNumber(summary.break_count),
                  })}
                </span>
              }
              hint={t("teamExtra.perf.field.breaksHint")}
            />
          </FactGrid>

          <FactGrid>
            <Fact
              label={t("teamExtra.perf.field.employmentStatus")}
              value={
                <StatusChip status={member.employment_status} map={EMPLOYMENT_STATUS_CHIP} />
              }
            />
            <Fact
              label={t("teamExtra.perf.field.employmentType")}
              value={EMPLOYMENT_TYPE_LABELS[member.employment_type]}
            />
            <Fact
              label={t("teamExtra.perf.field.joined")}
              value={<span className="num">{fmtCivilDate(member.date_of_join)}</span>}
            />
            <Fact
              label={t("teamExtra.perf.field.probation")}
              value={
                <YesNo
                  value={member.is_on_probation}
                  yes={t("teamExtra.perf.value.onProbation")}
                  no={t("teamExtra.perf.value.confirmed")}
                />
              }
            />
            <Fact
              label={t("teamExtra.perf.field.confirmationDue")}
              value={
                member.confirmation_due_date === null ? undefined : (
                  <span className="num">{fmtCivilDate(member.confirmation_due_date)}</span>
                )
              }
              hint={t("teamExtra.perf.field.confirmationDueHint")}
            />
            <Fact
              label={t("teamExtra.perf.field.otEligible")}
              value={
                <YesNo
                  value={member.is_ot_eligible}
                  yes={t("teamExtra.perf.value.otEligible")}
                  no={t("teamExtra.perf.value.notOtEligible")}
                />
              }
              hint={t("teamExtra.perf.field.otEligibleHint")}
            />
          </FactGrid>
        </>
      )}
    </FactCard>
  );
}
