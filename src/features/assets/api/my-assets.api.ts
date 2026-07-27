/**
 * my-assets.api.ts — the employee's own custody: what I hold, what Stores is
 * waiting for me to confirm, and what is due back.
 *
 * Verified against the migrations before a line was written:
 *
 *  * `v_asset_custody` (037 §7) is `security_invoker = true` and
 *    `GRANT SELECT … TO authenticated` (037 §13), and its base table carries
 *    `asset_allocations__self__select` (`employee_id = app.current_employee_id()`).
 *    So the SAME view the Stores console reads returns only MY rows here. The
 *    employee-id filter below is therefore belt-and-braces for the query key,
 *    not the security boundary.
 *  * Every figure on this screen is a view column: `days_in_custody`
 *    (`util.ist_today() - util.ist_date(allocated_at)`) and `is_return_overdue`
 *    (`expected_return_date < util.ist_today()`) are computed in Postgres. The
 *    client counts nothing and subtracts no dates.
 *  * The view's WHERE clause is `status IN ('allocated','acknowledged',
 *    'return_requested')`, so anything I have merely ASKED for is invisible in
 *    it. Those rows are read separately from `asset_allocations` (self SELECT,
 *    same policy) with the asset embedded — `assets__self__select` permits the
 *    join for exactly the assets already tied to me.
 *
 * WHAT IS NOT HERE, AND WHY NOTHING FAKES IT: acknowledging custody. 028 grants
 * the employee SELECT and INSERT on `asset_allocations` and nothing else — there
 * is no `asset_allocations__self__update` policy and no acknowledgement RPC in
 * any migration, so `acknowledged_at` cannot be stamped by the person holding
 * the asset. The screen shows the outstanding confirmations and says who can
 * record them.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbNumeric,
  dbTimestampNullable,
  dbUuid,
  eq,
  inList,
  isNotNull,
  isNull,
  isTrue,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import {
  ALLOCATIONS_TABLE,
  V_ASSET_CUSTODY,
  allocationStatusSchema,
  custodyRowSchema,
  type CustodyRow,
} from "@/features/admin/api/assets.api";

export { V_ASSET_CUSTODY, ALLOCATIONS_TABLE };
export type { CustodyRow };

/** Row cap: a venue employee holds uniform, tools and a locker key, not 200 rows. */
const CUSTODY_ROW_CAP = 100;

/**
 * The sections of E-11. Each one is a SERVER filter set, and the tile count and
 * the grid below it are built from the identical array — that is what stops a
 * tile from disagreeing with its own list.
 */
export type CustodyView = "all" | "confirm" | "overdue" | "recall";

export const CUSTODY_VIEWS = ["all", "confirm", "overdue", "recall"] as const;

export function isCustodyView(value: string | null): value is CustodyView {
  return value !== null && (CUSTODY_VIEWS as readonly string[]).includes(value);
}

/**
 * `view` → the predicate, in the view's own columns.
 *
 *  * `confirm`  — handed over but `acknowledged_at IS NULL`: Stores is waiting.
 *  * `overdue`  — the view's own `is_return_overdue` boolean.
 *  * `recall`   — `recall_requested_at IS NOT NULL`: someone has asked for it back.
 */
export function custodyFiltersFor(employeeId: string, view: CustodyView): readonly Filter[] {
  const base: Filter[] = [eq("employee_id", employeeId)];
  if (view === "confirm") return [...base, isNull("acknowledged_at")];
  if (view === "overdue") return [...base, isTrue("is_return_overdue")];
  if (view === "recall") return [...base, isNotNull("recall_requested_at")];
  return base;
}

const CUSTODY_COLUMNS =
  "allocation_id, allocation_number, asset_id, asset_tag, asset_name, asset_category_name, " +
  "serial_number, condition, employee_id, employee_code, display_name, department_name, " +
  "quantity, status, allocated_at, days_in_custody, acknowledged_at, expected_return_date, " +
  "is_return_overdue, recall_requested_at";

/** My open custody rows for one section, oldest custody first. */
export function fetchMyCustody(
  employeeId: string,
  view: CustodyView,
  signal?: AbortSignal,
): Promise<CustodyRow[]> {
  return selectMany(V_ASSET_CUSTODY, custodyRowSchema, {
    columns: CUSTODY_COLUMNS,
    filters: custodyFiltersFor(employeeId, view),
    // Longest-held first: the item most likely to need returning is at the top.
    order: [{ column: "allocated_at", ascending: true }],
    limit: CUSTODY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** `count=exact` from Postgres for one section — never `rows.length`. */
export function countMyCustody(
  employeeId: string,
  view: CustodyView,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_ASSET_CUSTODY, custodyFiltersFor(employeeId, view), {
    ...(signal ? { signal } : {}),
  });
}

export interface MyCustodyCounts {
  readonly all: number;
  readonly confirm: number;
  readonly overdue: number;
  readonly recall: number;
}

/** The four tiles, each counted by the database over the same filters as its grid. */
export async function fetchMyCustodyCounts(
  employeeId: string,
  signal?: AbortSignal,
): Promise<MyCustodyCounts> {
  const [all, confirm, overdue, recall] = await Promise.all([
    countMyCustody(employeeId, "all", signal),
    countMyCustody(employeeId, "confirm", signal),
    countMyCustody(employeeId, "overdue", signal),
    countMyCustody(employeeId, "recall", signal),
  ]);
  return { all, confirm, overdue, recall };
}

// -----------------------------------------------------------------------------
// Asked for, not yet handed over — the states the custody view excludes
// -----------------------------------------------------------------------------

/** `asset_allocation_status` values that mean "not in my hands yet" (028). */
export const PIPELINE_ALLOCATION_STATUSES = ["requested", "approved"] as const;

export const pipelineAllocationSchema = z.object({
  id: dbUuid,
  allocation_number: z.string(),
  asset_id: dbUuid,
  quantity: dbNumeric,
  status: allocationStatusSchema,
  requested_at: dbTimestampNullable,
  expected_return_date: dbDateNullable,
  /** Embedded via `fk_asset_allocations__asset_id`; `assets__self__select` allows it. */
  assets: z.object({ asset_tag: z.string(), name: z.string() }).nullable(),
});
export type PipelineAllocation = z.infer<typeof pipelineAllocationSchema>;

const PIPELINE_COLUMNS =
  "id, allocation_number, asset_id, quantity, status, requested_at, expected_return_date, " +
  "assets(asset_tag, name)";

/**
 * Allocations raised for me that Stores has not handed over yet. Read from the
 * table rather than the view because `v_asset_custody` deliberately excludes
 * `requested`/`approved` — an item on order is not custody.
 */
export function fetchMyPipelineAllocations(
  employeeId: string,
  signal?: AbortSignal,
): Promise<PipelineAllocation[]> {
  return selectMany(ALLOCATIONS_TABLE, pipelineAllocationSchema, {
    columns: PIPELINE_COLUMNS,
    filters: [
      eq("employee_id", employeeId),
      inList("status", PIPELINE_ALLOCATION_STATUSES),
    ],
    order: [{ column: "requested_at", ascending: false }],
    limit: CUSTODY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}
