/**
 * The claim rules the browser mirrors from the database.
 *
 * Two things these are really guarding.
 *
 *  * THE MIRROR STAYS A MIRROR. `billDateIssue` restates
 *    `claim_lines_check_bill_date` (migration 040400). If the two drift, one of
 *    two bad things happens: the form accepts a bill the database then refuses
 *    with a raw error, or the form refuses one the database would have taken.
 *    The window-of-0 case below is the one most likely to drift, because "0
 *    disables the check" is a convention rather than something the types carry.
 *
 *  * DATES DO NOT MOVE WITH THE READER. The previous screen compared civil dates
 *    through `new Date(...)`, which is midnight LOCAL — so the same bill was a
 *    day older to someone in a different timezone. Everything here is compared
 *    as UTC day numbers.
 */
import { describe, expect, it } from "vitest";
import {
  billDateIssue,
  daysBetween,
  isReadableReceipt,
  isTravelClaim,
  readableFieldCount,
  sniffReadableMime,
  receiptIssue,
  travelModeValues,
  travelPurposeValues,
} from "./claimPolicy";
import { rupeesToPaise, rupeesAsNumber } from "./api/claim-submit.api";

const TODAY = "2026-08-10";

describe("billDateIssue", () => {
  it("accepts a bill from today and from inside the window", () => {
    expect(billDateIssue(TODAY, TODAY, 180)).toBeNull();
    expect(billDateIssue("2026-08-01", TODAY, 180)).toBeNull();
    // Exactly on the boundary is inside it — the trigger uses `< today - days`.
    expect(billDateIssue("2026-02-11", TODAY, 180)).toBeNull();
  });

  it("refuses a future bill", () => {
    expect(billDateIssue("2026-08-11", TODAY, 180)).toBe("future");
    expect(billDateIssue("2027-01-01", TODAY, 180)).toBe("future");
  });

  it("refuses a bill older than the window", () => {
    expect(billDateIssue("2026-02-10", TODAY, 180)).toBe("outside_window");
    expect(billDateIssue("2019-04-01", TODAY, 180)).toBe("outside_window");
  });

  it("treats a window of 0 as no age limit, exactly as the trigger does", () => {
    expect(billDateIssue("2019-04-01", TODAY, 0)).toBeNull();
    // A future bill is still refused — that check is unconditional.
    expect(billDateIssue("2027-01-01", TODAY, 0)).toBe("future");
  });

  it("reports a non-date rather than guessing at one", () => {
    expect(billDateIssue("", TODAY, 180)).toBe("not_a_date");
    expect(billDateIssue("10-08-2026", TODAY, 180)).toBe("not_a_date");
    expect(billDateIssue("2026-02-31", TODAY, 180)).toBe("not_a_date");
    expect(billDateIssue("2026-13-01", TODAY, 180)).toBe("not_a_date");
  });
});

describe("daysBetween", () => {
  it("counts whole days across a month and a leap day", () => {
    expect(daysBetween("2026-08-01", "2026-08-10")).toBe(9);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // 2024 is a leap year
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("does not shift across a DST-style boundary", () => {
    // India has no DST, but the reader's browser might. UTC day numbers make the
    // arithmetic independent of where the claim is being typed.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });

  it("is negative when the range runs backwards", () => {
    expect(daysBetween("2026-08-10", "2026-08-01")).toBe(-9);
  });
});

describe("receiptIssue", () => {
  it("accepts ANY file type", () => {
    // Asked for: "why only image, keep option to upload any file". Nothing on the
    // server disagrees — the `documents` bucket has no MIME allow-list, and
    // `document_types.allowed_mime_types` is read by the picker, not enforced.
    for (const type of [
      "image/jpeg",
      "application/pdf",
      "image/heic",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "message/rfc822",
      "",
    ]) {
      expect(receiptIssue({ size: 1024, type })).toBeNull();
    }
  });

  it("still refuses a file bigger than the type's limit", () => {
    // Not taste: the file is base64'd into a model request when it is read, and
    // `document_types.max_file_size_mb` is 10 for this type.
    expect(receiptIssue({ size: 11 * 1024 * 1024, type: "image/jpeg" })).toBe("too_large");
    expect(receiptIssue({ size: 10 * 1024 * 1024, type: "image/jpeg" })).toBeNull();
  });
});

describe("isReadableReceipt", () => {
  it("separates what can be ATTACHED from what can be READ", () => {
    expect(isReadableReceipt("image/jpeg")).toBe(true);
    expect(isReadableReceipt("application/pdf")).toBe(true);
    expect(isReadableReceipt("IMAGE/PNG")).toBe(true); // case is not the user's problem
    // Valid evidence, just not machine-readable — attach it and type the details.
    expect(isReadableReceipt("application/vnd.ms-excel")).toBe(false);
    expect(isReadableReceipt("image/heic")).toBe(false);
  });
});

describe("sniffReadableMime", () => {
  const head = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(16).fill(0)]);

  it("recognises a PDF whose NAME says nothing", () => {
    /*
      The reported case: a bill saved as `invoice.pdf -10-Aug-2026-11_37 AM`.
      The name does not end in `.pdf`, so the browser reports `file.type` as ""
      and the screen said the file could not be read. The bytes say otherwise.
    */
    expect(sniffReadableMime(head(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe("application/pdf");
  });

  it("recognises the image formats the reader can use", () => {
    expect(sniffReadableMime(head(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    expect(sniffReadableMime(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffReadableMime(head(0x47, 0x49, 0x46, 0x38))).toBe("image/gif");
    // RIFF....WEBP — the type is at offset 8, not 4.
    expect(
      sniffReadableMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("returns null for anything it does not recognise, rather than guessing", () => {
    // A .docx (a zip) is valid evidence and simply is not readable — the caller
    // falls back to the browser's own answer, which is the honest one here.
    expect(sniffReadableMime(head(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(sniffReadableMime(head(0x00, 0x00, 0x00))).toBeNull();
    expect(sniffReadableMime(new Uint8Array([]))).toBeNull();
  });

  it("does not read past the end of a short file", () => {
    // A truncated RIFF header must not be reported as WEBP off the back of
    // undefined reads.
    expect(sniffReadableMime(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });

  it("feeds isReadableReceipt, which is what the screen actually asks", () => {
    const pdf = sniffReadableMime(head(0x25, 0x50, 0x44, 0x46, 0x2d));
    expect(pdf !== null && isReadableReceipt(pdf)).toBe(true);
  });
});

describe("isTravelClaim", () => {
  it("asks how they travelled only where a journey happened", () => {
    expect(isTravelClaim("local_conveyance")).toBe(true);
    expect(isTravelClaim("travel")).toBe(true);
    expect(isTravelClaim("fuel")).toBe(true);
    expect(isTravelClaim("medical")).toBe(false);
    expect(isTravelClaim("telephone")).toBe(false);
  });
});

describe("the dropdown vocabularies match the database CHECKs", () => {
  it("carries exactly the values ck_claim_lines__travel_purpose permits", () => {
    expect([...travelPurposeValues]).toEqual(["sales", "support", "management"]);
  });

  it("carries exactly the values ck_claim_lines__travel_mode permits", () => {
    expect([...travelModeValues]).toEqual([
      "taxi",
      "auto",
      "bus",
      "bike",
      "car",
      "company_bike",
      "company_car",
      "train",
      "flight",
      "other",
    ]);
  });
});

describe("readableFieldCount", () => {
  it("counts only what the reader actually returned", () => {
    expect(readableFieldCount({ a: null, b: null })).toBe(0);
    expect(readableFieldCount({ a: 1250, b: null, c: "Auto fare" })).toBe(2);
    // An empty string is not a reading either.
    expect(readableFieldCount({ a: "", b: "x" })).toBe(1);
  });
});

/*
  `rupeesToPaise` has carried every claim since the screen shipped and had no
  test. It is string arithmetic precisely so that ₹1,234.56 cannot arrive as
  123455.99999 — which is the whole reason it exists rather than `* 100`.
*/
describe("rupeesToPaise", () => {
  it("encodes rupees as integer paise without float arithmetic", () => {
    expect(rupeesToPaise("1250")).toBe(125000);
    expect(rupeesToPaise("1250.50")).toBe(125050);
    expect(rupeesToPaise("1234.56")).toBe(123456);
    expect(rupeesToPaise("0.05")).toBe(5);
    expect(rupeesToPaise("1250.5")).toBe(125050);
  });

  it("accepts the thousands separators people actually type", () => {
    expect(rupeesToPaise("1,250.50")).toBe(125050);
    expect(rupeesToPaise(" 1,20,000 ")).toBe(12000000);
  });

  it("refuses anything that is not a rupee figure", () => {
    expect(rupeesToPaise("")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise("-100")).toBeNull();
    expect(rupeesToPaise("12.345")).toBeNull();
    expect(rupeesToPaise("₹100")).toBeNull();
  });

  it("agrees with rupeesAsNumber on what is valid", () => {
    for (const raw of ["1250", "1250.50", "1,250", "", "abc", "-1"]) {
      expect(rupeesToPaise(raw) === null).toBe(rupeesAsNumber(raw) === null);
    }
  });
});
