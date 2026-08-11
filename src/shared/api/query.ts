/**
 * query.ts — the ONE way a feature `api/` module reads a Postgres VIEW, and
 * (bottom half of this file) the ONE way it performs an AUDITED WRITE.
 *
 * Contract (docs/build/frontend-contract.md §5):
 *  - Pages/components never touch `@/lib/supabase`; they call a feature
 *    `api/*.ts`, which calls these helpers (architecture D-01).
 *  - EVERY row is zod-parsed here. Nothing returns un-parsed network data and
 *    there is no `as` cast on a payload — a schema drift surfaces as a
 *    `QueryError{ kind: "parse" }`, not as `undefined` three renders later.
 *  - Pagination is KEYSET, never OFFSET. OFFSET on a live table silently skips
 *    or repeats rows while the engine is writing attendance; a cursor cannot.
 *  - No arithmetic lives here. These helpers move server-computed rows; they
 *    never sum, average or re-derive a business number.
 *
 * On RLS and "no permission":
 *   RLS denial is NOT a Postgres error — the row simply is not in the result
 *   set. So an absent row is ambiguous by construction, and the two cases are
 *   surfaced differently on purpose:
 *     * `selectOne`  → `null`  (caller decides: empty state or no-permission)
 *     * `selectOneOrThrow` → `QueryError{ kind: "not_found" }` for a row the
 *       caller asserts must exist — i.e. it was filtered by RLS.
 *   A genuine privilege failure (missing GRANT, expired JWT) arrives as a real
 *   Postgres code and maps to `kind: "no_permission"`.
 */
import { z } from "zod";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { nowInstantIso } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";
import { humaniseRefusal } from "./humaniseRefusal";
// Safe: `invoke.ts` does not import from this module, so this is not a cycle.
import { TTApiError } from "./invoke";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Why a read failed, at the granularity a UI actually branches on.
 *  - `no_permission` — GRANT/JWT/privilege failure, or a row RLS withheld.
 *  - `not_found`     — the read asserted a row and got none (usually RLS).
 *  - `offline`       — the request never reached Postgres.
 *  - `schema`        — view/column/function missing: a deploy mismatch, ours to fix.
 *  - `parse`         — the row shape disagrees with our zod schema.
 *  - `conflict`      — constraint violation surfaced on a read path (rare).
 *  - `unknown`       — anything else; show the error_ref and let the user retry.
 */
export type QueryErrorKind =
  | "no_permission"
  | "not_found"
  | "offline"
  | "schema"
  | "parse"
  | "conflict"
  | "unknown";

/** Postgres / PostgREST codes we branch on by name rather than by number. */
const CODE_KIND: Readonly<Record<string, QueryErrorKind>> = {
  // Postgres
  "42501": "no_permission", // insufficient_privilege
  "42P01": "schema", // undefined_table  → view not deployed
  "42883": "schema", // undefined_function → RPC not deployed
  "42703": "schema", // undefined_column → we asked for a column that isn't there
  "23505": "conflict", // unique_violation
  "23503": "conflict", // foreign_key_violation
  "22P02": "unknown", // invalid_text_representation (bad uuid/date literal)
  "57014": "unknown", // query_canceled (statement timeout)
  // PostgREST
  PGRST116: "not_found", // .single() found 0 rows
  PGRST301: "no_permission", // JWT expired / invalid
  PGRST302: "no_permission", // anonymous where auth required
  PGRST202: "schema", // RPC not found in schema cache
  PGRST204: "schema", // column not found in schema cache
};

export class QueryError extends Error {
  readonly kind: QueryErrorKind;
  /** The raw Postgres/PostgREST code, e.g. '42501', 'PGRST116'. Null if none. */
  readonly code: string | null;
  /** The view, table or RPC we were reading — for the error_ref line. */
  readonly relation: string;
  readonly details: string | null;
  readonly hint: string | null;
  /** The underlying PostgrestError / ZodError / TypeError, for the console. */
  readonly cause?: unknown;

  constructor(
    relation: string,
    kind: QueryErrorKind,
    message: string,
    opts: {
      code?: string | null;
      details?: string | null;
      hint?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "QueryError";
    this.relation = relation;
    this.kind = kind;
    this.code = opts.code ?? null;
    this.details = opts.details ?? null;
    this.hint = opts.hint ?? null;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** The caller may not see this data — render the no-permission state. */
  get isNoPermission(): boolean {
    return this.kind === "no_permission";
  }

  /** The request never reached the server — render the offline state. */
  get isOffline(): boolean {
    return this.kind === "offline";
  }

  /** Our bug, not the user's: a missing view/column/RPC. Retry will not help. */
  get isOurBug(): boolean {
    return this.kind === "schema" || this.kind === "parse";
  }

  /** Retrying could plausibly succeed (network blips, timeouts). */
  get isRetryable(): boolean {
    return this.kind === "offline" || this.kind === "unknown";
  }

  /** Short stable ref for ErrorState, e.g. 'v_payslip_detail/42501'. */
  get errorRef(): string {
    return `${this.relation}/${this.code ?? this.kind}`;
  }
}

/** True when `e` is a QueryError of a given kind — for `useQuery` branches. */
export function isQueryErrorOfKind(e: unknown, kind: QueryErrorKind): boolean {
  return e instanceof QueryError && e.kind === kind;
}

/** A read failed because the caller may not see the data. */
export function isNoPermissionError(e: unknown): boolean {
  return e instanceof QueryError && (e.kind === "no_permission" || e.kind === "not_found");
}

/**
 * The retry predicate every feature `useQuery` passes as `retry`.
 *
 * Retrying a `no_permission`, `not_found`, `schema` or `parse` failure only
 * delays the honest state the user should already be seeing — and hammers the
 * database while it does. Offline and unknown failures get two attempts.
 */
export function shouldRetryQuery(failureCount: number, error: Error): boolean {
  if (error instanceof QueryError && !error.isRetryable) return false;
  return failureCount < 2;
}

function fromPostgrest(relation: string, error: PostgrestError): QueryError {
  const code = error.code ?? null;
  const kind: QueryErrorKind = (code !== null ? CODE_KIND[code] : undefined) ?? "unknown";
  return new QueryError(relation, kind, error.message, {
    code,
    details: error.details ?? null,
    hint: error.hint ?? null,
    cause: error,
  });
}

function fromThrown(relation: string, e: unknown): QueryError {
  if (e instanceof QueryError) return e;
  // fetch() rejects with TypeError when the network is unreachable.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const message = e instanceof Error ? e.message : String(e);
  return new QueryError(
    relation,
    offline || e instanceof TypeError ? "offline" : "unknown",
    message,
    { cause: e },
  );
}

function parseRows<S extends z.ZodTypeAny>(
  relation: string,
  schema: S,
  rows: unknown[],
): z.infer<S>[] {
  const out: z.infer<S>[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      throw new QueryError(
        relation,
        "parse",
        `Row from ${relation} does not match its schema: ${parsed.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
        { cause: parsed.error },
      );
    }
    out.push(parsed.data);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Filters — a tiny closed vocabulary, so a feature api cannot smuggle in SQL
// -----------------------------------------------------------------------------

export type FilterScalar = string | number | boolean;

export type Filter =
  | { readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; readonly column: string; readonly value: FilterScalar }
  | { readonly op: "like" | "ilike"; readonly column: string; readonly value: string }
  | { readonly op: "is"; readonly column: string; readonly value: null | boolean }
  | { readonly op: "not_is"; readonly column: string; readonly value: null | boolean }
  | { readonly op: "in"; readonly column: string; readonly values: readonly FilterScalar[] }
  | { readonly op: "contains"; readonly column: string; readonly values: readonly FilterScalar[] };

export const eq = (column: string, value: FilterScalar): Filter => ({ op: "eq", column, value });
export const neq = (column: string, value: FilterScalar): Filter => ({ op: "neq", column, value });
export const gt = (column: string, value: FilterScalar): Filter => ({ op: "gt", column, value });
export const gte = (column: string, value: FilterScalar): Filter => ({ op: "gte", column, value });
export const lt = (column: string, value: FilterScalar): Filter => ({ op: "lt", column, value });
export const lte = (column: string, value: FilterScalar): Filter => ({ op: "lte", column, value });
export const ilike = (column: string, value: string): Filter => ({ op: "ilike", column, value });
export const isNull = (column: string): Filter => ({ op: "is", column, value: null });
/** `column IS NOT NULL` — the Archive console's "only soft-deleted rows". */
export const isNotNull = (column: string): Filter => ({ op: "not_is", column, value: null });
export const isTrue = (column: string): Filter => ({ op: "is", column, value: true });
export const isFalse = (column: string): Filter => ({ op: "is", column, value: false });
export const inList = (column: string, values: readonly FilterScalar[]): Filter => ({ op: "in", column, values });

/** Inclusive date/text window on one column — `[from, to]`. */
export function between(column: string, from: FilterScalar, to: FilterScalar): readonly Filter[] {
  return [gte(column, from), lte(column, to)];
}

export interface OrderSpec {
  readonly column: string;
  /** Default true (ASC). */
  readonly ascending?: boolean;
  /** Default: nulls last on ASC, nulls first on DESC (Postgres default). */
  readonly nullsFirst?: boolean;
}

/**
 * The supabase filter builder, minimally typed. The client is created without a
 * generated `Database` type (see src/lib/supabase.ts), so column names are not
 * statically checked here — zod at the boundary is what actually guards shape.
 */
interface Builder {
  eq(column: string, value: unknown): Builder;
  neq(column: string, value: unknown): Builder;
  gt(column: string, value: unknown): Builder;
  gte(column: string, value: unknown): Builder;
  lt(column: string, value: unknown): Builder;
  lte(column: string, value: unknown): Builder;
  like(column: string, pattern: string): Builder;
  ilike(column: string, pattern: string): Builder;
  is(column: string, value: null | boolean): Builder;
  not(column: string, operator: string, value: unknown): Builder;
  in(column: string, values: readonly unknown[]): Builder;
  contains(column: string, value: unknown): Builder;
  or(filters: string): Builder;
  order(column: string, opts: { ascending: boolean; nullsFirst: boolean }): Builder;
  limit(count: number): Builder;
  abortSignal(signal: AbortSignal): Builder;
  then: PromiseLike<{ data: unknown; error: PostgrestError | null }>["then"];
}

function applyFilters(builder: Builder, filters: readonly Filter[] | undefined): Builder {
  let b = builder;
  for (const f of filters ?? []) {
    switch (f.op) {
      case "eq":
        b = b.eq(f.column, f.value);
        break;
      case "neq":
        b = b.neq(f.column, f.value);
        break;
      case "gt":
        b = b.gt(f.column, f.value);
        break;
      case "gte":
        b = b.gte(f.column, f.value);
        break;
      case "lt":
        b = b.lt(f.column, f.value);
        break;
      case "lte":
        b = b.lte(f.column, f.value);
        break;
      case "like":
        b = b.like(f.column, f.value);
        break;
      case "ilike":
        b = b.ilike(f.column, f.value);
        break;
      case "is":
        b = b.is(f.column, f.value);
        break;
      case "not_is":
        b = b.not(f.column, "is", f.value);
        break;
      case "in":
        b = b.in(f.column, f.values);
        break;
      case "contains":
        b = b.contains(f.column, f.values);
        break;
    }
  }
  return b;
}

function applyOrder(builder: Builder, order: readonly OrderSpec[] | undefined): Builder {
  let b = builder;
  for (const o of order ?? []) {
    const ascending = o.ascending ?? true;
    b = b.order(o.column, {
      ascending,
      nullsFirst: o.nullsFirst ?? !ascending,
    });
  }
  return b;
}

function startQuery(relation: string, columns: string): Builder {
  // `from()` is untyped without a generated Database type; the shape contract is
  // the zod schema, enforced in parseRows.
  return supabase.from(relation).select(columns) as unknown as Builder;
}

async function run(
  relation: string,
  builder: Builder,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  const b = signal ? builder.abortSignal(signal) : builder;
  let res: { data: unknown; error: PostgrestError | null };
  try {
    res = await b;
  } catch (e) {
    throw fromThrown(relation, e);
  }
  if (res.error) throw fromPostgrest(relation, res.error);
  if (res.data === null || res.data === undefined) return [];
  return Array.isArray(res.data) ? res.data : [res.data];
}

// -----------------------------------------------------------------------------
// selectOne / selectMany
// -----------------------------------------------------------------------------

export interface SelectOneOptions {
  /** Projection. Default '*' — narrow it when a view is wide. */
  readonly columns?: string;
  /** Deterministic pick when the filters could match more than one row. */
  readonly order?: readonly OrderSpec[];
  readonly signal?: AbortSignal;
}

/**
 * Read at most one row. Returns `null` when nothing matched — which for an
 * RLS-protected view means either "no such row" or "not yours"; those are
 * indistinguishable at the wire and the caller decides how to render it.
 */
export async function selectOne<S extends z.ZodTypeAny>(
  view: string,
  schema: S,
  filters: readonly Filter[],
  opts: SelectOneOptions = {},
): Promise<z.infer<S> | null> {
  let b = startQuery(view, opts.columns ?? "*");
  b = applyFilters(b, filters);
  b = applyOrder(b, opts.order);
  b = b.limit(1);
  const rows = await run(view, b, opts.signal);
  if (rows.length === 0) return null;
  const parsed = parseRows(view, schema, rows);
  return parsed[0] ?? null;
}

/**
 * Read one row that MUST exist. Absence is treated as an RLS denial and throws
 * `QueryError{ kind: "not_found" }` so the screen can render the
 * no-permission state instead of a misleading empty state.
 */
export async function selectOneOrThrow<S extends z.ZodTypeAny>(
  view: string,
  schema: S,
  filters: readonly Filter[],
  opts: SelectOneOptions = {},
): Promise<z.infer<S>> {
  const row = await selectOne(view, schema, filters, opts);
  if (row === null) {
    throw new QueryError(
      view,
      "not_found",
      `No visible row in ${view} for the given filters (row absent or withheld by RLS).`,
    );
  }
  return row;
}

export interface SelectManyOptions {
  readonly filters?: readonly Filter[];
  readonly order?: readonly OrderSpec[];
  /**
   * Hard cap on rows. ALWAYS set one on an unbounded relation — an employee's
   * leave ledger grows forever. Use `paginate` when the user can scroll.
   */
  readonly limit?: number;
  readonly columns?: string;
  readonly signal?: AbortSignal;
}

/** Read many rows, each zod-parsed. Empty result → `[]`, never null. */
export async function selectMany<S extends z.ZodTypeAny>(
  view: string,
  schema: S,
  opts: SelectManyOptions = {},
): Promise<z.infer<S>[]> {
  let b = startQuery(view, opts.columns ?? "*");
  b = applyFilters(b, opts.filters);
  b = applyOrder(b, opts.order);
  if (opts.limit !== undefined) b = b.limit(opts.limit);
  const rows = await run(view, b, opts.signal);
  return parseRows(view, schema, rows);
}

// -----------------------------------------------------------------------------
// COUNT — a dashboard tile's number is counted by Postgres, never by the client
// -----------------------------------------------------------------------------

/**
 * Same filter vocabulary as `selectMany`, but the number comes back from the
 * database and NO rows cross the wire (`HEAD` + `count=exact`).
 *
 * Why this exists: a Command Centre tile must be the cardinality of exactly the
 * row set its drill-through opens. Fetching 500 rows to read `.length` would
 * make the tile depend on the client's page size and on whatever `limit` the
 * caller happened to pass — that is how a tile and its own detail screen start
 * disagreeing (the `7 vs 8` defect, spec-screens DR-29). Passing the SAME
 * `filters` array to `selectCount` and to `selectMany` makes them agree by
 * construction.
 *
 * This is not client arithmetic: nothing is summed, averaged or re-derived here.
 */
export async function selectCount(
  view: string,
  filters: readonly Filter[] = [],
  opts: { readonly signal?: AbortSignal } = {},
): Promise<number> {
  const head = supabase.from(view).select("*", { count: "exact", head: true }) as unknown as Builder;
  let b = applyFilters(head, filters);
  if (opts.signal) b = b.abortSignal(opts.signal);
  let res: { count: number | null; error: PostgrestError | null };
  try {
    res = await (b as unknown as PromiseLike<{ count: number | null; error: PostgrestError | null }>);
  } catch (e) {
    throw fromThrown(view, e);
  }
  if (res.error) throw fromPostgrest(view, res.error);
  // A `count` of null on a successful HEAD means the relation is empty.
  return res.count ?? 0;
}

// -----------------------------------------------------------------------------
// Keyset pagination — never OFFSET
// -----------------------------------------------------------------------------

/**
 * Opaque-ish cursor: the sort key and the tiebreak key of the LAST row handed
 * to the caller. Serialisable, so it can live in a query key or the URL.
 */
export interface Cursor {
  readonly key: FilterScalar;
  readonly tiebreak: FilterScalar;
}

export interface Page<T> {
  readonly rows: T[];
  /** Pass to the next `paginate` call. Null when the last page was reached. */
  readonly nextCursor: Cursor | null;
  readonly hasMore: boolean;
}

export interface PaginateOptions {
  /** The sort column. Must be a column the caller also selects. */
  readonly orderBy: string;
  /** Default true (oldest first). Set false for "newest first" lists. */
  readonly ascending?: boolean;
  /**
   * Unique tiebreak column — REQUIRED. Keyset paging over a non-unique sort key
   * (`ist_date`, `effective_date`) drops rows without it. Use the primary key.
   */
  readonly tiebreak: string;
  readonly pageSize: number;
  readonly cursor?: Cursor | null;
  readonly filters?: readonly Filter[];
  readonly columns?: string;
  readonly signal?: AbortSignal;
}

/**
 * PostgREST `or=` takes a comma-separated list, so a raw comma, parenthesis or
 * quote in a cursor value would change the meaning of the predicate. Cursor
 * values are ids, dates and numbers; anything else is refused rather than
 * escaped-and-hoped.
 */
function assertCursorSafe(relation: string, value: FilterScalar): string {
  const s = String(value);
  if (/[(),."'\\]/.test(s)) {
    throw new QueryError(
      relation,
      "unknown",
      `Cursor value ${JSON.stringify(s)} contains a character that is unsafe in a PostgREST 'or' predicate. Paginate on an id or date column.`,
    );
  }
  return s;
}

/**
 * One keyset page. The predicate is
 *   `key <cmp> cursor.key OR (key = cursor.key AND tiebreak <cmp> cursor.tiebreak)`
 * which is stable while the attendance engine writes underneath us — the defect
 * OFFSET paging produces (a row seen twice, a row never seen) cannot occur.
 *
 * `pageSize + 1` rows are fetched to learn `hasMore` without a COUNT.
 */
export async function paginate<S extends z.ZodTypeAny>(
  view: string,
  schema: S,
  opts: PaginateOptions,
): Promise<Page<z.infer<S>>> {
  const ascending = opts.ascending ?? true;
  const cmp = ascending ? "gt" : "lt";

  let b = startQuery(view, opts.columns ?? "*");
  b = applyFilters(b, opts.filters);

  const cursor = opts.cursor ?? null;
  if (cursor !== null) {
    const key = assertCursorSafe(view, cursor.key);
    const tie = assertCursorSafe(view, cursor.tiebreak);
    b = b.or(
      `${opts.orderBy}.${cmp}.${key},and(${opts.orderBy}.eq.${key},${opts.tiebreak}.${cmp}.${tie})`,
    );
  }

  b = applyOrder(b, [
    { column: opts.orderBy, ascending },
    { column: opts.tiebreak, ascending },
  ]);
  b = b.limit(opts.pageSize + 1);

  const raw = await run(view, b, opts.signal);
  const hasMore = raw.length > opts.pageSize;
  const rows = parseRows(view, schema, hasMore ? raw.slice(0, opts.pageSize) : raw);

  let nextCursor: Cursor | null = null;
  if (hasMore && rows.length > 0) {
    // The cursor is read off the RAW last row: the sort/tiebreak columns are
    // wire values, and the schema may have renamed or transformed them.
    const last = raw[opts.pageSize - 1];
    if (last !== null && typeof last === "object") {
      const rec = last as Record<string, unknown>;
      const key = rec[opts.orderBy];
      const tie = rec[opts.tiebreak];
      if (isFilterScalar(key) && isFilterScalar(tie)) nextCursor = { key, tiebreak: tie };
    }
    if (nextCursor === null) {
      throw new QueryError(
        view,
        "parse",
        `Cannot build a keyset cursor: select '${opts.orderBy}' and '${opts.tiebreak}' in the projection.`,
      );
    }
  }

  return { rows, nextCursor, hasMore };
}

function isFilterScalar(v: unknown): v is FilterScalar {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

// -----------------------------------------------------------------------------
// RPC — for the set-returning functions behind parameterised views
// -----------------------------------------------------------------------------

/**
 * Call a set-returning Postgres function and parse each row.
 *
 * Needed because some "views" in 034–037 are zero-argument wrappers over a
 * parameterised function (`v_attendance_period_summary` wraps
 * `f_attendance_period_summary(from, to, employee_id)` pinned to month-to-date).
 * Any period other than MTD must go through the function.
 */
export async function rpcMany<S extends z.ZodTypeAny>(
  fn: string,
  args: Record<string, unknown>,
  schema: S,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<z.infer<S>[]> {
  let res: { data: unknown; error: PostgrestError | null };
  try {
    const builder = supabase.rpc(fn, args) as unknown as Builder;
    const b = opts.signal ? builder.abortSignal(opts.signal) : builder;
    res = await b;
  } catch (e) {
    throw fromThrown(fn, e);
  }
  if (res.error) throw fromPostgrest(fn, res.error);
  const rows = res.data === null || res.data === undefined
    ? []
    : Array.isArray(res.data)
      ? res.data
      : [res.data];
  return parseRows(fn, schema, rows);
}

/** Call a set-returning function expecting at most one row. */
export async function rpcOne<S extends z.ZodTypeAny>(
  fn: string,
  args: Record<string, unknown>,
  schema: S,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<z.infer<S> | null> {
  const rows = await rpcMany(fn, args, schema, opts);
  return rows[0] ?? null;
}

// =============================================================================
// AUDITED WRITES — the ONLY sanctioned path from a feature api to a table
// =============================================================================
//
// Why this exists, verified against the live project (xfoeudhwxlbkkwetncjb) and
// not assumed:
//
//   * `app.pgrst_pre_request()` (migration 005) copies the request header
//     `x-reason` into the transaction-scoped GUC `app.reason`.
//   * `audit.log_changes()` (migration 006 §2) reads that GUC and RAISEs
//     SQLSTATE 22023 when a table listed in `audit.reason_required_tables`
//     is written without a reason of at least `min_length` (seeded 10)
//     characters. 17 tables are listed, among them employees,
//     attendance_days, user_roles, settings, leave_types, documents,
//     payroll_runs, employee_salary_revisions, holidays, pay_periods.
//   * Several RLS policies demand it independently — `esr__admin__insert`
//     has `AND app.has_reason()` in its WITH CHECK, so a missing reason there
//     is a 42501, not a 22023.
//
// Header attachment: postgrest-js 2.110.8 exposes `.setHeader(name, value)` on
// the builder, scoped to that ONE request. Confirmed on the live API as the
// admin persona: no header → 22023; a 9-character reason → 22023; a real
// sentence → 200 with the row. A fresh client per write was considered and
// rejected — it would not carry the session, and a module-level "current
// reason" variable would race between two concurrent saves. Per-request header,
// per-call argument, no shared state.
//
// A reason shorter than the minimum NEVER reaches the network: the server's
// 22023 must not be the first thing an admin hears about their own typing.
// -----------------------------------------------------------------------------

/** Floor enforced by `audit.reason_required_tables.min_length` (seeded 10). */
export const MIN_REASON_LENGTH = 10;

/**
 * spec-admin D-21: overrides, backdates, unlocks, reveals, PII exports, hard
 * deletes and manual payroll edits want a fuller sentence. Pass it as
 * `minReasonLength` on those calls — the database floor stays 10, this is the
 * product asking for more.
 */
export const SENSITIVE_REASON_LENGTH = 15;

/**
 * Why a write failed, at the granularity a form actually branches on. Distinct
 * from `QueryErrorKind` because a write has failure modes a read does not: a
 * reason was missing, a unique key collided, a CHECK/guard refused the row.
 */
export type MutationErrorKind =
  | "reason_required"
  | "duplicate"
  | "check_violation"
  | "permission_denied"
  | "fk_violation"
  | "locked"
  | "not_found"
  | "invalid_request"
  | "offline"
  | "schema"
  | "parse"
  | "unknown";

/** SQLSTATE / PostgREST code → the write-side kind. */
const MUTATION_CODE_KIND: Readonly<Record<string, MutationErrorKind>> = {
  "22023": "reason_required", // invalid_parameter_value ← audit.log_changes()
  "23505": "duplicate", // unique_violation
  "23514": "check_violation", // check_violation / RAISE from a guard
  "23P01": "check_violation", // exclusion_violation (overlapping period rows)
  "23503": "fk_violation", // foreign_key_violation
  "42501": "permission_denied", // insufficient_privilege / RLS WITH CHECK refused
  "0A000": "locked", // feature_not_supported ← "system-managed row" / locked-period guards
  P0002: "not_found", // no_data_found from a definer function
  "42P01": "schema",
  "42703": "schema",
  "42883": "schema",
  "22P02": "invalid_request", // bad uuid/date literal in the payload
  PGRST116: "not_found",
  PGRST204: "schema",
  PGRST202: "schema",
  PGRST301: "permission_denied",
  PGRST302: "permission_denied",
};

/** How each write-side kind renders into the read-side state machine. */
const MUTATION_KIND_TO_QUERY_KIND: Readonly<Record<MutationErrorKind, QueryErrorKind>> = {
  reason_required: "conflict",
  duplicate: "conflict",
  check_violation: "conflict",
  permission_denied: "no_permission",
  fk_violation: "conflict",
  locked: "conflict",
  not_found: "not_found",
  invalid_request: "conflict",
  offline: "offline",
  schema: "schema",
  parse: "parse",
  unknown: "unknown",
};

/** i18n key carrying the plain-English sentence for each kind. */
const MUTATION_MESSAGE_KEY: Readonly<Record<MutationErrorKind, MessageKey>> = {
  reason_required: "write.error.reasonRequired",
  duplicate: "write.error.duplicate",
  check_violation: "write.error.checkViolation",
  permission_denied: "write.error.permissionDenied",
  fk_violation: "write.error.fkViolation",
  locked: "write.error.locked",
  not_found: "write.error.notFound",
  invalid_request: "write.error.invalidRequest",
  offline: "write.error.offline",
  schema: "write.error.schema",
  parse: "write.error.parse",
  unknown: "write.error.unknown",
};

/**
 * A failed write. Extends `QueryError` so `StateBoundary` / `ErrorState` keep
 * working unchanged, and adds `mutationKind` + `userMessage` for forms.
 *
 * `userMessage` is the sentence to render. It is plain English from the string
 * catalogue — never a SQLSTATE, never a raw constraint name. For the two kinds
 * where the database speaks in whole sentences on purpose (a guard's RAISE
 * message on 23514, a locked-period refusal on 0A000) the server's own wording
 * is appended, because those strings were written for a person to read.
 */
export class MutationError extends QueryError {
  readonly mutationKind: MutationErrorKind;
  /** The table the write targeted. */
  readonly table: string;
  /** Minimum reason length in force — set on `reason_required`. */
  readonly minReasonLength: number | null;

  constructor(
    table: string,
    mutationKind: MutationErrorKind,
    message: string,
    opts: {
      code?: string | null;
      details?: string | null;
      hint?: string | null;
      cause?: unknown;
      minReasonLength?: number | null;
    } = {},
  ) {
    super(table, MUTATION_KIND_TO_QUERY_KIND[mutationKind], message, {
      code: opts.code ?? null,
      details: opts.details ?? null,
      hint: opts.hint ?? null,
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = "MutationError";
    this.table = table;
    this.mutationKind = mutationKind;
    this.minReasonLength = opts.minReasonLength ?? null;
  }

  /** The sentence to put in front of the user. Never a code, never SQL. */
  get userMessage(): string {
    if (this.mutationKind === "reason_required") {
      return t("write.error.reasonRequired", { min: this.minReasonLength ?? MIN_REASON_LENGTH });
    }
    const base = t(MUTATION_MESSAGE_KEY[this.mutationKind]);
    if (this.mutationKind === "check_violation" || this.mutationKind === "locked") {
      const server = serverSentence(this.message);
      if (server !== null) return `${base} ${server}`;
    }
    return base;
  }

  /** The user can fix this by editing the form; retrying as-is cannot help. */
  get isUserFixable(): boolean {
    return (
      this.mutationKind === "reason_required" ||
      this.mutationKind === "duplicate" ||
      this.mutationKind === "check_violation" ||
      this.mutationKind === "fk_violation" ||
      this.mutationKind === "invalid_request"
    );
  }
}

/**
 * A Postgres message is worth showing only when it reads like a sentence a
 * person wrote. Internal shapes ('reason_required: UPDATE on public.x needs…',
 * 'duplicate key value violates unique constraint "uq_…"') are suppressed.
 */
function serverSentence(message: string): string | null {
  const m = message.trim();
  if (m === "") return null;
  if (/violates|constraint|relation|column|permission denied|syntax/i.test(m)) return null;
  if (/^[a-z_]+:/.test(m) && !/\s/.test(m.slice(0, m.indexOf(":")))) {
    // 'code_like_prefix: rest' — keep the human half only.
    const rest = m.slice(m.indexOf(":") + 1).trim();
    return rest === "" ? null : ensureStop(rest);
  }
  return ensureStop(m);
}

function ensureStop(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Narrowing helper for a mutation `onError` handler. */
export function isMutationError(e: unknown): e is MutationError {
  return e instanceof MutationError;
}

/** True when `e` is a write that failed for a specific write-side reason. */
export function isMutationErrorOfKind(e: unknown, kind: MutationErrorKind): boolean {
  return e instanceof MutationError && e.mutationKind === kind;
}

/**
 * The plain-English sentence for ANY thrown value, so a form's error slot is
 * never empty and never shows a SQLSTATE.
 */
/**
 * Postgres's own constraint prose, which is NOT written for a person.
 *
 * A 23514 can come from two places that look identical to the client: a trigger
 * that did `RAISE EXCEPTION 'Sick Leave must be taken on its own…'`, and a bare
 * CHECK constraint, which Postgres reports as `new row for relation
 * "leave_requests" violates check constraint "ck_lr__reason"`. The first is an
 * answer; the second is a constraint name an employee cannot act on.
 */
const PG_CONSTRAINT_PROSE = [
  /^new row for relation /i,
  /^duplicate key value /i,
  /^insert or update on table /i,
  /^update or delete on table /i,
  /^null value in column /i,
  /violates (check|foreign key|unique|exclusion|not-null) constraint/i,
];

/**
 * True when the database refused the write AND said something worth showing.
 *
 * The distinction `isRuleRejection` does not make: it answers "was this a
 * business rule", which is the right question for deciding whether to retry, but
 * not for deciding whether to render `e.message`. This answers the second.
 *
 * The codes are the ones this schema's own guards raise — 23514 from a trigger's
 * RAISE, 0A000 from the append-only and system-managed guards, P0002 from a
 * definer function that found nothing. Unique and foreign-key violations are
 * excluded by code, and a bare CHECK is excluded by the shape of its message.
 */
export function ruleRejectionMessage(e: unknown): string | null {
  if (!(e instanceof QueryError)) return null;
  const code = e.code ?? "";
  if (code !== "23514" && code !== "0A000" && code !== "P0002") return null;
  const message = e.message.trim();
  if (message === "") return null;
  if (PG_CONSTRAINT_PROSE.some((pattern) => pattern.test(message))) return null;
  return message;
}

export function mutationUserMessage(e: unknown): string {
  if (e instanceof MutationError) return e.userMessage;
  if (e instanceof QueryError) {
    if (e.isOffline) return t("write.error.offline");
    if (e.isNoPermission) return t("write.error.permissionDenied");
    /*
      THE DATABASE'S OWN SENTENCE, WHICH WAS BEING THROWN AWAY.

      The same defect the note below describes for edge functions, left standing
      for the database path: a trigger raises "Sick Leave must be taken on its
      own and cannot be combined with another leave type", and the employee was
      shown "The change could not be saved. Try again, and report it if it keeps
      failing." — which is wrong twice, because retrying cannot fix a rule and
      the one sentence that would have told them what to do was discarded.

      `isRuleRejection` in write.ts has documented since it was written that
      these messages "are safe to render". Nothing called it.
    */
    /*
      Humanised, then shown. `ruleRejectionMessage` decides whether the server
      said something showable; `humaniseRefusal` turns the ones that name a column
      into the same fact in words an employee can act on. Anything it does not
      recognise passes through unchanged — a new rule shows its own sentence
      rather than a vague apology.
    */
    const rule = ruleRejectionMessage(e);
    if (rule !== null) return humaniseRefusal(rule);
    /*
      The SQLSTATE, when there is one. Whoever is asked to "report it" can only
      report what they were shown, and three very different faults share this one
      sentence.
    */
    const code = e.code;
    if (typeof code === "string" && code.trim() !== "") {
      return t("write.error.unknownWithCode", { code });
    }
    return t("write.error.unknown");
  }
  /*
    AN EDGE-FUNCTION REFUSAL, WHOSE OWN SENTENCE WAS BEING THROWN AWAY.

    Every write that goes through `invokeEdgeFn` throws `TTApiError`, and this function
    knew only about `MutationError` and `QueryError` — so it fell through to
    "The change could not be saved. Try again, and report it if it keeps failing."

    That sentence is wrong twice over. It tells somebody to RETRY when the server has
    usually refused for a reason retrying cannot fix, and it discards the one thing that
    would have told them what to do. A face enrolment refused for missing biometric
    consent, or because a pending enrolment already exists, said nothing at all — and the
    administrator's only option was to press the button again.

    `problem.detail` is written by the side that refused and is more specific than anything
    this function could compose, so it is shown as-is. `problem.title` is the fallback for a
    problem with no detail; the generic sentence is the last resort rather than the first.
  */
  if (e instanceof TTApiError) {
    const detail = e.problem.detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail;
    const title = e.problem.title;
    if (typeof title === "string" && title.trim() !== "") return ensureStop(title);
    return t("write.error.unknown");
  }
  return t("write.error.unknown");
}

/**
 * Validate a reason BEFORE the request leaves the browser and return it
 * trimmed. `min` defaults to the database floor; pass
 * `SENSITIVE_REASON_LENGTH` on D-21 actions.
 *
 * This is deliberately not a soft warning: a write that will certainly be
 * refused should never consume a round trip, and "invalid_parameter_value" is
 * not something an HR admin should ever have to interpret.
 */
export function assertReason(
  reason: string | null | undefined,
  opts: { readonly table?: string; readonly minLength?: number } = {},
): string {
  const min = opts.minLength ?? MIN_REASON_LENGTH;
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < min) {
    throw new MutationError(
      opts.table ?? "(client)",
      "reason_required",
      `A reason of at least ${min} characters is required for this change; got ${trimmed.length}.`,
      { minReasonLength: min },
    );
  }
  return trimmed;
}

/** True when `reason` would pass `assertReason` — for enabling a Save button. */
export function isReasonValid(reason: string | null | undefined, minLength?: number): boolean {
  return (reason ?? "").trim().length >= (minLength ?? MIN_REASON_LENGTH);
}

function fromPostgrestMutation(table: string, error: PostgrestError): MutationError {
  const code = error.code ?? null;
  const kind: MutationErrorKind = (code !== null ? MUTATION_CODE_KIND[code] : undefined) ?? "unknown";
  return new MutationError(table, kind, error.message, {
    code,
    details: error.details ?? null,
    hint: error.hint ?? null,
    cause: error,
    ...(kind === "reason_required" ? { minReasonLength: MIN_REASON_LENGTH } : {}),
  });
}

function fromThrownMutation(table: string, e: unknown): MutationError {
  if (e instanceof MutationError) return e;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const message = e instanceof Error ? e.message : String(e);
  return new MutationError(table, offline || e instanceof TypeError ? "offline" : "unknown", message, {
    cause: e,
  });
}

/**
 * The supabase mutation builder, minimally typed — same approach as `Builder`
 * above. `setHeader` is postgrest-js's per-request header escape hatch and is
 * what makes one reason belong to exactly one write.
 */
interface MutationBuilder {
  insert(values: Record<string, unknown> | Record<string, unknown>[]): MutationBuilder;
  update(values: Record<string, unknown>): MutationBuilder;
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): MutationBuilder;
  select(columns: string): MutationBuilder;
  setHeader(name: string, value: string): MutationBuilder;
  abortSignal(signal: AbortSignal): MutationBuilder;
  then: PromiseLike<{ data: unknown; error: PostgrestError | null }>["then"];
}

export interface AuditedWriteOptions {
  /** The free-text sentence recorded against the admin's name. Mandatory. */
  readonly reason: string;
  /** Raise the client-side floor above the database's 10 (D-21 actions). */
  readonly minReasonLength?: number;
  /** Projection read back. Default '*'. */
  readonly columns?: string;
  readonly signal?: AbortSignal;
  /**
   * Correlation id landing in `audit_log.request_id`. Generated per call when
   * omitted; pass a stable one to tie several writes into one admin action.
   */
  readonly requestId?: string;
}

/** Attach the audit context headers to exactly this request. */
function withAuditHeaders(
  builder: MutationBuilder,
  reason: string,
  requestId: string | undefined,
): MutationBuilder {
  // 'x-reason' → app.reason (pre-request hook, migration 005).
  let b = builder.setHeader("x-reason", reason);
  // 'x-request-id' → app.request_id → audit_log.request_id. Must be a UUID:
  // the hook casts it, and a non-uuid would abort the whole transaction.
  const id = requestId ?? safeUuid();
  if (id !== null) b = b.setHeader("x-request-id", id);
  return b;
}

function safeUuid(): string | null {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : null;
}

async function runMutation(
  table: string,
  builder: MutationBuilder,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  const b = signal ? builder.abortSignal(signal) : builder;
  let res: { data: unknown; error: PostgrestError | null };
  try {
    res = await b;
  } catch (e) {
    throw fromThrownMutation(table, e);
  }
  if (res.error) throw fromPostgrestMutation(table, res.error);
  if (res.data === null || res.data === undefined) return [];
  return Array.isArray(res.data) ? res.data : [res.data];
}

/**
 * Parse the row PostgREST echoed back.
 *
 * ZERO rows on an accepted write is the silent-failure trap migration 051 was
 * written about: without an admin SELECT policy, `UPDATE … WHERE id = $1`
 * matches nothing and PostgREST answers 204, so the console reports success and
 * nothing changed. It is surfaced here as `not_found`, never as success.
 */
function parseWrittenRow<S extends z.ZodTypeAny>(
  table: string,
  schema: S,
  rows: unknown[],
): z.infer<S> {
  const row = rows[0];
  if (row === undefined) {
    throw new MutationError(
      table,
      "not_found",
      `${table} accepted the statement but returned no row — the row is absent, or RLS withheld it, so nothing was written.`,
    );
  }
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new MutationError(
      table,
      "parse",
      `Row written to ${table} does not match its schema: ${parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function mutation(table: string): MutationBuilder {
  return supabase.from(table) as unknown as MutationBuilder;
}

/** Reuse the read-side filter application; both builders expose the same ops. */
function applyMutationFilters(
  builder: MutationBuilder,
  filters: readonly Filter[],
): MutationBuilder {
  return applyFilters(builder as unknown as Builder, filters) as unknown as MutationBuilder;
}

/**
 * INSERT one row with an audit reason and return it, zod-parsed.
 *
 * The reason is required even where the audit trigger would not demand it on
 * INSERT (`applies_to = 'update_delete'` for most tables): some RLS policies
 * do — `employee_salary_revisions` refuses an insert without
 * `app.has_reason()` — and an admin console that records why a row was created
 * is worth more than one saved keystroke.
 */
export async function insertRow<S extends z.ZodTypeAny>(
  table: string,
  values: Readonly<Record<string, unknown>>,
  schema: S,
  opts: AuditedWriteOptions,
): Promise<z.infer<S>> {
  const reason = assertReason(opts.reason, {
    table,
    ...(opts.minReasonLength !== undefined ? { minLength: opts.minReasonLength } : {}),
  });
  if (Object.keys(values).length === 0) {
    throw new MutationError(table, "invalid_request", `insertRow(${table}) was called with no columns.`);
  }
  let b = mutation(table).insert({ ...values });
  b = withAuditHeaders(b, reason, opts.requestId);
  b = b.select(opts.columns ?? "*");
  const rows = await runMutation(table, b, opts.signal);
  return parseWrittenRow(table, schema, rows);
}

/**
 * UPDATE the rows matching `filters` with an audit reason, returning the first
 * updated row, zod-parsed.
 *
 * `filters` may not be empty. An unfiltered PATCH is a whole-table update and
 * there is no admin screen that wants one; refusing it here is cheaper than
 * discovering it in `audit_log`.
 */
export async function updateRow<S extends z.ZodTypeAny>(
  table: string,
  filters: readonly Filter[],
  patch: Readonly<Record<string, unknown>>,
  schema: S,
  opts: AuditedWriteOptions,
): Promise<z.infer<S>> {
  const reason = assertReason(opts.reason, {
    table,
    ...(opts.minReasonLength !== undefined ? { minLength: opts.minReasonLength } : {}),
  });
  if (filters.length === 0) {
    throw new MutationError(
      table,
      "invalid_request",
      `updateRow(${table}) was called with no filters — that would rewrite every row.`,
    );
  }
  if (Object.keys(patch).length === 0) {
    throw new MutationError(table, "invalid_request", `updateRow(${table}) was called with no changed fields.`);
  }
  let b = mutation(table).update({ ...patch });
  b = applyMutationFilters(b, filters);
  b = withAuditHeaders(b, reason, opts.requestId);
  // No `.limit()`: PostgREST refuses a limit on an unordered mutation
  // (PGRST109). `filters` is what bounds the statement.
  b = b.select(opts.columns ?? "*");
  const rows = await runMutation(table, b, opts.signal);
  return parseWrittenRow(table, schema, rows);
}

export interface UpsertOptions extends AuditedWriteOptions {
  /**
   * Comma-separated conflict target, e.g. `'key'` or `'employee_id,leave_year'`.
   * Name it explicitly — relying on PostgREST's default (the primary key) is
   * how an "update" silently becomes an insert.
   */
  readonly onConflict: string;
}

/** INSERT … ON CONFLICT DO UPDATE with an audit reason. */
export async function upsertRow<S extends z.ZodTypeAny>(
  table: string,
  values: Readonly<Record<string, unknown>>,
  schema: S,
  opts: UpsertOptions,
): Promise<z.infer<S>> {
  const reason = assertReason(opts.reason, {
    table,
    ...(opts.minReasonLength !== undefined ? { minLength: opts.minReasonLength } : {}),
  });
  if (Object.keys(values).length === 0) {
    throw new MutationError(table, "invalid_request", `upsertRow(${table}) was called with no columns.`);
  }
  let b = mutation(table).upsert({ ...values }, { onConflict: opts.onConflict });
  b = withAuditHeaders(b, reason, opts.requestId);
  b = b.select(opts.columns ?? "*");
  const rows = await runMutation(table, b, opts.signal);
  return parseWrittenRow(table, schema, rows);
}

export interface SoftDeleteOptions {
  readonly reason: string;
  readonly minReasonLength?: number;
  readonly signal?: AbortSignal;
  readonly requestId?: string;
  /** Primary-key column. Default 'id'. */
  readonly idColumn?: string;
}

/**
 * Soft delete (D-23): stamp `deleted_at` / `deleted_by` / `deletion_reason` so
 * the row stays queryable in the Archive console. Never a DELETE — nothing in
 * the admin console hard-deletes; that is a super-admin ceremony behind an edge
 * function.
 *
 * `deleted_by` is set explicitly: `util.touch_row` stamps `updated_by` but no
 * trigger fills `deleted_by`, and an archive row with no actor is not an audit
 * trail. The audit trigger separately classifies this UPDATE as
 * `action = 'soft_delete'` because `deleted_at` went from NULL to a value.
 */
export async function softDelete(
  table: string,
  id: string,
  opts: SoftDeleteOptions,
): Promise<void> {
  const reason = assertReason(opts.reason, {
    table,
    ...(opts.minReasonLength !== undefined ? { minLength: opts.minReasonLength } : {}),
  });
  const { data: sessionData } = await supabase.auth.getSession();
  const actorId = sessionData.session?.user.id ?? null;
  if (actorId === null) {
    throw new MutationError(
      table,
      "permission_denied",
      "No signed-in session — a soft delete must record who did it.",
    );
  }
  const idColumn = opts.idColumn ?? "id";
  let b = mutation(table).update({
    deleted_at: nowInstantIso(),
    deleted_by: actorId,
    deletion_reason: reason,
  });
  b = applyMutationFilters(b, [eq(idColumn, id), isNull("deleted_at")]);
  b = withAuditHeaders(b, reason, opts.requestId);
  b = b.select(idColumn);
  const rows = await runMutation(table, b, opts.signal);
  if (rows.length === 0) {
    throw new MutationError(
      table,
      "not_found",
      `Nothing was archived in ${table}: the row is already archived, does not exist, or is not yours to change.`,
    );
  }
}

/**
 * Restore a soft-deleted row. The audit trigger records this as
 * `action = 'restore'` for the same NULL-transition reason.
 */
export async function restoreRow(
  table: string,
  id: string,
  opts: SoftDeleteOptions,
): Promise<void> {
  const reason = assertReason(opts.reason, {
    table,
    ...(opts.minReasonLength !== undefined ? { minLength: opts.minReasonLength } : {}),
  });
  const idColumn = opts.idColumn ?? "id";
  let b = mutation(table).update({ deleted_at: null, deleted_by: null, deletion_reason: reason });
  b = applyMutationFilters(b, [eq(idColumn, id)]);
  b = withAuditHeaders(b, reason, opts.requestId);
  b = b.select(idColumn);
  const rows = await runMutation(table, b, opts.signal);
  if (rows.length === 0) {
    throw new MutationError(
      table,
      "not_found",
      `Nothing was restored in ${table}: the row does not exist, or is not yours to change.`,
    );
  }
}

/**
 * Call a definer function that performs an audited write, with the reason
 * header attached. Some server-side paths (`recompute_attendance_range`) read
 * `app.reason` themselves rather than taking it as an argument.
 */
export async function rpcAudited<S extends z.ZodTypeAny>(
  fn: string,
  args: Record<string, unknown>,
  schema: S,
  opts: AuditedWriteOptions,
): Promise<z.infer<S>[]> {
  const reason = assertReason(opts.reason, {
    table: fn,
    ...(opts.minReasonLength !== undefined ? { minLength: opts.minReasonLength } : {}),
  });
  let b = supabase.rpc(fn, args) as unknown as MutationBuilder;
  b = withAuditHeaders(b, reason, opts.requestId);
  const rows = await runMutation(fn, b, opts.signal);
  const out: z.infer<S>[] = [];
  for (const row of rows) out.push(parseWrittenRow(fn, schema, [row]));
  return out;
}

// -----------------------------------------------------------------------------
// Shared zod primitives for DB wire values
// -----------------------------------------------------------------------------

/**
 * Postgres `numeric` may arrive as a JSON number or, depending on PostgREST
 * settings, as a string. Accept both and land on a number. This is a decode,
 * not a computation — no business arithmetic happens in the data layer.
 */
export const dbNumeric = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number),
]);

export const dbNumericNullable = dbNumeric.nullable();

/** Postgres `integer` / `bigint`. Paise amounts arrive here. */
export const dbInt = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/).transform(Number),
]);

export const dbIntNullable = dbInt.nullable();

/** A Postgres `date` — 'YYYY-MM-DD', NO timezone. Format with fmtCivilDate. */
export const dbDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");

export const dbDateNullable = dbDate.nullable();

/** A Postgres `timestamptz` — an instant. Format with fmtDateTime (IST suffix). */
export const dbTimestamp = z.string().min(1);

export const dbTimestampNullable = dbTimestamp.nullable();

export const dbUuid = z.string().uuid();

export const dbUuidNullable = dbUuid.nullable();

/**
 * A percentage the SERVER already multiplied by 100 and clamped. We assert the
 * range rather than clamping, because a value outside [0,100] means the view is
 * wrong and we want to see it, not paper over it (the 1,700.00% defect).
 */
export const dbPercent = dbNumeric.refine((n) => n >= 0 && n <= 100, {
  message: "percentage outside [0,100] — the view must clamp, the client must not",
});

export const dbPercentNullable = z.union([dbPercent, z.null()]);
