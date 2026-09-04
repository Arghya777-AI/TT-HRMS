/**
 * An administrator may decide their own LEAVE, and nothing else of their own.
 *
 * ── WHAT WAS ASKED, AND WHAT WAS ACTUALLY BLOCKING IT ────────────────────────
 * "Sunil will be approving his own leave also. Give all admins the access to approve their own
 * leave also."
 *
 * The database already permitted it: `act_on_approval` exempts an administrator from the
 * "an employee cannot approve their own request" rule and records the act as `admin_override`,
 * which the Override Log lists. The Approval Inbox was the only thing refusing — one line that
 * returned false for any row whose subject was the viewer.
 *
 * Refusing something the API allows makes the screen a liar rather than a control.
 *
 * ── WHY IT IS SCOPED TO LEAVE ────────────────────────────────────────────────
 * Because that is what was asked, and because the other types are not the same decision. A
 * reimbursement is money, and an administrator approving their own claim is precisely the
 * control that exists to prevent that. It stays blocked, and opening it is one line if the
 * venue ever asks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  join(process.cwd(), "src", "features", "admin", "pages", "ApprovalInbox.page.tsx"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("an admin decides their own leave", () => {
  it("no longer refuses every request whose subject is the viewer", () => {
    // The single line that blocked it.
    expect(page).not.toContain(
      "if (myEmployeeId !== null && row.subject_employee_id === myEmployeeId) return false;",
    );
    expect(page).toContain("if (isMine(row)) return isOwnLeave(row);");
  });

  it("allows it for a plain admin, not only a super admin", () => {
    /*
      "Give ALL admins the access." `app.is_admin()` on the server is `has_role('admin')`,
      which a super admin also satisfies, so the screen mirrors exactly who the database will
      let act.
    */
    expect(page).toContain('const isAdmin = isSuperAdmin || roles.includes("admin")');
    expect(page).toContain("isMine(row) && isAdmin");
  });

  it("is scoped to LEAVE", () => {
    // A reimbursement is money; self-approval there is the control that must stay.
    expect(page).toContain('typeMap.get(row.request_type_id)?.code === "LEAVE"');
  });

  it("still refuses a settled request, however senior the viewer", () => {
    /*
      The state check comes first and is untouched. A screen that offers Approve on something
      already approved is the defect this predicate was last fixed for.
    */
    expect(page).toContain("!isSettled(row) && (isNamedApprover(row) || isOverride(row))");
  });

  it("still treats it as an override, and says so in its own words", () => {
    /*
      Deciding your own leave is not the same act as reaching past somebody else's approver.
      Both are recorded; only one of them is you signing your own leave, and the notice should
      not pretend otherwise.
    */
    expect(page).toContain("isOwn ? t(\"admin.wf.inbox.detail.ownRequest\")");
    const copy = readFileSync(join(process.cwd(), "src", "shared", "i18n", "en.ts"), "utf8");
    expect(copy).toContain("This is your own request.");
    expect(copy).toContain("recorded in the Override Log");
  });

  it("does not touch who the named approvers are", () => {
    // The chain still resolves as it did; this only decides who the SCREEN offers buttons to.
    expect(page).toContain("row.current_approver_ids.includes(myEmployeeId)");
  });
});
