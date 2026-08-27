/**
 * E-05 Leave `/me/leave` — balances per eligible type, plus every request.
 *
 * Both halves read server rows only: `v_leave_balance_current` for the cards
 * (its `available_after_pending` IS the headline formula) and `leave_requests`
 * for the list. Nothing on this page is added up in the browser, which is why the
 * card, the apply form's impact line and the request detail cannot disagree.
 *
 * @route /me/leave
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, CalendarPlus, CalendarRange, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Cursor } from "@/shared/api/query";
import { useLeaveBalances, useLeaveRequests ,
  useLeaveApprovers,
} from "../hooks/useLeave";
import { useLeaveTypeRules, useMyLeaveContext, useWithdrawLeave } from "../hooks/useLeaveApply";
import { isProbationLocked, type LeaveTypeRule } from "../api/leave-apply.api";
import type { LeaveRequest, LeaveRequestStatus } from "../api/leave.api";
import { LeaveBalanceCard } from "../components/LeaveBalanceCard";
import { splitBalances } from "./myLeaveBalances";
import { LeaveBalanceRings } from "../components/LeaveBalanceRings";
import { fmtDays, LEAVE_STATUS_MAP } from "../components/leave-vocab";
import { toast } from "sonner";

/** Everything except the working draft the apply form keeps. */
const LISTED_STATUSES: readonly LeaveRequestStatus[] = [
  "pending",
  "approved",
  "partially_approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "cancellation_pending",
];

export default function MyLeavePage() {
  const balances = useLeaveBalances();
  const rules = useLeaveTypeRules();
  const context = useMyLeaveContext();

  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [history, setHistory] = useState<(Cursor | null)[]>([]);
  const requests = useLeaveRequests({ statuses: LISTED_STATUSES, pageSize: 20, cursor });

  /* Only the requests on THIS page, so the lookup follows the pagination and
     never asks about a row nobody is looking at. */
  const approvalIds = useMemo(
    () =>
      (requests.data?.rows ?? [])
        .map((r) => r.approval_request_id)
        .filter((id): id is string => id !== null),
    [requests.data],
  );
  const approvers = useLeaveApprovers(approvalIds);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const withdraw = useWithdrawLeave();

  const ruleByTypeId = useMemo(() => {
    const map = new Map<string, LeaveTypeRule>();
    for (const rule of rules.data ?? []) map.set(rule.id, rule);
    return map;
  }, [rules.data]);

  /**
   * Hour-unit types (PERM short permission) are a chip strip, not a card — a
   * "2 of 2 remaining" permission is not a day balance (spec E-05).
   *
   * ── DRIVEN BY THE OFFERED TYPES, NOT BY THE BALANCE ROWS ──────────────────
   *
   * This iterated `balances.data`, so a type only appeared once the employee had a
   * `leave_balances` row for it — and a row is only written when something credits
   * or debits days. Across the venue that meant Maternity, Paternity and Week-off
   * had rows for two employees and nobody else, so this screen showed two cards
   * while /me/leave/apply showed five: the apply form reads the TYPES and joins
   * balances, this one read the balances and inferred the types. Two screens, two
   * answers to "what leave do I have".
   *
   * Now `rules.data` leads — the active types, which is what the venue has decided
   * to offer — and a type with no balance row renders as a real zero. "Maternity
   * Leave: 0 available" is a fact; the card's absence was read as the entitlement
   * not existing.
   */
  /*
    The leave year as the SERVER computed it, borrowed from any real balance row.
    Every employee holds sick and earned rows, so this is present in practice; the
    fallback of 0 only shows on a person with no ledger history at all, where every
    card is zero anyway and the year is a label nothing reads.
  */
  const leaveYear = balances.data?.[0]?.leave_year ?? 0;

  const { cardBalances, chipBalances } = useMemo(
    () => splitBalances(rules.data ?? [], balances.data ?? [], leaveYear),
    [balances.data, rules.data, leaveYear],
  );

  const lastRecomputed = balances.data?.find((b) => b.last_recomputed_at !== null)?.last_recomputed_at ?? null;

  function onWithdraw(request: LeaveRequest) {
    withdraw.mutate(
      { requestId: request.id, reason: t("leave.withdraw.reason") },
      {
        onSuccess: () => {
          setConfirmingId(null);
          toast.success(t("leave.withdraw.done"));
        },
        onError: (error) => {
          setConfirmingId(null);
          toast.error(t("leave.withdraw.failed"), { description: error.message });
        },
      },
    );
  }

  const columns: DataGridColumn<LeaveRequest>[] = [
    {
      key: "request_number",
      header: t("leave.col.ref"),
      render: (row) => <span className="font-mono text-xs">{row.request_number}</span>,
    },
    {
      key: "leave_type",
      header: t("leave.col.type"),
      render: (row) => dash(row.leave_type?.name ?? null),
    },
    {
      key: "from_date",
      header: t("leave.col.dates"),
      render: (row) =>
        row.from_date === row.to_date
          ? fmtCivilDate(row.from_date)
          : t("leave.dateRange", { from: fmtCivilDate(row.from_date), to: fmtCivilDate(row.to_date) }),
    },
    {
      key: "total_days",
      header: t("leave.col.days"),
      align: "right",
      width: "5rem",
      render: (row) => fmtDays(row.total_days),
    },
    {
      key: "status",
      header: t("leave.col.status"),
      render: (row) => <StatusChip status={row.status} map={LEAVE_STATUS_MAP} />,
    },
    {
      /*
        WHO IS HOLDING IT. The status chip says "With your approver", which is a
        state and not a person — "I already told u that for each request show who
        is handling that request but here we can't see".

        `leave_requests.current_approver_id` looks like the answer and is not: it
        is written only by the demo seed, so on live data it is NULL on every row.
        The live answer is `approval_requests.current_approver_ids`, which the
        raise trigger fills, resolved to names through the directory allowlist.
      */
      key: "with",
      header: t("leave.col.with"),
      width: "12rem",
      hideBelow: "md",
      render: (row) => {
        if (row.approval_request_id === null) {
          /* Settled requests have nobody holding them, which is not a gap. One
             still open with no workflow row is — and it should look like one. */
          return row.decided_at !== null ? (
            dash(null)
          ) : (
            <Badge variant="warning">{t("leave.with.nobody")}</Badge>
          );
        }
        const people = approvers.data?.get(row.approval_request_id) ?? [];
        if (people.length === 0) {
          return row.decided_at !== null ? (
            dash(null)
          ) : (
            <Badge variant="warning">{t("leave.with.nobody")}</Badge>
          );
        }
        return <span>{people.map((person) => person.display_name).join(", ")}</span>;
      },
    },
    {
      key: "created_at",
      header: t("leave.col.submitted"),
      hideBelow: "lg",
      render: (row) => fmtDateTime(row.created_at),
    },
    {
      key: "decided_at",
      header: t("leave.col.decided"),
      hideBelow: "lg",
      render: (row) => (row.decided_at === null ? dash(null) : fmtDateTime(row.decided_at)),
    },
    {
      key: "action",
      header: t("leave.col.action"),
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button asChild size="sm" variant="ghost">
            <Link to={`/me/leave/${row.id}`}>{t("leave.action.view")}</Link>
          </Button>
          {row.status === "pending" ? (
            confirmingId === row.id ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={withdraw.isPending}
                onClick={() => onWithdraw(row)}
              >
                {t("leave.action.withdraw")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmingId(row.id)}>
                {t("leave.action.withdraw")}
              </Button>
            )
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={CalendarDays}
        title={t("leave.title")}
        subtitle={t("leave.subtitle")}
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link to="/me/leave/calendar">
                <CalendarRange className="h-4 w-4" aria-hidden />
                {t("leave.nav.calendar")}
              </Link>
            </Button>
            {/*
              NO COMP-OFF BUTTON. The venue asked for comp-off to be hidden
              everywhere, and `HIDDEN_FROM_NAV` took `/me/comp-off` out of the
              rails — but an in-page button is not a rail, so this one survived the
              change and kept the screen reachable. The route is still SERVED; only
              the entrances are gone.
            */}
            <Button asChild size="sm">
              <Link to="/me/leave/apply">
                <CalendarPlus className="h-4 w-4" aria-hidden />
                {t("leave.nav.apply")}
              </Link>
            </Button>
          </>
        }
      />

      <section aria-labelledby="leave-balances-heading" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="leave-balances-heading" className="font-display text-lg font-semibold">
            {t("leave.balances.title")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {lastRecomputed === null
              ? t("leave.balances.eligibleOnly")
              : t("leave.balances.asAt", { when: fmtDateTime(lastRecomputed) })}
          </p>
        </div>

        <StateBoundary
          loading={balances.isLoading}
          error={balances.error}
          onRetry={() => void balances.refetch()}
          isEmpty={(balances.data?.length ?? 0) === 0}
          empty={
            <EmptyState
              title={t("leave.balances.empty.title")}
              hint={t("leave.balances.empty.hint")}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/me/leave/apply">{t("leave.nav.apply")}</Link>
                </Button>
              }
            />
          }
          partialError={rules.error ?? context.error}
          partialLabel={t("leave.apply.rules.title")}
          skeletonRows={2}
        >
          {/* The ratio the cards cannot show: taken against granted, per type.
              Same rows, same columns, above the cards rather than in place of
              them — "7 left" reads differently on a 30-day entitlement. */}
          <LeaveBalanceRings balances={cardBalances} />

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cardBalances.map((balance) => {
              const rule = ruleByTypeId.get(balance.leave_type_id);
              const locked = rule ? isProbationLocked(rule, context.data ?? null) : false;
              return (
                <LeaveBalanceCard
                  key={balance.leave_type_id}
                  balance={balance}
                  probationLocked={locked}
                  confirmationDue={context.data?.confirmation_due_date ?? null}
                />
              );
            })}
          </div>

          {chipBalances.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {chipBalances.map((balance) => (
                <li key={balance.leave_type_id}>
                  <Badge variant="neutral" className="gap-1.5">
                    <span>{balance.leave_type_name}</span>
                    <span className="num font-semibold">
                      {fmtDays(balance.available_after_pending)}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </StateBoundary>
      </section>

      <section aria-labelledby="leave-requests-heading">
        <h2 id="leave-requests-heading" className="mb-3 font-display text-lg font-semibold">
          {t("leave.requests.title")}
        </h2>

        <StateBoundary
          loading={requests.isLoading}
          error={requests.error}
          onRetry={() => void requests.refetch()}
          isEmpty={(requests.data?.rows.length ?? 0) === 0 && history.length === 0}
          empty={
            <EmptyState
              icon={Inbox}
              title={t("leave.requests.empty.title")}
              hint={t("leave.requests.empty.hint")}
              action={
                <Button asChild size="sm">
                  <Link to="/me/leave/apply">{t("leave.nav.apply")}</Link>
                </Button>
              }
            />
          }
        >
          <DataGrid<LeaveRequest>
            columns={columns}
            rows={requests.data?.rows ?? []}
            rowKey={(row) => row.id}
            pageSize={20}
          />

          {requests.data?.hasMore === true || history.length > 0 ? (
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={history.length === 0}
                onClick={() =>
                  setHistory((prev) => {
                    const next = [...prev];
                    const previous = next.pop() ?? null;
                    setCursor(previous);
                    return next;
                  })
                }
              >
                {t("leave.requests.prev")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={requests.data?.nextCursor == null}
                onClick={() => {
                  const next = requests.data?.nextCursor ?? null;
                  if (next === null) return;
                  setHistory((prev) => [...prev, cursor]);
                  setCursor(next);
                }}
              >
                {t("leave.requests.more")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </section>
    </div>
  );
}
