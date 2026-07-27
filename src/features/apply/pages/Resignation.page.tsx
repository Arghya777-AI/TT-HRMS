/**
 * E-10.3 · /me/apply/resignation — "Notice period, last working day and
 * clearance."
 *
 * A resignation cannot be SUBMITTED against the deployed schema, and both
 * reasons are read off the server rather than asserted:
 *
 *  1. NO DETAIL ROW TO POINT AT. `request_types.code = 'RESIGNATION'` exists
 *     (045 §2) and names `detail_table = 'resignations'` — a table no migration
 *     creates. It appears twice as a STRING only: in
 *     `ck_request_types__detail_table` (029 §1) and in that seed row.
 *     `approval_requests.detail_id` is NOT NULL.
 *  2. NO APPROVAL CHAIN. 045 §3 seeds chains for eleven of the eighteen types;
 *     `RESIGNATION` is not one, so `create_approval_request` would raise
 *     `no approval chain matches request type RESIGNATION`. The routing card
 *     proves it by reading `approval_chains` and finding it empty.
 *
 * The real path today is the one the schema is built around:
 * `employee_lifecycle_events` with `event_type = 'resigned'`, which
 * `ele_status_projection` (011 §1) turns into `employment_status = 'on_notice'`
 * plus `employees.resignation_date`. Only HR can write it —
 * `ele__admin_insert` is `app.is_admin() AND app.admin_scope_covers(...)` — so
 * this screen SHOWS that record instead of pretending to create one.
 *
 * WHAT IT REFUSES TO COMPUTE, all asked for by spec-employee §5:
 *  * SHORTFALL RECOVERY (`shortfall × monthly_gross / days_in_month`). That is
 *    payroll arithmetic on a salary figure, in a browser. Not here, not ever.
 *  * LEAVE ENCASHMENT ESTIMATE. It needs an encashment rule and a rate; neither
 *    is a column in this schema.
 *  * CLEARANCE AND THE EXIT INTERVIEW. `clearance_templates`, `clearance_items`
 *    and `exit_interviews` do not exist in any migration. `employees
 *    .exit_interview_done` is a single boolean, and it is shown as exactly that.
 *
 * The earliest last working day IS shown, because it is a calendar shift of a
 * server-owned integer through the sanctioned `addIstDays` helper — the same
 * civil-date arithmetic the admin consoles use for their range presets, not a
 * business figure derived in the component.
 *
 * @route /me/apply/resignation
 */
import { Link } from "react-router-dom";
import { CalendarClock, History, LogOut, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS } from "@/features/admin/api/employees.api";
import { EXIT_TYPE_LABELS, LIFECYCLE_EVENT_LABELS } from "@/features/admin/api/lifecycle.api";
import { t } from "@/shared/i18n/en";
import { dash, formatNumber } from "@/lib/format";
import { addIstDays, fmtCivilDateWeekday, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { REQUEST_CODE_RESIGNATION, type LifecycleEvent } from "../api/apply-forms.api";
import { useMyOpenRequestsOfType, useRequestRouting, useRequestTypeByCode } from "../hooks/useApply";
import { useMyLifecycleEvents, useNoticeFacts } from "../hooks/useApplyForms";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";
import { RequestRoutingCard } from "../components/RequestRoutingCard";

/** `public.employment_status`, toned for the one question this screen asks. */
const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pre_joining: { label: EMPLOYMENT_STATUS_LABELS.pre_joining, tone: "neutral" },
  active: { label: EMPLOYMENT_STATUS_LABELS.active, tone: "success" },
  on_probation: { label: EMPLOYMENT_STATUS_LABELS.on_probation, tone: "info" },
  confirmed: { label: EMPLOYMENT_STATUS_LABELS.confirmed, tone: "success" },
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  suspended: { label: EMPLOYMENT_STATUS_LABELS.suspended, tone: "danger" },
  on_long_leave: { label: EMPLOYMENT_STATUS_LABELS.on_long_leave, tone: "info" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  rehired: { label: EMPLOYMENT_STATUS_LABELS.rehired, tone: "success" },
};

/** One server-owned fact, rendered as a labelled value with its provenance. */
function FactRow({ label, value, source }: { label: string; value: string; source: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{source}</span>
      </span>
      <span className="num text-sm font-semibold">{value}</span>
    </li>
  );
}

export default function ResignationPage() {
  const today = nowIstDate();
  const type = useRequestTypeByCode(REQUEST_CODE_RESIGNATION);
  const routing = useRequestRouting(type.data?.id);
  const open = useMyOpenRequestsOfType(type.data?.id);
  const facts = useNoticeFacts();
  const events = useMyLifecycleEvents();

  const me = facts.data?.employee ?? null;
  const grade = facts.data?.grade ?? null;
  const contract = facts.data?.contract ?? null;

  /**
   * The binding figure is `employees.notice_period_days` — `NOT NULL DEFAULT 30`
   * (008), and the column HR and payroll both read. The grade's and the signed
   * contract's are shown beside it rather than folded in, so a disagreement is
   * visible instead of resolved in silence.
   */
  const noticeDays = me?.notice_period_days ?? null;
  const earliestLwd = noticeDays === null ? null : addIstDays(today, noticeDays);
  const gradeDiffers =
    grade !== null && noticeDays !== null && grade.notice_period_days !== noticeDays;
  const contractDiffers =
    contract !== null &&
    contract.notice_period_days !== null &&
    noticeDays !== null &&
    contract.notice_period_days !== noticeDays;

  /** HR has already filed something once any of the three exit columns is set. */
  const exitOnFile =
    me !== null &&
    (me.resignation_date !== null || me.last_working_day !== null || me.exit_type !== null);

  const eventColumns: DataGridColumn<LifecycleEvent>[] = [
    {
      key: "effective_date",
      header: t("apply.resign.col.effective"),
      width: "12rem",
      sortable: true,
      render: (row) => fmtCivilDateWeekday(row.effective_date),
    },
    {
      key: "event_type",
      header: t("apply.resign.col.event"),
      width: "12rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {LIFECYCLE_EVENT_LABELS[row.event_type]}
          {row.is_reversed ? (
            <Badge variant="warning">{t("apply.resign.event.reversed")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "reason",
      header: t("apply.resign.col.reason"),
      render: (row) => row.reason,
    },
    {
      key: "recorded_at",
      header: t("apply.resign.col.recorded"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => fmtDateTime(row.recorded_at),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={LogOut}
        title={t("apply.resign.title")}
        subtitle={t("apply.resign.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply">{t("apply.back")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ── The blocking facts, named ───────────────────────────────────── */}
        <Notice tone="error">
          <p className="font-medium">{t("apply.resign.gap.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("apply.resign.gap.table")}</li>
            <li>{t("apply.resign.gap.chain")}</li>
            <li>{t("apply.resign.gap.clearance")}</li>
          </ul>
        </Notice>

        {/* ── How a resignation is actually recorded here ──────────────────── */}
        <EmptyState
          icon={CalendarClock}
          title={t("apply.resign.alt.title")}
          hint={t("apply.resign.alt.hint")}
          action={
            <Button asChild>
              <Link to="/me/apply">{t("apply.resign.alt.cta")}</Link>
            </Button>
          }
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── Notice period, from three server columns ──────────────────── */}
          <section aria-labelledby="resign-notice">
            <h2 id="resign-notice" className="mb-3 font-display text-lg font-semibold">
              {t("apply.resign.notice.title")}
            </h2>
            <StateBoundary
              loading={facts.isLoading}
              error={facts.error ?? undefined}
              onRetry={() => void facts.refetch()}
              isEmpty={facts.data === null && !facts.isLoading}
              empty={
                <EmptyState
                  icon={LogOut}
                  title={t("apply.resign.notice.empty.title")}
                  hint={t("apply.resign.notice.empty.hint")}
                />
              }
              skeletonRows={4}
            >
              <div className="rounded-lg border bg-card p-4">
                <ul className="divide-y">
                  <FactRow
                    label={t("apply.resign.fact.mine")}
                    value={
                      noticeDays === null
                        ? dash(null)
                        : t("apply.resign.days", { days: formatNumber(noticeDays) })
                    }
                    source="employees.notice_period_days"
                  />
                  <FactRow
                    label={
                      grade !== null
                        ? t("apply.resign.fact.grade", { grade: grade.name })
                        : // A grade_id with no readable row means the grade was
                          // retired: `grades__all_read__select` is
                          // `USING (is_active AND deleted_at IS NULL)`.
                          me !== null && me.grade_id !== null
                          ? t("apply.resign.fact.gradeHidden")
                          : t("apply.resign.fact.gradeNone")
                    }
                    value={
                      grade === null
                        ? dash(null)
                        : t("apply.resign.days", {
                            days: formatNumber(grade.notice_period_days),
                          })
                    }
                    source="grades.notice_period_days"
                  />
                  <FactRow
                    label={
                      contract === null
                        ? t("apply.resign.fact.contractNone")
                        : t("apply.resign.fact.contract", { ref: contract.contract_number })
                    }
                    value={
                      contract === null || contract.notice_period_days === null
                        ? dash(null)
                        : t("apply.resign.days", {
                            days: formatNumber(contract.notice_period_days),
                          })
                    }
                    source="contracts.notice_period_days"
                  />
                  <FactRow
                    label={t("apply.resign.fact.earliest")}
                    value={earliestLwd === null ? dash(null) : fmtCivilDateWeekday(earliestLwd)}
                    source={t("apply.resign.fact.earliest.source")}
                  />
                </ul>

                {gradeDiffers || contractDiffers ? (
                  <div className="mt-3 border-t pt-3">
                    <Notice tone="warning">
                      <p className="font-medium">{t("apply.resign.notice.disagree.title")}</p>
                      <p className="mt-1">{t("apply.resign.notice.disagree.hint")}</p>
                    </Notice>
                  </div>
                ) : (
                  <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">
                    {t("apply.resign.notice.binding")}
                  </p>
                )}
              </div>
            </StateBoundary>
          </section>

          {/* ── Where the exit already stands ─────────────────────────────── */}
          <section aria-labelledby="resign-exit">
            <h2 id="resign-exit" className="mb-3 font-display text-lg font-semibold">
              {t("apply.resign.exit.title")}
            </h2>
            <StateBoundary
              loading={facts.isLoading}
              error={facts.error ?? undefined}
              onRetry={() => void facts.refetch()}
              isEmpty={facts.data === null && !facts.isLoading}
              empty={
                <EmptyState
                  icon={ShieldCheck}
                  title={t("apply.resign.notice.empty.title")}
                  hint={t("apply.resign.notice.empty.hint")}
                />
              }
              skeletonRows={4}
            >
              <div className="space-y-3 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {me === null ? null : (
                    <>
                      <StatusChip status={me.employment_status} map={STATUS_CHIP} />
                      <Badge variant="neutral">
                        {EMPLOYMENT_TYPE_LABELS[me.employment_type]}
                      </Badge>
                    </>
                  )}
                </div>

                {!exitOnFile ? (
                  <p className="text-sm text-muted-foreground">
                    {t("apply.resign.exit.none")}
                  </p>
                ) : null}

                <ul className="divide-y">
                  <FactRow
                    label={t("apply.resign.fact.joined")}
                    value={
                      me?.date_of_join === null || me?.date_of_join === undefined
                        ? dash(null)
                        : fmtCivilDateWeekday(me.date_of_join)
                    }
                    source="employees.date_of_join"
                  />
                  <FactRow
                    label={t("apply.resign.fact.resignationDate")}
                    value={
                      me?.resignation_date === null || me?.resignation_date === undefined
                        ? dash(null)
                        : fmtCivilDateWeekday(me.resignation_date)
                    }
                    source="employees.resignation_date"
                  />
                  <FactRow
                    label={t("apply.resign.fact.lwd")}
                    value={
                      me?.last_working_day === null || me?.last_working_day === undefined
                        ? dash(null)
                        : fmtCivilDateWeekday(me.last_working_day)
                    }
                    source="employees.last_working_day"
                  />
                  <FactRow
                    label={t("apply.resign.fact.exitType")}
                    value={
                      me?.exit_type === null || me?.exit_type === undefined
                        ? dash(null)
                        : EXIT_TYPE_LABELS[me.exit_type]
                    }
                    source="employees.exit_type"
                  />
                  <FactRow
                    label={t("apply.resign.fact.interview")}
                    value={
                      me === null
                        ? dash(null)
                        : me.exit_interview_done
                          ? t("apply.resign.yes")
                          : t("apply.resign.no")
                    }
                    source="employees.exit_interview_done"
                  />
                  <FactRow
                    label={t("apply.resign.fact.fnf")}
                    value={
                      me?.full_and_final_settled_on === null ||
                      me?.full_and_final_settled_on === undefined
                        ? dash(null)
                        : fmtCivilDateWeekday(me.full_and_final_settled_on)
                    }
                    source="employees.full_and_final_settled_on"
                  />
                  <FactRow
                    label={t("apply.resign.fact.gratuity")}
                    value={
                      facts.data?.gratuityEligibleFrom === null ||
                      facts.data?.gratuityEligibleFrom === undefined
                        ? dash(null)
                        : fmtCivilDateWeekday(facts.data.gratuityEligibleFrom)
                    }
                    source="employee_statutory.gratuity_eligible_from"
                  />
                </ul>

                {me?.exit_reason !== null && me?.exit_reason !== undefined ? (
                  <p className="border-t pt-3 text-sm">
                    <span className="font-medium">{t("apply.resign.fact.exitReason")}</span>{" "}
                    {me.exit_reason}
                  </p>
                ) : null}
              </div>
            </StateBoundary>
          </section>
        </div>

        {/* ── The lifecycle record itself ─────────────────────────────────── */}
        <section aria-labelledby="resign-events">
          <h2 id="resign-events" className="font-display text-lg font-semibold">
            {t("apply.resign.events.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.resign.events.hint")}</p>
          <StateBoundary
            loading={events.isLoading}
            error={events.error ?? undefined}
            onRetry={() => void events.refetch()}
          >
            <DataGrid
              columns={eventColumns}
              rows={events.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={History}
                  title={t("apply.resign.events.empty.title")}
                  hint={t("apply.resign.events.empty.hint")}
                />
              }
            />
          </StateBoundary>
        </section>

        {/* ── What the workflow engine has configured for this type ───────── */}
        <section aria-labelledby="resign-routing">
          <h2 id="resign-routing" className="mb-3 font-display text-lg font-semibold">
            {t("apply.routing.section")}
          </h2>
          <StateBoundary
            loading={type.isLoading || routing.isLoading}
            error={type.error ?? routing.error ?? undefined}
            onRetry={() => {
              void type.refetch();
              void routing.refetch();
            }}
            skeletonRows={2}
          >
            {type.data === null ? (
              <Notice tone="warning">{t("apply.type.missing")}</Notice>
            ) : (
              <div className="space-y-3">
                {type.data !== undefined ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="neutral">{type.data.name}</Badge>
                    <span>{t("apply.tile.sla", { hours: type.data.sla_hours })}</span>
                    {type.data.escalation_hours !== null ? (
                      <span>{t("apply.type.escalates", { hours: type.data.escalation_hours })}</span>
                    ) : null}
                    <span>
                      {type.data.allows_withdrawal
                        ? t("apply.type.withdrawable")
                        : t("apply.type.notWithdrawable")}
                    </span>
                    <span>{t("apply.type.detailTable", { table: type.data.detail_table })}</span>
                  </div>
                ) : null}
                <RequestRoutingCard
                  routing={routing.data}
                  missingChainMessage={t("apply.resign.gap.chain")}
                />
              </div>
            )}
          </StateBoundary>
        </section>

        {/* ── Anything of this type already in flight ─────────────────────── */}
        <section aria-labelledby="resign-open">
          <h2 id="resign-open" className="mb-3 font-display text-lg font-semibold">
            {t("apply.mine.title")}
          </h2>
          <StateBoundary
            loading={open.isLoading}
            error={open.error ?? undefined}
            onRetry={() => void open.refetch()}
          >
            <OpenRequestsGrid
              rows={open.data?.rows ?? []}
              approvers={open.data?.approvers ?? {}}
              emptyTitle={t("apply.resign.mine.empty.title")}
              emptyHint={t("apply.resign.mine.empty.hint")}
            />
          </StateBoundary>
        </section>

        {/* ── What a migration would have to add ──────────────────────────── */}
        <section aria-labelledby="resign-when-ready">
          <h2 id="resign-when-ready" className="font-display text-lg font-semibold">
            {t("apply.resign.ready.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.resign.ready.hint")}</p>
          <ol className="list-decimal space-y-1.5 rounded-lg border bg-card p-4 pl-9 text-sm">
            <li>{t("apply.resign.ready.item1")}</li>
            <li>{t("apply.resign.ready.item2")}</li>
            <li>{t("apply.resign.ready.item3")}</li>
            <li>{t("apply.resign.ready.item4")}</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
