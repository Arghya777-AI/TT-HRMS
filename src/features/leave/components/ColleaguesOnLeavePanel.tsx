/**
 * ColleaguesOnLeavePanel — who is away, grouped by department.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT SHOW ─────────────────────────────────────
 * Arrival times, departure times, who is on site. A "who is in today" panel sat beside this one
 * briefly and was removed at the venue's instruction: colleagues are not to see each other's
 * hours. That belongs to the person and their manager, and it lives on the admin dashboard.
 *
 * So this answers exactly one question — who is off — and carries only the leave type and
 * whether it is a half day.
 *
 * ── WHY DEPARTMENT AND NOT DATE ──────────────────────────────────────────────
 * The first version grouped by date, which is how a calendar thinks. Asked for instead: sections
 * by department, Management first. That is how a venue thinks — "is anyone from Restaurant off
 * today" is answerable at a glance, where a flat list of forty names is not.
 *
 * Management leads because it was asked for; the rest follow by headcount so the biggest team is
 * next, and by name after that so the order never wobbles between renders.
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

/** Pinned first, by name — the section the venue reads first. */
const LEAD_DEPARTMENT = "Management";

interface DeptSection {
  readonly key: string;
  readonly name: string;
  readonly rows: readonly LeaveRosterRow[];
}

export function ColleaguesOnLeavePanel(): React.JSX.Element {
  const from = istToday();
  const to = addIstDays(from, WINDOW_DAYS);
  const roster = useLeaveRoster(from, to);

  const sections = useMemo<DeptSection[]>(() => {
    const buckets = new Map<string, LeaveRosterRow[]>();
    for (const row of roster.data ?? []) {
      // Keyed on the name, because that is what the heading shows and what the venue calls it.
      const key = row.department_name ?? t("leave.onLeaveSoon.noDept");
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [row]);
      else bucket.push(row);
    }
    const out = [...buckets.entries()].map(([name, rows]) => ({ key: name, name, rows }));
    out.sort((a, b) => {
      const lead = (s: DeptSection) => (s.name === LEAD_DEPARTMENT ? 0 : 1);
      return lead(a) - lead(b) || b.rows.length - a.rows.length || a.name.localeCompare(b.name);
    });
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
        {sections.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("leave.onLeaveSoon.empty")}</p>
        ) : (
          /* Its own scroll box: four weeks of a venue's leave must not push the page down. */
          <div className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
            {sections.map((section) => (
              <div key={section.key}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.name}
                  <span className="ml-1.5 font-normal">{section.rows.length}</span>
                </p>
                <ul className="mt-1 space-y-1">
                  {section.rows.map((row) => (
                    <li key={row.leave_request_day_id} className="flex items-baseline gap-2 text-sm">
                      <span
                        aria-hidden
                        className="mt-1.5 size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.colour_hex ?? "currentColor" }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{row.display_name}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {row.leave_type_name}
                        </span>
                        {isHalfDay(row.portion) ? (
                          <span className="ml-1.5 rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">
                            {portionShort(row.portion)}
                          </span>
                        ) : null}
                      </span>
                      {/* The date, because four weeks of leave is not all today. */}
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {row.leave_date === from
                          ? t("leave.onLeaveSoon.today")
                          : fmtCivilDayMonthWeekday(row.leave_date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
