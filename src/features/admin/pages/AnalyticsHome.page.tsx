/**
 * §14 · /admin/analytics — the analytics home. One tile per analytics screen,
 * each carrying a single headline figure and opening the screen that owns it.
 *
 * The discipline here is narrow on purpose: this page is a directory of
 * measures, not a dashboard that re-derives them. So
 *
 *  * every figure is a `count=exact` over the SAME relation the destination
 *    screen reads, or a single named column of it (`late_pct` off
 *    `v_attendance_late_trend`) — nothing on this page is summed or averaged;
 *  * a screen whose measure has no deployed relation shows an em dash and NAMES
 *    the missing piece. Three do: the metric dictionary has no
 *    `metric_definitions` table, scheduled reports has no `scheduled_reports`
 *    table, and the report builder is a P2 screen with nothing behind it yet.
 *    A plausible zero on any of those would be a lie about the backend;
 *  * every tile links. A number an administrator cannot open is a dead end
 *    (spec-admin §2.1), which is why `CountTile` demands a route.
 *
 * @route /admin/analytics
 */
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Skeleton } from "@/components/ui/skeleton";
import { dash, formatPercent } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { CountTile, type CountState } from "../components/CountTile";
import { AnalyticsOverview } from "../components/AnalyticsOverview";
import { Notice } from "../components/Notice";
import { unavailableHint } from "../command-vocab";
import {
  useAnalyticsHeadlines,
  type HeadlineQuery,
} from "../hooks/useAnalyticsWorkforce";
import type { HeadlineMeasure } from "../api/analytics-workforce.api";

/** A tile whose number is a server COUNT. */
interface CountTileSpec {
  readonly measure: HeadlineMeasure;
  readonly label: string;
  readonly hint: string;
  readonly to: string;
  readonly source: string;
}

const COUNT_TILES: readonly CountTileSpec[] = [
  {
    measure: "workforce",
    label: t("admin.analytics.home.workforce.label"),
    hint: t("admin.analytics.home.workforce.hint"),
    to: "/admin/analytics/workforce",
    source: t("admin.analytics.home.workforce.source"),
  },
  {
    measure: "leave",
    label: t("admin.analytics.home.leave.label"),
    hint: t("admin.analytics.home.leave.hint"),
    to: "/admin/analytics/leave",
    source: t("admin.analytics.home.leave.source"),
  },
  {
    measure: "payroll",
    label: t("admin.analytics.home.payroll.label"),
    hint: t("admin.analytics.home.payroll.hint"),
    to: "/admin/analytics/payroll",
    source: t("admin.analytics.home.payroll.source"),
  },
  {
    measure: "compliance",
    label: t("admin.analytics.home.compliance.label"),
    hint: t("admin.analytics.home.compliance.hint"),
    to: "/admin/analytics/compliance",
    source: t("admin.analytics.home.compliance.source"),
  },
  {
    measure: "kiosk",
    label: t("admin.analytics.home.kiosk.label"),
    hint: t("admin.analytics.home.kiosk.hint"),
    to: "/admin/analytics/kiosk",
    source: t("admin.analytics.home.kiosk.source"),
  },
  {
    measure: "ai",
    label: t("admin.analytics.home.ai.label"),
    hint: t("admin.analytics.home.ai.hint"),
    to: "/admin/analytics/ai",
    source: t("admin.analytics.home.ai.source"),
  },
  {
    measure: "exports",
    label: t("admin.analytics.home.exports.label"),
    hint: t("admin.analytics.home.exports.hint"),
    to: "/admin/analytics/exports",
    source: t("admin.analytics.home.exports.source"),
  },
];

/** A screen with no relation behind its headline yet — stated, never faked. */
interface MissingTileSpec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly to: string;
}

const MISSING_TILES: readonly MissingTileSpec[] = [
  {
    key: "metrics",
    label: t("admin.analytics.home.metrics.label"),
    hint: t("admin.analytics.home.metrics.hint"),
    to: "/admin/analytics/metrics",
  },
  {
    key: "scheduled",
    label: t("admin.analytics.home.scheduled.label"),
    hint: t("admin.analytics.home.scheduled.hint"),
    to: "/admin/analytics/scheduled",
  },
  {
    key: "builder",
    label: t("admin.analytics.home.builder.label"),
    hint: t("admin.analytics.home.builder.hint"),
    to: "/admin/analytics/builder",
  },
];

/**
 * A headline query as `CountTile` wants it. Only used for the count measures —
 * `selectCount` always yields a number, so no null can be flattened into a 0
 * here (the percent measure is rendered separately for exactly that reason).
 */
function toCountState(query: HeadlineQuery | undefined): CountState {
  if (query === undefined) return { data: undefined, error: null, isPending: true };
  return {
    data: query.data?.figure ?? undefined,
    error: query.error,
    isPending: query.isPending,
  };
}

export default function AnalyticsHomePage() {
  const headlines = useAnalyticsHeadlines();
  const attendance = headlines.get("attendance");
  const attendanceFigure = attendance?.data?.figure ?? null;
  const attendanceAsOf = attendance?.data?.asOfDate ?? null;

  const attendanceValue = attendance?.isPending === true
    ? <Skeleton className="h-7 w-16" />
    : attendance?.error != null
      ? dash(null)
      : formatPercent(attendanceFigure, { digits: 2 });

  const attendanceHint = attendance?.error != null
    ? unavailableHint(attendance.error)
    : attendanceAsOf !== null
      ? t("admin.analytics.home.attendance.hintOn", { date: fmtCivilDate(attendanceAsOf) })
      : t("admin.analytics.home.attendance.hint");

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("admin.analytics.home.title")}
        subtitle={t("admin.analytics.home.subtitle")}
      />

      {/*
        The filtered, aggregated view sits ABOVE the directory below it. They answer
        different questions and are deliberately not merged: this block aggregates and
        says so; the directory below is counts-only, each one over the same relation
        its destination screen reads, which is why its tiles can never disagree with
        the screens they open.
      */}
      <AnalyticsOverview />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Punctuality is a percentage, not a count: its own tile. */}
        <KpiTile
          label={t("admin.analytics.home.attendance.label")}
          value={attendanceValue}
          hint={attendanceHint}
          to="/admin/analytics/attendance"
          drillLabel={t("admin.analytics.home.attendance.drill")}
          tone={attendanceFigure !== null && attendanceFigure > 0 ? "warn" : "neutral"}
          explainer={{
            formula: t("admin.analytics.home.attendance.formula"),
            numbers:
              attendanceAsOf === null
                ? t("admin.analytics.home.attendance.hint")
                : t("admin.analytics.home.attendance.numbers", {
                    pct: formatPercent(attendanceFigure, { digits: 2 }),
                    date: fmtCivilDate(attendanceAsOf),
                  }),
          }}
        />

        {COUNT_TILES.map((tile) => (
          <CountTile
            key={tile.measure}
            label={tile.label}
            hint={tile.hint}
            to={tile.to}
            drillLabel={tile.label}
            source={tile.source}
            query={toCountState(headlines.get(tile.measure))}
          />
        ))}

        {MISSING_TILES.map((tile) => (
          <KpiTile
            key={tile.key}
            label={tile.label}
            value={dash(null)}
            hint={tile.hint}
            to={tile.to}
            drillLabel={tile.label}
          />
        ))}
      </div>

      <div className="mt-4 space-y-3">
        <Notice tone="info">{t("admin.analytics.home.footnote")}</Notice>
        {/*
          INFO, NOT WARNING. This note is permanent, architectural, and nothing an
          administrator can act on — three screens have no table behind them, which
          is a roadmap fact rather than a fault in their data. Dressed as a warning
          it read as an error somebody had to fix, and a warning triangle that
          never clears is how people learn to ignore warning triangles.
        */}
        <Notice tone="note">{t("admin.analytics.home.gap")}</Notice>
      </div>
    </div>
  );
}
