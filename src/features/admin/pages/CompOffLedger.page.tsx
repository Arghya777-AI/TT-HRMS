/**
 * /admin/leave/comp-off — the comp-off ledger, and what expires when.
 *
 * Two server relations, two sections, no client arithmetic between them:
 *   1. `v_comp_off_balance` — per employee: `available_days`, `nearest_expiry`,
 *      `expiring_within_30_days`, `open_credits`. The "expiring soon" figure is
 *      a SERVER column, not a date window computed in the browser.
 *   2. `comp_off_ledger` — the credits themselves: how each one was earned, when
 *      it expires, how much of it is left (`days_remaining`), and its state.
 *
 * The ledger is read-only from any client: 019 grants INSERT/UPDATE on
 * `comp_off_ledger` to `service_role` only, and expiry is a nightly job. The
 * screen says so rather than showing an edit affordance that would 42501.
 *
 * Expiry rendering follows D-09: a credit with no `expires_on` is "No expiry",
 * never a year-3000 sentinel (DR-19).
 *
 * @route /admin/leave/comp-off
 */
import { useMemo } from "react";
import { HeartHandshake, Hourglass } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime, fmtDurationHm } from "@/lib/datetime";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { CompOffBalance, CompOffLedgerRow } from "../api/leave.api";
import { COMP_OFF_CHIP, COMP_OFF_ENTRY_CHIP } from "../display";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { LEAVE_ROW_CAP, useCompOffBalances, useCompOffLedger } from "../hooks/useAdminLeave";

/** `comp_off_ledger.status` values the ledger filter offers. */
function statusChoices(): SelectOption[] {
  return [
    { value: "available", label: t("admin.compOff.status.available") },
    { value: "partially_used", label: t("admin.compOff.status.partially_used") },
    { value: "availed", label: t("admin.compOff.status.availed") },
    { value: "encashed", label: t("admin.compOff.status.encashed") },
    { value: "expired", label: t("admin.compOff.status.expired") },
    { value: "cancelled", label: t("admin.compOff.status.cancelled") },
  ];
}

export default function AdminCompOffLedgerPage() {
  const [params, setParams] = useSearchParams();
  const employeeId = params.get("emp");
  const status = params.get("status");

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const balances = useCompOffBalances();
  const ledger = useCompOffLedger({ employeeId, status });

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const balanceRows = useMemo(() => {
    const rows = balances.data ?? [];
    if (employeeId === null) return rows;
    return rows.filter((row) => row.employee_id === employeeId);
  }, [balances.data, employeeId]);

  const ledgerRows = ledger.data ?? [];
  const capped = ledgerRows.length >= LEAVE_ROW_CAP;

  const balanceColumns: DataGridColumn<CompOffBalance>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.compOff.col.employee"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
        },
      },
      {
        key: "available_days",
        header: t("admin.compOff.col.available"),
        width: "9rem",
        align: "right",
        sortable: true,
        render: (row) => (
          <span className="num font-semibold">{formatDays(row.available_days)}</span>
        ),
      },
      {
        key: "expiring_within_30_days",
        header: t("admin.compOff.col.expiring30"),
        width: "11rem",
        align: "right",
        sortable: true,
        render: (row) =>
          row.expiring_within_30_days > 0 ? (
            <span className="num text-warning">{formatDays(row.expiring_within_30_days)}</span>
          ) : (
            formatDays(row.expiring_within_30_days)
          ),
      },
      {
        key: "nearest_expiry",
        header: t("admin.compOff.col.nearestExpiry"),
        width: "11rem",
        render: (row) =>
          row.nearest_expiry === null
            ? t("admin.common.noExpiry")
            : fmtCivilDate(row.nearest_expiry),
      },
      {
        key: "open_credits",
        header: t("admin.compOff.col.openCredits"),
        width: "9rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <span className="num">{row.open_credits}</span>,
      },
    ],
    [labels.data],
  );

  const ledgerColumns: DataGridColumn<CompOffLedgerRow>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.compOff.col.employee"),
        width: "14rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
        },
      },
      {
        key: "entry_type",
        header: t("admin.compOff.col.entry"),
        width: "10rem",
        render: (row) => <StatusChip status={row.entry_type} map={COMP_OFF_ENTRY_CHIP} />,
      },
      {
        key: "days",
        header: t("admin.compOff.col.days"),
        width: "7rem",
        align: "right",
        render: (row) => formatDays(row.days),
      },
      {
        key: "days_remaining",
        header: t("admin.compOff.col.remaining"),
        width: "8rem",
        align: "right",
        render: (row) => dash(row.days_remaining, formatDays),
      },
      {
        key: "earned_on_date",
        header: t("admin.compOff.col.earnedOn"),
        width: "11rem",
        sortable: true,
        sortValue: (row) => row.earned_on_date ?? "",
        render: (row) => dash(row.earned_on_date, fmtCivilDate),
      },
      {
        key: "source",
        header: t("admin.compOff.col.source"),
        width: "14rem",
        hideBelow: "md",
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{dash(row.event_reference ?? row.earn_source)}</span>
            {row.earned_minutes !== null ? (
              <span className="num text-xs text-muted-foreground">
                {t("admin.compOff.earnedMinutes", {
                  duration: fmtDurationHm(row.earned_minutes),
                })}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "expires_on",
        header: t("admin.compOff.col.expiresOn"),
        width: "11rem",
        sortable: true,
        sortValue: (row) => row.expires_on ?? "",
        render: (row) =>
          row.expires_on === null ? t("admin.common.noExpiry") : fmtCivilDate(row.expires_on),
      },
      {
        key: "status",
        header: t("admin.compOff.col.status"),
        width: "11rem",
        render: (row) => <StatusChip status={row.status} map={COMP_OFF_CHIP} />,
      },
      {
        key: "availed_on_date",
        header: t("admin.compOff.col.availedOn"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => dash(row.availed_on_date, fmtCivilDate),
      },
      {
        key: "recorded_at",
        header: t("admin.compOff.col.recorded"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => fmtDateTime(row.recorded_at),
      },
      {
        key: "reason",
        header: t("admin.compOff.col.reason"),
        width: "16rem",
        hideBelow: "lg",
        render: (row) => dash(row.reason),
      },
    ],
    [labels.data],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={HeartHandshake}
        title={t("admin.compOff.title")}
        subtitle={t("admin.compOff.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.compOff.readOnly")}
      </Notice>

      <section className="mb-8">
        <h2 className="mb-3 font-display text-lg font-semibold">
          {t("admin.compOff.balances.heading")}
        </h2>
        <StateBoundary
          loading={balances.isLoading}
          error={balances.error ?? undefined}
          onRetry={() => void balances.refetch()}
          partialError={labels.error ?? undefined}
          partialLabel={t("admin.common.partial.names")}
          skeletonRows={4}
        >
          <DataGrid
            columns={balanceColumns}
            rows={balanceRows}
            rowKey={(row) => row.employee_id}
            pageSize={25}
            emptyState={
              <EmptyState
                icon={Hourglass}
                title={t("admin.compOff.balances.empty.title")}
                hint={t("admin.compOff.balances.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">
          {t("admin.compOff.ledger.heading")}
        </h2>

        {capped ? (
          <Notice tone="warning" className="mb-4">
            {t("admin.common.rowCap", { count: LEAVE_ROW_CAP })}
          </Notice>
        ) : null}

        <StateBoundary
          loading={ledger.isLoading}
          error={ledger.error ?? undefined}
          onRetry={() => void ledger.refetch()}
          partialError={labels.error ?? undefined}
          partialLabel={t("admin.common.partial.names")}
          skeletonRows={6}
        >
          <DataGrid
            columns={ledgerColumns}
            rows={ledgerRows}
            rowKey={(row) => row.id}
            pageSize={25}
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
                  label={t("admin.compOff.filter.status")}
                  value={status ?? ""}
                  options={statusChoices()}
                  placeholder={t("admin.compOff.filter.allStatuses")}
                  onChange={(value) => setParam("status", value)}
                />
              </div>
            }
            emptyState={
              <EmptyState
                icon={Hourglass}
                title={t("admin.compOff.ledger.empty.title")}
                hint={
                  employeeId !== null || status !== null
                    ? t("admin.compOff.ledger.empty.filtered")
                    : t("admin.compOff.ledger.empty.hint")
                }
              />
            }
          />
        </StateBoundary>
      </section>
    </div>
  );
}
