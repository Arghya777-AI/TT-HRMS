/**
 * §12 · /admin/assets/allocations — Allocations. Who holds what, since when.
 *
 * The rows are `v_asset_custody`, which is the only honest source for this
 * screen: it joins `asset_allocations` to `assets`, to `asset_categories` and to
 * `v_employee_ref` (so the employee's NAME and code come from the server, not
 * from a client-side id lookup), and it computes the two figures that matter —
 * `days_in_custody` as `util.ist_today() - util.ist_date(allocated_at)` and
 * `is_return_overdue` as `expected_return_date < util.ist_today()`. Neither is
 * recomputed here; an IST day boundary is the database's business.
 *
 * The view is narrowed to the three states where somebody is actually holding
 * the thing (`allocated`, `acknowledged`, `return_requested`), so this screen is
 * "current custody", not "allocation history" — that is /admin/assets/history.
 *
 * ISSUING is a real write, recon'd rather than assumed: there is NO allocation
 * RPC in any migration, and `asset_allocations` grants INSERT to `authenticated`
 * under `asset_allocations__admin__all` (admin AND `admin_scope_covers`). So the
 * button writes the allocation row and then the register's status/custodian, both
 * carrying the admin's typed reason and ONE shared `request_id`. That pair is not
 * a transaction and `assets.api.ts` says so in its header instead of pretending.
 *
 * RETURNS live on /admin/assets/returns, where the due and overdue queues are —
 * one action, one home, rather than two half-copies.
 *
 * @route /admin/assets/allocations
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRightLeft, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  ALLOCATION_STATUS_CHIP,
  useAssets,
  useCustody,
  useCustodyCount,
  useIssueAsset,
} from "../hooks/useAssetsAdmin";
import {
  OPEN_ALLOCATION_STATUSES,
  type AssetFilters,
  type CustodyFilters,
  type CustodyRow,
} from "../api/assets.api";

/** The tile the admin is standing on. `all` is every open custody row. */
type Slice = "all" | "allocated" | "acknowledged" | "return_requested" | "overdue";

const SLICE_FILTERS: Readonly<Record<Slice, CustodyFilters>> = {
  all: {},
  allocated: { statuses: ["allocated"] },
  acknowledged: { statuses: ["acknowledged"] },
  return_requested: { statuses: ["return_requested"] },
  overdue: { overdueOnly: true },
};

const TILES: readonly { slice: Slice; label: string; ring: string }[] = [
  { slice: "all", label: t("admin.assets.alloc.tile.all"), ring: "border-border" },
  { slice: "allocated", label: t("admin.assets.alloc.tile.awaitingAck"), ring: "border-warning/50" },
  { slice: "acknowledged", label: t("admin.assets.alloc.tile.acknowledged"), ring: "border-success/50" },
  {
    slice: "return_requested",
    label: t("admin.assets.alloc.tile.returnRequested"),
    ring: "border-info/50",
  },
  { slice: "overdue", label: t("admin.assets.alloc.tile.overdue"), ring: "border-destructive/50" },
];

function isSlice(v: string | null): v is Slice {
  return (
    v === "all" ||
    v === "allocated" ||
    v === "acknowledged" ||
    v === "return_requested" ||
    v === "overdue"
  );
}

/** Module-level so the filter object is referentially stable across renders. */
const IN_STOCK: AssetFilters = { statuses: ["in_stock"] };

interface IssueForm {
  assetId: string;
  employeeId: string;
  expectedReturnDate: string;
  notes: string;
}

const EMPTY_ISSUE: IssueForm = {
  assetId: "",
  employeeId: "",
  expectedReturnDate: "",
  notes: "",
};

export default function AssetAllocationsPage() {
  const [params, setParams] = useSearchParams();
  const sliceParam = params.get("slice");
  const slice: Slice = isSlice(sliceParam) ? sliceParam : "all";
  const employeeId = params.get("employee") ?? "";

  const filters = useMemo<CustodyFilters>(() => {
    const base = SLICE_FILTERS[slice];
    return {
      ...base,
      ...(employeeId !== "" ? { employeeIds: [employeeId] } : {}),
    };
  }, [slice, employeeId]);

  const custody = useCustody(filters);
  const rows = custody.data ?? [];
  const total = useCustodyCount(filters);

  // One server count per tile, each from the same predicate as its row set.
  const tileCounts: Record<Slice, ReturnType<typeof useCustodyCount>> = {
    all: useCustodyCount(SLICE_FILTERS.all),
    allocated: useCustodyCount(SLICE_FILTERS.allocated),
    acknowledged: useCustodyCount(SLICE_FILTERS.acknowledged),
    return_requested: useCustodyCount(SLICE_FILTERS.return_requested),
    overdue: useCustodyCount(SLICE_FILTERS.overdue),
  };

  const labels = useEmployeeLabels();
  const employeeOptions = useEmployeeOptions(labels.data);
  // Only an in-stock asset can be handed over; the register's own status says so.
  const inStock = useAssets(IN_STOCK);

  const issue = useIssueAsset();
  const [issuing, setIssuing] = useState(false);
  const [form, setForm] = useState<IssueForm>(EMPTY_ISSUE);
  const [formError, setFormError] = useState<string | null>(null);
  const [askReason, setAskReason] = useState(false);
  const [lastIssued, setLastIssued] = useState<string | null>(null);

  const assetOptions: SelectOption[] = (inStock.data ?? []).map((a) => ({
    value: a.id,
    label: t("admin.assets.alloc.assetOption", { tag: a.asset_tag, name: a.name }),
  }));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  async function submitIssue(reason: string): Promise<void> {
    try {
      const saved = await issue.saveAsync(
        {
          assetId: form.assetId,
          employeeId: form.employeeId,
          ...(form.expectedReturnDate !== ""
            ? { expectedReturnDate: form.expectedReturnDate }
            : {}),
          ...(form.notes.trim() !== "" ? { notes: form.notes.trim() } : {}),
        },
        reason,
      );
      setAskReason(false);
      setIssuing(false);
      setForm(EMPTY_ISSUE);
      setLastIssued(
        t("admin.assets.alloc.issued", { number: saved.allocation_number }),
      );
    } catch {
      // The dialog stays open with `issue.userMessage`; the reason is not lost.
    }
  }

  const columns: DataGridColumn<CustodyRow>[] = [
    {
      key: "display_name",
      header: t("admin.assets.alloc.col.holder"),
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
      key: "asset_tag",
      header: t("admin.assets.alloc.col.asset"),
      width: "15rem",
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
      key: "serial_number",
      header: t("admin.assets.col.serial"),
      hideBelow: "lg",
      render: (row) => <span className="num">{dash(row.serial_number)}</span>,
    },
    {
      key: "status",
      header: t("admin.assets.alloc.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={ALLOCATION_STATUS_CHIP} />,
    },
    {
      key: "allocated_at",
      header: t("admin.assets.alloc.col.since"),
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
      key: "days_in_custody",
      header: t("admin.assets.alloc.col.days"),
      width: "7rem",
      align: "right",
      sortable: true,
      // Server column. The client never subtracts two dates to get a day count.
      render: (row) => <span className="num">{dash(row.days_in_custody, formatNumber)}</span>,
    },
    {
      key: "expected_return_date",
      header: t("admin.assets.alloc.col.due"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
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
      key: "flags",
      header: t("admin.assets.alloc.col.flags"),
      width: "11rem",
      render: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.is_return_overdue === true ? (
            <StatusChip
              status="overdue"
              map={{ overdue: { label: t("admin.assets.flag.overdue"), tone: "danger" } }}
            />
          ) : null}
          {row.recall_requested_at !== null ? (
            <StatusChip
              status="recalled"
              map={{ recalled: { label: t("admin.assets.flag.recalled"), tone: "warn" } }}
            />
          ) : null}
          {row.acknowledged_at === null ? (
            <StatusChip
              status="unack"
              map={{ unack: { label: t("admin.assets.flag.unacknowledged"), tone: "warn" } }}
            />
          ) : null}
        </span>
      ),
    },
    {
      key: "action",
      header: t("admin.assets.alloc.col.action"),
      width: "8rem",
      render: (row) => (
        <Button asChild variant="outline" size="sm">
          <Link to={`/admin/assets/returns?slice=all&asset=${row.asset_id}`}>
            {t("admin.assets.alloc.recordReturn")}
          </Link>
        </Button>
      ),
    },
  ];

  const canIssue = form.assetId !== "" && form.employeeId !== "";

  return (
    <div className="container py-6">
      <PageHeader
        icon={ArrowRightLeft}
        title={t("admin.assets.alloc.title")}
        subtitle={
          total.isSuccess
            ? t("admin.assets.alloc.subtitle", { n: formatNumber(total.data) })
            : t("admin.assets.alloc.subtitlePlain")
        }
        actions={
          <Button
            onClick={() => {
              issue.reset();
              setFormError(null);
              setIssuing(true);
            }}
          >
            <PackageCheck className="mr-2 size-4" aria-hidden />
            {t("admin.assets.alloc.action.issue")}
          </Button>
        }
      />

      {lastIssued !== null ? (
        <div className="mt-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setLastIssued(null)}>
                {t("admin.assets.dismiss")}
              </Button>
            }
          >
            {lastIssued}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TILES.map((tile) => {
          const q = tileCounts[tile.slice];
          const active = slice === tile.slice;
          return (
            <button
              key={tile.slice}
              type="button"
              onClick={() => setParam("slice", tile.slice === "all" ? "" : tile.slice)}
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

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.assets.alloc.filter.holder")}
          value={employeeId}
          placeholder={t("admin.assets.alloc.filter.anyHolder")}
          options={employeeOptions}
          onChange={(v) => setParam("employee", v)}
        />
        <div className="flex items-end">
          {slice !== "all" || employeeId !== "" ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.assets.filter.clear")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {t("admin.assets.alloc.stateList", {
              states: OPEN_ALLOCATION_STATUSES.map(
                (s) => ALLOCATION_STATUS_CHIP[s].label,
              ).join(", "),
            })}
          </p>
        </div>
      </div>

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
              icon={ArrowRightLeft}
              title={
                slice === "all" && employeeId === ""
                  ? t("admin.assets.alloc.empty.title")
                  : t("admin.assets.alloc.empty.filtered.title")
              }
              hint={
                slice === "all" && employeeId === ""
                  ? t("admin.assets.alloc.empty.hint")
                  : t("admin.assets.alloc.empty.filtered.hint")
              }
              action={
                slice === "all" && employeeId === "" ? (
                  <Button onClick={() => setIssuing(true)}>
                    {t("admin.assets.alloc.action.issueFirst")}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setParams(new URLSearchParams(), { replace: true })}
                  >
                    {t("admin.assets.filter.clear")}
                  </Button>
                )
              }
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.allocation_id} pageSize={25} />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.assets.alloc.footnote")}</Notice>
      </div>

      <Sheet
        open={issuing}
        onOpenChange={(next) => {
          if (!next && !issue.isPending) setIssuing(false);
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader className="text-left">
            <SheetTitle className="font-display">{t("admin.assets.alloc.issueTitle")}</SheetTitle>
            <SheetDescription>{t("admin.assets.alloc.issueDescription")}</SheetDescription>
          </SheetHeader>

          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canIssue) {
                setFormError(t("admin.assets.alloc.err.pickBoth"));
                return;
              }
              setFormError(null);
              setAskReason(true);
            }}
          >
            <SelectField
              label={t("admin.assets.alloc.field.asset")}
              value={form.assetId}
              placeholder={
                assetOptions.length === 0
                  ? t("admin.assets.alloc.field.noStock")
                  : t("admin.assets.alloc.field.assetPlaceholder")
              }
              options={assetOptions}
              onChange={(v) => setForm((f) => ({ ...f, assetId: v }))}
              required
              hint={t("admin.assets.alloc.field.assetHint")}
              disabled={assetOptions.length === 0}
            />
            <SelectField
              label={t("admin.assets.alloc.field.employee")}
              value={form.employeeId}
              placeholder={t("admin.assets.alloc.field.employeePlaceholder")}
              options={employeeOptions}
              onChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}
              required
            />
            <TextField
              label={t("admin.assets.alloc.field.due")}
              type="date"
              value={form.expectedReturnDate}
              onChange={(v) => setForm((f) => ({ ...f, expectedReturnDate: v }))}
              hint={t("admin.assets.alloc.field.dueHint")}
            />
            <TextField
              label={t("admin.assets.alloc.field.notes")}
              value={form.notes}
              onChange={(v) => setForm((f) => ({ ...f, notes: v }))}
              hint={t("admin.assets.alloc.field.notesHint")}
            />

            {formError !== null ? <Notice tone="warning">{formError}</Notice> : null}
            {issue.userMessage !== null ? <Notice tone="error">{issue.userMessage}</Notice> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={issue.isPending}
                onClick={() => setIssuing(false)}
              >
                {t("admin.assets.form.cancel")}
              </Button>
              <Button type="submit" disabled={issue.isPending}>
                {issue.isPending
                  ? t("admin.assets.alloc.issuing")
                  : t("admin.assets.alloc.issueConfirm")}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <ReasonDialog
        open={askReason}
        title={t("admin.assets.alloc.reasonTitle")}
        description={t("admin.assets.alloc.reasonDescription", {
          asset:
            assetOptions.find((o) => o.value === form.assetId)?.label ?? t("admin.assets.thisAsset"),
          who:
            employeeOptions.find((o) => o.value === form.employeeId)?.label ??
            t("admin.assets.thisPerson"),
        })}
        confirmLabel={t("admin.assets.alloc.reasonConfirm")}
        pending={issue.isPending}
        errorMessage={issue.userMessage}
        onConfirm={(reason) => void submitIssue(reason)}
        onCancel={() => setAskReason(false)}
      />
    </div>
  );
}
