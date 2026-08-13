/**
 * E-15 · /me/holidays — my calendar year, and what the engine made of each date.
 *
 * Three things this screen refuses to fudge:
 *
 *  1. WHICH CALENDAR IS MINE is answered by Postgres, not by a column read.
 *     `employees.holiday_calendar_id` is NULL for every live employee; the
 *     attendance engine resolves the calendar through
 *     `resolve_policy('holiday_calendar', me, today)`, so this screen calls the
 *     same function and NAMES the source it got an answer from. Reading only the
 *     employee column (the first version) produced "no calendar assigned" on a
 *     screen whose own attendance rows already said 26-Jan was a holiday.
 *  2. THE "FOR YOU" COLUMN IS THE ENGINE'S ROW. It comes from
 *     `v_attendance_day_enriched` — literally the row `/me/attendance` renders —
 *     so a date cannot read "Holiday" here and "Working" there. A future date has
 *     no row yet, and that is shown as "not decided yet", never as "Working".
 *  3. THE TILES ARE SERVER COUNTS. Total / optional / paid come from
 *     `count=exact` HEAD requests over the same filters as the table, and "next
 *     holiday" is an `ORDER BY holiday_date LIMIT 1` pick — nothing is counted or
 *     compared in the browser.
 *
 * Optional-holiday ELECTION (spec-employee §5 E-15 asks employees to pick two of
 * the restricted holidays) is NOT offered: there is no election table in the
 * deployed schema — `holidays.is_optional` plus
 * `holiday_calendars.optional_holiday_quota` is all that exists. The screen marks
 * the optional days, states the quota, and says where to take the choice
 * instead of rendering a checkbox that would write nowhere.
 *
 * @route /me/holidays
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, CalendarHeart, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { fmtCivilDate, fmtCivilDayMonthWeekday, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AttendanceDay } from "@/features/attendance/api/attendance.api";
import type { CalendarSource, Holiday, HolidayType } from "../api/holidays.api";
import { useHolidayYear } from "../hooks/useHolidays";

/** `public.holiday_type` → label + tone. Never a bare enum on screen (D-10). */
const TYPE_CHIP: Readonly<Record<HolidayType, StatusChipEntry>> = {
  national: { label: t("holidays.type.national"), tone: "info" },
  state: { label: t("holidays.type.state"), tone: "info" },
  festival: { label: t("holidays.type.festival"), tone: "neutral" },
  restricted: { label: t("holidays.type.restricted"), tone: "warn" },
  optional: { label: t("holidays.type.optional"), tone: "warn" },
  company: { label: t("holidays.type.company"), tone: "neutral" },
  venue_closure: { label: t("holidays.type.venueClosure"), tone: "success" },
};

const SOURCE_LABEL: Readonly<Record<CalendarSource, string>> = {
  assignment: t("holidays.source.assignment"),
  employee: t("holidays.source.employee"),
  location: t("holidays.source.location"),
  /* The company calendar, shown to anybody the first three sources do not
     answer for — an administrator or a manager with no site on their record. */
  default: t("holidays.source.default"),
};

interface HolidayRow {
  readonly holiday: Holiday;
  readonly day: AttendanceDay | null;
}

/**
 * What the engine's own row says about this date, for me.
 *
 * The order matters: a leave row wins over the holiday flag because that is what
 * the day record says happened, and a worked holiday is called out because it is
 * the case a venue employee actually cares about (it earns comp-off).
 */
function forYouCell(row: HolidayRow) {
  const day = row.day;
  if (day === null) {
    return <span className="text-muted-foreground">{t("holidays.forYou.notYet")}</span>;
  }
  if (day.is_holiday && day.punch_count > 0) {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge variant="warning" className="w-fit">
          {t("holidays.forYou.worked")}
        </Badge>
        <span className="num text-xs text-muted-foreground">{dash(day.worked_hm)}</span>
      </span>
    );
  }
  if (day.is_holiday) {
    return <Badge variant="success">{t("holidays.forYou.holiday")}</Badge>;
  }
  if (day.leave_type_name !== null) {
    return <Badge variant="info">{day.leave_type_name}</Badge>;
  }
  if (day.is_weekly_off) {
    return <Badge variant="neutral">{t("holidays.forYou.weeklyOff")}</Badge>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <Badge variant="neutral" className="w-fit">
        {t("holidays.forYou.working")}
      </Badge>
      <StatusChip status={day.status} />
    </span>
  );
}

export default function HolidaysPage() {
  const [params, setParams] = useSearchParams();
  const yearParam = params.get("year");
  const parsedYear = yearParam !== null && /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;

  const query = useHolidayYear(parsedYear);
  const payload = query.data ?? null;
  const today = nowIstDate();

  const rows = useMemo<HolidayRow[]>(() => {
    const holidays = payload?.holidays ?? [];
    const dayRows = payload?.dayRows ?? {};
    return holidays.map((holiday) => ({
      holiday,
      day: dayRows[holiday.holiday_date] ?? null,
    }));
  }, [payload]);

  function selectYear(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next === "") nextParams.delete("year");
    else nextParams.set("year", next);
    setParams(nextParams, { replace: true });
  }

  const calendar = payload?.calendar ?? null;
  const counts = payload?.counts ?? null;
  const next = payload?.next ?? null;
  const years = payload?.years ?? [];

  const columns: DataGridColumn<HolidayRow>[] = [
    {
      key: "holiday_date",
      header: t("holidays.col.date"),
      width: "12rem",
      sortable: true,
      sortValue: (row) => row.holiday.holiday_date,
      render: (row) => (
        <span className="num">
          {fmtCivilDayMonthWeekday(row.holiday.holiday_date)}
          {row.holiday.holiday_date === today ? (
            <Badge variant="info" className="ml-2">
              {t("holidays.today")}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "name",
      header: t("holidays.col.name"),
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{row.holiday.name}</span>
          {row.holiday.local_name !== null ? (
            <span className="text-xs text-muted-foreground">{row.holiday.local_name}</span>
          ) : null}
          {row.holiday.description !== null ? (
            <span className="text-xs text-muted-foreground">{row.holiday.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "holiday_type",
      header: t("holidays.col.type"),
      width: "9rem",
      sortable: true,
      sortValue: (row) => row.holiday.holiday_type,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusChip status={row.holiday.holiday_type} map={TYPE_CHIP} />
          {row.holiday.is_optional ? (
            <Badge variant="warning">{t("holidays.forYou.optional")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "is_paid",
      header: t("holidays.col.paid"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => (row.holiday.is_paid ? t("common.yes") : t("common.no")),
    },
    {
      key: "working_if_event_booked",
      header: t("holidays.col.ifEvent"),
      hideBelow: "lg",
      render: (row) =>
        row.holiday.working_if_event_booked
          ? t("holidays.ifEvent.mayWork")
          : t("holidays.ifEvent.closed"),
    },
    {
      key: "compensatory_off_if_worked",
      header: t("holidays.col.compOff"),
      hideBelow: "lg",
      render: (row) =>
        row.holiday.compensatory_off_if_worked
          ? t("holidays.compOff.yes")
          : t("holidays.compOff.no"),
    },
    {
      key: "forYou",
      header: t("holidays.col.forYou"),
      width: "11rem",
      render: forYouCell,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("holidays.title")}
        subtitle={
          calendar !== null
            ? t("holidays.subtitle.named", { name: calendar.name, state: calendar.state })
            : t("holidays.subtitle")
        }
        actions={
          years.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("holidays.year")}</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={calendar !== null ? String(calendar.year) : ""}
                onChange={(event) => selectYear(event.target.value)}
              >
                {years.map((option) => (
                  <option key={option.id} value={String(option.year)}>
                    {option.year}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />

      <StateBoundary
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        isEmpty={calendar === null}
        skeletonRows={6}
        empty={
          <EmptyState
            icon={CalendarDays}
            title={t("holidays.noCalendar.title")}
            hint={t("holidays.noCalendar.hint")}
          />
        }
      >
        {counts !== null && calendar !== null ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label={t("holidays.kpi.published")}
              value={formatNumber(counts.total)}
              hint={t("holidays.kpi.publishedHint", { year: String(calendar.year) })}
              explainer={{
                formula: t("holidays.kpi.published.formula"),
                numbers: t("holidays.kpi.published.numbers", {
                  n: formatNumber(counts.total),
                  name: calendar.name,
                }),
              }}
            />
            <KpiTile
              label={t("holidays.kpi.paid")}
              value={formatNumber(counts.paid)}
              tone="success"
              hint={t("holidays.kpi.paidHint")}
              explainer={{
                formula: t("holidays.kpi.paid.formula"),
                numbers: t("holidays.kpi.paid.numbers", {
                  n: formatNumber(counts.paid),
                  total: formatNumber(counts.total),
                }),
              }}
            />
            <KpiTile
              label={t("holidays.kpi.optional")}
              value={formatNumber(counts.optional)}
              tone="warn"
              hint={t("holidays.kpi.optionalHint", {
                quota: formatNumber(calendar.optional_holiday_quota),
              })}
              explainer={{
                formula: t("holidays.kpi.optional.formula"),
                numbers: t("holidays.kpi.optional.numbers", {
                  n: formatNumber(counts.optional),
                  quota: formatNumber(calendar.optional_holiday_quota),
                }),
              }}
            />
            <KpiTile
              label={t("holidays.kpi.next")}
              value={next !== null ? fmtCivilDate(next.holiday_date) : dash(null)}
              tone="info"
              hint={next !== null ? next.name : t("holidays.kpi.nextNone")}
              explainer={{
                formula: t("holidays.kpi.next.formula"),
                numbers:
                  next !== null
                    ? t("holidays.kpi.next.numbers", {
                        name: next.name,
                        date: fmtCivilDate(next.holiday_date),
                      })
                    : t("holidays.kpi.nextNone"),
              }}
            />
          </div>
        ) : null}

        {payload?.source !== null && payload?.source !== undefined ? (
          <Notice tone="info" className="mt-4">
            {t("holidays.source.note", { source: SOURCE_LABEL[payload.source] })}
          </Notice>
        ) : null}

        {/* Only when the year actually HAS optional days — otherwise the notice
            is a warning about nothing. */}
        {calendar !== null && counts !== null && counts.optional > 0 ? (
          <Notice tone="warning" className="mt-3">
            {t("holidays.optional.gap", {
              quota: formatNumber(calendar.optional_holiday_quota),
            })}
          </Notice>
        ) : null}

        <div className="mt-4">
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.holiday.id}
            pageSize={50}
            emptyState={
              <EmptyState
                icon={CalendarHeart}
                title={t("holidays.empty.title", {
                  year: String(calendar?.year ?? nowIstDate().slice(0, 4)),
                })}
                hint={t("holidays.empty.hint")}
              />
            }
          />
        </div>

        <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t("holidays.forYou.note")}</span>
        </p>
      </StateBoundary>
    </div>
  );
}
