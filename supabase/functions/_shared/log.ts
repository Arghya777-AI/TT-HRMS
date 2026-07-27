/**
 * _shared/log.ts — structured JSON logging with a secret redactor.
 *
 * spec-architecture §4 (`log.ts` redactor) and §5: "any secret touching a log,
 * screenshot or chat = compromised → rotate". The redactor is the mechanical
 * guarantee that a careless `log.info("ctx", { headers })` cannot cost a key
 * rotation. It is applied to EVERY field of EVERY entry, always — there is no
 * opt-out parameter, deliberately.
 *
 * One line of JSON per entry on stdout (Supabase's log drain parses it):
 * ```json
 * {"ts":"2026-07-25T09:14:02.101Z","level":"info","fn":"kiosk-heartbeat",
 *  "request_id":"1f3…","msg":"heartbeat accepted","duration_ms":41,"status":200,
 *  "device_id":"a1b2…"}
 * ```
 *
 * What must never be logged, and is redacted even if passed:
 * service-role keys, user JWTs, device secrets, HMAC signatures, guard PINs,
 * face descriptors, Aadhaar/PAN/bank numbers, signing tokens, cron secret.
 */

import { nowIso, nowMs, toIso } from "./datetime.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** `LOG_LEVEL` env var, default `info`. Set `debug` on a branch project, never prod. */
function configuredLevel(): LogLevel {
  const raw = (Deno.env.get("LOG_LEVEL") ?? "info").toLowerCase();
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
}

export const REDACTED = "[redacted]";

/**
 * Key names whose VALUE is always dropped. Matched case-insensitively as a
 * substring, so `x-cron-secret`, `serviceRoleKey` and `pin_hash` all hit.
 */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|passphrase|\bpin\b|pin_hash|authorization|auth_header|apikey|api_key|anon_key|service_role|signature|credential|private_key|cookie|session_key|otp|challenge|descriptor|aadhaar|\bpan\b|\buan\b|account_number|card_number|ifsc_secret|bearer)/i;

/** Value shapes that are secret regardless of the key they arrived under. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // any JWT
  /\bsb(p|_secret|_publishable)?_[A-Za-z0-9_-]{20,}/gi, // Supabase key formats
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\bkdt_[A-Za-z0-9_-]{16,}/g, // kiosk device token
  /\bre_[A-Za-z0-9]{20,}/g, // Resend
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\$argon2[a-z]{0,2}\$[^\s"]+/gi, // Argon2 encoded hash
];

/** PII shapes reduced to their masked tail (mirrors `util.mask_tail`). */
const PII_PATTERNS: readonly { re: RegExp; visible: number }[] = [
  { re: /\b\d{12}\b/g, visible: 4 }, // Aadhaar
  { re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, visible: 4 }, // PAN
];

const MAX_DEPTH = 6;
const MAX_ARRAY = 20;
const MAX_STRING = 2_000;

function maskTail(value: string, visible: number): string {
  if (value.length <= visible) return "X".repeat(value.length);
  return "X".repeat(value.length - visible) + value.slice(-visible);
}

function redactString(value: string): string {
  let out = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  for (const { re, visible } of PII_PATTERNS) {
    out = out.replace(re, (m) => maskTail(m, visible));
  }
  return out;
}

/**
 * Deep-redact any value for logging. Exported because `errors.ts` consumers and
 * tests need the same function the logger uses — one redactor, one behaviour.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Date) return toIso(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: typeof value.stack === "string" ? redactString(value.stack) : undefined,
      cause: value.cause === undefined ? undefined : redact(value.cause, depth + 1),
    };
  }
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (value instanceof Headers) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redactString(v);
    }
    return out;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `[+${value.length - MAX_ARRAY} more]`] : head;
  }
  if (value instanceof Map) return redact(Object.fromEntries(value.entries()), depth);
  if (value instanceof Set) return redact([...value.values()], depth);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  /** Function name, e.g. `kiosk-heartbeat`. Appears on every line. */
  fn: string;
  requestId: string;
  /** Anything request-scoped worth having on every line (device_id, actor_id, …). */
  base?: LogFields;
}

/**
 * Request-scoped logger. One per invocation, created at lifecycle step 3 and
 * used by the `finally` block at step 12.
 */
export class Logger {
  readonly fn: string;
  readonly requestId: string;
  private readonly base: LogFields;
  private readonly threshold: number;
  private readonly startedMs: number;

  constructor(opts: LoggerOptions) {
    this.fn = opts.fn;
    this.requestId = opts.requestId;
    this.base = opts.base ?? {};
    this.threshold = LEVEL_ORDER[configuredLevel()];
    this.startedMs = nowMs();
  }

  /** Milliseconds since the logger (i.e. the request) was created. */
  elapsedMs(): number {
    return nowMs() - this.startedMs;
  }

  /** A logger carrying extra permanent fields; shares the original's timer. */
  child(fields: LogFields): Logger {
    const child = new Logger({ fn: this.fn, requestId: this.requestId, base: { ...this.base, ...fields } });
    // Keep one timeline per request: the child reports the parent's elapsed time.
    Object.defineProperty(child, "startedMs", { value: this.startedMs });
    return child;
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const entry = {
      ts: nowIso(),
      level,
      fn: this.fn,
      request_id: this.requestId,
      msg,
      ...(redact({ ...this.base, ...(fields ?? {}) }) as LogFields),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }

  /**
   * 5xx and unexpected throws. `sentry: true` marks the line for forwarding by
   * the log drain — the Sentry DSN is a client/relay concern, not a function
   * secret, so nothing here talks to Sentry directly.
   */
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, { sentry: true, ...(fields ?? {}) });
  }

  /**
   * Lifecycle step 12. Exactly one of these per invocation, from `finally`.
   * 5xx logs at `error`, 4xx at `warn`, success at `info`.
   */
  finish(status: number, fields?: LogFields): void {
    const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    this.write(level, "request complete", {
      status,
      duration_ms: this.elapsedMs(),
      ...(status >= 500 ? { sentry: true } : {}),
      ...(fields ?? {}),
    });
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new Logger(opts);
}
