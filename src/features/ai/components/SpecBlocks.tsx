/**
 * SpecBlocks — draws one `InfographicSpec` block.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO
 *
 * It does not compute. Not a sum, not a percentage, not a currency format. Every figure
 * on screen is the server's `display` string, and `raw` is touched only where a chart
 * needs a number to position a point. The function validates the model's arithmetic
 * against the tool results it cited and recomputes every display value afterwards; a
 * second formatter here could disagree with that and would be believed.
 *
 * It also does not choose colours. `series.colour` is a palette TOKEN and `paletteColour`
 * maps it to the theme, so an answer's charts match the rest of the product in both
 * modes.
 *
 * AN UNKNOWN BLOCK IS SHOWN, NOT SWALLOWED. The function can add a block type without a
 * frontend deploy. A block this build cannot draw renders as a short note naming it, so a
 * reader knows part of the answer is missing instead of quietly receiving less than the
 * model produced.
 */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  itemMasked,
  itemValueText,
  paletteColour,
  toChartRows,
  type FlexibleItem,
} from "../aiSpec";
import type { SpecBlock } from "../api/aiAgent.api";

/** Recessive chrome, from the theme — never a literal. */
const GRID = "hsl(var(--border))";
const AXIS = "hsl(var(--muted-foreground))";

const CHART_HEIGHT = 260;

function BlockFrame({
  title,
  subtitle,
  children,
  className,
}: {
  title?: string;
  subtitle?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border bg-card p-4", className)}>
      {title !== undefined && title !== "" ? (
        <h3 className="font-display text-sm font-semibold">{title}</h3>
      ) : null}
      {subtitle !== null && subtitle !== undefined && subtitle !== "" ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
      <div className={title !== undefined && title !== "" ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

/** A masked figure is marked, so nobody reads the mask as the number. */
function Figure({ item, big }: { item: FlexibleItem; big?: boolean }) {
  const text = itemValueText(item);
  return (
    <div className="min-w-0">
      <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">{item.label}</p>
      <p className={cn("num mt-1 font-semibold", big ? "text-2xl" : "text-lg")}>
        {text ?? "—"}
        {itemMasked(item) ? (
          <span className="ml-1.5 align-middle text-[10px] font-normal text-muted-foreground">
            {t("ai.masked")}
          </span>
        ) : null}
      </p>
      {item.detail !== null && item.detail !== undefined && item.detail !== "" ? (
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{item.detail}</p>
      ) : null}
    </div>
  );
}

function SeriesChart({ block }: { block: SpecBlock }) {
  const series = block.series ?? [];
  const rows = toChartRows(series);
  const isArea = block.type === "area";

  if (rows.length === 0) return <Empty />;

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      {isArea ? (
        <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="x" tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
          <YAxis tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: `1px solid ${GRID}`,
              borderRadius: 8,
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
          />
          {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {series.map((s) => (
            <Area
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={paletteColour(s.colour)}
              fill={paletteColour(s.colour)}
              fillOpacity={0.18}
              strokeWidth={2}
              // Gaps stay gaps: a null is a non-working day, not a zero.
              connectNulls={false}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="x" tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
          <YAxis tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: `1px solid ${GRID}`,
              borderRadius: 8,
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
          />
          {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {series.map((s, i) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={paletteColour(s.colour)}
              strokeWidth={2}
              // Secondary encoding, so identity survives greyscale, print and CVD —
              // the same reason the operational charts carry SERIES_DASH.
              strokeDasharray={["0", "6 3", "2 3", "9 3 2 3"][i % 4]}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

function BarBlock({ block }: { block: SpecBlock }) {
  const series = block.series ?? [];
  const rows = toChartRows(series);
  if (rows.length === 0) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="x" tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
        <YAxis tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))" }}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: `1px solid ${GRID}`,
            borderRadius: 8,
            color: "hsl(var(--popover-foreground))",
            fontSize: 12,
          }}
        />
        {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
        {series.map((s) => (
          // Grouped, never stacked: a stack of two measures invites reading the top
          // segment's height as its own value.
          <Bar key={s.name} dataKey={s.name} fill={paletteColour(s.colour)} radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function DonutBlock({ block }: { block: SpecBlock }) {
  const items = (block.items ?? []).filter((i) => typeof i.raw === "number" || i.value !== null);
  const slices = items.map((item, i) => {
    const raw = typeof item.raw === "number" ? item.raw : Number(item.value?.raw ?? 0);
    return {
      name: item.label,
      value: Number.isFinite(raw) ? raw : 0,
      colour: paletteColour(`series-${(i % 6) + 1}`),
      text: itemValueText(item) ?? "",
    };
  });
  if (slices.length === 0) return <Empty />;
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="82%" strokeWidth={2}>
            {slices.map((s) => (
              <Cell key={s.name} fill={s.colour} stroke="hsl(var(--card))" />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      {/* A legend is always present for more than one slice, and it carries the
          server's own display strings — so identity is never colour alone. */}
      <ul className="space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: s.colour }} />
            <span className="text-muted-foreground">{s.name}</span>
            <span className="num ml-auto font-medium">{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableBlock({ block }: { block: SpecBlock }) {
  const table = block.table;
  if (!table || table.rows.length === 0) return <Empty />;
  type Row = { __i: number; cells: (number | string | null)[] };
  const rows: Row[] = table.rows.map((cells, i) => ({ __i: i, cells }));
  const columns: DataGridColumn<Row>[] = table.columns.map((col, index) => ({
    key: col.key,
    header: col.label,
    render: (row) => {
      const cell = row.cells[index];
      // Cells are pre-formatted server-side. `String` only, never a re-format.
      return <span className="num">{cell === null || cell === undefined ? "—" : String(cell)}</span>;
    },
  }));
  return <DataGrid columns={columns} rows={rows} rowKey={(r) => String(r.__i)} pageSize={12} />;
}

function ProgressBars({ block }: { block: SpecBlock }) {
  const items = block.items ?? [];
  if (items.length === 0) return <Empty />;
  const numbers = items.map((i) => (typeof i.raw === "number" ? i.raw : Number(i.value?.raw ?? 0)));
  const max = Math.max(...numbers.filter((n) => Number.isFinite(n)), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((item, i) => {
        const n = numbers[i] ?? 0;
        const pct = max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
        return (
          <li key={`${item.label}-${i}`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground">{item.label}</span>
              <span className="num shrink-0 font-medium">{itemValueText(item) ?? "—"}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                // Width is the ONLY thing derived from raw, and it is relative to the
                // largest bar — a bar length, not a restated figure.
                style={{ width: `${pct}%`, background: paletteColour("series-1") }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ItemList({ block, timeline }: { block: SpecBlock; timeline?: boolean }) {
  const items = block.items ?? [];
  if (items.length === 0) return <Empty />;
  return (
    <ul className={cn("space-y-2", timeline && "relative border-l pl-4")}>
      {items.map((item, i) => (
        <li key={`${item.label}-${i}`} className="relative text-sm">
          {timeline ? (
            <span
              aria-hidden
              className="absolute -left-[1.32rem] top-1.5 size-2 rounded-full"
              style={{ background: paletteColour("series-1") }}
            />
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">{item.label}</span>
            {itemValueText(item) !== null ? (
              <span className="num shrink-0 font-medium">{itemValueText(item)}</span>
            ) : null}
          </div>
          {item.detail !== null && item.detail !== undefined && item.detail !== "" ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AlertBlock({ block }: { block: SpecBlock }) {
  const severity = block.severity ?? "info";
  const tone =
    severity === "critical" || severity === "danger"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : severity === "warning"
        ? "border-warning/40 bg-warning/5"
        : "border-border bg-muted/40";
  const Icon = severity === "critical" || severity === "danger" ? ShieldAlert : severity === "warning" ? AlertTriangle : Info;
  return (
    <div className={cn("flex gap-3 rounded-lg border p-4", tone)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {block.title !== "" ? <p className="text-sm font-medium">{block.title}</p> : null}
        {block.message !== null && block.message !== undefined ? (
          <p className="mt-0.5 text-sm leading-relaxed">{block.message}</p>
        ) : null}
      </div>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-muted-foreground">{t("ai.block.empty")}</p>;
}

/** Provenance, on every block that cites a tool. */
function Citation({ block }: { block: SpecBlock }) {
  const c = block.citation;
  if (c === null || c === undefined || c.tool === undefined) return null;
  const bits: string[] = [t("ai.citation.tool", { tool: c.tool })];
  if (typeof c.row_count === "number") bits.push(t("ai.citation.rows", { rows: c.row_count }));
  if (c.truncated === true) bits.push(t("ai.citation.truncated"));
  return <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">{bits.join(" · ")}</p>;
}

export function SpecBlockView({ block }: { block: SpecBlock }) {
  const body = ((): React.ReactNode => {
    switch (block.type) {
      case "kpi_row":
      case "gauge_row":
        return (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {(block.items ?? []).map((item, i) => (
              <Figure key={`${item.label}-${i}`} item={item} />
            ))}
          </div>
        );
      case "stat_callout": {
        /*
          Three shapes, in the order they actually occur. The live function puts the
          figure on the BLOCK (`block.raw` + `block.format`); the schema's canonical
          shapes are `items[0]` and `values[0]`. Checking the block first is what fixed
          this block rendering as "nothing to show" while the answer contained a number.
        */
        const first = (block.items ?? [])[0] ?? null;
        const fromValues = (block.values ?? [])[0] ?? null;
        const item: FlexibleItem | null =
          block.raw !== undefined
            ? {
                label: block.title,
                raw: block.raw,
                ...(block.display !== undefined ? { display: block.display } : {}),
                ...(block.masked !== undefined ? { masked: block.masked } : {}),
              }
            : first !== null
              ? first
              : fromValues !== null
                ? { label: fromValues.label, value: fromValues }
                : null;
        // The block title is already the heading; repeating it as the figure's own
        // label would print it twice, one line apart.
        return item === null ? <Empty /> : <Figure item={{ ...item, label: "" }} big />;
      }
      case "line_chart":
      case "area":
        return <SeriesChart block={block} />;
      case "bar_chart":
        return <BarBlock block={block} />;
      case "donut":
        return <DonutBlock block={block} />;
      case "table":
        return <TableBlock block={block} />;
      case "progress_bars":
        return <ProgressBars block={block} />;
      case "timeline":
        return <ItemList block={block} timeline />;
      case "list":
      case "comparison":
      case "payslip_card":
      case "employee_card":
        return <ItemList block={block} />;
      case "calendar_heatmap":
        // Deliberately rendered as a list rather than a fake grid: a heatmap needs a
        // real calendar layout, and a wrong-shaped grid of squares would misplace dates.
        return <ItemList block={block} />;
      default:
        return null;
    }
  })();

  if (block.type === "alert") return <AlertBlock block={block} />;

  if (body === null) {
    // A known unknown — see RENDERABLE_BLOCKS.
    return (
      <BlockFrame title={block.title}>
        <p className="text-sm text-muted-foreground">{t("ai.block.unsupported", { type: block.type })}</p>
      </BlockFrame>
    );
  }

  return (
    <BlockFrame title={block.title} subtitle={block.subtitle ?? null}>
      {body}
      <Citation block={block} />
    </BlockFrame>
  );
}
