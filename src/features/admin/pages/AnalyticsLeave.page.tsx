/**
 * §14 · /admin/analytics/leave — consumption, exhaustion and ledger movement.
 *
 * `v_leave_balance_current` is the only current-leave-year relation deployed, and
 * its grain decides what this screen can honestly say. It is ONE ROW PER
 * EMPLOYEE × LEAVE TYPE, carrying stored columns (`availed_days`,
 * `available_days`, `expiring_soon_days` — the last two GENERATED over the
 * append-only ledger). It carries no department, and no view or function
 * anywhere sums days by type, department or month.
 *
 * So:
 *
 *  * every figure on this page is either a `count=exact` of records matching a
 *    predicate, or a column printed from a record. "Days consumed by
 *    department" — the number a leave dashboard usually leads with — is NOT
 *    computable without adding rows up in the browser, and it is therefore
 *    stated as missing rather than shown;
 *  * the by-type panel counts EMPLOYEES (records holding the type, records with
 *    consumption), not days, and says so in its own heading;
 *  * the department filter works by naming the department's employees and
 *    filtering `employee_id` — a join the client may make. It scopes the counts
 *    and the grid identically, so the tile and the rows always agree;
 *  * the ledger panel counts MOVEMENTS per entry kind in the leave year from
 *    `v_leave_ledger_statement`; the leave year itself comes from Postgres
 *    (`leave_year_of(ist_today())`), never from a browser calendar.
 *
 * @route /admin/analytics/leave
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, CalendarDays, Scale } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { CountTile } from "../components/CountTile";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { unavailableHint } from "../command-vocab";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useRefOptions } from "../hooks/useMasters";
import {
  useAnalyticsLeaveTypes,
  useCurrentLeaveYear,
  useDepartmentEmployeeIds,
  useLeaveConsumption,
  useLeaveSliceCounts,
  useLeaveTypeCounts,
  useLedgerKindCounts,
  ANALYTICS_ROW_CAP,
} from "../hooks/useAnalyticsWorkforce";
import type { LeaveScope } from "../api/analytics-workforce.api";
import type { LeaveBalance } from "../api/leave.api";

const GRID_STROKE = "hsl(var(--border))";
const CONSUMER_FILL = "hsl(var(--chart-6))";

const LEDGER_LABELS: Readonly<Record<string, string>> = {
  accrual: t("admin.analytics.lv.kind.accrual"),
  availed: t("admin.analytics.lv.kind.availed"),
  credit_adjustment: t("admin.analytics.lv.kind.credit"),
  debit_adjustment: t("admin.analytics.lv.kind.debit"),
  lapse: t("admin.analytics.lv.kind.lapse"),
  encashment: t("admin.analytics.lv.kind.encashment"),
};

/** A per-type row: two server counts and the type's name. */
interface TypeRow {
  readonly key: string;
  readonly name: string;
  readonly holders: number | null;
  readonly consumers: number | null;
  readonly unreadable: string | null;
}

/** A ledger-kind row: one server count of movements. */
interface KindRow {
  readonly key: string;
  readonly label: string;
  readonly count: number | null;
  readonly unreadable: string | null;
}

export default function AnalyticsLeavePage() {
  const [params, setParams] = useSearchParams();

  const departmentId = params.get("department") ?? "";
  const leaveTypeId = params.get("type") ?? "";

  const departments = useRefOptions("departments");
  const types = useAnalyticsLeaveTypes();
  const labels = useEmployeeLabels();
  const leaveYear = useCurrentLeaveYear();
  const departmentEmployees = useDepartmentEmployeeIds(departmentId);

  const departmentChoices: SelectOption[] = useMemo(
    () => (departments.data ?? []).map((d) => ({ value: d.id, label: d.name })),
    [departments.data],
  );
  const typeChoices: SelectOption[] = useMemo(
    () => (types.data ?? []).map((type) => ({ value: type.id, label: type.name })),
    [types.data],
  );

  /**
   * The department filter has to resolve to employee ids before any count can
   * run — otherwise an unscoped count would flash the whole organisation's
   * number under a department heading.
   */
  const scopeReady = departmentId === "" || departmentEmployees.isSuccess;
  const departmentIsEmpty =
    departmentId !== "" &&
    departmentEmployees.isSuccess &&
    (departmentEmployees.data ?? []).length === 0;

  const scope: LeaveScope = useMemo(
    () => ({
      ...(departmentId !== "" && departmentEmployees.data !== undefined
        ? { employeeIds: departmentEmployees.data }
        : {}),
      ...(leaveTypeId !== "" ? { leaveTypeId } : {}),
    }),
    [departmentEmployees.data, departmentId, leaveTypeId],
  );

  const enabled = scopeReady && !departmentIsEmpty;

  const sliceCounts = useLeaveSliceCounts(scope, enabled);
  const typeCounts = useLeaveTypeCounts(types.data ?? [], scope, enabled);
  const consumption = useLeaveConsumption(scope, enabled);
  const ledgerKinds = useLedgerKindCounts(leaveYear.data ?? null, scope);

  const typeRows: TypeRow[] = useMemo(
    () =>
      typeCounts.map((slice) => ({
        key: slice.id,
        name: slice.name,
        holders: slice.holders.data ?? null,
        consumers: slice.consumers.data ?? null,
        unreadable:
          slice.holders.error !== null
            ? unavailableHint(slice.holders.error)
            : slice.consumers.error !== null
              ? unavailableHint(slice.consumers.error)
              : null,
      })),
    [typeCounts],
  );

  const kindRows: KindRow[] = useMemo(
    () =>
      ledgerKinds.map((slice) => ({
        key: slice.key,
        label: LEDGER_LABELS[slice.key] ?? slice.key,
        count: slice.query.data ?? null,
        unreadable: slice.query.error !== null ? unavailableHint(slice.query.error) : null,
      })),
    [ledgerKinds],
  );

  const consumerBars = typeRows.filter((row) => row.consumers !== null);
  const rows = consumption.data ?? [];

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const typeColumns: DataGridColumn<TypeRow>[] = useMemo(
    () => [
      { key: "name", header: t("admin.analytics.lv.col.type"), width: "14rem" },
      {
        key: "holders",
        header: t("admin.analytics.lv.col.holders"),
        width: "11rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.holders,
        render: (row) =>
          row.unreadable !== null ? (
            <span className="text-xs text-muted-foreground">{row.unreadable}</span>
          ) : (
            <span className="num">{dash(row.holders, formatNumber)}</span>
          ),
      },
      {
        key: "consumers",
        header: t("admin.analytics.lv.col.consumers"),
        width: "12rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.consumers,
        render: (row) => <span className="num">{dash(row.consumers, formatNumber)}</span>,
      },
    ],
    [],
  );

  const kindColumns: DataGridColumn<KindRow>[] = useMemo(
    () => [
      { key: "label", header: t("admin.analytics.lv.col.kind"), width: "14rem" },
      {
        key: "count",
        header: t("admin.analytics.lv.col.movements"),
        width: "11rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.count,
        render: (row) =>
          row.unreadable !== null ? (
            <span className="text-xs text-muted-foreground">{row.unreadable}</span>
          ) : (
            <span className="num">{dash(row.count, formatNumber)}</span>
          ),
      },
    ],
    [],
  );

  const consumptionColumns: DataGridColumn<LeaveBalance>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.analytics.lv.col.employee"),
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
        header: t("admin.analytics.lv.col.type"),
        width: "11rem",
        sortable: true,
        render: (row) => row.leave_type_name,
      },
      {
        key: "entitlement_days",
        header: t("admin.analytics.lv.col.entitlement"),
        width: "9rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <span className="num">{formatDays(row.entitlement_days)}</span>,
      },
      {
        key: "availed_days",
        header: t("admin.analytics.lv.col.availed"),
        width: "9rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num font-medium">{formatDays(row.availed_days)}</span>,
      },
      {
        key: "pending_days",
        header: t("admin.analytics.lv.col.pending"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatDays(row.pending_days)}</span>,
      },
      {
        key: "available_days",
        header: t("admin.analytics.lv.col.available"),
        width: "9rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatDays(row.available_days)}</span>,
      },
      {
        key: "lapsed_days",
        header: t("admin.analytics.lv.col.lapsed"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatDays(row.lapsed_days)}</span>,
      },
      {
        key: "encashed_days",
        header: t("admin.analytics.lv.col.encashed"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatDays(row.encashed_days)}</span>,
      },
      {
        key: "nearest_expiry",
        header: t("admin.analytics.lv.col.expiry"),
        width: "10rem",
        hideBelow: "lg",
        render: (row) => dash(row.nearest_expiry, fmtCivilDate),
      },
    ],
    [labels.data],
  );

  const balancesRoute =
    leaveTypeId === "" ? "/admin/leave/balances" : `/admin/leave/balances?type=${leaveTypeId}`;

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("admin.analytics.lv.title")}
        subtitle={
          leaveYear.data == null
            ? t("admin.analytics.lv.subtitleUnknownYear")
            : t("admin.analytics.lv.subtitle", { year: String(leaveYear.data) })
        }
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label={t("admin.analytics.lv.filter.department")}
              value={departmentId}
              placeholder={t("admin.analytics.lv.filter.anyDepartment")}
              options={departmentChoices}
              onChange={(v) => setParam("department", v)}
            />
            <SelectField
              label={t("admin.analytics.lv.filter.type")}
              value={leaveTypeId}
              placeholder={t("admin.analytics.lv.filter.anyType")}
              options={typeChoices}
              onChange={(v) => setParam("type", v)}
            />
          </div>
        }
      />

      {departmentIsEmpty ? (
        <div className="mb-4">
          <Notice tone="warning">{t("admin.analytics.lv.departmentEmpty")}</Notice>
        </div>
      ) : null}

      {/* Four counts over the same predicate the grid below uses. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile
          label={t("admin.analytics.lv.tile.records")}
          hint={t("admin.analytics.lv.tile.recordsHint")}
          to={balancesRoute}
          drillLabel={t("admin.analytics.lv.tile.recordsDrill")}
          source={t("admin.analytics.lv.source.balances")}
          query={sliceCounts.get("all") ?? { data: undefined, error: null, isPending: true }}
        />
        <CountTile
          label={t("admin.analytics.lv.tile.consumed")}
          hint={t("admin.analytics.lv.tile.consumedHint")}
          to={balancesRoute}
          drillLabel={t("admin.analytics.lv.tile.consumedDrill")}
          source={t("admin.analytics.lv.source.balances")}
          query={sliceCounts.get("consumed") ?? { data: undefined, error: null, isPending: true }}
        />
        <CountTile
          label={t("admin.analytics.lv.tile.exhausted")}
          hint={t("admin.analytics.lv.tile.exhaustedHint")}
          to={balancesRoute}
          drillLabel={t("admin.analytics.lv.tile.exhaustedDrill")}
          source={t("admin.analytics.lv.source.balances")}
          query={sliceCounts.get("exhausted") ?? { data: undefined, error: null, isPending: true }}
        />
        <CountTile
          label={t("admin.analytics.lv.tile.expiring")}
          hint={t("admin.analytics.lv.tile.expiringHint")}
          to="/admin/leave/comp-off"
          drillLabel={t("admin.analytics.lv.tile.expiringDrill")}
          source={t("admin.analytics.lv.source.balances")}
          query={sliceCounts.get("expiring") ?? { data: undefined, error: null, isPending: true }}
        />
      </div>

      {/* Consumption BY TYPE — counted in employees, never in days. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.analytics.lv.byType.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.lv.byType.hint")}</p>
        <StateBoundary
          loading={types.isPending}
          error={types.error}
          onRetry={() => void types.refetch()}
          isEmpty={typeRows.length === 0}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.analytics.lv.byType.empty.title")}
              hint={t("admin.analytics.lv.byType.empty.hint")}
            />
          }
        >
          <figure className="mt-3 m-0 rounded-lg border bg-card p-4">
            <div className="overflow-x-auto">
              <div className="h-64 min-w-[420px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={consumerBars}
                    layout="vertical"
                    margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
                    accessibilityLayer
                  >
                    <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
                    <XAxis
                      type="number"
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      stroke={GRID_STROKE}
                      tickLine={false}
                      className="fill-muted-foreground"
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={140}
                      tick={{ fontSize: 12 }}
                      stroke={GRID_STROKE}
                      tickLine={false}
                      className="fill-muted-foreground"
                    />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted))" }}
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.375rem",
                        fontSize: "0.875rem",
                      }}
                    />
                    <Bar
                      dataKey="consumers"
                      name={t("admin.analytics.lv.col.consumers")}
                      fill={CONSUMER_FILL}
                      radius={[0, 4, 4, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              {t("admin.analytics.lv.byType.caption")}
            </figcaption>
          </figure>
          <div className="mt-3">
            <DataGrid columns={typeColumns} rows={typeRows} rowKey={(row) => row.key} pageSize={25} />
          </div>
        </StateBoundary>
      </section>

      {/* Ledger movement counts + the department gap, side by side. */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {leaveYear.data == null
              ? t("admin.analytics.lv.ledger.titleNoYear")
              : t("admin.analytics.lv.ledger.title", { year: String(leaveYear.data) })}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.lv.ledger.hint")}</p>
          <div className="mt-3">
            <StateBoundary
              loading={leaveYear.isPending}
              error={leaveYear.error}
              onRetry={() => void leaveYear.refetch()}
              isEmpty={kindRows.length === 0}
              empty={
                <EmptyState
                  icon={Scale}
                  title={t("admin.analytics.lv.ledger.empty.title")}
                  hint={t("admin.analytics.lv.ledger.empty.hint")}
                />
              }
            >
              <DataGrid columns={kindColumns} rows={kindRows} rowKey={(row) => row.key} pageSize={10} />
            </StateBoundary>
          </div>
        </div>

        <div>
          <h2 className="font-display text-lg font-semibold">
            {t("admin.analytics.lv.byDept.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.lv.byDept.hint")}</p>
          <div className="mt-3">
            <EmptyState
              icon={Scale}
              title={t("admin.analytics.lv.byDept.missing.title")}
              hint={t("admin.analytics.lv.byDept.missing.hint")}
            />
          </div>
        </div>
      </section>

      {/* Per employee × type, heaviest consumption first — server-ordered. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.analytics.lv.grid.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.lv.grid.hint")}</p>
        <div className="mt-3">
          <StateBoundary
            loading={consumption.isPending && enabled}
            error={consumption.error}
            onRetry={() => void consumption.refetch()}
            isEmpty={rows.length === 0}
            partialError={labels.error}
            partialLabel={t("admin.analytics.lv.grid.namesLabel")}
            empty={
              <EmptyState
                icon={CalendarDays}
                title={t("admin.analytics.lv.grid.empty.title")}
                hint={t("admin.analytics.lv.grid.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={consumptionColumns}
              rows={rows}
              rowKey={(row) => `${row.employee_id}-${row.leave_type_id}`}
              pageSize={25}
            />
          </StateBoundary>
        </div>
        {rows.length >= ANALYTICS_ROW_CAP ? (
          <div className="mt-3">
            <Notice tone="warning">
              {t("admin.analytics.lv.grid.capped", { n: String(ANALYTICS_ROW_CAP) })}
            </Notice>
          </div>
        ) : null}
      </section>

      <div className="mt-6 space-y-3">
        <Notice tone="info">{t("admin.analytics.lv.footnote.sources")}</Notice>
        <Notice tone="note">{t("admin.analytics.lv.footnote.gaps")}</Notice>
      </div>
    </div>
  );
}
