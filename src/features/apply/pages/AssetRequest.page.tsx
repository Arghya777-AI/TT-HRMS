/**
 * E-10.4 · /me/apply/asset — "Ask Stores for equipment or a uniform item."
 *
 * The brief for this screen was to raise the request through
 * `public.create_approval_request` with the `ASSET_REQUEST` type. The recon says
 * that call cannot succeed today, for THREE independent reasons, each of which is
 * a fact about the deployed schema rather than an opinion:
 *
 *  1. NO APPROVAL CHAIN. 046 §3 seeds chains for 11 of the 18 request types and
 *     `ASSET_REQUEST` is not one of them, so `request_types
 *     .default_approval_chain_id` stays NULL and `create_approval_request`
 *     RAISES `no approval chain matches request type ASSET_REQUEST`. The routing
 *     card below reads `approval_chains` for this type and shows the empty
 *     result — that is the proof, not a claim.
 *  2. NO DETAIL ROW TO POINT AT. The type's `detail_table` is
 *     `asset_allocations`, whose `asset_id` is NOT NULL — a request must name a
 *     specific asset UNIT. `assets__self__select` (028 §3b) lets an employee read
 *     an asset only when an allocation already ties it to them, so there is no
 *     catalogue to pick from and no honest way to fill that column.
 *  3. NO SERVER-MINTED REFERENCE. `asset_allocations.allocation_number` is NOT
 *     NULL and UNIQUE with no generating trigger anywhere in the migrations
 *     (contrast `reimbursement_claims`, which has `generate_claim_number()`).
 *     Minting one in the browser is exactly the thing this codebase forbids, so
 *     this screen does not offer an insert at all.
 *
 * What it shows instead is real and self-scoped: the categories Stores actually
 * stocks (`asset_categories`, readable by every employee), and every allocation
 * already raised for me that has not been handed over yet.
 *
 * @route /me/apply/asset
 */
import { Link } from "react-router-dom";
import { LifeBuoy, Package, PackageSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { REQUEST_CODE_ASSET } from "../api/apply-requests.api";
import type { AssetCategoryRef } from "../api/apply-requests.api";
import type { PipelineAllocation } from "@/features/assets/api/my-assets.api";
import {
  useAssetCategories,
  useMyOpenRequestsOfType,
  useMyPipelineAllocations,
  useRequestRouting,
  useRequestTypeByCode,
} from "../hooks/useApply";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";
import { RequestRoutingCard } from "../components/RequestRoutingCard";

/** `asset_allocation_status`, in the two states that mean "not yours yet". */
const PIPELINE_STATUS_MAP: Record<string, StatusChipEntry> = {
  requested: { label: t("assets.status.requested"), tone: "warn" },
  approved: { label: t("assets.status.approved"), tone: "info" },
};

function CategoryCard({ category }: { category: AssetCategoryRef }) {
  return (
    <li className="rounded-lg border bg-card p-3">
      <p className="font-medium leading-snug">{category.name}</p>
      <p className="mt-0.5 font-mono text-xs text-muted-foreground">{category.code}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {category.is_consumable ? (
          <li>
            <Badge variant="neutral">{t("apply.asset.cat.consumable")}</Badge>
          </li>
        ) : null}
        {category.default_return_required ? (
          <li>
            <Badge variant="warning">{t("apply.asset.cat.returnable")}</Badge>
          </li>
        ) : null}
        {category.requires_acknowledgement ? (
          <li>
            <Badge variant="info">{t("apply.asset.cat.ackRequired")}</Badge>
          </li>
        ) : null}
      </ul>
    </li>
  );
}

export default function AssetRequestPage() {
  const type = useRequestTypeByCode(REQUEST_CODE_ASSET);
  const routing = useRequestRouting(type.data?.id);
  const categories = useAssetCategories();
  const pipeline = useMyPipelineAllocations();
  const open = useMyOpenRequestsOfType(type.data?.id);

  const pipelineColumns: DataGridColumn<PipelineAllocation>[] = [
    {
      key: "allocation_number",
      header: t("apply.asset.col.ref"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.allocation_number}</span>,
    },
    {
      key: "asset",
      header: t("apply.asset.col.item"),
      render: (row) => (row.assets === null ? dash(null) : row.assets.name),
    },
    {
      key: "asset_tag",
      header: t("apply.asset.col.tag"),
      width: "9rem",
      hideBelow: "md",
      render: (row) =>
        row.assets === null ? dash(null) : <span className="font-mono text-xs">{row.assets.asset_tag}</span>,
    },
    {
      key: "quantity",
      header: t("apply.asset.col.qty"),
      align: "right",
      width: "6rem",
      render: (row) => formatNumber(row.quantity),
    },
    {
      key: "status",
      header: t("apply.asset.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={PIPELINE_STATUS_MAP} />,
    },
    {
      key: "requested_at",
      header: t("apply.asset.col.raised"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => (row.requested_at === null ? dash(null) : fmtDateTime(row.requested_at)),
    },
    {
      key: "expected_return_date",
      header: t("apply.asset.col.due"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.expected_return_date),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={Package}
        title={t("apply.asset.title")}
        subtitle={t("apply.asset.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply">{t("apply.back")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        <Notice tone="error">
          <p className="font-medium">{t("apply.asset.gap.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("apply.asset.gap.chain")}</li>
            <li>{t("apply.asset.gap.catalogue")}</li>
            <li>{t("apply.asset.gap.number")}</li>
          </ul>
        </Notice>

        <EmptyState
          icon={LifeBuoy}
          title={t("apply.asset.alt.title")}
          hint={t("apply.asset.alt.hint")}
          action={
            <Button asChild>
              <Link to="/me/helpdesk">{t("apply.asset.alt.cta")}</Link>
            </Button>
          }
        />

        {/* ── What Stores stocks ──────────────────────────────────────────── */}
        <section aria-labelledby="asset-categories">
          <h2 id="asset-categories" className="font-display text-lg font-semibold">
            {t("apply.asset.cats.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.asset.cats.hint")}</p>
          <StateBoundary
            loading={categories.isLoading}
            error={categories.error ?? undefined}
            onRetry={() => void categories.refetch()}
            isEmpty={categories.data !== undefined && categories.data.length === 0}
            empty={
              <EmptyState
                icon={PackageSearch}
                title={t("apply.asset.cats.empty.title")}
                hint={t("apply.asset.cats.empty.hint")}
              />
            }
            skeletonRows={2}
          >
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(categories.data ?? []).map((category) => (
                <CategoryCard key={category.id} category={category} />
              ))}
            </ul>
          </StateBoundary>
        </section>

        {/* ── The routing that would decide it ───────────────────────────── */}
        <section aria-labelledby="asset-routing">
          <h2 id="asset-routing" className="mb-3 font-display text-lg font-semibold">
            {t("apply.routing.section")}
          </h2>
          <StateBoundary
            loading={type.isLoading || routing.isLoading}
            error={type.error ?? routing.error ?? undefined}
            onRetry={() => {
              void type.refetch();
              void routing.refetch();
            }}
            skeletonRows={2}
          >
            {type.data === null ? (
              <Notice tone="warning">{t("apply.type.missing")}</Notice>
            ) : (
              <div className="space-y-3">
                {type.data !== undefined ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="neutral">{type.data.name}</Badge>
                    <span>{t("apply.tile.sla", { hours: type.data.sla_hours })}</span>
                    <span>{t("apply.type.detailTable", { table: type.data.detail_table })}</span>
                  </div>
                ) : null}
                <RequestRoutingCard
                  routing={routing.data}
                  missingChainMessage={t("apply.asset.gap.chain")}
                />
              </div>
            )}
          </StateBoundary>
        </section>

        {/* ── Already raised for me by Stores ────────────────────────────── */}
        <section aria-labelledby="asset-pipeline">
          <h2 id="asset-pipeline" className="font-display text-lg font-semibold">
            {t("apply.asset.pipeline.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.asset.pipeline.hint")}</p>
          <StateBoundary
            loading={pipeline.isLoading}
            error={pipeline.error ?? undefined}
            onRetry={() => void pipeline.refetch()}
          >
            <DataGrid
              columns={pipelineColumns}
              rows={pipeline.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={Package}
                  title={t("apply.asset.pipeline.empty.title")}
                  hint={t("apply.asset.pipeline.empty.hint")}
                />
              }
            />
          </StateBoundary>
        </section>

        <section aria-labelledby="asset-open">
          <h2 id="asset-open" className="mb-3 font-display text-lg font-semibold">
            {t("apply.mine.title")}
          </h2>
          <StateBoundary
            loading={open.isLoading}
            error={open.error ?? undefined}
            onRetry={() => void open.refetch()}
          >
            <OpenRequestsGrid
              rows={open.data?.rows ?? []}
              approvers={open.data?.approvers ?? {}}
              emptyTitle={t("apply.asset.mine.empty.title")}
              emptyHint={t("apply.asset.mine.empty.hint")}
            />
          </StateBoundary>
        </section>
      </div>
    </div>
  );
}
