/**
 * BucketDrillDown — the people behind a number on the department subtotals table.
 *
 * Click "43" under People, or "1" under Late, or the department name itself, and this opens
 * underneath the row and names them.
 *
 * ── WHY IT IS INSTANT ────────────────────────────────────────────────────────
 * It issues NO query for present / late / absent / people / overtime. Everything shown for
 * those — name, code, department, both scan times, worked minutes, lateness, overtime — was
 * already fetched by the board for every visible row, so opening a panel is a filter over an
 * array already in memory. That is the whole reason `bucketMembers` lives in
 * `departmentTotals.ts` beside the counting rather than being asked of the server.
 *
 * On leave is the one exception, and it is lazy: `v_attendance_today_board` knows the status is
 * `on_leave` but carries no request, and the dates and the reason live on the request. So opening
 * an on-leave list fires ONE query scoped to the few employees in that bucket. See
 * `leave-on-date.api.ts`.
 *
 * ── THE NUMBERS CANNOT DISAGREE WITH THE LIST ────────────────────────────────
 * `bucketMembers` uses the same predicates as the counter, in the same file, and a test asserts
 * for every department and metric that the member count equals the printed figure. A panel that
 * says five under a cell that says four is worse than no panel: the reader cannot tell which to
 * believe.
 *
 * ── THE CLOCK MOVES ──────────────────────────────────────────────────────────
 * "On site" ticks every second from the first scan for anybody still in — 1h 00m 01s,
 * 1h 00m 02s. Break time is included, which is why the column is labelled on-site rather than
 * worked: the engine's `worked_minutes` deducts the unpaid break and is shown beside it, so the
 * paid figure and the wall-clock figure are both visible and never confused.
 *
 * ── EVERY NAME IS A DOOR ─────────────────────────────────────────────────────
 * The employee name links to their full record, so the panel is a way in rather than a dead end.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import { fmtDurationHm } from "@/lib/datetime";
import type { BoardRow } from "../attendanceBoard";
import { bucketMembers, sortMembers, type BucketMetric } from "../departmentTotals";
import { elapsedOnSite, formatElapsed } from "../liveWorked";
import { useTick } from "../hooks/useTick";
import { useLeaveOnDate } from "../hooks/useLeaveOnDate";
import type { LeaveOnDate } from "../api/leave-on-date.api";

export interface BucketDrillDownProps {
  readonly rows: readonly BoardRow[];
  readonly metric: BucketMetric;
  /** `undefined` = every department (the all-departments row); `null` = the unassigned bucket. */
  readonly departmentName?: string | null;
  /** The date the board is showing, for the leave lookup. */
  readonly istDate: string;
  readonly columnCount: number;
}

export function BucketDrillDown({
  rows,
  metric,
  departmentName,
  istDate,
  columnCount,
}: BucketDrillDownProps): React.JSX.Element {
  const members = useMemo(
    () => sortMembers(bucketMembers(rows, metric, departmentName), metric),
    [rows, metric, departmentName],
  );

  // Only asked for when an on-leave list is actually open — see the header.
  const leaveIds = useMemo(
    () => (metric === "onLeave" ? members.map((m) => m.employeeId) : []),
    [metric, members],
  );
  const leave = useLeaveOnDate(leaveIds, istDate, metric === "onLeave");
  const leaveByEmployee = useMemo(() => {
    const map = new Map<string, LeaveOnDate[]>();
    for (const row of leave.data ?? []) {
      const list = map.get(row.employee_id) ?? [];
      list.push(row);
      map.set(row.employee_id, list);
    }
    return map;
  }, [leave.data]);

  const anyRunning = members.some((m) => m.firstInAt !== null && m.lastOutAt === null && m.yetToReach !== null);
  const nowMs = useTick(anyRunning);

  return (
    <tr className="bg-muted/30">
      <td colSpan={columnCount} className="px-4 py-3">
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("admin.board.drill.nobody")}</p>
        ) : (
          <>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t("admin.board.drill.heading", {
                n: formatNumber(members.length),
                what: t(METRIC_LABEL[metric]),
                where: departmentName ?? t("admin.board.dept.all"),
              })}
            </p>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                      {t("admin.board.drill.person")}
                    </th>
                    {metric === "onLeave" ? (
                      <>
                        <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                          {t("admin.board.drill.leaveType")}
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                          {t("admin.board.drill.leaveSpan")}
                        </th>
                        <th scope="col" className="py-1.5 text-left font-medium">
                          {t("admin.board.drill.leaveReason")}
                        </th>
                      </>
                    ) : (
                      <>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                          {t("admin.board.drill.firstScan")}
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                          {t("admin.board.drill.lastScan")}
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                          {t("admin.board.drill.onSite")}
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                          {t("admin.board.drill.worked")}
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                          {t("admin.board.drill.lateBy")}
                        </th>
                        <th scope="col" className="py-1.5 text-right font-medium">
                          {t("admin.board.dept.overtime")}
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const live = m.yetToReach !== null;
                    const elapsed = elapsedOnSite({
                      firstInAt: m.firstInAt,
                      lastOutAt: m.lastOutAt,
                      nowMs,
                      isLive: live,
                    });
                    const theirLeave = leaveByEmployee.get(m.employeeId) ?? [];
                    return (
                      <tr key={`${m.employeeId}-${m.istDate}`} className="border-b last:border-0">
                        <td className="py-1.5 pr-3">
                          {/* A door, not a dead end: the whole record is one click away. */}
                          <Link
                            to={`/admin/people/${encodeURIComponent(m.employeeCode)}`}
                            className="group inline-flex items-center gap-1 font-medium hover:underline"
                          >
                            {m.displayName}
                            <ChevronRight className="size-3 opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
                          </Link>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {m.employeeCode}
                            {departmentName === undefined && m.departmentName !== null
                              ? ` · ${m.departmentName}`
                              : ""}
                          </span>
                        </td>

                        {metric === "onLeave" ? (
                          <>
                            <td className="py-1.5 pr-3">
                              {leave.isPending ? (
                                <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
                              ) : (
                                theirLeave.map((l) => l.leave_types?.name ?? "—").join(", ") || "—"
                              )}
                            </td>
                            <td className="py-1.5 pr-3 tabular-nums">
                              {theirLeave
                                .map((l) => `${l.from_date} → ${l.to_date}`)
                                .join(", ") || "—"}
                            </td>
                            <td className="py-1.5 text-muted-foreground">
                              {theirLeave.map((l) => l.reason ?? "—").join(" / ") || "—"}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="num py-1.5 pr-3 text-right tabular-nums">
                              {m.firstInHm ?? "—"}
                            </td>
                            <td className="num py-1.5 pr-3 text-right tabular-nums">
                              {m.lastOutHm ?? "—"}
                            </td>
                            {/* The moving one. `running` gets the accent so it reads as live. */}
                            <td
                              className={cn(
                                "num py-1.5 pr-3 text-right tabular-nums",
                                elapsed.running && "font-medium text-primary",
                              )}
                            >
                              {formatElapsed(elapsed)}
                            </td>
                            <td className="num py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                              {m.workedMinutes > 0 ? fmtDurationHm(m.workedMinutes) : "—"}
                            </td>
                            <td className="num py-1.5 pr-3 text-right tabular-nums">
                              {m.lateMinutes > 0 ? (
                                <span className="text-warning">{fmtDurationHm(m.lateMinutes)}</span>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="num py-1.5 text-right tabular-nums">
                              {m.overtimeMinutes > 0 ? fmtDurationHm(m.overtimeMinutes) : "—"}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {metric !== "onLeave" ? (
              <p className="mt-2 text-[0.65rem] text-muted-foreground">
                {t("admin.board.drill.onSiteNote")}
              </p>
            ) : null}
            {leave.error !== null && metric === "onLeave" ? (
              <p className="mt-2 text-xs text-destructive">{t("admin.board.drill.leaveFailed")}</p>
            ) : null}
          </>
        )}
      </td>
    </tr>
  );
}

const METRIC_LABEL: Readonly<Record<BucketMetric, Parameters<typeof t>[0]>> = {
  employees: "admin.board.dept.people",
  present: "admin.board.dept.present",
  late: "admin.board.dept.late",
  onLeave: "admin.board.dept.leave",
  absent: "admin.board.dept.absent",
  overtime: "admin.board.dept.overtime",
};
