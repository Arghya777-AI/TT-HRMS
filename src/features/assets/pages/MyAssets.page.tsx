/**
 * E-11 · /me/assets — "What you hold, what to confirm, and what to return."
 *
 * One relation answers all three: `v_asset_custody` (037 §7), which is
 * `security_invoker = true` over `asset_allocations`, so the employee's own RLS
 * policy (`employee_id = app.current_employee_id()`) is what scopes it. The
 * console's Stores screens read the same view — same columns, same vocabulary, no
 * second definition of "in custody".
 *
 * Every number here is the database's. `days_in_custody` and `is_return_overdue`
 * are view columns computed from `util.ist_today()`; the four tiles are four
 * `count=exact` HEAD requests over the SAME filter arrays the grid below uses, so
 * a tile and its own list cannot disagree. Nothing is summed or dated in the
 * browser.
 *
 * THE ONE THING THIS SCREEN CANNOT DO, AND SAYS SO: confirm receipt. 028 grants
 * the employee SELECT and INSERT on `asset_allocations` and nothing more — there
 * is no self UPDATE policy and no acknowledgement RPC in any migration, so
 * `acknowledged_at` can only be stamped by Stores under the admin policy. The
 * "To confirm" section therefore lists what is outstanding and names who records
 * it, instead of offering a button that would fail with a 42501.
 *
 * @route /me/assets
 */
import { Link, useSearchParams } from "react-router-dom";
import { BadgeCheck, Package, PackageCheck, RotateCcw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import {
  isCustodyView,
  type CustodyRow,
  type CustodyView,
  type PipelineAllocation,
} from "../api/my-assets.api";
import {
  useMyCustody,
  useMyCustodyCounts,
  useMyPipelineAllocations,
} from "@/features/apply/hooks/useApply";

/** `asset_allocation_status` — only the states `v_asset_custody` admits. */
const CUSTODY_STATUS_MAP: Record<string, StatusChipEntry> = {
  allocated: { label: t("assets.status.allocated"), tone: "info" },
  acknowledged: { label: t("assets.status.acknowledged"), tone: "success" },
  return_requested: { label: t("assets.status.returnRequested"), tone: "warn" },
};

const PIPELINE_STATUS_MAP: Record<string, StatusChipEntry> = {
  requested: { label: t("assets.status.requested"), tone: "warn" },
  approved: { label: t("assets.status.approved"), tone: "info" },
};

interface TileSpec {
  readonly view: CustodyView;
  readonly label: string;
  readonly hint: string;
  readonly icon: typeof Package;
  readonly count: number | undefined;
}

function Tile({ tile, active, onSelect }: { tile: TileSpec; active: boolean; onSelect: () => void }) {
  const Icon = tile.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex h-full flex-col rounded-lg border bg-card p-4 text-left transition-colors",
        "hover:border-primary/40 hover:bg-muted/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active && "border-primary/60 bg-muted/40",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        {tile.label}
      </span>
      <span className="num mt-2 font-display text-2xl font-semibold leading-none">
        {tile.count === undefined ? dash(null) : formatNumber(tile.count)}
      </span>
      <span className="mt-1.5 text-xs text-muted-foreground">{tile.hint}</span>
    </button>
  );
}

export default function MyAssetsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  const view: CustodyView = isCustodyView(raw) ? raw : "all";

  const counts = useMyCustodyCounts();
  const rows = useMyCustody(view);
  const pipeline = useMyPipelineAllocations();

  function selectView(next: CustodyView) {
    const updated = new URLSearchParams(params);
    if (next === "all") updated.delete("view");
    else updated.set("view", next);
    setParams(updated, { replace: true });
  }

  const tiles: TileSpec[] = [
    {
      view: "all",
      label: t("assets.tile.held"),
      hint: t("assets.tile.held.hint"),
      icon: Package,
      count: counts.data?.all,
    },
    {
      view: "confirm",
      label: t("assets.tile.confirm"),
      hint: t("assets.tile.confirm.hint"),
      icon: BadgeCheck,
      count: counts.data?.confirm,
    },
    {
      view: "overdue",
      label: t("assets.tile.overdue"),
      hint: t("assets.tile.overdue.hint"),
      icon: TriangleAlert,
      count: counts.data?.overdue,
    },
    {
      view: "recall",
      label: t("assets.tile.recall"),
      hint: t("assets.tile.recall.hint"),
      icon: RotateCcw,
      count: counts.data?.recall,
    },
  ];

  const columns: DataGridColumn<CustodyRow>[] = [
    {
      key: "asset_name",
      header: t("assets.col.item"),
      render: (row) => (
        <span className="min-w-0">
          <span className="block font-medium leading-snug">{row.asset_name}</span>
          <span className="block font-mono text-xs text-muted-foreground">{row.asset_tag}</span>
        </span>
      ),
    },
    {
      key: "asset_category_name",
      header: t("assets.col.category"),
      hideBelow: "md",
      render: (row) => dash(row.asset_category_name),
    },
    {
      key: "serial_number",
      header: t("assets.col.serial"),
      hideBelow: "lg",
      render: (row) =>
        row.serial_number === null ? dash(null) : <span className="font-mono text-xs">{row.serial_number}</span>,
    },
    {
      key: "quantity",
      header: t("assets.col.qty"),
      align: "right",
      width: "5.5rem",
      hideBelow: "md",
      render: (row) => formatNumber(row.quantity),
    },
    {
      key: "status",
      header: t("assets.col.state"),
      width: "12rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusChip status={row.status} map={CUSTODY_STATUS_MAP} />
          {row.is_return_overdue === true ? (
            <Badge variant="danger">{t("assets.chip.overdue")}</Badge>
          ) : null}
          {row.recall_requested_at !== null ? (
            <Badge variant="warning">{t("assets.chip.recalled")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "allocated_at",
      header: t("assets.col.since"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => (row.allocated_at === null ? dash(null) : fmtDateTime(row.allocated_at)),
    },
    {
      key: "days_in_custody",
      header: t("assets.col.days"),
      align: "right",
      width: "7rem",
      sortable: true,
      // A view column (`util.ist_today() - util.ist_date(allocated_at)`), not a
      // date subtraction done here.
      render: (row) => (row.days_in_custody === null ? dash(null) : formatNumber(row.days_in_custody)),
    },
    {
      key: "expected_return_date",
      header: t("assets.col.returnBy"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => fmtCivilDate(row.expected_return_date),
    },
    {
      key: "acknowledged_at",
      header: t("assets.col.confirmed"),
      width: "13rem",
      hideBelow: "lg",
      render: (row) =>
        row.acknowledged_at === null ? (
          <Badge variant="warning">{t("assets.chip.unconfirmed")}</Badge>
        ) : (
          fmtDateTime(row.acknowledged_at)
        ),
    },
  ];

  const pipelineColumns: DataGridColumn<PipelineAllocation>[] = [
    {
      key: "allocation_number",
      header: t("assets.col.ref"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.allocation_number}</span>,
    },
    {
      key: "asset",
      header: t("assets.col.item"),
      render: (row) => (row.assets === null ? dash(null) : row.assets.name),
    },
    {
      key: "quantity",
      header: t("assets.col.qty"),
      align: "right",
      width: "5.5rem",
      render: (row) => formatNumber(row.quantity),
    },
    {
      key: "status",
      header: t("assets.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={PIPELINE_STATUS_MAP} />,
    },
    {
      key: "requested_at",
      header: t("assets.col.raised"),
      width: "13rem",
      hideBelow: "md",
      sortable: true,
      render: (row) => (row.requested_at === null ? dash(null) : fmtDateTime(row.requested_at)),
    },
  ];

  const emptyByView: Readonly<Record<CustodyView, { title: string; hint: string }>> = {
    all: { title: t("assets.empty.all.title"), hint: t("assets.empty.all.hint") },
    confirm: { title: t("assets.empty.confirm.title"), hint: t("assets.empty.confirm.hint") },
    overdue: { title: t("assets.empty.overdue.title"), hint: t("assets.empty.overdue.hint") },
    recall: { title: t("assets.empty.recall.title"), hint: t("assets.empty.recall.hint") },
  };
  const empty = emptyByView[view];

  return (
    <div>
      <PageHeader
        icon={PackageCheck}
        title={t("assets.title")}
        subtitle={t("assets.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply/asset">{t("assets.requestCta")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        <StateBoundary
          loading={counts.isLoading}
          error={counts.error ?? undefined}
          onRetry={() => void counts.refetch()}
          skeletonRows={1}
        >
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {tiles.map((tile) => (
              <li key={tile.view}>
                <Tile
                  tile={tile}
                  active={view === tile.view}
                  onSelect={() => selectView(tile.view)}
                />
              </li>
            ))}
          </ul>
        </StateBoundary>

        {view === "confirm" ? (
          <Notice tone="info">
            <p className="font-medium">{t("assets.confirm.gap.title")}</p>
            <p className="mt-1">{t("assets.confirm.gap.hint")}</p>
          </Notice>
        ) : null}

        <section aria-labelledby="assets-list">
          <h2 id="assets-list" className="mb-3 font-display text-lg font-semibold">
            {t("assets.list.title")}
          </h2>
          <StateBoundary
            loading={rows.isLoading}
            error={rows.error ?? undefined}
            onRetry={() => void rows.refetch()}
          >
            <DataGrid
              columns={columns}
              rows={rows.data ?? []}
              rowKey={(row) => row.allocation_id}
              pageSize={25}
              emptyState={<EmptyState icon={Package} title={empty.title} hint={empty.hint} />}
            />
          </StateBoundary>
        </section>

        <section aria-labelledby="assets-pipeline">
          <h2 id="assets-pipeline" className="font-display text-lg font-semibold">
            {t("assets.pipeline.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("assets.pipeline.hint")}</p>
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
                  title={t("assets.pipeline.empty.title")}
                  hint={t("assets.pipeline.empty.hint")}
                />
              }
            />
          </StateBoundary>
        </section>
      </div>
    </div>
  );
}
