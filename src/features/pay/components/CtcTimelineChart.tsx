/**
 * CtcTimelineChart — E-08 Card C. Monthly CTC against the date each revision
 * took effect.
 *
 * The two defects this chart exists to not repeat (spec-screens S-10):
 *  - **X was categorical.** Two revisions 21 months apart sat side by side as
 *    equal-width slots, so a long wait looked like a short one. Here X is a
 *    genuine time scale (`type="number" scale="time"`), so the gap between
 *    Dec-2023 and Sep-2025 is 21 months wide.
 *  - **Y was raw (`0 … 300000`), no ₹, no grouping.** Here every tick is
 *    `lib/money` — `₹2,20,000` — the same formatter as the tables (DR-20).
 *
 * Y starts at zero. With two points 10% apart a zero baseline looks almost
 * flat, and that is the honest picture; the exact increment and percentage are
 * columns in the revisions table below, taken from the server.
 *
 * The dashed tail runs from the latest revision to today: it is not a forecast,
 * it says "this figure is still in force".
 *
 * Money is gated by the page-level session reveal — an axis of real rupees is a
 * salary disclosure like any other, so while amounts are masked the plot is not
 * drawn at all rather than drawn with the numbers scrubbed off.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState } from "@/shared/ui/EmptyState";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtMonth, istDayUtcBounds, nowIstDate } from "@/lib/datetime";
import { formatPaise } from "@/lib/money";
import { revisionKindLabel } from "../display";
import type { SalaryRevision } from "../api/pay.api";

export interface CtcTimelineChartProps {
  /** `v_salary_revisions` rows, oldest first (the api orders them). */
  revisions: readonly SalaryRevision[];
  revealed: boolean;
}

interface TimelinePoint {
  /** Epoch ms of IST midnight on `effective_from` — the time-scaled X value. */
  x: number;
  /** Monthly CTC in paise. Null on the synthetic "today" datum. */
  ctc: number | null;
  /** Same figure, non-null only on the last revision and today — the dashed tail. */
  toDate: number | null;
  effectiveFrom: string | null;
  kindLabel: string | null;
}

/** Epoch ms for a civil date, via lib/datetime — no `new Date(string)` here. */
function civilX(isoDate: string): number {
  return istDayUtcBounds(isoDate).startUtc.getTime();
}

export function CtcTimelineChart({ revisions, revealed }: CtcTimelineChartProps) {
  // Only APPROVED revisions are facts. A proposed one plotted as a point would
  // read as a pay rise the employee has not been granted.
  const approved = revisions.filter((r) => r.status === "approved");

  if (approved.length === 0) {
    return (
      <EmptyState
        title={t("pay.salary.cardC.empty.title")}
        hint={t("pay.salary.cardC.empty.hint")}
      />
    );
  }

  if (!revealed) {
    return (
      <div className="grid place-items-center rounded-lg border border-dashed px-6 py-10 text-center">
        <div className="max-w-xs">
          <p className="num font-display text-2xl font-semibold tracking-widest text-muted-foreground" aria-hidden>
            ₹•,••,•••
          </p>
          <h4 className="mt-3 text-sm font-semibold">{t("pay.reveal.gated.title")}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t("pay.reveal.gated.hint")}</p>
        </div>
      </div>
    );
  }

  const last = approved[approved.length - 1];
  const points: TimelinePoint[] = approved.map((r, i) => ({
    x: civilX(r.effective_from),
    ctc: r.monthly_ctc_paise,
    toDate: i === approved.length - 1 ? r.monthly_ctc_paise : null,
    effectiveFrom: r.effective_from,
    kindLabel: revisionKindLabel(r.revision_kind),
  }));

  const todayX = civilX(nowIstDate());
  const lastPoint = points[points.length - 1];
  if (last !== undefined && lastPoint !== undefined && todayX > lastPoint.x) {
    points.push({
      x: todayX,
      ctc: null,
      toDate: last.monthly_ctc_paise,
      effectiveFrom: nowIstDate(),
      kindLabel: null,
    });
  }

  const byX = new Map<number, TimelinePoint>(points.map((p) => [p.x, p]));
  const firstX = points[0]?.x ?? todayX;
  const lastX = points[points.length - 1]?.x ?? todayX;
  // A single revision would collapse the domain to one instant; give it a month
  // of air on each side so the point sits in the middle of a readable axis.
  const pad = Math.max((lastX - firstX) * 0.06, 15 * 86_400_000);
  const grid = "hsl(var(--border))";
  const series = "hsl(var(--chart-3))";
  const surface = "hsl(var(--card))";

  return (
    <figure className="m-0">
      {/* Line charts scroll in their own container below 768px (spec §8 mobile). */}
      <div className="overflow-x-auto">
        <div className="h-64 min-w-[520px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 12, right: 20, bottom: 4, left: 8 }}
              accessibilityLayer
            >
              <CartesianGrid stroke={grid} strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="x"
                type="number"
                scale="time"
                domain={[firstX - pad, lastX + pad]}
                tickFormatter={(value: number) => fmtMonth(value)}
                minTickGap={32}
                tick={{ fontSize: 12 }}
                stroke={grid}
                tickLine={false}
                className="fill-muted-foreground"
              />
              <YAxis
                type="number"
                domain={[0, "auto"]}
                tickFormatter={(value: number) => formatPaise(value, { paise: false })}
                width={92}
                tick={{ fontSize: 12 }}
                stroke={grid}
                tickLine={false}
                className="fill-muted-foreground"
              />
              <Tooltip
                cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 }}
                content={({ active, label }) => {
                  if (active !== true) return null;
                  const point = byX.get(Number(label));
                  if (point === undefined) return null;
                  const amount = point.ctc ?? point.toDate;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
                      <p className="font-medium">{fmtCivilDate(point.effectiveFrom)}</p>
                      <p className="num mt-0.5">
                        {t("pay.salary.cardC.axis")}: {formatPaise(amount)}
                      </p>
                      {point.kindLabel !== null ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{point.kindLabel}</p>
                      ) : (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("pay.salary.cardC.stillInForce")}
                        </p>
                      )}
                    </div>
                  );
                }}
              />
              {/* The dashed tail first, so the solid series draws over it. */}
              <Line
                type="linear"
                dataKey="toDate"
                stroke={series}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="ctc"
                stroke={series}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={{ r: 4, fill: series, stroke: surface, strokeWidth: 2 }}
                activeDot={{ r: 6, fill: series, stroke: surface, strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-muted-foreground">
        {t("pay.salary.cardC.caption")}
      </figcaption>
    </figure>
  );
}
