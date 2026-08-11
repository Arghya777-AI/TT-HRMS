/**
 * /team/approvals — everything awaiting THIS manager's decision.
 *
 * The most consequential manager screen in the product, so five things are held
 * deliberately rather than incidentally:
 *
 *  1. THE QUEUE IS THE DATABASE'S. `v_approval_inbox` ends in
 *     `app.current_employee_id() = ANY (ar.current_approver_ids)`. This page adds
 *     no scope predicate, because a client predicate is not a scope — and it means
 *     an empty result is a real, correct answer. An empty inbox therefore reads as
 *     "nothing is waiting on you", never as an error and never as a blank grid.
 *  2. THE CLOCK IS NEVER COMPARED HERE. `sla_due_at`, `sla_remaining_hours`,
 *     `is_overdue` and `age_hours` are COLUMNS, evaluated inside Postgres against
 *     `now()` in the same statement that produced the row. A browser whose clock
 *     is ten minutes fast must not be able to turn an on-time request red.
 *     `fmtDurationFromHours` converts the server's decimal hours to '18h 30m' for
 *     display and does nothing else.
 *  3. A DECISION COSTS A SENTENCE. Approve and Reject both open `<ReasonDialog>`
 *     at 15 characters (D-21), and the sentence travels through
 *     `useAuditedMutation` into `act_on_approval`'s `p_comment` — where it becomes
 *     the permanent decision comment on the trail — AND into the `x-reason` header
 *     the audit engine requires for the balance writes the decision triggers.
 *  4. THE TILES ARE SERVER COUNTS. Each is a `count=exact` over the same
 *     predicate as the rows it filters to, so the tile and the grid cannot
 *     disagree about how many things are overdue.
 *  5. IT SHOWS ITS WORK. Opening a row shows the full append-only approval trail
 *     — who did what, when, as whom, and what they wrote — because a decision
 *     queue with no history is a queue you have to trust rather than check.
 *
 * Where a decision does NOT finish the story, the screen says so: on a leave
 * request above the chain's day band the manager's approval hands the request to
 * HR, and for request types whose apply step lives server-side (and is not
 * deployed) the decision is recorded but the underlying row is untouched. Both are
 * reported in words rather than presented as a plain success.
 *
 * @route /team/approvals
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CircleCheck, Clock, Inbox, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { fmtCivilDate, fmtDateTime, fmtDurationFromHours } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { summaryText } from "@/features/apply/api/apply.api";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "@/features/admin/components/Notice";
import { PersonCell } from "@/features/admin/components/PersonCell";
import { SelectField } from "@/features/admin/components/Field";
import { useReasonPrompt } from "@/features/admin/hooks/useReasonPrompt";
import {
  APPROVAL_ROW_CAP,
  LEAVE_REQUESTS_TABLE,
  isApprovalSlice,
  readSummaryFacts,
  type ApprovalDecision,
  type ApprovalDecisionResult,
  type ApprovalInboxRow,
  type ApprovalSlice,
} from "../api/team.api";
import {
  useApprovalContext,
  useApprovalCount,
  useApprovalInbox,
  useApprovalTrail,
  useDecideApproval,
} from "../hooks/useTeamDecisions";

/** `approval_status`, chipped. Only the three open states reach this queue. */
const REQUEST_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("team.approvals.state.pending"), tone: "warn" },
  in_progress: { label: t("team.approvals.state.in_progress"), tone: "info" },
  escalated: { label: t("team.approvals.state.escalated"), tone: "danger" },
};

/** `approval_requests.priority` — a text column with a CHECK, never shown raw. */
const PRIORITY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  low: { label: t("team.approvals.priority.low"), tone: "neutral" },
  normal: { label: t("team.approvals.priority.normal"), tone: "neutral" },
  high: { label: t("team.approvals.priority.high"), tone: "warn" },
  urgent: { label: t("team.approvals.priority.urgent"), tone: "danger" },
};

/**
 * `public.approval_action`. Every value the trail can hold gets a sentence,
 * because a raw `skip_level` or `admin_override` on an evidence surface is the
 * same defect class as a raw enum anywhere else (DR-53).
 */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  submit: t("team.approvals.action.submit"),
  approve: t("team.approvals.action.approve"),
  reject: t("team.approvals.action.reject"),
  request_info: t("team.approvals.action.request_info"),
  provide_info: t("team.approvals.action.provide_info"),
  comment: t("team.approvals.action.comment"),
  delegate: t("team.approvals.action.delegate"),
  reassign: t("team.approvals.action.reassign"),
  escalate: t("team.approvals.action.escalate"),
  skip_level: t("team.approvals.action.skip_level"),
  recall: t("team.approvals.action.recall"),
  cancel: t("team.approvals.action.cancel"),
  auto_approve: t("team.approvals.action.auto_approve"),
};

/** `approval_actions.acted_as` — how the actor held the authority they used. */
const ACTED_AS_LABEL: Readonly<Record<string, string>> = {
  approver: t("team.approvals.actedAs.approver"),
  delegate: t("team.approvals.actedAs.delegate"),
  admin_override: t("team.approvals.actedAs.admin_override"),
};

const TILES: readonly { slice: ApprovalSlice; label: string; tone: string }[] = [
  { slice: "all", label: t("team.approvals.tile.waiting"), tone: "border-info/50" },
  { slice: "overdue", label: t("team.approvals.tile.overdue"), tone: "border-destructive/50" },
  { slice: "escalated", label: t("team.approvals.tile.escalated"), tone: "border-warning/50" },
];

/** What the reason dialog is about to do, carried as one object (never two). */
interface DecisionTarget {
  readonly row: ApprovalInboxRow;
  readonly decision: ApprovalDecision;
}

export default function TeamApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const { user, employee } = useAuth();
  const decidedByProfileId = user?.id ?? null;
  const actorName = employee?.displayName ?? null;

  const rawSlice = params.get("slice");
  const slice: ApprovalSlice = isApprovalSlice(rawSlice) ? rawSlice : "all";
  const typeCode = params.get("type") ?? "";
  const openId = params.get("open");

  const inbox = useApprovalInbox();
  // Memoised so the three useMemo filters below keep a stable dep while loading.
  const allRows = useMemo(() => inbox.data ?? [], [inbox.data]);

  const counts = {
    all: useApprovalCount("all"),
    overdue: useApprovalCount("overdue"),
    escalated: useApprovalCount("escalated"),
  } as const;

  // The enrichment (dates, the requester's own reason) is keyed off the rows the
  // queue actually returned, so it never asks for anything it cannot already see.
  const context = useApprovalContext(allRows);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  /**
   * The slice and type predicates applied to the loaded queue.
   *
   * Filtering 100 already-loaded rows in the browser is a VIEW choice, not a
   * derivation: no number is computed from it. The tiles above still show
   * Postgres's counts over the same predicates, which is what a manager reads to
   * know how much is waiting.
   */
  const rows = useMemo(() => {
    return allRows.filter((r) => {
      if (slice === "overdue" && r.is_overdue !== true) return false;
      if (slice === "escalated" && r.escalated_at === null) return false;
      if (typeCode !== "" && r.request_type_code !== typeCode) return false;
      return true;
    });
  }, [allRows, slice, typeCode]);

  /** The request types actually present, so the filter offers no dead options. */
  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of allRows) seen.set(r.request_type_code, r.request_type_name);
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allRows]);


  const prompt = useReasonPrompt<DecisionTarget>();
  const { ask, close: closePrompt, target, isOpen } = prompt;
  const [outcome, setOutcome] = useState<ApprovalDecisionResult | null>(null);

  const decide = useDecideApproval((result) => {
    closePrompt();
    setOutcome(result);
  });

  const capped = allRows.length >= APPROVAL_ROW_CAP;

  const columns: DataGridColumn<ApprovalInboxRow>[] = useMemo(
    () => [
      {
        key: "subject",
        header: t("team.approvals.col.who"),
        width: "14rem",
        sortable: true,
        sortValue: (r) => r.subject_display_name ?? "",
        render: (r) => (
          <PersonCell
            name={r.subject_display_name}
            code={r.subject_employee_code}
            secondary={r.subject_department_name}
          />
        ),
      },
      {
        key: "what",
        header: t("team.approvals.col.what"),
        width: "15rem",
        sortable: true,
        sortValue: (r) => r.request_type_name,
        /*
          THE TITLE, NOT JUST THE TYPE.

          Reported: "I request laptop it is not visible, to show I have to click
          to see more details". The column said "Asset Request" for every asset
          request — true and useless. `approval_requests.title` is written by
          whoever raised it and says WHICH thing: "Asset · Laptops ×1",
          "Travel · Bengaluru → Coorg", "Sick Leave · 11 Aug". Every request type
          carries one, so this needs no per-type branch.
        */
        render: (r) => (
          <span className="flex flex-col leading-tight">
            <span className="font-medium">{r.title}</span>
            <span className="text-xs text-muted-foreground">
              {r.request_type_name} · <span className="num">{r.request_number}</span>
            </span>
          </span>
        ),
      },
      {
        key: "dates",
        header: t("team.approvals.col.dates"),
        width: "13rem",
        // From the submitted payload (`approval_requests.summary`), decoded — not
        // measured. A type that carries no dates renders an em dash.
        render: (r) => {
          const facts = readSummaryFacts(context.data?.refs.get(r.approval_request_id)?.summary);
          if (facts.fromDate === null) return dash(null);
          if (facts.toDate === null || facts.toDate === facts.fromDate) {
            return <span className="num">{fmtCivilDate(facts.fromDate)}</span>;
          }
          return (
            <span className="num">
              {t("team.approvals.dateRange", {
                from: fmtCivilDate(facts.fromDate),
                to: fmtCivilDate(facts.toDate),
              })}
            </span>
          );
        },
      },
      {
        key: "days",
        header: t("team.approvals.col.days"),
        width: "6rem",
        align: "right",
        // `approval_requests.days`, straight through. The chain bands on it.
        render: (r) => <span className="num">{formatDays(r.days)}</span>,
      },
      {
        key: "reason",
        header: t("team.approvals.col.reason"),
        width: "16rem",
        hideBelow: "lg",
        render: (r) => {
          /*
            LEAVE FIRST, then everything else. A leave request's reason is the
            sentence the employee typed into `leave_requests`, which no workflow
            table carries — so it is worth the extra read. Every OTHER type puts
            its sentence in `approval_requests.summary`, and this column used to
            return a dash for all of them: an asset request showed nothing at all,
            which is what sent managers clicking into each row to find out what
            was being asked for.
          */
          const ref = context.data?.refs.get(r.approval_request_id);
          const leave =
            ref !== undefined && ref.detail_table === LEAVE_REQUESTS_TABLE
              ? context.data?.leave.get(ref.detail_id)
              : undefined;
          const text = leave?.reason ?? summaryText(ref?.summary);
          if (text === null || text === undefined || text.trim() === "") return dash(null);
          return <span className="line-clamp-2 text-sm text-muted-foreground">{text}</span>;
        },
      },
      {
        key: "sla",
        header: t("team.approvals.col.sla"),
        width: "12rem",
        align: "right",
        sortable: true,
        sortValue: (r) => r.sla_due_at,
        // is_overdue / sla_remaining_hours are the SERVER's verdict and the
        // SERVER's countdown. Nothing here compares two clocks.
        render: (r) => (
          <span className="flex flex-col items-end leading-tight">
            <span
              className={cn(
                "num font-medium",
                r.is_overdue === true ? "text-destructive" : "text-foreground",
              )}
            >
              {r.is_overdue === true
                ? t("team.approvals.overdueBy", {
                    duration: fmtDurationFromHours(
                      r.sla_remaining_hours === null ? null : Math.abs(r.sla_remaining_hours),
                    ),
                  })
                : t("team.approvals.dueIn", {
                    duration: fmtDurationFromHours(r.sla_remaining_hours),
                  })}
            </span>
            <span className="num text-xs text-muted-foreground">{fmtDateTime(r.sla_due_at)}</span>
          </span>
        ),
      },
      {
        key: "age",
        header: t("team.approvals.col.age"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        sortable: true,
        sortValue: (r) => r.age_hours ?? 0,
        render: (r) => <span className="num">{fmtDurationFromHours(r.age_hours)}</span>,
      },
      {
        key: "level",
        header: t("team.approvals.col.level"),
        width: "9rem",
        hideBelow: "lg",
        render: (r) => (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm">
              {t("team.approvals.levelOf", {
                current: formatNumber(r.current_level),
                total: formatNumber(r.total_levels),
              })}
            </span>
            <StatusChip status={r.priority} map={PRIORITY_CHIP} />
          </span>
        ),
      },
      {
        key: "status",
        header: t("team.approvals.col.status"),
        width: "10rem",
        render: (r) => <StatusChip status={r.status} map={REQUEST_STATUS_CHIP} />,
      },
      {
        key: "actions",
        header: t("team.approvals.col.decision"),
        width: "14rem",
        align: "right",
        render: (r) => {
          if (decidedByProfileId === null) {
            return (
              <span className="text-xs text-muted-foreground">
                {t("team.approvals.noSession")}
              </span>
            );
          }
          return (
            <span className="inline-flex gap-2">
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  ask({ row: r, decision: "approve" });
                }}
              >
                {t("team.approvals.btn.approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  ask({ row: r, decision: "reject" });
                }}
              >
                {t("team.approvals.btn.reject")}
              </Button>
            </span>
          );
        },
      },
    ],
    [context.data, decidedByProfileId, decide.isPending, ask],
  );

  const total = counts.all;
  const subtitle = total.isSuccess
    ? total.data === 0
      ? t("team.approvals.subtitle.clear")
      : t("team.approvals.subtitle.count", { n: formatNumber(total.data) })
    : t("team.approvals.subtitle.plain");

  return (
    <div className="container py-6">
      <PageHeader
        icon={Inbox}
        title={t("team.approvals.title")}
        subtitle={subtitle}
        actions={
          <Button
            variant="outline"
            onClick={() => void inbox.refetch()}
            disabled={inbox.isFetching}
          >
            <RefreshCw
              className={cn("mr-2 size-4", inbox.isFetching && "animate-spin")}
              aria-hidden
            />
            {t("team.approvals.refresh")}
          </Button>
        }
      />

      {outcome !== null ? <DecisionOutcome outcome={outcome} onDismiss={() => setOutcome(null)} /> : null}

      {capped ? (
        <Notice tone="warning" className="mb-4">
          {t("team.approvals.rowCap", { count: formatNumber(APPROVAL_ROW_CAP) })}
        </Notice>
      ) : null}

      {/* Server counts. Each tile filters the grid to its own predicate. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TILES.map((tile) => {
          const q = counts[tile.slice];
          const active = slice === tile.slice;
          return (
            <button
              key={tile.slice}
              type="button"
              aria-pressed={active}
              onClick={() => setParam("slice", tile.slice === "all" ? "" : tile.slice)}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tile.tone,
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? dash(null) : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("team.approvals.filter.type")}
          value={typeCode}
          placeholder={t("team.approvals.filter.anyType")}
          options={typeOptions}
          onChange={(v) => setParam("type", v)}
        />
        <div className="flex items-end">
          {slice !== "all" || typeCode !== "" ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("team.approvals.filter.clear")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {t("team.approvals.showing", { n: formatNumber(rows.length) })}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={inbox.isPending}
          error={inbox.error}
          onRetry={() => void inbox.refetch()}
          isEmpty={rows.length === 0}
          partialError={context.error}
          partialLabel={t("team.approvals.partial.context")}
          skeletonRows={6}
          empty={
            slice !== "all" || typeCode !== "" ? (
              <EmptyState
                icon={Inbox}
                title={t("team.approvals.empty.filtered.title")}
                hint={t("team.approvals.empty.filtered.hint")}
                action={
                  <Button
                    variant="outline"
                    onClick={() => setParams(new URLSearchParams(), { replace: true })}
                  >
                    {t("team.approvals.filter.clear")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={CircleCheck}
                title={t("team.approvals.empty.title")}
                hint={t("team.approvals.empty.hint")}
              />
            )
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.approval_request_id}
            pageSize={25}
            onRowClick={(r) =>
              setParam("open", openId === r.approval_request_id ? "" : r.approval_request_id)
            }
            /*
              UNDER THE ROW, not under the grid. It used to render after the whole
              list: "if we have lot row then we have to go down to see details".
              With 25 rows on a page the detail was a screen and a half away from
              the row it described.
            */
            renderRowDetail={(r) =>
              r.approval_request_id === openId ? (
                <RequestDetail row={r} onClose={() => setParam("open", "")} />
              ) : null
            }
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("team.approvals.footnote")}</Notice>
      </div>

      <ReasonDialog
        open={isOpen}
        title={
          target === null
            ? t("team.approvals.dialog.approveTitle", { number: "" })
            : target.decision === "reject"
              ? t("team.approvals.dialog.rejectTitle", { number: target.row.request_number })
              : t("team.approvals.dialog.approveTitle", { number: target.row.request_number })
        }
        description={
          target?.decision === "reject"
            ? t("team.approvals.dialog.rejectDescription")
            : t("team.approvals.dialog.approveDescription")
        }
        actorName={actorName}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={
          target?.decision === "reject"
            ? t("team.approvals.btn.reject")
            : t("team.approvals.btn.approve")
        }
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={(reason) => {
          if (target === null) return;
          const ref = context.data?.refs.get(target.row.approval_request_id);
          decide.save(
            {
              approvalRequestId: target.row.approval_request_id,
              requestNumber: target.row.request_number,
              decision: target.decision,
              detailTable: ref?.detail_table ?? null,
              detailId: ref?.detail_id ?? null,
              decidedByProfileId,
            },
            reason,
          );
        }}
        onCancel={() => {
          decide.reset();
          closePrompt();
        }}
      />
    </div>
  );
}

/**
 * What actually happened, in words.
 *
 * A decision has three honest outcomes and this component refuses to collapse
 * them into one green tick: the request settled and the leave row moved with it;
 * the request settled but the underlying row has no client apply path; or the
 * chain simply advanced to the next approver and is still in flight.
 */
function DecisionOutcome({
  outcome,
  onDismiss,
}: {
  outcome: ApprovalDecisionResult;
  onDismiss: () => void;
}) {
  const number = outcome.approval.request_number;
  const dismiss = (
    <Button variant="ghost" size="sm" onClick={onDismiss}>
      {t("team.approvals.dismiss")}
    </Button>
  );

  if (outcome.applyError !== null) {
    return (
      <Notice tone="warning" className="mb-4" action={dismiss}>
        {t("team.approvals.outcome.applyFailed", { number, message: outcome.applyError })}
      </Notice>
    );
  }
  if (outcome.notAppliedReason === "chain_continues") {
    return (
      <Notice tone="info" className="mb-4" action={dismiss}>
        {t("team.approvals.outcome.chainContinues", {
          number,
          level: String(outcome.approval.current_level),
        })}
      </Notice>
    );
  }
  if (outcome.notAppliedReason === "no_apply_path") {
    return (
      <Notice tone="warning" className="mb-4" action={dismiss}>
        {t("team.approvals.outcome.noApplyPath", { number })}
      </Notice>
    );
  }
  return (
    <Notice tone="success" className="mb-4" action={dismiss}>
      {outcome.approval.status === "rejected"
        ? t("team.approvals.outcome.rejected", { number })
        : t("team.approvals.outcome.approved", { number })}
    </Notice>
  );
}

/**
 * The opened request: what was asked for, in the requester's own words, and every
 * action ever taken on it.
 *
 * The trail is append-only in Postgres — `approval_actions` has no UPDATE or
 * DELETE policy and a trigger refuses both — so this list is evidence rather than
 * a log that could have been tidied. Actions with no actor (`skip_level`, written
 * by `advance_approval` itself) are attributed to the system in words, never left
 * blank.
 */
function RequestDetail({ row, onClose }: { row: ApprovalInboxRow; onClose: () => void }) {
  const context = useApprovalContext([row]);
  const trail = useApprovalTrail(row.approval_request_id);

  const ref = context.data?.refs.get(row.approval_request_id) ?? null;
  const facts = readSummaryFacts(ref?.summary);
  const leave =
    ref !== null && ref.detail_table === LEAVE_REQUESTS_TABLE
      ? context.data?.leave.get(ref.detail_id) ?? null
      : null;

  return (
    <section className="mt-4 rounded-lg border bg-card p-4" aria-label={t("team.approvals.detail.title")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {t("team.approvals.detail.heading", {
              number: row.request_number,
              type: row.request_type_name,
            })}
          </h2>
          <p className="text-sm text-muted-foreground">{row.title}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("team.approvals.detail.close")}
        </Button>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailFact
          label={t("team.approvals.detail.employee")}
          value={dash(row.subject_display_name)}
        />
        <DetailFact
          label={t("team.approvals.detail.dates")}
          value={
            facts.fromDate === null
              ? dash(null)
              : facts.toDate === null || facts.toDate === facts.fromDate
                ? fmtCivilDate(facts.fromDate)
                : t("team.approvals.dateRange", {
                    from: fmtCivilDate(facts.fromDate),
                    to: fmtCivilDate(facts.toDate),
                  })
          }
        />
        <DetailFact label={t("team.approvals.detail.days")} value={formatDays(row.days)} />
        <DetailFact
          label={t("team.approvals.detail.submitted")}
          value={fmtDateTime(row.submitted_at)}
        />
        <DetailFact
          label={t("team.approvals.detail.slaDue")}
          value={fmtDateTime(row.sla_due_at)}
        />
        <DetailFact
          label={t("team.approvals.detail.firstAction")}
          value={dash(ref?.first_action_at ?? null, fmtDateTime)}
        />
        <DetailFact
          label={t("team.approvals.detail.escalated")}
          value={dash(row.escalated_at, fmtDateTime)}
        />
        <DetailFact
          label={t("team.approvals.detail.backdated")}
          value={
            leave === null
              ? dash(null)
              : leave.is_backdated
                ? t("team.approvals.detail.yes")
                : t("team.approvals.detail.no")
          }
        />
      </dl>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border bg-background p-3">
          <h3 className="text-sm font-medium">{t("team.approvals.detail.theirReason")}</h3>
          <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
            {leave === null ? t("team.approvals.detail.noReasonOnFile") : leave.reason}
          </p>
          {leave !== null && leave.handover_notes !== null && leave.handover_notes !== "" ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("team.approvals.detail.handover", { notes: leave.handover_notes })}
            </p>
          ) : null}
          {leave !== null && leave.contact_during_leave !== null ? (
            <p className="num mt-2 text-sm text-muted-foreground">
              {t("team.approvals.detail.contact", { contact: leave.contact_during_leave })}
            </p>
          ) : null}
        </div>

        <div className="rounded-md border bg-background p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            {t("team.approvals.detail.trail")}
          </h3>
          <StateBoundary
            loading={trail.isPending}
            error={trail.error}
            onRetry={() => void trail.refetch()}
            isEmpty={(trail.data?.actions.length ?? 0) === 0}
            skeletonRows={3}
            empty={
              <p className="mt-2 text-sm text-muted-foreground">
                {t("team.approvals.detail.trailEmpty")}
              </p>
            }
          >
            <ol className="mt-2 space-y-3">
              {(trail.data?.actions ?? []).map((action) => {
                const actor =
                  action.actor_id === null ? null : trail.data?.actors.get(action.actor_id) ?? null;
                const actedAs =
                  action.acted_as === null ? null : ACTED_AS_LABEL[action.acted_as] ?? null;
                return (
                  <li key={action.id} className="border-l-2 border-border pl-3">
                    <p className="text-sm font-medium">
                      {ACTION_LABEL[action.action] ?? action.action}
                      <span className="ml-2 num text-xs font-normal text-muted-foreground">
                        {t("team.approvals.detail.atLevel", { level: String(action.level) })}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {actor === null
                        ? t("team.approvals.detail.bySystem")
                        : t("team.approvals.detail.byActor", {
                            name: actor.display_name,
                            code: actor.employee_code,
                          })}
                      {actedAs === null ? "" : ` · ${actedAs}`}
                    </p>
                    <p className="num text-xs text-muted-foreground">
                      {fmtDateTime(action.acted_at)}
                    </p>
                    {action.comment !== null && action.comment !== "" ? (
                      <p className="mt-1 whitespace-pre-line text-sm">{action.comment}</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </StateBoundary>
        </div>
      </div>

      {ref !== null && ref.detail_table !== LEAVE_REQUESTS_TABLE ? (
        <div className="mt-3">
          <Notice tone="info">{t("team.approvals.detail.noApplyPathNote")}</Notice>
        </div>
      ) : null}

      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="size-3.5" aria-hidden />
        {t("team.approvals.detail.ageNote", { duration: fmtDurationFromHours(row.age_hours) })}
      </p>
    </section>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-sm font-medium">{value}</dd>
    </div>
  );
}
