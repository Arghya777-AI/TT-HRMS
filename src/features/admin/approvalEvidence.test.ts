/**
 * An approver sees the whole request — every type, every reason, every attachment.
 *
 * ── WHAT HR SAID, TWICE ──────────────────────────────────────────────────────
 * "If I go for an approval, I can see only the amount. There is no Excel, no attachment,
 * nothing is there." And: "No details are showing properly. Every detail should be coming —
 * images, what they applied for, what is the reason, and at what time they applied. Right now
 * only the times are coming, but not the reason or the purpose. If they have attached a
 * document or not, nothing is coming."
 *
 * All accurate. The Approval Inbox rendered `approval_requests` and never opened the row it
 * names through `detail_table` / `detail_id` — two columns already handed to
 * `act_on_approval` when the decision is taken. So a leave request showed no reason, and
 * `leave_requests.supporting_document_id` had no reader anywhere in the app.
 *
 * There are 19 request types over 13 detail tables. These assertions guard the two things
 * that make one panel cover all of them: the server returns whatever the row holds, and the
 * client can order and format a key it has never seen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceValueKind,
  humaniseKey,
  isWideField,
  orderEvidenceKeys,
} from "./evidenceFields";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
/** Comments are not code — tests here have passed on a word inside one. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*--.*$/gm, "");

const panel = strip(read("src", "features", "admin", "components", "ApprovalEvidence.tsx"));
const inbox = strip(read("src", "features", "admin", "pages", "ApprovalInbox.page.tsx"));
const migration = strip(
  read("supabase", "migrations", "20260903120000_an_approver_sees_the_whole_request.sql"),
);

describe("the reason is never buried", () => {
  it("puts the reason above the bookkeeping", () => {
    /*
      THE WHOLE COMPLAINT. "Only the times are coming, but not the reason or the purpose."
      A reason rendered after `status` and `is_backdated` is a reason nobody reads.
    */
    const ordered = orderEvidenceKeys([
      "status", "is_backdated", "reason", "total_days", "unpaid_days", "leave_type",
    ]);
    expect(ordered.indexOf("reason")).toBeLessThan(ordered.indexOf("status"));
    expect(ordered.indexOf("leave_type")).toBeLessThan(ordered.indexOf("reason"));
  });

  it("puts the approver's own decision note last, after the request", () => {
    const ordered = orderEvidenceKeys(["decision_comment", "reason", "employee_reason"]);
    expect(ordered.at(-1)).toBe("decision_comment");
  });

  it("shows a column nobody has ranked instead of hiding it", () => {
    // A new request type must appear, not silently drop its own fields.
    const ordered = orderEvidenceKeys(["zzz_new_column", "reason"]);
    expect(ordered).toContain("zzz_new_column");
    expect(ordered.indexOf("reason")).toBeLessThan(ordered.indexOf("zzz_new_column"));
  });

  it("gives free text its own full-width row", () => {
    expect(isWideField("employee_reason", "We met Mr Sadanand to discuss the decor deck")).toBe(true);
    expect(isWideField("total_days", 3)).toBe(false);
  });
});

describe("a value is formatted from its key, not guessed from its type", () => {
  it.each([
    ["total_claimed_paise", 597000, "money"],
    ["requested_first_in_at", "2026-09-02T14:30:00+00:00", "instant"],
    ["from_date", "2026-09-13", "date"],
    ["ist_date", "2026-09-02", "date"],
    ["is_backdated", false, "boolean"],
    ["reason", "Ganesha Habba", "text"],
  ] as const)("%s renders as %s", (key, value, kind) => {
    expect(evidenceValueKind(key, value)).toBe(kind);
  });

  it("falls back to text when a value contradicts its suffix", () => {
    /*
      A string in a `_paise` column should LOOK wrong rather than be formatted into a
      plausible amount — this panel sits next to an Approve button.
    */
    expect(evidenceValueKind("total_claimed_paise", "not a number")).toBe("text");
    expect(evidenceValueKind("decided_at", 12345)).toBe("text");
  });

  it("humanises an unlabelled column rather than printing it raw", () => {
    expect(humaniseKey("employee_reason")).toBe("Employee reason");
  });
});

describe("the panel covers every request type", () => {
  it("is mounted with the approval request's own id", () => {
    expect(inbox).toContain("<ApprovalEvidence approvalRequestId={row.id} />");
  });

  it("reads through the one server function, not per-type fetchers", () => {
    // 13 bespoke readers is 13 chances to forget the reason column.
    expect(panel).toContain("fetchApprovalEvidence");
    expect(panel).not.toContain("fetchClaimLines");
    expect(panel).not.toContain("fetchRegularizationsByIds");
  });

  it("does not build an i18n key by template and hope", () => {
    /*
      `t()` has NO missing-key fallback: `en[key]` is undefined and `t` returns it unchanged,
      so a templated key renders an EMPTY cell. Membership is checked first.
    */
    expect(panel).toContain("Object.prototype.hasOwnProperty.call(en, messageKey)");
  });
});

describe("attachments", () => {
  it("lists every one and opens it through document-access", () => {
    expect(panel).toContain("DocumentOpenButtons");
    expect(panel).not.toContain("createSignedUrl");
    expect(panel).not.toContain("storage.from");
  });

  it("says when nothing was attached, rather than leaving a gap", () => {
    // An approver needs to know a request arrived WITHOUT proof; blank space says nothing.
    expect(panel).toContain('t("admin.wf.ev.noDocs")');
  });

  it("collects attachments from both column shapes and deduplicates them", () => {
    /*
      The underscores are LIKE-escaped in the SQL (`%\_document\_id`), so these match the
      escaped literal. The first version asserted the bare name and failed — which is the
      assertion doing its job, not the code.
    */
    expect(migration).toContain("LIKE '%\\_document\\_id'");
    expect(migration).toContain("LIKE '%\\_document\\_ids'");
    expect(migration).toContain("SELECT DISTINCT unnest(v_docs)");
  });

  it("pulls a claim's receipts off its child lines", () => {
    // A claim keeps its money and its bills on `claim_lines`; the header alone shows neither.
    expect(migration).toContain("cl.receipt_document_id IS NOT NULL");
  });
});

describe("unreadable is not the same as empty", () => {
  it("distinguishes the two on screen", () => {
    expect(panel).toContain("!data.readable");
    expect(panel).toContain('t("admin.wf.ev.unreadable")');
    expect(panel).toContain('t("admin.wf.ev.noFields")');
  });

  it("returns readable:false from the server when RLS withholds the row", () => {
    expect(migration).toContain("'readable', false");
  });

  it("names a detail_table that is not a registered type", () => {
    expect(migration).toContain("'unknown_table', true");
    expect(panel).toContain("data.unknown_table");
  });
});

describe("the server function's security", () => {
  it("is SECURITY INVOKER, so RLS decides", () => {
    /*
      DEFINER here would hand every approver every detail row in the company. The comment on
      the line exists so nobody "fixes" it.
    */
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).not.toMatch(/FUNCTION public\.approval_request_evidence[\s\S]{0,400}SECURITY DEFINER/);
  });

  it("never lets an unvalidated table name reach dynamic SQL", () => {
    expect(migration).toContain("FROM public.request_types rt");
    expect(migration).toContain("rt.detail_table = v_table");
    expect(migration).toContain("format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_table)");
  });

  it("is granted to authenticated and revoked from anon", () => {
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.approval_request_evidence(uuid) FROM anon");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.approval_request_evidence(uuid) TO authenticated");
  });

  it("re-implements no permission check in the client", () => {
    expect(panel).not.toContain("is_admin");
    expect(panel).not.toContain("admin_scope_covers");
  });
});
