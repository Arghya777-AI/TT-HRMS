/**
 * An off-hours punch carries a photograph, and the approver sees whether it does.
 *
 * ── THE VENUE'S REQUIREMENT ──────────────────────────────────────────────────
 * "Can we give one small screenshot or something for records, evidence?" — "Mandatory, yes.
 * They should attach. And while checking out also, it's mandatory. Someone will check in and
 * the meeting would have been over long back. They might check out by 10 or 12 o'clock. I
 * don't want to pay so much and I don't want to keep on verifying all that."
 *
 * ── THE ONE DECISION WORTH GUARDING ──────────────────────────────────────────
 * MANDATORY ON THE FORM, RECORDED-AND-FLAGGED ON THE SERVER. Those are not in tension; they
 * are belt and braces. The card refuses to submit without a picture, so in practice it is
 * required. The server does NOT refuse one that arrives without it, because this venue has
 * already lost attendance to a hard gate: employees hit the reason requirement, decided the
 * app was broken, and stopped punching — "they thought okay, it's not working, so let's attend
 * like that only." An upload failing on weak signal at 9 pm must cost a review, not a day.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
/**
 * Remove comments so an assertion cannot pass on a word in prose — a recurring defect in this
 * repo, and one this file hit twice.
 *
 * STRING LITERALS ARE MASKED FIRST, and that is not defensive tidiness. The naive version ran
 * the block-comment regex directly over the source, and `accept="image/*,application/pdf"`
 * contains `/*` — so it matched from inside that attribute to the next comment terminator and deleted the
 * `capture="environment"` line thirty characters later. The assertion then failed against
 * perfectly correct code.
 *
 * Masking keeps each literal's LENGTH, so `toContain` on a code fragment outside a string
 * still works and nothing shifts.
 */
const strip = (src: string): string => {
  /*
    Mask every string literal to same-length placeholders. Length is preserved so an index
    into the masked copy is an index into the original.
  */
  const masked = src.replace(
    /(["'])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m) => m[0] + "\u0000".repeat(Math.max(0, m.length - 2)) + m[0],
  );

  /* Find comment RANGES in the masked copy, then cut those ranges out of the original. */
  const ranges: Array<[number, number]> = [];
  for (const re of [/\{\/\*[\s\S]*?\*\/\}/g, /\/\*[\s\S]*?\*\//g, /(?<![:/])\/\/[^\n]*/g]) {
    for (const m of masked.matchAll(re)) {
      if (m.index !== undefined) ranges.push([m.index, m.index + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);

  let out = "";
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from < cursor) continue;   // already inside a range that was cut
    out += src.slice(cursor, from);
    cursor = to;
  }
  return out + src.slice(cursor);
};

const fn = strip(read("supabase", "functions", "attendance-self-punch", "index.ts"));
const card = strip(read("src", "features", "attendance", "components", "SelfPunchCard.tsx"));
const api = strip(read("src", "features", "attendance", "api", "selfPunch.api.ts"));
const queue = strip(read("src", "features", "admin", "components", "OffHoursApprovals.tsx"));
const uploader = strip(read("src", "features", "attendance", "api", "attendanceProof.api.ts"));
const schema = strip(read("supabase", "migrations", "20260903180000_an_off_hours_punch_carries_its_proof.sql"));

describe("the form makes it mandatory", () => {
  it("lifts the block once an upload has been TRIED and FAILED", () => {
    /*
      ── THE FAILURE THIS COST SOMEBODY ──────────────────────────────────────
      An employee starting at 8 am — before her 09:30 shift, so off-hours — could not punch at
      all, because the proof photograph would not upload and the button stayed disabled. Her
      hours were lost to a hard gate.

      The server was built to record a proofless off-hours punch and flag it for exactly this
      reason. The client gate meant that safety net was never reached: the request was never
      sent. Intent in the server is worth nothing if the client refuses to call it.

      `proofError === null` is the whole fix. Somebody who has not TRIED still faces the
      requirement; somebody whose upload failed may go ahead.
    */
    expect(card).toContain("proofDocId === null && proofError === null");
  });

  it("still requires it from somebody who has not tried", () => {
    // Mandatory, not optional. The gate lifts on FAILURE, never on inaction.
    const line = card.split("\n").find((l) => l.includes("const proofMissing ="));
    expect(line).toBeDefined();
    const clause = card.slice(card.indexOf("const proofMissing ="), card.indexOf("const cameraLive"));
    expect(clause).toContain("needsOffHoursReason === true");
  });

  it("blocks the punch button until the document id exists", () => {
    /*
      Gated on the ID, not on a file having been picked: a chosen file whose upload failed is
      not proof of anything, and letting it through would show the approver "proof attached"
      with nothing behind it.
    */
    expect(card).toContain("proofDocId === null");
    expect(card).toContain("disabled={busy || reasonTooShort || proofMissing}");
  });

  it("asks only for the punches that need it", () => {
    // An employee punching inside their shift must never see this or be stopped by it.
    expect(card).toContain("needsOffHoursReason === true");
  });

  it("uploads on choose, not on submit", () => {
    // So the employee learns the vault took it before spending a face capture on it.
    expect(card).toContain("uploadAttendanceProof({");
    expect(card).toContain("setProofDocId(doc.id)");
  });

  it("opens the rear camera on a phone and a file picker on a laptop", () => {
    expect(card).toContain('capture="environment"');
    expect(card).toContain('accept="image/*,application/pdf"');
  });

  it("checks the size against the type's own limit, not a hardcoded one", () => {
    expect(card).toContain("type.max_file_size_mb ?? 10");
  });
});

describe("the server records rather than refuses", () => {
  it("takes the proof as optional", () => {
    expect(fn).toContain("proofDocumentId: z.string().uuid().optional()");
  });

  it("flags an off-hours punch that arrived without one", () => {
    expect(fn).toContain('reviewNotes.push("off_hours_proof_missing")');
    expect(fn).toContain('if (!withinShift && (body.proofDocumentId ?? "") === "")');
  });

  it("does not refuse the punch for a missing proof", () => {
    /*
      THE DECISION THIS FILE EXISTS FOR. A `SELF_PUNCH_PROOF_REQUIRED` refusal would repeat
      the failure that already cost this venue two days of attendance.
    */
    expect(fn).not.toContain("PROOF_REQUIRED");
    expect(fn).not.toContain("SELF_PUNCH_PROOF");
  });

  it("attaches it only to a punch that needed one", () => {
    // An in-window punch carrying a photograph of somebody's home is collection nobody asked
    // for and nobody can justify later.
    expect(fn).toContain("${requiresApproval ? (body.proofDocumentId ?? null) : null}::uuid");
  });

  it("omits the key entirely when absent, because the body is strict", () => {
    expect(api).toContain('...((request.proofDocumentId ?? "") !== ""');
  });
});

describe("the approver sees whether a proof exists", () => {
  it("offers it through document-access, never a storage URL", () => {
    // document-access logs the view BEFORE it mints a URL. For evidence that decides whether
    // overtime is paid, that trail is the point.
    expect(queue).toContain("DocumentOpenButtons");
    expect(queue).toContain("documentId={row.proof_document_id}");
    expect(queue).not.toContain("createSignedUrl");
  });

  it("says so in words when nothing was attached", () => {
    /*
      Rendering nothing would let an approver assume a photograph exists and never open it —
      then approve the money.
    */
    expect(queue).toContain('t("admin.offHours.proof.missing")');
    expect(queue).toContain("row.proof_document_id !== null");
  });
});

describe("the stored document", () => {
  it("does NOT set is_confidential, because RLS forbids the uploader setting it", () => {
    /*
      ── THIS TEST WAS ASSERTING THE BUG ────────────────────────────────────────
      It read `is_confidential: true` and passed, because the flag was there. What it could
      not see is that `documents__self__insert` requires `is_confidential = false`, so every
      single upload was refused with 42501 AFTER the bytes had been written and were then
      cleaned up by the catch. An employee starting at 8 am could not punch at all, and the
      failure looked like a network problem rather than a rule. Probed against the live
      policy as the employee: `true` -> REFUSED [42501], `false` -> ACCEPTED, one flag the
      only difference.

      The policy is right. Letting employees mark their OWN uploads confidential would let
      them hide a photograph from the very people who have to review it. Confidentiality is
      a property of the TYPE, asserted below.
    */
    expect(uploader).toContain("is_confidential: false");
    expect(uploader).not.toContain("is_confidential: true");
  });

  it("is kept out of the general browser by its document TYPE instead", () => {
    /*
      Which is where it belonged all along: ATTENDANCE_PROOF carries is_sensitive = true, so
      every document of the type is handled that way regardless of what the uploading client
      claimed on the row.

      This is now the ONLY thing doing that job, so it is asserted rather than assumed. The
      original upsert's DO UPDATE re-asserted is_active, employee_uploadable and
      visible_to_employee but not this, which left it free to drift on any re-run.
    */
    const sensitive = strip(
      read("supabase", "migrations", "20260905160000_the_proof_photo_is_sensitive_by_type.sql"),
    );
    expect(sensitive).toContain("SET is_sensitive = true");
    expect(sensitive).toContain("code = 'ATTENDANCE_PROOF'");
    // And it refuses to finish if the type could not both take the upload and hide it.
    expect(sensitive).toContain("RAISE EXCEPTION");
  });

  it("does not go to a second approval queue of its own", () => {
    // The PUNCH is what gets approved, by somebody looking at the picture and the hours
    // together. Two queues would be one decision in two places.
    expect(schema).toContain("requires_approval");
    expect(uploader).toContain("input.type.requires_approval ? \"pending_review\" : \"approved\"");
  });

  it("writes the bytes before the row", () => {
    // `documents.storage_path` is NOT NULL, so a row pointing at bytes that were never
    // written is the worse artefact.
    const upload = uploader.indexOf(".upload(path");
    const insert = uploader.indexOf("insertOne(");
    expect(upload).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(upload);
  });

  it("cleans up the object when the row is refused", () => {
    expect(uploader).toContain(".remove([path])");
  });

  it("reuses the one path convention rather than copying it", () => {
    /*
      `documents__self__insert` requires the employee id to be the SECOND folder segment. A
      second implementation is a second chance to land bytes where the policy did not intend.
    */
    expect(uploader).toContain("storagePathFor(input.employeeId");
    expect(uploader).toContain('from "@/features/profile/api/documents.api"');
  });

  it("is not tied to the punch by a database constraint", () => {
    // A CHECK here would be the hard gate this whole design avoids.
    expect(schema).not.toMatch(/CHECK[^;]*proof_document_id/);
  });
});
