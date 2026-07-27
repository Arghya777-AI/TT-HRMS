/**
 * useAssetsAdmin — the data layer behind the six /admin/assets/* screens, plus
 * the display vocabularies they share (a status word must read the same on the
 * register as it does on the returns queue).
 *
 * Three rules this file exists to keep:
 *
 *  1. EVERY FIGURE IS THE SERVER'S. Row counts come from `selectCount`
 *     (`HEAD … count=exact`) built from the SAME filter object the paged read
 *     uses, so a tile and the grid it filters cannot disagree (DR-29). Days in
 *     custody and the overdue flag are columns of `v_asset_custody`
 *     (`util.ist_today() - util.ist_date(allocated_at)` and
 *     `expected_return_date < util.ist_today()`) — never re-derived here.
 *  2. AN EMPTY ID LIST IS NOT "NO FILTER". `custodyFilters()` skips an empty
 *     `employeeIds` array, so passing one would silently widen the Exit
 *     Liability screen from "what leavers hold" to "what everyone holds". Every
 *     hook that filters by a fetched id list is `enabled` only when that list is
 *     non-empty, and resolves to `[]` / `0` otherwise.
 *  3. WRITES CARRY A REASON. Create, edit, issue, return and recall all go
 *     through `useAuditedMutation`, so the sentence the admin typed lands in
 *     `audit_log` with their name on it. There is no allocation RPC in any
 *     migration (checked 028 and 029): issue/return are the audited
 *     table writes `assets.api.ts` documents, and `asset_history` stays
 *     server-owned (INSERT is granted to service_role only).
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import {
  countAssets,
  countCustody,
  createAsset,
  fetchAllocationsForAsset,
  fetchAssetCategories,
  fetchAssetHistory,
  fetchAssets,
  fetchAssetsByIds,
  fetchCustody,
  issueAsset,
  requestRecall,
  returnAsset,
  updateAsset,
  type Allocation,
  type Asset,
  type AssetCategory,
  type AssetCondition,
  type AssetFilters,
  type AssetHistoryRow,
  type AssetStatus,
  type AllocationStatus,
  type CreateAssetInput,
  type CustodyFilters,
  type CustodyRow,
  type IssueAssetInput,
  type RequestRecallInput,
  type ReturnAssetInput,
  type UpdateAssetInput,
} from "../api/assets.api";
import {
  countEmployeeDirectory,
  fetchEmployeeOptions,
  type DirectoryRow,
  type EmploymentStatus,
} from "../api/employees.api";

// -----------------------------------------------------------------------------
// Display vocabularies — internal enum values never reach the screen (DR-53)
// -----------------------------------------------------------------------------

export const ASSET_STATUS_CHIP: Readonly<Record<AssetStatus, StatusChipEntry>> = {
  in_stock: { label: t("admin.assets.status.inStock"), tone: "success" },
  allocated: { label: t("admin.assets.status.allocated"), tone: "info" },
  in_repair: { label: t("admin.assets.status.inRepair"), tone: "warn" },
  lost: { label: t("admin.assets.status.lost"), tone: "danger" },
  retired: { label: t("admin.assets.status.retired"), tone: "neutral" },
  written_off: { label: t("admin.assets.status.writtenOff"), tone: "neutral" },
};

export const ALLOCATION_STATUS_CHIP: Readonly<Record<AllocationStatus, StatusChipEntry>> = {
  requested: { label: t("admin.assets.alloc.status.requested"), tone: "warn" },
  approved: { label: t("admin.assets.alloc.status.approved"), tone: "info" },
  allocated: { label: t("admin.assets.alloc.status.allocated"), tone: "info" },
  acknowledged: { label: t("admin.assets.alloc.status.acknowledged"), tone: "success" },
  return_requested: { label: t("admin.assets.alloc.status.returnRequested"), tone: "warn" },
  returned: { label: t("admin.assets.alloc.status.returned"), tone: "neutral" },
  recalled: { label: t("admin.assets.alloc.status.recalled"), tone: "warn" },
  lost: { label: t("admin.assets.alloc.status.lost"), tone: "danger" },
  damaged: { label: t("admin.assets.alloc.status.damaged"), tone: "danger" },
  written_off: { label: t("admin.assets.alloc.status.writtenOff"), tone: "neutral" },
  transferred: { label: t("admin.assets.alloc.status.transferred"), tone: "info" },
};

export const CONDITION_LABELS: Readonly<Record<AssetCondition, string>> = {
  new: t("admin.assets.condition.new"),
  good: t("admin.assets.condition.good"),
  fair: t("admin.assets.condition.fair"),
  poor: t("admin.assets.condition.poor"),
  unserviceable: t("admin.assets.condition.unserviceable"),
};

/**
 * The lifecycle states that make an open allocation an EXIT LIABILITY. Read off
 * `employees.employment_status` (migration 008 enum), not invented: a person on
 * notice, already exited, retired or absconding is one who will not be handing
 * the walkie-talkie back on their own initiative.
 */
export const LEAVER_STATUSES = [
  "on_notice",
  "exited",
  "retired",
  "absconding",
] as const satisfies readonly EmploymentStatus[];

export type LeaverStatus = (typeof LEAVER_STATUSES)[number];

// -----------------------------------------------------------------------------
// Query keys — flattened so two equivalent filter objects share a cache entry
// -----------------------------------------------------------------------------

function assetKey(f: AssetFilters): Record<string, unknown> {
  return {
    scope: "register",
    statuses: [...(f.statuses ?? [])].sort(),
    conditions: [...(f.conditions ?? [])].sort(),
    categoryIds: [...(f.categoryIds ?? [])].sort(),
    nameLike: f.nameLike ?? "",
    tagLike: f.tagLike ?? "",
  };
}

function custodyKey(f: CustodyFilters): Record<string, unknown> {
  return {
    scope: "custody",
    statuses: [...(f.statuses ?? [])].sort(),
    employeeIds: [...(f.employeeIds ?? [])].sort(),
    assetId: f.assetId ?? "",
    overdueOnly: f.overdueOnly === true,
    dueOnly: f.dueOnly === true,
    recalledOnly: f.recalledOnly === true,
  };
}

// -----------------------------------------------------------------------------
// Reads — categories
// -----------------------------------------------------------------------------

/** The 15 venue categories (seeded, migration 046 §4). Rarely changes. */
export function useAssetCategories(): UseQueryResult<AssetCategory[], Error> {
  return useQuery({
    queryKey: qk.assets.list({ scope: "categories" }),
    queryFn: ({ signal }) => fetchAssetCategories(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export type AssetCategoryMap = ReadonlyMap<string, AssetCategory>;

/** id → category, so a grid can label `asset_category_id`. A join, not a sum. */
export function useAssetCategoryMap(
  categories: readonly AssetCategory[] | undefined,
): AssetCategoryMap {
  return useMemo(() => {
    const map = new Map<string, AssetCategory>();
    for (const c of categories ?? []) map.set(c.id, c);
    return map as AssetCategoryMap;
  }, [categories]);
}

// -----------------------------------------------------------------------------
// Reads — the register
// -----------------------------------------------------------------------------

/**
 * The register, filtered by Postgres.
 *
 * `enabled` exists for one specific trap: `assetFilters()` DROPS an empty
 * `categoryIds` array, so a screen that is still waiting for its category list
 * would read the whole register and present it as "consumable stock". Pass
 * `false` until the predicate is real.
 */
export function useAssets(
  filters: AssetFilters,
  enabled = true,
): UseQueryResult<Asset[], Error> {
  return useQuery({
    queryKey: qk.assets.list(assetKey(filters)),
    queryFn: ({ signal }) => fetchAssets(filters, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

/**
 * How many assets match — counted by Postgres from the same predicate as
 * `useAssets`. A separate query so a failed count degrades to "—" on the header
 * while the grid still renders.
 */
export function useAssetCount(
  filters: AssetFilters,
  enabled = true,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.assets.list({ ...assetKey(filters), count: true }),
    queryFn: ({ signal }) => countAssets(filters, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

/** Cost/status lookup for asset ids another read already named. */
export function useAssetsByIds(ids: readonly string[]): UseQueryResult<Asset[], Error> {
  const sorted = useMemo(() => [...ids].sort(), [ids]);
  return useQuery({
    queryKey: qk.assets.list({ scope: "by-ids", ids: sorted }),
    queryFn: ({ signal }) => fetchAssetsByIds(sorted, signal),
    enabled: sorted.length > 0,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Reads — custody (v_asset_custody)
// -----------------------------------------------------------------------------

export function useCustody(filters: CustodyFilters): UseQueryResult<CustodyRow[], Error> {
  return useQuery({
    queryKey: qk.assets.list(custodyKey(filters)),
    queryFn: ({ signal }) => fetchCustody(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useCustodyCount(filters: CustodyFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.assets.list({ ...custodyKey(filters), count: true }),
    queryFn: ({ signal }) => countCustody(filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Open custody rows held by a KNOWN set of employees.
 *
 * Guarded on purpose: `custodyFilters()` drops an empty `employeeIds` array, so
 * an unguarded call with "no leavers" would return every open allocation and the
 * Exit Liability screen would accuse the whole venue.
 */
export function useCustodyForEmployees(
  employeeIds: readonly string[],
): UseQueryResult<CustodyRow[], Error> {
  const ids = useMemo(() => [...employeeIds].sort(), [employeeIds]);
  return useQuery({
    queryKey: qk.assets.list(custodyKey({ employeeIds: ids })),
    queryFn: ({ signal }) => fetchCustody({ employeeIds: ids }, signal),
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
  });
}

/** Same predicate, counted by Postgres. Zero when there is nobody to count. */
export function useCustodyCountForEmployees(
  employeeIds: readonly string[],
): UseQueryResult<number, Error> {
  const ids = useMemo(() => [...employeeIds].sort(), [employeeIds]);
  return useQuery({
    queryKey: qk.assets.list({ ...custodyKey({ employeeIds: ids }), count: true }),
    queryFn: ({ signal }) => countCustody({ employeeIds: ids }, signal),
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Reads — one asset's trail
// -----------------------------------------------------------------------------

/** Every allocation ever made against one asset, newest first. */
export function useAssetAllocations(
  assetId: string | null,
): UseQueryResult<Allocation[], Error> {
  return useQuery({
    queryKey: qk.assets.list({ scope: "allocations", assetId: assetId ?? "" }),
    queryFn: ({ signal }) => fetchAllocationsForAsset(assetId ?? "", signal),
    enabled: assetId !== null && assetId !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * The append-only `asset_history` trail. EXPECTED EMPTY on this deployment:
 * INSERT on that table is granted to `service_role` only ("written by the
 * allocation RPCs / edge functions, never by clients", migration 028 §4) and
 * those functions are not deployed. Read anyway — the day the server side lands,
 * the screen fills in with no frontend change.
 */
export function useAssetHistoryTrail(
  assetId: string | null,
): UseQueryResult<AssetHistoryRow[], Error> {
  return useQuery({
    queryKey: qk.assets.list({ scope: "history", assetId: assetId ?? "" }),
    queryFn: ({ signal }) => fetchAssetHistory(assetId ?? "", signal),
    enabled: assetId !== null && assetId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Reads — the leavers whose custody is a liability
// -----------------------------------------------------------------------------

/**
 * Employees in a leaver lifecycle state, filtered BY POSTGRES on
 * `v_admin_employee.employment_status`. Their ids feed the custody read; their
 * rows also carry the status chip the Exit Liability grid shows.
 */
export function useLeavers(
  statuses: readonly LeaverStatus[],
): UseQueryResult<DirectoryRow[], Error> {
  const sorted = useMemo(() => [...statuses].sort(), [statuses]);
  return useQuery({
    queryKey: qk.assets.list({ scope: "leavers", statuses: sorted }),
    queryFn: ({ signal }) => fetchEmployeeOptions({ statuses: sorted }, 500, signal),
    enabled: sorted.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * How many leavers there are, counted by POSTGRES over the same
 * `employment_status IN (…)` predicate `useLeavers` reads with.
 *
 * A separate query rather than `useLeavers().data.length`, because that read is
 * capped at 500 rows: the length of a capped page is the page size, not the
 * total, and a liability screen that quietly says "500 leavers" when there are
 * 512 is the DR-29 defect with money attached.
 */
export function useLeaverCount(
  statuses: readonly LeaverStatus[],
): UseQueryResult<number, Error> {
  const sorted = useMemo(() => [...statuses].sort(), [statuses]);
  return useQuery({
    queryKey: qk.assets.list({ scope: "leavers", statuses: sorted, count: true }),
    queryFn: ({ signal }) => countEmployeeDirectory({ statuses: sorted }, signal),
    enabled: sorted.length > 0,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes — every one audited, every one invalidating the whole assets domain
// -----------------------------------------------------------------------------

/**
 * One invalidation prefix for all six screens. Issuing an asset changes the
 * register row, the custody view, the returns queue and the exit-liability
 * total; refreshing only the grid in front of the admin is how two screens start
 * disagreeing.
 */
const ASSETS_PREFIX = [qk.assets.all];

export function useCreateAsset(): AuditedMutationResult<Asset, CreateAssetInput> {
  return useAuditedMutation<Asset, CreateAssetInput>({
    mutationFn: (input, reason) => createAsset(input, reason),
    invalidate: ASSETS_PREFIX,
  });
}

export function useUpdateAsset(): AuditedMutationResult<Asset, UpdateAssetInput> {
  return useAuditedMutation<Asset, UpdateAssetInput>({
    mutationFn: (input, reason) => updateAsset(input, reason),
    invalidate: ASSETS_PREFIX,
  });
}

/**
 * Hand an in-stock asset to an employee. Two statements (allocation row, then
 * the register's status + custodian) tied by one `request_id` — PostgREST has no
 * cross-table transaction and no server function does both, which
 * `assets.api.ts` states in its header rather than hiding.
 */
export function useIssueAsset(): AuditedMutationResult<Allocation, IssueAssetInput> {
  return useAuditedMutation<Allocation, IssueAssetInput>({
    mutationFn: (input, reason) => issueAsset(input, reason),
    invalidate: ASSETS_PREFIX,
  });
}

export function useReturnAsset(): AuditedMutationResult<Allocation, ReturnAssetInput> {
  return useAuditedMutation<Allocation, ReturnAssetInput>({
    mutationFn: (input, reason) => returnAsset(input, reason),
    invalidate: ASSETS_PREFIX,
  });
}

/**
 * Stamp a recall on an open allocation. The typed sentence is both the audit
 * reason and the `recall_reason` the holder reads, so the floor is the CHECK's
 * 10 characters — the same sentence, one audience more.
 */
export function useRequestRecall(): AuditedMutationResult<Allocation, RequestRecallInput> {
  return useAuditedMutation<Allocation, RequestRecallInput>({
    mutationFn: (input, reason) => requestRecall(input, reason),
    invalidate: ASSETS_PREFIX,
  });
}
