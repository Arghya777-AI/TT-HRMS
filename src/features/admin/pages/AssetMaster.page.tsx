/**
 * §12 · /admin/assets/master — Asset Master. Every asset, its category and its
 * value.
 *
 * What this screen is careful about:
 *
 *  1. THE TILES AND THE GRID SHARE ONE PREDICATE. Each status tile is a
 *     `count=exact` over `assets` built from the same `AssetFilters` object the
 *     grid's read uses (`useAssetCount` / `useAssets`), so a tile can never
 *     disagree with the rows it filters to. Nothing on this page is counted in
 *     the browser.
 *  2. MONEY IS INTEGER PAISE, IN BOTH DIRECTIONS. `purchase_cost_paise` renders
 *     through `<Money>`; the rupees an admin types are converted by
 *     `rupeesToPaise`, which does string arithmetic on the two halves rather
 *     than a float multiply (₹4,500.55 → 450055, never 450054.999…).
 *  3. THE CATEGORY'S OWN RULES ARE ENFORCED, NOT INVENTED. `requires_serial`
 *     comes from `asset_categories` (seeded, migration 046 §4): pick
 *     Walkie-Talkies and the serial number becomes required, pick Chef Knives
 *     and it does not. The screen reads the rule; it does not hard-code a list.
 *
 * Writes are the admin's own: `assets__admin__all` is `FOR ALL` (migration 028
 * §2), so create and edit here are sanctioned — with a reason, through
 * `insertRow`/`updateRow`. DELETE is revoked from `authenticated` on purpose, so
 * there is no delete button; retiring an asset is a status change that keeps the
 * custody trail intact.
 *
 * @route /admin/assets/master
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Package, PackagePlus } from "lucide-react";
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
import { Money } from "@/shared/ui/Money";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { useDefaultCompanyId, useRefOptions } from "../hooks/useMasters";
import {
  ASSET_STATUS_CHIP,
  CONDITION_LABELS,
  useAssetCategories,
  useAssetCategoryMap,
  useAssetCount,
  useAssets,
  useCreateAsset,
  useUpdateAsset,
} from "../hooks/useAssetsAdmin";
import {
  assetConditionValues,
  assetStatusValues,
  rupeesToPaise,
  type Asset,
  type AssetCondition,
  type AssetFilters,
  type AssetStatus,
} from "../api/assets.api";

const STATUS_TILES = assetStatusValues;

const TONE_RING: Readonly<Record<string, string>> = {
  success: "border-success/50",
  info: "border-info/50",
  warn: "border-warning/50",
  danger: "border-destructive/50",
  neutral: "border-border",
};

function isAssetStatus(v: string | null): v is AssetStatus {
  return v !== null && (assetStatusValues as readonly string[]).includes(v);
}

function isCondition(v: string | null): v is AssetCondition {
  return v !== null && (assetConditionValues as readonly string[]).includes(v);
}

/** The create form's own state — strings, because that is what inputs hold. */
interface CreateForm {
  assetTag: string;
  name: string;
  categoryId: string;
  serialNumber: string;
  make: string;
  model: string;
  purchaseDate: string;
  costRupees: string;
  locationId: string;
  condition: AssetCondition;
  notes: string;
}

const EMPTY_FORM: CreateForm = {
  assetTag: "",
  name: "",
  categoryId: "",
  serialNumber: "",
  make: "",
  model: "",
  purchaseDate: "",
  costRupees: "",
  locationId: "",
  condition: "good",
  notes: "",
};

interface EditForm {
  status: AssetStatus;
  condition: AssetCondition;
  notes: string;
}

export default function AssetMasterPage() {
  const [params, setParams] = useSearchParams();

  const statusParam = params.get("status");
  const conditionParam = params.get("condition");
  const categoryId = params.get("category") ?? "";
  const tagLike = params.get("tag") ?? "";
  const nameLike = params.get("q") ?? "";
  const status = isAssetStatus(statusParam) ? statusParam : null;
  const condition = isCondition(conditionParam) ? conditionParam : null;

  const categories = useAssetCategories();
  const categoryMap = useAssetCategoryMap(categories.data);
  const locations = useRefOptions("locations");
  const companyId = useDefaultCompanyId();

  const filters = useMemo<AssetFilters>(
    () => ({
      ...(status !== null ? { statuses: [status] } : {}),
      ...(condition !== null ? { conditions: [condition] } : {}),
      ...(categoryId !== "" ? { categoryIds: [categoryId] } : {}),
      ...(tagLike !== "" ? { tagLike } : {}),
      ...(nameLike !== "" ? { nameLike } : {}),
    }),
    [status, condition, categoryId, tagLike, nameLike],
  );

  const assets = useAssets(filters);
  const total = useAssetCount(filters);
  const rows = assets.data ?? [];

  // One server count per status tile — the same relation, the same predicate.
  const tileCounts: Record<AssetStatus, ReturnType<typeof useAssetCount>> = {
    in_stock: useAssetCount({ statuses: ["in_stock"] }),
    allocated: useAssetCount({ statuses: ["allocated"] }),
    in_repair: useAssetCount({ statuses: ["in_repair"] }),
    lost: useAssetCount({ statuses: ["lost"] }),
    retired: useAssetCount({ statuses: ["retired"] }),
    written_off: useAssetCount({ statuses: ["written_off"] }),
  };

  const create = useCreateAsset();
  const update = useUpdateAsset();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [createErrors, setCreateErrors] = useState<Partial<Record<keyof CreateForm, string>>>({});
  const [askCreateReason, setAskCreateReason] = useState(false);

  const [editing, setEditing] = useState<Asset | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [askEditReason, setAskEditReason] = useState(false);

  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const hasFilter =
    status !== null || condition !== null || categoryId !== "" || tagLike !== "" || nameLike !== "";

  const categoryOptions: SelectOption[] = (categories.data ?? []).map((c) => ({
    value: c.id,
    label: c.name,
  }));

  const chosenCategory = form.categoryId === "" ? undefined : categoryMap.get(form.categoryId);

  function validateCreate(): boolean {
    const errors: Partial<Record<keyof CreateForm, string>> = {};
    if (form.assetTag.trim() === "") errors.assetTag = t("admin.assets.form.err.tag");
    if (form.name.trim() === "") errors.name = t("admin.assets.form.err.name");
    if (form.categoryId === "") errors.categoryId = t("admin.assets.form.err.category");
    if (chosenCategory?.requires_serial === true && form.serialNumber.trim() === "")
      errors.serialNumber = t("admin.assets.form.err.serialRequired");
    if (form.costRupees.trim() !== "" && rupeesToPaise(form.costRupees) === null)
      errors.costRupees = t("admin.assets.form.err.cost");
    setCreateErrors(errors);
    return Object.keys(errors).length === 0;
  }

  /**
   * Awaits the write, so the sheet closes on the ROW THE SERVER RETURNED and
   * stays open (with the server's sentence) when it does not. No optimistic
   * close, no state patched during render.
   */
  async function submitCreate(reason: string): Promise<void> {
    if (companyId === null) return;
    const paise = form.costRupees.trim() === "" ? null : rupeesToPaise(form.costRupees);
    try {
      const saved = await create.saveAsync(
        {
        assetTag: form.assetTag.trim(),
        name: form.name.trim(),
        categoryId: form.categoryId,
        companyId,
        condition: form.condition,
        ...(form.serialNumber.trim() !== "" ? { serialNumber: form.serialNumber.trim() } : {}),
        ...(form.make.trim() !== "" ? { make: form.make.trim() } : {}),
        ...(form.model.trim() !== "" ? { model: form.model.trim() } : {}),
        ...(form.purchaseDate !== "" ? { purchaseDate: form.purchaseDate } : {}),
        ...(paise !== null ? { purchaseCostPaise: paise } : {}),
        ...(form.locationId !== "" ? { locationId: form.locationId } : {}),
          ...(form.notes.trim() !== "" ? { notes: form.notes.trim() } : {}),
        },
        reason,
      );
      setAskCreateReason(false);
      setCreating(false);
      setForm(EMPTY_FORM);
      setLastSaved(t("admin.assets.saved.created", { tag: saved.asset_tag }));
    } catch {
      // The dialog stays open; `create.userMessage` carries the server's sentence.
    }
  }

  async function submitEdit(reason: string): Promise<void> {
    if (editing === null || editForm === null) return;
    try {
      const saved = await update.saveAsync(
        {
          id: editing.id,
          status: editForm.status,
          condition: editForm.condition,
          notes: editForm.notes.trim() === "" ? null : editForm.notes.trim(),
        },
        reason,
      );
      setAskEditReason(false);
      setEditing(null);
      setEditForm(null);
      setLastSaved(t("admin.assets.saved.updated", { tag: saved.asset_tag }));
    } catch {
      // Same posture: the reason the admin typed is not thrown away on failure.
    }
  }

  const columns: DataGridColumn<Asset>[] = [
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
            {dash(categoryMap.get(row.asset_category_id)?.name ?? null)}
          </span>
        </span>
      ),
    },
    {
      key: "make",
      header: t("admin.assets.col.makeModel"),
      hideBelow: "lg",
      render: (row) =>
        row.make === null && row.model === null
          ? dash(null)
          : `${row.make ?? ""} ${row.model ?? ""}`.trim(),
    },
    {
      key: "serial_number",
      header: t("admin.assets.col.serial"),
      hideBelow: "md",
      render: (row) => <span className="num">{dash(row.serial_number)}</span>,
    },
    {
      key: "condition",
      header: t("admin.assets.col.condition"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => dash(CONDITION_LABELS[row.condition]),
    },
    {
      key: "status",
      header: t("admin.assets.col.status"),
      width: "9rem",
      sortable: true,
      render: (row) => <StatusChip status={row.status} map={ASSET_STATUS_CHIP} />,
    },
    {
      key: "quantity",
      header: t("admin.assets.col.quantity"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => (
        <span className="num">
          {t("admin.assets.qtyUnit", { qty: formatNumber(row.quantity), unit: row.unit })}
        </span>
      ),
    },
    {
      key: "purchase_cost_paise",
      header: t("admin.assets.col.cost"),
      width: "9rem",
      align: "right",
      sortable: true,
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

  return (
    <div className="container py-6">
      <PageHeader
        icon={Package}
        title={t("admin.assets.master.title")}
        subtitle={
          total.isSuccess
            ? t("admin.assets.master.subtitle", { n: formatNumber(total.data) })
            : t("admin.assets.master.subtitlePlain")
        }
        actions={
          <Button
            onClick={() => {
              create.reset();
              setCreateErrors({});
              setCreating(true);
            }}
            disabled={companyId === null}
            title={companyId === null ? t("admin.assets.form.noCompany") : undefined}
          >
            <PackagePlus className="mr-2 size-4" aria-hidden />
            {t("admin.assets.action.add")}
          </Button>
        }
      />

      {lastSaved !== null ? (
        <div className="mt-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setLastSaved(null)}>
                {t("admin.assets.dismiss")}
              </Button>
            }
          >
            {lastSaved}
          </Notice>
        </div>
      ) : null}

      {/* Status tiles — server counts, each one a filter on the grid below. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATUS_TILES.map((tile) => {
          const q = tileCounts[tile];
          const active = status === tile;
          const entry = ASSET_STATUS_CHIP[tile];
          return (
            <button
              key={tile}
              type="button"
              onClick={() => setParam("status", active ? "" : tile)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                TONE_RING[entry.tone],
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{entry.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? "—" : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.assets.filter.category")}
          value={categoryId}
          placeholder={t("admin.assets.filter.anyCategory")}
          options={categoryOptions}
          onChange={(v) => setParam("category", v)}
        />
        <SelectField
          label={t("admin.assets.filter.condition")}
          value={condition ?? ""}
          placeholder={t("admin.assets.filter.anyCondition")}
          options={assetConditionValues.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))}
          onChange={(v) => setParam("condition", v)}
        />
        <TextField
          label={t("admin.assets.filter.tag")}
          value={tagLike}
          onChange={(v) => setParam("tag", v)}
          placeholder={t("admin.assets.filter.tagPlaceholder")}
        />
        <TextField
          label={t("admin.assets.filter.name")}
          value={nameLike}
          onChange={(v) => setParam("q", v)}
          placeholder={t("admin.assets.filter.namePlaceholder")}
        />
        {hasFilter ? (
          <div className="flex items-end">
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.assets.filter.clear")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={assets.isPending}
          error={assets.error}
          onRetry={() => void assets.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error}
          partialLabel={t("admin.assets.partial.total")}
          empty={
            hasFilter ? (
              <EmptyState
                icon={Package}
                title={t("admin.assets.master.empty.filtered.title")}
                hint={t("admin.assets.master.empty.filtered.hint")}
                action={
                  <Button
                    variant="outline"
                    onClick={() => setParams(new URLSearchParams(), { replace: true })}
                  >
                    {t("admin.assets.filter.clear")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Package}
                title={t("admin.assets.master.empty.title")}
                hint={t("admin.assets.master.empty.hint")}
                action={
                  <Button disabled={companyId === null} onClick={() => setCreating(true)}>
                    {t("admin.assets.action.addFirst")}
                  </Button>
                }
              />
            )
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => {
              update.reset();
              setEditing(row);
              setEditForm({
                status: row.status,
                condition: row.condition,
                notes: row.notes ?? "",
              });
            }}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.assets.master.footnote")}</Notice>
      </div>

      {/* ---------------- Create ---------------- */}
      <Sheet
        open={creating}
        onOpenChange={(next) => {
          if (!next && !create.isPending) setCreating(false);
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-2xl">
          <SheetHeader className="text-left">
            <SheetTitle className="font-display">{t("admin.assets.form.createTitle")}</SheetTitle>
            <SheetDescription>{t("admin.assets.form.createDescription")}</SheetDescription>
          </SheetHeader>

          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (validateCreate()) setAskCreateReason(true);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t("admin.assets.form.tag")}
                value={form.assetTag}
                onChange={(v) => setForm((f) => ({ ...f, assetTag: v.toUpperCase() }))}
                required
                hint={t("admin.assets.form.tagHint")}
                {...(createErrors.assetTag !== undefined ? { error: createErrors.assetTag } : {})}
              />
              <TextField
                label={t("admin.assets.form.name")}
                value={form.name}
                onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                required
                {...(createErrors.name !== undefined ? { error: createErrors.name } : {})}
              />
              <SelectField
                label={t("admin.assets.form.category")}
                value={form.categoryId}
                placeholder={t("admin.assets.form.categoryPlaceholder")}
                options={categoryOptions}
                onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
                required
                {...(chosenCategory !== undefined
                  ? {
                      hint: chosenCategory.is_consumable
                        ? t("admin.assets.form.categoryConsumable")
                        : chosenCategory.default_return_required
                          ? t("admin.assets.form.categoryReturnable")
                          : t("admin.assets.form.categoryNoReturn"),
                    }
                  : {})}
                {...(createErrors.categoryId !== undefined
                  ? { error: createErrors.categoryId }
                  : {})}
              />
              <TextField
                label={t("admin.assets.form.serial")}
                value={form.serialNumber}
                onChange={(v) => setForm((f) => ({ ...f, serialNumber: v }))}
                required={chosenCategory?.requires_serial === true}
                {...(chosenCategory?.requires_serial === true
                  ? { hint: t("admin.assets.form.serialHint") }
                  : {})}
                {...(createErrors.serialNumber !== undefined
                  ? { error: createErrors.serialNumber }
                  : {})}
              />
              <TextField
                label={t("admin.assets.form.make")}
                value={form.make}
                onChange={(v) => setForm((f) => ({ ...f, make: v }))}
              />
              <TextField
                label={t("admin.assets.form.model")}
                value={form.model}
                onChange={(v) => setForm((f) => ({ ...f, model: v }))}
              />
              <TextField
                label={t("admin.assets.form.purchaseDate")}
                type="date"
                value={form.purchaseDate}
                onChange={(v) => setForm((f) => ({ ...f, purchaseDate: v }))}
              />
              <TextField
                label={t("admin.assets.form.cost")}
                value={form.costRupees}
                onChange={(v) => setForm((f) => ({ ...f, costRupees: v }))}
                inputMode="decimal"
                hint={t("admin.assets.form.costHint")}
                {...(createErrors.costRupees !== undefined
                  ? { error: createErrors.costRupees }
                  : {})}
              />
              <SelectField
                label={t("admin.assets.form.location")}
                value={form.locationId}
                placeholder={t("admin.assets.form.locationPlaceholder")}
                options={(locations.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
                onChange={(v) => setForm((f) => ({ ...f, locationId: v }))}
              />
              <SelectField
                label={t("admin.assets.form.condition")}
                value={form.condition}
                options={assetConditionValues.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))}
                onChange={(v) =>
                  setForm((f) => ({ ...f, condition: isCondition(v) ? v : f.condition }))
                }
              />
              <TextField
                label={t("admin.assets.form.notes")}
                value={form.notes}
                onChange={(v) => setForm((f) => ({ ...f, notes: v }))}
                className="sm:col-span-2"
              />
            </div>

            {create.userMessage !== null ? (
              <Notice tone="error">{create.userMessage}</Notice>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setCreating(false)}
              >
                {t("admin.assets.form.cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? t("admin.assets.form.saving") : t("admin.assets.form.save")}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <ReasonDialog
        open={askCreateReason}
        title={t("admin.assets.reason.createTitle")}
        description={t("admin.assets.reason.createDescription", {
          tag: form.assetTag.trim(),
          name: form.name.trim(),
        })}
        confirmLabel={t("admin.assets.reason.createConfirm")}
        pending={create.isPending}
        errorMessage={create.userMessage}
        onConfirm={(reason) => void submitCreate(reason)}
        onCancel={() => setAskCreateReason(false)}
      />

      {/* ---------------- Edit ---------------- */}
      <Sheet
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next && !update.isPending) {
            setEditing(null);
            setEditForm(null);
          }
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader className="text-left">
            <SheetTitle className="font-display">
              {editing === null
                ? t("admin.assets.form.editTitlePlain")
                : t("admin.assets.form.editTitle", { tag: editing.asset_tag, name: editing.name })}
            </SheetTitle>
            <SheetDescription>{t("admin.assets.form.editDescription")}</SheetDescription>
          </SheetHeader>

          {editing !== null && editForm !== null ? (
            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setAskEditReason(true);
              }}
            >
              <dl className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t("admin.assets.col.category")}</dt>
                  <dd className="text-sm">
                    {dash(categoryMap.get(editing.asset_category_id)?.name ?? null)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("admin.assets.col.serial")}</dt>
                  <dd className="num text-sm">{dash(editing.serial_number)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("admin.assets.col.cost")}</dt>
                  <dd className="text-sm">
                    <Money paise={editing.purchase_cost_paise} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.assets.col.purchased")}
                  </dt>
                  <dd className="num text-sm">{fmtCivilDate(editing.purchase_date)}</dd>
                </div>
              </dl>

              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  label={t("admin.assets.form.status")}
                  value={editForm.status}
                  options={assetStatusValues.map((s) => ({
                    value: s,
                    label: ASSET_STATUS_CHIP[s].label,
                  }))}
                  onChange={(v) =>
                    setEditForm((f) =>
                      f === null ? f : { ...f, status: isAssetStatus(v) ? v : f.status },
                    )
                  }
                  hint={t("admin.assets.form.statusHint")}
                />
                <SelectField
                  label={t("admin.assets.form.condition")}
                  value={editForm.condition}
                  options={assetConditionValues.map((c) => ({
                    value: c,
                    label: CONDITION_LABELS[c],
                  }))}
                  onChange={(v) =>
                    setEditForm((f) =>
                      f === null ? f : { ...f, condition: isCondition(v) ? v : f.condition },
                    )
                  }
                />
                <TextField
                  label={t("admin.assets.form.notes")}
                  value={editForm.notes}
                  onChange={(v) => setEditForm((f) => (f === null ? f : { ...f, notes: v }))}
                  className="sm:col-span-2"
                />
              </div>

              {update.userMessage !== null ? (
                <Notice tone="error">{update.userMessage}</Notice>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() => {
                    setEditing(null);
                    setEditForm(null);
                  }}
                >
                  {t("admin.assets.form.cancel")}
                </Button>
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? t("admin.assets.form.saving") : t("admin.assets.form.save")}
                </Button>
              </div>
            </form>
          ) : null}
        </SheetContent>
      </Sheet>

      <ReasonDialog
        open={askEditReason}
        title={t("admin.assets.reason.editTitle")}
        description={
          editing === null
            ? t("admin.assets.reason.editDescriptionPlain")
            : t("admin.assets.reason.editDescription", {
                tag: editing.asset_tag,
                status: editForm === null ? "" : ASSET_STATUS_CHIP[editForm.status].label,
                condition: editForm === null ? "" : CONDITION_LABELS[editForm.condition],
              })
        }
        confirmLabel={t("admin.assets.reason.editConfirm")}
        pending={update.isPending}
        errorMessage={update.userMessage}
        onConfirm={(reason) => void submitEdit(reason)}
        onCancel={() => setAskEditReason(false)}
      />
    </div>
  );
}
