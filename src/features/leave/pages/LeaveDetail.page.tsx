/**
 * E-05.7 Leave detail `/me/leave/:id` — header, allocation table, decision trail
 * and balance impact.
 *
 * The allocation table is the SAME component the apply preview renders, over the
 * same `leave_request_days` rows, so what was previewed and what was recorded are
 * displayed by one code path. The balance-impact line states which of the two
 * server states this request is in — days HELD while it waits (`pending_days`),
 * days DEDUCTED once approved (`availed_days`) — rather than doing sums.
 *
 * @route /me/leave/:id
 */
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CalendarCheck, ChevronLeft, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime, isFutureIstDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { useLeaveRequest } from "../hooks/useLeave";
import { useApprovalTrail, useLeaveAllocation } from "../hooks/useLeaveApply";
import { AllocationTable } from "../components/AllocationTable";
import {
  approvalActionLabel,
  approvalActionTone,
  fmtDays,
  LEAVE_STATUS_MAP,
  portionLabel,
  toneTextClass,
} from "../components/leave-vocab";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export default function LeaveDetailPage() {
  const { id } = useParams<{ id: string }>();
  const request = useLeaveRequest(id);
  const allocation = useLeaveAllocation(id);
  const trail = useApprovalTrail(id);

  const row = request.data ?? null;
  const heldStatuses = new Set(["pending", "cancellation_pending"]);
  const deductedStatuses = new Set(["approved", "partially_approved"]);

  return (
    <div>
      <PageHeader
        icon={CalendarCheck}
        title={row?.request_number ?? t("leave.title")}
        subtitle={t("leave.detail.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/leave">
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("leave.apply.back")}
            </Link>
          </Button>
        }
      />

      <StateBoundary
        loading={request.isLoading}
        error={request.error}
        onRetry={() => void request.refetch()}
        isEmpty={!request.isLoading && row === null}
        empty={
          <EmptyState
            title={t("leave.detail.notFound.title")}
            hint={t("leave.detail.notFound.hint")}
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/me/leave">{t("leave.apply.back")}</Link>
              </Button>
            }
          />
        }
        skeletonRows={4}
      >
        {row === null ? null : (
          <div className="space-y-6">
            {/* Summary */}
            <section aria-labelledby="leave-detail-summary">
              <h2 id="leave-detail-summary" className="mb-3 font-display text-lg font-semibold">
                {t("leave.detail.summary")}
              </h2>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={row.status} map={LEAVE_STATUS_MAP} />
                  {row.is_backdated ? (
                    <Badge variant="warning">{t("leave.detail.backdated")}</Badge>
                  ) : null}
                </div>

                <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Fact label={t("leave.col.type")}>{dash(row.leave_type?.name ?? null)}</Fact>
                  <Fact label={t("leave.col.dates")}>
                    {row.from_date === row.to_date
                      ? fmtCivilDate(row.from_date)
                      : t("leave.dateRange", {
                          from: fmtCivilDate(row.from_date),
                          to: fmtCivilDate(row.to_date),
                        })}
                  </Fact>
                  <Fact label={t("leave.alloc.col.portion")}>{portionLabel(row.portion)}</Fact>
                  <Fact label={t("leave.col.days")}>
                    <span className="num">{fmtDays(row.total_days)}</span>
                    <span className="ml-2 text-muted-foreground">
                      {t("leave.apply.preview.split", {
                        paid: fmtDays(row.paid_days),
                        unpaid: fmtDays(row.unpaid_days),
                      })}
                    </span>
                  </Fact>
                  <Fact label={t("leave.detail.submittedAt")}>{fmtDateTime(row.created_at)}</Fact>
                  <Fact label={t("leave.detail.decidedAt")}>
                    {row.decided_at === null ? dash(null) : fmtDateTime(row.decided_at)}
                  </Fact>
                  <Fact label={t("leave.detail.reason")}>{dash(row.reason)}</Fact>
                  <Fact label={t("leave.detail.contact")}>{dash(row.contact_during_leave)}</Fact>
                  <Fact label={t("leave.detail.handover")}>{dash(row.handover_notes)}</Fact>
                  {row.decision_comment === null ? null : (
                    <Fact label={t("leave.detail.decisionComment")}>{row.decision_comment}</Fact>
                  )}
                </dl>
              </div>
            </section>

            {/* Balance impact */}
            <section aria-labelledby="leave-detail-impact">
              <h2 id="leave-detail-impact" className="mb-3 font-display text-lg font-semibold">
                {t("leave.detail.impact.title")}
              </h2>
              <div className="rounded-lg border bg-card p-4">
                <p className="num font-display text-xl font-semibold leading-none">
                  {heldStatuses.has(row.status)
                    ? t("leave.detail.impact.held", { days: fmtDays(row.total_days) })
                    : deductedStatuses.has(row.status)
                      ? t("leave.detail.impact.deducted", {
                          days: fmtDays(row.approved_days ?? row.total_days),
                        })
                      : t("leave.detail.impact.released")}
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {t("leave.detail.impact.hint")}
                </p>

                {row.status === "approved" && isFutureIstDate(row.from_date) ? (
                  <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">
                      {t("leave.detail.cancel.unavailable")}
                    </span>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/me/helpdesk">
                        <LifeBuoy className="h-4 w-4" aria-hidden />
                        {t("leave.action.raise")}
                      </Link>
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            {/* Allocation */}
            <section aria-labelledby="leave-detail-allocation">
              <h2 id="leave-detail-allocation" className="mb-1 font-display text-lg font-semibold">
                {t("leave.detail.allocation.title")}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("leave.detail.allocation.hint")}
              </p>
              <StateBoundary
                loading={allocation.isLoading}
                error={allocation.error}
                onRetry={() => void allocation.refetch()}
                skeletonRows={3}
              >
                <AllocationTable
                  days={allocation.data ?? []}
                  emptyTitle={t("leave.detail.allocation.empty.title")}
                  emptyHint={t("leave.detail.allocation.empty.hint")}
                />
              </StateBoundary>
            </section>

            {/* Approval trail */}
            <section aria-labelledby="leave-detail-trail">
              <h2 id="leave-detail-trail" className="mb-3 font-display text-lg font-semibold">
                {t("leave.detail.trail.title")}
              </h2>
              <StateBoundary
                loading={trail.isLoading}
                error={trail.error}
                onRetry={() => void trail.refetch()}
                skeletonRows={2}
              >
                {trail.data?.request == null ? (
                  <EmptyState
                    title={t("leave.detail.trail.empty.title")}
                    hint={t("leave.detail.trail.noChain")}
                  />
                ) : (trail.data.actions.length === 0 ? (
                  <EmptyState
                    title={t("leave.detail.trail.empty.title")}
                    hint={t("leave.detail.trail.empty.hint")}
                  />
                ) : (
                  <div className="rounded-lg border bg-card p-4">
                    <p className="text-xs text-muted-foreground">
                      {t("leave.detail.trail.level", {
                        level: trail.data.request.current_level,
                        total: trail.data.request.total_levels,
                      })}
                      {" · "}
                      {t("leave.detail.trail.due", {
                        when: fmtDateTime(trail.data.request.sla_due_at),
                      })}
                    </p>
                    <ol className="mt-4 space-y-4">
                      {trail.data.actions.map((action) => {
                        const actor =
                          action.actor_id === null
                            ? null
                            : (trail.data?.actors.get(action.actor_id) ?? null);
                        return (
                          <li key={action.id} className="flex gap-3">
                            <span
                              className={cn(
                                "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current",
                                toneTextClass(approvalActionTone(action.action)),
                              )}
                              aria-hidden
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {approvalActionLabel(action.action)}
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {actor === null
                                  ? t("leave.detail.trail.system")
                                  : `${actor.display_name} · ${actor.employee_code}`}
                                {" · "}
                                {fmtDateTime(action.acted_at)}
                              </p>
                              {action.comment === null ? null : (
                                <p className="mt-1 break-words text-sm">{action.comment}</p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                ))}
              </StateBoundary>
            </section>
          </div>
        )}
      </StateBoundary>
    </div>
  );
}
