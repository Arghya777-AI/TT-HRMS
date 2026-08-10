/**
 * claimPolicy.ts — the claim rules that are pure, so they can be tested.
 *
 * Everything here is a MIRROR of a rule the database enforces, never the rule
 * itself. `trg_claim_lines__bill_date` (migration 040400) refuses a future or
 * out-of-window bill, `ck_claim_lines__travel_mode` refuses an unknown mode, and
 * `documents__self__insert` refuses the wrong document type. This module exists
 * so the form can say so BEFORE the round trip, in the same words.
 *
 * That order matters and is easy to get backwards: the previous version of this
 * screen enforced the future-date rule and a minimum description length in the
 * browser ONLY, so a direct PostgREST call sailed past both. A rule that lives
 * only in the form is a rule the form's author enforces, not the company. These
 * are duplicates of server rules for the sake of a fast, kind error message —
 * if one of them is ever the ONLY place a rule lives, that is a defect.
 *
 * No `Date` construction from a locale string anywhere: dates arrive as
 * `YYYY-MM-DD` in IST and are compared as UTC day numbers, so a browser in
 * another timezone cannot shift a bill by a day.
 */

/** `ck_claim_lines__travel_purpose` (040400). */
export const travelPurposeValues = ["sales", "support", "management"] as const;
export type TravelPurpose = (typeof travelPurposeValues)[number];

/** `ck_claim_lines__travel_mode` (040400). */
export const travelModeValues = [
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
] as const;
export type TravelMode = (typeof travelModeValues)[number];

/** The document type seeded by 040400; the only one the OCR function will read. */
export const CLAIM_RECEIPT_TYPE_CODE = "EXPENSE_RECEIPT";

/** `document_types.max_file_size_mb` for that type. */
export const CLAIM_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * ANY FILE MAY BE ATTACHED. Asked for directly: "why only image, keep option to
 * upload any file".
 *
 * Nothing on the server disagrees. The `documents` bucket is created with
 * `allowed_mime_types = NULL` and `file_size_limit = NULL` (039), and no policy
 * or trigger reads `document_types.allowed_mime_types` — it is metadata the
 * picker consults, not a rule the database enforces. The narrow list this
 * replaced was a client-side convention, and a convention that refuses a bill
 * somebody actually holds is just an obstacle.
 *
 * SIZE IS STILL CAPPED, for a reason that is not taste: the file is base64'd
 * into a model request when it is read, and `document_types.max_file_size_mb`
 * says 10 for this type.
 */

/**
 * The formats the reader can actually see inside.
 *
 * Kept as a SEPARATE list from what may be attached, because they answer
 * different questions. A .docx receipt is perfectly valid evidence and belongs
 * in the vault; it simply cannot be read automatically, and the screen should
 * say so at the moment of attaching rather than after a failed round trip.
 */
export const CLAIM_RECEIPT_READABLE_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const;

/**
 * What the file actually IS, from its first bytes.
 *
 * REPORTED: a PDF saved as `invoice.pdf -10-Aug-2026-11_37 AM` was attached and
 * the screen said it could not be read. It was a perfectly ordinary PDF — but
 * the name does not END in `.pdf`, so the browser could not infer a type and
 * reported `file.type` as an empty string. Everything downstream believed it:
 * the row would have been stored as `application/octet-stream`, and the reader
 * refuses that.
 *
 * A browser's `file.type` is a guess made from the file NAME. The magic number
 * is the file telling you what it is. Where they disagree, the bytes win.
 *
 * Only the formats the reader can use are detected — this is not a general
 * content-type sniffer, and anything unrecognised falls back to whatever the
 * browser said, which is the honest answer for a .docx or a .zip.
 */
export function sniffReadableMime(head: Uint8Array): string | null {
  const at = (i: number): number => head[i] ?? -1;
  // "%PDF-"
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) {
    return "application/pdf";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  // \x89 P N G \r \n \x1a \n
  if (
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "image/png";
  }
  // "GIF8"
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  // "RIFF" ....  "WEBP"
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** How many bytes `sniffReadableMime` needs. WEBP is the longest signature. */
export const MIME_SNIFF_BYTES = 12;

/** True when the OCR reader has a chance with this file. */
export function isReadableReceipt(mimeType: string): boolean {
  return (CLAIM_RECEIPT_READABLE_MIME as readonly string[]).includes(mimeType.toLowerCase());
}

/**
 * The heads where asking how somebody travelled makes sense.
 *
 * A medical certificate has no mode of travel, and offering the dropdown anyway
 * is how a form teaches people that its questions are decorative — they pick
 * anything to get past it, and the data is then worse than absent.
 */
const TRAVEL_CLAIM_TYPES: ReadonlySet<string> = new Set([
  "local_conveyance",
  "travel",
  "fuel",
]);

export function isTravelClaim(claimType: string): boolean {
  return TRAVEL_CLAIM_TYPES.has(claimType);
}

/** `YYYY-MM-DD` → a UTC day number, or null when it is not a civil date. */
function utcDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const stamp = Date.UTC(y, mo - 1, d);
  // Rejects 31 February and friends: Date.UTC rolls them over, so a round trip
  // that changes the day means the input was not a real date.
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return stamp;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `fromIso` to `toIso`; null if either is not a civil date. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = utcDay(fromIso);
  const b = utcDay(toIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

export type BillDateIssue = "not_a_date" | "future" | "outside_window" | null;

/**
 * Mirrors `claim_lines_check_bill_date`.
 *
 * `windowDays <= 0` disables the age check, exactly as the trigger does — the
 * setting is documented as "0 disables the check" and the two must agree, or the
 * form refuses something the database would have accepted.
 */
export function billDateIssue(
  billDate: string,
  todayIso: string,
  windowDays: number,
): BillDateIssue {
  const age = daysBetween(billDate, todayIso);
  if (age === null) return "not_a_date";
  if (age < 0) return "future";
  if (windowDays > 0 && age > windowDays) return "outside_window";
  return null;
}

/**
 * `wrong_type` is retained in the union and never returned any more — the type
 * of a bill is not this screen's business. Only the size is.
 */
export type ReceiptIssue = "too_large" | "wrong_type" | null;

export function receiptIssue(file: { readonly size: number; readonly type: string }): ReceiptIssue {
  if (file.size > CLAIM_RECEIPT_MAX_BYTES) return "too_large";
  return null;
}

/**
 * How many of the fields the reader came back with were usable.
 *
 * The edge function has already blanked anything it was not sure about, so a
 * null here means "not read", not "read as empty". The screen uses the count to
 * decide between offering the details and simply saying it could not read the
 * bill — offering a dialog with nothing in it reads as a failure either way, and
 * an empty one wastes a tap.
 */
export function readableFieldCount(fields: Record<string, unknown>): number {
  return Object.values(fields).filter((v) => v !== null && v !== undefined && v !== "").length;
}
