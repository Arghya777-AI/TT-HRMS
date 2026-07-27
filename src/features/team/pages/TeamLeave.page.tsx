/**
 * §D · /team/leave — Team Leave. Who is off when, across my team, one month at
 * a time, with the balance context beside it.
 *
 * Rules held here:
 *
 *  1. ONE ROW PER PERSON PER DATE. `v_leave_calendar` is already the expanded
 *     day grain, already excludes rejected/withdrawn requests, and `day_value`
 *     (1 or 0.5) is the server's figure for that date — printed, never summed.
 *  2. BALANCES ARE GENERATED COLUMNS. `available_days` and
 *     `available_after_pending` come off `leave_balances` exactly as the
 *     employee's own screen and the payroll engine read them, so a manager and
 *     their reportee can never see different numbers.
 *  3. COVERAGE IS NOT FAKED. The spec wants leave judged against booked events;
 *     no events/roster view exists server-side yet, so this page shows the
 *     per-date off-count honestly and says what is missing, rather than
 *     inventing a coverage figure.
 *
 * @route /team/leave
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtCivilDateWeekday, nowIstDate } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "@/features/admin/components/Notice";
import { PersonCell } from "@/features/admin/components/PersonCell";
import { MonthStepper } from "@/features/admin/components/MonthStepper";
import { SelectField } from "@/features/admin/components/Field";
import {
  isTeamLeaveSlice,
  type TeamLeaveBalance,
  type TeamLeaveDay,
  type TeamLeaveSlice,
} from "../api/team.api";
import {
  useTeamLeaveBalances,
  useTeamLeaveCount,
  useTeamLeaveDays,
  useTeamRoster,
} from "../hooks/useTeamDecisions";

const LEAVE_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  approved: { label: t("team.leave.status.approved"), tone: "success" },
  partially_approved: { label: t("team.leave.status.partiallyApproved"), tone: "success" },
  pending: { label: t("team.leave.status.pending"), tone: "warn" },
  cancellation_pending: { label: t("team.leave.status.cancellationPending"), tone: "warn" },
};

const PORTION_LABEL: Readonly<Record<string, string>> = {
  full_day: t("team.leave.portion.fullDay"),
  first_half: t("team.leave.portion.firstHalf"),
  second_half: t("team.leave.portion.secondHalf"),
};

const SLICES: readonly { value: TeamLeaveSlice; label: string }[] = [
  { value: "all", label: t("team.leave.slice.all") },
  { value: "approved", label: t("team.leave.slice.approved") },
  { value: "pending", label: t("team.leave.slice.pending") },
  { value: "cancellation_pending", label: t("team.leave.slice.cancellationPending") },
];

export default function TeamLeavePage() {
  const [params, setParams] = useSearchParams();
  const roster = useTeamRoster();
  // Memoised so downstream useMemo/useQuery deps get a stable reference while
  // the roster is loading, instead of a fresh [] every render.
  const employeeIds = useMemo(() => roster.data?.employeeIds ?? [], [roster.data]);

  const [month, setMonth] = useState(() => nowIstDate().slice(0, 7));
  const rawSlice = params.get("slice");
  const slice: TeamLeaveSlice = isTeamLeaveSlice(rawSlice) ? rawSlice : "all";

  const filters = useMemo(
    () => ({ month, employeeIds, ...(slice !== "all" ? { slice } : {}) }),
    [month, employeeIds, slice],
  );

  const leaveDays = useTeamLeaveDays(filters);
  const total = useTeamLeaveCount(
    { month, employeeIds },
    slice === "all" ? undefined : slice,
  );
  const balances = useTeamLeaveBalances(employeeIds);
  const rows = useMemo(() => leaveDays.data ?? [], [leaveDays.data]);

  const setSlice = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === "all" || !isTeamLeaveSlice(next)) p.delete("slice");
    else p.set("slice", next);
    setParams(p, { replace: true });
  };

  /**
   * The off-density strip: how many of MY team are off per date this month.
   * Grouping loaded day-grain rows by date is presentation (each row is one
   * person-date, `day_value` untouched), not a business figure — the payable
   * arithmetic stays in the ledger.
   */
  const byDate = useMemo(() => {
    const map = new Map<string, TeamLeaveDay[]>();
    for (const r of rows) {
      const list = map.get(r.leave_date) ?? [];
      list.push(r);
      map.set(r.leave_date, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const nameOf = useMemo(() => {
    const map = new Map<string, { name: string; code: string }>();
    for (const m of roster.data?.members ?? [])
      map.set(m.id, { name: m.display_name ?? "", code: m.employee_code ?? "" });
    return map;
  }, [roster.data]);

  /** Balance rows pivoted per person for the side panel. */
  const balancesByPerson = useMemo(() => {
    const map = new Map<string, TeamLeaveBalance[]>();
    for (const b of balances.data ?? []) {
      const list = map.get(b.employee_id) ?? [];
      list.push(b);
      map.set(b.employee_id, list);
    }
    return map;
  }, [balances.data]);

  const columns: DataGridColumn<TeamLeaveDay>[] = [
    {
      key: "leave_date",
      header: t("team.leave.col.date"),
      width: "11rem",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDateWeekday(r.leave_date)}</span>,
    },
    {
      key: "display_name",
      header: t("team.leave.col.who"),
      width: "13rem",
      sortable: true,
      render: (r) => <PersonCell name={r.display_name} code={r.employee_code} />,
    },
    {
      key: "leave_type_name",
      header: t("team.leave.col.type"),
      render: (r) => dash(r.leave_type_name),
    },
    {
      key: "portion",
      header: t("team.leave.col.portion"),
      width: "8rem",
      hideBelow: "md",
      render: (r) => PORTION_LABEL[r.portion] ?? r.portion,
    },
    {
      key: "day_value",
      header: t("team.leave.col.dayValue"),
      align: "right",
      width: "6rem",
      hideBelow: "lg",
      // The server's value for the date (1 or 0.5) — printed as-is.
      render: (r) => <span className="num">{formatDays(r.day_value)}</span>,
    },
    {
      key: "status",
      header: t("team.leave.col.status"),
      width: "10rem",
      render: (r) => <StatusChip status={r.status} map={LEAVE_STATUS_CHIP} />,
    },
    {
      key: "request_number",
      header: t("team.leave.col.request"),
      hideBelow: "lg",
      render: (r) => <span className="num text-xs">{r.request_number}</span>,
    },
  ];

  const noTeam = roster.data?.isEmpty === true;

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("team.leave.title")}
        subtitle={
          total.isSuccess
            ? t("team.leave.subtitle", { n: formatNumber(total.data) })
            : t("team.leave.subtitlePlain")
        }
        actions={<MonthStepper month={month} onChange={setMonth} />}
      />

      {noTeam ? (
        <div className="mt-6">
          <EmptyState
            icon={Users}
            title={t("team.leave.noTeam.title")}
            hint={t("team.leave.noTeam.hint")}
          />
        </div>
      ) : (
        <>
          {/* Off-density: which dates this month have someone away. */}
          <section className="mt-4 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold">{t("team.leave.density.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("team.leave.density.hint")}</p>
            {byDate.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t("team.leave.density.empty")}</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {byDate.map(([date, list]) => (
                  <li
                    key={date}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs",
                      list.length > 1 ? "border-warning/60 bg-warning/10" : "bg-muted/40",
                    )}
                    title={list.map((r) => r.display_name ?? "").join(", ")}
                  >
                    <span className="num font-medium">{fmtCivilDateWeekday(date)}</span>
                    <span className="ml-2 text-muted-foreground">
                      {t("team.leave.density.off", { n: formatNumber(list.length) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("team.leave.density.noEvents")}</p>
          </section>

          <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
            <SelectField
              label={t("team.leave.filter.state")}
              value={slice}
              options={SLICES.map((s) => ({ value: s.value, label: s.label }))}
              onChange={setSlice}
            />
            <div className="flex items-end">
              {slice !== "all" ? (
                <Button variant="ghost" onClick={() => setSlice("all")}>
                  {t("team.leave.filter.clear")}
                </Button>
              ) : null}
            </div>
            <div className="flex items-end justify-end">
              <p className="text-sm text-muted-foreground">
                {total.isSuccess
                  ? t("team.leave.matching", { n: formatNumber(total.data) })
                  : t("team.leave.matchingUnknown")}
              </p>
            </div>
          </div>

          <div className="mt-4">
            <StateBoundary
              loading={leaveDays.isPending || roster.isPending}
              error={leaveDays.error ?? roster.error}
              onRetry={() => void leaveDays.refetch()}
              isEmpty={rows.length === 0}
              partialError={total.error}
              partialLabel={t("team.leave.partial.total")}
              empty={
                <EmptyState
                  icon={CalendarDays}
                  title={t("team.leave.empty.title")}
                  hint={t("team.leave.empty.hint")}
                />
              }
            >
              <DataGrid
                columns={columns}
                rows={rows}
                rowKey={(r) => r.leave_request_day_id}
                pageSize={31}
              />
            </StateBoundary>
          </div>

          {/* Balance context per reportee — GENERATED columns, printed as-is. */}
          <section className="mt-4 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold">{t("team.leave.balances.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("team.leave.balances.hint")}</p>
            <StateBoundary
              loading={balances.isPending}
              error={balances.error}
              onRetry={() => void balances.refetch()}
              isEmpty={(balances.data ?? []).length === 0}
              empty={
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("team.leave.balances.empty")}
                </p>
              }
              skeletonRows={3}
            >
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {[...balancesByPerson.entries()].map(([employeeId, list]) => {
                  const who = nameOf.get(employeeId);
                  return (
                    <div key={employeeId} className="rounded-md border p-3">
                      <PersonCell name={who?.name} code={who?.code} />
                      <dl className="mt-2 space-y-1">
                        {list.map((b) => (
                          <div
                            key={b.leave_type_id}
                            className="flex items-baseline justify-between gap-2 text-sm"
                          >
                            <dt className="text-muted-foreground">{b.leave_type_name}</dt>
                            <dd className="num">
                              {t("team.leave.balances.value", {
                                available: formatDays(b.available_after_pending),
                                entitled: formatDays(b.entitlement_days),
                              })}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  );
                })}
              </div>
            </StateBoundary>
          </section>

          <div className="mt-4">
            <Notice tone="info">{t("team.leave.footnote")}</Notice>
          </div>
        </>
      )}
    </div>
  );
}
