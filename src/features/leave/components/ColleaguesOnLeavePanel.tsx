/**
 * ColleaguesOnLeavePanel — who is on approved leave, from today onwards.
 *
 * ── WHY IT IS FORWARD-LOOKING AND THE CALENDAR VERSION IS NOT ────────────────
 * The leave calendar shows the month you are browsing, because you went there to browse. On the
 * home page nobody is browsing: the question is "who is off, now and soon", so this starts
 * today and runs four weeks out. Leave that ended yesterday is not news.
 *
 * The leave TYPE is named, which the venue decided knowing it discloses Sick Leave and
 * Maternity Leave to colleagues. Reads `v_leave_roster` — see that view for what it deliberately
 * does not expose.
 */
import { useMemo } from "react";
import { CalendarOff } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { addIstDays, fmtCivilDayMonthWeekday, istToday } from "@/lib/datetime";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { useLeaveRoster } from "../hooks/useLeaveApply";
import { isHalfDay, portionShort } from "../leavePortion";
import type { LeaveRosterRow } from "../api/leave-apply.api";

/** Four weeks. Far enough to plan a handover, short enough to stay a glance. */
const WINDOW_DAYS = 28;

export function ColleaguesOnLeavePanel(): React.JSX.Element {
  const from = istToday();
  const to = addIstDays(from, WINDOW_DAYS);
  const roster = useLeaveRoster(from, to);

  const byDate = useMemo(() => {
    const out = new Map<string, LeaveRosterRow[]>();
    for (const row of roster.data ?? []) {
      const bucket = out.get(row.leave_date);
      if (bucket === undefined) out.set(row.leave_date, [row]);
      else bucket.push(row);
    }
    return out;
  }, [roster.data]);

  return (
    <section className="mt-4 rounded-xl border bg-card p-4">
      <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
        <CalendarOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {t("leave.onLeaveSoon.title")}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("leave.onLeaveSoon.subtitle")}</p>

      <StateBoundary
        loading={roster.isLoading}
        error={roster.error ?? undefined}
        onRetry={() => void roster.refetch()}
        skeletonRows={2}
      >
        {byDate.size === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("leave.onLeaveSoon.empty")}</p>
        ) : (
          /* Its own scroll box: four weeks of a venue's leave must not push the page down. */
          <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            {[...byDate.entries()].map(([date, rows]) => (
              <li key={date}>
                <p className="text-[11px] font-medium text-muted-foreground">
                  {fmtCivilDayMonthWeekday(date)}
                  {date === from ? ` · ${t("leave.onLeaveSoon.today")}` : ""}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {rows.map((row) => (
                    <span
                      key={row.leave_request_day_id}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.colour_hex ?? "currentColor" }}
                      />
                      <span className="font-medium">{row.display_name}</span>
                      <span className="text-muted-foreground">{row.leave_type_name}</span>
                      {isHalfDay(row.portion) ? (
                        <span className="rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">
                          {portionShort(row.portion)}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </StateBoundary>
    </section>
  );
}
