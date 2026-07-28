/**
 * PlannedMetricCard — a metric the product intends to show, honestly rendered while
 * its data source does not exist yet.
 *
 * WHY NOT JUST SHOW A DASH
 * ------------------------
 * Because "—" and "0" are claims. On a dashboard, a tile that looks like every other
 * tile is read as a measurement, and a zero is read as *the answer is zero*. "Open
 * positions: 0" tells an HR head there is no hiring underway; the truth is that nobody
 * has built a requisition table. Those are opposite conclusions from the same pixel.
 *
 * So this card is deliberately NOT tile-shaped. It is muted, it carries a "not
 * collected yet" chip, it states the question it will answer, and it names what has to
 * exist for it to start answering. Nobody can mistake it for a number, and nobody has
 * to go and ask why a figure is blank.
 *
 * IT DISAPPEARS BY ITSELF. `useMetricSourceState` probes the declared relation; the
 * moment it holds rows the caller renders the real metric instead. There is no flag to
 * remember to flip, which is the usual reason placeholders outlive their purpose by a
 * year.
 */
import { Clock3, Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { t } from "@/shared/i18n/en";
import type { MetricSourceState, PlannedMetric } from "../analyticsCapabilities";

export function PlannedMetricCard({
  metric,
  state,
}: {
  metric: PlannedMetric;
  /** `live` should never reach here — the caller renders the real metric instead. */
  state: Exclude<MetricSourceState, "live">;
}) {
  const awaiting = state === "awaiting";
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/30 p-4"
      // Not a figure: announced as a note so a screen reader does not read it as data.
      role="note"
      aria-label={`${metric.label} — ${t("admin.analytics.planned.aria")}`}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{metric.label}</h3>
        <Badge variant="neutral" className="shrink-0">
          {awaiting ? t("admin.analytics.planned.awaiting") : t("admin.analytics.planned.notCollected")}
        </Badge>
      </header>

      {/*
        The QUESTION, not a number. This is what makes the card useful rather than an
        apology: a reader learns what the dashboard will be able to tell them.
      */}
      <p className="text-sm text-foreground/80">{metric.question}</p>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        {awaiting ? (
          <Clock3 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        ) : (
          <Database className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        )}
        <span>
          {awaiting
            ? t("admin.analytics.planned.awaitingHint", { relation: metric.relation ?? "" })
            : metric.enabledBy}
        </span>
      </p>
    </article>
  );
}
