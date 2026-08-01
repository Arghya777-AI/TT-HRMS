/**
 * §14 · /admin/analytics/kiosk — Kiosk Analytics. Match rates, latency and
 * outcomes over time for the gate camera.
 *
 * THE NUMBER THIS SCREEN REFUSES TO SHOW is an org-wide match rate.
 * `v_kiosk_health` computes `match_success_pct` per device per IST day
 * (matched × 100 / attempts, in SQL); a ratio cannot be summed, and averaging
 * per-day ratios would weight a 3-scan Sunday like a 200-scan Saturday. No view
 * in the database publishes a fleet-wide rate, so the tiles here are COUNTS from
 * `v_face_match_audit` — one `count=exact` per outcome over the same window and
 * device filter the charts use — and the RATE is shown only where the server
 * computes it: per device, per day, in the trend line and in the grid.
 *
 * Two more honesty lines worth keeping:
 *
 *  * `v_kiosk_health` has a row only for a device-day that saw at least one
 *     attempt, so a gap in the line means the gate was not used that day, not
 *     that it failed. `connectNulls` is off precisely so that reads as a gap.
 *  * The outcome stack plots four of the view's own columns (matched, no match,
 *     ambiguous, liveness failures). Capture failures, engine errors and
 *     suppressed duplicates are NOT folded into an "other" segment, because
 *     folding them would mean adding three columns together in the browser; they
 *     are columns in the grid below instead.
 *
 * Candidate scores behind an individual attempt are super-admin-only and live
 * behind `reveal_face_match_candidates` on /admin/kiosk/matches. Nothing on this
 * screen reveals a biometric score.
 *
 * @route /admin/analytics/kiosk
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity, Camera, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { KpiTile } from "@/shared/ui/KpiTile";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { addIstDays, compareCivilDates, fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import {
  StackedBarsChart,
  TrendLinesChart,
  type ChartPoint,
  type ChartSeries,
} from "../components/AnalyticsOpsCharts";
import { MAX_SERIES } from "../analytics-ops-palette";
import { useKioskDevices, useKioskHealth } from "../hooks/useKioskConsole";
import { useMatchAttemptTotal, useMatchOutcomeCounts } from "../hooks/useAnalyticsOps";
import { matchOutcomeLabel } from "../kiosk-display";
import type { KioskHealthRow } from "../api/system.api";

/** The window the screen opens on: today and the 29 IST days before it. */
const DEFAULT_DAYS = 30;

/**
 * The outcome buckets the tiles count, in funnel order. These are
 * `secure.face_match_log.outcome` values — the log's vocabulary, not ours.
 */
const TILE_OUTCOMES: readonly string[] = ["matched", "no_match", "ambiguous", "liveness_failed"];

/** The four `v_kiosk_health` columns the outcome stack plots, bottom first. */
const OUTCOME_SERIES: readonly ChartSeries[] = [
  { key: "matched", label: t("admin.akiosk.series.matched") },
  { key: "no_match", label: t("admin.akiosk.series.noMatch") },
  { key: "ambiguous", label: t("admin.akiosk.series.ambiguous") },
  { key: "liveness_failures", label: t("admin.akiosk.series.liveness") },
];

const TILE_TONE: Readonly<Record<string, "success" | "warn" | "danger" | "info" | "neutral">> = {
  matched: "success",
  no_match: "warn",
  ambiguous: "danger",
  liveness_failed: "danger",
};

function isCivilDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export default function AnalyticsKioskPage() {
  const [params, setParams] = useSearchParams();

  const today = nowIstDate();
  const fromParam = params.get("from") ?? "";
  const toParam = params.get("to") ?? "";
  const from = isCivilDate(fromParam) ? fromParam : addIstDays(today, -(DEFAULT_DAYS - 1));
  const to = isCivilDate(toParam) ? toParam : today;
  const deviceId = params.get("device") ?? "";
  const rangeInvalid = compareCivilDates(from, to) > 0;

  const devices = useKioskDevices();
  const health = useKioskHealth(from, to);
  const window_ = useMemo(
    () => ({ from, to, ...(deviceId !== "" ? { deviceIds: [deviceId] } : {}) }),
    [from, to, deviceId],
  );
  const outcomeCounts = useMatchOutcomeCounts(window_, TILE_OUTCOMES);
  const attempts = useMatchAttemptTotal(window_);

  const rows = useMemo(() => {
    const all = health.data ?? [];
    return deviceId === "" ? all : all.filter((r) => r.kiosk_device_id === deviceId);
  }, [health.data, deviceId]);

  /** Devices present in the window, in device_code order — the series set. */
  const seriesDevices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      if (!seen.has(row.kiosk_device_id)) seen.set(row.kiosk_device_id, row.device_code);
    }
    return [...seen.entries()]
      .map(([id, code]) => ({ id, code }))
      .sort((a, b) => a.code.localeCompare(b.code, "en-IN", { numeric: true }));
  }, [rows]);

  const deviceSeries: readonly ChartSeries[] = useMemo(
    () => seriesDevices.slice(0, MAX_SERIES).map((d) => ({ key: d.id, label: d.code })),
    [seriesDevices],
  );

  /** IST days present, oldest first — the X axis of both trend charts. */
  const days = useMemo(() => {
    const set = new Set(rows.map((r) => r.ist_date));
    return [...set].sort(compareCivilDates);
  }, [rows]);

  /** (device, day) is unique in the view, so this is a lookup, not an aggregation. */
  const cell = useMemo(() => {
    const map = new Map<string, KioskHealthRow>();
    for (const row of rows) map.set(`${row.ist_date}:${row.kiosk_device_id}`, row);
    return map;
  }, [rows]);

  const ratePoints: readonly ChartPoint[] = useMemo(
    () =>
      days.map((day) => ({
        x: fmtCivilDate(day),
        values: Object.fromEntries(
          deviceSeries.map((s) => [s.key, cell.get(`${day}:${s.key}`)?.match_success_pct ?? null]),
        ),
      })),
    [days, deviceSeries, cell],
  );

  const latencyPoints: readonly ChartPoint[] = useMemo(
    () =>
      days.map((day) => ({
        x: fmtCivilDate(day),
        values: Object.fromEntries(
          deviceSeries.map((s) => [s.key, cell.get(`${day}:${s.key}`)?.p95_latency_ms ?? null]),
        ),
      })),
    [days, deviceSeries, cell],
  );

  /**
   * The outcome stack is only honest for ONE device: stacking two devices'
   * counts in one bar would be a client-side sum. With more than one device in
   * the window the screen asks for a device instead of guessing.
   */
  const singleDevice = seriesDevices.length === 1 ? seriesDevices[0] : undefined;
  const outcomePoints: readonly ChartPoint[] = useMemo(() => {
    if (singleDevice === undefined) return [];
    return days.flatMap((day) => {
      const row = cell.get(`${day}:${singleDevice.id}`);
      if (row === undefined) return [];
      return [
        {
          x: fmtCivilDate(day),
          values: {
            matched: row.matched,
            no_match: row.no_match,
            ambiguous: row.ambiguous,
            liveness_failures: row.liveness_failures,
          },
        },
      ];
    });
  }, [days, cell, singleDevice]);

  const deviceOptions: SelectOption[] = useMemo(
    () =>
      (devices.data ?? []).map((d) => ({
        value: d.id,
        label: t("admin.akiosk.deviceOption", { code: d.device_code, label: d.label }),
      })),
    [devices.data],
  );

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const columns: DataGridColumn<KioskHealthRow>[] = useMemo(
    () => [
      {
        key: "ist_date",
        header: t("admin.akiosk.col.date"),
        width: "9rem",
        sortable: true,
        render: (row) => <span className="num">{fmtCivilDate(row.ist_date)}</span>,
      },
      {
        key: "device_code",
        header: t("admin.akiosk.col.device"),
        width: "11rem",
        sortable: true,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="num font-medium">{row.device_code}</span>
            <span className="text-xs text-muted-foreground">{row.label}</span>
          </span>
        ),
      },
      {
        key: "total_attempts",
        header: t("admin.akiosk.col.attempts"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.total_attempts)}</span>,
      },
      {
        key: "matched",
        header: t("admin.akiosk.col.matched"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.matched)}</span>,
      },
      {
        key: "match_success_pct",
        header: t("admin.akiosk.col.rate"),
        width: "8rem",
        align: "right",
        sortable: true,
        // Clamped: this is a share of attempts, and the view already clamps it.
        render: (row) => (
          <span className="num">{formatPercent(row.match_success_pct, { clamp: true })}</span>
        ),
      },
      {
        key: "no_match",
        header: t("admin.akiosk.col.noMatch"),
        width: "7rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <span className="num">{formatNumber(row.no_match)}</span>,
      },
      {
        key: "ambiguous",
        header: t("admin.akiosk.col.ambiguous"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.ambiguous)}</span>,
      },
      {
        key: "liveness_failures",
        header: t("admin.akiosk.col.liveness"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.liveness_failures)}</span>,
      },
      {
        key: "capture_failures",
        header: t("admin.akiosk.col.capture"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.capture_failures)}</span>,
      },
      {
        key: "errors",
        header: t("admin.akiosk.col.errors"),
        width: "6rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.errors)}</span>,
      },
      {
        key: "duplicates_suppressed",
        header: t("admin.akiosk.col.duplicates"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.duplicates_suppressed)}</span>,
      },
      {
        key: "p50_latency_ms",
        header: t("admin.akiosk.col.p50"),
        width: "7rem",
        align: "right",
        hideBelow: "md",
        render: (row) =>
          row.p50_latency_ms === null ? (
            dash(null)
          ) : (
            <span className="num">
              {t("admin.akiosk.ms", { n: formatNumber(row.p50_latency_ms) })}
            </span>
          ),
      },
      {
        key: "p95_latency_ms",
        header: t("admin.akiosk.col.p95"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) =>
          row.p95_latency_ms === null ? (
            dash(null)
          ) : (
            <span className="num">
              {t("admin.akiosk.ms", { n: formatNumber(row.p95_latency_ms) })}
            </span>
          ),
      },
      {
        key: "offline_replays",
        header: t("admin.akiosk.col.offline"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.offline_replays)}</span>,
      },
      {
        key: "last_seen_at",
        header: t("admin.akiosk.col.lastSeen"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) =>
          row.last_seen_at === null ? dash(null) : (
            <span className="num">{fmtDateTime(row.last_seen_at)}</span>
          ),
      },
    ],
    [],
  );

  const tooManyDevices = seriesDevices.length > MAX_SERIES;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Camera}
        title={t("admin.akiosk.title")}
        subtitle={t("admin.akiosk.subtitle")}
        actions={
          <Button variant="outline" asChild>
            {/* `/admin/kiosk/matches` is NOT a route — this button 404'd. The
                screen is `/admin/kiosk/match-review` (MatchReview.page.tsx). */}
            <Link to="/admin/kiosk/match-review">{t("admin.akiosk.toMatches")}</Link>
          </Button>
        }
      />

      {/* Tiles: server COUNTS over v_face_match_audit — never a client ratio. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile
          label={t("admin.akiosk.kpi.attempts")}
          value={
            attempts.isPending ? "…" : attempts.error !== null ? dash(null) : formatNumber(attempts.data)
          }
          hint={t("admin.akiosk.kpi.attemptsHint")}
          explainer={{
            formula: t("admin.akiosk.kpi.attemptsFormula"),
            numbers: t("admin.akiosk.kpi.window", {
              from: fmtCivilDate(from),
              to: fmtCivilDate(to),
            }),
          }}
        />
        {outcomeCounts.map((bucket) => (
          <KpiTile
            key={bucket.outcome}
            label={matchOutcomeLabel(bucket.outcome) ?? bucket.outcome}
            value={
              bucket.isPending ? "…" : bucket.error !== null ? dash(null) : formatNumber(bucket.count)
            }
            tone={TILE_TONE[bucket.outcome] ?? "neutral"}
            hint={t("admin.akiosk.kpi.outcomeHint")}
            explainer={{
              formula: t("admin.akiosk.kpi.outcomeFormula", { outcome: bucket.outcome }),
              numbers: t("admin.akiosk.kpi.window", {
                from: fmtCivilDate(from),
                to: fmtCivilDate(to),
              }),
            }}
          />
        ))}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("admin.akiosk.filter.from")}
          type="date"
          value={from}
          max={to}
          onChange={(v) => setParam("from", v)}
          {...(rangeInvalid ? { error: t("admin.akiosk.filter.rangeError") } : {})}
        />
        <TextField
          label={t("admin.akiosk.filter.to")}
          type="date"
          value={to}
          min={from}
          onChange={(v) => setParam("to", v)}
        />
        <SelectField
          label={t("admin.akiosk.filter.device")}
          value={deviceId}
          placeholder={t("admin.akiosk.filter.anyDevice")}
          options={deviceOptions}
          onChange={(v) => setParam("device", v)}
        />
        <div className="flex items-end justify-end">
          {params.toString() !== "" ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.akiosk.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {tooManyDevices ? (
        <div className="mt-4">
          <Notice tone="warning">
            {t("admin.akiosk.note.seriesCap", {
              shown: formatNumber(MAX_SERIES),
              total: formatNumber(seriesDevices.length),
            })}
          </Notice>
        </div>
      ) : null}

      {/*
        `[&>*]:min-w-0` is what makes the charts' own `overflow-x-auto` work. A grid item's
        default `min-width: auto` floors it at its content's min-content width, so a 520px plot
        made the CARD 554px wide on a 390px phone — the inner scroller never got the chance to
        scroll because it was never constrained.
      */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="rounded-lg border bg-card p-4">
          <StateBoundary
            loading={health.isPending}
            error={health.error}
            onRetry={() => void health.refetch()}
            isEmpty={ratePoints.length === 0}
            skeletonRows={4}
            empty={
              <EmptyState
                icon={Activity}
                title={t("admin.akiosk.rate.empty.title")}
                hint={t("admin.akiosk.rate.empty.hint")}
              />
            }
          >
            <TrendLinesChart
              title={t("admin.akiosk.rate.title")}
              caption={t("admin.akiosk.rate.caption")}
              series={deviceSeries}
              points={ratePoints}
              format={(v) => formatPercent(v, { clamp: true })}
              xHeader={t("admin.akiosk.col.date")}
              yMax={100}
              yWidth={52}
            />
          </StateBoundary>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <StateBoundary
            loading={health.isPending}
            error={health.error}
            onRetry={() => void health.refetch()}
            isEmpty={latencyPoints.length === 0}
            skeletonRows={4}
            empty={
              <EmptyState
                icon={Gauge}
                title={t("admin.akiosk.latency.empty.title")}
                hint={t("admin.akiosk.latency.empty.hint")}
              />
            }
          >
            <TrendLinesChart
              title={t("admin.akiosk.latency.title")}
              caption={t("admin.akiosk.latency.caption")}
              series={deviceSeries}
              points={latencyPoints}
              format={(v) => (v === null ? dash(null) : t("admin.akiosk.ms", { n: formatNumber(v) }))}
              tickFormat={(v) => (v === null ? dash(null) : formatNumber(v))}
              xHeader={t("admin.akiosk.col.date")}
              yWidth={56}
            />
          </StateBoundary>
        </div>
      </div>

      <div className="mt-4 rounded-lg border bg-card p-4">
        {singleDevice === undefined ? (
          <EmptyState
            icon={Activity}
            title={t("admin.akiosk.outcomes.pick.title")}
            hint={t("admin.akiosk.outcomes.pick.hint")}
          />
        ) : (
          <StateBoundary
            loading={health.isPending}
            error={health.error}
            onRetry={() => void health.refetch()}
            isEmpty={outcomePoints.length === 0}
            skeletonRows={4}
            empty={
              <EmptyState
                icon={Activity}
                title={t("admin.akiosk.outcomes.empty.title")}
                hint={t("admin.akiosk.outcomes.empty.hint")}
              />
            }
          >
            <StackedBarsChart
              title={t("admin.akiosk.outcomes.title", { device: singleDevice.code })}
              caption={t("admin.akiosk.outcomes.caption")}
              series={OUTCOME_SERIES}
              points={outcomePoints}
              format={(v) => (v === null ? dash(null) : formatNumber(v))}
              xHeader={t("admin.akiosk.col.date")}
              yWidth={56}
            />
          </StateBoundary>
        )}
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={health.isPending}
          error={health.error}
          onRetry={() => void health.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Camera}
              title={t("admin.akiosk.grid.empty.title")}
              hint={t("admin.akiosk.grid.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.ist_date}:${row.kiosk_device_id}`}
            pageSize={31}
          />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t("admin.akiosk.note.noFleetRate")}</Notice>
        <Notice tone="warning">{t("admin.akiosk.note.rowCap")}</Notice>
      </div>
    </div>
  );
}
