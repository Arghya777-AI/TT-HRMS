/**
 * /admin/leave/balances — `v_leave_balance_current` across the organisation.
 *
 * Every figure in this grid is a column of that view, printed as-is. Nothing is
 * summed, averaged or re-derived here, and that is the whole point: the view
 * exposes `available_days` and `available_after_pending` as GENERATED columns
 * over the append-only `leave_ledger`, so this screen, the employee's own leave
 * screen and the payroll engine are reading the same number (DR-29, spec-admin
 * §7.2 "Balance = running ledger sum").
 *
 * Grain is one row per employee × leave type — the grain of the view. The spec's
 * pivot (one row per employee, columns per type) is deliberately NOT built by
 * transposing rows in the browser: a pivot needs an `as_of` parameter the view
 * does not take, and a client-side transpose is exactly the kind of local
 * arithmetic that lets two screens disagree.
 *
 * Row click drills into `/admin/leave/ledger/:code`, which is the ledger behind
 * the balance.
 *
 * @route /admin/leave/balances
 */
import { useMemo } from "react";
import { CalendarDays, Scale } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { LeaveBalance } from "../api/leave.api";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  LEAVE_ROW_CAP,
  useAdminLeaveBalances,
  useAdminLeaveTypes,
} from "../hooks/useAdminLeave";

export default function AdminLeaveBalancesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const employeeId = params.get("emp");
  const leaveTypeId = params.get("type");

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const types = useAdminLeaveTypes();
  const balances = useAdminLeaveBalances({ employeeId, leaveTypeId });

  const typeChoices: SelectOption[] = useMemo(
    () =>
      (types.data ?? []).map((type) => ({
        value: type.id,
        label: type.name,
      })),
    [types.data],
  );

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const rows = balances.data ?? [];
  const capped = rows.length >= LEAVE_ROW_CAP;

  const columns: DataGridColumn<LeaveBalance>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.leaveBal.col.employee"),
        width: "14rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
        },
      },
      {
        key: "leave_type_name",
        header: t("admin.leaveBal.col.type"),
        width: "12rem",
        sortable: true,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{row.leave_type_name}</span>
            <span className="text-xs text-muted-foreground">
              {row.is_paid ? t("admin.leaveBal.paid") : t("admin.leaveBal.unpaid")}
            </span>
          </span>
        ),
      },
      {
        key: "leave_year",
        header: t("admin.leaveBal.col.year"),
        width: "6rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{row.leave_year}</span>,
      },
      {
        key: "opening_days",
        header: t("admin.leaveBal.col.opening"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => formatDays(row.opening_days),
      },
      {
        key: "accrued_days",
        header: t("admin.leaveBal.col.accrued"),
        width: "7rem",
        align: "right",
        hideBelow: "md",
        render: (row) => formatDays(row.accrued_days),
      },
      {
        key: "carried_forward_days",
        header: t("admin.leaveBal.col.carried"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => formatDays(row.carried_forward_days),
      },
      {
        key: "adjusted_days",
        header: t("admin.leaveBal.col.adjusted"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => formatDays(row.adjusted_days),
      },
      {
        key: "entitlement_days",
        header: t("admin.leaveBal.col.entitlement"),
        width: "8rem",
        align: "right",
        hideBelow: "md",
        render: (row) => formatDays(row.entitlement_days),
      },
      {
        key: "availed_days",
        header: t("admin.leaveBal.col.availed"),
        width: "7rem",
        align: "right",
        hideBelow: "md",
        render: (row) => formatDays(row.availed_days),
      },
      {
        key: "pending_days",
        header: t("admin.leaveBal.col.pending"),
        width: "7rem",
        align: "right",
        hideBelow: "md",
        render: (row) => formatDays(row.pending_days),
      },
      {
        key: "lapsed_days",
        header: t("admin.leaveBal.col.lapsed"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => formatDays(row.lapsed_days),
      },
      {
        key: "available_days",
        header: t("admin.leaveBal.col.available"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => (
          <span className="num font-semibold">{formatDays(row.available_days)}</span>
        ),
      },
      {
        key: "available_after_pending",
        header: t("admin.leaveBal.col.spendable"),
        width: "9rem",
        align: "right",
        render: (row) => formatDays(row.available_after_pending),
      },
      {
        key: "ledger",
        header: t("admin.leaveBal.col.ledger"),
        width: "8rem",
        align: "right",
        render: (row) => {
          const code = labels.data?.get(row.employee_id)?.code;
          if (code === undefined) return dash(null);
          // The cell swallows the click so the row's own navigation cannot race
          // the link the reader actually pressed.
          return (
            <span onClick={(event) => event.stopPropagation()}>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/admin/leave/ledger/${code}?type=${row.leave_type_code}`}>
                  {t("admin.leaveBal.openLedger")}
                </Link>
              </Button>
            </span>
          );
        },
      },
      {
        key: "adjust",
        header: t("admin.leaveBal.col.adjust"),
        width: "7rem",
        align: "right",
        render: (row) => (
          /*
            Prefilled with the employee and the leave type, because those are the
            two fields most easily got wrong by hand — and adjusting the wrong
            person's balance is not a mistake the screen can detect afterwards.
          */
          <span onClick={(event) => event.stopPropagation()}>
            <Button variant="outline" size="sm" asChild>
              <Link
                to={`/admin/leave/adjustments?emp=${row.employee_id}&type=${row.leave_type_id}`}
              >
                {t("admin.leaveBal.adjust")}
              </Link>
            </Button>
          </span>
        ),
      },
      {
        key: "nearest_expiry",
        header: t("admin.leaveBal.col.expiry"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => {
          if (row.nearest_expiry === null) return dash(null);
          return (
            <span className="flex flex-col leading-tight">
              <span>{fmtCivilDate(row.nearest_expiry)}</span>
              <span className="num text-xs text-warning">
                {t("admin.leaveBal.expiringSoon", {
                  days: formatDays(row.expiring_soon_days),
                })}
              </span>
            </span>
          );
        },
      },
    ],
    [labels.data],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Scale}
        title={t("admin.leaveBal.title")}
        subtitle={t("admin.leaveBal.subtitle")}
        actions={
          /*
            THE WAY IN. `adjust_leave_balance` and `/admin/leave/adjustments` have
            both existed since migration 039300, and neither was reachable from the
            screen where somebody LOOKS at a balance — so the answer to "how do I
            add leave" was "know the URL". One button, on the page where the
            question is asked.
          */
          <Button asChild size="sm">
            <Link to="/admin/leave/adjustments">{t("admin.leaveBal.adjustBalance")}</Link>
          </Button>
        }
      />

      <Notice tone="info" className="mb-4">
        {t("admin.leaveBal.provenance")}
      </Notice>

      {capped ? (
        <Notice tone="warning" className="mb-4">
          {t("admin.common.rowCap", { count: LEAVE_ROW_CAP })}
        </Notice>
      ) : null}

      <StateBoundary
        loading={balances.isLoading}
        error={balances.error ?? undefined}
        onRetry={() => void balances.refetch()}
        partialError={types.error ?? labels.error ?? undefined}
        partialLabel={t("admin.leaveBal.partial")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.employee_id}:${row.leave_type_id}:${row.leave_year}`}
          pageSize={25}
          onRowClick={(row) => {
            const code = labels.data?.get(row.employee_id)?.code;
            if (code === undefined) return;
            navigate(`/admin/leave/ledger/${code}?type=${row.leave_type_code}`);
          }}
          toolbar={
            <div className="grid w-full gap-3 sm:grid-cols-2">
              <SelectField
                label={t("admin.common.filter.employee")}
                value={employeeId ?? ""}
                options={employeeChoices}
                placeholder={t("admin.common.filter.allEmployees")}
                onChange={(value) => setParam("emp", value)}
                disabled={labels.isLoading}
              />
              <SelectField
                label={t("admin.leaveBal.filter.type")}
                value={leaveTypeId ?? ""}
                options={typeChoices}
                placeholder={t("admin.leaveBal.filter.allTypes")}
                onChange={(value) => setParam("type", value)}
                disabled={types.isLoading}
              />
            </div>
          }
          emptyState={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.leaveBal.empty.title")}
              hint={
                employeeId !== null || leaveTypeId !== null
                  ? t("admin.leaveBal.empty.filtered")
                  : t("admin.leaveBal.empty.hint")
              }
            />
          }
        />
      </StateBoundary>
    </div>
  );
}
