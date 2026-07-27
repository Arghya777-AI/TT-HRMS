/**
 * §1 · /admin/tasks — My Admin Tasks. What THIS administrator personally owes.
 *
 * The distinction this page exists to make: `/admin/workflow/inbox` is the
 * organisation's queue, `/admin/alerts` is the organisation's problems. This is
 * the short list with the admin's own name on it, and it is personal by
 * construction rather than by a client-side filter:
 *
 *  * `v_approval_inbox` is scoped in Postgres to
 *    `app.current_employee_id() = ANY (current_approver_ids)`.
 *  * The service-level breaches are read with `employee_id = my employee id`,
 *    which in the `sla_breach` branch of `v_exception_queue` IS the approver.
 *
 * Every clock on this page is the server's: `sla_due_at`, `sla_remaining_hours`,
 * `age_hours` and `is_overdue` are columns, not comparisons made here. The client
 * converts hours to `18h 30m` for display and does nothing else with them — an
 * admin must never see one screen call an item overdue while another calls it
 * due in an hour because the two disagreed about "now".
 *
 * A signed-in account with no employee record (kiosk-only staff, or an admin
 * whose employee row is not linked) is a real case: the inbox legitimately
 * returns nothing, and this page says why instead of showing an empty grid.
 *
 * @route /admin/tasks
 */
import { Link } from "react-router-dom";
import { ClipboardList, Inbox, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { fmtCivilDate, fmtDateTime, fmtDurationFromHours } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AdminTask, ExceptionRow } from "../api/command.api";
import { ADMIN_ROUTES, SEVERITY_CHIP } from "../command-vocab";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { useMySlaBreaches, useMyTasks } from "../hooks/useCommandCentre";

/** Priority is free text on `approval_requests`; StatusChip humanises the rest. */
const PRIORITY_CHIP = {
  low: { label: t("admin.tasks.priority.low"), tone: "neutral" as const },
  normal: { label: t("admin.tasks.priority.normal"), tone: "info" as const },
  high: { label: t("admin.tasks.priority.high"), tone: "warn" as const },
  urgent: { label: t("admin.tasks.priority.urgent"), tone: "danger" as const },
};

function taskColumns(): DataGridColumn<AdminTask>[] {
  return [
    {
      key: "request_number",
      header: t("admin.tasks.col.request"),
      width: "14rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.title}</span>
          <span className="num text-xs text-muted-foreground">{row.request_number}</span>
        </span>
      ),
    },
    {
      key: "request_type_name",
      header: t("admin.tasks.col.type"),
      width: "11rem",
      hideBelow: "sm",
      sortable: true,
    },
    {
      key: "subject_display_name",
      header: t("admin.tasks.col.subject"),
      width: "13rem",
      render: (row) => (
        <PersonCell
          name={row.subject_display_name}
          code={row.subject_employee_code}
          secondary={row.subject_department_name}
        />
      ),
    },
    {
      key: "priority",
      header: t("admin.tasks.col.priority"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.priority} map={PRIORITY_CHIP} />,
    },
    {
      key: "current_level",
      header: t("admin.tasks.col.level"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) =>
        t("admin.tasks.levelOf", { current: row.current_level, total: row.total_levels }),
    },
    {
      key: "age_hours",
      header: t("admin.tasks.col.age"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.age_hours ?? 0,
      render: (row) => <span className="num">{fmtDurationFromHours(row.age_hours)}</span>,
    },
    {
      key: "sla_due_at",
      header: t("admin.tasks.col.due"),
      width: "13rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          {row.is_overdue === true ? (
            <StatusChip
              status="overdue"
              map={{ overdue: { label: t("admin.tasks.overdue"), tone: "danger" } }}
            />
          ) : (
            <span className="num text-sm">
              {t("admin.tasks.dueIn", { duration: fmtDurationFromHours(row.sla_remaining_hours) })}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{fmtDateTime(row.sla_due_at)}</span>
        </span>
      ),
    },
    {
      key: "actions",
      header: t("admin.tasks.col.action"),
      align: "right",
      width: "8rem",
      render: () => (
        <Button variant="outline" size="sm" asChild>
          <Link to={ADMIN_ROUTES.workflowInbox}>{t("admin.tasks.decide")}</Link>
        </Button>
      ),
    },
  ];
}

function breachColumns(): DataGridColumn<ExceptionRow>[] {
  return [
    {
      key: "severity",
      header: t("admin.alert.col.severity"),
      width: "8.5rem",
      render: (row) => <StatusChip status={row.severity} map={SEVERITY_CHIP} />,
    },
    {
      key: "description",
      header: t("admin.alert.col.what"),
      render: (row) => <span className="text-sm">{row.description}</span>,
    },
    {
      key: "ist_date",
      header: t("admin.alert.col.date"),
      width: "8rem",
      hideBelow: "sm",
      render: (row) => fmtCivilDate(row.ist_date),
    },
    {
      key: "occurred_at",
      header: t("admin.alert.col.raised"),
      width: "12rem",
      hideBelow: "md",
      render: (row) => fmtDateTime(row.occurred_at),
    },
    {
      key: "actions",
      header: t("admin.alert.col.action"),
      align: "right",
      width: "8rem",
      render: () => (
        <Button variant="ghost" size="sm" asChild>
          <Link to={ADMIN_ROUTES.workflowSla}>{t("admin.alert.open")}</Link>
        </Button>
      ),
    },
  ];
}

export default function AdminTasksPage() {
  const employeeId = useEmployeeId();
  const tasks = useMyTasks();
  const breaches = useMySlaBreaches(employeeId);

  const taskRows = tasks.data ?? [];
  const breachRows = breaches.data ?? [];

  return (
    <>
      <PageHeader
        icon={ClipboardList}
        title={t("admin.tasks.title")}
        subtitle={t("admin.tasks.subtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to={ADMIN_ROUTES.workflowInbox}>{t("admin.tasks.openInbox")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        {employeeId === null ? (
          <Notice tone="warning">{t("admin.tasks.noEmployeeRecord")}</Notice>
        ) : null}

        <section aria-labelledby="my-approvals-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2
                id="my-approvals-heading"
                className="flex items-center gap-2 font-display text-lg font-semibold"
              >
                <Inbox className="h-4 w-4 text-primary" aria-hidden />
                {t("admin.tasks.approvals.title")}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t("admin.tasks.approvals.hint")}
              </p>
            </div>
            {taskRows.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("admin.tasks.waiting", { count: formatNumber(taskRows.length) })}
              </p>
            ) : null}
          </div>

          <StateBoundary
            loading={tasks.isPending}
            error={tasks.error}
            onRetry={() => void tasks.refetch()}
            isEmpty={taskRows.length === 0}
            empty={
              <EmptyState
                icon={Inbox}
                title={t("admin.tasks.empty.title")}
                hint={t("admin.tasks.empty.hint")}
                action={
                  <Button variant="outline" size="sm" asChild>
                    <Link to={ADMIN_ROUTES.alerts}>{t("admin.tasks.empty.action")}</Link>
                  </Button>
                }
              />
            }
            skeletonRows={4}
          >
            <DataGrid
              columns={taskColumns()}
              rows={taskRows}
              rowKey={(row) => row.approval_request_id}
              pageSize={25}
            />
          </StateBoundary>
        </section>

        <section aria-labelledby="my-breaches-heading" className="space-y-3">
          <div>
            <h2
              id="my-breaches-heading"
              className="flex items-center gap-2 font-display text-lg font-semibold"
            >
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
              {t("admin.tasks.breaches.title")}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.tasks.breaches.hint")}</p>
          </div>

          <StateBoundary
            loading={employeeId !== null && breaches.isPending}
            error={breaches.error}
            onRetry={() => void breaches.refetch()}
            isEmpty={breachRows.length === 0}
            empty={
              <EmptyState
                icon={ShieldCheck}
                title={t("admin.tasks.breaches.empty.title")}
                hint={t("admin.tasks.breaches.empty.hint")}
              />
            }
            skeletonRows={2}
          >
            <DataGrid
              columns={breachColumns()}
              rows={breachRows}
              rowKey={(row) => `${row.exception_kind}:${row.entity_id}`}
              pageSize={10}
            />
          </StateBoundary>
        </section>
      </div>
    </>
  );
}
