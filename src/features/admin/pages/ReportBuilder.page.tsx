/**
 * §14 · /admin/analytics/builder — Report Builder. Ad-hoc questions against the
 * governed analytics views, with the query itself as the saved artefact.
 *
 * The route manifest calls this P2 ("ad-hoc reporting arrives in a later phase").
 * What arrives later is a report SERVER — scheduling, delivery, a `saved_reports`
 * table, a server-side render. None of that is needed for the useful half, which
 * is deployed today: eight `security_barrier` views that already compute every
 * figure this product publishes. So this screen is a real builder over them.
 *
 * FOUR RULES, each of which is why this can be shown to a client:
 *
 *  1. NO SQL CROSSES THE WIRE. Dataset, columns, filters and sort are validated
 *     against `report-datasets.ts` — an allow-list read out of the migrations — and
 *     compiled into the shared query layer's closed filter vocabulary. A column the
 *     catalogue does not name cannot be selected, filtered or sorted.
 *  2. RLS IS STILL THE BOUNDARY. Every dataset is a view whose predicate is
 *     `app.is_admin()` or `app.can_see_employee()`. The builder cannot widen scope
 *     because it never names a base table; a scoped admin sees their own slice.
 *  3. NO AGGREGATION IN THE BROWSER. Rows are listed, never summed, averaged or
 *     ratio'd. Totals belong to the views (`total_cost_paise`, `attrition_pct`,
 *     `late_pct`) which own their definitions in the Metric Dictionary; a figure
 *     invented here would have no owner. Money stays integer paise, rendered by
 *     `<Money>`. The row COUNT comes from Postgres, so "100 of 1,347" is true.
 *  4. NO EXPORT BUTTON. An export is a PII egress event and only a server function
 *     may perform one, because only it can write the `export_log` row beside the
 *     file (§14, and see /admin/analytics/exports). A browser-built CSV would be an
 *     unaudited egress dressed as a convenience.
 *
 * THE SAVED QUERY IS THE URL. There is no `saved_reports` relation in the database,
 * so this screen does not pretend to persist anything: dataset, columns, filters,
 * sort and row cap are URL-encoded, exactly as §16.4 requires of every grid, and a
 * bookmark or a pasted link reproduces the report — including running it. Seven
 * starter reports ship as such links.
 *
 * @route /admin/analytics/builder
 */
import { useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BarChart3, Filter as FilterIcon, Play, RotateCcw, ScrollText, Table2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime, fmtDurationHm } from "@/lib/datetime";
import { dash, formatDays, formatNumber, formatPercent } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import {
  DATASETS,
  DEFAULT_DATASET,
  STARTER_REPORTS,
  findColumn,
  findDataset,
  opNeedsValue,
  opsForKind,
  type ColumnKind,
  type Dataset,
  type DatasetColumn,
  type FilterOp,
} from "../report-datasets";
import {
  REPORT_LIMITS,
  ReportQueryError,
  compileReport,
  type ReportFilterInput,
  type ReportQuery,
  type ReportRow,
} from "../api/report-builder.api";
import {
  parseReportState,
  reportStateToParams,
  starterToQuery,
  useReportCount,
  useReportRows,
} from "../hooks/useReportBuilder";

/** At most four filters — beyond that the answer belongs on a curated screen. */
const MAX_FILTERS = 4;

const OP_LABEL: Readonly<Record<FilterOp, MessageKey>> = {
  eq: "admin.rbuild.op.eq",
  neq: "admin.rbuild.op.neq",
  gt: "admin.rbuild.op.gt",
  gte: "admin.rbuild.op.gte",
  lt: "admin.rbuild.op.lt",
  lte: "admin.rbuild.op.lte",
  contains: "admin.rbuild.op.contains",
  isNull: "admin.rbuild.op.isNull",
  notNull: "admin.rbuild.op.notNull",
};

const KIND_HINT: Readonly<Partial<Record<ColumnKind, MessageKey>>> = {
  paise: "admin.rbuild.hint.paise",
  minutes: "admin.rbuild.hint.minutes",
  pct: "admin.rbuild.hint.pct",
  date: "admin.rbuild.hint.date",
  timestamp: "admin.rbuild.hint.timestamp",
};

/** Postgres `numeric` arrives as a string; read it without inventing a value. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** One cell, formatted by its catalogue kind. A mismatch renders '—', never JSON. */
function ReportCell({ column, value }: { column: DatasetColumn; value: unknown }): ReactNode {
  switch (column.kind) {
    case "paise":
      return <Money paise={numberOf(value)} />;
    case "pct":
      return <span className="num">{formatPercent(numberOf(value), { digits: 1 })}</span>;
    case "minutes":
      return <span className="num">{dash(numberOf(value), (v) => fmtDurationHm(v))}</span>;
    case "int":
      return <span className="num">{formatNumber(numberOf(value))}</span>;
    case "decimal":
      return <span className="num">{formatDays(numberOf(value))}</span>;
    case "date":
      return <span className="num">{fmtCivilDate(textOf(value))}</span>;
    case "timestamp": {
      const raw = textOf(value);
      return <span className="num">{raw === null ? dash(null) : fmtDateTime(raw)}</span>;
    }
    case "bool":
      return typeof value === "boolean" ? (
        <Badge variant={value ? "success" : "neutral"}>
          {value ? t("admin.rbuild.yes") : t("admin.rbuild.no")}
        </Badge>
      ) : (
        <span>{dash(null)}</span>
      );
    case "enum": {
      const raw = textOf(value);
      return raw === null ? <span>{dash(null)}</span> : <StatusChip status={raw} />;
    }
    case "code":
      return <code className="num text-xs">{dash(textOf(value))}</code>;
    case "uuid": {
      const raw = textOf(value);
      return (
        <code className="num text-xs text-muted-foreground" title={raw ?? undefined}>
          {raw === null ? dash(null) : `${raw.slice(0, 8)}…`}
        </code>
      );
    }
    case "text":
      return <span>{dash(textOf(value))}</span>;
  }
}

function datasetOptions(): SelectOption[] {
  return DATASETS.map((dataset) => ({ value: dataset.id, label: t(dataset.titleKey) }));
}

function columnOptions(dataset: Dataset, onlyFilterable: boolean): SelectOption[] {
  return dataset.columns
    .filter((column) => !onlyFilterable || column.filterable === true)
    .map((column) => ({ value: column.column, label: t(column.labelKey) }));
}

function opOptions(kind: ColumnKind): SelectOption[] {
  return opsForKind(kind).map((op) => ({ value: op, label: t(OP_LABEL[op]) }));
}

export default function ReportBuilderPage() {
  const [params, setParams] = useSearchParams();
  const state = parseReportState(params);
  const query = state.query;
  const dataset = findDataset(query.datasetId) ?? DEFAULT_DATASET;

  /**
   * The compile step decides BOTH whether the Run button is live and what the
   * request would be, so the screen can never offer a query the api layer refuses.
   */
  const compiled = useMemo<{ ok: true } | { ok: false; message: string }>(() => {
    try {
      compileReport(query);
      return { ok: true };
    } catch (error) {
      if (error instanceof ReportQueryError) return { ok: false, message: error.message };
      throw error;
    }
  }, [query]);

  const runnable = compiled.ok;
  const enabled = state.shouldRun && runnable;
  const rows = useReportRows(query, enabled);
  const total = useReportCount(query, enabled);

  function apply(next: ReportQuery, run: boolean): void {
    setParams(reportStateToParams(next, run), { replace: true });
  }

  function changeDataset(datasetId: string): void {
    const target = findDataset(datasetId) ?? DEFAULT_DATASET;
    // Columns, filters and sort all belong to the previous relation; carrying any
    // of them over would produce a query about columns that no longer exist.
    apply(
      {
        datasetId: target.id,
        columns: [...target.defaultColumns],
        filters: [],
        sort: { ...target.defaultSort },
        limit: query.limit,
      },
      false,
    );
  }

  function toggleColumn(column: string): void {
    const has = query.columns.includes(column);
    const columns = has
      ? query.columns.filter((entry) => entry !== column)
      : // Keep the catalogue's order, so a report's columns read the same whichever
        // order the boxes were ticked in.
        dataset.columns
          .filter((entry) => entry.column === column || query.columns.includes(entry.column))
          .map((entry) => entry.column);
    apply({ ...query, columns }, false);
  }

  function setFilter(index: number, patch: Partial<ReportFilterInput>): void {
    const filters = query.filters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter));
    apply({ ...query, filters }, false);
  }

  function addFilter(): void {
    const first = dataset.columns.find((column) => column.filterable === true);
    if (first === undefined) return;
    const ops = opsForKind(first.kind);
    const op: FilterOp = ops[0] ?? "eq";
    apply(
      { ...query, filters: [...query.filters, { column: first.column, op, value: "" }] },
      false,
    );
  }

  function removeFilter(index: number): void {
    apply({ ...query, filters: query.filters.filter((_, i) => i !== index) }, false);
  }

  const gridColumns: DataGridColumn<ReportRow>[] = useMemo(
    () =>
      query.columns
        .map((name) => findColumn(dataset, name))
        .filter((column): column is DatasetColumn => column !== null)
        .map((column) => ({
          key: column.column,
          header: t(column.labelKey),
          align:
            column.kind === "paise" ||
            column.kind === "int" ||
            column.kind === "decimal" ||
            column.kind === "pct" ||
            column.kind === "minutes"
              ? ("right" as const)
              : ("left" as const),
          sortable: true,
          sortValue: (row: ReportRow) => {
            const raw = row[column.column];
            const asNumber = numberOf(raw);
            return asNumber ?? textOf(raw) ?? "";
          },
          render: (row: ReportRow) => <ReportCell column={column} value={row[column.column]} />,
        })),
    [dataset, query.columns],
  );

  /** The matview stamp, when the report asked for it. */
  const asOf = useMemo(() => {
    const stampColumn = dataset.refreshedAtColumn;
    if (stampColumn === undefined || !query.columns.includes(stampColumn)) return null;
    const first = rows.data?.[0];
    const raw = first === undefined ? null : textOf(first[stampColumn]);
    return raw === null ? null : fmtDateTime(raw);
  }, [dataset.refreshedAtColumn, query.columns, rows.data]);

  const shownRows = rows.data?.length ?? 0;
  const matched = total.data ?? null;
  const truncated = matched !== null && matched > shownRows;

  const shareSearch = `?${reportStateToParams(query, true).toString()}`;

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("admin.rbuild.title")}
        subtitle={t("admin.rbuild.subtitle", { n: formatNumber(DATASETS.length) })}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/analytics/metrics">
              <ScrollText className="mr-2 size-4" aria-hidden />
              {t("admin.rbuild.toDictionary")}
            </Link>
          </Button>
        }
      />

      <div className="space-y-2">
        <Notice tone="info">{t("admin.rbuild.intro")}</Notice>
        <Notice tone="warning">{t("admin.rbuild.limits")}</Notice>
      </div>

      {/* ── Starter reports — the seeded saved views ────────────────────────── */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.rbuild.starters.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.rbuild.starters.hint")}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STARTER_REPORTS.map((starter) => (
            <button
              key={starter.id}
              type="button"
              onClick={() => apply(starterToQuery(starter), true)}
              className="rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block text-sm font-medium">{t(starter.titleKey)}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t(starter.hintKey)}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── The query ──────────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t("admin.rbuild.query.heading")}</h2>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <SelectField
            label={t("admin.rbuild.field.dataset")}
            value={dataset.id}
            options={datasetOptions()}
            onChange={changeDataset}
          />
          <SelectField
            label={t("admin.rbuild.field.sort")}
            value={query.sort?.column ?? dataset.defaultSort.column}
            options={columnOptions(dataset, false)}
            onChange={(value) =>
              apply(
                { ...query, sort: { column: value, ascending: query.sort?.ascending ?? true } },
                false,
              )
            }
          />
          <SelectField
            label={t("admin.rbuild.field.direction")}
            value={query.sort?.ascending === false ? "desc" : "asc"}
            options={[
              { value: "asc", label: t("admin.rbuild.direction.asc") },
              { value: "desc", label: t("admin.rbuild.direction.desc") },
            ]}
            onChange={(value) =>
              apply(
                {
                  ...query,
                  sort: {
                    column: query.sort?.column ?? dataset.defaultSort.column,
                    ascending: value !== "desc",
                  },
                },
                false,
              )
            }
          />
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          {t("admin.rbuild.query.datasetNote", { view: dataset.view })}{" "}
          <Link
            to={dataset.ownerRoute}
            className="text-primary underline-offset-4 hover:underline"
          >
            {t("admin.rbuild.query.ownerScreen")}
          </Link>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{t(dataset.hintKey)}</p>

        {/* Columns */}
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              <Table2 className="mr-1.5 inline size-4 align-[-2px]" aria-hidden />
              {t("admin.rbuild.columns.heading", {
                chosen: formatNumber(query.columns.length),
                total: formatNumber(dataset.columns.length),
              })}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => apply({ ...query, columns: [...dataset.defaultColumns] }, false)}
            >
              <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
              {t("admin.rbuild.columns.reset")}
            </Button>
          </div>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {dataset.columns.map((column) => (
              <li key={column.column}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={query.columns.includes(column.column)}
                    onChange={() => toggleColumn(column.column)}
                    className="mt-0.5 h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <span className="min-w-0">
                    <span className="block leading-tight">{t(column.labelKey)}</span>
                    <code className="block text-xs text-muted-foreground">{column.column}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {/* Filters */}
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              <FilterIcon className="mr-1.5 inline size-4 align-[-2px]" aria-hidden />
              {t("admin.rbuild.filters.heading")}
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={addFilter}
              disabled={query.filters.length >= MAX_FILTERS}
              title={
                query.filters.length >= MAX_FILTERS
                  ? t("admin.rbuild.filters.max", { max: MAX_FILTERS })
                  : undefined
              }
            >
              {t("admin.rbuild.filters.add")}
            </Button>
          </div>

          {query.filters.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t("admin.rbuild.filters.none")}</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {query.filters.map((filter, index) => {
                const column = findColumn(dataset, filter.column);
                const kind: ColumnKind = column?.kind ?? "text";
                const needsValue = opNeedsValue(filter.op);
                const hintKey = KIND_HINT[kind];
                return (
                  <li
                    key={`${filter.column}-${index}`}
                    className="grid gap-3 rounded-md border bg-background p-3 lg:grid-cols-[1fr_1fr_1fr_auto]"
                  >
                    <SelectField
                      label={t("admin.rbuild.filters.column")}
                      value={filter.column}
                      options={columnOptions(dataset, true)}
                      onChange={(value) => {
                        const next = findColumn(dataset, value);
                        const ops = next === null ? opsForKind("text") : opsForKind(next.kind);
                        const op: FilterOp = ops.includes(filter.op) ? filter.op : (ops[0] ?? "eq");
                        setFilter(index, { column: value, op, value: "" });
                      }}
                    />
                    <SelectField
                      label={t("admin.rbuild.filters.operator")}
                      value={filter.op}
                      options={opOptions(kind)}
                      onChange={(value) => setFilter(index, { op: value as FilterOp })}
                    />
                    {needsValue ? (
                      kind === "bool" ? (
                        <SelectField
                          label={t("admin.rbuild.filters.value")}
                          value={filter.value === "" ? "true" : filter.value}
                          options={[
                            { value: "true", label: t("admin.rbuild.yes") },
                            { value: "false", label: t("admin.rbuild.no") },
                          ]}
                          onChange={(value) => setFilter(index, { value })}
                        />
                      ) : (
                        <TextField
                          label={t("admin.rbuild.filters.value")}
                          value={filter.value}
                          type={
                            kind === "date"
                              ? "date"
                              : kind === "int" ||
                                  kind === "decimal" ||
                                  kind === "paise" ||
                                  kind === "pct" ||
                                  kind === "minutes"
                                ? "number"
                                : "text"
                          }
                          onChange={(value) => setFilter(index, { value })}
                          {...(hintKey !== undefined ? { hint: t(hintKey) } : {})}
                        />
                      )
                    ) : (
                      <p className="self-end text-xs text-muted-foreground">
                        {t("admin.rbuild.filters.noValueNeeded")}
                      </p>
                    )}
                    <div className="flex items-end">
                      <Button variant="ghost" size="sm" onClick={() => removeFilter(index)}>
                        {t("admin.rbuild.filters.remove")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Row cap + run */}
        <div className="mt-5 grid gap-3 lg:grid-cols-[16rem_auto]">
          <SelectField
            label={t("admin.rbuild.field.limit")}
            value={String(query.limit)}
            options={REPORT_LIMITS.map((limit) => ({
              value: String(limit),
              label: t("admin.rbuild.limit.rows", { n: formatNumber(limit) }),
            }))}
            hint={t("admin.rbuild.field.limitHint")}
            onChange={(value) => apply({ ...query, limit: Number(value) }, false)}
          />
          <div className="flex items-end gap-3">
            <Button
              onClick={() => apply(query, true)}
              disabled={!runnable || rows.isFetching}
              {...(compiled.ok ? {} : { title: compiled.message })}
            >
              <Play className="mr-2 size-4" aria-hidden />
              {rows.isFetching ? t("admin.rbuild.running") : t("admin.rbuild.run")}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                apply(
                  {
                    datasetId: dataset.id,
                    columns: [...dataset.defaultColumns],
                    filters: [],
                    sort: { ...dataset.defaultSort },
                    limit: query.limit,
                  },
                  false,
                )
              }
            >
              {t("admin.rbuild.reset")}
            </Button>
          </div>
        </div>

        {!compiled.ok ? (
          <Notice tone="error" className="mt-4">
            {compiled.message}
          </Notice>
        ) : null}
      </section>

      {/* ── Results ────────────────────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">{t("admin.rbuild.results.heading")}</h2>
          {enabled && matched !== null ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("admin.rbuild.results.count", {
                shown: formatNumber(shownRows),
                total: formatNumber(matched),
              })}
            </p>
          ) : null}
        </div>

        {asOf !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.rbuild.results.asOf", { when: asOf })}
          </p>
        ) : null}

        <div className="mt-3">
          <StateBoundary
            loading={enabled && rows.isLoading}
            error={rows.error ?? undefined}
            onRetry={() => void rows.refetch()}
            partialError={total.error ?? undefined}
            partialLabel={t("admin.rbuild.results.countLabel")}
            isEmpty={!enabled}
            empty={
              <EmptyState
                icon={BarChart3}
                title={t("admin.rbuild.results.notRun.title")}
                hint={t("admin.rbuild.results.notRun.hint")}
                action={
                  <Button onClick={() => apply(query, true)} disabled={!runnable}>
                    <Play className="mr-2 size-4" aria-hidden />
                    {t("admin.rbuild.run")}
                  </Button>
                }
              />
            }
            skeletonRows={5}
          >
            {truncated ? (
              <Notice tone="warning" className="mb-3">
                {t("admin.rbuild.results.truncated", {
                  shown: formatNumber(shownRows),
                  total: formatNumber(matched ?? 0),
                })}
              </Notice>
            ) : null}
            <DataGrid
              columns={gridColumns}
              rows={rows.data ?? []}
              rowKey={(row) =>
                query.columns.map((column) => textOf(row[column]) ?? "").join("|")
              }
              pageSize={25}
              emptyState={
                <EmptyState
                  icon={FilterIcon}
                  title={t("admin.rbuild.results.empty.title")}
                  hint={t("admin.rbuild.results.empty.hint")}
                />
              }
            />
          </StateBoundary>
        </div>
      </section>

      {/* ── The saved query ────────────────────────────────────────────────── */}
      <section className="mt-8 rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t("admin.rbuild.saved.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.rbuild.saved.hint")}</p>
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="report-link">{t("admin.rbuild.saved.label")}</Label>
          <Input id="report-link" readOnly value={shareSearch} className="num text-xs" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("admin.rbuild.saved.gap")}</p>
      </section>

      <div className="mt-6 space-y-2">
        <Notice tone="info">{t("admin.rbuild.note.rls")}</Notice>
        <Notice tone="info">{t("admin.rbuild.note.export")}</Notice>
      </div>
    </div>
  );
}
