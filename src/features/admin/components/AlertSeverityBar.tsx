/**
 * AlertSeverityBar — the open exception queue, split by the server's own severity.
 *
 * ── WHY A PICTURE, HERE, ON A SCREEN THAT IS OTHERWISE ALL NUMBERS ─────────
 *
 * The card above it already says "37 open", and 37 is not a decision. "Four of
 * them are critical" is. The feed below shows the eight most urgent rows, so on a
 * busy morning the SHAPE of the queue — is this one payroll emergency or thirty
 * information notices — was invisible until somebody paged through
 * `/admin/alerts`. Severity is the axis an administrator triages on, so it is the
 * one thing worth drawing beside the total rather than under a filter.
 *
 * ── IT COMPUTES NOTHING ────────────────────────────────────────────────────
 *
 * Three `count=exact` reads of `v_exception_queue`, each carrying the SAME
 * predicate as the `/admin/alerts?severity=…` screen its legend opens — the rule
 * every other figure on this console is built on (DR-29). The bar turns those
 * three counts into three widths and stops there: it never sums them, never
 * prints a percentage, and takes nothing from the eight rows in the feed (which
 * are a `limit`, not a census, and would have been the wrong denominator).
 *
 * The three severities are exhaustive BY CONSTRUCTION: every one of the eight
 * branches of the view emits a literal 'critical', 'warning' or 'info', so the bar
 * accounts for the whole queue and cannot silently drop a fourth bucket.
 *
 * ── COLOUR IS THE CHIP'S COLOUR ────────────────────────────────────────────
 *
 * `SEVERITY_CHIP` makes critical danger, warning warn and info info; the chart
 * tones below resolve to those same three tokens. A red segment and the red chip
 * on the row underneath have to mean the same thing, or the reader is holding two
 * mappings at once.
 *
 * ── AND IT STAYS QUIET WHEN IT CANNOT BE HONEST ────────────────────────────
 *
 * If any of the three counts is still loading or cannot be read, this renders
 * NOTHING: a bar drawn from two of three counts misstates the shape of the queue,
 * and the card already says "the open count could not be read" in words. An empty
 * queue gets no bar either — there is no shape to show, and the feed's own empty
 * state says so.
 */
import { Link } from "react-router-dom";
import { SplitBar } from "@/shared/ui/charts/SplitBar";
import { CHART_TONE, type ChartTone } from "@/shared/ui/charts/chartTokens";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AlertFilters } from "../api/command.api";
import { ADMIN_ROUTES } from "../command-vocab";
import { useAlertCount } from "../hooks/useCommandCentre";

/* Module constants so each hook keeps one stable filter object across renders. */
const CRITICAL_FILTER: AlertFilters = { severities: ["critical"] };
const WARNING_FILTER: AlertFilters = { severities: ["warning"] };
const INFO_FILTER: AlertFilters = { severities: ["info"] };

export function AlertSeverityBar() {
  const critical = useAlertCount(CRITICAL_FILTER);
  const warning = useAlertCount(WARNING_FILTER);
  const info = useAlertCount(INFO_FILTER);

  const queries = [critical, warning, info];
  if (queries.some((query) => query.isPending || query.error !== null)) return null;

  const rows: readonly {
    severity: string;
    label: string;
    drill: string;
    tone: ChartTone;
    count: number;
  }[] = [
    {
      severity: "critical",
      label: t("admin.alert.severity.critical"),
      drill: t("admin.cc.alerts.mix.drill.critical"),
      // `absent` is the destructive token — the same red as the critical chip.
      tone: "absent",
      count: critical.data ?? 0,
    },
    {
      severity: "warning",
      label: t("admin.alert.severity.warning"),
      drill: t("admin.cc.alerts.mix.drill.warning"),
      // `late` is the warning token.
      tone: "late",
      count: warning.data ?? 0,
    },
    {
      severity: "info",
      label: t("admin.alert.severity.info"),
      drill: t("admin.cc.alerts.mix.drill.info"),
      // `leave` is the info token.
      tone: "leave",
      count: info.data ?? 0,
    },
  ];

  if (rows.every((row) => row.count === 0)) return null;

  return (
    <div className="rounded-lg border bg-card p-3">
      <SplitBar
        segments={rows.map((row) => ({
          key: row.severity,
          label: row.label,
          value: row.count,
          tone: row.tone,
        }))}
        title={t("admin.cc.alerts.mix.title")}
        format={formatNumber}
        /* The kit's own legend is plain text. This screen's rule is that every
           number opens, so the legend is rebuilt below as three links. */
        legend={false}
        height={8}
      />
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {rows.map((row) => (
          <li key={row.severity}>
            <Link
              to={ADMIN_ROUTES.alertsBySeverity(row.severity)}
              aria-label={row.drill}
              className="flex items-center gap-1.5 rounded text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: CHART_TONE[row.tone] }}
              />
              <span className="text-muted-foreground">{row.label}</span>
              <span className="num font-medium">{formatNumber(row.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
