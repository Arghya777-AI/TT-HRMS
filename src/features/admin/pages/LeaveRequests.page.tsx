/**
 * /admin/leave/requests — every leave request in the organisation, with the
 * admin's approve / reject decision on behalf of the approver (spec-admin §7.3,
 * `override_of_level_N`).
 *
 * What this screen refuses to do:
 *  - It never invents an audit reason. Approving or rejecting somebody else's
 *    request is an override, so `<ReasonDialog>` asks for ≥15 characters
 *    (D-21) and the sentence travels in `X-Reason` on that one request.
 *  - It never touches days or balances. The DB triggers
 *    `leave_requests_apply_ledger` and `leave_requests_recompute_balance` write
 *    the ledger inside the same transaction; this screen records the intent and
 *    then re-reads the server (no optimistic patch, so the grid and the balance
 *    screen cannot disagree — DR-29).
 *  - It never renders a raw status. `pending`/`partially_approved`/… go through
 *    LEAVE_REQUEST_CHIP (DR-53), and the filter values in the URL are the only
 *    place the enum appears at all.
 *
 * Filter state lives in the URL (D-25), so a filtered queue is a link.
 *
 * @route /admin/leave/requests
 */
import { useMemo, useState } from "react";
import { CalendarDays, Inbox } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { CancelLeaveDaysDialog } from "../components/CancelLeaveDaysDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { LeaveRequest, LeaveRequestStatus } from "../api/leave.api";
import { LEAVE_REQUEST_CHIP, PORTION_LABEL, isDecidable } from "../display";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  LEAVE_ROW_CAP,
  useAdminLeaveRequests,
  useAdminLeaveTypes,
  useDecideLeaveRequest,
  useLeaveTypeMap,
  type DecisionInput,
} from "../hooks/useAdminLeave";
import { useReasonPrompt } from "../hooks/useReasonPrompt";

/** The status presets the queue is actually worked from. */
const STATUS_PRESETS: Readonly<Record<string, readonly LeaveRequestStatus[] | null>> = {
  all: null,
  awaiting: ["pending", "partially_approved"],
  approved: ["approved"],
  rejected: ["rejected"],
  cancelled: ["cancelled", "withdrawn", "cancellation_pending"],
  draft: ["draft"],
};

function statusOptions(): SelectOption[] {
  return [
    { value: "all", label: t("admin.leaveReq.filter.all") },
    { value: "awaiting", label: t("admin.leaveReq.filter.awaiting") },
    { value: "approved", label: t("admin.leaveReq.filter.approved") },
    { value: "rejected", label: t("admin.leaveReq.filter.rejected") },
    { value: "cancelled", label: t("admin.leaveReq.filter.cancelled") },
    { value: "draft", label: t("admin.leaveReq.filter.draft") },
  ];
}

export default function AdminLeaveRequestsPage() {
  const [params, setParams] = useSearchParams();
  const { user, employee } = useAuth();
  const profileId = user?.id ?? null;
  const actorName = employee?.displayName ?? null;

  const statusKey = params.get("status") ?? "all";
  const preset = STATUS_PRESETS[statusKey] ?? null;
  const employeeId = params.get("emp");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const types = useAdminLeaveTypes();
  const typeMap = useLeaveTypeMap(types.data);

  const requests = useAdminLeaveRequests({
    ...(preset ? { statuses: preset } : {}),
    employeeId,
    from,
    to,
  });

  /*
    One prompt for three verbs. `decision` carries which: approve and reject go to
    `useDecideLeaveRequest`, and "cancel" — only offered on an already-approved row — goes to
    `useCancelLeaveRequest`, which calls the guarded database function.
  */
  const prompt = useReasonPrompt<DecisionInput>();
  const { ask, close: closePrompt, target, isOpen } = prompt;
  const [done, setDone] = useState<string | null>(null);
  /*
    The day picker, not a straight cancel. A three-day booking is rarely wrong in all three,
    and cancelling the whole thing so the employee can re-apply loses the approval trail and
    the notice period. Same dialog the leave calendar opens, so the two screens cannot drift.
  */
  const [cancelTarget, setCancelTarget] = useState<
    { requestId: string; requestNumber: string; name: string | null } | null
  >(null);

  const decide = useDecideLeaveRequest(profileId, (input) => {
    closePrompt();
    setDone(
      input.decision === "approved"
        ? t("admin.leaveReq.done.approved", { number: input.requestNumber })
        : t("admin.leaveReq.done.rejected", { number: input.requestNumber }),
    );
  });

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const rows = requests.data ?? [];
  const capped = rows.length >= LEAVE_ROW_CAP;

  const columns: DataGridColumn<LeaveRequest>[] = useMemo(
    () => [
      {
        key: "request_number",
        header: t("admin.leaveReq.col.request"),
        width: "10rem",
        sortable: true,
        render: (row) => <span className="num">{row.request_number}</span>,
      },
      {
        key: "employee",
        header: t("admin.leaveReq.col.employee"),
        width: "14rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
        },
      },
      {
        key: "type",
        header: t("admin.leaveReq.col.type"),
        width: "11rem",
        render: (row) => dash(typeMap.get(row.leave_type_id)?.name ?? null),
      },
      {
        key: "dates",
        header: t("admin.leaveReq.col.dates"),
        width: "15rem",
        sortable: true,
        sortValue: (row) => row.from_date,
        render: (row) =>
          row.from_date === row.to_date
            ? fmtCivilDate(row.from_date)
            : t("admin.common.dateRange", {
                from: fmtCivilDate(row.from_date),
                to: fmtCivilDate(row.to_date),
              }),
      },
      {
        key: "days",
        header: t("admin.leaveReq.col.days"),
        width: "9rem",
        align: "right",
        render: (row) =>
          row.portion === "full_day"
            ? formatDays(row.total_days)
            : t("admin.leaveReq.daysWithPortion", {
                days: formatDays(row.total_days),
                portion: PORTION_LABEL[row.portion] ?? row.portion,
              }),
      },
      {
        key: "paid",
        header: t("admin.leaveReq.col.paid"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => formatDays(row.paid_days),
      },
      {
        key: "unpaid",
        header: t("admin.leaveReq.col.unpaid"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => formatDays(row.unpaid_days),
      },
      {
        key: "status",
        header: t("admin.leaveReq.col.status"),
        width: "11rem",
        render: (row) => <StatusChip status={row.status} map={LEAVE_REQUEST_CHIP} />,
      },
      {
        key: "decided",
        header: t("admin.leaveReq.col.decided"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.decided_at, fmtDateTime),
      },
      {
        key: "actions",
        header: t("admin.leaveReq.col.actions"),
        width: "13rem",
        align: "right",
        render: (row) => {
          /*
            An approved request is not decidable any more, but it IS cancellable — that is the
            whole point of this action. Taking back an approved absence releases the day to the
            balance and re-derives the attendance record, so it asks for a reason like every
            other consequential change here.
          */
          if (row.status === "approved" || row.status === "partially_approved") {
            if (profileId === null) {
              return (
                <span className="text-xs text-muted-foreground">
                  {t("admin.leaveReq.noSession")}
                </span>
              );
            }
            return (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setCancelTarget({
                    requestId: row.id,
                    requestNumber: row.request_number,
                    name: labels.data?.get(row.employee_id)?.name ?? null,
                  })
                }
              >
                {t("admin.leaveReq.action.cancel")}
              </Button>
            );
          }
          if (!isDecidable(row.status)) return dash(null);
          if (profileId === null) {
            return (
              <span className="text-xs text-muted-foreground">
                {t("admin.leaveReq.noSession")}
              </span>
            );
          }
          return (
            <span className="inline-flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() =>
                  ask({
                    requestId: row.id,
                    requestNumber: row.request_number,
                    decision: "approved",
                  })
                }
              >
                {t("admin.leaveReq.action.approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() =>
                  ask({
                    requestId: row.id,
                    requestNumber: row.request_number,
                    decision: "rejected",
                  })
                }
              >
                {t("admin.leaveReq.action.reject")}
              </Button>
            </span>
          );
        },
      },
    ],
    [labels.data, typeMap, profileId, decide.isPending, ask],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("admin.leaveReq.title")}
        subtitle={t("admin.leaveReq.subtitle")}
      />

      {done !== null ? (
        <Notice
          tone="success"
          className="mb-4"
          action={
            <Button variant="ghost" size="sm" onClick={() => setDone(null)}>
              {t("admin.common.dismiss")}
            </Button>
          }
        >
          {done}
        </Notice>
      ) : null}

      {capped ? (
        <Notice tone="warning" className="mb-4">
          {t("admin.common.rowCap", { count: LEAVE_ROW_CAP })}
        </Notice>
      ) : null}

      <StateBoundary
        loading={requests.isLoading}
        error={requests.error ?? undefined}
        onRetry={() => void requests.refetch()}
        partialError={types.error ?? labels.error ?? undefined}
        partialLabel={t("admin.leaveReq.partial")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          toolbar={
            <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SelectField
                label={t("admin.leaveReq.filter.status")}
                value={statusKey}
                options={statusOptions()}
                onChange={(value) => setParam("status", value === "all" ? "" : value)}
              />
              <SelectField
                label={t("admin.common.filter.employee")}
                value={employeeId ?? ""}
                options={employeeChoices}
                placeholder={t("admin.common.filter.allEmployees")}
                onChange={(value) => setParam("emp", value)}
                disabled={labels.isLoading}
              />
              <TextField
                label={t("admin.common.filter.from")}
                type="date"
                value={from}
                onChange={(value) => setParam("from", value)}
              />
              <TextField
                label={t("admin.common.filter.to")}
                type="date"
                value={to}
                onChange={(value) => setParam("to", value)}
              />
            </div>
          }
          emptyState={
            <EmptyState
              icon={Inbox}
              title={t("admin.leaveReq.empty.title")}
              hint={
                statusKey !== "all" || employeeId !== null || from !== "" || to !== ""
                  ? t("admin.leaveReq.empty.filtered")
                  : t("admin.leaveReq.empty.hint")
              }
            />
          }
        />
      </StateBoundary>

      <ReasonDialog
        open={isOpen}
        title={
          target?.decision === "rejected"
              ? t("admin.leaveReq.dialog.rejectTitle", { number: target.requestNumber })
            : t("admin.leaveReq.dialog.approveTitle", {
                number: target?.requestNumber ?? "",
              })
        }
        description={t("admin.leaveReq.dialog.description")}
        actorName={actorName}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={
          target?.decision === "rejected"
            ? t("admin.leaveReq.action.reject")
            : t("admin.leaveReq.action.approve")
        }
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={(reason) => {
          if (target !== null) decide.save(target, reason);
        }}
        onCancel={() => {
          decide.reset();
          closePrompt();
        }}
      />

      <CancelLeaveDaysDialog
        open={cancelTarget !== null}
        onOpenChange={(next) => { if (!next) setCancelTarget(null); }}
        requestId={cancelTarget?.requestId ?? null}
        requestNumber={cancelTarget?.requestNumber ?? ""}
        employeeName={cancelTarget?.name ?? null}
        onDone={(message) => { setCancelTarget(null); setDone(message); }}
      />
    </div>
  );
}
