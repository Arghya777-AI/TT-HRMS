/**
 * §12 · /admin/assets/exit-liability — Exit Liability. What leavers still hold,
 * valued.
 *
 * How the row set is built, and why it is built that way:
 *
 *  1. POSTGRES PICKS THE LEAVERS. `v_admin_employee` is filtered server-side on
 *     `employment_status IN ('on_notice','exited','retired','absconding')`. Their
 *     ids are then passed as an `in` filter to `v_asset_custody`, so the custody
 *     rows are also chosen by the database. Nothing is fetched-then-sifted in the
 *     browser.
 *  2. AN EMPTY LEAVER LIST IS NOT "NO FILTER". `custodyFilters()` drops an empty
 *     `employeeIds` array, which would silently turn this screen into "everything
 *     everyone holds" — the worst possible lie on a liability screen. The custody
 *     read is therefore DISABLED when there are no leavers, and the empty state
 *     says which of the two zeros it is: no leavers at all, or leavers who are
 *     holding nothing.
 *  3. THE VALUE IS THE PURCHASE COST ON RECORD. `assets.purchase_cost_paise` is
 *     integer paise, joined in by id (`useAssetsByIds`) and rendered by `<Money>`.
 *     It is NOT a book value: `asset_categories.depreciation_pct_per_year` exists
 *     but NO view computes depreciation, so this screen refuses to invent one and
 *     labels the column for what it is. Recovery amounts
 *     (`asset_allocations.recovery_amount_paise`) are only ever set when a loss is
 *     recorded, which is a different screen and a different conversation.
 *
 * The one addition on the page is the explicitly-labelled SUM OF THE ROWS BELOW —
 * a total of exactly the rows rendered, which is why it says so on the tile.
 *
 * @route /admin/assets/exit-liability
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { UserMinus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Money } from "@/shared/ui/Money";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import {
  ALLOCATION_STATUS_CHIP,
  LEAVER_STATUSES,
  useAssetsByIds,
  useCustodyCountForEmployees,
  useCustodyForEmployees,
  useLeaverCount,
  useLeavers,
  type LeaverStatus,
} from "../hooks/useAssetsAdmin";
import { EMPLOYMENT_STATUS_LABELS } from "../api/employees.api";
import type { CustodyRow } from "../api/assets.api";

const LEAVER_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "danger" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
};

function isLeaverStatus(v: string | null): v is LeaverStatus {
  return v !== null && (LEAVER_STATUSES as readonly string[]).includes(v);
}

export default function AssetExitLiabilityPage() {
  const [params, setParams] = useSearchParams();
  const statusParam = params.get("status");
  const onlyStatus = isLeaverStatus(statusParam) ? statusParam : null;

  const statuses = useMemo<readonly LeaverStatus[]>(
    () => (onlyStatus !== null ? [onlyStatus] : LEAVER_STATUSES),
    [onlyStatus],
  );

  const leavers = useLeavers(statuses);
  // Counted by Postgres over the same predicate, NOT `leavers.data.length` —
  // that read is capped at 500 rows, so its length would be the cap, not the total.
  const leaverCount = useLeaverCount(statuses);
  const leaverIds = useMemo(() => (leavers.data ?? []).map((row) => row.id), [leavers.data]);

  const custody = useCustodyForEmployees(leaverIds);
  const heldCount = useCustodyCountForEmployees(leaverIds);
  // Memoised because the cost lookup and the row sum both key off this array.
  const rows = useMemo<readonly CustodyRow[]>(
    () => (leaverIds.length === 0 ? [] : (custody.data ?? [])),
    [leaverIds, custody.data],
  );

  // Cost lookup for exactly the assets in the rows above — a join by id.
  const assetIds = useMemo(() => rows.map((row) => row.asset_id), [rows]);
  const assets = useAssetsByIds(assetIds);
  const costByAsset = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const asset of assets.data ?? []) map.set(asset.id, asset.purchase_cost_paise);
    return map;
  }, [assets.data]);

  const statusByEmployee = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of leavers.data ?? []) map.set(row.id, row.employment_status);
    return map;
  }, [leavers.data]);

  /**
   * The SUM OF THE ROWS BELOW — the only arithmetic on this screen, allowed
   * because the tile says exactly that and adds up precisely the rendered rows.
   * Rows whose asset has no purchase cost on record contribute nothing and are
   * counted separately, so the figure is never quietly short.
   */
  const { rowsWithCost, sumPaise } = useMemo(() => {
    let sum = 0;
    let withCost = 0;
    for (const row of rows) {
      const paise = costByAsset.get(row.asset_id) ?? null;
      if (paise !== null) {
        sum += paise;
        withCost += 1;
      }
    }
    return { rowsWithCost: withCost, sumPaise: sum };
  }, [rows, costByAsset]);

  const columns: DataGridColumn<CustodyRow>[] = [
    {
      key: "display_name",
      header: t("admin.assets.exit.col.leaver"),
      width: "15rem",
      sortable: true,
      render: (row) => (
        <PersonCell
          name={row.display_name}
          code={row.employee_code}
          secondary={row.department_name}
        />
      ),
    },
    {
      key: "employment_status",
      header: t("admin.assets.exit.col.lifecycle"),
      width: "10rem",
      render: (row) => {
        const status = statusByEmployee.get(row.employee_id);
        return status === undefined ? (
          dash(null)
        ) : (
          <StatusChip status={status} map={LEAVER_CHIP} />
        );
      },
    },
    {
      key: "asset_tag",
      header: t("admin.assets.alloc.col.asset"),
      width: "14rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num font-medium">{row.asset_tag}</span>
          <span className="text-xs text-muted-foreground">{row.asset_name}</span>
        </span>
      ),
    },
    {
      key: "asset_category_name",
      header: t("admin.assets.col.category"),
      hideBelow: "lg",
      render: (row) => dash(row.asset_category_name),
    },
    {
      key: "status",
      header: t("admin.assets.alloc.col.state"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.status} map={ALLOCATION_STATUS_CHIP} />,
    },
    {
      key: "allocated_at",
      header: t("admin.assets.alloc.col.since"),
      width: "12rem",
      align: "right",
      hideBelow: "md",
      render: (row) => (
        <span className="num">
          {row.allocated_at === null ? "—" : fmtDateTime(row.allocated_at)}
        </span>
      ),
    },
    {
      key: "days_in_custody",
      header: t("admin.assets.alloc.col.days"),
      width: "7rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{dash(row.days_in_custody, formatNumber)}</span>,
    },
    {
      key: "expected_return_date",
      header: t("admin.assets.returns.col.due"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        row.expected_return_date === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.assets.alloc.openEnded")}
          </span>
        ) : (
          <span className="num">{fmtCivilDate(row.expected_return_date)}</span>
        ),
    },
    {
      key: "value",
      header: t("admin.assets.exit.col.value"),
      width: "10rem",
      align: "right",
      render: (row) => <Money paise={costByAsset.get(row.asset_id) ?? null} />,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserMinus}
        title={t("admin.assets.exit.title")}
        subtitle={
          heldCount.isSuccess
            ? t("admin.assets.exit.subtitle", { n: formatNumber(heldCount.data) })
            : t("admin.assets.exit.subtitlePlain")
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("admin.assets.exit.tile.leavers")}</p>
          <p className="num mt-1 font-display text-2xl font-semibold">
            {leaverCount.isPending
              ? "…"
              : leaverCount.error !== null
                ? "—"
                : formatNumber(leaverCount.data)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.assets.exit.tile.leaversHint")}
          </p>
        </div>
        <div className="rounded-lg border border-warning/50 bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("admin.assets.exit.tile.held")}</p>
          <p className="num mt-1 font-display text-2xl font-semibold">
            {leaverIds.length === 0
              ? formatNumber(0)
              : heldCount.isPending
                ? "…"
                : heldCount.error !== null
                  ? "—"
                  : formatNumber(heldCount.data)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.assets.exit.tile.heldHint")}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("admin.assets.exit.tile.value")}</p>
          <p className="num mt-1 font-display text-2xl font-semibold">
            {assets.isPending && assetIds.length > 0 ? (
              "…"
            ) : assets.error !== null ? (
              "—"
            ) : (
              <Money paise={sumPaise} />
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.assets.exit.tile.valueHint", {
              priced: formatNumber(rowsWithCost),
              rows: formatNumber(rows.length),
            })}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.assets.exit.filter.status")}
          value={onlyStatus ?? ""}
          placeholder={t("admin.assets.exit.filter.anyStatus")}
          options={LEAVER_STATUSES.map((s) => ({
            value: s,
            label: EMPLOYMENT_STATUS_LABELS[s],
          }))}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === "") next.delete("status");
            else next.set("status", v);
            setParams(next, { replace: true });
          }}
          hint={t("admin.assets.exit.filter.statusHint")}
        />
        <div className="flex items-end">
          {onlyStatus !== null ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.assets.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={leavers.isPending || (leaverIds.length > 0 && custody.isPending)}
          error={leavers.error ?? custody.error}
          onRetry={() => {
            void leavers.refetch();
            void custody.refetch();
          }}
          isEmpty={rows.length === 0}
          partialError={assets.error}
          partialLabel={t("admin.assets.exit.partial.value")}
          empty={
            leaverIds.length === 0 ? (
              <EmptyState
                icon={UserMinus}
                title={t("admin.assets.exit.empty.noLeavers.title")}
                hint={t("admin.assets.exit.empty.noLeavers.hint")}
              />
            ) : (
              <EmptyState
                icon={Wallet}
                title={t("admin.assets.exit.empty.clear.title")}
                hint={t("admin.assets.exit.empty.clear.hint")}
              />
            )
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.allocation_id}
            pageSize={25}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.assets.exit.footnote")}</Notice>
      </div>
    </div>
  );
}
