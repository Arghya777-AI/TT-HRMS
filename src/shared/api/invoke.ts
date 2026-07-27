/**
 * invoke.ts — the ONE way the browser calls a Supabase Edge Function.
 *
 * Contract (docs/build/frontend-contract.md §5):
 *  - POST `${VITE_SUPABASE_URL}/functions/v1/<name>` with the session JWT.
 *  - Every call carries an `Idempotency-Key` (UUID v4). For mutations, generate
 *    the key ONCE at form mount (`newIdempotencyKey()`) and reuse it across
 *    retries so the server can collapse repeats.
 *  - Success envelope: `{ ok: true, data: <payload> }` — payload zod-parsed.
 *  - Errors are RFC 9457 problem+json, surfaced as `TTApiError`.
 *  - A `409` replay (server saw this idempotency key already) is exposed via
 *    `TTApiError.isIdempotentReplay` — mutation UIs treat it as success.
 */
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";

/** RFC 9457 problem details (extension members preserved via passthrough). */
export const problemSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    status: z.number().optional(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    /** TT extension: stable machine code, e.g. 'idempotent_replay', 'period_locked'. */
    code: z.string().optional(),
    /** TT extension: correlation ref surfaced to the user on 5xx. */
    error_ref: z.string().optional(),
  })
  .passthrough();

export type Problem = z.infer<typeof problemSchema>;

export class TTApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  readonly fn: string;
  readonly idempotencyKey: string;

  constructor(fn: string, status: number, problem: Problem, idempotencyKey: string) {
    super(problem.detail ?? problem.title ?? `Edge function ${fn} failed (${status})`);
    this.name = "TTApiError";
    this.fn = fn;
    this.status = status;
    this.problem = problem;
    this.idempotencyKey = idempotencyKey;
  }

  /** Server already processed this idempotency key — UIs treat as success. */
  get isIdempotentReplay(): boolean {
    return this.status === 409 && this.problem.code === "idempotent_replay";
  }
}

const envelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() });

/** UUID v4 idempotency key. Generate once per form mount, reuse on retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface InvokeOptions {
  /** Reuse a mount-scoped key for mutations. Defaults to a fresh UUID v4. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Call an edge function and return its zod-parsed payload.
 * Throws `TTApiError` on any non-2xx (network errors propagate as TypeError).
 *
 * The schema is taken as `S extends z.ZodTypeAny` and the result typed as
 * `z.infer<S>` — the same pattern as the query layer. The earlier signature,
 * `dataSchema: z.ZodType<T>`, pinned zod's INPUT type to its output type, so any
 * schema that transforms on the way in could not satisfy it: `dbInt` accepts
 * `string | number` from Postgres and yields `number`, and TypeScript resolved
 * the conflict by widening the whole payload back to `string | number`. Callers
 * then failed to assign their own `z.infer<...>` return type, and the honest
 * fix is here rather than a cast at each of the 28 function wrappers.
 */
export async function invokeEdgeFn<S extends z.ZodTypeAny>(
  name: string,
  body: unknown,
  dataSchema: S,
  opts: InvokeOptions = {},
): Promise<z.infer<S>> {
  const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const res = await fetch(`${env.supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.supabasePublishableKey,
      Authorization: `Bearer ${token ?? env.supabasePublishableKey}`,
      // ONLY `x-idempotency-key`. The deployed functions read exactly that name
      // (`_shared/idempotency.ts:idempotencyKeyFrom`) and `requireIdempotencyKey`
      // rejects with 422 when it is absent.
      //
      // The RFC spelling `Idempotency-Key` and `x-application-name` USED to be
      // sent here too, and both were fatal in a browser: neither is in
      // `_shared/cors.ts`'s `Access-Control-Allow-Headers`, and a browser BLOCKS a
      // preflighted request whose headers the server does not permit — so the call
      // never left the tab. PostgREST reads kept working (they send no custom
      // headers), which is why the symptom looked like "edge functions are broken"
      // rather than "CORS". A grep proved nothing reads either name inbound: the
      // only `idempotency-key` hits are OUTBOUND headers that
      // communication-send/notification-dispatch set on Resend requests.
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body ?? {}),
    signal: opts.signal,
  });

  if (!res.ok) {
    let problem: Problem = { status: res.status, title: res.statusText };
    try {
      const parsed = problemSchema.safeParse(await res.json());
      if (parsed.success) problem = { status: res.status, ...parsed.data };
    } catch {
      // Non-JSON error body — keep the statusText problem.
    }
    throw new TTApiError(name, res.status, problem, idempotencyKey);
  }

  const json: unknown = await res.json();
  const envelope = envelopeSchema.safeParse(json);
  // Canonical shape is { ok: true, data }; tolerate a bare payload so the shell
  // keeps working against pre-contract functions.
  const payload = envelope.success ? envelope.data.data : json;
  return dataSchema.parse(payload);
}
