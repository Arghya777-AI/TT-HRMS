/**
 * apply-requests.api.ts — the shared reads behind the four E-10 request screens
 * (web punch, local claim, asset, certification), and the ONE client-facing way
 * a request enters the workflow engine.
 *
 * Everything here was verified against the migrations, because three of those
 * four screens turned out to have no server path at all and the screens have to
 * say so rather than pretend:
 *
 *  * `request_types` (029 §1, seeded by 046 §2) — 18 codes. RLS
 *    `request_types__all_read` gives every employee the active rows, so a screen
 *    can state its own SLA hours and withdrawal rule from the server instead of
 *    hard-coding them. There is NO `CERTIFICATION` code.
 *  * `approval_chains` + `approval_chain_levels` (029 §2/§3) — readable by
 *    `authenticated` (`approval_chains__all_read`, `acl__all_read`), so "who
 *    decides this, and above what amount" is a server fact on the screen. 046 §3
 *    seeds chains for ELEVEN of the 18 types only. `WEB_LOGIN` and
 *    `ASSET_REQUEST` are among the seven with none, and
 *    `create_approval_request` RAISES `no approval chain matches request type %`
 *    when it cannot resolve one — so those two requests cannot be raised at all
 *    today. Each screen proves that by READING the chain list for its own type
 *    and finding it empty, rather than by asserting it in prose.
 *  * `public.create_approval_request(p_request_type_code, p_subject_employee_id,
 *    p_detail_id, p_title, p_summary, p_amount, p_days, p_priority,
 *    p_on_behalf_of)` (029 §10) — SECURITY DEFINER, `GRANT EXECUTE ... TO
 *    authenticated` (029 line 1367). `p_detail_id` lands in
 *    `approval_requests.detail_id`, which is `NOT NULL`: a request can only be
 *    raised for a detail ROW THAT ALREADY EXISTS. `p_amount`/`p_days` are the
 *    chain selectors, and `approval_requests.amount` is `numeric(14,2)` RUPEES —
 *    not paise (046 seeds the claim chains at 10000, i.e. ₹10,000).
 *  * `web_punch_requests` — does NOT exist. It is named twice as a STRING (the
 *    `ck_request_types__detail_table` CHECK list in 029, and the `WEB_LOGIN` seed
 *    row in 046) and no migration creates the table.
 *
 * Nothing in this module mints a reference number, and nothing computes an
 * amount, a duration or a count.
 */
import { z } from "zod";
import {
  dbInt,
  dbNumericNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  isTrue,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import {
  APPROVAL_REQUESTS_TABLE,
  EMPLOYEE_DIRECTORY_VIEW,
  OPEN_APPROVAL_STATUSES,
  REQUEST_TYPES_TABLE,
  directoryEntrySchema,
  openRequestSchema,
  requestTypeSchema,
  type DirectoryEntry,
  type MyOpenRequests,
  type RequestType,
} from "./apply.api";

export const APPROVAL_CHAINS_TABLE = "approval_chains";
export const APPROVAL_CHAIN_LEVELS_TABLE = "approval_chain_levels";
export const CREATE_APPROVAL_REQUEST_FN = "create_approval_request";
export const MY_EMPLOYEE_VIEW = "v_my_employee";
export const ATTENDANCE_POLICIES_TABLE = "attendance_policies";
export const ASSET_CATEGORIES_TABLE = "asset_categories";

/** `request_types.code` values these four screens ask for, by name. */
export const REQUEST_CODE_WEB_PUNCH = "WEB_LOGIN";
export const REQUEST_CODE_LOCAL_CLAIM = "LOCAL_CLAIM";
export const REQUEST_CODE_ASSET = "ASSET_REQUEST";
/**
 * The certification screen's type code. Deliberately NOT in the 046 seed: no
 * `request_types` row has it, so the lookup returns null and the screen says
 * which row HR would have to seed. Never invented client-side.
 */
export const REQUEST_CODE_CERTIFICATION = "CERTIFICATION";

const REQUEST_TYPE_COLUMNS =
  "id, code, name, description, sort_order, detail_table, sla_hours, escalation_hours, " +
  "allows_withdrawal, requires_attachment, icon";

/**
 * One request type by its code, or null when HR has not switched it on (or, for
 * `CERTIFICATION`, has never had it to switch on).
 */
export async function fetchRequestTypeByCode(
  code: string,
  signal?: AbortSignal,
): Promise<RequestType | null> {
  return selectOne(
    REQUEST_TYPES_TABLE,
    requestTypeSchema,
    [eq("code", code), isTrue("is_active")],
    { columns: REQUEST_TYPE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// Routing — the chain that would decide this request
// -----------------------------------------------------------------------------

/**
 * `amount_from`/`amount_to` are `numeric` RUPEES on this table (046 seeds
 * 10000 / 10000.01 for the two claim chains), matching
 * `approval_requests.amount`. Render them with `formatINR`, never `<Money>`.
 */
export const approvalChainSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  amount_from: dbNumericNullable,
  amount_to: dbNumericNullable,
  days_from: dbNumericNullable,
  days_to: dbNumericNullable,
  priority: dbInt,
  is_default: z.boolean(),
});
export type ApprovalChain = z.infer<typeof approvalChainSchema>;

export const approvalChainLevelSchema = z.object({
  id: dbUuid,
  approval_chain_id: dbUuid,
  level: dbInt,
  approver_kind: z.string(),
  role: z.string().nullable(),
  specific_employee_id: dbUuidNullable,
  min_approvals: dbInt,
  is_optional: z.boolean(),
  notify_only: z.boolean(),
});
export type ApprovalChainLevel = z.infer<typeof approvalChainLevelSchema>;

export interface RequestRouting {
  readonly chains: ApprovalChain[];
  /** Levels of every chain above, in (chain, level) order. */
  readonly levels: ApprovalChainLevel[];
}

/**
 * Every active chain configured for one request type, with its levels.
 *
 * An EMPTY `chains` array is the finding, not a loading state: with no chain and
 * no `request_types.default_approval_chain_id`, `create_approval_request` raises
 * and the request cannot be submitted by anybody, through any client.
 */
export async function fetchRequestRouting(
  requestTypeId: string,
  signal?: AbortSignal,
): Promise<RequestRouting> {
  const chains = await selectMany(APPROVAL_CHAINS_TABLE, approvalChainSchema, {
    columns:
      "id, code, name, description, amount_from, amount_to, days_from, days_to, priority, is_default",
    filters: [eq("request_type_id", requestTypeId)],
    order: [
      { column: "priority", ascending: true },
      { column: "code", ascending: true },
    ],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
  if (chains.length === 0) return { chains, levels: [] };

  const levels = await selectMany(APPROVAL_CHAIN_LEVELS_TABLE, approvalChainLevelSchema, {
    columns:
      "id, approval_chain_id, level, approver_kind, role, specific_employee_id, " +
      "min_approvals, is_optional, notify_only",
    filters: [inList("approval_chain_id", chains.map((c) => c.id))],
    order: [
      { column: "approval_chain_id", ascending: true },
      { column: "level", ascending: true },
    ],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
  return { chains, levels };
}

// -----------------------------------------------------------------------------
// My requests of one type
// -----------------------------------------------------------------------------

const OPEN_REQUEST_COLUMNS =
  "id, request_number, request_type_id, detail_table, detail_id, subject_employee_id, title, " +
  "summary, amount, days, status, current_level, total_levels, current_approver_ids, " +
  "submitted_at, sla_due_at, decided_at, priority, request_types(code, name, icon)";

/**
 * The employee's undecided requests of ONE type, in the exact shape
 * `OpenRequestsGrid` renders — same table, same statuses and same approver
 * resolution as the launcher's list, so a per-type screen and `/me/apply` can
 * never disagree about the same request.
 */
export async function fetchMyOpenRequestsOfType(
  employeeId: string,
  requestTypeId: string,
  signal?: AbortSignal,
): Promise<MyOpenRequests> {
  const rows = await selectMany(APPROVAL_REQUESTS_TABLE, openRequestSchema, {
    columns: OPEN_REQUEST_COLUMNS,
    filters: [
      eq("subject_employee_id", employeeId),
      eq("request_type_id", requestTypeId),
      inList("status", OPEN_APPROVAL_STATUSES),
    ],
    order: [{ column: "submitted_at", ascending: false }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });

  const ids = [...new Set(rows.flatMap((r) => r.current_approver_ids))];
  if (ids.length === 0) return { rows, approvers: {} };

  const people = await selectMany(EMPLOYEE_DIRECTORY_VIEW, directoryEntrySchema, {
    columns: "id, employee_code, display_name, designation_name",
    filters: [inList("id", ids)],
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
  const approvers: Record<string, DirectoryEntry> = {};
  for (const person of people) approvers[person.id] = person;
  return { rows, approvers };
}

// -----------------------------------------------------------------------------
// Web-punch entitlement — the one thing that screen CAN read
// -----------------------------------------------------------------------------

const myPunchEntitlementSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  /** `employees.allow_web_punch` — the per-person switch (008 line 75). */
  allow_web_punch: z.boolean(),
  attendance_policy_id: dbUuidNullable,
  exclude_from_attendance: z.boolean(),
});

const punchPolicySchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  /** `attendance_policies.allow_web_punch` — the policy-level switch (014). */
  allow_web_punch: z.boolean(),
  regularization_window_days: dbInt,
  max_regularizations_per_month: dbInt,
});
export type PunchPolicy = z.infer<typeof punchPolicySchema>;

export interface WebPunchEntitlement {
  readonly employeeCode: string;
  readonly displayName: string;
  /** The per-employee switch. */
  readonly allowedForMe: boolean;
  readonly excludedFromAttendance: boolean;
  /** The policy row, or null when no policy is assigned to me. */
  readonly policy: PunchPolicy | null;
}

/**
 * Am I entitled to punch from outside the gate at all? Two switches, both
 * server-owned and both stated: `employees.allow_web_punch` (mine) and
 * `attendance_policies.allow_web_punch` (my policy's). Neither is a request
 * path — they are what a request path WOULD be checked against.
 */
export async function fetchWebPunchEntitlement(
  signal?: AbortSignal,
): Promise<WebPunchEntitlement | null> {
  const me = await selectOne(MY_EMPLOYEE_VIEW, myPunchEntitlementSchema, [], {
    columns:
      "id, employee_code, display_name, allow_web_punch, attendance_policy_id, " +
      "exclude_from_attendance",
    ...(signal ? { signal } : {}),
  });
  if (me === null) return null;

  const policy =
    me.attendance_policy_id === null
      ? null
      : await selectOne(
          ATTENDANCE_POLICIES_TABLE,
          punchPolicySchema,
          [eq("id", me.attendance_policy_id)],
          {
            columns:
              "id, code, name, allow_web_punch, regularization_window_days, " +
              "max_regularizations_per_month",
            ...(signal ? { signal } : {}),
          },
        );

  return {
    employeeCode: me.employee_code,
    displayName: me.display_name,
    allowedForMe: me.allow_web_punch,
    excludedFromAttendance: me.exclude_from_attendance,
    policy,
  };
}

// -----------------------------------------------------------------------------
// Asset categories — what Stores actually stocks
// -----------------------------------------------------------------------------

export const assetCategoryRefSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  sort_order: dbInt,
  is_consumable: z.boolean(),
  default_return_required: z.boolean(),
  requires_acknowledgement: z.boolean(),
});
export type AssetCategoryRef = z.infer<typeof assetCategoryRefSchema>;

/**
 * The venue's asset categories (028 §1, seeded by 046 §4).
 * `asset_categories__authenticated__select` gives every employee the active
 * rows, so the asset screen can show what Stores stocks even though it cannot
 * raise a request. `assets` itself is NOT readable by an employee unless a row
 * is already allocated to them (`assets__self__select`), which is exactly why no
 * catalogue picker can be built here.
 */
export function fetchAssetCategories(signal?: AbortSignal): Promise<AssetCategoryRef[]> {
  return selectMany(ASSET_CATEGORIES_TABLE, assetCategoryRefSchema, {
    columns:
      "id, code, name, sort_order, is_consumable, default_return_required, " +
      "requires_acknowledgement",
    order: [{ column: "sort_order", ascending: true }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}
