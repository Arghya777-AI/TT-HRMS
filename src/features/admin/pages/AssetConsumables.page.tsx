/**
 * §12 · /admin/assets/consumables — Consumable Stock. Uniforms and consumables,
 * with reissue rules.
 *
 * RECON FIRST, and it came back HALF MODELLED. What exists in migration 028 + the
 * 046 seed:
 *
 *  * `asset_categories.is_consumable` — the flag that separates a uniform set
 *     from a walkie-talkie. Four of the fifteen venue categories carry it
 *     (Uniforms, Safety Shoes, PPE, and any other the venue marks).
 *  * `asset_categories.default_return_required` / `requires_acknowledgement` /
 *     `requires_serial` — THE REISSUE RULES this screen is asked for, straight
 *     from the master.
 *  * `assets.quantity`, `assets.unit`, `assets.reorder_level` — a stock line's
 *     size, its unit (each / pair / set / litre) and the level the venue wants to
 *     reorder at.
 *
 * What does NOT exist, and is therefore NOT shown:
 *
 *  * No stock-movement ledger and no "on hand" view. `assets.quantity` is the
 *     quantity as RECORDED; nothing server-side decrements it when a consumable
 *     is issued, and `asset_allocations.quantity` is not aggregated back by any
 *     view. So this screen never prints a "remaining" figure — it prints the two
 *     columns Postgres holds and says which one is missing.
 *  * No reorder-breach flag. Comparing `quantity` to `reorder_level` needs a
 *     column-to-column comparison, which PostgREST cannot filter on and which
 *     this client will not fake by fetching everything and sifting. Both numbers
 *     sit side by side so a human can see it; no red badge pretends the database
 *     decided.
 *  * No consumable issue/replacement history distinct from `asset_allocations`.
 *
 * Every count here is still a server `count=exact` over `assets` filtered to the
 * consumable category ids.
 *
 * @route /admin/assets/consumables
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Shirt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { Money } from "@/shared/ui/Money";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/Field";
import {
  ASSET_STATUS_CHIP,
  CONDITION_LABELS,
  useAssetCategories,
  useAssetCount,
  useAssets,
} from "../hooks/useAssetsAdmin";
import type { Asset, AssetCategory, AssetFilters } from "../api/assets.api";

const YES_NO_CHIP = {
  yes: { label: t("admin.assets.consum.yes"), tone: "success" as const },
  no: { label: t("admin.assets.consum.no"), tone: "neutral" as const },
};

export default function AssetConsumablesPage() {
  const [params, setParams] = useSearchParams();
  const categoryId = params.get("category") ?? "";

  const categories = useAssetCategories();

  const consumableCategories = useMemo<readonly AssetCategory[]>(
    () => (categories.data ?? []).filter((c) => c.is_consumable),
    [categories.data],
  );

  /**
   * The consumable category ids, as an `in` filter. When the chosen category is
   * one of them, the filter narrows to that single id — the grid and every tile
   * keep sharing one predicate.
   */
  const categoryIds = useMemo<readonly string[]>(() => {
    const all = consumableCategories.map((c) => c.id);
    if (categoryId !== "" && all.includes(categoryId)) return [categoryId];
    return all;
  }, [consumableCategories, categoryId]);

  const filters = useMemo<AssetFilters>(
    () => (categoryIds.length === 0 ? {} : { categoryIds }),
    [categoryIds],
  );

  // Never read the whole register as if it were consumable stock: until the
  // category list resolves there is no honest predicate, so nothing is fetched.
  const hasPredicate = categoryIds.length > 0;
  const lines = useAssets(filters, hasPredicate);
  const lineCount = useAssetCount(filters, hasPredicate);
  const inStockCount = useAssetCount({ ...filters, statuses: ["in_stock"] }, hasPredicate);
  const issuedCount = useAssetCount({ ...filters, statuses: ["allocated"] }, hasPredicate);

  const rows = hasPredicate ? (lines.data ?? []) : [];
  const categoryNameOf = (id: string): string | null =>
    consumableCategories.find((c) => c.id === id)?.name ?? null;

  const lineColumns: DataGridColumn<Asset>[] = [
    {
      key: "asset_tag",
      header: t("admin.assets.col.tag"),
      width: "10rem",
      sortable: true,
      render: (row) => <span className="num font-medium">{row.asset_tag}</span>,
    },
    {
      key: "name",
      header: t("admin.assets.col.name"),
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span>{row.name}</span>
          <span className="text-xs text-muted-foreground">
            {dash(categoryNameOf(row.asset_category_id))}
          </span>
        </span>
      ),
    },
    {
      key: "quantity",
      header: t("admin.assets.consum.col.recorded"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (row) => (
        <span className="num">
          {t("admin.assets.qtyUnit", { qty: formatNumber(row.quantity), unit: row.unit })}
        </span>
      ),
    },
    {
      key: "reorder_level",
      header: t("admin.assets.consum.col.reorder"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (row) =>
        row.reorder_level === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.assets.consum.noReorder")}
          </span>
        ) : (
          <span className="num">{formatNumber(row.reorder_level)}</span>
        ),
    },
    {
      key: "status",
      header: t("admin.assets.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={ASSET_STATUS_CHIP} />,
    },
    {
      key: "condition",
      header: t("admin.assets.col.condition"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => CONDITION_LABELS[row.condition],
    },
    {
      key: "purchase_cost_paise",
      header: t("admin.assets.consum.col.unitCost"),
      width: "10rem",
      align: "right",
      render: (row) => <Money paise={row.purchase_cost_paise} />,
    },
    {
      key: "purchase_date",
      header: t("admin.assets.col.purchased"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{fmtCivilDate(row.purchase_date)}</span>,
    },
  ];

  const ruleColumns: DataGridColumn<AssetCategory>[] = [
    {
      key: "name",
      header: t("admin.assets.consum.col.category"),
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "default_return_required",
      header: t("admin.assets.consum.col.returnable"),
      width: "12rem",
      render: (row) => (
        <StatusChip status={row.default_return_required ? "yes" : "no"} map={YES_NO_CHIP} />
      ),
    },
    {
      key: "requires_acknowledgement",
      header: t("admin.assets.consum.col.ack"),
      width: "12rem",
      render: (row) => (
        <StatusChip status={row.requires_acknowledgement ? "yes" : "no"} map={YES_NO_CHIP} />
      ),
    },
    {
      key: "requires_serial",
      header: t("admin.assets.consum.col.serial"),
      width: "12rem",
      hideBelow: "md",
      render: (row) => (
        <StatusChip status={row.requires_serial ? "yes" : "no"} map={YES_NO_CHIP} />
      ),
    },
  ];

  const TILES: readonly { label: string; hint: string; query: ReturnType<typeof useAssetCount>; ring: string }[] = [
    {
      label: t("admin.assets.consum.tile.lines"),
      hint: t("admin.assets.consum.tile.linesHint"),
      query: lineCount,
      ring: "border-border",
    },
    {
      label: t("admin.assets.consum.tile.inStock"),
      hint: t("admin.assets.consum.tile.inStockHint"),
      query: inStockCount,
      ring: "border-success/50",
    },
    {
      label: t("admin.assets.consum.tile.issued"),
      hint: t("admin.assets.consum.tile.issuedHint"),
      query: issuedCount,
      ring: "border-info/50",
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Shirt}
        title={t("admin.assets.consum.title")}
        subtitle={
          lineCount.isSuccess && hasPredicate
            ? t("admin.assets.consum.subtitle", { n: formatNumber(lineCount.data) })
            : t("admin.assets.consum.subtitlePlain")
        }
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/assets/master">{t("admin.assets.consum.openRegister")}</Link>
          </Button>
        }
      />

      {/*
        ON HAND AGAINST ISSUED. `assets.status` holds one value per unit, so
        in-stock and allocated are disjoint — but they are two of five states, and
        a consumable that is lost or retired is in neither. The caption names the
        pair rather than letting the bar imply it is the whole register.

        Why it is worth a bar: a consumable line that is 90% issued is one
        somebody needs to reorder, and that is a proportion rather than a count —
        two numbers side by side do not make it obvious.
      */}
      <div className="mt-4">
        <StatusMixCard
          title={t("admin.assets.consum.mix.title")}
          hint={t("admin.assets.consum.mix.hint")}
          format={(v) => formatNumber(v)}
          totalCaption={(n) => t("admin.assets.consum.mix.total", { n: formatNumber(n) })}
          segments={[
            {
              key: "in_stock",
              label: t("admin.assets.consum.tile.inStock"),
              value: inStockCount.data,
              tone: "present",
            },
            {
              key: "issued",
              label: t("admin.assets.consum.tile.issued"),
              value: issuedCount.data,
              tone: "employer",
            },
          ]}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TILES.map((tile) => (
          <div key={tile.label} className={cn("rounded-lg border bg-card p-4", tile.ring)}>
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            <p className="num mt-1 font-display text-2xl font-semibold">
              {!hasPredicate
                ? "—"
                : tile.query.isPending
                  ? "…"
                  : tile.query.error !== null
                    ? "—"
                    : formatNumber(tile.query.data)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{tile.hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.assets.consum.filter.category")}
          value={categoryId}
          placeholder={t("admin.assets.consum.filter.allConsumable")}
          options={consumableCategories.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === "") next.delete("category");
            else next.set("category", v);
            setParams(next, { replace: true });
          }}
          hint={t("admin.assets.consum.filter.categoryHint")}
        />
        <div className="flex items-end">
          {categoryId !== "" ? (
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
        <Notice tone="note">{t("admin.assets.consum.gap")}</Notice>
      </div>

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.assets.consum.stock.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.assets.consum.stock.hint")}</p>
        <div className="mt-3">
          <StateBoundary
            loading={categories.isPending || (hasPredicate && lines.isPending)}
            error={categories.error ?? lines.error}
            onRetry={() => {
              void categories.refetch();
              void lines.refetch();
            }}
            isEmpty={rows.length === 0}
            partialError={lineCount.error}
            partialLabel={t("admin.assets.partial.total")}
            empty={
              consumableCategories.length === 0 ? (
                <EmptyState
                  icon={Shirt}
                  title={t("admin.assets.consum.empty.noCategories.title")}
                  hint={t("admin.assets.consum.empty.noCategories.hint")}
                />
              ) : (
                <EmptyState
                  icon={Shirt}
                  title={t("admin.assets.consum.empty.title")}
                  hint={t("admin.assets.consum.empty.hint")}
                  action={
                    <Button asChild>
                      <Link to="/admin/assets/master">
                        {t("admin.assets.consum.empty.action")}
                      </Link>
                    </Button>
                  }
                />
              )
            }
          >
            <DataGrid columns={lineColumns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
          </StateBoundary>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.assets.consum.rules.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.assets.consum.rules.hint")}</p>
        <div className="mt-3">
          <StateBoundary
            loading={categories.isPending}
            error={categories.error}
            onRetry={() => void categories.refetch()}
            isEmpty={consumableCategories.length === 0}
            empty={
              <EmptyState
                icon={Shirt}
                title={t("admin.assets.consum.empty.noCategories.title")}
                hint={t("admin.assets.consum.empty.noCategories.hint")}
              />
            }
          >
            <DataGrid
              columns={ruleColumns}
              rows={consumableCategories}
              rowKey={(row) => row.id}
              pageSize={25}
            />
          </StateBoundary>
        </div>
      </section>

      <div className="mt-6">
        <Notice tone="info">{t("admin.assets.consum.footnote")}</Notice>
      </div>
    </div>
  );
}
