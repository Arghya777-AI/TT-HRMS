/**
 * _shared/validate.ts — zod at the edge. Lint rule `local/edge-fn-must-validate`
 * requires every `functions/<name>/index.ts` with a body to import this module
 * (spec-architecture §7), so this is also the sanctioned re-export of `z`.
 * Never write that path as a glob in a block comment — the star-slash would
 * close the comment and the rest of the file would be parsed as code.
 *
 * One conversion, one status: a `ZodError` becomes a 422 problem+json whose
 * `errors[]` carries an RFC 6901 JSON pointer per rejected field. The client
 * maps pointer → form field; nothing has to parse prose.
 *
 * `readRawBody` exists because two consumers need the EXACT bytes the client
 * sent, before any parse: the kiosk HMAC (`auth.verifyDevice`) and the
 * idempotency request hash. Read it once, pass the string around; a `Request`
 * body can only be consumed once.
 */

import { z, ZodError } from "./deps.ts";
import type { ZodIssue, ZodType } from "./deps.ts";
import { problem, unprocessable, type ProblemErrorItem } from "./errors.ts";

export { z };

/** Default body ceiling. Descriptors are ~2 KB; punch photos go to Storage, never through JSON. */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** `["device","app_version"]` → `/device/app_version`; `[0]` → `/0`; `[]` → `` (whole body). */
export function zodPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "";
  return `/${path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

export function issuesToProblemErrors(issues: readonly ZodIssue[]): ProblemErrorItem[] {
  return issues.map((issue) => ({
    pointer: zodPointer(issue.path),
    code: issue.code,
    detail: issue.message,
  }));
}

/**
 * Parse or throw a 422. Use for bodies, query strings and anything else that
 * came from outside. `label` names the source in the problem `detail`.
 */
export function parse<S extends ZodType>(schema: S, input: unknown, label = "request body"): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const errors = issuesToProblemErrors(result.error.issues);
  throw unprocessable(
    errors,
    `${errors.length} problem${errors.length === 1 ? "" : "s"} in the ${label}.`,
  );
}

/** `parse` for values already known to be JSON-decoded. Alias kept for readability at call sites. */
export const parseOrThrow = parse;

export interface ReadBodyOptions {
  maxBytes?: number;
  /** Set false for functions that accept an empty body (rare). */
  requireJsonContentType?: boolean;
}

/**
 * Read the request body as text, exactly once, with a size ceiling.
 * Returns `""` for a bodyless request.
 *
 * Throws 413 over the ceiling and 415 when a non-empty body is not JSON.
 */
export async function readRawBody(req: Request, opts: ReadBodyOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw problem(413, "Payload too large", `Body exceeds ${maxBytes} bytes.`, undefined, {
      code: "PAYLOAD_TOO_LARGE",
    });
  }

  const raw = await req.text();
  if (raw.length === 0) return "";

  if (opts.requireJsonContentType !== false) {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("application/json")) {
      throw problem(415, "Unsupported media type", "Send `content-type: application/json`.", undefined, {
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
    }
  }

  // content-length can lie or be absent (chunked); re-check the real byte length.
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > maxBytes) {
    throw problem(413, "Payload too large", `Body exceeds ${maxBytes} bytes.`, undefined, {
      code: "PAYLOAD_TOO_LARGE",
    });
  }
  return raw;
}

/** Decode JSON or throw a 422 pointing at the whole body. */
export function decodeJson(raw: string): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw unprocessable(
      [{ pointer: "", code: "invalid_json", detail: "Body is not valid JSON." }],
      "The request body could not be parsed as JSON.",
      "MALFORMED_JSON",
    );
  }
}

export interface ParsedBody<T> {
  data: T;
  /** The exact bytes received — for HMAC verification and the idempotency hash. */
  raw: string;
}

/**
 * Lifecycle step 7 in one call: read → size/content-type check → JSON decode →
 * zod parse. Returns the parsed value AND the raw string.
 */
export async function parseBody<S extends ZodType>(
  req: Request,
  schema: S,
  opts: ReadBodyOptions & { allowEmpty?: boolean } = {},
): Promise<ParsedBody<z.infer<S>>> {
  const raw = await readRawBody(req, opts);
  if (raw.length === 0 && opts.allowEmpty !== true) {
    throw unprocessable(
      [{ pointer: "", code: "required", detail: "A JSON body is required." }],
      "The request body is empty.",
      "BODY_REQUIRED",
    );
  }
  return { data: parse(schema, decodeJson(raw), "request body"), raw };
}

/** Parse `?a=1&b=2` (repeated keys collapse to the last value; use arrays in a body instead). */
export function parseQuery<S extends ZodType>(url: URL | string, schema: S): z.infer<S> {
  const u = typeof url === "string" ? new URL(url) : url;
  return parse(schema, Object.fromEntries(u.searchParams.entries()), "query string");
}

/**
 * Schemas that mirror database constraints exactly. Use these instead of
 * re-deriving them — when the DB says `length(btrim(reason)) >= 10`, so does the
 * edge, and the client gets a 422 rather than a 500 from a CHECK violation.
 */
export const common = {
  uuid: z.string().uuid(),
  /** `YYYY-MM-DD` IST business date. */
  isoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date."),
  /** `HH:MM` or `HH:MM:SS` IST wall clock. */
  istTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Expected HH:MM or HH:MM:SS."),
  /** ISO-8601 instant. Client clocks are metadata only — the server timestamps the truth. */
  instant: z.string().datetime({ offset: true }),
  /** `audit.reason_required_tables` minimum, and the `ck_*__reason` CHECKs. */
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters."),
  /** Integer paise. D-04: money never travels as a float. */
  paise: z.number().int(),
  /** `[0,100]`, the mechanised form of the 1,700% defect. */
  percent: z.number().min(0).max(100),
  email: z.string().email().max(254),
  /** E.164, matching `ck_profiles__phone_e164`. */
  phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "Expected an E.164 phone number."),
  employeeCode: z.string().trim().min(1).max(32),
  /** Client-generated idempotency key. */
  idempotencyKey: z.string().trim().min(16).max(200),
  /** Kiosk HMAC nonce. */
  nonce: z.string().trim().min(16).max(120),
  appVersion: z.string().trim().min(1).max(40),
} as const;

export { ZodError };
