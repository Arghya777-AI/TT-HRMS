/**
 * §12 · /admin/assets/returns — Returns & Recalls. Pending returns and recall
 * campaigns.
 *
 * This is the chase list, and every figure on it is the database's:
 *
 *  * OVERDUE is `v_asset_custody.is_return_overdue`
 *    (`expected_return_date < util.ist_today()`), filtered server-side with
 *    `is.true`. The browser never compares a date to "today" — an IST day
 *    boundary belongs to Postgres, and a laptop clock in the wrong timezone must
 *    not be able to turn a return overdue.
 *  * DUE is `expected_return_date IS NOT NULL` — an asset issued open-ended
 *    (a uniform, an access card) is not "due", and the screen says so in words
 *    rather than showing a blank date column.
 *  * DAYS IN CUSTODY is the view's own column, never a subtraction here.
 *
 * Two audited actions:
 *
 *  1. RECORD RETURN — closes the allocation (`returned`, `returned_at`,
 *     `return_condition`) and puts the register row back to `in_stock` with the
 *     condition it came back in. Two statements, one `request_id`; not a
 *     transaction, and `assets.api.ts` says so.
 *  2. REQUEST RECALL — stamps `recall_requested_at/by/reason`. The typed sentence
 *     IS the recall reason (the CHECK constraint demands a requester and ≥10
 *     characters), so the holder reads the same words the auditor does. The
 *     allocation stays OPEN, because a recall is a request, not a receipt: the
 *     person still physically holds the thing until someone records the return.
 *
 * There is no bulk "recall campaign" write: nothing server-side batches recalls,
 * and firing N independent PATCHes behind one button would report success while
 * having half-failed. Recall is per row, per reason.
 *
 * @route /admin/assets/returns
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PackageX, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/app/auth/AuthProvider";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { ReasonActionButton } from "../components/ReasonActionButton";
import {
  ALLOCATION_STATUS_CHIP,
  CONDITION_LABELS,
  useCustody,
  useCustodyCount,
  useRequestRecall,
  useReturnAsset,
} from "../hooks/useAssetsAdmin";
import {
  assetConditionValues,
  type AssetCondition,
  type CustodyFilters,
  type CustodyRow,
} from "../api/assets.api";

type Slice = "overdue" | "due" | "recalled" | "all";

const SLICE_FILTERS: Readonly<Record<Slice, CustodyFilters>> = {
  overdue: { overdueOnly: true },
  due: { dueOnly: true },
  recalled: { recalledOnly: true },
  all: {},
};

const TILES: readonly { slice: Slice; label: string; ring: string }[] = [
  { slice: "overdue", label: t("admin.assets.returns.tile.overdue"), ring: "border-destructive/50" },
  { slice: "due", label: t("admin.assets.returns.tile.due"), ring: "border-warning/50" },
  { slice: "recalled", label: t("admin.assets.returns.tile.recalled"), ring: "border-info/50" },
  { slice: "all", label: t("admin.assets.returns.tile.all"), ring: "border-border" },
];

function isSlice(v: string | null): v is Slice {
  return v === "overdue" || v === "due" || v === "recalled" || v === "all";
}

function isCondition(v: string): v is AssetCondition {
  return (assetConditionValues as readonly string[]).includes(v);
}

export default function AssetReturnsPage() {
  const [params, setParams] = useSearchParams();
  const sliceParam = params.get("slice");
  const slice: Slice = isSlice(sliceParam) ? sliceParam : "overdue";
  const assetId = params.get("asset") ?? "";

  const { user } = useAuth();
  const actorProfileId = user?.id ?? null;

  const filters = useMemo<CustodyFilters>(() => {
    const base = SLICE_FILTERS[slice];
    return { ...base, ...(assetId !== "" ? { assetId } : {}) };
  }, [slice, assetId]);

  const custody = useCustody(filters);
  const rows = custody.data ?? [];
  const total = useCustodyCount(filters);

  const tileCounts: Record<Slice, ReturnType<typeof useCustodyCount>> = {
    overdue: useCustodyCount(SLICE_FILTERS.overdue),
    due: useCustodyCount(SLICE_FILTERS.due),
    recalled: useCustodyCount(SLICE_FILTERS.recalled),
    all: useCustodyCount(SLICE_FILTERS.all),
  };

  const recordReturn = useReturnAsset();
  const recall = useRequestRecall();

  const [target, setTarget] = useState<CustodyRow | null>(null);
  const [condition, setCondition] = useState<AssetCondition>("good");
  const [askReason, setAskReason] = useState(false);
  const [lastDone, setLastDone] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  function openReturn(row: CustodyRow): void {
    recordReturn.reset();
    setTarget(row);
    // Default to the condition the register currently records — the admin
    // changes it only if the item came back worse.
    setCondition(isCondition(row.condition) ? row.condition : "good");
  }

  async function submitReturn(reason: string): Promise<void> {
    if (target === null) return;
    try {
      await recordReturn.saveAsync(
        { allocationId: target.allocation_id, assetId: target.asset_id, condition },
        reason,
      );
      setAskReason(false);
      setLastDone(
        t("admin.assets.returns.done", {
          tag: target.asset_tag,
          who: target.display_name ?? "",
          condition: CONDITION_LABELS[condition],
        }),
      );
      setTarget(null);
    } catch {
      // Dialog stays open with `recordReturn.userMessage`.
    }
  }

  const columns: DataGridColumn<CustodyRow>[] = [
    {
      key: "display_name",
      header: t("admin.assets.alloc.col.holder"),
      width: "14rem",
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
      key: "expected_return_date",
      header: t("admin.assets.returns.col.due"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (row) =>
        row.expected_return_date === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.assets.alloc.openEnded")}
          </span>
        ) : (
          <span className={cn("num", row.is_return_overdue === true && "text-destructive")}>
            {fmtCivilDate(row.expected_return_date)}
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
      key: "status",
      header: t("admin.assets.alloc.col.state"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.status} map={ALLOCATION_STATUS_CHIP} />,
    },
    {
      key: "recall_requested_at",
      header: t("admin.assets.returns.col.recall"),
      width: "12rem",
      hideBelow: "md",
      render: (row) =>
        row.recall_requested_at === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.assets.returns.noRecall")}
          </span>
        ) : (
          <span className="num text-xs">{fmtDateTime(row.recall_requested_at)}</span>
        ),
    },
    {
      key: "actions",
      header: t("admin.assets.alloc.col.action"),
      width: "18rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => openReturn(row)}>
            {t("admin.assets.returns.action.return")}
          </Button>
          <ReasonActionButton
            label={t("admin.assets.returns.action.recall")}
            title={t("admin.assets.returns.recallTitle", { tag: row.asset_tag })}
            description={t("admin.assets.returns.recallDescription", {
              who: row.display_name ?? t("admin.assets.thisPerson"),
              asset: row.asset_name,
            })}
            confirmLabel={t("admin.assets.returns.recallConfirm")}
            disabled={row.recall_requested_at !== null || actorProfileId === null}
            disabledHint={
              row.recall_requested_at !== null
                ? t("admin.assets.returns.alreadyRecalled", {
                    at: fmtDateTime(row.recall_requested_at),
                  })
                : t("admin.assets.returns.noActor")
            }
            onConfirm={(reason) =>
              recall.saveAsync(
                { allocationId: row.allocation_id, actorProfileId: actorProfileId ?? "" },
                reason,
              )
            }
          />
        </span>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Undo2}
        title={t("admin.assets.returns.title")}
        subtitle={
          total.isSuccess
            ? t("admin.assets.returns.subtitle", { n: formatNumber(total.data) })
            : t("admin.assets.returns.subtitlePlain")
        }
      />

      {lastDone !== null ? (
        <div className="mt-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setLastDone(null)}>
                {t("admin.assets.dismiss")}
              </Button>
            }
          >
            {lastDone}
          </Notice>
        </div>
      ) : null}

      {recall.userMessage !== null ? (
        <div className="mt-4">
          <Notice tone="error">{recall.userMessage}</Notice>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((tile) => {
          const q = tileCounts[tile.slice];
          const active = slice === tile.slice;
          return (
            <button
              key={tile.slice}
              type="button"
              onClick={() => setParam("slice", tile.slice)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tile.ring,
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? "—" : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      {assetId !== "" ? (
        <div className="mt-4">
          <Notice
            tone="info"
            action={
              <Button variant="ghost" size="sm" onClick={() => setParam("asset", "")}>
                {t("admin.assets.returns.clearAsset")}
              </Button>
            }
          >
            {t("admin.assets.returns.oneAsset")}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={custody.isPending}
          error={custody.error}
          onRetry={() => void custody.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error}
          partialLabel={t("admin.assets.partial.total")}
          empty={
            <EmptyState
              icon={PackageX}
              title={
                slice === "overdue"
                  ? t("admin.assets.returns.empty.overdue.title")
                  : slice === "recalled"
                    ? t("admin.assets.returns.empty.recalled.title")
                    : t("admin.assets.returns.empty.title")
              }
              hint={
                slice === "overdue"
                  ? t("admin.assets.returns.empty.overdue.hint")
                  : slice === "recalled"
                    ? t("admin.assets.returns.empty.recalled.hint")
                    : t("admin.assets.returns.empty.hint")
              }
              action={
                slice === "all" ? null : (
                  <Button variant="outline" onClick={() => setParam("slice", "all")}>
                    {t("admin.assets.returns.showAll")}
                  </Button>
                )
              }
            />
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
        <Notice tone="info">{t("admin.assets.returns.footnote")}</Notice>
      </div>

      {/* Record a return: the condition it came back in is the one thing the
          admin must state, because it lands on BOTH the allocation and the
          register row. */}
      <Sheet
        open={target !== null}
        onOpenChange={(next) => {
          if (!next && !recordReturn.isPending) setTarget(null);
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
          <SheetHeader className="text-left">
            <SheetTitle className="font-display">
              {t("admin.assets.returns.sheetTitle")}
            </SheetTitle>
            <SheetDescription>{t("admin.assets.returns.sheetDescription")}</SheetDescription>
          </SheetHeader>

          {target !== null ? (
            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setAskReason(true);
              }}
            >
              <dl className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.assets.alloc.col.asset")}
                  </dt>
                  <dd className="text-sm">
                    <span className="num">{target.asset_tag}</span> · {target.asset_name}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.assets.alloc.col.holder")}
                  </dt>
                  <dd className="text-sm">
                    {dash(target.display_name)}{" "}
                    <span className="num text-xs text-muted-foreground">
                      {dash(target.employee_code)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.assets.alloc.col.since")}
                  </dt>
                  <dd className="num text-sm">
                    {target.allocated_at === null ? "—" : fmtDateTime(target.allocated_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.assets.alloc.col.days")}
                  </dt>
                  <dd className="num text-sm">{dash(target.days_in_custody, formatNumber)}</dd>
                </div>
              </dl>

              <SelectField
                label={t("admin.assets.returns.field.condition")}
                value={condition}
                options={assetConditionValues.map((c) => ({
                  value: c,
                  label: CONDITION_LABELS[c],
                }))}
                onChange={(v) => setCondition(isCondition(v) ? v : condition)}
                hint={t("admin.assets.returns.field.conditionHint")}
              />

              {recordReturn.userMessage !== null ? (
                <Notice tone="error">{recordReturn.userMessage}</Notice>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={recordReturn.isPending}
                  onClick={() => setTarget(null)}
                >
                  {t("admin.assets.form.cancel")}
                </Button>
                <Button type="submit" disabled={recordReturn.isPending}>
                  {recordReturn.isPending
                    ? t("admin.assets.returns.saving")
                    : t("admin.assets.returns.action.return")}
                </Button>
              </div>
            </form>
          ) : null}
        </SheetContent>
      </Sheet>

      <ReasonDialog
        open={askReason}
        title={t("admin.assets.returns.reasonTitle")}
        description={
          target === null
            ? t("admin.assets.returns.reasonDescriptionPlain")
            : t("admin.assets.returns.reasonDescription", {
                tag: target.asset_tag,
                who: target.display_name ?? t("admin.assets.thisPerson"),
                condition: CONDITION_LABELS[condition],
              })
        }
        confirmLabel={t("admin.assets.returns.reasonConfirm")}
        pending={recordReturn.isPending}
        errorMessage={recordReturn.userMessage}
        onConfirm={(reason) => void submitReturn(reason)}
        onCancel={() => setAskReason(false)}
      />
    </div>
  );
}
