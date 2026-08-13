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
import { useState } from "react";
import { type MessageKey, t } from "@/shared/i18n/en";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Required } from "@/shared/ui/Required";
import { mutationUserMessage } from "@/shared/api/query";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { SubmitAttemptScope, SubmitBlockers, blockerButtonProps, useSubmitAttempt } from "@/shared/ui/SubmitBlockers";
import { resignationReasonValues, type ResignationReason } from "../api/simple-requests.api";
import {
  useOpenResignation,
  useSubmitResignation,
  useWithdrawResignation,
} from "../hooks/useApply";
import { cn } from "@/lib/utils";
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

  const [lastDay, setLastDay] = useState<string>(today);
  const [category, setCategory] = useState<ResignationReason>("better_opportunity");
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const send = useSubmitResignation();
  /*
    ONE OPEN RESIGNATION AT A TIME. `uq_resign__one_open` is a partial unique
    index over draft/pending/in_progress, so a second filing comes back as 23505
    — a duplicate-key message naming an index, which is not something anybody can
    act on. Reading the open row first means the form never offers the second
    filing at all, and can say what to do instead: withdraw the first.
  */
  const openResignation = useOpenResignation();
  const withdraw = useWithdrawResignation();
  const alreadyFiled = openResignation.data ?? null;
  /*
    THE SANCTIONED WAY TO BE SHORT. `ck_resign__notice_or_waiver` permits a last
    working day inside the notice period only when the waiver is asked for, and
    `ck_resign__waiver_reason` then demands a sentence. Without this on the form,
    the only route to an early exit was a refusal nobody could act on.

    Asking is not receiving: the flag records a request, and HR decides. The copy
    says so, because a checkbox that reads as permission is worse than no
    checkbox.
  */
  const [waiver, setWaiver] = useState(false);
  const [waiverReason, setWaiverReason] = useState("");
  const attempt = useSubmitAttempt();

  /*
    The earliest last working day the database will accept: today plus the notice
    period from the employment record. The screen already shows the number; this
    turns it into the date, which is the thing being typed.
  */
  const earliestLastDay = noticeDays === null ? today : addIstDays(today, noticeDays);

  const resignBlockers: string[] = [];
  if (lastDay < today) resignBlockers.push(t("apply.resign.blocked.past"));
  /*
    THE NOTICE RULE, ASKED BEFORE IT IS REFUSED.

    `ck_resign__notice_or_waiver` is a bare CHECK — not a trigger — so it comes
    back as "new row … violates check constraint" with no sentence anybody can
    act on. The form knows the same arithmetic the constraint does: the earliest
    permitted last working day is today + the notice period on the employment
    record. Refusing here means the constraint never fires, and the person is told
    the DATE rather than the constraint's name.

    `addIstDays`, not date maths in the browser's timezone: the constraint
    compares against `submitted_on`, which the server stamps as the IST civil day.
  */
  if (waiver && waiverReason.trim().length < 10) {
    resignBlockers.push(t("apply.resign.blocked.waiverReason"));
  }
  if (!waiver && noticeDays !== null && lastDay >= today && lastDay < earliestLastDay) {
    resignBlockers.push(
      t("apply.resign.blocked.notice.short", {
        days: formatNumber(noticeDays),
        date: fmtCivilDateWeekday(earliestLastDay),
      }),
    );
  }
  if (reason.trim().length < 10) resignBlockers.push(t("apply.resign.blocked.reason"));
  if (noticeDays === null) resignBlockers.push(t("apply.resign.blocked.notice"));

  return (
    <SubmitAttemptScope attempt={attempt}>
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
        {/*
          The gap notice that stood here said a resignation could not be filed
          because `resignations` did not exist and no chain was configured. Both
          were true; migration 040800 created the table and seeded AC-RESIGN.
        */}
        {sent !== null ? (
          <Notice tone="success">{t("apply.resign.done")}</Notice>
        ) : null}

        {alreadyFiled !== null ? (
          <section className="rounded-lg border border-warning/50 bg-warning/5 p-4">
            <h2 className="font-display text-lg font-semibold">
              {t("apply.resign.already.title")}
            </h2>
            <p className="mt-1 text-sm">
              {t("apply.resign.already.body", {
                reference: alreadyFiled.resignation_number,
                date: fmtCivilDateWeekday(alreadyFiled.intended_last_working_day),
              })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("apply.resign.already.hint")}
            </p>

            {withdraw.isError ? (
              <div className="mt-3">
                <Notice tone="error">{mutationUserMessage(withdraw.error)}</Notice>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={withdraw.isPending}
                onClick={() => {
                  withdraw.mutate(alreadyFiled.id, {
                    onSuccess: () => {
                      confirmSubmitted(t("apply.resign.withdrawn"), {
                        reference: alreadyFiled.resignation_number,
                        detail: t("apply.resign.withdrawn.next"),
                      });
                    },
                  });
                }}
              >
                {withdraw.isPending
                  ? t("apply.resign.withdrawing")
                  : t("apply.resign.withdraw")}
              </Button>
              <Button asChild variant="ghost">
                <Link to="/me/approvals">{t("apply.resign.already.track")}</Link>
              </Button>
            </div>
          </section>
        ) : null}

        <section
          className={cn(
            "rounded-lg border bg-card p-4",
            /* Dimmed and inert while one is standing — the section stays visible
               so the rules on it can still be read. */
            alreadyFiled !== null && "pointer-events-none opacity-50",
          )}
          aria-hidden={alreadyFiled !== null}
          aria-labelledby="resign-form"
        >
          <h2 id="resign-form" className="font-display text-lg font-semibold">
            {t("apply.resign.form.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("apply.resign.form.hint")}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="rg-last">{t("apply.resign.field.lastDay")}</Label>
              <Input
                id="rg-last"
                type="date"
                /* The earliest the CHECK permits, so the picker cannot offer a
                   date that would be refused. With a waiver asked for the floor
                   drops to today, which is exactly what the constraint does. The
                   blocker still catches a typed one — `min` is advisory in every
                   browser. */
                min={waiver ? today : earliestLastDay}
                className="mt-1.5 h-11"
                value={lastDay}
                onChange={(e) => setLastDay(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("apply.resign.field.lastDay.hint", { days: String(noticeDays ?? 30) })}
              </p>

              <div className="mt-3 rounded-md border bg-muted/30 p-3">
                <label className="flex items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 rounded border-input"
                    checked={waiver}
                    onChange={(e) => {
                      setWaiver(e.target.checked);
                      if (!e.target.checked) setWaiverReason("");
                    }}
                  />
                  <span>
                    <span className="font-medium">{t("apply.resign.waiver.ask")}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("apply.resign.waiver.hint")}
                    </span>
                  </span>
                </label>

                {waiver ? (
                  <div className="mt-2">
                    <Label htmlFor="rg-waiver">
                      {t("apply.resign.waiver.reason")}
                      <Required />
                    </Label>
                    <textarea
        required
                      id="rg-waiver"
                      rows={2}
                      maxLength={1000}
                      className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={waiverReason}
                      onChange={(e) => setWaiverReason(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{t("form.needTen")}</p>
                  </div>
                ) : null}
              </div>
            </div>
            <div>
              <Label htmlFor="rg-why">{t("apply.resign.field.category")}</Label>
              <select
                id="rg-why"
                value={category}
                onChange={(e) => setCategory(e.target.value as ResignationReason)}
                className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {resignationReasonValues.map((v) => (
                  <option key={v} value={v}>{t(`apply.resign.category.${v}` as MessageKey)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3">
            <Label htmlFor="rg-reason">{t("apply.resign.field.reason")}</Label>
            <textarea
              id="rg-reason"
              rows={3}
              maxLength={1000}
              className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("apply.resign.field.reason.hint")}</p>
          </div>

          {send.isError ? (
            <div className="mt-3"><Notice tone="error">{mutationUserMessage(send.error)}</Notice></div>
          ) : null}

          <SubmitBlockers
            attempt={attempt}
            blockers={resignBlockers}
            id="resign-blockers"
            title={t("apply.resign.blocked.title")}
          />

          <Button
            className="mt-4 w-full"
            disabled={send.isPending}
            {...blockerButtonProps(attempt, resignBlockers, "resign-blockers")}
            onClick={() => {
              if (alreadyFiled !== null) return;
              if (!attempt.press(resignBlockers)) return;
              if (noticeDays === null) return;
              send.mutate(
                {
                  /*
                    The notice period comes from `employees.notice_period_days`,
                    never from anything typed here. It is the figure the contract
                    is written against, and `trg_resign__notice` checks the last
                    working day against it server-side.
                  */
                  noticePeriodDays: noticeDays,
                  intendedLastWorkingDay: lastDay,
                  reasonCategory: category,
                  reason,
                  isNoticeWaiverRequested: waiver,
                  waiverReason,
                },
                {
                  onSuccess: (r) => {
                    attempt.reset();
                    setSent(r.requestId);
                    setReason("");
                    setWaiver(false);
                    setWaiverReason("");
                    confirmSubmitted(t("apply.resign.toast"), {
                      detail: t("apply.resign.toast.next"),
                    });
                  },
                },
              );
            }}
          >
            {send.isPending ? t("apply.resign.sending") : t("apply.resign.send")}
          </Button>
        </section>

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
    </SubmitAttemptScope>
  );
}
