/**
 * /admin/leave/encashment — the encashable exposure, and every encashment that
 * has actually been paid (spec-admin §7.3: "formula `days × (basic + DA) / 26`,
 * super_admin above threshold").
 *
 * Two relations, two grids, and one deliberate absence:
 *
 *  1. WHAT COULD BE ENCASHED. `v_leave_balance_current` filtered to the types
 *     whose `encashment_allowed` is true, printed column by column:
 *     `available_days` (a GENERATED column over the append-only ledger),
 *     `encashed_days` (what this leave year has already paid out) and the type's
 *     own `max_encashment_days` cap beside them. Three server figures, no
 *     browser-side "eligible days" between them: the cap interacts with
 *     `max_balance_days` and with the rollover, and a number invented here would
 *     be the one figure on the screen the ledger could contradict.
 *  2. WHAT WAS ENCASHED. `v_leave_ledger_statement` filtered to `encashment` and
 *     `settlement` — the debits themselves, with the payroll run each was paid in.
 *     `ck_ll__sign` guarantees they are negative, so the sign on screen is the
 *     database's.
 *  3. NO MONEY. The payout is `days × (basic + DA) / 26` and it belongs to the
 *     payroll engine (component 140 "Leave Encashment", spec-admin §8.1), which
 *     computes it against the salary in force for the period and puts it on the
 *     payslip. Multiplying a salary by a day count in a browser — with no period,
 *     no revision history and no rounding rule — is exactly the arithmetic this
 *     build refuses to do, so the screen links to the run instead of guessing it.
 *
 * There is also no "run encashment" button, and that is not an omission:
 * `leave_ledger` grants INSERT to `service_role` only, its append-only guard
 * refuses client mutation, and no encashment function or edge function is
 * deployed. The screen says so where the button would have been.
 *
 * @route /admin/leave/encashment
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Banknote, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { LeaveBalance, LeaveType } from "../api/leave.api";
import { LEAVE_CONFIG_ROW_CAP, type LedgerRow } from "../api/leave-config.api";
import { CountTile } from "../components/CountTile";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { LEDGER_ENTRY_CHIP, encashmentRule, leaveYearLabel } from "../leave-config-vocab";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useAdminLeaveTypes } from "../hooks/useAdminLeave";
import { useCurrentLeaveYear } from "../hooks/useAnalyticsWorkforce";
import {
  useBalanceRecordCount,
  useEncashableBalances,
  useEncashmentLedger,
  useEncashmentLedgerCount,
} from "../hooks/useLeaveConfig";

export default function AdminLeaveEncashmentPage() {
  const [params, setParams] = useSearchParams();
  const typeParam = params.get("type") ?? "";

  const labels = useEmployeeLabels();
  const types = useAdminLeaveTypes();
  const leaveYear = useCurrentLeaveYear();

  /** The rulebook decides the scope: only types that may be encashed at all. */
  const encashTypes = useMemo<readonly LeaveType[]>(
    () => (types.data ?? []).filter((type) => type.encashment_allowed),
    [types.data],
  );
  const encashTypeIds = useMemo(() => encashTypes.map((type) => type.id), [encashTypes]);
  const typeById = useMemo(() => {
    const map = new Map<string, LeaveType>();
    for (const type of types.data ?? []) map.set(type.id, type);
    return map;
  }, [types.data]);

  /**
   * The scope every read below shares: the chosen encashable type, or all of
   * them. One list, so the tiles, the grid and the movements can never be
   * describing different sets of types.
   */
  const scopeTypeIds = useMemo(
    () => (typeParam === "" ? encashTypeIds : encashTypeIds.filter((id) => id === typeParam)),
    [encashTypeIds, typeParam],
  );

  const balances = useEncashableBalances(scopeTypeIds);
  const holders = useBalanceRecordCount(
    { leaveTypeIds: scopeTypeIds, availableAbove: 0 },
    "encashHolders",
    scopeTypeIds.length > 0,
  );
  const alreadyEncashed = useBalanceRecordCount(
    { leaveTypeIds: scopeTypeIds, encashedOnly: true },
    "encashedThisYear",
    scopeTypeIds.length > 0,
  );

  const ledgerFilters = useMemo(() => ({ leaveTypeIds: scopeTypeIds }), [scopeTypeIds]);
  const movements = useEncashmentLedger(ledgerFilters);
  const movementCount = useEncashmentLedgerCount(ledgerFilters);

  const balanceRows = balances.data ?? [];
  const movementRows = movements.data ?? [];
  const capped = balanceRows.length >= LEAVE_CONFIG_ROW_CAP;

  const balanceColumns: DataGridColumn<LeaveBalance>[] = [
    {
      key: "employee",
      header: t("adminLeave.encash.col.employee"),
      width: "15rem",
      sortable: true,
      sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
      render: (row) => {
        const label = labels.data?.get(row.employee_id);
        return (
          <PersonCell
            name={label?.name ?? null}
            code={label?.code ?? null}
            secondary={label?.department ?? null}
          />
        );
      },
    },
    {
      key: "leave_type_name",
      header: t("adminLeave.encash.col.type"),
      width: "11rem",
      sortable: true,
      render: (row) => row.leave_type_name,
    },
    {
      key: "available_days",
      header: t("adminLeave.encash.col.available"),
      width: "9rem",
      align: "right",
      sortable: true,
      render: (row) => (
        <span className="num font-semibold">{formatDays(row.available_days)}</span>
      ),
    },
    {
      key: "available_after_pending",
      header: t("adminLeave.encash.col.spendable"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{formatDays(row.available_after_pending)}</span>,
    },
    {
      key: "encashed_days",
      header: t("adminLeave.encash.col.encashed"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (row) => (
        <span className={cn("num", row.encashed_days > 0 && "text-info")}>
          {formatDays(row.encashed_days)}
        </span>
      ),
    },
    {
      key: "cap",
      header: t("adminLeave.encash.col.cap"),
      width: "9rem",
      align: "right",
      render: (row) => {
        const cap = typeById.get(row.leave_type_id)?.max_encashment_days ?? null;
        return (
          <span className="num">
            {cap === null ? t("adminLeave.encash.uncapped") : formatDays(cap)}
          </span>
        );
      },
    },
    {
      key: "leave_year",
      header: t("adminLeave.encash.col.year"),
      width: "9rem",
      hideBelow: "lg",
      render: (row) => <span className="num text-xs">{leaveYearLabel(row.leave_year)}</span>,
    },
    {
      key: "ledger",
      header: t("adminLeave.encash.col.ledger"),
      width: "9rem",
      align: "right",
      render: (row) => {
        const code = labels.data?.get(row.employee_id)?.code;
        if (code === undefined) return dash(null);
        return (
          <span onClick={(event) => event.stopPropagation()}>
            <Button variant="outline" size="sm" asChild>
              <Link
                to={`/admin/leave/ledger/${encodeURIComponent(code)}?type=${row.leave_type_code}`}
              >
                {t("adminLeave.encash.openLedger")}
              </Link>
            </Button>
          </span>
        );
      },
    },
  ];

  const movementColumns: DataGridColumn<LedgerRow>[] = [
    {
      key: "effective_date",
      header: t("adminLeave.encash.col.date"),
      width: "11rem",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDate(row.effective_date)}</span>,
    },
    {
      key: "employee",
      header: t("adminLeave.encash.col.employee"),
      width: "14rem",
      render: (row) => {
        const label = labels.data?.get(row.employee_id);
        return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
      },
    },
    {
      key: "entry_type",
      header: t("adminLeave.encash.col.movement"),
      width: "11rem",
      render: (row) => <StatusChip status={row.entry_type} map={LEDGER_ENTRY_CHIP} />,
    },
    {
      key: "leave_type_name",
      header: t("adminLeave.encash.col.type"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => row.leave_type_name,
    },
    {
      key: "days",
      header: t("adminLeave.encash.col.days"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num font-semibold">{formatDays(row.days)}</span>,
    },
    {
      key: "balance_after",
      header: t("adminLeave.encash.col.balanceAfter"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{dash(row.balance_after, formatDays)}</span>,
    },
    {
      key: "description",
      header: t("adminLeave.encash.col.description"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span>{row.description}</span>
          {row.reason === null ? null : (
            <span className="text-xs text-muted-foreground">{row.reason}</span>
          )}
        </span>
      ),
    },
    {
      key: "payroll_run_id",
      header: t("adminLeave.encash.col.paidIn"),
      width: "9rem",
      align: "right",
      render: (row) => {
        if (row.payroll_run_id === null)
          return <span className="text-xs text-muted-foreground">{t("adminLeave.encash.notPaid")}</span>;
        return (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/admin/payroll/runs/${row.payroll_run_id}`}>
              {t("adminLeave.encash.openRun")}
            </Link>
          </Button>
        );
      },
    },
  ];

  const typeChoices: SelectOption[] = useMemo(
    () => encashTypes.map((type) => ({ value: type.id, label: type.name })),
    [encashTypes],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("adminLeave.encash.title")}
        subtitle={t("adminLeave.encash.subtitle")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/leave/rollover">{t("adminLeave.encash.openRollover")}</Link>
          </Button>
        }
      />

      <Notice tone="warning" className="mb-4">
        <p className="font-medium">{t("adminLeave.encash.noEndpoint.title")}</p>
        <p className="mt-1">{t("adminLeave.encash.noEndpoint.body")}</p>
      </Notice>

      <Notice tone="info" className="mb-5">
        {t("adminLeave.encash.formulaNote")}
      </Notice>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <CountTile
          label={t("adminLeave.encash.tile.holders")}
          hint={t("adminLeave.encash.tile.holdersHint")}
          to="/admin/leave/balances"
          drillLabel={t("adminLeave.encash.tile.holdersDrill")}
          source={t("adminLeave.encash.source.balances")}
          query={holders}
        />
        <CountTile
          label={t("adminLeave.encash.tile.encashed")}
          hint={t("adminLeave.encash.tile.encashedHint", {
            year: leaveYear.data === null || leaveYear.data === undefined
              ? t("common.empty")
              : leaveYearLabel(leaveYear.data),
          })}
          to="/admin/leave/encashment"
          drillLabel={t("adminLeave.encash.tile.encashedDrill")}
          source={t("adminLeave.encash.source.balances")}
          query={alreadyEncashed}
        />
        <CountTile
          label={t("adminLeave.encash.tile.movements")}
          hint={t("adminLeave.encash.tile.movementsHint")}
          to="/admin/leave/encashment"
          drillLabel={t("adminLeave.encash.tile.movementsDrill")}
          source={t("adminLeave.encash.source.ledger")}
          query={movementCount}
        />
      </div>

      <section className="mb-8">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("adminLeave.encash.rules.heading")}
        </h2>
        <StateBoundary
          loading={types.isLoading}
          error={types.error ?? undefined}
          onRetry={() => void types.refetch()}
          isEmpty={types.isSuccess && encashTypes.length === 0}
          empty={
            <EmptyState
              icon={Banknote}
              title={t("adminLeave.encash.noTypes.title")}
              hint={t("adminLeave.encash.noTypes.hint")}
              action={
                <Button asChild>
                  <Link to="/admin/leave/types">{t("adminLeave.encash.openTypes")}</Link>
                </Button>
              }
            />
          }
          skeletonRows={2}
        >
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {encashTypes.map((type) => (
              <li key={type.id} className="rounded-lg border bg-card p-4">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{type.name}</span>
                  <span className="num text-xs text-muted-foreground">{type.code}</span>
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">{encashmentRule(type)}</p>
                <Button asChild variant="ghost" size="sm" className="mt-2 -ml-2">
                  <Link to={`/admin/leave/types`}>{t("adminLeave.encash.editRule")}</Link>
                </Button>
              </li>
            ))}
          </ul>
        </StateBoundary>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("adminLeave.encash.balances.heading")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("adminLeave.encash.balances.hint")}
        </p>

        {capped ? (
          <Notice tone="warning" className="mb-4">
            {t("adminLeave.encash.rowCap", { count: formatNumber(LEAVE_CONFIG_ROW_CAP) })}
          </Notice>
        ) : null}

        <StateBoundary
          loading={balances.isLoading}
          error={balances.error ?? undefined}
          onRetry={() => void balances.refetch()}
          partialError={labels.error ?? undefined}
          partialLabel={t("adminLeave.encash.partialNames")}
          skeletonRows={6}
        >
          <DataGrid
            columns={balanceColumns}
            rows={balanceRows}
            rowKey={(row) => `${row.employee_id}:${row.leave_type_id}:${row.leave_year}`}
            pageSize={25}
            toolbar={
              <div className="w-full sm:w-72">
                <SelectField
                  label={t("adminLeave.encash.filter.type")}
                  value={typeParam}
                  options={typeChoices}
                  placeholder={t("adminLeave.encash.filter.allTypes")}
                  onChange={(value) => {
                    const next = new URLSearchParams(params);
                    if (value === "") next.delete("type");
                    else next.set("type", value);
                    setParams(next, { replace: true });
                  }}
                  disabled={types.isLoading}
                  hint={t("adminLeave.encash.filter.hint")}
                />
              </div>
            }
            emptyState={
              <EmptyState
                icon={Scale}
                title={t("adminLeave.encash.balances.empty")}
                hint={t("adminLeave.encash.balances.emptyHint")}
              />
            }
          />
        </StateBoundary>
      </section>

      <section>
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("adminLeave.encash.movements.heading")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("adminLeave.encash.movements.hint")}
        </p>
        <StateBoundary
          loading={movements.isLoading}
          error={movements.error ?? undefined}
          onRetry={() => void movements.refetch()}
          partialError={labels.error ?? movementCount.error ?? undefined}
          partialLabel={t("adminLeave.encash.partialNames")}
          skeletonRows={4}
        >
          <DataGrid
            columns={movementColumns}
            rows={movementRows}
            rowKey={(row) => row.id}
            pageSize={25}
            emptyState={
              <EmptyState
                icon={Banknote}
                title={t("adminLeave.encash.movements.empty")}
                hint={t("adminLeave.encash.movements.emptyHint")}
              />
            }
          />
        </StateBoundary>
      </section>
    </div>
  );
}
