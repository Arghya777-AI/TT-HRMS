/**
 * §14 · /admin/analytics/scheduled — Scheduled Reports. Recurring reports and
 * their recipients.
 *
 * P1 in the route manifest, and honestly unbuildable today: there is no
 * `scheduled_reports` relation in the database, no recipient list, no report
 * definition and no render-and-deliver function. A screen with a working "Add
 * schedule" form over nothing would be a lie the client could click.
 *
 * So this page shows the real inventory instead. The recurring machinery that IS
 * deployed is job scheduling, not report scheduling: `cron_jobs` (the register of
 * recurring jobs, with cron expression, timezone, overlap policy and failure
 * alerting), `job_runs` (every execution with its outcome), and
 * `notification-dispatch` + `notification_templates` for delivery. Those already
 * have a screen — System Health — and this page points at it rather than
 * duplicating it under a name it does not earn.
 *
 * What would have to exist for this screen to become real is listed explicitly,
 * because "arrives later" without a named missing piece is indistinguishable from
 * "we forgot".
 *
 * @route /admin/analytics/scheduled
 */
import { Link } from "react-router-dom";
import { CalendarClock, Cog, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";

const STATE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  deployed: { label: t("admin.asched.state.deployed"), tone: "success" },
  missing: { label: t("admin.asched.state.missing"), tone: "warn" },
};

interface InventoryRow {
  /** A Postgres relation or an edge function — rendered as code, not prose. */
  readonly id: string;
  readonly whatKey: MessageKey;
  readonly state: "deployed" | "missing";
  readonly noteKey: MessageKey;
}

const INVENTORY: readonly InventoryRow[] = [
  {
    id: "cron_jobs",
    whatKey: "admin.asched.inv.cronJobs",
    state: "deployed",
    noteKey: "admin.asched.inv.cronJobsNote",
  },
  {
    id: "job_runs",
    whatKey: "admin.asched.inv.jobRuns",
    state: "deployed",
    noteKey: "admin.asched.inv.jobRunsNote",
  },
  {
    id: "notification_templates",
    whatKey: "admin.asched.inv.templates",
    state: "deployed",
    noteKey: "admin.asched.inv.templatesNote",
  },
  {
    id: "notification-dispatch",
    whatKey: "admin.asched.inv.dispatch",
    state: "deployed",
    noteKey: "admin.asched.inv.dispatchNote",
  },
  {
    id: "scheduled_reports",
    whatKey: "admin.asched.inv.reports",
    state: "missing",
    noteKey: "admin.asched.inv.reportsNote",
  },
  {
    id: "scheduled_report_recipients",
    whatKey: "admin.asched.inv.recipients",
    state: "missing",
    noteKey: "admin.asched.inv.recipientsNote",
  },
  {
    id: "report-render",
    whatKey: "admin.asched.inv.render",
    state: "missing",
    noteKey: "admin.asched.inv.renderNote",
  },
];

export default function AnalyticsScheduledPage() {
  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarClock}
        title={t("admin.asched.title")}
        subtitle={t("admin.asched.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/settings/health">
              <Gauge className="mr-2 size-4" aria-hidden />
              {t("admin.asched.toHealth")}
            </Link>
          </Button>
        }
      />

      <div className="mt-4">
        <EmptyState
          icon={CalendarClock}
          title={t("admin.asched.empty.title")}
          hint={t("admin.asched.empty.hint")}
          action={
            <Button variant="outline" asChild>
              <Link to="/admin/settings/notifications">
                <Cog className="mr-2 size-4" aria-hidden />
                {t("admin.asched.toTemplates")}
              </Link>
            </Button>
          }
        />
      </div>

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.asched.inventory.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.asched.inventory.hint")}</p>
        <div className="mt-2 overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[16rem]">{t("admin.asched.col.piece")}</TableHead>
                <TableHead className="w-[9rem]">{t("admin.asched.col.state")}</TableHead>
                <TableHead>{t("admin.asched.col.note")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {INVENTORY.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="align-top">
                    <span className="flex flex-col leading-tight">
                      <span className="font-medium">{t(row.whatKey)}</span>
                      <code className="num text-xs text-muted-foreground">{row.id}</code>
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    <StatusChip status={row.state} map={STATE_CHIP} />
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {t(row.noteKey)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="mt-6">
        <Notice tone="warning">{t("admin.asched.note.noFakeForm")}</Notice>
      </div>
    </div>
  );
}
