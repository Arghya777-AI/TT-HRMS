/**
 * useReportBuilder.ts — query state + reads for `/admin/analytics/builder`.
 *
 * THE URL IS THE SAVED QUERY. There is no `saved_reports` table in the database
 * (checked: nothing in `supabase/migrations/**` creates one), so a "saved view"
 * here is a link — dataset, columns, filters, sort and row cap, all URL-encoded,
 * exactly as §16.4 requires of every grid in the console. That is a real, shareable,
 * bookmarkable artefact; a row in a table this build would have had to invent is
 * not. The screen says so in as many words.
 *
 * Nothing runs until `run=1` is in the URL. A builder that fires a 500-row query on
 * every keystroke is a builder nobody can use over a venue's 4G, and a shared link
 * that arrives already-run is the useful half of the same switch.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  DEFAULT_REPORT_LIMIT,
  countReport,
  runReport,
  type ReportFilterInput,
  type ReportQuery,
  type ReportRow,
} from "../api/report-builder.api";
import {
  DEFAULT_DATASET,
  findColumn,
  findDataset,
  opsForKind,
  type FilterOp,
  type StarterReport,
} from "../report-datasets";

const PARAM_DATASET = "ds";
const PARAM_COLUMNS = "cols";
const PARAM_FILTER = "f";
const PARAM_SORT = "sort";
const PARAM_LIMIT = "limit";
const PARAM_RUN = "run";

/** `column:op:value` — the value keeps any colons of its own (split limit 3). */
function parseFilterParam(raw: string): { column: string; op: string; value: string } | null {
  const first = raw.indexOf(":");
  if (first < 0) return null;
  const second = raw.indexOf(":", first + 1);
  const column = raw.slice(0, first);
  const op = second < 0 ? raw.slice(first + 1) : raw.slice(first + 1, second);
  const value = second < 0 ? "" : raw.slice(second + 1);
  if (column === "" || op === "") return null;
  return { column, op, value };
}

function serialiseFilter(filter: ReportFilterInput): string {
  return `${filter.column}:${filter.op}:${filter.value}`;
}

export interface ReportState {
  readonly query: ReportQuery;
  /** True when the URL asks for the query to be executed. */
  readonly shouldRun: boolean;
}

/**
 * Read the whole builder state out of the URL, dropping anything the catalogue
 * does not recognise. A hand-edited link therefore degrades to a valid query
 * instead of a 400 from PostgREST.
 */
export function parseReportState(params: URLSearchParams): ReportState {
  const dataset = findDataset(params.get(PARAM_DATASET)) ?? DEFAULT_DATASET;
  const requested = (params.get(PARAM_COLUMNS) ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "" && findColumn(dataset, column) !== null);
  const columns = requested.length > 0 ? requested : [...dataset.defaultColumns];

  const filters: ReportFilterInput[] = [];
  for (const raw of params.getAll(PARAM_FILTER)) {
    const parsed = parseFilterParam(raw);
    if (parsed === null) continue;
    const column = findColumn(dataset, parsed.column);
    if (column === null) continue;
    const allowed = opsForKind(column.kind);
    if (!allowed.includes(parsed.op as FilterOp)) continue;
    filters.push({ column: parsed.column, op: parsed.op as FilterOp, value: parsed.value });
  }

  const rawSort = params.get(PARAM_SORT);
  const sortParts = rawSort === null ? null : rawSort.split(":");
  const sortColumn = sortParts?.[0] ?? null;
  const sort =
    sortColumn !== null && findColumn(dataset, sortColumn) !== null
      ? { column: sortColumn, ascending: sortParts?.[1] !== "desc" }
      : { column: dataset.defaultSort.column, ascending: dataset.defaultSort.ascending };

  const rawLimit = Number(params.get(PARAM_LIMIT) ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_REPORT_LIMIT;

  return {
    query: { datasetId: dataset.id, columns, filters, sort, limit },
    shouldRun: params.get(PARAM_RUN) === "1",
  };
}

/** The inverse: a query → the search string that reproduces it exactly. */
export function reportStateToParams(query: ReportQuery, run: boolean): URLSearchParams {
  const params = new URLSearchParams();
  params.set(PARAM_DATASET, query.datasetId);
  params.set(PARAM_COLUMNS, query.columns.join(","));
  for (const filter of query.filters) params.append(PARAM_FILTER, serialiseFilter(filter));
  if (query.sort !== null) {
    params.set(PARAM_SORT, `${query.sort.column}:${query.sort.ascending ? "asc" : "desc"}`);
  }
  params.set(PARAM_LIMIT, String(query.limit));
  if (run) params.set(PARAM_RUN, "1");
  return params;
}

/** A starter report → the same query shape the form edits. */
export function starterToQuery(starter: StarterReport): ReportQuery {
  return {
    datasetId: starter.datasetId,
    columns: [...starter.columns],
    filters: starter.filters.map((filter) => ({ ...filter })),
    sort: { ...starter.sort },
    limit: starter.limit,
  };
}

/** Stable cache key: the query's own serialisation, so equal queries share a row. */
function queryKeyFor(part: string, query: ReportQuery): readonly unknown[] {
  return qk.admin.list({
    area: "report-builder",
    part,
    q: reportStateToParams(query, false).toString(),
  });
}

export function useReportRows(
  query: ReportQuery,
  enabled: boolean,
): UseQueryResult<ReportRow[], Error> {
  return useQuery({
    queryKey: queryKeyFor("rows", query),
    queryFn: ({ signal }) => runReport(query, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

/** Postgres counts the matches; the grid never counts its own page (DR-29). */
export function useReportCount(query: ReportQuery, enabled: boolean): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: queryKeyFor("count", query),
    queryFn: ({ signal }) => countReport(query, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}
