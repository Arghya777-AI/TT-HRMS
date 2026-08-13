/**
 * simple-requests.api.ts — resignation, travel requisition, document request.
 *
 * Three forms that had no submit path at all until now. Their tables landed in
 * migrations 040800/041100/041000; this is what turns those tables into
 * something an employee can actually use.
 *
 * ── ONE SHAPE, THREE TIMES ───────────────────────────────────────────────────
 *
 * Every request in this system is the same four steps, forced by the database
 * rather than chosen:
 *
 *   1. insert the detail row      — `approval_requests.detail_id` is NOT NULL,
 *   2. `create_approval_request`     so the row must exist before anything can
 *   3. back-link the request id      point at it,
 *   4. read the request number     which only the server can mint.
 *
 * `raiseSimpleRequest` below is that sequence, once. Each of the three public
 * functions supplies its own row and title and gets the same guarantees — and,
 * more importantly, the same FAILURE behaviour: if step 2 raises, the detail row
 * survives as a `pending` row its owner can see, rather than an approval request
 * pointing at nothing.
 *
 * ── WHAT IS NOT DONE HERE ────────────────────────────────────────────────────
 *
 * No reference number is invented. `trg_resign__number` and
 * `trg_tr__requisition_number` mint theirs the way `generate_claim_number` does,
 * so those columns are omitted from every insert. A browser that guesses a
 * sequence value is a browser that collides with another browser.
 *
 * No amount is converted by arithmetic: `rupeesToPaise` from claim-submit does
 * the string encoding, so ₹1,234.56 cannot arrive as 123455.99999.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbIntNullable,
  dbTimestamp,
  dbUuid,
  eq,
  inList,
  rpcOne,
  selectMany,
} from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";
import { approvalStatusSchema } from "./apply.api";
import { CREATE_APPROVAL_REQUEST_FN } from "./apply-requests.api";
import { rupeesToPaise } from "./claim-submit.api";

export const RESIGNATIONS_TABLE = "resignations";
export const TRAVEL_REQUISITIONS_TABLE = "travel_requisitions";
export const DOCUMENT_REQUESTS_TABLE = "document_requests";

export const REQUEST_CODE_RESIGNATION = "RESIGNATION";
export const REQUEST_CODE_TRAVEL = "TRAVEL_REQUISITION";
export const REQUEST_CODE_DOCUMENT = "DOCUMENT_REQUEST";
export const REQUEST_CODE_PAYSLIP = "PAYSLIP_REQUEST";

const idSchema = z.object({ id: dbUuid });

/**
 * The four steps, once.
 *
 * Returns the detail row's id and the approval request id. The caller decides
 * what to show; this decides nothing about presentation.
 *
 * Exported because it is the shape of EVERY request in this system, not a
 * private detail of these three. `certification.api.ts` uses it verbatim — a
 * sixth copy of the same four steps is a sixth place for one of them to be
 * forgotten, and the step that gets forgotten is always the third.
 */
export async function raiseSimpleRequest(args: {
  readonly table: string;
  readonly row: Record<string, unknown>;
  readonly requestCode: string;
  readonly employeeId: string;
  readonly title: string;
  readonly summary: Record<string, unknown>;
  readonly amountRupees: number | null;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ detailId: string; requestId: string }> {
  const { signal } = args;

  const detail = await insertOne(args.table, idSchema, args.row, {
    columns: "id",
    ...(signal ? { signal } : {}),
  });

  const requestId = await rpcOne(
    CREATE_APPROVAL_REQUEST_FN,
    {
      p_request_type_code: args.requestCode,
      p_subject_employee_id: args.employeeId,
      p_detail_id: detail.id,
      p_title: args.title,
      p_summary: args.summary,
      p_amount: args.amountRupees,
      p_days: null,
      p_priority: "normal",
      p_on_behalf_of: null,
    },
    dbUuid,
    signal ? { signal } : {},
  );
  if (requestId === null) {
    throw new Error("The record was saved but the approval request was not created.");
  }

  await updateOne(
    args.table,
    idSchema,
    { approval_request_id: requestId },
    { id: detail.id },
    { columns: "id", ...(signal ? { signal } : {}) },
  );

  return { detailId: detail.id, requestId };
}

// -----------------------------------------------------------------------------
// Resignation
// -----------------------------------------------------------------------------

/** `ck_resign__reason_category` — a closed vocabulary, restated. */
export const resignationReasonValues = [
  "better_opportunity",
  "higher_studies",
  "relocation",
  "health",
  "family",
  "compensation",
  "work_environment",
  "career_change",
  "personal",
  "other",
] as const;
export type ResignationReason = (typeof resignationReasonValues)[number];

export const resignationRowSchema = z.object({
  id: dbUuid,
  resignation_number: z.string(),
  submitted_on: dbDateNullable,
  intended_last_working_day: z.string(),
  notice_period_days: dbIntNullable,
  reason_category: z.string(),
  status: approvalStatusSchema,
  approval_request_id: dbUuid.nullable(),
  created_at: dbTimestamp,
});
export type ResignationRow = z.infer<typeof resignationRowSchema>;

const RESIGNATION_COLUMNS =
  "id, resignation_number, submitted_on, intended_last_working_day, notice_period_days, " +
  "reason_category, status, approval_request_id, created_at";

export function fetchMyResignations(
  employeeId: string,
  signal?: AbortSignal,
): Promise<ResignationRow[]> {
  return selectMany(RESIGNATIONS_TABLE, resignationRowSchema, {
    columns: RESIGNATION_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "created_at", ascending: false }],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
}

export interface SubmitResignationInput {
  readonly employeeId: string;
  /** `employees.notice_period_days` — the server's figure, never typed here. */
  readonly noticePeriodDays: number;
  readonly intendedLastWorkingDay: string;
  readonly reasonCategory: ResignationReason;
  readonly reason: string;
  /**
   * Asking to leave before the notice period is up.
   *
   * `ck_resign__notice_or_waiver` permits an early last working day ONLY when
   * this is set — it is the sanctioned way to be short, and it does not grant
   * anything: HR still decides. Without it the row is refused outright, which is
   * what employees were hitting with no way forward.
   */
  readonly isNoticeWaiverRequested: boolean;
  /** Required by `ck_resign__waiver_reason` whenever the waiver is asked for. */
  readonly waiverReason: string;
}

export function submitResignation(
  input: SubmitResignationInput,
  signal?: AbortSignal,
): Promise<{ detailId: string; requestId: string }> {
  return raiseSimpleRequest({
    table: RESIGNATIONS_TABLE,
    // `resignation_number` omitted: trg_resign__number mints it.
    row: {
      employee_id: input.employeeId,
      notice_period_days: input.noticePeriodDays,
      intended_last_working_day: input.intendedLastWorkingDay,
      reason_category: input.reasonCategory,
      reason: input.reason.trim(),
      is_notice_waiver_requested: input.isNoticeWaiverRequested,
      /* NULL, not "", when no waiver is asked for: the CHECK tests for a
         non-blank string and an empty one would fail it while looking set. */
      waiver_reason: input.isNoticeWaiverRequested
        ? (input.waiverReason.trim() === "" ? null : input.waiverReason.trim())
        : null,
      status: "pending",
    },
    requestCode: REQUEST_CODE_RESIGNATION,
    employeeId: input.employeeId,
    title: `Resignation · last day ${input.intendedLastWorkingDay}`,
    summary: {
      summary: input.reason.trim(),
      reason_category: input.reasonCategory,
      intended_last_working_day: input.intendedLastWorkingDay,
      notice_period_days: input.noticePeriodDays,
      notice_waiver_requested: input.isNoticeWaiverRequested,
    },
    amountRupees: null,
    signal,
  });
}

/** Resignations that still count against `uq_resign__one_open`. */
export const OPEN_RESIGNATION_STATUSES = ["draft", "pending", "in_progress"] as const;

/**
 * The one resignation blocking another, if there is one.
 *
 * `uq_resign__one_open` is a partial unique index over exactly these three
 * statuses, so this asks the same question the index does. Withdrawn, rejected
 * and cancelled rows are outside the predicate — somebody who withdraws can
 * genuinely file again, and the screen must not pretend otherwise.
 */
export async function fetchOpenResignation(
  employeeId: string,
  signal?: AbortSignal,
): Promise<ResignationRow | null> {
  const rows = await selectMany(RESIGNATIONS_TABLE, resignationRowSchema, {
    columns: RESIGNATION_COLUMNS,
    filters: [
      eq("employee_id", employeeId),
      inList("status", [...OPEN_RESIGNATION_STATUSES]),
    ],
    order: [{ column: "created_at", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return rows[0] ?? null;
}

/**
 * Take it back.
 *
 * `resign__self__update` permits the employee to move their own row from
 * draft/pending to `withdrawn`, which is the sanctioned undo — the row survives
 * as a record that it happened and was taken back, rather than vanishing. Once
 * withdrawn it leaves `uq_resign__one_open`'s predicate, so a fresh resignation
 * can be filed immediately.
 *
 * A row already decided is refused by the policy's USING clause, not by this
 * function: a manager approving while the employee withdraws is a race the
 * database settles, and whoever loses is told.
 */
export function withdrawResignation(
  resignationId: string,
  signal?: AbortSignal,
): Promise<ResignationRow> {
  return updateOne(
    RESIGNATIONS_TABLE,
    resignationRowSchema,
    { status: "withdrawn" },
    { id: resignationId },
    { columns: RESIGNATION_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// Travel requisition
// -----------------------------------------------------------------------------

export interface SubmitTravelInput {
  readonly employeeId: string;
  readonly fromLocation: string;
  readonly toLocation: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly purpose: string;
  /** Exactly what was typed; encoded by string arithmetic, never `* 100`. */
  readonly estimatedCostRupees: string;
  readonly advanceRupees: string;
}

export function submitTravelRequisition(
  input: SubmitTravelInput,
  signal?: AbortSignal,
): Promise<{ detailId: string; requestId: string }> {
  const estimated = input.estimatedCostRupees.trim() === ""
    ? null
    : rupeesToPaise(input.estimatedCostRupees);
  const advance = input.advanceRupees.trim() === "" ? null : rupeesToPaise(input.advanceRupees);
  if (
    (input.estimatedCostRupees.trim() !== "" && estimated === null) ||
    (input.advanceRupees.trim() !== "" && advance === null)
  ) {
    throw new Error("Amounts must be rupee figures with at most two decimals.");
  }

  return raiseSimpleRequest({
    table: TRAVEL_REQUISITIONS_TABLE,
    // `requisition_number` omitted: trg_tr__requisition_number mints it.
    row: {
      employee_id: input.employeeId,
      from_location: input.fromLocation.trim(),
      to_location: input.toLocation.trim(),
      from_date: input.fromDate,
      to_date: input.toDate,
      purpose: input.purpose.trim(),
      estimated_cost_paise: estimated,
      advance_amount_paise: advance,
      status: "pending",
    },
    requestCode: REQUEST_CODE_TRAVEL,
    employeeId: input.employeeId,
    title: `Travel · ${input.fromLocation.trim()} → ${input.toLocation.trim()}`,
    summary: {
      summary: input.purpose.trim(),
      from_location: input.fromLocation.trim(),
      to_location: input.toLocation.trim(),
      from_date: input.fromDate,
      to_date: input.toDate,
    },
    /*
      RUPEES, not paise. `approval_requests.amount` is numeric(14,2) in rupees —
      the unit the chain's amount bands are written in — while the detail row is
      integer paise. Both come from the same typed string; neither is derived
      from the other by division.
    */
    amountRupees: estimated === null ? null : Number(input.estimatedCostRupees.replace(/,/g, "")),
    signal,
  });
}

// -----------------------------------------------------------------------------
// Document / payslip request
// -----------------------------------------------------------------------------

/** `ck_dr__document_kind` — what an employee can ask HR to issue. */
export const documentKindValues = [
  "payslip",
  "salary_certificate",
  "form16",
  "employment_letter",
  "experience_letter",
  "relieving_letter",
  "appointment_letter",
  "increment_letter",
  "address_proof",
  "bank_letter",
  "visa_letter",
  "noc",
  "other",
] as const;
export type DocumentKind = (typeof documentKindValues)[number];

export interface SubmitDocumentRequestInput {
  readonly employeeId: string;
  readonly documentKind: DocumentKind;
  /** Who the letter should be addressed to, when that matters (a bank, a consulate). */
  readonly addressedTo: string;
  readonly note: string;
  /** Only meaningful for a payslip or Form 16; `trg_dr__period` checks the pair. */
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
}

export function submitDocumentRequest(
  input: SubmitDocumentRequestInput,
  signal?: AbortSignal,
): Promise<{ detailId: string; requestId: string }> {
  const addressedTo = input.addressedTo.trim();
  return raiseSimpleRequest({
    table: DOCUMENT_REQUESTS_TABLE,
    row: {
      employee_id: input.employeeId,
      /*
        `ck_dr__request_kind` permits exactly 'DOCUMENT_REQUEST' and
        'PAYSLIP_REQUEST' — the request_type CODES, not lower-case words. Two
        request types share this one table and this column is what tells them
        apart; getting it wrong fails the insert outright, which is what the
        first draft of this line did.
      */
      request_kind: input.documentKind === "payslip" ? "PAYSLIP_REQUEST" : "DOCUMENT_REQUEST",
      document_kind: input.documentKind,
      addressed_to: addressedTo === "" ? null : addressedTo,
      note: input.note.trim(),
      period_from: input.periodFrom,
      period_to: input.periodTo,
      status: "pending",
    },
    /*
      Routed as the type that matches the kind. PAYSLIP_REQUEST and
      DOCUMENT_REQUEST share a detail table but are separate request types with
      their own chains, so a payslip asked for under DOCUMENT_REQUEST would be
      approved by the wrong route.
    */
    requestCode:
      input.documentKind === "payslip" ? REQUEST_CODE_PAYSLIP : REQUEST_CODE_DOCUMENT,
    employeeId: input.employeeId,
    title: `Document · ${input.documentKind}`,
    summary: {
      summary: input.note.trim(),
      document_kind: input.documentKind,
      addressed_to: addressedTo === "" ? null : addressedTo,
      period_from: input.periodFrom,
      period_to: input.periodTo,
    },
    amountRupees: null,
    signal,
  });
}

// -----------------------------------------------------------------------------
// Asset request
// -----------------------------------------------------------------------------

/**
 * `asset_requests` — NOT `asset_allocations`.
 *
 * `request_types.ASSET_REQUEST` pointed at the allocation register until
 * migration 041400 repointed it. That register is the record of who holds which
 * physical unit: `asset_id` is NOT NULL and `allocation_number` is NOT NULL and
 * UNIQUE with no minting trigger, so a REQUEST — which names no unit and has no
 * number — could not be written to it without inventing both. The new table
 * names a CATEGORY, which is the thing an employee can actually read.
 */
export const ASSET_REQUESTS_TABLE = "asset_requests";
export const REQUEST_CODE_ASSET_REQUEST = "ASSET_REQUEST";

/** `ck_asr__quantity` — restated so the stepper cannot offer a rejected number. */
export const ASSET_REQUEST_MAX_QUANTITY = 20;

export interface SubmitAssetRequestInput {
  readonly employeeId: string;
  readonly assetCategoryId: string;
  /** For the title only — the id is what is stored. */
  readonly assetCategoryName: string;
  readonly quantity: number;
  readonly reason: string;
  readonly neededBy: string | null;
  readonly isReplacement: boolean;
  /**
   * The unit being replaced. `trg_asr__check` verifies it is actually allocated
   * to this employee, so a stale picker cannot smuggle in someone else's laptop.
   */
  readonly replacesAssetId: string | null;
}

export function submitAssetRequest(
  input: SubmitAssetRequestInput,
  signal?: AbortSignal,
): Promise<{ detailId: string; requestId: string }> {
  return raiseSimpleRequest({
    table: ASSET_REQUESTS_TABLE,
    row: {
      employee_id: input.employeeId,
      asset_category_id: input.assetCategoryId,
      quantity: input.quantity,
      reason: input.reason.trim(),
      needed_by: input.neededBy,
      is_replacement: input.isReplacement,
      /*
        `ck_asr__replacement_pair` permits a unit id only on a replacement. The
        checkbox is what the employee sees, so it is the checkbox that decides —
        clearing the box drops the id rather than leaving a stale one behind to
        fail the insert.
      */
      replaces_asset_id: input.isReplacement ? input.replacesAssetId : null,
      status: "pending",
    },
    requestCode: REQUEST_CODE_ASSET_REQUEST,
    employeeId: input.employeeId,
    title: `Asset · ${input.assetCategoryName}${input.quantity > 1 ? ` × ${String(input.quantity)}` : ""}`,
    summary: {
      summary: input.reason.trim(),
      category: input.assetCategoryName,
      quantity: input.quantity,
      needed_by: input.neededBy,
      is_replacement: input.isReplacement,
    },
    /*
      No amount. `assets.purchase_cost_paise` is a property of the UNIT, and no
      unit is named yet — AC-ASSET is unbanded for exactly this reason (041300),
      so a figure here would be a number nothing reads.
    */
    amountRupees: null,
    signal,
  });
}
