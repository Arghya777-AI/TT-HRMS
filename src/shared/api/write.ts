/**
 * write.ts — the ONE way a feature `api/` module writes a row through PostgREST.
 *
 * Companion to `query.ts`, same contract, opposite direction:
 *  - Pages/components never touch `@/lib/supabase`; they call a feature
 *    `api/*.ts`, which calls these helpers (architecture D-01).
 *  - The row PostgREST returns is zod-parsed here, so a caller never gets an
 *    unvalidated payload back from a write either.
 *  - No business logic lives here. These helpers move a value bag to a table;
 *    every rule (day expansion, notice period, balance, overlap) is enforced by
 *    the database triggers that fire on the write.
 *
 * Why a write path exists at all, given "mutations go through edge functions":
 * there is no leave edge function in `supabase/functions/`. The deployed design
 * puts the whole leave rulebook in Postgres — `leave_requests_submit_guard`,
 * `rebuild_leave_request_days`, `leave_requests_apply_ledger` — and grants
 * `INSERT, UPDATE ON public.leave_requests` to `authenticated` (migration 019
 * line 1435) precisely so a self-service client can submit under RLS. So the
 * server is still the only thing that decides anything; the browser only posts
 * the intent. `invokeEdgeFn` stays the path for anything that needs the service
 * role.
 *
 * NOT FOR AUDITED TABLES. `insertOne`/`updateOne` send no `X-Reason` header, so a
 * write through them to any table in `audit.reason_required_tables` (employees,
 * attendance_days, user_roles, settings, leave_types, documents, payroll_runs,
 * employee_salary_revisions, holidays, pay_periods, leave_balances,
 * attendance_locks, attendance_policies, statutory_settings, kiosk_devices,
 * employee_statutory, employee_bank_accounts) is refused with SQLSTATE 22023.
 * Use `insertRow` / `updateRow` / `upsertRow` / `softDelete` from
 * `@/shared/api/query` for those — they carry the reason and refuse a short one
 * before the request. This file stays for the self-service leave path, whose
 * tables are not reason-gated.
 *
 * Error kinds are mapped from the WRITE-side Postgres vocabulary, which is a
 * different set from the read side: a `RAISE EXCEPTION ... errcode='23514'` out
 * of a submit guard is the normal way this database says "your request breaks a
 * rule", and its `message` is written to be shown to a person.
 */
import { z } from "zod";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { QueryError, type FilterScalar, type QueryErrorKind } from "@/shared/api/query";

/**
 * Write-side codes. `conflict` is the interesting one: it means the database
 * refused on a rule, `error.message` explains why in words, and retrying the
 * identical payload cannot help — the user has to change something.
 */
const WRITE_CODE_KIND: Readonly<Record<string, QueryErrorKind>> = {
  "23514": "conflict", // check_violation      → a guard / CHECK rejected the row
  "23P01": "conflict", // exclusion_violation  → overlapping leave request
  "23505": "conflict", // unique_violation
  "23503": "conflict", // foreign_key_violation
  "0A000": "conflict", // feature_not_supported → the "system-managed row" guards
  P0002: "not_found", // no_data_found (RAISE from a definer function)
  "42501": "no_permission", // insufficient_privilege / RLS WITH CHECK refused
  "42P01": "schema",
  "42703": "schema",
  "42883": "schema",
  PGRST116: "not_found",
  PGRST301: "no_permission",
  PGRST302: "no_permission",
  PGRST202: "schema",
  PGRST204: "schema",
};

function fromPostgrestWrite(relation: string, error: PostgrestError): QueryError {
  const code = error.code ?? null;
  const kind: QueryErrorKind = (code !== null ? WRITE_CODE_KIND[code] : undefined) ?? "unknown";
  return new QueryError(relation, kind, error.message, {
    code,
    details: error.details ?? null,
    hint: error.hint ?? null,
    cause: error,
  });
}

function fromThrownWrite(relation: string, e: unknown): QueryError {
  if (e instanceof QueryError) return e;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const message = e instanceof Error ? e.message : String(e);
  return new QueryError(relation, offline || e instanceof TypeError ? "offline" : "unknown", message, {
    cause: e,
  });
}

/**
 * True when the database refused the write on a business rule and said why.
 * The message is safe to render: these come from `RAISE EXCEPTION` strings that
 * were written for a person ("leave type CL does not allow half days").
 */
export function isRuleRejection(e: unknown): e is QueryError {
  return e instanceof QueryError && e.kind === "conflict";
}

/*
  `ruleRejectionMessage` — "did the database say something worth SHOWING?" —
  lives in query.ts beside `QueryError` and `mutationUserMessage`. It cannot live
  here: this module imports query.ts, and the dependency the other way would be a
  cycle.
*/

interface WriteBuilder {
  insert(values: Record<string, unknown>): WriteBuilder;
  update(values: Record<string, unknown>): WriteBuilder;
  eq(column: string, value: unknown): WriteBuilder;
  select(columns: string): WriteBuilder;
  limit(count: number): WriteBuilder;
  abortSignal(signal: AbortSignal): WriteBuilder;
  then: PromiseLike<{ data: unknown; error: PostgrestError | null }>["then"];
}

async function runWrite(
  relation: string,
  builder: WriteBuilder,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  const b = signal ? builder.abortSignal(signal) : builder;
  let res: { data: unknown; error: PostgrestError | null };
  try {
    res = await b;
  } catch (e) {
    throw fromThrownWrite(relation, e);
  }
  if (res.error) throw fromPostgrestWrite(relation, res.error);
  if (res.data === null || res.data === undefined) return [];
  return Array.isArray(res.data) ? res.data : [res.data];
}

function parseWritten<S extends z.ZodTypeAny>(
  relation: string,
  schema: S,
  rows: unknown[],
): z.infer<S> {
  const row = rows[0];
  if (row === undefined) {
    throw new QueryError(
      relation,
      "not_found",
      `${relation} accepted the write but returned no row — RLS withheld the result of your own write.`,
    );
  }
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new QueryError(
      relation,
      "parse",
      `Row written to ${relation} does not match its schema: ${parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export interface WriteOptions {
  /** Projection of the row to read back. Default '*'. */
  readonly columns?: string;
  readonly signal?: AbortSignal;
}

/** Insert one row and return it, zod-parsed. */
export async function insertOne<S extends z.ZodTypeAny>(
  table: string,
  schema: S,
  values: Readonly<Record<string, unknown>>,
  opts: WriteOptions = {},
): Promise<z.infer<S>> {
  // No `.limit(1)`: PostgREST refuses a limit on a mutation that has no explicit
  // order (PGRST109). The row count is bounded by the payload being one object.
  const b = (supabase.from(table) as unknown as WriteBuilder)
    .insert({ ...values })
    .select(opts.columns ?? "*");
  const rows = await runWrite(table, b, opts.signal);
  return parseWritten(table, schema, rows);
}

/**
 * Update the row(s) matching every key in `keys` (equality only — a write
 * targets rows by primary/business key, never by a range) and return the first
 * updated row, zod-parsed.
 */
export async function updateOne<S extends z.ZodTypeAny>(
  table: string,
  schema: S,
  values: Readonly<Record<string, unknown>>,
  keys: Readonly<Record<string, FilterScalar>>,
  opts: WriteOptions = {},
): Promise<z.infer<S>> {
  let b = (supabase.from(table) as unknown as WriteBuilder).update({ ...values });
  for (const [column, value] of Object.entries(keys)) b = b.eq(column, value);
  // As above: no limit on a mutation (PGRST109). `keys` is an equality set on the
  // primary/business key, so at most one row matches by construction.
  b = b.select(opts.columns ?? "*");
  const rows = await runWrite(table, b, opts.signal);
  return parseWritten(table, schema, rows);
}
