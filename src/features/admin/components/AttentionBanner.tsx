/**
 * AttentionBanner — the red bar at the top of the Command Centre.
 *
 * "An admin should also see what happens immediately after first login… it should clearly
 * indicate '6 needs your attention'." That is the whole brief, and the two words doing the
 * work are CLEARLY and IMMEDIATELY: this sits above the calendar and the KPI strip, because
 * everything below it answers "what is true", and this answers "what is undone".
 *
 * ── RED IS EARNED, NOT DECORATIVE ────────────────────────────────────────────
 * The bar is `destructive` only when something is actually blocked on this administrator —
 * an approval, an alert, a scan to review, a capture to decide. Chasing work (people who have
 * not shown their face yet) and housekeeping (documents expiring) are real but nobody is
 * waiting on a decision, so they render warning-toned. A bar that is red every single day
 * stops being read, which is how the notification feed got to 17,890 unread.
 *
 * ── IT RENDERS NOTHING WHEN THERE IS NOTHING ─────────────────────────────────
 * No "all clear" banner. A console that congratulates you daily trains you to skip the top of
 * the page, and the one morning it says something you skip that too. It is also silent while
 * the counts are still loading rather than showing a zero it would have to correct.
 */
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { headlineKey } from "../attention";
import type { AdminAttention } from "../hooks/useAdminAttention";

export function AttentionBanner({
  attention,
}: {
  readonly attention: AdminAttention;
}): React.JSX.Element | null {
  if (attention.isPending || attention.items.length === 0) return null;

  const urgent = attention.urgent;

  return (
    <section
      aria-labelledby="attention-heading"
      className={cn(
        "rounded-lg border p-4",
        urgent ? "border-destructive/50 bg-destructive/5" : "border-warning/50 bg-warning/5",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <AlertTriangle
          className={cn("mt-0.5 h-5 w-5 shrink-0", urgent ? "text-destructive" : "text-warning")}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h2
            id="attention-heading"
            className={cn(
              "font-display text-lg font-semibold",
              urgent ? "text-destructive" : "text-warning",
            )}
          >
            {t(headlineKey(attention), { n: formatNumber(attention.headline) })}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("admin.attention.subtitle")}
            {/* Named separately so the headline can stay small without hiding the backlog. */}
            {attention.urgent && attention.followUpCount > 0
              ? ` ${t("admin.attention.alsoFollowUp", {
                  n: formatNumber(attention.followUpCount),
                })}`
              : ""}
          </p>

          {/* Every row opens the screen that clears it — the count and its destination are
              built from the same predicate, so the list there is exactly this number long. */}
          <ul className="mt-3 flex flex-wrap gap-2">
            {attention.items.map((item) => (
              <li key={item.key}>
                <Link
                  to={item.href}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    item.tone === "act"
                      ? "border-destructive/40 bg-background text-destructive hover:bg-destructive/10"
                      : "border-warning/40 bg-background text-foreground hover:bg-warning/10",
                  )}
                >
                  {t(item.labelKey, { n: formatNumber(item.count) })}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
