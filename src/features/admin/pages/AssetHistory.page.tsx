/**
 * §12 · /admin/assets/history — Asset History. The full custody trail for an
 * asset.
 *
 * This screen reads TWO relations on purpose, because they are two different
 * kinds of truth and only one of them is populated on this deployment:
 *
 *  1. `asset_allocations` — every allocation ever made against the chosen asset,
 *     in every state (returned, recalled, lost, written off, not just the open
 *     ones `v_asset_custody` shows). This is the custody LEDGER, and it is what
 *     the venue actually has: each row carries who held it, from when, whether
 *     they acknowledged it, when it came back and in what condition.
 *  2. `asset_history` — the append-only EVENT trail (handed_over, acknowledged,
 *     transferred, returned, recalled, repaired, written_off …). It is read here
 *     and it is expected to be EMPTY: migration 028 §4 grants INSERT to
 *     `service_role` only ("written by the allocation RPCs / edge functions,
 *     never by clients") and REVOKEs it from `authenticated`, and no such RPC or
 *     edge function is deployed. The screen states that in the empty state rather
 *     than reconstructing an event log out of the allocation columns — a
 *     fabricated audit trail is worse than an honest gap.
 *
 * The asset is chosen in the URL (`?asset=<id>`), so a trail is linkable from the
 * register and from a returns row.
 *
 * @route /admin/assets/history
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { History, ScrollText } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { Money } from "@/shared/ui/Money";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, type SelectOption } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  ALLOCATION_STATUS_CHIP,
  ASSET_STATUS_CHIP,
  CONDITION_LABELS,
  useAssetAllocations,
  useAssetCategoryMap,
  useAssetCategories,
  useAssetHistoryTrail,
  useAssets,
} from "../hooks/useAssetsAdmin";
import {
  assetConditionValues,
  type Allocation,
  type AssetCondition,
  type AssetFilters,
  type AssetHistoryRow,
} from "../api/assets.api";

/** The whole register, so any asset's trail is one click away. */
const ALL_ASSETS: AssetFilters = {};

function isCondition(value: string): value is AssetCondition {
  return (assetConditionValues as readonly string[]).includes(value);
}

/** `return_condition` / `condition_after` are free text columns with a CHECK. */
function conditionLabel(value: string | null): string {
  if (value === null) return dash(null);
  return isCondition(value) ? CONDITION_LABELS[value] : value;
}

export default function AssetHistoryPage() {
  const [params, setParams] = useSearchParams();
  const assetId = params.get("asset") ?? "";

  const assets = useAssets(ALL_ASSETS);
  const categories = useAssetCategories();
  const categoryMap = useAssetCategoryMap(categories.data);
  const labels = useEmployeeLabels();

  const chosen = useMemo(
    () => (assets.data ?? []).find((row) => row.id === assetId) ?? null,
    [assets.data, assetId],
  );

  const allocations = useAssetAllocations(assetId === "" ? null : assetId);
  const trail = useAssetHistoryTrail(assetId === "" ? null : assetId);

  const assetOptions: SelectOption[] = (assets.data ?? []).map((row) => ({
    value: row.id,
    label: t("admin.assets.alloc.assetOption", { tag: row.asset_tag, name: row.name }),
  }));

  const personOf = (employeeId: string | null): string => {
    if (employeeId === null) return dash(null);
    const label = labels.data?.get(employeeId);
    return label === undefined ? dash(null) : `${label.name} · ${label.code}`;
  };

  const allocationColumns: DataGridColumn<Allocation>[] = [
    {
      key: "allocation_number",
      header: t("admin.assets.history.col.allocation"),
      width: "12rem",
      sortable: true,
      render: (row) => <span className="num font-medium">{row.allocation_number}</span>,
    },
    {
      key: "employee_id",
      header: t("admin.assets.history.col.holder"),
      width: "14rem",
      render: (row) => personOf(row.employee_id),
    },
    {
      key: "status",
      header: t("admin.assets.alloc.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={ALLOCATION_STATUS_CHIP} />,
    },
    {
      key: "quantity",
      header: t("admin.assets.col.quantity"),
      width: "6rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.quantity)}</span>,
    },
    {
      key: "allocated_at",
      header: t("admin.assets.history.col.issued"),
      width: "12rem",
      align: "right",
      sortable: true,
      render: (row) => (
        <span className="num">
          {row.allocated_at === null ? "—" : fmtDateTime(row.allocated_at)}
        </span>
      ),
    },
    {
      key: "acknowledged_at",
      header: t("admin.assets.history.col.acknowledged"),
      width: "12rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => (
        <span className="num">
          {row.acknowledged_at === null ? "—" : fmtDateTime(row.acknowledged_at)}
        </span>
      ),
    },
    {
      key: "expected_return_date",
      header: t("admin.assets.returns.col.due"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{fmtCivilDate(row.expected_return_date)}</span>,
    },
    {
      key: "returned_at",
      header: t("admin.assets.history.col.returned"),
      width: "12rem",
      align: "right",
      render: (row) => (
        <span className="num">
          {row.returned_at === null ? "—" : fmtDateTime(row.returned_at)}
        </span>
      ),
    },
    {
      key: "return_condition",
      header: t("admin.assets.history.col.backAs"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => conditionLabel(row.return_condition),
    },
    {
      key: "recovery_amount_paise",
      header: t("admin.assets.history.col.recovery"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.recovery_amount_paise} />,
    },
  ];

  const trailColumns: DataGridColumn<AssetHistoryRow>[] = [
    {
      key: "recorded_at",
      header: t("admin.assets.history.col.when"),
      width: "13rem",
      render: (row) => <span className="num">{fmtDateTime(row.recorded_at)}</span>,
    },
    {
      key: "event",
      header: t("admin.assets.history.col.event"),
      width: "12rem",
      render: (row) => <StatusChip status={row.event} />,
    },
    {
      key: "employee_id",
      header: t("admin.assets.history.col.holder"),
      render: (row) => personOf(row.employee_id),
    },
    {
      key: "from_employee_id",
      header: t("admin.assets.history.col.from"),
      hideBelow: "lg",
      render: (row) => personOf(row.from_employee_id),
    },
    {
      key: "to_employee_id",
      header: t("admin.assets.history.col.to"),
      hideBelow: "lg",
      render: (row) => personOf(row.to_employee_id),
    },
    {
      key: "condition_after",
      header: t("admin.assets.history.col.backAs"),
      hideBelow: "md",
      render: (row) => conditionLabel(row.condition_after),
    },
    {
      key: "notes",
      header: t("admin.assets.history.col.notes"),
      hideBelow: "lg",
      render: (row) => dash(row.notes),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={History}
        title={t("admin.assets.history.title")}
        subtitle={
          chosen === null
            ? t("admin.assets.history.subtitlePlain")
            : t("admin.assets.history.subtitle", { tag: chosen.asset_tag, name: chosen.name })
        }
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <SelectField
          label={t("admin.assets.history.filter.asset")}
          value={assetId}
          placeholder={
            assetOptions.length === 0
              ? t("admin.assets.history.filter.noAssets")
              : t("admin.assets.history.filter.pick")
          }
          options={assetOptions}
          disabled={assetOptions.length === 0}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === "") next.delete("asset");
            else next.set("asset", v);
            setParams(next, { replace: true });
          }}
          hint={t("admin.assets.history.filter.assetHint")}
        />
      </div>

      {chosen !== null ? (
        <dl className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs text-muted-foreground">{t("admin.assets.col.category")}</dt>
            <dd className="text-sm">
              {dash(categoryMap.get(chosen.asset_category_id)?.name ?? null)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("admin.assets.col.serial")}</dt>
            <dd className="num text-sm">{dash(chosen.serial_number)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("admin.assets.col.status")}</dt>
            <dd className="text-sm">
              <StatusChip status={chosen.status} map={ASSET_STATUS_CHIP} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("admin.assets.col.condition")}</dt>
            <dd className="text-sm">{CONDITION_LABELS[chosen.condition]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("admin.assets.col.cost")}</dt>
            <dd className="text-sm">
              <Money paise={chosen.purchase_cost_paise} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t("admin.assets.history.custodian")}
            </dt>
            <dd className="text-sm">{personOf(chosen.custodian_employee_id)}</dd>
          </div>
        </dl>
      ) : null}

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.assets.history.ledger.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.assets.history.ledger.hint")}
        </p>
        <div className="mt-3">
          {assetId === "" ? (
            <EmptyState
              icon={History}
              title={t("admin.assets.history.pick.title")}
              hint={t("admin.assets.history.pick.hint")}
            />
          ) : (
            <StateBoundary
              loading={allocations.isPending}
              error={allocations.error}
              onRetry={() => void allocations.refetch()}
              isEmpty={(allocations.data ?? []).length === 0}
              partialError={labels.error}
              partialLabel={t("admin.assets.history.partial.names")}
              empty={
                <EmptyState
                  icon={History}
                  title={t("admin.assets.history.ledger.empty.title")}
                  hint={t("admin.assets.history.ledger.empty.hint")}
                />
              }
            >
              <DataGrid
                columns={allocationColumns}
                rows={allocations.data ?? []}
                rowKey={(row) => row.id}
                pageSize={25}
              />
            </StateBoundary>
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.assets.history.trail.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.assets.history.trail.hint")}</p>
        <div className="mt-3">
          {assetId === "" ? (
            <EmptyState
              icon={ScrollText}
              title={t("admin.assets.history.pick.title")}
              hint={t("admin.assets.history.pick.hint")}
            />
          ) : (
            <StateBoundary
              loading={trail.isPending}
              error={trail.error}
              onRetry={() => void trail.refetch()}
              isEmpty={(trail.data ?? []).length === 0}
              empty={
                <EmptyState
                  icon={ScrollText}
                  title={t("admin.assets.history.trail.empty.title")}
                  hint={t("admin.assets.history.trail.empty.hint")}
                />
              }
            >
              <DataGrid
                columns={trailColumns}
                rows={trail.data ?? []}
                rowKey={(row) => row.id}
                pageSize={25}
              />
            </StateBoundary>
          )}
        </div>
      </section>

      <div className="mt-6">
        <Notice tone="warning">{t("admin.assets.history.footnote")}</Notice>
      </div>
    </div>
  );
}
