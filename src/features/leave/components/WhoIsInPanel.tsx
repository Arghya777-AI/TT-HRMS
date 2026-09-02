/**
 * WhoIsInPanel — who is at the venue today, and who is working from elsewhere.
 *
 * ── WHAT THE THREE GROUPS MEAN ───────────────────────────────────────────────
 * Decided by how the punch was taken, not by a coordinate comparison:
 *
 *   At the venue    a gate scan today. The tablet is fixed to a known wall, so a gate scan
 *                   IS the venue — the strongest evidence available, needing no fence.
 *   Working away    punches today, none from the gate. Recorded from a phone or a laptop.
 *   Not in          no punch. Split further, because "on leave" and "has not arrived" are
 *                   different facts and only one of them is worth acting on.
 *
 * `geofence_ok` is deliberately unused: a web punch from the car park is inside the fence and
 * still is not somebody at their desk.
 *
 * ── WHY IT SHOWS NO TIMES BEYOND ARRIVAL ─────────────────────────────────────
 * The view carries no lateness, no worked minutes and no paid fraction, so this cannot show
 * them. "In since 09:20" is how a person says somebody is here; how late they were is between
 * them and their manager.
 */
import { useMemo } from "react";
import { Building2, Globe, UserMinus } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { usePresenceRoster } from "../hooks/useLeaveApply";
import type { PresenceRosterRow } from "../api/leave-apply.api";

/** Day statuses that mean "away, and that is arranged" rather than "not here yet". */
const AWAY_STATUSES = new Set([
  "on_leave",
  "on_leave_half",
  "comp_off_availed",
  "weekly_off",
  "holiday",
]);

interface Group {
  readonly key: string;
  readonly icon: typeof Building2;
  readonly label: string;
  readonly tone: string;
  readonly rows: readonly PresenceRosterRow[];
}

export function WhoIsInPanel(): React.JSX.Element {
  const roster = usePresenceRoster();

  const groups = useMemo<Group[]>(() => {
    const rows = roster.data ?? [];
    const onCampus = rows.filter((r) => r.presence === "on_campus");
    const remote = rows.filter((r) => r.presence === "remote");
    /*
      Somebody on approved leave is not "not in" — they are away by arrangement, and the leave
      panel already names them. Keeping them out of this list stops the same person appearing
      twice on one screen saying two different things.
    */
    const notIn = rows.filter(
      (r) => r.presence === "not_in" && !AWAY_STATUSES.has(r.day_status),
    );
    return [
      {
        key: "on_campus",
        icon: Building2,
        label: t("leave.who.atVenue"),
        tone: "text-success",
        rows: onCampus,
      },
      { key: "remote", icon: Globe, label: t("leave.who.away"), tone: "text-foreground", rows: remote },
      {
        key: "not_in",
        icon: UserMinus,
        label: t("leave.who.notIn"),
        tone: "text-muted-foreground",
        rows: notIn,
      },
    ];
  }, [roster.data]);

  return (
    <section className="mt-6">
      <h2 className="font-display text-lg font-semibold">{t("leave.who.title")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("leave.who.subtitle")}</p>

      <StateBoundary
        loading={roster.isLoading}
        error={roster.error ?? undefined}
        onRetry={() => void roster.refetch()}
        skeletonRows={3}
      >
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.key} className="rounded-xl border bg-card p-3">
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                <g.icon className="size-3.5 shrink-0" aria-hidden />
                {g.label}
                <span className={cn("ml-auto font-mono text-sm font-semibold", g.tone)}>
                  {g.rows.length}
                </span>
              </p>

              {g.rows.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">{t("leave.who.none")}</p>
              ) : (
                /* Its own scroll box: fifty-one names must not push the calendar off the page. */
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
                  {g.rows.map((row) => (
                    <li key={row.employee_id} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{row.display_name}</span>
                        {row.department_name === null ? null : (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {row.department_name}
                          </span>
                        )}
                      </span>
                      {row.first_in_hm === null ? null : (
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {row.first_in_hm}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </StateBoundary>
    </section>
  );
}
