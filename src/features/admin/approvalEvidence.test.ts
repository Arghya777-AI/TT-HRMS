/**
 * An approver can see what they are approving.
 *
 * ── WHAT HR SAW ──────────────────────────────────────────────────────────────
 * On a reimbursement: "if I go for an approval, I can see only the amount. There is no Excel,
 * no attachment, nothing is there." On an attendance regularisation: "I'm not able to see any
 * details — just given the request and it is showing nothing. I just approved it."
 *
 * Both were true. The Approval Inbox's detail panel rendered the request's ENVELOPE — dates,
 * days, amount, SLA clocks, action trail — and never opened the request. The address was on
 * the row the whole time: `detail_table` and `detail_id` are already passed to
 * `act_on_approval` when the decision is taken, and nothing read them to show what the
 * decision was about.
 *
 * Not a permission: every live admin can read these rows, verified by impersonating each one
 * under RLS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
/** Comments are not code — tests here have passed on a word inside one. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const panel = strip(read("src", "features", "admin", "pages", "ApprovalInbox.page.tsx"));
const evidence = strip(read("src", "features", "admin", "components", "ApprovalEvidence.tsx"));

describe("the panel opens the request it is deciding", () => {
  it("passes the row's own detail address", () => {
    expect(panel).toContain("<ApprovalEvidence detailTable={row.detail_table} detailId={row.detail_id} />");
  });

  it("switches on detail_table, not on the request-type code", () => {
    /*
      `detail_table` is what `act_on_approval` dispatches on. Keying the panel off the same
      column makes the panel and the decision agree by construction; keying it off the type
      CODE would let a renamed type show one thing and decide another.
    */
    expect(evidence).toContain('const CLAIM_TABLE = "reimbursement_claims"');
    expect(evidence).toContain('const REGULARIZATION_TABLE = "attendance_regularizations"');
    expect(evidence).toContain("detailTable === CLAIM_TABLE || detailTable === REGULARIZATION_TABLE");
  });

  it("says so when a type has no block yet, instead of rendering an empty box", () => {
    expect(evidence).toContain('t("admin.wf.ev.none")');
  });
});

describe("a regularisation shows the correction being asked for", () => {
  it.each([
    ["the claimed in-time", "admin.wf.ev.reg.in"],
    ["the claimed out-time", "admin.wf.ev.reg.out"],
    ["the kind of correction", "admin.wf.ev.reg.kind"],
    ["the employee's reason", "admin.wf.ev.reg.reason"],
    ["whether it reached attendance", "admin.wf.ev.reg.applied"],
  ])("shows %s", (_label, key) => {
    expect(evidence).toContain(key);
  });

  it("offers the proof when one is attached, and says so when none is", () => {
    expect(evidence).toContain("reg.supporting_document_id !== null");
    expect(evidence).toContain('t("admin.wf.ev.reg.noProof")');
  });

  it("reads the requested times off the row, never off the summary blob", () => {
    // `approval_requests.summary` is a snapshot taken at submission; the detail row is current.
    expect(evidence).toContain("reg.requested_first_in_at");
    expect(evidence).toContain("reg.requested_last_out_at");
    expect(evidence).not.toContain("row.summary");
  });
});

describe("a claim shows its lines and its bill", () => {
  it("renders the lines with the money and the route", () => {
    expect(evidence).toContain("admin.reimb.ev.f.claimed");
    expect(evidence).toContain("admin.reimb.ev.f.from");
    expect(evidence).toContain("admin.reimb.ev.f.distance");
  });

  it("opens the bill through document-access, never a direct storage URL", () => {
    expect(evidence).toContain("DocumentOpenButtons");
    expect(evidence).not.toContain("createSignedUrl");
    expect(evidence).not.toContain("storage.from");
  });

  it("keeps the three absences apart", () => {
    /*
      A receipt this reader may not open is a bill that EXISTS. Rendering it as "none
      attached" would tell an approver the employee filed nothing — while they decide money.
    */
    expect(evidence).toContain("admin.reimb.ev.billUnreadable");
    expect(evidence).toContain("admin.reimb.ev.noBillRequired");
    expect(evidence).toContain("admin.reimb.ev.noBill");
  });
});

describe("an unreadable detail row is not reported as an empty one", () => {
  it("says the record is outside what you can read", () => {
    expect(evidence).toContain("admin.wf.ev.unreadable");
    expect(evidence).toContain("evidence.data.reg === null");
  });

  it("re-implements no permission check of its own", () => {
    // RLS answers, under the caller's token. A second copy in TypeScript is how they drift.
    expect(evidence).not.toContain("is_admin");
    expect(evidence).not.toContain("admin_scope_covers");
  });
});
