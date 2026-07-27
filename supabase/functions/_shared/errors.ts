/**
 * _shared/errors.ts — the one error envelope, RFC 9457 `application/problem+json`.
 *
 * spec-architecture §4: "status semantics 401 / 403 / 404 (never
 * exists-but-forbidden) / 409 / 410 / 422 (errors[]) / 423 locked / 429
 * (Retry-After) / 500 / 502 upstream / 503 kill switch".
 *
 * Shape on the wire:
 * ```json
 * {
 *   "type":     "https://hr.thetamarindtree.in/problems/unprocessable-entity",
 *   "title":    "Validation failed",
 *   "status":   422,
 *   "detail":   "2 fields were rejected.",
 *   "code":     "VALIDATION_FAILED",
 *   "instance": "/functions/v1/kiosk-heartbeat",
 *   "request_id": "0f0c…",
 *   "errors":  [{ "pointer": "/queue_depth", "code": "too_small", "detail": "…" }]
 * }
 * ```
 *
 * `HttpProblem` is a throwable: every helper in this layer throws one and the
 * function handler has a single `catch` that turns it into the response. That is
 * what keeps the 12-step lifecycle readable in 27 functions.
 *
 * Two rules that are security, not style:
 *   1. 404, not 403, when the caller must not learn the row exists.
 *   2. `detail` is caller-safe prose. Driver messages, SQL, stack traces and
 *      anything from Deno.env never go in it — they go to the logger.
 */

import { nowIso } from "./datetime.ts";

export const PROBLEM_BASE = "https://hr.thetamarindtree.in/problems";
export const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";

/** One field-level rejection. Populated by `validate.ts` from a ZodError. */
export interface ProblemErrorItem {
  /** RFC 6901 JSON pointer into the request body, e.g. `/device/app_version`. */
  pointer: string;
  /** Machine code — the Zod issue code, or a domain code such as `NOT_ROSTERED`. */
  code: string;
  /** One human sentence. Safe to show a user. */
  detail: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Stable machine code the client switches on (`KIOSK_NONCE_REPLAY`, …). */
  code?: string;
  request_id?: string;
  errors?: ProblemErrorItem[];
  /** 429/503 only — milliseconds. Mirrors the `Retry-After` header for fetch clients. */
  retry_after_ms?: number;
  /** 5xx only — the id to quote to support; the details are in the logs, not here. */
  error_ref?: string;
  occurred_at?: string;
}

export interface ProblemOptions {
  code?: string;
  requestId?: string;
  instance?: string;
  retryAfterMs?: number;
  errorRef?: string;
  headers?: Record<string, string>;
  /** Never serialised. Logged by the handler, then dropped. */
  cause?: unknown;
}

const TITLE_SLUGS: Record<number, string> = {
  400: "bad-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  405: "method-not-allowed",
  409: "conflict",
  410: "gone",
  413: "payload-too-large",
  415: "unsupported-media-type",
  422: "unprocessable-entity",
  423: "locked",
  426: "upgrade-required",
  429: "too-many-requests",
  500: "internal-server-error",
  502: "bad-gateway",
  503: "service-unavailable",
  504: "gateway-timeout",
};

function slugFor(status: number, title: string): string {
  const known = TITLE_SLUGS[status];
  if (known !== undefined) return known;
  const derived = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return derived === "" ? `status-${status}` : derived;
}

/**
 * A throwable problem. `toResponse()` is called exactly once, by the handler,
 * with the CORS headers for the request's origin.
 */
export class HttpProblem extends Error {
  override readonly name = "HttpProblem";
  readonly problem: Problem;
  readonly headers: Record<string, string>;

  constructor(problem: Problem, headers: Record<string, string> = {}, cause?: unknown) {
    super(`${problem.status} ${problem.title}${problem.detail ? `: ${problem.detail}` : ""}`);
    this.problem = problem;
    this.headers = headers;
    if (cause !== undefined) this.cause = cause;
  }

  get status(): number {
    return this.problem.status;
  }

  get code(): string | undefined {
    return this.problem.code;
  }

  /** True for 5xx — the handler logs these at `error` and reports to Sentry. */
  get isServerFault(): boolean {
    return this.problem.status >= 500;
  }

  /** Fill in request-scoped fields discovered after the throw (request_id, instance). */
  withContext(ctx: { requestId?: string; instance?: string }): HttpProblem {
    if (ctx.requestId && !this.problem.request_id) this.problem.request_id = ctx.requestId;
    if (ctx.instance && !this.problem.instance) this.problem.instance = ctx.instance;
    return this;
  }

  toResponse(extraHeaders: Record<string, string> = {}): Response {
    const headers: Record<string, string> = {
      "content-type": PROBLEM_CONTENT_TYPE,
      "cache-control": "no-store",
      ...extraHeaders,
      ...this.headers,
    };
    if (this.problem.request_id) headers["x-request-id"] = this.problem.request_id;
    if (this.problem.retry_after_ms !== undefined && headers["retry-after"] === undefined) {
      headers["retry-after"] = String(Math.max(1, Math.ceil(this.problem.retry_after_ms / 1000)));
    }
    return new Response(JSON.stringify(this.problem), { status: this.problem.status, headers });
  }
}

/**
 * Build a problem. `errors[]` is for 422 field rejections; everything else uses
 * `detail` + `code`.
 */
export function problem(
  status: number,
  title: string,
  detail?: string,
  errors?: ProblemErrorItem[],
  opts: ProblemOptions = {},
): HttpProblem {
  const p: Problem = {
    type: `${PROBLEM_BASE}/${slugFor(status, title)}`,
    title,
    status,
    occurred_at: nowIso(),
  };
  if (detail) p.detail = detail;
  if (errors && errors.length > 0) p.errors = errors;
  if (opts.code) p.code = opts.code;
  if (opts.requestId) p.request_id = opts.requestId;
  if (opts.instance) p.instance = opts.instance;
  if (opts.retryAfterMs !== undefined) p.retry_after_ms = opts.retryAfterMs;
  if (opts.errorRef) p.error_ref = opts.errorRef;
  return new HttpProblem(p, opts.headers ?? {}, opts.cause);
}

// ── Typed shortcuts ─────────────────────────────────────────────────────────
// One per status the catalogue uses. The `code` argument is the client-facing
// machine code (spec-kiosk §4.5 defines the KIOSK_* set).

/** 401 — no credential, or a credential that does not verify. */
export const unauthorized = (detail?: string, code = "UNAUTHORIZED", opts: ProblemOptions = {}) =>
  problem(401, "Unauthorized", detail, undefined, { ...opts, code });

/** 403 — verified caller, insufficient authority. Use only when the caller may KNOW the thing exists. */
export const forbidden = (detail?: string, code = "FORBIDDEN", opts: ProblemOptions = {}) =>
  problem(403, "Forbidden", detail, undefined, { ...opts, code });

/** 404 — absent OR out of scope. §4: "never exists-but-forbidden". */
export const notFound = (detail?: string, code = "NOT_FOUND", opts: ProblemOptions = {}) =>
  problem(404, "Not found", detail ?? "No such record, or it is outside your scope.", undefined, {
    ...opts,
    code,
  });

/** 405 — method not in the function's allowlist (lifecycle step 2). */
export const methodNotAllowed = (allow: readonly string[], opts: ProblemOptions = {}) =>
  problem(405, "Method not allowed", `Allowed: ${allow.join(", ")}.`, undefined, {
    ...opts,
    code: "METHOD_NOT_ALLOWED",
    headers: { allow: allow.join(", "), ...(opts.headers ?? {}) },
  });

/** 409 — state conflict: idempotency-key reuse with a different body, nonce replay, concurrent claim. */
export const conflict = (detail?: string, code = "CONFLICT", opts: ProblemOptions = {}) =>
  problem(409, "Conflict", detail, undefined, { ...opts, code });

/** 410 — the thing existed and is intentionally gone (expired token, consumed resolution). */
export const gone = (detail?: string, code = "GONE", opts: ProblemOptions = {}) =>
  problem(410, "Gone", detail, undefined, { ...opts, code });

/** 422 — well-formed request, invalid content. Always carries `errors[]`. */
export const unprocessable = (
  errors: ProblemErrorItem[],
  detail?: string,
  code = "VALIDATION_FAILED",
  opts: ProblemOptions = {},
) =>
  problem(
    422,
    "Validation failed",
    detail ?? `${errors.length} field${errors.length === 1 ? "" : "s"} rejected.`,
    errors,
    { ...opts, code },
  );

/** 423 — a lock refuses the write (attendance period lock, payroll run lock). */
export const locked = (detail?: string, code = "PERIOD_LOCKED", opts: ProblemOptions = {}) =>
  problem(423, "Locked", detail, undefined, { ...opts, code });

/** 429 — token bucket empty. Always sets Retry-After. */
export const tooMany = (retryAfterMs: number, detail?: string, code = "RATE_LIMITED", opts: ProblemOptions = {}) =>
  problem(429, "Too many requests", detail ?? "Rate limit exceeded. Retry after the stated delay.", undefined, {
    ...opts,
    code,
    retryAfterMs,
  });

/** 426 — client too old to be allowed to proceed (kiosk min_app_version). */
export const upgradeRequired = (detail?: string, code = "UPGRADE_REQUIRED", opts: ProblemOptions = {}) =>
  problem(426, "Upgrade required", detail, undefined, { ...opts, code });

/** 500 — our fault. `detail` stays generic; the truth is in the log under `error_ref`. */
export const serverError = (errorRef: string, detail?: string, opts: ProblemOptions = {}) =>
  problem(
    500,
    "Internal server error",
    detail ?? "Something went wrong on our side. Quote the reference when reporting it.",
    undefined,
    { ...opts, code: opts.code ?? "INTERNAL", errorRef },
  );

/** 502 — a third party (Anthropic, Resend) failed or answered unusably. */
export const badGateway = (detail?: string, code = "UPSTREAM_FAILED", opts: ProblemOptions = {}) =>
  problem(502, "Upstream failure", detail, undefined, { ...opts, code });

/** 503 — deliberate kill switch (feature flag off, AI budget exceeded). */
export const unavailable = (detail?: string, code = "UNAVAILABLE", opts: ProblemOptions = {}) =>
  problem(503, "Service unavailable", detail, undefined, { ...opts, code });

// ── Handler-side plumbing ───────────────────────────────────────────────────

export function isProblem(err: unknown): err is HttpProblem {
  return err instanceof HttpProblem;
}

/**
 * Last-resort funnel for the `catch` in every function: a thrown `HttpProblem`
 * passes through untouched, anything else becomes a 500 whose detail says
 * nothing. `errorRef` is the request id — that is the join key into the logs.
 */
export function toProblem(err: unknown, errorRef: string): HttpProblem {
  if (isProblem(err)) {
    if (!err.problem.error_ref && err.isServerFault) err.problem.error_ref = errorRef;
    return err;
  }
  return serverError(errorRef, undefined, { cause: err });
}

/** JSON success response. Mirrors the problem path so headers are handled identically. */
export function ok(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; requestId?: string } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers ?? {}),
  };
  if (init.requestId) headers["x-request-id"] = init.requestId;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}
