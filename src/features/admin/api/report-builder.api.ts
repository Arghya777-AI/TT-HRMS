/**
 * report-builder.api.ts — the runtime half of `/admin/analytics/builder`.
 *
 * One read path, `runReport`, over the DATASETS catalogue in
 * `../report-datasets`. Three properties make an ad-hoc query builder safe enough
 * to put in front of a client:
 *
 *  1. NO FREE-FORM SQL, EVER. The screen composes a dataset id, a column list, a
 *     filter list and a sort — all of which are validated against the catalogue
 *     here, in the api layer, before a request is built. An unknown column is a
 *     refusal (`QueryError`-shaped, via `ReportQueryError`), not a request that
 *     PostgREST gets to interpret.
 *  2. THE SERVER STILL DECIDES WHO SEES WHAT. Every dataset is a `security_barrier`
 *     view whose predicate is `app.is_admin()` or `app.can_see_employee()`. The
 *     builder cannot widen scope, because it never names a base table.
 *  3. NO CLIENT ARITHMETIC. Rows are rendered, never aggregated: a total, an
 *     average or a percentage on this screen would be a metric with no server
 *     owner (see the Metric Dictionary). `countRows` asks Postgres for the
 *     cardinality of exactly the same filter set the grid shows.
 *
 * Row shape is `Record<string, unknown>` on purpose — the column list is chosen at
 * runtime, so there is no fixed schema to assert. Each cell is formatted by its
 * catalogue `kind`, and a cell whose value does not match its kind renders '—'
 * rather than `String(value)`.
 */
import { z } from "zod";
import {
  eq,
  gt,
  gte,
  ilike,
  isFalse,
  isNull,
  isNotNull,
  isTrue,
  lt,
  lte,
  neq,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import {
  findColumn,
  findDataset,
  opNeedsValue,
  opsForKind,
  type ColumnKind,
  type Dataset,
  type FilterOp,
} from "../report-datasets";

/** One report row: keys are the selected columns, values are whatever the view held. */
export type ReportRow = Record<string, unknown>;

/** No fixed shape to assert — the column list is a runtime choice (see header). */
const reportRowSchema = z.record(z.unknown());

/** Row ceilings. A builder that could ask for everything is a denial of service. */
export const REPORT_LIMITS = [50, 100, 250, 500, 1000] as const;
export type ReportLimit = (typeof REPORT_LIMITS)[number];
export const DEFAULT_REPORT_LIMIT: ReportLimit = 100;

export interface ReportFilterInput {
  readonly column: string;
  readonly op: FilterOp;
  /** Raw text from the form; converted by the column's kind, never guessed. */
  readonly value: string;
}

export interface ReportQuery {
  readonly datasetId: string;
  readonly columns: readonly string[];
  readonly filters: readonly ReportFilterInput[];
  readonly sort: { readonly column: string; readonly ascending: boolean } | null;
  readonly limit: number;
}

/** A query the catalogue refuses — never sent to the server. */
export class ReportQueryError extends Error {
  readonly kind: "unknown_dataset" | "unknown_column" | "bad_operator" | "bad_value" | "no_columns";

  constructor(
    kind: "unknown_dataset" | "unknown_column" | "bad_operator" | "bad_value" | "no_columns",
    message: string,
  ) {
    super(message);
    this.name = "ReportQueryError";
    this.kind = kind;
  }
}

/**
 * Text → the scalar the column's kind demands.
 *
 * A number column never receives a string: PostgREST would compare
 * `'12abc'::text` and answer 400 halfway through the demo. `NaN` is refused here
 * with a sentence the form can show under the box.
 */
function scalarFor(kind: ColumnKind, raw: string, column: string): string | number | boolean {
  const value = raw.trim();
  switch (kind) {
    case "int":
    case "decimal":
    case "paise":
    case "pct":
    case "minutes": {
      const parsed = Number(value);
      if (value === "" || !Number.isFinite(parsed)) {
        throw new ReportQueryError("bad_value", `${column} needs a number; got ${JSON.stringify(raw)}.`);
      }
      return parsed;
    }
    case "bool":
      if (value !== "true" && value !== "false") {
        throw new ReportQueryError("bad_value", `${column} needs true or false.`);
      }
      return value === "true";
    default:
      if (value === "") {
        throw new ReportQueryError("bad_value", `${column} needs a value.`);
      }
      return value;
  }
  // Unreachable: the switch above is exhaustive over the column kinds, but the
  // compiler cannot prove it because the default arm returns rather than throws.
  throw new ReportQueryError("bad_value", `${column} could not be coerced.`);
}

/** Catalogue filter → the shared query layer's closed filter vocabulary. */
function toFilter(dataset: Dataset, input: ReportFilterInput): Filter {
  const column = findColumn(dataset, input.column);
  if (column === null) {
    throw new ReportQueryError(
      "unknown_column",
      `${input.column} is not a column of ${dataset.view}.`,
    );
  }
  if (!opsForKind(column.kind).includes(input.op)) {
    throw new ReportQueryError(
      "bad_operator",
      `${input.op} cannot be applied to ${input.column}.`,
    );
  }
  if (!opNeedsValue(input.op)) {
    return input.op === "isNull" ? isNull(column.column) : isNotNull(column.column);
  }
  // `contains` is the only text-shaped operator, and the wildcards are added
  // HERE rather than typed by the user: a bare `%` in the box would otherwise
  // become a full-table scan by accident.
  if (input.op === "contains") {
    const value = input.value.trim();
    if (value === "") {
      throw new ReportQueryError("bad_value", `${input.column} needs some text to look for.`);
    }
    return ilike(column.column, `%${value}%`);
  }
  const scalar = scalarFor(column.kind, input.value, input.column);
  if (column.kind === "bool" && input.op === "eq") {
    return scalar === true ? isTrue(column.column) : isFalse(column.column);
  }
  switch (input.op) {
    case "eq":
      return eq(column.column, scalar);
    case "neq":
      return neq(column.column, scalar);
    case "gt":
      return gt(column.column, scalar);
    case "gte":
      return gte(column.column, scalar);
    case "lt":
      return lt(column.column, scalar);
    case "lte":
      return lte(column.column, scalar);
  }
  // Unreachable for the same reason as toValue(): the op switch is exhaustive but
  // the compiler cannot see it.
  throw new ReportQueryError("bad_value", `${input.op} is not supported here.`);
}

export interface CompiledReport {
  readonly dataset: Dataset;
  /** Comma-joined select list — every name checked against the catalogue. */
  readonly columns: string;
  readonly filters: readonly Filter[];
  readonly order: readonly { column: string; ascending: boolean }[];
  readonly limit: number;
}

/**
 * Validate a query against the catalogue and compile it. Exported so the screen
 * can show "why this cannot run" WITHOUT firing a request — the same function
 * decides both, so the two answers cannot disagree.
 */
export function compileReport(query: ReportQuery): CompiledReport {
  const dataset = findDataset(query.datasetId);
  if (dataset === null) {
    throw new ReportQueryError("unknown_dataset", `${query.datasetId} is not a known dataset.`);
  }
  const chosen = query.columns.filter((column) => findColumn(dataset, column) !== null);
  if (chosen.length === 0) {
    throw new ReportQueryError("no_columns", "Pick at least one column to report on.");
  }
  const filters = query.filters
    .filter((f) => !opNeedsValue(f.op) || f.value.trim() !== "")
    .map((f) => toFilter(dataset, f));

  const sortColumn = query.sort === null ? null : findColumn(dataset, query.sort.column);
  const order =
    query.sort !== null && sortColumn !== null
      ? [{ column: sortColumn.column, ascending: query.sort.ascending }]
      : [{ column: dataset.defaultSort.column, ascending: dataset.defaultSort.ascending }];

  const limit = REPORT_LIMITS.includes(query.limit as ReportLimit)
    ? query.limit
    : DEFAULT_REPORT_LIMIT;

  return { dataset, columns: chosen.join(","), filters, order, limit };
}

/** Run a compiled report. Rows come back exactly as the view holds them. */
export function runReport(query: ReportQuery, signal?: AbortSignal): Promise<ReportRow[]> {
  const compiled = compileReport(query);
  return selectMany(compiled.dataset.view, reportRowSchema, {
    columns: compiled.columns,
    filters: compiled.filters,
    order: compiled.order,
    limit: compiled.limit,
    ...(signal ? { signal } : {}),
  });
}

/**
 * How many rows the filter set matches, counted by Postgres. The grid shows at
 * most `limit` of them, and the difference is stated on screen — a truncated
 * report that looks complete is the worst thing an ad-hoc tool can produce.
 */
export function countReport(query: ReportQuery, signal?: AbortSignal): Promise<number> {
  const compiled = compileReport(query);
  return selectCount(compiled.dataset.view, compiled.filters, { ...(signal ? { signal } : {}) });
}
