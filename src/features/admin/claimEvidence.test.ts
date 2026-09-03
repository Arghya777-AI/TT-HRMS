/**
 * An admin can see the bill behind a reimbursement claim.
 *
 * ── WHAT WAS ACTUALLY WRONG ──────────────────────────────────────────────────
 * Not a permission. `documents__admin__all`, the `documents__admin_all` storage policy and
 * `document-access`'s own scan gate all admit an administrator — verified by impersonating
 * every live admin under RLS, which returned all three claims, all three lines and all three
 * receipts. The register just never fetched the receipt, because it does not live on
 * `reimbursement_claims`: it lives on `claim_lines.receipt_document_id`, one level down.
 *
 * So `/admin/payroll/reimbursements` offered a Decide button on money and showed no evidence
 * at all. These assertions are about the two things that made that hard to see — a level of
 * data nobody read, and three different absences that must never be collapsed into one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessKindValues } from "./api/documents.api";
import {
  attachReceipts,
  evidenceActorIds,
  groupLinesByClaim,
  tallyAttachments,
  type ClaimLine,
  type ClaimReceipt,
} from "./api/claimEvidence.api";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** Comments are not code. Three tests in this repo have passed on a word in a comment. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function line(over: Partial<ClaimLine> = {}): ClaimLine {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    claim_id: "22222222-2222-4222-8222-222222222222",
    line_date: "2026-08-24",
    expense_head: "conveyance",
    description: "Client visit",
    from_location: "Office",
    to_location: "Indiranagar",
    distance_km: 12.5,
    rate_per_km_paise: 1200,
    amount_claimed_paise: 15000,
    amount_approved_paise: null,
    tax_amount_paise: null,
    gst_number: null,
    travel_mode: "auto",
    travel_purpose: "client_meeting",
    is_receipt_required: true,
    receipt_document_id: null,
    rejection_reason: null,
    created_at: "2026-09-01T08:42:00.000Z",
    ...over,
  };
}

function receipt(over: Partial<ClaimReceipt> = {}): ClaimReceipt {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Receipt — bill.pdf",
    file_name: "bill.pdf",
    mime_type: "application/pdf",
    file_size_bytes: 49740,
    checksum_sha256: "abc123",
    status: "approved",
    virus_scan_status: "pending",
    issue_date: "2026-08-24",
    uploaded_by: "44444444-4444-4444-8444-444444444444",
    created_at: "2026-09-01T08:42:26.000Z",
    ...over,
  };
}

describe("three different absences, never collapsed", () => {
  it("counts a receipt that resolved", () => {
    const rows = attachReceipts(
      [line({ receipt_document_id: receipt().id })],
      new Map([[receipt().id, receipt()]]),
    );
    expect(tallyAttachments(rows)).toEqual({
      attachments: 1,
      lines: 1,
      missing: 0,
      unreadable: 0,
    });
  });

  it("counts a line that OWES a receipt as missing, not as attached", () => {
    /*
      `ck_claim_lines__receipt_present` is NOT VALID, so a row filed before it can say a
      receipt is required and carry none. An approver must see that on the row rather than
      discover it after approving.
    */
    const rows = attachReceipts([line({ is_receipt_required: true })], new Map());
    expect(tallyAttachments(rows)).toEqual({
      attachments: 0,
      lines: 1,
      missing: 1,
      unreadable: 0,
    });
  });

  it("does not call an optional missing receipt a violation", () => {
    const rows = attachReceipts([line({ is_receipt_required: false })], new Map());
    expect(tallyAttachments(rows)).toEqual({
      attachments: 0,
      lines: 1,
      missing: 0,
      unreadable: 0,
    });
  });

  it("separates 'you may not open it' from 'none attached'", () => {
    /*
      THE DAMAGING CASE. A line holding a document id whose row RLS did not return is a bill
      that exists. Rendering it as "no attachment" tells an approver the employee filed
      nothing — the single most misleading sentence this screen could show.
    */
    const rows = attachReceipts([line({ receipt_document_id: "99999999-9999-4999-8999-999999999999" })], new Map());
    expect(rows[0]?.receipt).toBeNull();
    expect(tallyAttachments(rows)).toEqual({
      attachments: 0,
      lines: 1,
      missing: 0,
      unreadable: 1,
    });
  });

  it("keeps them apart in one mixed claim", () => {
    const rows = attachReceipts(
      [
        line({ id: "a", receipt_document_id: receipt().id }),
        line({ id: "b", receipt_document_id: "unresolvable" }),
        line({ id: "c", is_receipt_required: true }),
        line({ id: "d", is_receipt_required: false }),
      ],
      new Map([[receipt().id, receipt()]]),
    );
    expect(tallyAttachments(rows)).toEqual({
      attachments: 1,
      lines: 4,
      missing: 1,
      unreadable: 1,
    });
  });
});

describe("grouping and actor collection", () => {
  it("groups lines under their own claim", () => {
    const grouped = groupLinesByClaim([
      line({ id: "a", claim_id: "c1" }),
      line({ id: "b", claim_id: "c2" }),
      line({ id: "c", claim_id: "c1" }),
    ]);
    expect(grouped.get("c1")?.map((l) => l.id)).toEqual(["a", "c"]);
    expect(grouped.get("c2")?.map((l) => l.id)).toEqual(["b"]);
    expect(grouped.get("nope")).toBeUndefined();
  });

  it("deduplicates actor ids across uploader, reader and approver", () => {
    // The uploader is very often also the first approver; asking twice is a wasted request.
    const same = "44444444-4444-4444-8444-444444444444";
    const ids = evidenceActorIds(
      [{ line: line(), receipt: receipt({ uploaded_by: same }) }],
      [
        {
          id: "l1",
          document_id: receipt().id,
          access_kind: "view",
          accessed_by: same,
          accessed_by_role: "admin",
          on_behalf_of: null,
          purpose: null,
          ip: "10.0.0.1/32",
          user_agent: null,
          signed_url_expires_at: null,
          bytes_served: null,
          recorded_at: "2026-09-02T10:00:00.000Z",
        },
      ],
      [
        {
          id: "a1",
          approval_request_id: "r1",
          level: 1,
          actor_id: same,
          actor_role: "manager",
          acted_as: null,
          delegated_from: null,
          action: "approved",
          comment: null,
          ip: null,
          acted_at: "2026-09-02T11:00:00.000Z",
          time_to_action_seconds: null,
        },
      ],
    );
    expect(ids).toEqual([same]);
  });

  it("asks for nothing when there is nobody to name", () => {
    expect(evidenceActorIds([], [], [])).toEqual([]);
  });
});

describe("the access-kind vocabulary is the deployed one", () => {
  const sheet = read("src", "features", "admin", "components", "ClaimEvidenceSheet.tsx");
  const keys = read("src", "shared", "i18n", "keys", "claim-evidence.ts");

  it.each(accessKindValues)("%s has a label", (kind) => {
    /*
      `ck_dal__access_kind` permits exactly six values, confirmed against the live constraint.
      A value with no key renders an EMPTY CELL in the trail, because `t()` has no missing-key
      fallback — `en[key]` is `undefined` and `t` returns it unchanged.
    */
    expect(keys).toContain(`"admin.reimb.ev.kind.${kind}"`);
    expect(stripComments(sheet)).toContain(`${kind}: "admin.reimb.ev.kind.${kind}"`);
  });

  it("invents no kind the database would refuse", () => {
    const declared = [...keys.matchAll(/"admin\.reimb\.ev\.kind\.([a-z_]+)"/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...accessKindValues].sort());
  });

  it("does not rely on a t() fallback that does not exist", () => {
    /*
      THE FIRST VERSION'S BUG. It built the key by template and fell back "when t returns the
      key" — which never happens: `t()` is `en[key]` with no default, so a miss is `undefined`
      and `t(key, vars)` throws on `undefined.replace`. The map has to be typed instead.
    */
    const code = stripComments(sheet);
    expect(code).not.toContain("`admin.reimb.ev.kind.${");
    expect(code).toContain("Record<AccessKind, MessageKey>");
  });
});

describe("the register actually reads and shows the level it used to skip", () => {
  const page = stripComments(read("src", "features", "admin", "pages", "PayrollReimbursements.page.tsx"));

  it("fetches the claim lines for the claims on screen", () => {
    expect(page).toContain("useClaimLineEvidence(claimIds)");
  });

  it("puts the bill count on the row", () => {
    expect(page).toContain('key: "attachments"');
    expect(page).toContain("AttachmentCount");
  });

  it("keeps the count column in the memo dependencies", () => {
    /*
      The columns are built inside a `useMemo`. A dependency array that omits `tallies` pins
      the first render's value, so the column would read "—" forever after the query resolved
      — the same empty cell the whole bug looked like, reintroduced one layer up.
    */
    expect(page).toContain("[labelMap, targetMap, tallies, decide.isPending]");
  });

  it("shows the missing and unreadable counts, not just a number", () => {
    expect(page).toContain("admin.reimb.ev.missing");
    expect(page).toContain("admin.reimb.ev.unreadable");
  });

  it("mounts the evidence sheet and opens it per claim", () => {
    expect(page).toContain("<ClaimEvidenceSheet");
    expect(page).toContain("setEvidenceFor(row)");
  });

  it("opens files through document-access, never a direct storage URL", () => {
    /*
      The bytes are unreachable from the browser by design (migration 039) and every link must
      be logged before it exists. `DocumentOpenButtons` is the only sanctioned route.
    */
    const sheet = stripComments(read("src", "features", "admin", "components", "ClaimEvidenceSheet.tsx"));
    expect(sheet).toContain("DocumentOpenButtons");
    expect(sheet).not.toContain("createSignedUrl");
    expect(sheet).not.toContain("storage.from");
  });
});

describe("the query forms are ones this codebase can prove", () => {
  const api = stripComments(read("src", "features", "admin", "api", "claimEvidence.api.ts"));

  it("uses no PostgREST FK-hint embed", () => {
    /*
      An embed on an FK-constraint hint could not be executed against the live API before
      shipping — the service key is rotated and interactive sign-in is unavailable — and a
      select string PostgREST rejects fails at RUNTIME, on a deployed screen, with no type
      error. The receipt is fetched by id list with `inList`, the form every other register
      already proves.
    */
    expect(api).not.toContain("!fk_claim_lines__receipt_document");
    expect(api).not.toMatch(/receipt:documents/);
    // The receipt is fetched by id list. Matched on the filter, not on the local variable's
    // name — chunking renamed it once already, and the name is not the thing under test.
    expect(api).toMatch(/inList\("id",\s*\w+\)/);
  });

  it("never asks for the same receipt twice", () => {
    expect(api).toContain("new Set(lines.flatMap");
  });

  it("chunks every id-list filter, so a full register does not build a 19 kB URL", () => {
    /*
      THE BUG THAT WOULD HAVE SHIPPED. The register caps at 500 claims and PostgREST takes its
      filters in the QUERY STRING, so 500 UUIDs is a ~19 kB request line against a proxy limit
      near 8 kB. It does not come back slow, it comes back REFUSED — and with three claims in
      this venue today the unchunked version works perfectly, so nothing on screen would have
      hinted at it until a register filled up.
    */
    /*
      The TERMINATOR matters. `toContain("const ID_CHUNK = 100")` also matches
      `= 100000`, so the first version of this assertion passed with the chunking
      effectively switched off — a green test for the exact bug it names.
    */
    expect(api).toMatch(/const ID_CHUNK = 100;/);
    expect(api).toMatch(/chunk\(claimIds, ID_CHUNK\)/);
    expect(api).toMatch(/chunk\(ids, ID_CHUNK\)/);
    expect(api).toMatch(/chunk\(documentIds, ID_CHUNK\)/);
  });

  it("re-sorts the access log after concatenating batches", () => {
    // Each request is ordered; the concatenation of two ordered pages is not.
    expect(api).toContain("b.recorded_at.localeCompare(a.recorded_at)");
  });

  it("does not re-implement any permission check", () => {
    // RLS answers. A second copy in TypeScript is how the two drift apart.
    expect(api).not.toContain("is_admin");
    expect(api).not.toContain("admin_scope_covers");
  });
});
