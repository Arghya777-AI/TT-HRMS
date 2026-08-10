/**
 * §12 · /admin/workflow/inbox — Approval Inbox. Everything awaiting an
 * administrator's decision, organisation-wide.
 *
 * The distinction this screen exists to make: `/admin/tasks` and
 * `/team/approvals` are the queues with YOUR name on them (`v_approval_inbox`,
 * scoped in Postgres to `current_employee_id() = ANY current_approver_ids`).
 * This is the ORGANISATION'S queue — every live request, whoever it is waiting
 * on — read from `approval_requests` under `ar__admin_read`
 * (`app.is_admin() AND app.admin_scope_covers(subject)`). It therefore has to be
 * honest about two things a personal inbox never faces:
 *
 *  1. MOST ROWS ARE NOT YOURS TO DECIDE, AND EACH ROW SAYS SO. Approve/Reject
 *     appear only where this admin's employee id is actually in the row's
 *     materialised `current_approver_ids`; every other row shows, in words, who
 *     it is waiting on. That check is an AFFORDANCE — `act_on_approval` is
 *     SECURITY DEFINER and re-asserts authorisation server-side, refusing a
 *     non-approver, a self-approval and a repeat approval of the same level.
 *     Administrative override IS a capability the RPC has (`acted_as =
 *     'admin_override'`), and it is deliberately NOT offered here: reaching past
 *     a named approver belongs on a screen built to demand a justification for
 *     that specific act, and the Override Log is where the ones that happened
 *     are read.
 *  2. THE CLOCK IS NEVER THE BROWSER'S. `v_approval_inbox` carries `is_overdue`
 *     and `sla_remaining_hours` computed inside Postgres — but only for the
 *     caller's own rows, so this screen cannot use it. Rather than compare
 *     `sla_due_at` to the browser's idea of "now" (a console that calls a request
 *     late while the database does not is precisely the defect this codebase is
 *     written against), the "Late" tile is driven by `sla_breaches` — rows
 *     `sla_sweep()` writes on the server's clock every 30 minutes. The screen
 *     prints when that sweep last recorded one, so the slice's freshness is
 *     visible rather than assumed.
 *
 * Every number is a server count over the SAME predicate as the rows it opens
 * (`inboxFilters`), the grid is keyset-paged, and the trail under an opened row
 * is `approval_actions` — append-only in Postgres, no UPDATE or DELETE policy for
 * anyone plus a trigger that refuses both — so it is evidence, not a log that
 * could have been tidied.
 *
 * @route /admin/workflow/inbox
 */
import { useMemo, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { useSearchParams } from "react-router-dom";
import { Inbox, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StatusChip } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import {
  ACTED_AS_LABEL,
  PRIORITY_CHIP,
  REQUEST_STATUS_CHIP,
  actionLabel,
  roleLabel,
} from "../workflow-vocab";
import {
  approvalPriorityValues,
  approvalStatusValues,
  isInboxSlice,
  readSummaryFacts,
  type ApprovalDecision,
  type ApprovalDecisionResult,
  type ApprovalPriority,
  type ApprovalRequestRow,
  type ApprovalStatus,
  type InboxFilters,
  type InboxSlice,
} from "../api/workflow-admin.api";
import {
  flattenInbox,
  useApprovalRequestCount,
  useApprovalRequests,
  useApprovalTrail,
  useDecideApproval,
  useOpenBreachRequestIds,
  usePeopleByEmployeeId,
  useRequestTypeMap,
  useRequestTypes,
} from "../hooks/useWorkflowAdmin";

/** Every slice except `all`, which is the "clear the filters" state, not a tile. */
type TileSlice = Exclude<InboxSlice, "all">;

/** The tiles, in the order an administrator triages them. */
const TILES: readonly { slice: TileSlice; label: string; ring: string }[] = [
  { slice: "open", label: t("admin.wf.inbox.tile.open"), ring: "border-info/50" },
  { slice: "mine", label: t("admin.wf.inbox.tile.mine"), ring: "border-primary/50" },
  { slice: "breached", label: t("admin.wf.inbox.tile.breached"), ring: "border-destructive/50" },
  { slice: "escalated", label: t("admin.wf.inbox.tile.escalated"), ring: "border-warning/50" },
  { slice: "settled", label: t("admin.wf.inbox.tile.settled"), ring: "border-border" },
];

const SLICE_HINT: Readonly<Record<InboxSlice, string>> = {
  open: t("admin.wf.inbox.hint.open"),
  mine: t("admin.wf.inbox.hint.mine"),
  breached: t("admin.wf.inbox.hint.breached"),
  escalated: t("admin.wf.inbox.hint.escalated"),
  settled: t("admin.wf.inbox.hint.settled"),
  all: t("admin.wf.inbox.hint.all"),
};

function isStatus(value: string): value is ApprovalStatus {
  return (approvalStatusValues as readonly string[]).includes(value);
}

function isPriority(value: string): value is ApprovalPriority {
  return (approvalPriorityValues as readonly string[]).includes(value);
}

/** What the reason dialog is about to do, carried as ONE object (never two). */
interface DecisionTarget {
  readonly row: ApprovalRequestRow;
  readonly decision: ApprovalDecision;
}

export default function ApprovalInboxPage() {
  const [params, setParams] = useSearchParams();
  const myEmployeeId = useEmployeeId();
  const myProfileId = useProfileId();

  const rawSlice = params.get("slice");
  const slice: InboxSlice = isInboxSlice(rawSlice) ? rawSlice : "open";
  const requestTypeId = params.get("type") ?? "";
  const rawStatus = params.get("status") ?? "";
  const status = isStatus(rawStatus) ? rawStatus : undefined;
  const rawPriority = params.get("priority") ?? "";
  const priority = isPriority(rawPriority) ? rawPriority : undefined;

  const [openId, setOpenId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ApprovalDecisionResult | null>(null);
  const prompt = useReasonPrompt<DecisionTarget>();

  const types = useRequestTypes();
  const typeMap = useRequestTypeMap(types.data);

  // The one server-recorded "late" fact available org-wide (see the header).
  const breachIds = useOpenBreachRequestIds();

  const filters = useMemo<InboxFilters>(
    () => ({
      slice,
      ...(requestTypeId !== "" ? { requestTypeId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(myEmployeeId !== null ? { approverEmployeeId: myEmployeeId } : {}),
      ...(slice === "breached" ? { breachedRequestIds: breachIds.data ?? [] } : {}),
    }),
    [slice, requestTypeId, status, priority, myEmployeeId, breachIds.data],
  );

  const list = useApprovalRequests(filters);
  const rows = flattenInbox(list.data);
  const total = useApprovalRequestCount(filters);

  // One count per tile, over the tile's slice PLUS whatever filters are set, so
  // clicking a tile lands on a grid with exactly that many rows.
  const tileFilters = (tileSlice: TileSlice): InboxFilters => ({
    ...filters,
    slice: tileSlice,
    ...(tileSlice === "breached" ? { breachedRequestIds: breachIds.data ?? [] } : {}),
  });
  const counts: Record<TileSlice, ReturnType<typeof useApprovalRequestCount>> = {
    open: useApprovalRequestCount(tileFilters("open")),
    mine: useApprovalRequestCount(tileFilters("mine")),
    breached: useApprovalRequestCount(tileFilters("breached")),
    escalated: useApprovalRequestCount(tileFilters("escalated")),
    settled: useApprovalRequestCount(tileFilters("settled")),
  };

  // Names for the subjects on screen — a join, keyed by the ids already loaded.
  const subjectIds = useMemo(() => rows.map((r) => r.subject_employee_id), [rows]);
  const people = usePeopleByEmployeeId(subjectIds);

  const decide = useDecideApproval((result) => {
    setOutcome(result);
    prompt.close();
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };


  /** Is this admin actually one of the row's current approvers? */
  /*
    ── WHO MAY DECIDE HERE ───────────────────────────────────────────────────────

    REPORTED, repeatedly: "Suraj is super-admin but still can't see button to
    approve". He could not, and this was the screen he was on. The header above
    said an administrative override "is deliberately NOT offered here" and
    pointed at a screen built to justify it — but no such screen offers it for a
    request whose named approver has simply not looked yet, so the capability was
    unreachable from anywhere. A rule nobody can satisfy is not a control.

    THE RULE, as specified: "72 hours restriction was for admin — if manager has
    not approved within 72 hours then admin can approve. super-admin has no
    restriction."

      the named approver  →  always, at their own level
      super_admin         →  any open request, immediately
      admin               →  only once the SLA has been breached

    THE ROLE, NOT A CAPABILITY. `capsForRoles` grants `admin.super` to the plain
    `admin` role too, so `can("admin.super")` is true for both and cannot tell
    them apart. Only `user_roles` can, and reading the capability instead would
    silently hand every admin the unrestricted power.

    THE CLOCK IS STILL NEVER THE BROWSER'S — the point the header makes at length.
    "Breached" is `sla_breaches`, rows `sla_sweep()` writes on the server's clock,
    already loaded on this page for the breach tile. No `sla_due_at` is compared
    to the browser's idea of now.

    NOT YOUR OWN REQUEST, either way: `act_on_approval` exempts an admin from its
    self-approval refusal, so this is the only thing standing between an
    administrator and approving their own claim.
  */
  const { roles } = useAuth();
  const isSuperAdmin = roles.includes("super_admin");
  const breachedIds = useMemo(
    () => new Set<string>(breachIds.data ?? []),
    [breachIds.data],
  );

  const isNamedApprover = (row: ApprovalRequestRow): boolean =>
    myEmployeeId !== null && row.current_approver_ids.includes(myEmployeeId);

  /** True when acting would reach past the named approver. */
  const isOverride = (row: ApprovalRequestRow): boolean => {
    if (isNamedApprover(row)) return false;
    if (myEmployeeId !== null && row.subject_employee_id === myEmployeeId) return false;
    return isSuperAdmin || breachedIds.has(row.id);
  };

  const canDecide = (row: ApprovalRequestRow): boolean =>
    isNamedApprover(row) || isOverride(row);

  const columns: DataGridColumn<ApprovalRequestRow>[] = [
    {
      key: "request_number",
      header: t("admin.wf.inbox.col.request"),
      width: "16rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.title}</span>
          <span className="num text-xs text-muted-foreground">{row.request_number}</span>
        </span>
      ),
    },
    {
      key: "request_type_id",
      header: t("admin.wf.inbox.col.type"),
      width: "11rem",
      hideBelow: "sm",
      render: (row) => dash(typeMap.get(row.request_type_id)?.name ?? null),
    },
    {
      key: "subject_employee_id",
      header: t("admin.wf.inbox.col.subject"),
      width: "13rem",
      render: (row) => {
        const person = people.data?.get(row.subject_employee_id) ?? null;
        return person === null ? (
          <span className="text-sm text-muted-foreground">{dash(null)}</span>
        ) : (
          <PersonCell
            name={person.display_name}
            code={person.employee_code}
            secondary={person.department_name}
          />
        );
      },
    },
    {
      key: "amount",
      header: t("admin.wf.inbox.col.value"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      // `amount` is numeric(14,2) RUPEES on this table (paise is the payroll
      // convention); `days` is the day figure the chain bands on. Neither is
      // computed — one column or the other, or an em dash.
      render: (row) => (
        <span className="num">
          {row.amount !== null
            ? formatINR(row.amount)
            : row.days !== null
              ? formatDays(row.days)
              : dash(null)}
        </span>
      ),
    },
    {
      key: "status",
      header: t("admin.wf.inbox.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={REQUEST_STATUS_CHIP} />,
    },
    {
      key: "current_level",
      header: t("admin.wf.inbox.col.level"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) =>
        t("admin.wf.inbox.levelOf", {
          current: formatNumber(row.current_level),
          total: formatNumber(row.total_levels),
        }),
    },
    {
      key: "priority",
      header: t("admin.wf.inbox.col.priority"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.priority} map={PRIORITY_CHIP} />,
    },
    {
      key: "submitted_at",
      header: t("admin.wf.inbox.col.submitted"),
      width: "12rem",
      sortable: true,
      hideBelow: "md",
      render: (row) => <span className="num">{fmtDateTime(row.submitted_at)}</span>,
    },
    {
      key: "sla_due_at",
      header: t("admin.wf.inbox.col.due"),
      width: "12rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num">{fmtDateTime(row.sla_due_at)}</span>
          {row.escalated_at !== null ? (
            <span className="text-xs text-destructive">
              {t("admin.wf.inbox.escalatedAt", { at: fmtDateTime(row.escalated_at) })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "current_approver_ids",
      header: t("admin.wf.inbox.col.waitingOn"),
      width: "12rem",
      render: (row) => <WaitingOn row={row} mine={canDecide(row)} />,
    },
  ];

  const anyFilter =
    requestTypeId !== "" || status !== undefined || priority !== undefined || slice !== "open";

  const breachSliceEmpty =
    slice === "breached" && breachIds.isSuccess && (breachIds.data ?? []).length === 0;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Inbox}
        title={t("admin.wf.inbox.title")}
        subtitle={
          total.isSuccess
            ? t("admin.wf.inbox.subtitle.count", { n: formatNumber(total.data) })
            : t("admin.wf.inbox.subtitle.plain")
        }
      />

      {/* Server counts. Each tile is the cardinality of the rows it opens. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TILES.map((tile) => {
          const q = counts[tile.slice];
          const active = slice === tile.slice;
          // The breach slice's predicate is the sweep's id set; until that read
          // lands its count would be a confident zero, so it stays a spinner.
          const pending = q.isPending || (tile.slice === "breached" && breachIds.isPending);
          return (
            <button
              key={tile.slice}
              type="button"
              onClick={() => setParam("slice", active ? "" : tile.slice)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tile.ring,
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {pending ? "…" : q.error !== null ? dash(null) : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{SLICE_HINT[slice]}</p>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.wf.inbox.filter.type")}
          value={requestTypeId}
          placeholder={t("admin.wf.inbox.filter.anyType")}
          options={(types.data ?? []).map((rt) => ({ value: rt.id, label: rt.name }))}
          onChange={(v) => setParam("type", v)}
        />
        <SelectField
          label={t("admin.wf.inbox.filter.status")}
          value={status ?? ""}
          placeholder={t("admin.wf.inbox.filter.anyStatus")}
          options={approvalStatusValues.map((s) => ({
            value: s,
            label: REQUEST_STATUS_CHIP[s]?.label ?? s,
          }))}
          onChange={(v) => setParam("status", v)}
          hint={t("admin.wf.inbox.filter.statusHint")}
        />
        <SelectField
          label={t("admin.wf.inbox.filter.priority")}
          value={priority ?? ""}
          placeholder={t("admin.wf.inbox.filter.anyPriority")}
          options={approvalPriorityValues.map((p) => ({
            value: p,
            label: PRIORITY_CHIP[p]?.label ?? p,
          }))}
          onChange={(v) => setParam("priority", v)}
        />
        <div className="flex items-end gap-2">
          {anyFilter ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.wf.inbox.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {outcome !== null ? (
        <div className="mt-4">
          <DecisionOutcome outcome={outcome} onDismiss={() => setOutcome(null)} />
        </div>
      ) : null}

      {myEmployeeId === null ? (
        <div className="mt-4">
          <Notice tone="info">{t("admin.wf.inbox.noEmployeeRecord")}</Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={rows.length === 0}
          partialError={people.error ?? total.error ?? breachIds.error}
          partialLabel={t("admin.wf.inbox.partial")}
          empty={
            breachSliceEmpty ? (
              <EmptyState
                icon={ShieldCheck}
                title={t("admin.wf.inbox.empty.noBreach.title")}
                hint={t("admin.wf.inbox.empty.noBreach.hint")}
              />
            ) : (
              <EmptyState
                icon={Inbox}
                title={
                  anyFilter
                    ? t("admin.wf.inbox.empty.filtered.title")
                    : t("admin.wf.inbox.empty.title")
                }
                hint={
                  anyFilter
                    ? t("admin.wf.inbox.empty.filtered.hint")
                    : t("admin.wf.inbox.empty.hint")
                }
                {...(anyFilter
                  ? {
                      action: (
                        <Button
                          variant="outline"
                          onClick={() => setParams(new URLSearchParams(), { replace: true })}
                        >
                          {t("admin.wf.inbox.filter.clear")}
                        </Button>
                      ),
                    }
                  : {})}
              />
            )
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => setOpenId(row.id === openId ? null : row.id)}
            /*
              The detail belongs UNDER THE ROW, not under the grid.

              Reported: "when i click then it's details should just that below not
              after list, because if there will more row then we have to scroll
              down too much". On a 25-row page the old placement put the panel a
              screen and a half below the row that opened it — so you clicked,
              scrolled to read, and then had to find your place again to click the
              next one.
            */
            renderRowDetail={(row) =>
              row.id === openId ? (
                <div className="border-t bg-background">
                  <RequestDetail
                    row={row}
                    typeName={typeMap.get(row.request_type_id)?.name ?? null}
                    canDecide={canDecide(row)}
                    isOverride={isOverride(row)}
                    onClose={() => setOpenId(null)}
                    onDecide={(decision) => {
                      decide.reset();
                      prompt.ask({ row, decision });
                    }}
                  />
                </div>
              ) : null
            }
          />

          {list.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage
                  ? t("admin.wf.inbox.loadingMore")
                  : t("admin.wf.inbox.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.wf.inbox.footnote")}</Notice>
      </div>

      <ReasonDialog
        open={prompt.isOpen}
        title={
          prompt.target?.decision === "reject"
            ? t("admin.wf.inbox.dialog.rejectTitle")
            : t("admin.wf.inbox.dialog.approveTitle")
        }
        description={
          prompt.target === null
            ? t("admin.wf.inbox.dialog.descriptionPlain")
            : t("admin.wf.inbox.dialog.description", {
                number: prompt.target.row.request_number,
                title: prompt.target.row.title,
              })
        }
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={
          prompt.target?.decision === "reject"
            ? t("admin.wf.inbox.action.reject")
            : t("admin.wf.inbox.action.approve")
        }
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={(reason) => {
          const target = prompt.target;
          if (target === null) return;
          decide.save(
            {
              approvalRequestId: target.row.id,
              requestNumber: target.row.request_number,
              decision: target.decision,
              detailTable: target.row.detail_table,
              detailId: target.row.detail_id,
              decidedByProfileId: myProfileId,
            },
            reason,
          );
        }}
        onCancel={() => {
          decide.reset();
          prompt.close();
        }}
      />
    </div>
  );
}

/**
 * Who the row is waiting on, in words.
 *
 * `current_approver_ids` is the materialised array `advance_approval` writes and
 * both `ar__approver_read` and `v_approval_inbox` test. The console prints
 * whether THIS admin is in it and how many people the level is waiting on — it
 * does not name them, because resolving every approver of every row would be a
 * read per row for a fact the decision panel already shows.
 */
function WaitingOn({ row, mine }: { row: ApprovalRequestRow; mine: boolean }) {
  if (mine) {
    return (
      <span className="text-sm font-medium text-primary">{t("admin.wf.inbox.waiting.you")}</span>
    );
  }
  const n = row.current_approver_ids.length;
  if (n === 0) {
    return (
      <span className="text-sm text-muted-foreground">{t("admin.wf.inbox.waiting.none")}</span>
    );
  }
  return (
    <span className="text-sm text-muted-foreground">
      {t("admin.wf.inbox.waiting.others", { n: formatNumber(n) })}
    </span>
  );
}

/** The three honest outcomes of a decision, never collapsed into one tick. */
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
      {t("admin.wf.inbox.dismiss")}
    </Button>
  );

  if (outcome.applyError !== null) {
    return (
      <Notice tone="warning" action={dismiss}>
        {t("admin.wf.inbox.outcome.applyFailed", { number, message: outcome.applyError })}
      </Notice>
    );
  }
  if (outcome.notAppliedReason === "chain_continues") {
    return (
      <Notice tone="info" action={dismiss}>
        {t("admin.wf.inbox.outcome.chainContinues", {
          number,
          level: formatNumber(outcome.approval.current_level),
        })}
      </Notice>
    );
  }
  if (outcome.notAppliedReason === "no_apply_path") {
    return (
      <Notice tone="warning" action={dismiss}>
        {t("admin.wf.inbox.outcome.noApplyPath", { number })}
      </Notice>
    );
  }
  return (
    <Notice tone="success" action={dismiss}>
      {outcome.approval.status === "rejected"
        ? t("admin.wf.inbox.outcome.rejected", { number })
        : t("admin.wf.inbox.outcome.approved", { number })}
    </Notice>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="num mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * The opened request: what was asked for, where the chain has reached, and every
 * action ever taken on it.
 *
 * `summary` is DECODED, never derived: `create_approval_request` is called with
 * `{request_number, from_date, to_date, total_days}` for leave and with other
 * keys for other types, so each field is independently optional and an absent one
 * renders an em dash rather than a guess. Actions with no actor are `sla_sweep`'s
 * own (escalation, auto-approval) and are attributed to the system in words.
 */
function RequestDetail({
  row,
  typeName,
  canDecide,
  isOverride,
  onClose,
  onDecide,
}: {
  row: ApprovalRequestRow;
  typeName: string | null;
  canDecide: boolean;
  /** Acting reaches past the named approver — the panel must say so. */
  isOverride: boolean;
  onClose: () => void;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const trail = useApprovalTrail(row.id);
  const facts = readSummaryFacts(row.summary);
  const actionCount = trail.data?.actions.length ?? 0;

  return (
    <section
      /*
        No `mt-4`, no border, no rounding: this now renders INSIDE the row it
        belongs to, and the grid already draws the separator above it. Keeping the
        standalone card styling here produced a card floating inside a table cell
        with a double border and a gap that broke the connection to its own row.
      */
      className="bg-background p-4"
      aria-label={t("admin.wf.inbox.detail.title")}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {t("admin.wf.inbox.detail.heading", {
              number: row.request_number,
              type: typeName ?? t("admin.wf.inbox.detail.unknownType"),
            })}
          </h2>
          <p className="text-sm text-muted-foreground">{row.title}</p>
        </div>
        <div className="flex items-center gap-2">
          {canDecide ? (
            <>
              <Button variant="outline" onClick={() => onDecide("reject")}>
                {t("admin.wf.inbox.action.reject")}
              </Button>
              <Button onClick={() => onDecide("approve")}>
                {t("admin.wf.inbox.action.approve")}
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("admin.wf.inbox.detail.close")}
          </Button>
        </div>
      </div>

      {!canDecide ? (
        <div className="mt-3">
          <Notice tone="info">{t("admin.wf.inbox.detail.readOnly")}</Notice>
        </div>
      ) : isOverride ? (
        <div className="mt-3">
          {/*
            Never silent. Reaching past a named approver is recorded by
            `act_on_approval` as `acted_as = 'admin_override'` and read back in
            the Override Log; the person doing it should know that before they
            click, not afterwards.
          */}
          <Notice tone="warning">{t("admin.wf.inbox.detail.override")}</Notice>
        </div>
      ) : null}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailFact
          label={t("admin.wf.inbox.detail.dates")}
          value={
            facts.fromDate === null
              ? dash(null)
              : facts.toDate === null || facts.toDate === facts.fromDate
                ? fmtCivilDate(facts.fromDate)
                : t("admin.wf.inbox.detail.dateRange", {
                    from: fmtCivilDate(facts.fromDate),
                    to: fmtCivilDate(facts.toDate),
                  })
          }
        />
        <DetailFact label={t("admin.wf.inbox.detail.days")} value={formatDays(row.days)} />
        <DetailFact
          label={t("admin.wf.inbox.detail.amount")}
          value={row.amount === null ? dash(null) : formatINR(row.amount, { paise: true })}
        />
        <DetailFact
          label={t("admin.wf.inbox.detail.submitted")}
          value={fmtDateTime(row.submitted_at)}
        />
        <DetailFact label={t("admin.wf.inbox.detail.slaDue")} value={fmtDateTime(row.sla_due_at)} />
        <DetailFact
          label={t("admin.wf.inbox.detail.firstAction")}
          value={dash(row.first_action_at, fmtDateTime)}
        />
        <DetailFact
          label={t("admin.wf.inbox.detail.decided")}
          value={dash(row.decided_at, fmtDateTime)}
        />
        <DetailFact
          label={t("admin.wf.inbox.detail.applied")}
          value={dash(row.applied_at, fmtDateTime)}
        />
      </dl>

      {row.apply_error !== null ? (
        <div className="mt-3">
          <Notice tone="error">
            {t("admin.wf.inbox.detail.applyError", { message: row.apply_error })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border bg-background p-3">
          <h3 className="text-sm font-medium">{t("admin.wf.inbox.detail.position")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("admin.wf.inbox.detail.positionValue", {
              current: formatNumber(row.current_level),
              total: formatNumber(row.total_levels),
              n: formatNumber(row.current_approver_ids.length),
            })}
          </p>
          {row.decision_comment !== null && row.decision_comment !== "" ? (
            <p className="mt-2 whitespace-pre-line text-sm">
              {t("admin.wf.inbox.detail.lastComment", { comment: row.decision_comment })}
            </p>
          ) : null}
        </div>

        <div className="rounded-md border bg-background p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            {t("admin.wf.inbox.detail.trail")}
          </h3>
          <StateBoundary
            loading={trail.isPending}
            error={trail.error}
            onRetry={() => void trail.refetch()}
            isEmpty={(trail.data?.actions.length ?? 0) === 0}
            skeletonRows={3}
            empty={
              <p className="mt-2 text-sm text-muted-foreground">
                {t("admin.wf.inbox.detail.trailEmpty")}
              </p>
            }
          >
            <ol className="mt-2 space-y-3">
              {(trail.data?.actions ?? []).map((action) => {
                const actor =
                  action.actor_id === null
                    ? null
                    : trail.data?.actors.get(action.actor_id) ?? null;
                const actedAs =
                  action.acted_as === null ? null : ACTED_AS_LABEL[action.acted_as] ?? null;
                return (
                  <li key={action.id} className="border-l-2 border-border pl-3">
                    <p className="text-sm font-medium">
                      {actionLabel(action.action)}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {t("admin.wf.inbox.detail.atLevel", {
                          level: formatNumber(action.level),
                        })}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {actor === null
                        ? t("admin.wf.inbox.detail.bySystem")
                        : t("admin.wf.inbox.detail.byActor", {
                            name: actor.display_name,
                            role: roleLabel(action.actor_role),
                          })}
                      {actedAs !== null
                        ? t("admin.wf.inbox.detail.actedAsSuffix", { as: actedAs })
                        : ""}
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
            {actionCount === 0 ? null : (
              <p className="mt-3 text-xs text-muted-foreground">
                {t("admin.wf.inbox.detail.trailAppendOnly")}
              </p>
            )}
          </StateBoundary>
        </div>
      </div>
    </section>
  );
}
