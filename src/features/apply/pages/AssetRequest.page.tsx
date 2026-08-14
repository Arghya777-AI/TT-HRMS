/**
 * E-10.4 · /me/apply/asset — ask Stores for equipment or a uniform item.
 *
 * ── THREE REASONS THIS SCREEN USED TO REFUSE, AND WHAT BECAME OF THEM ────────
 *
 * For most of its life this page offered no form and listed why. All three
 * reasons were facts about the deployed schema, and all three have now been
 * answered — by migrations, not by lowering the standard:
 *
 *  1. NO APPROVAL CHAIN. ASSET_REQUEST was not among the eleven types 046 seeded
 *     chains for, so `create_approval_request` raised `no approval chain matches
 *     request type ASSET_REQUEST`. Migration 041300 seeded `AC-ASSET`:
 *     reporting manager, then hr_admin. The routing card below still READS
 *     `approval_chains` rather than describing the route in prose — that is what
 *     proves it is there, and what will show it gone if anyone deactivates it.
 *  2. NO DETAIL ROW TO POINT AT. `detail_table` was `asset_allocations`, whose
 *     `asset_id` is NOT NULL — a request had to name a specific UNIT, and
 *     `assets__self__select` only lets an employee read units already allocated
 *     to them. Migration 041400 created `asset_requests`, which names a
 *     CATEGORY, and repointed the type at it. `asset_categories` is readable by
 *     every employee (002800 P7), so the picker below is the real register's own
 *     vocabulary rather than a list invented here.
 *  3. NO SERVER-MINTED REFERENCE. `asset_allocations.allocation_number` is NOT
 *     NULL/UNIQUE with no generating trigger, and minting one in the browser is
 *     what this codebase forbids. Moot now: `asset_requests` has no number
 *     column at all — the reference is the approval request number, which
 *     `create_approval_request` mints server-side.
 *
 * ── WHAT A REQUEST STILL IS NOT ──────────────────────────────────────────────
 *
 * An approved request is not an allocation. Stores answers it by handing over a
 * unit and recording an `asset_allocations` row, and only then does the item
 * appear under /me/assets. The pipeline grid below reads that register, so an
 * approved request with nothing in the grid is exactly the honest state: agreed,
 * not yet issued.
 *
 * @route /me/apply/asset
 */
import { Link } from "react-router-dom";
import { Package, PackageSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { useState } from "react";
import { t } from "@/shared/i18n/en";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Required } from "@/shared/ui/Required";
import { mutationUserMessage } from "@/shared/api/query";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { SubmitAttemptScope, SubmitBlockers, blockerButtonProps, useSubmitAttempt } from "@/shared/ui/SubmitBlockers";
import { nowIstDate } from "@/lib/datetime";
import { ASSET_REQUEST_MAX_QUANTITY } from "../api/simple-requests.api";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { REQUEST_CODE_ASSET } from "../api/apply-requests.api";
import type { AssetCategoryRef } from "../api/apply-requests.api";
import type { PipelineAllocation } from "@/features/assets/api/my-assets.api";
import {
  useAssetCategories,
  useMyCustody,
  useMyOpenRequestsOfType,
  useMyPipelineAllocations,
  useRequestRouting,
  useRequestTypeByCode,
  useSubmitAssetRequest,
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

  const today = nowIstDate();
  const custody = useMyCustody("all");
  const [categoryId, setCategoryId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [isReplacement, setIsReplacement] = useState(false);
  const [replacesId, setReplacesId] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const sendAsset = useSubmitAssetRequest();
  const attempt = useSubmitAttempt();

  const categoryOptions = categories.data ?? [];
  const chosenCategory = categoryOptions.find((c) => c.id === categoryId);
  const custodyOptions = custody.data ?? [];

  /*
    Every one of these mirrors a server rule — ck_asr__reason, ck_asr__quantity,
    ck_asr__replacement_pair, and the needed-by half of trg_asr__check. The
    server is what enforces them; this is only so the refusal arrives before the
    round trip rather than after it.
  */
  const quantityNumber = Number(quantity);
  const assetBlockers: string[] = [];
  if (chosenCategory === undefined) assetBlockers.push(t("apply.asset.blocked.category"));
  if (!Number.isInteger(quantityNumber) || quantityNumber < 1 || quantityNumber > ASSET_REQUEST_MAX_QUANTITY) {
    assetBlockers.push(t("apply.asset.blocked.quantity", { max: String(ASSET_REQUEST_MAX_QUANTITY) }));
  }
  if (reason.trim().length < 10) assetBlockers.push(t("apply.asset.blocked.reason"));
  if (neededBy !== "" && neededBy < today) assetBlockers.push(t("apply.asset.blocked.date"));
  if (isReplacement && custodyOptions.length > 0 && replacesId === "") {
    assetBlockers.push(t("apply.asset.blocked.replaces"));
  }

  return (
    <SubmitAttemptScope attempt={attempt}>
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
        {sent !== null ? <Notice tone="success">{t("apply.asset.done")}</Notice> : null}

        <section className="rounded-lg border bg-card p-4" aria-labelledby="asset-form">
          <h2 id="asset-form" className="font-display text-lg font-semibold">
            {t("apply.asset.form.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("apply.asset.form.hint")}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="ar-cat">{t("apply.asset.field.category")}<Required /></Label>
              <select
        required
                id="ar-cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                disabled={categoryOptions.length === 0}
                className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <option value="">{t("apply.asset.field.category.none")}</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ar-qty">{t("apply.asset.field.quantity")}<Required /></Label>
              <Input
        required
                id="ar-qty"
                type="number"
                min={1}
                max={ASSET_REQUEST_MAX_QUANTITY}
                step={1}
                className="mt-1.5 h-11"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="ar-by">{t("apply.asset.field.neededBy")}</Label>
              <Input
                id="ar-by"
                type="date"
                min={today}
                className="mt-1.5 h-11"
                value={neededBy}
                onChange={(e) => setNeededBy(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t("apply.asset.field.neededBy.hint")}</p>
            </div>
          </div>

          <div className="mt-3">
            <Label htmlFor="ar-reason">{t("apply.asset.field.reason")}<Required /></Label>
            <textarea
        required
              id="ar-reason"
              rows={3}
              maxLength={1000}
              className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("form.needTen")}</p>
          </div>

          {/*
            The replacement pair. `ck_asr__replacement_pair` refuses a unit id
            without the flag, and `trg_asr__check` refuses a unit that is not in
            this person's custody — so the picker offers exactly what
            v_asset_custody returns for them and nothing else.
          */}
          <div className="mt-3 rounded-md border bg-muted/30 p-3">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-input"
                checked={isReplacement}
                onChange={(e) => {
                  setIsReplacement(e.target.checked);
                  if (!e.target.checked) setReplacesId("");
                }}
              />
              <span>
                <span className="font-medium">{t("apply.asset.field.replacement")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("apply.asset.field.replacement.hint")}
                </span>
              </span>
            </label>

            {isReplacement ? (
              custodyOptions.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("apply.asset.field.replaces.none")}
                </p>
              ) : (
                <div className="mt-2">
                  <Label htmlFor="ar-replaces">{t("apply.asset.field.replaces")}</Label>
                  <select
                    id="ar-replaces"
                    value={replacesId}
                    onChange={(e) => setReplacesId(e.target.value)}
                    className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">{t("apply.asset.field.replaces.pick")}</option>
                    {custodyOptions.map((row) => (
                      <option key={row.allocation_id} value={row.asset_id}>
                        {row.asset_name} · {row.asset_tag}
                      </option>
                    ))}
                  </select>
                </div>
              )
            ) : null}
          </div>

          {sendAsset.isError ? (
            <div className="mt-3"><Notice tone="error">{mutationUserMessage(sendAsset.error)}</Notice></div>
          ) : null}

          <SubmitBlockers
            attempt={attempt}
            blockers={assetBlockers}
            id="asset-blockers"
            title={t("apply.asset.blocked.title")}
          />

          <Button
            className="mt-4 w-full"
            disabled={sendAsset.isPending}
            {...blockerButtonProps(attempt, assetBlockers, "asset-blockers")}
            onClick={() => {
              if (!attempt.press(assetBlockers)) return;
              if (chosenCategory === undefined) return;
              sendAsset.mutate(
                {
                  assetCategoryId: chosenCategory.id,
                  assetCategoryName: chosenCategory.name,
                  quantity: Number(quantity),
                  reason,
                  neededBy: neededBy === "" ? null : neededBy,
                  isReplacement,
                  replacesAssetId: replacesId === "" ? null : replacesId,
                },
                {
                  onSuccess: (r) => {
                    attempt.reset();
                    setSent(r.requestId);
                    setReason("");
                    /* The banner is at the top of the page and the button is at
                       the bottom; the toast is what the person actually sees. */
                    confirmSubmitted(t("apply.asset.done"), {
                      detail: t("apply.asset.toast.next"),
                    });
                  },
                },
              );
            }}
          >
            {sendAsset.isPending ? t("apply.asset.sending") : t("apply.asset.send")}
          </Button>
        </section>

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
              <Notice tone="note">{t("apply.type.missing")}</Notice>
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
    </SubmitAttemptScope>
  );
}
