/**
 * assets.api.ts — reads and audited writes behind /admin/assets/* (spec §3.12,
 * migration 028).
 *
 * Relations, verified against supabase/migrations/20260801002800_assets.sql:
 *  * `asset_categories` — seeded with the 15 venue categories (046 §4);
 *    `is_consumable` splits the Consumable Stock screen from the register.
 *  * `assets` — the register. Admin RLS is FOR ALL (`assets__admin__all`), so
 *    create/edit from this console is sanctioned. DELETE is revoked; archive
 *    would be a soft delete.
 *  * `asset_allocations` — custody rows. Admin ALL scoped by
 *    `app.admin_scope_covers(employee_id)`. Issue and return are direct audited
 *    writes here: NO allocation RPC exists in any migration.
 *  * `asset_history` — append-only trail, INSERT granted to service_role ONLY
 *    ("written by the allocation RPCs / edge functions, never by clients").
 *    Those RPCs are not deployed, so this console CANNOT write history rows —
 *    the History screen says so instead of pretending.
 *  * `v_asset_custody` — open allocations (allocated/acknowledged/
 *    return_requested) with server-computed `days_in_custody` and
 *    `is_return_overdue`; employee labels come from the embedded
 *    v_employee_ref join.
 *
 * Known non-transactional seam, stated rather than hidden: issuing an asset is
 * an INSERT on asset_allocations then an UPDATE on assets.status (returning is
 * the mirror pair). PostgREST gives no cross-table transaction, and there is no
 * server function to do both. The allocation row is written FIRST because it is
 * the source of truth; a failure of the second statement surfaces as an error
 * so the admin retries the status update rather than losing the custody record.
 */
import { z } from "zod";
import { nowInstantIso } from "@/lib/datetime";
import {
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  ilike,
  inList,
  insertRow,
  isNotNull,
  isNull,
  isTrue,
  rpcAudited,
  selectCount,
  selectMany,
  updateRow,
  type Filter,
} from "@/shared/api/query";

export const ASSET_CATEGORIES_TABLE = "asset_categories";
export const ASSETS_TABLE = "assets";
export const ALLOCATIONS_TABLE = "asset_allocations";
export const ASSET_HISTORY_TABLE = "asset_history";
export const V_ASSET_CUSTODY = "v_asset_custody";

/** Hard caps — the venue's register is hundreds of rows, not thousands. */
export const ASSET_ROW_CAP = 500;
export const CUSTODY_ROW_CAP = 500;
export const HISTORY_ROW_CAP = 200;

// -----------------------------------------------------------------------------
// Vocabularies (CHECK constraints / enum in 028 + 003)
// -----------------------------------------------------------------------------

export const assetStatusValues = [
  "in_stock",
  "allocated",
  "in_repair",
  "lost",
  "retired",
  "written_off",
] as const;
export const assetStatusSchema = z.enum(assetStatusValues);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

export const assetConditionValues = ["new", "good", "fair", "poor", "unserviceable"] as const;
export const assetConditionSchema = z.enum(assetConditionValues);
export type AssetCondition = z.infer<typeof assetConditionSchema>;

export const allocationStatusValues = [
  "requested",
  "approved",
  "allocated",
  "acknowledged",
  "return_requested",
  "returned",
  "recalled",
  "lost",
  "damaged",
  "written_off",
  "transferred",
] as const;
export const allocationStatusSchema = z.enum(allocationStatusValues);
export type AllocationStatus = z.infer<typeof allocationStatusSchema>;

/** The custody view's WHERE clause — the "someone is holding it" states. */
export const OPEN_ALLOCATION_STATUSES = [
  "allocated",
  "acknowledged",
  "return_requested",
] as const satisfies readonly AllocationStatus[];

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

export const assetCategorySchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  sort_order: dbInt,
  is_consumable: z.boolean(),
  default_return_required: z.boolean(),
  requires_serial: z.boolean(),
  requires_acknowledgement: z.boolean(),
});
export type AssetCategory = z.infer<typeof assetCategorySchema>;

const CATEGORY_COLUMNS =
  "id, code, name, sort_order, is_consumable, default_return_required, " +
  "requires_serial, requires_acknowledgement";

export const assetSchema = z.object({
  id: dbUuid,
  asset_tag: z.string(),
  asset_category_id: dbUuid,
  company_id: dbUuid,
  location_id: dbUuidNullable,
  name: z.string(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  serial_number: z.string().nullable(),
  purchase_date: dbDateNullable,
  purchase_cost_paise: dbIntNullable,
  condition: assetConditionSchema,
  status: assetStatusSchema,
  quantity: dbNumeric,
  unit: z.string(),
  reorder_level: dbNumericNullable,
  custodian_employee_id: dbUuidNullable,
  notes: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type Asset = z.infer<typeof assetSchema>;

const ASSET_COLUMNS =
  "id, asset_tag, asset_category_id, company_id, location_id, name, make, model, " +
  "serial_number, purchase_date, purchase_cost_paise, condition, status, quantity, " +
  "unit, reorder_level, custodian_employee_id, notes, created_at, updated_at";

/** One row of v_asset_custody — every figure server-computed. */
export const custodyRowSchema = z.object({
  allocation_id: dbUuid,
  allocation_number: z.string(),
  asset_id: dbUuid,
  asset_tag: z.string(),
  asset_name: z.string(),
  asset_category_name: z.string().nullable(),
  serial_number: z.string().nullable(),
  condition: z.string(),
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  quantity: dbNumeric,
  status: allocationStatusSchema,
  allocated_at: dbTimestampNullable,
  days_in_custody: dbIntNullable,
  acknowledged_at: dbTimestampNullable,
  expected_return_date: dbDateNullable,
  is_return_overdue: z.boolean().nullable(),
  recall_requested_at: dbTimestampNullable,
});
export type CustodyRow = z.infer<typeof custodyRowSchema>;

export const allocationSchema = z.object({
  id: dbUuid,
  asset_id: dbUuid,
  employee_id: dbUuid,
  allocation_number: z.string(),
  quantity: dbNumeric,
  status: allocationStatusSchema,
  requested_at: dbTimestampNullable,
  allocated_at: dbTimestampNullable,
  expected_return_date: dbDateNullable,
  acknowledged_at: dbTimestampNullable,
  returned_at: dbTimestampNullable,
  return_condition: z.string().nullable(),
  recall_requested_at: dbTimestampNullable,
  recall_reason: z.string().nullable(),
  recovery_amount_paise: dbIntNullable,
  handover_notes: z.string().nullable(),
  created_at: dbTimestamp,
});
export type Allocation = z.infer<typeof allocationSchema>;

const ALLOCATION_COLUMNS =
  "id, asset_id, employee_id, allocation_number, quantity, status, requested_at, " +
  "allocated_at, expected_return_date, acknowledged_at, returned_at, return_condition, " +
  "recall_requested_at, recall_reason, recovery_amount_paise, handover_notes, created_at";

export const assetHistoryEventValues = [
  "created",
  "stock_in",
  "requested",
  "approved",
  "handed_over",
  "acknowledged",
  "transferred",
  "return_requested",
  "returned",
  "recalled",
  "repaired",
  "lost",
  "damaged",
  "written_off",
  "audited",
] as const;

export const assetHistorySchema = z.object({
  id: dbUuid,
  asset_id: dbUuid,
  allocation_id: dbUuidNullable,
  employee_id: dbUuidNullable,
  event: z.string(),
  from_employee_id: dbUuidNullable,
  to_employee_id: dbUuidNullable,
  quantity: dbNumericNullable,
  condition_before: z.string().nullable(),
  condition_after: z.string().nullable(),
  notes: z.string().nullable(),
  recorded_at: dbTimestamp,
});
export type AssetHistoryRow = z.infer<typeof assetHistorySchema>;

const HISTORY_COLUMNS =
  "id, asset_id, allocation_id, employee_id, event, from_employee_id, to_employee_id, " +
  "quantity, condition_before, condition_after, notes, recorded_at";

// -----------------------------------------------------------------------------
// Reads — categories
// -----------------------------------------------------------------------------

/** Active categories, venue sort order. RLS already hides inactive/deleted. */
export function fetchAssetCategories(signal?: AbortSignal): Promise<AssetCategory[]> {
  return selectMany(ASSET_CATEGORIES_TABLE, assetCategorySchema, {
    columns: CATEGORY_COLUMNS,
    order: [{ column: "sort_order", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Reads — the register
// -----------------------------------------------------------------------------

export interface AssetFilters {
  readonly statuses?: readonly AssetStatus[];
  readonly conditions?: readonly AssetCondition[];
  readonly categoryIds?: readonly string[];
  /** ilike on the human name. */
  readonly nameLike?: string;
  /** ilike on the asset tag. */
  readonly tagLike?: string;
}

/** ONE predicate builder feeds both rows and count (DR-29). */
function assetFilters(f: AssetFilters): readonly Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.conditions && f.conditions.length > 0) filters.push(inList("condition", f.conditions));
  if (f.categoryIds && f.categoryIds.length > 0)
    filters.push(inList("asset_category_id", f.categoryIds));
  if (f.nameLike !== undefined && f.nameLike !== "")
    filters.push(ilike("name", `%${f.nameLike}%`));
  if (f.tagLike !== undefined && f.tagLike !== "")
    filters.push(ilike("asset_tag", `%${f.tagLike}%`));
  return filters;
}

export function fetchAssets(f: AssetFilters, signal?: AbortSignal): Promise<Asset[]> {
  return selectMany(ASSETS_TABLE, assetSchema, {
    columns: ASSET_COLUMNS,
    filters: assetFilters(f),
    order: [{ column: "asset_tag", ascending: true }],
    limit: ASSET_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countAssets(f: AssetFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(ASSETS_TABLE, assetFilters(f), { ...(signal ? { signal } : {}) });
}

/** Cost/status lookup for rows another read already named — a join, not math. */
export function fetchAssetsByIds(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Asset[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return selectMany(ASSETS_TABLE, assetSchema, {
    columns: ASSET_COLUMNS,
    filters: [isNull("deleted_at"), inList("id", ids)],
    limit: ASSET_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Reads — custody (v_asset_custody) and per-asset trails
// -----------------------------------------------------------------------------

export interface CustodyFilters {
  /** Narrow within the view's open set (allocated/acknowledged/return_requested). */
  readonly statuses?: readonly AllocationStatus[];
  readonly employeeIds?: readonly string[];
  readonly assetId?: string;
  /** Only rows past their expected return date (server flag, never re-derived). */
  readonly overdueOnly?: boolean;
  /** Only rows that have an expected return date at all. */
  readonly dueOnly?: boolean;
  /** Only rows with a recall requested. */
  readonly recalledOnly?: boolean;
}

function custodyFilters(f: CustodyFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.employeeIds && f.employeeIds.length > 0)
    filters.push(inList("employee_id", f.employeeIds));
  if (f.assetId !== undefined && f.assetId !== "") filters.push(eq("asset_id", f.assetId));
  if (f.overdueOnly === true) filters.push(isTrue("is_return_overdue"));
  if (f.dueOnly === true) filters.push(isNotNull("expected_return_date"));
  if (f.recalledOnly === true) filters.push(isNotNull("recall_requested_at"));
  return filters;
}

export function fetchCustody(f: CustodyFilters, signal?: AbortSignal): Promise<CustodyRow[]> {
  return selectMany(V_ASSET_CUSTODY, custodyRowSchema, {
    filters: custodyFilters(f),
    // Oldest custody first: the longest-held item is the one to chase.
    order: [{ column: "allocated_at", ascending: true, nullsFirst: true }],
    limit: CUSTODY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countCustody(f: CustodyFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_ASSET_CUSTODY, custodyFilters(f), { ...(signal ? { signal } : {}) });
}

/** Every allocation ever made against one asset — the custody ledger. */
export function fetchAllocationsForAsset(
  assetId: string,
  signal?: AbortSignal,
): Promise<Allocation[]> {
  return selectMany(ALLOCATIONS_TABLE, allocationSchema, {
    columns: ALLOCATION_COLUMNS,
    filters: [eq("asset_id", assetId)],
    order: [{ column: "created_at", ascending: false }],
    limit: HISTORY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The append-only asset_history trail for one asset. Expected EMPTY on this
 * deployment: only the (undeployed) allocation RPCs may write it. Read anyway —
 * if the server side lands, the screen lights up without a frontend change.
 */
export function fetchAssetHistory(
  assetId: string,
  signal?: AbortSignal,
): Promise<AssetHistoryRow[]> {
  return selectMany(ASSET_HISTORY_TABLE, assetHistorySchema, {
    columns: HISTORY_COLUMNS,
    filters: [eq("asset_id", assetId)],
    order: [{ column: "recorded_at", ascending: false }],
    limit: HISTORY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Writes — all through the audited helpers, never raw
// -----------------------------------------------------------------------------

/**
 * Parse the rupee amount an admin typed into integer paise. String arithmetic
 * on the two halves — never a float multiply. This is write-side ENCODING of an
 * input; rendering money stays with <Money>/formatPaise.
 */
export function rupeesToPaise(rupees: string): number | null {
  const trimmed = rupees.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const parts = trimmed.split(".");
  const whole = parts[0] ?? "0";
  const frac = ((parts[1] ?? "") + "00").slice(0, 2);
  return Number(whole) * 100 + Number(frac);
}

export interface CreateAssetInput {
  readonly assetTag: string;
  readonly name: string;
  readonly categoryId: string;
  readonly companyId: string;
  readonly serialNumber?: string;
  readonly make?: string;
  readonly model?: string;
  /** YYYY-MM-DD. */
  readonly purchaseDate?: string;
  /** Integer paise (use rupeesToPaise on the typed value). */
  readonly purchaseCostPaise?: number;
  readonly locationId?: string;
  readonly condition?: AssetCondition;
  readonly notes?: string;
}

export function createAsset(input: CreateAssetInput, reason: string): Promise<Asset> {
  const text = (v: string | undefined): string | null => {
    const s = (v ?? "").trim();
    return s === "" ? null : s;
  };
  return insertRow(
    ASSETS_TABLE,
    {
      asset_tag: input.assetTag.trim(),
      name: input.name.trim(),
      asset_category_id: input.categoryId,
      company_id: input.companyId,
      serial_number: text(input.serialNumber),
      make: text(input.make),
      model: text(input.model),
      ...(input.purchaseDate !== undefined && input.purchaseDate !== ""
        ? { purchase_date: input.purchaseDate }
        : {}),
      ...(input.purchaseCostPaise !== undefined
        ? { purchase_cost_paise: input.purchaseCostPaise }
        : {}),
      ...(input.locationId !== undefined && input.locationId !== ""
        ? { location_id: input.locationId }
        : {}),
      condition: input.condition ?? "good",
      status: "in_stock",
      notes: text(input.notes),
    },
    assetSchema,
    { reason, columns: ASSET_COLUMNS },
  );
}

export interface UpdateAssetInput {
  readonly id: string;
  readonly status?: AssetStatus;
  readonly condition?: AssetCondition;
  readonly locationId?: string | null;
  readonly notes?: string | null;
}

export function updateAsset(input: UpdateAssetInput, reason: string): Promise<Asset> {
  return updateRow(
    ASSETS_TABLE,
    [eq("id", input.id)],
    {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.condition !== undefined ? { condition: input.condition } : {}),
      ...(input.locationId !== undefined ? { location_id: input.locationId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    assetSchema,
    { reason, columns: ASSET_COLUMNS },
  );
}

/*
  `newAllocationNumber` is gone with 042500: the reference is minted by
  `generate_allocation_number()` under an advisory lock, like every other
  reference in this schema. A browser generating one with Math.random() could
  collide on the UNIQUE index and produced references with no order.
*/

export interface IssueAssetInput {
  readonly assetId: string;
  readonly employeeId: string;
  /** YYYY-MM-DD; omit for an open-ended issue (uniform, access card). */
  readonly expectedReturnDate?: string;
  readonly notes?: string;
  /** The `asset_requests` row this fulfils, when the issue came from one. */
  readonly assetRequestId?: string;
}

/** The definer RPC from migration 042500. See `issueAsset` for why. */
export const ISSUE_ASSET_FN = "issue_asset";

/**
 * Hand an in-stock asset to an employee.
 *
 * ── THIS USED TO BE TWO WRITES AND A GUESSED REFERENCE ──────────────────────
 *
 * The previous implementation inserted the allocation, then updated the asset —
 * with a comment admitting the pair is not one transaction, because "PostgREST
 * has no cross-table transaction and no server function does both". A closed tab
 * between the two left a register saying the unit was in stock while somebody was
 * holding it.
 *
 * It also minted `allocation_number` in the BROWSER as `ALC-<date>-<4 random
 * chars>`, using Math.random(). Two people issuing at once could collide on the
 * UNIQUE index, and the reference carried no order — ALC-20260812-K3QP tells
 * nobody which was issued first.
 *
 * Migration 042500 supplies the server function the old comment said did not
 * exist. It does all three writes in one statement — allocation, asset status,
 * and closing the `asset_request` that asked for it — mints the reference with
 * an advisory lock the way every other reference in this schema is minted, and
 * refuses a unit that is not in stock with a sentence Stores can read.
 */
export async function issueAsset(input: IssueAssetInput, reason: string): Promise<Allocation> {
  const row = await rpcAudited(
    ISSUE_ASSET_FN,
    {
      p_asset_id: input.assetId,
      p_employee_id: input.employeeId,
      p_expected_return_date:
        input.expectedReturnDate !== undefined && input.expectedReturnDate !== ""
          ? input.expectedReturnDate
          : null,
      /* The request this closes, when the issue came from one. Absent for the
         uniform handed over on somebody's first day, which nobody requested. */
      p_asset_request_id: input.assetRequestId ?? null,
      p_notes: input.notes !== undefined && input.notes.trim() !== "" ? input.notes.trim() : null,
    },
    allocationSchema,
    { reason },
  );
  /* `rpcAudited` returns rows; a definer function returning one composite gives
     exactly one. An empty array means the function returned NULL, which it does
     not — but reading `[0]` without checking is how a screen renders undefined. */
  const issued = row[0];
  if (issued === undefined) {
    throw new Error("The asset was not issued. Check that it is still in stock.");
  }
  return issued;
}

export interface RequestRecallInput {
  readonly allocationId: string;
  /**
   * `profiles.id` of the signed-in admin (= the auth user id). REQUIRED, because
   * `ck_asset_allocations__recall_reason` refuses a recall whose
   * `recall_requested_by` is NULL — a recall with no named requester is not a
   * recall, it is an anonymous demand.
   */
  readonly actorProfileId: string;
}

/**
 * Ask a holder to bring an asset back. The typed sentence IS the recall reason
 * the holder reads on /me/assets, and is also the audit reason — the same CHECK
 * that demands a requester demands ≥10 characters of justification.
 *
 * `status` is deliberately NOT touched: the row stays in `v_asset_custody` (the
 * person still physically holds the thing) and only gains the recall stamps.
 * Closing it is `returnAsset`, when the item is actually handed back.
 */
export function requestRecall(input: RequestRecallInput, reason: string): Promise<Allocation> {
  return updateRow(
    ALLOCATIONS_TABLE,
    [eq("id", input.allocationId)],
    {
      recall_requested_at: nowInstantIso(),
      recall_requested_by: input.actorProfileId,
      recall_reason: reason,
    },
    allocationSchema,
    { reason, columns: ALLOCATION_COLUMNS },
  );
}

export interface ReturnAssetInput {
  readonly allocationId: string;
  readonly assetId: string;
  /** Condition as received back — recorded on both rows. */
  readonly condition: AssetCondition;
}

/** Close a custody row and put the asset back in stock. Same pairing as issue. */
export async function returnAsset(input: ReturnAssetInput, reason: string): Promise<Allocation> {
  const requestId = crypto.randomUUID();
  const allocation = await updateRow(
    ALLOCATIONS_TABLE,
    [eq("id", input.allocationId)],
    {
      status: "returned",
      returned_at: nowInstantIso(),
      return_condition: input.condition,
    },
    allocationSchema,
    { reason, requestId, columns: ALLOCATION_COLUMNS },
  );
  await updateRow(
    ASSETS_TABLE,
    [eq("id", input.assetId)],
    { status: "in_stock", condition: input.condition, custodian_employee_id: null },
    assetSchema,
    { reason, requestId, columns: ASSET_COLUMNS },
  );
  return allocation;
}
