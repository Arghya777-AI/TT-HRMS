import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/shared/ui/EmptyState";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";

export type GridBreakpoint = "sm" | "md" | "lg";

export interface DataGridColumn<T> {
  /** Stable column id; also the default field accessor on the row object. */
  key: string;
  /** Human label — never a raw DB column name (D-10/11). */
  header: string;
  render?: (row: T) => ReactNode;
  align?: "left" | "center" | "right";
  /** CSS width (e.g. '120px', '12rem'). */
  width?: string;
  /**
   * Hide the column below this breakpoint. Columns WITHOUT hideBelow are the
   * high-priority set that the <768px card list renders.
   */
  hideBelow?: GridBreakpoint;
  /** Opt-in client-side sorting for this column. */
  sortable?: boolean;
  /** Custom sort accessor; defaults to the raw field value. */
  sortValue?: (row: T) => string | number | null | undefined;
}

export interface DataGridProps<T> {
  columns: DataGridColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Contextual empty state (DR-07). Defaults to a generic one. */
  emptyState?: ReactNode;
  /** Default 25 (D-24). Month grids pass 31. */
  pageSize?: number;
  onRowClick?: (row: T) => void;
  /** Rendered in the header block above the table (search, filters, export…). */
  toolbar?: ReactNode;
  /**
   * Detail for ONE row, rendered immediately beneath it rather than after the
   * grid. Return null for every row you do not want expanded.
   *
   * REPORTED on the approval inbox: "when i click then it's details should just
   * that below not after list, because if there will more row then we have to
   * scroll down too much". Exactly right — a panel under a 25-row page puts the
   * thing you just clicked a screen and a half above the answer, and the reader
   * loses their place on the way back.
   *
   * Optional and additive: a grid that does not pass it renders precisely as
   * before, which is why this did not need touching in the other screens.
   */
  renderRowDetail?: (row: T) => ReactNode;
}

const PAGE_SIZES = [10, 25, 50, 100, 200] as const;

const HIDE_CLASS: Record<GridBreakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

type SortState = { key: string; dir: "asc" | "desc" } | null;

function defaultSortValue<T>(row: T, key: string): string | number {
  const raw = (row as Record<string, unknown>)[key];
  if (typeof raw === "number") return raw;
  if (raw == null) return "";
  return String(raw);
}

function defaultCell<T>(row: T, key: string): string {
  const raw = (row as Record<string, unknown>)[key];
  if (raw == null) return dash(null);
  if (typeof raw === "string" || typeof raw === "number") return dash(raw);
  return dash(String(raw));
}

/**
 * DataGrid — THE one grid component (D-24). Lightweight, client-side paging and
 * optional per-column sorting; below 768px it renders a card list built from
 * the high-priority (no `hideBelow`) columns. Server-side pagination arrives
 * with the features; this component intentionally stays presentational.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyState,
  pageSize: initialPageSize = 25,
  onRowClick,
  renderRowDetail,
  toolbar,
}: DataGridProps<T>) {
  const [sort, setSort] = useState<SortState>(null);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const accessor = col.sortValue ?? ((row: T) => defaultSortValue(row, col.key));
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = accessor(a) ?? "";
      const vb = accessor(b) ?? "";
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * factor;
      return String(va).localeCompare(String(vb), "en-IN", { numeric: true }) * factor;
    });
  }, [rows, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const pageRows = useMemo(
    () => sorted.slice(page * pageSize, page * pageSize + pageSize),
    [sorted, page, pageSize],
  );

  const cardColumns = columns.filter((c) => !c.hideBelow);
  const titleColumn = cardColumns[0] ?? columns[0];

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
    setPage(0);
  }

  function cellContent(row: T, col: DataGridColumn<T>): ReactNode {
    return col.render ? col.render(row) : defaultCell(row, col.key);
  }

  const empty = !loading && rows.length === 0;
  const from = sorted.length === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(sorted.length, (page + 1) * pageSize);

  return (
    <div className="rounded-lg border bg-card">
      {toolbar ? <div className="flex flex-wrap items-center gap-2 border-b p-3">{toolbar}</div> : null}

      {/* ≥768px: table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    col.hideBelow && HIDE_CLASS[col.hideBelow],
                    col.align === "right" && "text-right",
                    col.align === "center" && "text-center",
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        col.align === "right" && "flex-row-reverse",
                      )}
                      aria-label={`Sort by ${col.header}`}
                    >
                      {col.header}
                      {sort?.key === col.key ? (
                        sort.dir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {columns.map((col) => (
                      <TableCell key={col.key} className={col.hideBelow ? HIDE_CLASS[col.hideBelow] : undefined}>
                        <Skeleton className="h-4 w-full max-w-32" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : pageRows.flatMap((row) => {
                  const detail = renderRowDetail?.(row) ?? null;
                  const rows = [
                    <TableRow
                      key={rowKey(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(
                        onRowClick && "cursor-pointer",
                        // The expanded row and its detail read as one block.
                        detail !== null && "bg-muted/40",
                      )}
                    >
                      {columns.map((col) => (
                        <TableCell
                          key={col.key}
                          className={cn(
                            col.hideBelow && HIDE_CLASS[col.hideBelow],
                            col.align === "right" && "num text-right",
                            col.align === "center" && "text-center",
                          )}
                        >
                          {cellContent(row, col)}
                        </TableCell>
                      ))}
                    </TableRow>,
                  ];
                  if (detail !== null) {
                    rows.push(
                      // `hover:bg-transparent` so the detail does not light up as
                      // if it were another clickable row.
                      <TableRow key={`${rowKey(row)}--detail`} className="hover:bg-transparent">
                        <TableCell colSpan={columns.length} className="p-0">
                          {detail}
                        </TableCell>
                      </TableRow>,
                    );
                  }
                  return rows;
                })}
            {empty ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-6">
                  {emptyState ?? <EmptyState title={t("common.noRows.title")} />}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      {/* <768px: card list from high-priority columns */}
      <div className="md:hidden">
        {loading ? (
          <div className="space-y-3 p-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : empty ? (
          <div className="p-4">{emptyState ?? <EmptyState title={t("common.noRows.title")} />}</div>
        ) : (
          <ul className="divide-y">
            {pageRows.map((row) => (
              <li key={rowKey(row)}>
                <div
                  role={onRowClick ? "button" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  className={cn("p-4", onRowClick && "cursor-pointer transition-colors hover:bg-muted/50")}
                >
                  {/*
                    A `div`, NOT a `p`. A column's `render` may return anything —
                    a StatusChip, a PersonCell, a PunchLocation — and every one of
                    those is a block element. `<p>` may only contain phrasing
                    content, so React logged `validateDOMNesting: <div> cannot
                    appear as a descendant of <p>` on the analytics screen, and the
                    browser SILENTLY CLOSES the paragraph before the offending
                    child: the title and the rest of the card end up as siblings,
                    which is a real layout bug on narrow screens and not only a
                    console warning.
                  */}
                  {titleColumn ? (
                    <div className="font-medium">{cellContent(row, titleColumn)}</div>
                  ) : null}
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {cardColumns
                      .filter((c) => c.key !== titleColumn?.key)
                      .map((col) => (
                        <div key={col.key} className="min-w-0">
                          <dt className="text-xs text-muted-foreground">{col.header}</dt>
                          <dd className="num truncate text-sm">{cellContent(row, col)}</dd>
                        </div>
                      ))}
                  </dl>
                </div>
                {renderRowDetail?.(row) ?? null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pagination footer */}
      {!empty && !loading ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2 text-sm text-muted-foreground">
          <label className="flex items-center gap-2">
            <span>{t("common.rowsPerPage")}</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className="h-8 rounded-md border bg-background px-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {[...new Set([initialPageSize, ...PAGE_SIZES])]
                .sort((a, b) => a - b)
                .map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <span className="num">
              {from}–{to} {t("common.of")} {sorted.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
