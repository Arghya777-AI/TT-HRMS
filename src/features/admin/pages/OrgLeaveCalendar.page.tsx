/**
 * /admin/leave/calendar — who is off, org-wide, one IST month at a time
 * (spec-admin §7.3 "Org calendar").
 *
 * The relation is `v_leave_calendar`: ONE ROW PER EMPLOYEE PER COUNTED LEAVE DAY,
 * already restricted by the view to the live statuses (`pending`, `approved`,
 * `partially_approved`, `cancellation_pending`) and to `is_counted` days. So a
 * cell on this calendar is a day the venue is actually short a person — not an
 * application someone filed and withdrew.
 *
 * What is honest about the numbers on it:
 *
 *  1. THE THREE TILES ARE SERVER COUNTS over the same predicate as the grid, plus
 *     one status set each. Change the department filter and tile, grid and warning
 *     move together, because they are the same `orgCalendarFilters()`.
 *  2. THE CELL COUNT IS THE NAMES IN THE CELL. Each day lists the people, and the
 *     header of the cell counts exactly those listed rows — nothing is inferred
 *     about people not shown. If the month exceeds the row cap the screen says so
 *     rather than drawing a thinner month than the one that exists.
 *  3. THE DENSITY WARNING IS A THRESHOLD, NOT A DERIVED PERCENTAGE. Spec §7.3
 *     wants a warning above 20% of a department. No deployed relation computes
 *     leave density (`v_team_leave_density` does not exist — the employee calendar
 *     states the same gap), so the screen prints TWO server figures ("4 of 26 in
 *     Housekeeping") and `isDenseDay` compares them. No percentage is calculated
 *     or displayed, and the warning only appears when a department is selected,
 *     because an org-wide denominator would answer a different question.
 *  4. NO EVENT OVERLAY. The spec's confirmed-event band reads `public.events`,
 *     which exists now (043100) but is not yet drawn on this calendar.
 *     Historically it needed `public.events`,
 *     which no migration creates (`coverage.api` documents the same gap). An
 *     invented band over a real calendar is exactly the class of defect this build
 *     removes, so the absence is stated instead.
 *
 * @route /admin/leave/calendar
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarRange, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import {
  fmtCivilDayMonthWeekday,
  fmtCivilWeekday,
  fmtMonthLong,
  isIstMonthKey,
  istMonthDates,
  istMonthRange,
  nowIstDate,
  nowIstMonth,
} from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { isHalfDay, portionShort, portionText } from "@/features/leave/leavePortion";
import { ACTIVE_EMPLOYMENT_STATUSES } from "../api/employees.api";
import {
  CALENDAR_APPROVED_STATUSES,
  CALENDAR_PENDING_STATUSES,
  LEAVE_CONFIG_ROW_CAP,
  type LeaveCalendarRow,
  type OrgCalendarFilters,
} from "../api/leave-config.api";
import { CountTile } from "../components/CountTile";
import { MonthStepper } from "../components/MonthStepper";
import { Notice } from "../components/Notice";
import { SelectField, type SelectOption } from "../components/Field";
import { isDenseDay } from "../leave-config-vocab";
import { unavailableHint } from "../command-vocab";
import { useAdminLeaveTypes } from "../hooks/useAdminLeave";
import { useDirectoryCount } from "../hooks/usePeople";
import { useRefOptions } from "../hooks/useMasters";
import { useOrgLeaveCalendar, useOrgLeaveCalendarCount } from "../hooks/useLeaveConfig";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** One date of the month, with the people the server says are off on it. */
interface DayCell {
  readonly date: string;
  readonly rows: readonly LeaveCalendarRow[];
  /** Distinct people, because one person can hold two counted rows in a day. */
  readonly people: number;
  readonly isToday: boolean;
}

export default function AdminOrgLeaveCalendarPage() {
  const [params, setParams] = useSearchParams();

  const monthParam = params.get("m");
  const month = monthParam !== null && isIstMonthKey(monthParam) ? monthParam : nowIstMonth();
  const departmentId = params.get("department") ?? "";
  const leaveTypeId = params.get("type") ?? "";

  const range = useMemo(() => istMonthRange(month), [month]);
  const today = nowIstDate();

  const departments = useRefOptions("departments");
  const types = useAdminLeaveTypes();

  /** The ONE filter object every read on this screen is built from. */
  const filters = useMemo<OrgCalendarFilters>(
    () => ({
      from: range.from,
      to: range.to,
      departmentId: departmentId === "" ? null : departmentId,
      leaveTypeId: leaveTypeId === "" ? null : leaveTypeId,
    }),
    [range, departmentId, leaveTypeId],
  );

  const calendar = useOrgLeaveCalendar(filters);
  const total = useOrgLeaveCalendarCount(filters);
  const approved = useOrgLeaveCalendarCount(
    useMemo(() => ({ ...filters, statuses: CALENDAR_APPROVED_STATUSES }), [filters]),
  );
  const pending = useOrgLeaveCalendarCount(
    useMemo(() => ({ ...filters, statuses: CALENDAR_PENDING_STATUSES }), [filters]),
  );

  /**
   * The department's headcount, counted by Postgres over the directory. It is the
   * denominator the density warning compares against — and it is only read when a
   * department is actually selected, because an org-wide figure would answer a
   * question nobody asked.
   */
  const headcount = useDirectoryCount(
    useMemo(
      () => ({
        statuses: ACTIVE_EMPLOYMENT_STATUSES,
        ...(departmentId === "" ? {} : { departmentIds: [departmentId] }),
      }),
      [departmentId],
    ),
  );
  const denominator = departmentId === "" ? null : headcount.data ?? null;

  const rows = calendar.data ?? [];

  const cells = useMemo<DayCell[]>(() => {
    const byDate = new Map<string, LeaveCalendarRow[]>();
    for (const row of rows) {
      const list = byDate.get(row.leave_date) ?? [];
      list.push(row);
      byDate.set(row.leave_date, list);
    }
    return istMonthDates(month).map((date) => {
      const dayRows = byDate.get(date) ?? [];
      return {
        date,
        rows: dayRows,
        people: new Set(dayRows.map((row) => row.employee_id)).size,
        isToday: date === today,
      };
    });
  }, [rows, month, today]);

  const leadingBlanks = useMemo(() => {
    const first = cells[0];
    if (first === undefined) return 0;
    return WEEKDAYS.indexOf(fmtCivilWeekday(first.date) as (typeof WEEKDAYS)[number]);
  }, [cells]);

  const marked = cells.filter((cell) => cell.rows.length > 0);
  const denseDays = cells.filter((cell) => isDenseDay(cell.people, denominator));
  const capped = rows.length >= LEAVE_CONFIG_ROW_CAP;
  const truncated = total.data !== undefined && total.data > rows.length;

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const departmentChoices: SelectOption[] = useMemo(
    () => (departments.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [departments.data],
  );
  const typeChoices: SelectOption[] = useMemo(
    () => (types.data ?? []).map((type) => ({ value: type.id, label: type.name })),
    [types.data],
  );
  const departmentName =
    departmentId === ""
      ? null
      : departmentChoices.find((choice) => choice.value === departmentId)?.label ?? null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarRange}
        title={t("adminLeave.cal.title")}
        subtitle={t("adminLeave.cal.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <MonthStepper month={month} onChange={(next) => setParam("m", next)} />
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/leave/requests">{t("adminLeave.cal.openRequests")}</Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <CountTile
          label={t("adminLeave.cal.tile.days")}
          hint={t("adminLeave.cal.tile.daysHint", { month: fmtMonthLong(month) })}
          to="/admin/leave/requests"
          drillLabel={t("adminLeave.cal.tile.daysDrill")}
          source={t("adminLeave.cal.source")}
          query={total}
        />
        <CountTile
          label={t("adminLeave.cal.tile.approved")}
          hint={t("adminLeave.cal.tile.approvedHint")}
          to="/admin/leave/requests?status=approved"
          drillLabel={t("adminLeave.cal.tile.approvedDrill")}
          source={t("adminLeave.cal.source")}
          query={approved}
        />
        <CountTile
          label={t("adminLeave.cal.tile.pending")}
          hint={t("adminLeave.cal.tile.pendingHint")}
          to="/admin/leave/requests?status=pending"
          drillLabel={t("adminLeave.cal.tile.pendingDrill")}
          source={t("adminLeave.cal.source")}
          query={pending}
          toneFor={(count) => (count > 0 ? "warn" : "success")}
        />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t("adminLeave.cal.filter.department")}
          value={departmentId}
          options={departmentChoices}
          placeholder={t("adminLeave.cal.filter.allDepartments")}
          onChange={(value) => setParam("department", value)}
          disabled={departments.isLoading}
          hint={t("adminLeave.cal.filter.departmentHint")}
        />
        <SelectField
          label={t("adminLeave.cal.filter.type")}
          value={leaveTypeId}
          options={typeChoices}
          placeholder={t("adminLeave.cal.filter.allTypes")}
          onChange={(value) => setParam("type", value)}
          disabled={types.isLoading}
        />
      </div>

      {capped || truncated ? (
        <Notice tone="warning" className="mb-4">
          {t("adminLeave.cal.truncated", {
            shown: formatNumber(rows.length),
            total: total.data === undefined ? t("common.empty") : formatNumber(total.data),
          })}
        </Notice>
      ) : null}

      {departmentId !== "" && denseDays.length > 0 ? (
        <Notice tone="warning" className="mb-4">
          {t("adminLeave.cal.dense.warning", {
            days: formatNumber(denseDays.length),
            department: departmentName ?? t("adminLeave.cal.dense.thisDepartment"),
            headcount: denominator === null ? t("common.empty") : formatNumber(denominator),
          })}
        </Notice>
      ) : null}

      {departmentId !== "" && headcount.error !== null ? (
        <Notice tone="info" className="mb-4">
          {t("adminLeave.cal.dense.noHeadcount", { reason: unavailableHint(headcount.error) })}
        </Notice>
      ) : null}

      <ul className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <li>
          <Badge variant="info">{t("adminLeave.cal.legend.leave")}</Badge>
        </li>
        <li>
          <Badge variant="warning">{t("adminLeave.cal.legend.dense")}</Badge>
        </li>
        <li className="text-muted-foreground">{t("adminLeave.cal.legend.hint")}</li>
      </ul>

      <StateBoundary
        loading={calendar.isLoading}
        error={calendar.error ?? undefined}
        onRetry={() => void calendar.refetch()}
        isEmpty={calendar.isSuccess && marked.length === 0}
        empty={
          <EmptyState
            icon={CalendarRange}
            title={t("adminLeave.cal.empty.title", { month: fmtMonthLong(month) })}
            hint={
              departmentId !== "" || leaveTypeId !== ""
                ? t("adminLeave.cal.empty.filtered")
                : t("adminLeave.cal.empty.hint")
            }
          />
        }
        partialError={total.error ?? departments.error ?? types.error ?? undefined}
        partialLabel={t("adminLeave.cal.partial")}
        skeletonRows={5}
      >
        {/* ≥768px: the month grid. */}
        <div className="hidden md:block">
          <div className="grid grid-cols-7 gap-1" role="grid" aria-label={fmtMonthLong(month)}>
            {WEEKDAYS.map((weekday) => (
              <div
                key={weekday}
                className="pb-1 text-center text-xs font-medium text-muted-foreground"
              >
                {weekday}
              </div>
            ))}
            {Array.from({ length: leadingBlanks }, (_, index) => (
              <div key={`blank-${index}`} aria-hidden />
            ))}
            {cells.map((cell) => {
              const dense = isDenseDay(cell.people, denominator);
              return (
                <div
                  key={cell.date}
                  className={cn(
                    "min-h-[7rem] rounded-md border p-2 text-left",
                    cell.rows.length > 0 && "border-info/50 bg-info/5",
                    dense && "border-warning/60 bg-warning/10",
                    cell.isToday && "ring-2 ring-ring",
                  )}
                >
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="num text-xs font-semibold">{cell.date.slice(8)}</span>
                    {cell.people === 0 ? null : (
                      <span
                        className={cn(
                          "num text-xs",
                          dense ? "font-semibold text-warning" : "text-muted-foreground",
                        )}
                      >
                        {denominator === null
                          ? t("adminLeave.cal.cell.off", { count: cell.people })
                          : t("adminLeave.cal.cell.offOf", {
                              count: cell.people,
                              headcount: denominator,
                            })}
                      </span>
                    )}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {cell.rows.map((row) => (
                      <li key={row.leave_request_day_id}>
                        <Link
                          to={`/admin/leave/requests?emp=${row.employee_id}`}
                          className="block truncate rounded text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title={`${row.display_name ?? ""} · ${row.leave_type_name} · ${portionText(row.portion)}`}
                        >
                          <span
                            className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                            style={
                              row.colour_hex === null
                                ? undefined
                                : { backgroundColor: row.colour_hex }
                            }
                            aria-hidden
                          />
                          {row.display_name ?? t("admin.common.unknownPerson")}
                          {/*
                            A month grid has room for a mark, not a sentence. The half-day
                            badge is what distinguishes somebody who is in this afternoon from
                            somebody who is gone; a full day needs no mark, because it is what
                            a name on a leave calendar already means.
                          */}
                          {isHalfDay(row.portion) ? (
                            <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">
                              {t("leave.portion.halfShort")}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>

        {/* <768px: an agenda of the days that have leave on them. */}
        <div className="md:hidden">
          <h2 className="mb-2 font-display text-base font-semibold">
            {t("adminLeave.cal.agenda.heading")}
          </h2>
          <ul className="divide-y rounded-lg border bg-card">
            {marked.map((cell) => (
              <li key={cell.date} className="p-3">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">
                    {fmtCivilDayMonthWeekday(cell.date)}
                  </span>
                  <span
                    className={cn(
                      "num text-xs",
                      isDenseDay(cell.people, denominator)
                        ? "font-semibold text-warning"
                        : "text-muted-foreground",
                    )}
                  >
                    {denominator === null
                      ? t("adminLeave.cal.cell.off", { count: cell.people })
                      : t("adminLeave.cal.cell.offOf", {
                          count: cell.people,
                          headcount: denominator,
                        })}
                  </span>
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {cell.rows.map((row) => (
                    <Link
                      key={row.leave_request_day_id}
                      to={`/admin/leave/requests?emp=${row.employee_id}`}
                    >
                      <Badge variant="info">
                        {row.display_name ?? t("admin.common.unknownPerson")} ·{" "}
                        {row.leave_type_code} · {portionShort(row.portion)}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("adminLeave.cal.densityNote")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t("adminLeave.cal.eventsNote")}</p>
      </StateBoundary>
    </div>
  );
}
