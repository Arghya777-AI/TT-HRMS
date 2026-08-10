/**
 * web-punch-submit.api.ts — raise a request to punch from outside the gate.
 *
 * The screen this serves has said "A web punch cannot be requested yet" since it
 * was written, and it was telling the truth: `request_types.WEB_LOGIN` names a
 * detail table `web_punch_requests` that no migration created, and
 * `create_approval_request` refuses a request it cannot attach to a row. That
 * table exists as of migration 040900, along with chain `AC-WEBPUNCH`, so this
 * module is the part that was missing.
 *
 * ── THE SAME FOUR STEPS AS A CLAIM, IN THE SAME ORDER ────────────────────────
 *
 * detail row → `create_approval_request` → back-link. The order is forced by the
 * database, not chosen: `approval_requests.detail_id` is NOT NULL, so the row
 * must exist before a request can point at it. If step 2 fails, the request
 * survives as a `pending` row its owner can see and resubmit — the opposite
 * arrangement would leave an approval pointing at nothing.
 *
 * ── WHAT THE SERVER CHECKS, SO THIS DOES NOT PRETEND TO ──────────────────────
 *
 * `trg_wpr__entitlement` refuses a request from someone not entitled to punch
 * off-site — the screen already reads and displays both switches, but the
 * trigger is what enforces it. `ck_wpr__not_future` refuses a punch dated in the
 * future, and `ck_wpr__employee_reason` a reason that is too short. All three
 * arrive as 23514 and are rendered verbatim by `isRuleRejection`, so this module
 * does not re-word them.
 */
import { z } from "zod";
import { dbTimestamp, dbUuid, eq, rpcOne, selectMany } from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";
import { approvalStatusSchema } from "./apply.api";
import { CREATE_APPROVAL_REQUEST_FN } from "./apply-requests.api";

export const WEB_PUNCH_REQUESTS_TABLE = "web_punch_requests";

/** `request_types.code` for a web punch — the seed calls it WEB_LOGIN. */
export const REQUEST_CODE_WEB_PUNCH = "WEB_LOGIN";

/**
 * `public.punch_direction`, restated so a select cannot offer a value the
 * insert would reject.
 *
 * `undetermined` is deliberately NOT offered: it is what the attendance engine
 * writes when it cannot tell in from out, never something a person asks for.
 */
export const webPunchDirectionValues = ["in", "out", "break_start", "break_end"] as const;
export const webPunchDirectionSchema = z.enum(webPunchDirectionValues);
export type WebPunchDirection = z.infer<typeof webPunchDirectionSchema>;

export const webPunchRowSchema = z.object({
  id: dbUuid,
  requested_punch_at: dbTimestamp,
  ist_date: z.string(),
  direction: z.string(),
  employee_reason: z.string(),
  status: approvalStatusSchema,
  approval_request_id: dbUuid.nullable(),
  decision_comment: z.string().nullable(),
  created_at: dbTimestamp,
});
export type WebPunchRow = z.infer<typeof webPunchRowSchema>;

const COLUMNS =
  "id, requested_punch_at, ist_date, direction, employee_reason, status, " +
  "approval_request_id, decision_comment, created_at";

const MY_REQUESTS_CAP = 50;

/** My own web-punch requests, newest first. RLS is the boundary. */
export function fetchMyWebPunchRequests(
  employeeId: string,
  signal?: AbortSignal,
): Promise<WebPunchRow[]> {
  return selectMany(WEB_PUNCH_REQUESTS_TABLE, webPunchRowSchema, {
    columns: COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "created_at", ascending: false }],
    limit: MY_REQUESTS_CAP,
    ...(signal ? { signal } : {}),
  });
}

export interface SubmitWebPunchInput {
  readonly employeeId: string;
  /** The instant being claimed, as an ISO string from the form. */
  readonly requestedPunchAt: string;
  /** `YYYY-MM-DD` IST — which business day the punch belongs to. */
  readonly istDate: string;
  readonly direction: WebPunchDirection;
  readonly reason: string;
}

export interface SubmittedWebPunch {
  readonly row: WebPunchRow;
  readonly requestId: string;
}

/**
 * Raise the request.
 *
 * `status: 'pending'` and not `'draft'`: the self-insert policy permits either,
 * but a draft is a row nobody is looking at. There is no screen that lists
 * drafts and no way to promote one, so a draft here would be a request the
 * employee believes they filed and nobody ever receives.
 */
export async function submitWebPunchRequest(
  input: SubmitWebPunchInput,
  signal?: AbortSignal,
): Promise<SubmittedWebPunch> {
  const reason = input.reason.trim();

  const row = await insertOne(
    WEB_PUNCH_REQUESTS_TABLE,
    webPunchRowSchema,
    {
      employee_id: input.employeeId,
      requested_punch_at: input.requestedPunchAt,
      ist_date: input.istDate,
      direction: input.direction,
      employee_reason: reason,
      status: "pending",
    },
    { columns: COLUMNS, ...(signal ? { signal } : {}) },
  );

  const requestId = await rpcOne(
    CREATE_APPROVAL_REQUEST_FN,
    {
      p_request_type_code: REQUEST_CODE_WEB_PUNCH,
      p_subject_employee_id: input.employeeId,
      p_detail_id: row.id,
      p_title: `Web punch · ${input.direction} · ${input.istDate}`,
      p_summary: {
        summary: reason,
        direction: input.direction,
        ist_date: input.istDate,
        requested_punch_at: input.requestedPunchAt,
      },
      p_amount: null,
      p_days: null,
      p_priority: "normal",
      p_on_behalf_of: null,
    },
    dbUuid,
    signal ? { signal } : {},
  );
  if (requestId === null) {
    throw new Error("The request was saved but the approval request was not created.");
  }

  const linked = await updateOne(
    WEB_PUNCH_REQUESTS_TABLE,
    webPunchRowSchema,
    { approval_request_id: requestId },
    { id: row.id },
    { columns: COLUMNS, ...(signal ? { signal } : {}) },
  );

  return { row: linked, requestId };
}
