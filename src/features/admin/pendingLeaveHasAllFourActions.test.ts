/**
 * All four administrator actions, on a pending leave as well as an approved one.
 *
 * ── WHAT WAS UNEVEN ─────────────────────────────────────────────────────────────
 * Approve and reject applied to a PENDING request. Edit and hand-back refused anything that
 * was not already approved — "This request is pending, not approved — reopen it before
 * editing" — so an administrator reading an application with the wrong dates on it had exactly
 * one move: reject it, and ask the employee to type the whole thing again.
 *
 * And the approved row's only button said "Cancel leave" while the dialog behind it has always
 * offered cancel, edit AND hand-back. Two of the three were unreachable to anybody who read
 * the button and decided they did not want to cancel anything.
 *
 * ── WHERE A HANDED-BACK LEAVE LANDS ────────────────────────────────────────────
 * An approved leave goes back to `pending`: the decision is undone, the application stands. A
 * pending leave has no decision to undo, so handing it back gives up the application itself and
 * it goes to `draft` — off the approver's desk, wholly the employee's again.
 *
 * Verified live against LV-2026-000057, rolled back:
 *   send back  → status=draft,   approval withdrawn, approval_request_id cleared
 *   edit dates → status=pending, approval still pending, decided_by still null
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
/* Line comments first — a `//` containing a block opener otherwise eats the file. */
const strip = (s: string) =>
  s
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const sql = strip(
  read("supabase", "migrations", "20260907160000_a_pending_leave_can_be_edited_or_handed_back.sql"),
);
const dialog = strip(read("src", "features", "admin", "components", "CancelLeaveDaysDialog.tsx"));
const queue = strip(read("src", "features", "admin", "pages", "LeaveRequests.page.tsx"));

describe("the server accepts a pending request now", () => {
  it("lets both actions take pending, and still refuses everything else", () => {
    for (const fn of ["admin_send_leave_back", "admin_edit_leave_dates"]) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      const upTo = body.slice(0, body.indexOf("$function$;"));
      expect(upTo).toContain("'approved','partially_approved','pending'");
      expect(upTo).toContain("RAISE EXCEPTION");
    }
  });

  it("sends a PENDING leave to draft and an APPROVED one back to pending", () => {
    expect(sql).toContain("v_target := CASE WHEN r.status = 'pending' THEN 'draft' ELSE 'pending' END;");
    expect(sql).toContain("SET status              = v_target,");
  });

  it("keeps an edited PENDING request pending, and undecided", () => {
    expect(sql).toContain("v_was_pending := (r.status = 'pending');");
    expect(sql).toContain("decided_by       = CASE WHEN v_was_pending THEN NULL ELSE v_actor END");
    expect(sql).toContain("IF NOT v_was_pending THEN\n    UPDATE public.leave_requests SET status = 'approved' WHERE id = r.id;");
  });

  it("builds day rows at the request's OWN status, not always approved", () => {
    expect(sql).toContain("CASE WHEN v_was_pending THEN 'pending' ELSE 'approved' END");
  });

  it("skips the ledger reversal for a request that was already pending", () => {
    // There is no `availed` debit on a pending request to reverse.
    expect(sql).toContain("IF NOT v_was_pending THEN\n    UPDATE public.leave_requests SET status = 'pending' WHERE id = r.id;");
  });

  it("skips locks and payroll checks only for pending, which was never applied", () => {
    expect(sql).toContain("IF r.status <> 'pending' THEN");
  });
});

describe("going to draft takes the item off the approver's desk", () => {
  it("teaches the existing settle trigger the third word instead of restating it", () => {
    expect(sql).toContain("trg_leave_requests__settle_approval");
    expect(sql).toContain("ARRAY['withdrawn'::text, 'cancelled'::text, 'draft'::text]");
    expect(sql).toContain("EXECUTE FUNCTION settle_approval_for_detail()");
  });

  it("clears approval_request_id in a SECOND statement, and only for a draft", () => {
    /*
      The trigger reads NEW.approval_request_id to find what to settle, so clearing it in the
      same update makes it return early and orphans a live approval. Clearing it afterwards is
      still required, or `raise_approval` will not fire on resubmission and the request sits
      pending with nobody assigned.
    */
    const at = sql.indexOf("SET status              = v_target,");
    const after = sql.slice(at);
    expect(after).toContain("IF v_target = 'draft' THEN");
    expect(after).toContain("UPDATE public.leave_requests SET approval_request_id = NULL");
    // The status update must come first.
    expect(after.indexOf("approval_request_id = NULL")).toBeGreaterThan(0);
  });
});

describe("the dialog offers only what the server will accept", () => {
  it("takes the status and derives the three permissions from it", () => {
    expect(dialog).toContain("readonly status?: LeaveRequestStatus;");
    expect(dialog).toContain("function allowedActions(status: LeaveRequestStatus)");
    expect(dialog).toContain("return { edit: approved || pending, sendBack: approved || pending, cancel: approved };");
  });

  it("hides cancel on a pending request, because the server refuses it", () => {
    // `admin_cancel_leave_days`: "This request is %, not approved — there is nothing to cancel."
    expect(dialog).toContain("{allowed.cancel ? (");
    expect(dialog).toContain("{allowed.edit ? (");
    expect(dialog).toContain("{allowed.sendBack ? (");
  });

  it("words the hand-back differently for a pending request", () => {
    expect(dialog).toContain('status === "pending"');
    expect(dialog).toContain("adminLeave.cancelDays.startSendBackPending");
  });

  it("defaults to approved, for the calendar surfaces that only show granted leave", () => {
    expect(dialog).toContain('status = "approved",');
  });
});

describe("the queue row", () => {
  it("names the approved button for everything behind it, not just cancel", () => {
    expect(queue).toContain('t("admin.leaveReq.action.take")');
    const en = read("src", "shared", "i18n", "en.ts");
    const at = en.indexOf('"admin.leaveReq.action.take"');
    expect(en.slice(at, at + 80)).toContain("Cancel or edit");
  });

  it("adds the other two moves to a pending row, beside approve and reject", () => {
    expect(queue).toContain('t("admin.leaveReq.action.approve")');
    expect(queue).toContain('t("admin.leaveReq.action.reject")');
    expect(queue).toContain('t("admin.leaveReq.action.more")');
    const en = read("src", "shared", "i18n", "en.ts");
    const at = en.indexOf('"admin.leaveReq.action.more"');
    expect(en.slice(at, at + 90)).toContain("Edit or send back");
  });

  it("passes the row's real status through to the dialog", () => {
    expect(queue).toContain("status: row.status,");
    expect(queue).toContain('status={cancelTarget?.status ?? "approved"}');
  });

  it("widened the column, because a pending row now carries three controls", () => {
    const col = queue.slice(queue.indexOf('key: "actions"'));
    expect(col.slice(0, 200)).toContain('width: "17rem"');
  });
});
