/**
 * /admin/leave/ledger/:code — every credit and debit behind one person's leave
 * balance (spec-admin §7.2, "Balance = running ledger sum").
 *
 * This is the screen that settles an argument. When an employee says "I had
 * eight days", this is where the eight comes from — and it reads like a bank
 * statement because it is one:
 *
 *  1. THE RUNNING BALANCE IS THE DATABASE'S, NOT THE SCROLL POSITION'S.
 *     `balance_after` is stamped by `leave_ledger_before_insert()` at the moment
 *     each row was written (migration 019 §5), so the figure beside a movement is
 *     the balance as it stood THEN. Accumulating it down the page would produce a
 *     different number for the same row depending on the filter — the defect this
 *     column exists to prevent.
 *  2. THE HEADER STRIP IS `v_leave_balance_current`, PRINTED. Opening, accrued,
 *     carried forward, adjusted, availed, pending, encashed, lapsed and available
 *     are its columns; `available_days` is a GENERATED column over this very
 *     ledger, which is why the strip and the statement cannot disagree.
 *  3. THE TOTAL IS A SERVER COUNT over the grid's own predicate, so it stays
 *     honest while "load more" walks the keyset.
 *  4. THE LEDGER IS APPEND-ONLY. `leave_ledger_guard_mutation()` refuses client
 *     UPDATE and DELETE outright; a correction is a reversing entry, and a
 *     reversed row is labelled rather than hidden. There is no edit affordance on
 *     this screen because there is no edit in the database.
 *
 * `:code` is the `employee_code` — the same identifier every other admin route
 * carries — and `?type=` accepts a leave type CODE, because that is what
 * `/admin/leave/balances` links with.
 *
 * @route /admin/leave/ledger/:code
 */
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { LeaveBalance } from "../api/leave.api";
import type { LedgerRow } from "../api/leave-config.api";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import {
  LEDGER_ENTRY_CHIP,
  LEDGER_KIND_GROUPS,
  leaveYearLabel,
  ledgerKindGroup,
  ledgerOrigin,
} from "../leave-config-vocab";
import { unavailableHint } from "../command-vocab";
import { useAdminEmployee } from "../hooks/usePeople";
import { useAdminLeaveTypes } from "../hooks/useAdminLeave";
import {
  LEDGER_PAGE_SIZE,
  flattenLedger,
  useEmployeeBalances,
  useEmployeeLedger,
  useEmployeeLedgerCount,
  useLedgerYears,
} from "../hooks/useLeaveConfig";

/** One balance figure on the statement header, printed from its own column. */
function BalanceFigure({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("num text-right", strong === true && "font-semibold")}>
        {formatDays(value)}
      </dd>
    </div>
  );
}

export default function AdminLeaveLedgerPage() {
  const { code = "" } = useParams<{ code: string }>();
  const [params, setParams] = useSearchParams();

  /** `?type=` is a leave type CODE (what /admin/leave/balances links with). */
  const typeCode = params.get("type") ?? "";
  const yearParam = params.get("year") ?? "";
  const kindParam = params.get("kind") ?? "";

  const employee = useAdminEmployee(code);
  const employeeId = employee.data?.id ?? null;

  const types = useAdminLeaveTypes();
  const balances = useEmployeeBalances(employeeId);
  const years = useLedgerYears(employeeId);

  const selectedType = useMemo(
    () => (types.data ?? []).find((type) => type.code === typeCode) ?? null,
    [types.data, typeCode],
  );

  const kindGroup = ledgerKindGroup(kindParam);
  const leaveYear = /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;

  /**
   * The ONE filter object the statement, its total and "load more" all share. A
   * syntactically valid employee id that matches nothing would be wrong here —
   * the reads are disabled until the person resolves, so an unresolved code can
   * never widen into "everybody's ledger" for one render.
   */
  const filters = useMemo(
    () => ({
      employeeId: employeeId ?? "",
      leaveTypeId: selectedType?.id ?? null,
      leaveYear,
      ...(kindGroup !== null ? { entryTypes: kindGroup.types } : {}),
    }),
    [employeeId, selectedType, leaveYear, kindGroup],
  );

  const enabled = employeeId !== null;
  const ledger = useEmployeeLedger(filters, enabled);
  const total = useEmployeeLedgerCount(filters, enabled);

  const rows = flattenLedger(ledger.data);

  const balanceRows = balances.data ?? [];
  const typeBalance: LeaveBalance | null =
    selectedType === null
      ? null
      : balanceRows.find((row) => row.leave_type_id === selectedType.id) ?? null;

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const typeChoices: SelectOption[] = useMemo(
    () => (types.data ?? []).map((type) => ({ value: type.code, label: type.name })),
    [types.data],
  );

  const yearChoices: SelectOption[] = useMemo(
    () => (years.data ?? []).map((year) => ({ value: String(year), label: leaveYearLabel(year) })),
    [years.data],
  );

  const kindChoices: SelectOption[] = LEDGER_KIND_GROUPS.map((group) => ({
    value: group.value,
    label: group.label,
  }));

  const person = employee.data ?? null;
  const filtersOn = typeCode !== "" || yearParam !== "" || kindParam !== "";

  const columns: DataGridColumn<LedgerRow>[] = [
    {
      key: "effective_date",
      header: t("adminLeave.ledger.col.date"),
      width: "11rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num">{fmtCivilDate(row.effective_date)}</span>
          <span className="text-xs text-muted-foreground">{leaveYearLabel(row.leave_year)}</span>
        </span>
      ),
    },
    {
      key: "entry_type",
      header: t("adminLeave.ledger.col.movement"),
      width: "12rem",
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <StatusChip status={row.entry_type} map={LEDGER_ENTRY_CHIP} />
          {row.is_reversal ? (
            <span className="text-xs text-muted-foreground">
              {t("adminLeave.ledger.isReversal")}
            </span>
          ) : null}
          {row.is_reversed ? (
            <span className="text-xs text-warning">{t("adminLeave.ledger.isReversed")}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "leave_type_name",
      header: t("adminLeave.ledger.col.type"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => row.leave_type_name,
    },
    {
      key: "days",
      header: t("adminLeave.ledger.col.days"),
      width: "7rem",
      align: "right",
      sortable: true,
      // The sign belongs to the row: `ck_ll__sign` guarantees credits are
      // positive and debits negative, so nothing here decides which it is.
      render: (row) => (
        <span
          className={cn("num font-semibold", row.days < 0 ? "text-destructive" : "text-success")}
        >
          {row.days > 0 ? `+${formatDays(row.days)}` : formatDays(row.days)}
        </span>
      ),
    },
    {
      key: "balance_after",
      header: t("adminLeave.ledger.col.balanceAfter"),
      width: "9rem",
      align: "right",
      render: (row) => <span className="num">{dash(row.balance_after, formatDays)}</span>,
    },
    {
      key: "description",
      header: t("adminLeave.ledger.col.description"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span>{row.description}</span>
          <span className="text-xs text-muted-foreground">{ledgerOrigin(row)}</span>
          {row.reason === null ? null : (
            <span className="text-xs text-muted-foreground">
              {t("adminLeave.ledger.reason", { reason: row.reason })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "leave_request_id",
      header: t("adminLeave.ledger.col.request"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        if (row.leave_request_id === null) return dash(null);
        return (
          <span onClick={(event) => event.stopPropagation()}>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/admin/leave/requests?emp=${row.employee_id}`}>
                {t("adminLeave.ledger.openRequests")}
              </Link>
            </Button>
          </span>
        );
      },
    },
    {
      key: "recorded_at_ist",
      header: t("adminLeave.ledger.col.recorded"),
      width: "12rem",
      hideBelow: "lg",
      // Pre-rendered IST by the view (`to_char(util.ist_ts(...))`) — never
      // re-derived from the instant in the browser.
      render: (row) => <span className="num text-xs">{row.recorded_at_ist}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Scale}
        title={t("adminLeave.ledger.title")}
        subtitle={t("adminLeave.ledger.subtitle")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/leave/balances">
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
              {t("adminLeave.ledger.backToBalances")}
            </Link>
          </Button>
        }
      />

      <StateBoundary
        loading={employee.isLoading}
        error={employee.error ?? undefined}
        onRetry={() => void employee.refetch()}
        skeletonRows={3}
      >
        <section className="mb-5 rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PersonCell
              name={person?.display_name ?? null}
              code={person?.employee_code ?? null}
              secondary={[person?.department_name, person?.designation_name]
                .filter((part): part is string => part != null && part !== "")
                .join(" · ")}
            />
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to={`/admin/people/${encodeURIComponent(code)}`}>
                  {t("adminLeave.ledger.openPerson")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to={`/admin/leave/requests?emp=${person?.id ?? ""}`}>
                  {t("adminLeave.ledger.openRequests")}
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </StateBoundary>

      <Notice tone="info" className="mb-4">
        {t("adminLeave.ledger.provenance")}
      </Notice>

      <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          <StateBoundary
            loading={balances.isLoading}
            error={balances.error ?? undefined}
            onRetry={() => void balances.refetch()}
            isEmpty={balances.isSuccess && balanceRows.length === 0}
            empty={
              <EmptyState
                icon={CalendarDays}
                title={t("adminLeave.ledger.noBalances.title")}
                hint={t("adminLeave.ledger.noBalances.hint")}
              />
            }
            skeletonRows={3}
          >
            {typeBalance !== null ? (
              <section className="rounded-lg border bg-card p-5">
                <h2 className="font-display text-base font-semibold">
                  {t("adminLeave.ledger.statementOf", { type: typeBalance.leave_type_name })}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {leaveYearLabel(typeBalance.leave_year)}
                </p>
                <dl className="mt-4 space-y-2 text-sm">
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.opening")}
                    value={typeBalance.opening_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.accrued")}
                    value={typeBalance.accrued_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.carried")}
                    value={typeBalance.carried_forward_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.adjusted")}
                    value={typeBalance.adjusted_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.availed")}
                    value={typeBalance.availed_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.pending")}
                    value={typeBalance.pending_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.encashed")}
                    value={typeBalance.encashed_days}
                  />
                  <BalanceFigure
                    label={t("adminLeave.ledger.fig.lapsed")}
                    value={typeBalance.lapsed_days}
                  />
                  <div className="border-t pt-2">
                    <BalanceFigure
                      label={t("adminLeave.ledger.fig.available")}
                      value={typeBalance.available_days}
                      strong
                    />
                    <BalanceFigure
                      label={t("adminLeave.ledger.fig.spendable")}
                      value={typeBalance.available_after_pending}
                    />
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  {/*
                    `last_recomputed_at` is a timestamptz. Slicing its first ten
                    characters yields the UTC calendar date, which is the
                    PREVIOUS IST day for anything stamped after 18:30 UTC — and
                    the drift-check job that writes it runs at 02:45 IST, so the
                    sliced version reported yesterday every single night.
                    fmtDateTime renders the instant in IST.
                  */}
                  {typeBalance.last_recomputed_at === null
                    ? t("adminLeave.ledger.neverRecomputed")
                    : t("adminLeave.ledger.recomputed", {
                        when: fmtDateTime(typeBalance.last_recomputed_at),
                      })}
                </p>
              </section>
            ) : (
              <section className="rounded-lg border bg-card p-5">
                <h2 className="font-display text-base font-semibold">
                  {t("adminLeave.ledger.allTypes.title")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("adminLeave.ledger.allTypes.hint")}
                </p>
                <ul className="mt-4 space-y-2 text-sm">
                  {balanceRows.map((row) => (
                    <li key={row.leave_type_id}>
                      <button
                        type="button"
                        onClick={() => setParam("type", row.leave_type_code)}
                        className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span>{row.leave_type_name}</span>
                        <span className="num font-semibold">
                          {formatDays(row.available_days)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </StateBoundary>

          <KpiTile
            label={t("adminLeave.ledger.tile.movements")}
            value={
              total.error !== null
                ? t("common.empty")
                : total.data === undefined
                  ? t("admin.cc.tile.loading")
                  : formatNumber(total.data)
            }
            hint={
              total.error !== null
                ? unavailableHint(total.error)
                : t("adminLeave.ledger.tile.movementsHint")
            }
            explainer={{
              formula: t("adminLeave.ledger.tile.formula"),
              numbers: t("adminLeave.ledger.tile.numbers", {
                count: total.data === undefined ? t("common.empty") : formatNumber(total.data),
              }),
            }}
          />
        </aside>

        <StateBoundary
          loading={ledger.isLoading}
          error={ledger.error ?? undefined}
          onRetry={() => void ledger.refetch()}
          partialError={total.error ?? years.error ?? types.error ?? undefined}
          partialLabel={t("adminLeave.ledger.partial")}
          skeletonRows={8}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={LEDGER_PAGE_SIZE}
            toolbar={
              <div className="grid w-full gap-3 sm:grid-cols-3">
                <SelectField
                  label={t("adminLeave.ledger.filter.type")}
                  value={typeCode}
                  options={typeChoices}
                  placeholder={t("adminLeave.ledger.filter.allTypes")}
                  onChange={(value) => setParam("type", value)}
                  disabled={types.isLoading}
                />
                <SelectField
                  label={t("adminLeave.ledger.filter.year")}
                  value={yearParam}
                  options={yearChoices}
                  placeholder={t("adminLeave.ledger.filter.allYears")}
                  onChange={(value) => setParam("year", value)}
                  disabled={years.isLoading}
                />
                <SelectField
                  label={t("adminLeave.ledger.filter.kind")}
                  value={kindParam}
                  options={kindChoices}
                  placeholder={t("adminLeave.ledger.filter.allKinds")}
                  onChange={(value) => setParam("kind", value)}
                />
              </div>
            }
            emptyState={
              <EmptyState
                icon={Scale}
                title={t("adminLeave.ledger.empty.title")}
                hint={
                  filtersOn
                    ? t("adminLeave.ledger.empty.filtered")
                    : t("adminLeave.ledger.empty.hint")
                }
              />
            }
          />

          {ledger.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void ledger.fetchNextPage()}
                disabled={ledger.isFetchingNextPage}
              >
                {ledger.isFetchingNextPage
                  ? t("adminLeave.ledger.loadingMore")
                  : t("adminLeave.ledger.loadMore")}
              </Button>
            </div>
          ) : null}

          <p className="mt-4 text-xs text-muted-foreground">
            {t("adminLeave.ledger.appendOnly")}
          </p>
        </StateBoundary>
      </div>
    </div>
  );
}
