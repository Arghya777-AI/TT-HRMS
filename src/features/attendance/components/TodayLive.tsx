/**
 * TodayLive — today, while it is still happening.
 *
 * ── WHY A LIVE PANEL AT ALL ──────────────────────────────────────────────────
 * Every other figure in this product is retrospective: the engine computes a day after it
 * closes, so until tomorrow the register shows "Not processed yet" and the person has no way to
 * know where they stand. The question people actually have at 4pm is "how much longer do I
 * need to be here", and nothing on screen answered it.
 *
 * ── THE COUNTDOWN, AND WHY IT FLIPS ──────────────────────────────────────────
 * One figure does the work of two. While there is time left it counts DOWN to zero — "2h 48m
 * left" — and the moment it crosses, it becomes "+15m over" in green. That is the same number
 * throughout, and it means a person never has to work out which of two figures applies to them
 * right now.
 *
 * Showing a raw variance instead would read "−8h 40m" at half past ten, which is arithmetically
 * true and useless: it looks like a deficit somebody is accruing rather than a day in progress.
 *
 * ── WHAT IS LIVE AND WHAT IS THE ENGINE'S ────────────────────────────────────
 * The ticking figures are measured on this device from the arrival punch, so they move without
 * a round trip. They are an ESTIMATE and labelled as one: breaks are subtracted only once the
 * engine has recorded them, and the engine's own `payable_worked_minutes` is what the register
 * and payroll use. Where the two differ, the engine is right — which is why this panel
 * disappears once the day has been computed rather than lingering to contradict it.
 */
import { useEffect, useState } from "react";
import { Clock, Hourglass, TrendingUp } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { fmtDurationHm, fmtTime, nowInstantIso } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import type { AttendanceDay } from "../api/attendance.api";
import type { SelfPunchState } from "../api/selfPunch.api";
import { dayVariance, fmtSignedMinutes } from "../lib/variance";

export interface TodayLiveProps {
  /** Today's row, when the engine has one. Carries the shift, and the breaks it has seen. */
  today: AttendanceDay | null;
  /** Live punch state — the arrival instant and whether they are currently in. */
  state: SelfPunchState | null;
}

/** Minutes between two instants, never negative. */
function minutesBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 60_000));
}

export function TodayLive({ today, state }: TodayLiveProps): React.JSX.Element | null {
  /*
    One interval, one re-render a minute. Not a second: every figure here is shown to the
    minute, so a per-second tick would be sixty times the renders for no visible difference —
    and this panel sits above a table that is expensive to re-render.
  */
  const [now, setNow] = useState(nowInstantIso);
  useEffect(() => {
    const id = window.setInterval(() => setNow(nowInstantIso()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const arrival = state?.firstPunchAt ?? today?.first_in_at ?? null;
  // Nothing to say before the first scan of the day. The punch card already invites it.
  if (arrival === null) return null;

  const onSite = minutesBetween(arrival, now);
  // Breaks come from the engine, so they are only subtracted once it has seen them. Stated in
  // the footnote rather than silently changing the number people watched all afternoon.
  const breaks = today?.break_minutes ?? 0;
  const worked = Math.max(0, onSite - breaks);

  const expected = today !== null ? dayVariance(today).expectedMinutes : 0;
  const remaining = expected - worked;
  const late = today?.late_minutes ?? 0;

  const figures: {
    key: string;
    icon: typeof Clock;
    label: string;
    value: string;
    tone?: string;
    hint?: string;
  }[] = [
    {
      key: "worked",
      icon: Clock,
      label: t("attendance.live.worked"),
      value: fmtDurationHm(worked),
      hint: t("attendance.live.workedHint", { since: fmtTime(arrival) }),
    },
  ];

  /*
    THE COUNTDOWN. Down to zero, then over — one figure, two meanings, no ambiguity about which
    applies. Only shown when the day expects something: on a holiday or a full leave day there is
    nothing to count towards, and "0m left" would be nonsense.
  */
  if (expected > 0) {
    figures.push(
      remaining > 0
        ? {
          key: "remaining",
          icon: Hourglass,
          label: t("attendance.live.remaining"),
          value: fmtDurationHm(remaining),
          tone: "text-foreground",
          hint: t("attendance.live.remainingHint", { expected: fmtDurationHm(expected) }),
        }
        : {
          key: "over",
          icon: TrendingUp,
          label: t("attendance.live.over"),
          value: fmtSignedMinutes(-remaining),
          tone: "text-success",
          hint: t("attendance.live.overHint", { expected: fmtDurationHm(expected) }),
        },
    );
  }

  if (late > 0) {
    figures.push({
      key: "late",
      icon: Clock,
      label: t("attendance.live.late"),
      value: fmtDurationHm(late),
      tone: "text-warning",
      hint: t("attendance.live.lateHint"),
    });
  }

  return (
    <section
      className="rounded-xl border bg-card p-4"
      aria-label={t("attendance.live.aria")}
      aria-live="off"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-semibold">{t("attendance.live.title")}</h3>
        <span className="text-[11px] text-muted-foreground">
          {t("attendance.live.since", { time: fmtTime(arrival) })}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {figures.map((f) => (
          <div key={f.key}>
            <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <f.icon className="size-3.5 shrink-0" aria-hidden />
              {f.label}
            </dt>
            <dd
              className={cn("mt-0.5 font-mono text-xl font-semibold tabular-nums", f.tone)}
              title={f.hint}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      {/*
        Says plainly that these are this device's figures, not the record. The engine computes
        the day after it closes and that is what payroll uses; a panel that implied otherwise
        would be setting up a disagreement nobody could resolve.
      */}
      <p className="mt-3 border-t pt-3 text-[11px] leading-snug text-muted-foreground">
        {breaks > 0
          ? t("attendance.live.footnoteBreaks", { breaks: fmtDurationHm(breaks) })
          : t("attendance.live.footnote")}
      </p>
    </section>
  );
}
