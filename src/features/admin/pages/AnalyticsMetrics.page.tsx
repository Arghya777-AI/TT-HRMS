/**
 * §14 · /admin/analytics/metrics — the Metric Dictionary. Every figure this
 * product shows, its exact definition, and the server relation that OWNS it.
 *
 * This screen reads nothing. That is the point: it is the contract between the
 * numbers on twelve other screens and the SQL that produces them, so it has to
 * be checkable by eye against `supabase/migrations/`. Every row below names a
 * real deployed relation and a real column — each one was read out of the
 * migration that creates it, not inferred from a name — and each one links to the
 * screen where that column is printed.
 *
 * The second table is the more useful half of an honest dictionary: the figures
 * a reader might EXPECT to find here and cannot, because no server relation
 * computes them. A metric with no owner is not a metric; it is a wish. Listing
 * them here is how the build stays honest about its own edges instead of
 * inventing a number in the browser to fill a gap.
 *
 * DEFINITIONS ARE QUOTED, NOT PARAPHRASED. Where a formula appears in the SQL —
 * `matched * 100.0 / NULLIF(total_attempts, 0)`, `exits * 12 * 100.0 /
 * NULLIF(avg_headcount, 0)` — this page states it in those terms so an
 * administrator can reconcile a figure with the database without a developer.
 *
 * @route /admin/analytics/metrics
 */
import { Link } from "react-router-dom";
import { ScrollText } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/shared/ui/PageHeader";
import { formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";

interface MetricEntry {
  /** Stable id — also the anchor an explainer popover elsewhere can point at. */
  readonly id: string;
  readonly nameKey: MessageKey;
  readonly definitionKey: MessageKey;
  /** `relation.column` — a deployed Postgres identifier, verified in migrations. */
  readonly source: string;
  /** Where the figure is printed. Every entry in the route manifest. */
  readonly route: string;
  readonly routeKey: MessageKey;
}

/**
 * The dictionary, grouped by domain in the order the admin console presents
 * them. `source` is a Postgres identifier, so it is rendered as code and is NOT
 * a translatable string — the column name is the same in every language.
 */
const SECTIONS: readonly { titleKey: MessageKey; metrics: readonly MetricEntry[] }[] = [
  {
    titleKey: "admin.adict.section.attendance",
    metrics: [
      {
        id: "presence-now",
        nameKey: "admin.adict.m.presence.name",
        definitionKey: "admin.adict.m.presence.def",
        source: "v_attendance_today_board.attended / yet_to_reach / late_in",
        route: "/admin/attendance/live",
        routeKey: "admin.adict.route.live",
      },
      {
        id: "attendance-pct",
        nameKey: "admin.adict.m.attendancePct.name",
        definitionKey: "admin.adict.m.attendancePct.def",
        source: "v_attendance_monthly_summary.attendance_pct",
        route: "/admin/analytics/attendance",
        routeKey: "admin.adict.route.attendance",
      },
      {
        id: "late-pct",
        nameKey: "admin.adict.m.latePct.name",
        definitionKey: "admin.adict.m.latePct.def",
        source: "v_attendance_monthly_summary.late_pct",
        route: "/admin/analytics/attendance",
        routeKey: "admin.adict.route.attendance",
      },
      {
        id: "worked-minutes",
        nameKey: "admin.adict.m.worked.name",
        definitionKey: "admin.adict.m.worked.def",
        source: "v_attendance_monthly_summary.total_worked_minutes",
        route: "/admin/analytics/attendance",
        routeKey: "admin.adict.route.attendance",
      },
    ],
  },
  {
    titleKey: "admin.adict.section.workforce",
    metrics: [
      {
        id: "headcount",
        nameKey: "admin.adict.m.headcount.name",
        definitionKey: "admin.adict.m.headcount.def",
        source: "v_headcount_daily.headcount",
        route: "/admin/analytics/workforce",
        routeKey: "admin.adict.route.workforce",
      },
      {
        id: "attrition",
        nameKey: "admin.adict.m.attrition.name",
        definitionKey: "admin.adict.m.attrition.def",
        source: "v_headcount_monthly.attrition_pct",
        route: "/admin/analytics/workforce",
        routeKey: "admin.adict.route.workforce",
      },
    ],
  },
  {
    titleKey: "admin.adict.section.payroll",
    metrics: [
      {
        id: "payroll-cost",
        nameKey: "admin.adict.m.payrollCost.name",
        definitionKey: "admin.adict.m.payrollCost.def",
        source: "v_payroll_cost_monthly.total_cost_paise",
        route: "/admin/analytics/payroll",
        routeKey: "admin.adict.route.payroll",
      },
      {
        id: "cost-per-employee",
        nameKey: "admin.adict.m.costPerEmployee.name",
        definitionKey: "admin.adict.m.costPerEmployee.def",
        source: "v_payroll_cost_monthly.cost_per_employee_paise",
        route: "/admin/analytics/payroll",
        routeKey: "admin.adict.route.payroll",
      },
      {
        id: "overtime-share",
        nameKey: "admin.adict.m.overtimeShare.name",
        definitionKey: "admin.adict.m.overtimeShare.def",
        source: "v_payroll_cost_monthly.overtime_share_pct",
        route: "/admin/analytics/payroll",
        routeKey: "admin.adict.route.payroll",
      },
      {
        id: "run-variance",
        nameKey: "admin.adict.m.runVariance.name",
        definitionKey: "admin.adict.m.runVariance.def",
        source: "payroll_runs.variance_vs_previous_pct",
        route: "/admin/payroll/runs",
        routeKey: "admin.adict.route.runs",
      },
    ],
  },
  {
    titleKey: "admin.adict.section.kiosk",
    metrics: [
      {
        id: "match-rate",
        nameKey: "admin.adict.m.matchRate.name",
        definitionKey: "admin.adict.m.matchRate.def",
        source: "v_kiosk_health.match_success_pct",
        route: "/admin/analytics/kiosk",
        routeKey: "admin.adict.route.kiosk",
      },
      {
        id: "p95",
        nameKey: "admin.adict.m.p95.name",
        definitionKey: "admin.adict.m.p95.def",
        source: "v_kiosk_health.p95_latency_ms",
        route: "/admin/analytics/kiosk",
        routeKey: "admin.adict.route.kiosk",
      },
      {
        id: "duplicates",
        nameKey: "admin.adict.m.duplicates.name",
        definitionKey: "admin.adict.m.duplicates.def",
        source: "v_kiosk_health.duplicates_suppressed",
        route: "/admin/analytics/kiosk",
        routeKey: "admin.adict.route.kiosk",
      },
    ],
  },
  {
    titleKey: "admin.adict.section.compliance",
    metrics: [
      {
        id: "doc-compliance",
        nameKey: "admin.adict.m.docCompliance.name",
        definitionKey: "admin.adict.m.docCompliance.def",
        source: "v_document_compliance.compliance_status",
        route: "/admin/analytics/compliance",
        routeKey: "admin.adict.route.compliance",
      },
      {
        id: "enrolment-gap",
        nameKey: "admin.adict.m.enrolmentGap.name",
        definitionKey: "admin.adict.m.enrolmentGap.def",
        source: "v_enrolment_coverage.gap_kind",
        route: "/admin/analytics/compliance",
        routeKey: "admin.adict.route.compliance",
      },
    ],
  },
];

/**
 * Figures with NO server owner. Each line names what would have to be built,
 * because "we could add it up in the browser" is exactly the answer this
 * dictionary exists to refuse.
 */
const ABSENT: readonly { readonly nameKey: MessageKey; readonly whyKey: MessageKey }[] = [
  { nameKey: "admin.adict.absent.eventCost.name", whyKey: "admin.adict.absent.eventCost.why" },
  { nameKey: "admin.adict.absent.fleetRate.name", whyKey: "admin.adict.absent.fleetRate.why" },
  { nameKey: "admin.adict.absent.coverage.name", whyKey: "admin.adict.absent.coverage.why" },
  { nameKey: "admin.adict.absent.aiCost.name", whyKey: "admin.adict.absent.aiCost.why" },
  { nameKey: "admin.adict.absent.leaveLiability.name", whyKey: "admin.adict.absent.leaveLiability.why" },
];

const METRIC_TOTAL = SECTIONS.reduce((n, s) => n + s.metrics.length, 0);

export default function AnalyticsMetricsPage() {
  return (
    <div className="container py-6">
      <PageHeader
        icon={ScrollText}
        title={t("admin.adict.title")}
        subtitle={t("admin.adict.subtitle", { n: formatNumber(METRIC_TOTAL) })}
      />

      <div className="mt-4">
        <Notice tone="info">{t("admin.adict.note.static")}</Notice>
      </div>

      {SECTIONS.map((section) => (
        <section key={section.titleKey} className="mt-6">
          <h2 className="font-display text-lg font-semibold">{t(section.titleKey)}</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[14rem]">{t("admin.adict.col.metric")}</TableHead>
                  <TableHead>{t("admin.adict.col.definition")}</TableHead>
                  <TableHead className="w-[20rem]">{t("admin.adict.col.source")}</TableHead>
                  <TableHead className="w-[11rem]">{t("admin.adict.col.shownOn")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {section.metrics.map((metric) => (
                  <TableRow key={metric.id} id={metric.id}>
                    <TableCell className="align-top font-medium">{t(metric.nameKey)}</TableCell>
                    <TableCell className="align-top text-sm text-muted-foreground">
                      {t(metric.definitionKey)}
                    </TableCell>
                    <TableCell className="align-top">
                      <code className="num break-words text-xs">{metric.source}</code>
                    </TableCell>
                    <TableCell className="align-top">
                      <Link
                        to={metric.route}
                        className="text-sm text-primary underline-offset-4 hover:underline"
                      >
                        {t(metric.routeKey)}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.adict.absent.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.adict.absent.hint")}</p>
        <div className="mt-2 overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[18rem]">{t("admin.adict.col.figure")}</TableHead>
                <TableHead>{t("admin.adict.col.whyAbsent")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ABSENT.map((row) => (
                <TableRow key={row.nameKey}>
                  <TableCell className="align-top font-medium">{t(row.nameKey)}</TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {t(row.whyKey)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="mt-6 space-y-2">
        <Notice tone="info">{t("admin.adict.note.paise")}</Notice>
        <Notice tone="info">{t("admin.adict.note.asOf")}</Notice>
      </div>
    </div>
  );
}
