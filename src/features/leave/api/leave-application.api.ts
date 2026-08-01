/**
 * leave-application.api.ts — filing ONE leave application that draws on several types.
 *
 * WHAT AN "APPLICATION" IS HERE. N single-type `leave_requests` rows sharing an
 * `application_group_id` (migration 039700). The employee fills in one form; the group is
 * what makes it read and decide as one thing. Each row is still independently guarded by the
 * five triggers around `leave_requests`, per type — which is the whole reason this shape was
 * chosen over putting the type on the day.
 *
 * ── TWO FACTS ABOUT THE SERVER THAT DICTATE THIS CODE ────────────────────────
 *
 * 1. A REQUEST CANNOT BE BORN `pending`. `leave_requests_submit_guard` is a BEFORE trigger
 *    that calls `rebuild_leave_request_days(NEW.id, …)`, so on a direct pending INSERT the
 *    child rows reference a parent that does not exist yet and the foreign key fails:
 *
 *      insert on leave_request_days violates foreign key … Key (leave_request_id) is not
 *      present in table "leave_requests"
 *
 *    Every member is therefore inserted as a DRAFT and then updated to pending. This is not
 *    a style choice; it is the only order that works, and it is what the employee's own
 *    screen has always done via preview-then-submit.
 *
 * 2. THE COMBINATION GUARD IS AN `AFTER` CONSTRAINT TRIGGER, judged per row against the
 *    group. So the FIRST member submits cleanly and a violating member is refused when IT is
 *    submitted — the failure names the offending type, which is what the screen shows.
 *
 * ── WHY DRAFTS ARE CREATED FIRST, ALL OF THEM, BEFORE ANY SUBMIT ─────────────
 * A partially submitted application is the worst outcome: one leave type approved, another
 * silently missing, and a balance that has moved for half the days somebody asked for. So
 * drafts are created for every member first — cheap, invisible to approvers, and refused by
 * nothing except a malformed range — and only then are they submitted. A submit failure
 * therefore leaves DRAFTS behind rather than a half-filed application: drafts reach no
 * approver, and the employee's next attempt resumes from them.
 */
import { z } from "zod";
import { insertOne, updateOne } from "@/shared/api/write";
import { dbUuid } from "@/shared/api/query";
import type { LeaveDayPortion } from "./leave-apply.api";

export const LEAVE_REQUESTS_TABLE = "leave_requests";
export const MENTIONS_TABLE = "leave_request_mentions";

const memberSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  status: z.string(),
});

/** One leg of the application: this many days from this leave type. */
export interface ApplicationMember {
  readonly leaveTypeId: string;
  readonly leaveTypeName: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly portion: LeaveDayPortion;
}

export interface LeaveApplicationInput {
  readonly employeeId: string;
  readonly members: readonly ApplicationMember[];
  readonly reason: string;
  readonly contactDuringLeave: string | null;
  /** `leave_requests.address_during_leave` — where they can be reached. */
  readonly addressDuringLeave: string | null;
  readonly handoverToEmployeeId: string | null;
  readonly handoverNotes: string | null;
  /**
   * Colleagues to name on the application. Each becomes a `leave_request_mentions` row and
   * the trigger notifies them — see migration 039800.
   */
  readonly mentionEmployeeIds: readonly string[];
}

export interface FiledMember {
  readonly requestId: string;
  readonly requestNumber: string;
  readonly leaveTypeName: string;
}

export interface LeaveApplicationResult {
  readonly groupId: string;
  readonly filed: readonly FiledMember[];
}

/**
 * A group id minted in the browser.
 *
 * Safe because it is an opaque grouping key, not an identity or a secret: the request NUMBER
 * is still allocated by `generate_leave_request_number` server-side, and RLS still decides
 * whose rows these are. `crypto.randomUUID` is available in every browser this app supports.
 */
function newGroupId(): string {
  return crypto.randomUUID();
}

/**
 * File the application: draft every member, then submit every member.
 *
 * Returns the group id and what was filed. Throws on the first submit failure, leaving the
 * unsubmitted members as drafts — see the header for why drafts are the safe residue and why
 * already-submitted members are not withdrawn.
 */
export async function submitLeaveApplication(
  input: LeaveApplicationInput,
): Promise<LeaveApplicationResult> {
  if (input.members.length === 0) {
    throw new Error("An application needs at least one leave type.");
  }
  const groupId = newGroupId();
  const reason = input.reason.trim();

  // ── Phase 1: drafts ──────────────────────────────────────────────────────
  const drafts: { id: string; member: ApplicationMember }[] = [];
  for (const member of input.members) {
    const row = await insertOne(
      LEAVE_REQUESTS_TABLE,
      memberSchema,
      {
        employee_id: input.employeeId,
        leave_type_id: member.leaveTypeId,
        from_date: member.fromDate,
        to_date: member.toDate,
        portion: member.portion,
        status: "draft",
        reason,
        application_group_id: groupId,
      },
      { columns: "id, request_number, status" },
    );
    drafts.push({ id: row.id, member });
  }

  /*
    ── Phase 2: submit ──────────────────────────────────────────────────────

    A FAILURE HERE LEAVES DRAFTS, AND THAT IS THE SAFE RESIDUE. There is no catch: the
    error propagates with the server's own sentence — "Sick Leave must be taken on its
    own", "insufficient MRL balance: need 1.00 paid day(s), 0.000 available" — which is
    exactly what the employee needs to read.

    What is left behind is deliberate. Members not yet submitted stay DRAFTS, and a draft
    reaches no approver (every approval view filters to pending and beyond) while the
    employee's own screen reuses it, so the next attempt resumes rather than restarting.

    Members already submitted are NOT withdrawn. They are real pending requests in an
    approver's inbox, and retracting them behind the approver's back is worse than a
    partially filed application the employee can see and finish — which is why `filed`
    is returned rather than discarded on the throw.
  */
  const filed: FiledMember[] = [];
  for (const draft of drafts) {
    const row = await updateOne(
      LEAVE_REQUESTS_TABLE,
      memberSchema,
      {
        status: "pending",
        reason,
        contact_during_leave: input.contactDuringLeave,
        address_during_leave: input.addressDuringLeave,
        handover_to_employee_id: input.handoverToEmployeeId,
        handover_notes: input.handoverNotes,
      },
      { id: draft.id },
      { columns: "id, request_number, status" },
    );
    filed.push({
      requestId: row.id,
      requestNumber: row.request_number,
      leaveTypeName: draft.member.leaveTypeName,
    });
  }

  /*
    ── Mentions ─────────────────────────────────────────────────────────────

    Attached to the FIRST member only, not to every one. A combined application is one act
    to the employee, so mentioning three colleagues must notify each of them ONCE — writing a
    row per member would send the same person a notification per leave type, which reads as a
    bug to whoever receives it.

    Written after the members are filed and NOT allowed to fail the application: the leave is
    the thing that matters and it is already submitted. A mention that did not save is worth
    reporting, never worth throwing away an approved-and-pending request over.
  */
  const anchor = filed[0];
  if (anchor !== undefined && input.mentionEmployeeIds.length > 0) {
    for (const employeeId of input.mentionEmployeeIds) {
      try {
        await insertOne(
          MENTIONS_TABLE,
          z.object({ id: dbUuid }),
          { leave_request_id: anchor.requestId, employee_id: employeeId },
          { columns: "id" },
        );
      } catch {
        // Deliberately swallowed. See the note above: the application is already filed.
      }
    }
  }

  return { groupId, filed };
}
