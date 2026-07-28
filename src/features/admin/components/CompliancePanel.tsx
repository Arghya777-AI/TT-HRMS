/**
 * CompliancePanel — where the paperwork, the gate, the approvals and the kit
 * actually stand, for the department/location/employee already in the URL.
 *
 * NINE RELATIONS, NINE BOUNDARIES
 * ------------------------------
 * `useHrCompliance` deliberately does NOT share one query key: these sections
 * read nine relations at five grains, so there is no single page to project. The
 * screen mirrors that — every block wraps its own `StateBoundary` and names its
 * own relation, so `v_kiosk_health` being unreachable reports one broken section
 * instead of blanking eight working ones. The headline tiles do the same thing at
 * tile granularity: a tile whose read failed shows an em dash, because a failed
 * read rendering as `0` is how a dashboard reports a crisis that never happened.
 *
 * SEVEN THINGS THIS PANEL REFUSES TO DO
 * -------------------------------------
 *  1. IT WILL NOT PRINT A BIOMETRIC COVERAGE PERCENTAGE. `v_enrolment_coverage`
 *     holds gap rows only and is gated on `app.is_admin()` alone, while
 *     `v_admin_employee` also applies `app.admin_scope_covers()` — so "gaps ÷
 *     headcount" divides two different populations and can exceed 100% for a
 *     department-scoped admin. The counts are printed and the absence is stated
 *     (`bio.chartCaption`, `caveat.gapRowsOnly`).
 *  2. IT WILL NOT CHASE A WITHDRAWN CONSENT. The view's own `gap_kind` decides
 *     why somebody is blocked; a withdrawal is a lawful choice, is counted in its
 *     own tile, is never toned as a fault, and never joins the "to enrol" number.
 *     Two places deciding that independently is how a person gets chased for a
 *     right they exercised, so nothing here re-derives it from
 *     `has_active_consent` / `has_active_template`.
 *  3. IT WILL NOT REPORT APPROVAL VOLUME AS A COMPLIANCE MEASURE. Breaches are
 *     the metric. Every rate ships beside its own `decided` count, because three
 *     late out of four and three out of three hundred are different findings.
 *  4. IT WILL NOT CALL A MEAN OF PERCENTILES A PERCENTILE. There is no p95 of the
 *     window — percentiles do not pool — so the tile is the worst OBSERVED
 *     device-day p95 with the device and date it came from, and the mean of the
 *     p95 column is labelled as exactly that.
 *  5. IT WILL NOT LET A CAPPED READ LOOK COMPLETE. Every section prints its
 *     relation and row count, and a read that came back full says so with the cap
 *     in the sentence. Where Postgres also counted the true total (gaps,
 *     exceptions, custody) both numbers are on screen.
 *  6. IT WILL NOT FOLD "NOT RECORDED" INTO "NOT APPLICABLE". A NULL statutory
 *     flag means no `employee_statutory` row at all; it is counted separately and
 *     excluded from every share, because "we never filed it" is the finding.
 *  7. IT WILL NOT ASSUME AN UNRESOLVABLE ASSET HOLDER IS STILL EMPLOYED. A holder
 *     outside this admin's scope is `unknown`, in its own tile, never `current`.
 *
 * WHY THERE IS NO TIME SERIES ON THIS SCREEN
 * -----------------------------------------
 * Eight of the nine relations are snapshots of now — they carry no date column at
 * all, which is why almost every section emits `caveat.snapshotNotPeriod`. The one
 * that is dated (`v_kiosk_health`) is at device × day grain, and pooling it into a
 * daily match rate is arithmetic no relation publishes and the pure aggregate does
 * not expose. Drawing a line from a number this component invented would break the
 * first rule of the surface, so there is no line. The gaps-are-not-zeros rule
 * therefore never bites here: every zero drawn below is a bucket Postgres counted
 * as zero (`bucketByKey` keeps empty buckets on purpose), not a day with no record.
 *
 * Charts come from `AnalyticsOpsCharts` and `DonutChart` — validated categorical
 * palette, secondary encoding, and a real `<table>` fallback under every figure.
 */
import { useMemo, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ClipboardList,
  FileWarning,
  Fingerprint,
  Gauge,
  Package,
  ScanFace,
  ScrollText,
  ShieldCheck,
  UserRound,
  Workflow,
} from "lucide-react";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DonutChart, type DonutSlice } from "@/shared/ui/DonutChart";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { fmtCivilDate, fmtDurationFromHours } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { seriesColour } from "../analytics-ops-palette";
import { AnalyticsFilterBar } from "./AnalyticsFilterBar";
import { RankedBarsChart, type ChartPoint } from "./AnalyticsOpsCharts";
import { Notice } from "./Notice";
import { PersonCell } from "./PersonCell";
import { ADMIN_ROUTES, alertKindLabel } from "../command-vocab";
import { ACK_STATUS_CHIP, COMPLIANCE_CHIP } from "../documents/labels";
import { useAnalyticsFilterOptions } from "../hooks/useAnalytics";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import { useEmployeeLabels, type EmployeeLabelMap } from "../hooks/useEmployeeLabels";
import {
  useApprovalBreaches,
  useAssetCustody,
  useDocumentCompliance,
  useEnrolmentGaps,
  useExpiringDocuments,
  useGateHealth,
  useOpenExceptions,
  useOwnOverdueApprovals,
  usePolicyAcknowledgement,
  useUnacknowledgedPolicies,
  useWorkforceCompliance,
} from "../hooks/useHrCompliance";
import { DOCUMENT_EXPIRY_WINDOW_DAYS } from "../api/command.api";
import type { AdminAck } from "../api/documents.api";
import type { AnalyticsProvenance } from "../api/analytics.api";
import type { DocumentExpiryRow } from "../api/hr-compliance.api";
import {
  COMPLETENESS_UNKNOWN,
  EXCEPTION_SEVERITY_ORDER,
  GAP_KIND_UNKNOWN,
  MIN_ATTEMPTS_FOR_RANKING,
  SEVERITY_UNKNOWN,
  TAX_REGIMES,
  TAX_REGIME_UNKNOWN,
  type ApprovalSlaLike,
  type CompletenessBandKey,
  type CountBucket,
  type CustodyHolderRow,
  type EnrolmentGapKind,
  type EnrolmentGapRow,
  type FlagCoverage,
  type HolderVerdict,
  type KioskHealthRow,
  type PolicyAckRow,
  type StatutoryFlag,
} from "../hrComplianceAggregate";

/**
 * Bars past this are not drawn. An exception-kind list grows every time the view
 * unions a branch, and a chart of thirty 4px bars communicates nothing; the
 * caption is not lying about a top-N because every bucket is also in the table
 * fallback the figure ships.
 */
const MAX_BARS = 14;

/**
 * Every grid below is handed its WHOLE row set, not a slice of it.
 *
 * `DataGrid` pages client-side, so the DOM cost is bounded by the page size and a
 * second truncation here would buy nothing — while silently hiding rows 101–300 of
 * a read this panel has already promised to report the size of. The api module's
 * caps are the only truncation on this screen, and each one announces itself.
 */

// -----------------------------------------------------------------------------
// Server value → label
// -----------------------------------------------------------------------------

/**
 * Every bucket vocabulary below is keyed on the AGGREGATE's own union, not on
 * `string`, and its unknown-bucket key is the imported constant rather than the
 * word spelled again.
 *
 * That is deliberate coupling: a `gap_kind` renamed, a completeness band
 * re-cut or a third tax regime added is then a compile error in this file instead
 * of a raw server value appearing on a compliance report. A value the union does
 * NOT contain — a CASE arm added to a view after today — still renders as itself
 * through {@link bucketLabel}, which is the visible under-report the aggregate
 * keeps its unknown bucket for.
 */
const GAP_KIND_LABEL: Readonly<Record<EnrolmentGapKind | typeof GAP_KIND_UNKNOWN, MessageKey>> = {
  no_consent: "admin.hrcomp.bio.gap.no_consent",
  consented_not_enrolled: "admin.hrcomp.bio.gap.consented_not_enrolled",
  consent_withdrawn: "admin.hrcomp.bio.gap.consent_withdrawn",
  [GAP_KIND_UNKNOWN]: "admin.hrcomp.bio.gap.unclassified",
};

/**
 * The one gap kind that is NOT somebody's to-do, named once and typed against the
 * view's union so the "never chase a withdrawal" branch below cannot rot into a
 * stale string literal that silently stops matching.
 */
const WITHDRAWN_GAP: EnrolmentGapKind = "consent_withdrawn";

const SEVERITY_LABEL: Readonly<
  Record<(typeof EXCEPTION_SEVERITY_ORDER)[number] | typeof SEVERITY_UNKNOWN, MessageKey>
> = {
  critical: "admin.hrcomp.exc.critical",
  warning: "admin.hrcomp.exc.warning",
  info: "admin.hrcomp.exc.info",
  [SEVERITY_UNKNOWN]: "admin.hrcomp.exc.unclassified",
};

const REGIME_LABEL: Readonly<
  Record<(typeof TAX_REGIMES)[number] | typeof TAX_REGIME_UNKNOWN, MessageKey>
> = {
  old: "admin.hrcomp.stat.regime.old",
  new: "admin.hrcomp.stat.regime.new",
  [TAX_REGIME_UNKNOWN]: "admin.hrcomp.stat.regime.not_recorded",
};

const BAND_LABEL: Readonly<
  Record<CompletenessBandKey | typeof COMPLETENESS_UNKNOWN, MessageKey>
> = {
  under50: "admin.hrcomp.comp.band.under50",
  b50to74: "admin.hrcomp.comp.band.b50to74",
  b75to89: "admin.hrcomp.comp.band.b75to89",
  b90to99: "admin.hrcomp.comp.band.b90to99",
  complete: "admin.hrcomp.comp.band.complete",
  [COMPLETENESS_UNKNOWN]: "admin.hrcomp.comp.band.not_recorded",
};

const FLAG_LABEL: Readonly<Record<StatutoryFlag, MessageKey>> = {
  pf: "admin.hrcomp.stat.flag.pf",
  esi: "admin.hrcomp.stat.flag.esi",
  pt: "admin.hrcomp.stat.flag.pt",
  lwf: "admin.hrcomp.stat.flag.lwf",
};

/**
 * `unknown` is warn and not danger on purpose: it means "outside your admin
 * scope", which is a limit of the reader's permissions rather than a fault of the
 * holder. `exited` is the finding, so it is the only red one.
 */
const VERDICT_CHIP: Readonly<Record<HolderVerdict, StatusChipEntry>> = {
  current: { label: t("admin.hrcomp.asset.verdict.current"), tone: "neutral" },
  exited: { label: t("admin.hrcomp.asset.verdict.exited"), tone: "danger" },
  unknown: { label: t("admin.hrcomp.asset.verdict.unknown"), tone: "warn" },
};

/**
 * An unmapped bucket key is SERVER DATA — a CASE arm added to a view after this
 * file was written. It renders as itself rather than as a blank or a guess, which
 * is the visible under-report `bucketByKey` keeps its unknown bucket for.
 */
function bucketLabel(map: Readonly<Record<string, MessageKey>>, key: string): string {
  const mapped = map[key];
  return mapped === undefined ? key : t(mapped);
}

/** '134 of 214' — the sentence a share is not allowed on this screen without. */
function ofTotal(numerator: number, denominator: number): string {
  return t("admin.hrcomp.ofTotal", {
    n: formatNumber(numerator),
    d: formatNumber(denominator),
  });
}

/**
 * A chart's caption, plus a "top N of M" line whenever buckets were left off.
 *
 * Only the two unbounded distributions can trip it — exception kinds and request
 * types both grow with the schema — but it is applied to every figure so the day
 * one of them passes fourteen the picture says so instead of quietly becoming a
 * top-14.
 */
function barsCaption(base: string, total: number): string {
  if (total <= MAX_BARS) return base;
  return `${base} ${t("admin.hrcomp.bars.more", { shown: MAX_BARS, total: formatNumber(total) })}`;
}

/** A latency the server measured in milliseconds. Sub-millisecond precision is noise. */
function msText(value: number | null | undefined): string {
  return dash(value, (ms) => t("admin.akiosk.ms", { n: formatNumber(Math.round(ms)) }));
}

/**
 * A failed read is an em dash, NEVER the zero the `?? 0` fallback would produce.
 * Each headline tile reads its own query, so one broken relation costs one tile.
 */
function orDash(error: Error | null, value: string): string {
  return error === null ? value : dash(null);
}

const countFormat = (value: number | null): string => formatNumber(value);

/** Buckets → bars, keeping the SERVER's key as the drill identity, never the label. */
function toBucketPoints(
  buckets: readonly CountBucket[],
  labels: Readonly<Record<string, MessageKey>> | null,
  measureKey: string,
): ChartPoint[] {
  return buckets.slice(0, MAX_BARS).map((bucket) => ({
    x: labels === null ? alertKindLabel(bucket.key) : bucketLabel(labels, bucket.key),
    id: bucket.key,
    values: { [measureKey]: bucket.count },
  }));
}

// -----------------------------------------------------------------------------
// Provenance chrome
// -----------------------------------------------------------------------------

/**
 * The two caveats that change whether a number can be believed at all. Everything
 * else the scope reported is context, and context does not need a banner each.
 */
const CAVEAT_WARNING: readonly MessageKey[] = [
  "admin.hrcomp.caveat.truncated",
  "admin.hrcomp.caveat.holderIdsCapped",
];

/**
 * Everything the data layer discovered while answering, printed ABOVE the numbers
 * it qualifies — a reader who has already believed a figure is not helped by a
 * footnote.
 *
 * `AnalyticsCaveats` is deliberately not reused: it interpolates only the
 * `analytics.caveat.*` vocabulary, so this panel's `{cap}` would reach the DOM as
 * the literal text `{cap}`, and its closing line describes attendance day records
 * that none of these nine relations are.
 */
function SectionCaveats({
  provenance,
  warningsOnly = false,
}: {
  provenance: AnalyticsProvenance | undefined;
  /**
   * Drop the context sentences and keep the ones that change whether a number can
   * be believed. Set where a SIBLING block already printed this relation's scope
   * caveats — the document tiles and the lapsing list read `v_document_compliance`
   * with the same dimension support, so "this is a snapshot of now" is one fact
   * about one relation and is stated once.
   */
  warningsOnly?: boolean;
}) {
  if (provenance === undefined || provenance.caveats.length === 0) return null;
  const warnings = provenance.caveats.filter((key) => CAVEAT_WARNING.includes(key));
  const notes = warningsOnly
    ? []
    : provenance.caveats.filter((key) => !CAVEAT_WARNING.includes(key));
  if (warnings.length === 0 && notes.length === 0) return null;
  return (
    <div className="mb-3 space-y-2">
      {warnings.map((key) => (
        <Notice key={key} tone="warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {key === "admin.hrcomp.caveat.truncated"
              ? t(key, { cap: formatNumber(provenance.rowCap) })
              : t(key)}
          </span>
        </Notice>
      ))}
      {notes.length > 0 ? (
        <p className="text-xs text-muted-foreground">{notes.map((key) => t(key)).join(" ")}</p>
      ) : null}
    </div>
  );
}

/** Which relation, and how many rows of it. The traceability line, per section. */
function SectionBasis({ provenance }: { provenance: AnalyticsProvenance | undefined }) {
  if (provenance === undefined) return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      {t("admin.hrcomp.basis", {
        relation: provenance.relation,
        rows: formatNumber(provenance.rowsScanned),
      })}
    </p>
  );
}

interface PanelSectionProps {
  readonly title: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly caption?: string;
  /**
   * Omitted when a sibling block already printed this relation's caveats and
   * basis — three of the sections below are projections of ONE read, and saying
   * "2,000-row cap" three times reads as three separate problems.
   */
  readonly provenance?: AnalyticsProvenance;
  readonly children: ReactNode;
}

function PanelSection({ title, icon: Icon, caption, provenance, children }: PanelSectionProps) {
  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {title}
      </h3>
      {caption === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
      )}
      <div className="mt-3">
        <SectionCaveats provenance={provenance} />
        {children}
        <SectionBasis provenance={provenance} />
      </div>
    </section>
  );
}

export interface CompliancePanelProps {
  /**
   * Override the URL-backed filters. Omit on a normal screen — the panel then
   * reads the same `AnalyticsFilters` the filter bar writes, so a drill-through
   * into it inherits the exact question being asked.
   */
  readonly filters?: AnalyticsFilters;
  /**
   * Render this panel's own filter bar. FALSE when embedded under a surface that
   * already renders one over the same URL filters — see `WorkforcePanelProps`. Every
   * dimension a section cannot reach is already declared by `scopeFor` and printed
   * in that section's caveats, so the honesty does not live in the bar.
   */
  readonly showFilterBar?: boolean;
}

export function CompliancePanel({
  filters: override,
  showFilterBar = true,
}: CompliancePanelProps = {}) {
  const navigate = useNavigate();
  const { filters: urlFilters } = useAnalyticsFilters();
  const filters = override ?? urlFilters;

  const options = useAnalyticsFilterOptions();
  const labels = useEmployeeLabels();

  const documents = useDocumentCompliance(filters);
  const expiring = useExpiringDocuments(filters);
  const policies = usePolicyAcknowledgement(filters);
  const unacknowledged = useUnacknowledgedPolicies(filters);
  const gaps = useEnrolmentGaps(filters);
  const gate = useGateHealth(filters);
  const breaches = useApprovalBreaches(filters);
  const ownOverdue = useOwnOverdueApprovals();
  const exceptions = useOpenExceptions(filters);
  const workforce = useWorkforceCompliance(filters);
  const custody = useAssetCustody(filters);

  const docs = documents.data?.summary;
  const policy = policies.data?.summary;
  const gapSummary = gaps.data?.summary;
  const gateSummary = gate.data?.summary;
  const sla = breaches.data?.summary;
  const queue = exceptions.data?.summary;
  const staff = workforce.data?.summary;
  const kit = custody.data?.summary;

  /** The 360 route is keyed by employee_code, not by id — see route-manifest. */
  function openPerson(code: string | null | undefined): void {
    if (code == null || code === "") return;
    void navigate(ADMIN_ROUTES.person(code));
  }

  const gapPoints = useMemo(
    () => toBucketPoints(gapSummary?.byKind ?? [], GAP_KIND_LABEL, "people"),
    [gapSummary],
  );

  // No label map: `alertKindLabel` already names every kind the alert feed knows
  // and humanises the ones it does not, which is exactly the ninth-CASE-arm case
  // `groupExceptions` refuses to drop.
  const kindPoints = useMemo(
    () => toBucketPoints(queue?.byKind ?? [], null, "exceptions"),
    [queue],
  );

  const slaTypePoints = useMemo<ChartPoint[]>(
    () =>
      (sla?.byRequestType ?? []).slice(0, MAX_BARS).map((row) => ({
        x: row.requestTypeName,
        id: row.requestTypeCode,
        values: { breached: row.breached, decided: row.decided },
      })),
    [sla],
  );

  const completenessPoints = useMemo(
    () => toBucketPoints(staff?.completeness ?? [], BAND_LABEL, "people"),
    [staff],
  );

  const regimeSlices = useMemo<DonutSlice[]>(
    () =>
      (staff?.taxRegime ?? []).map((bucket, i) => ({
        // The index is a stable identity here and not a rank: `bucketByKey` emits
        // `TAX_REGIMES` first and in order, zero counts included, so a regime that
        // empties keeps its slot and its hue instead of repainting the survivors.
        key: bucket.key,
        label: bucketLabel(REGIME_LABEL, bucket.key),
        value: bucket.count,
        color: seriesColour(i),
        // The hatch is reserved for "we never recorded this", so it reads as
        // different in kind from a declared regime rather than as a third hue.
        ...(bucket.key === TAX_REGIME_UNKNOWN ? { texture: true } : {}),
      })),
    [staff],
  );

  return (
    <section className="mb-8">
      {/* `source` is hidden rather than ignored: punch capture method is a column
          on `attendance_punches`, and nothing on this panel is at scan grain. The
          other three dimensions reach at least one relation each, and the ones
          they cannot reach say so in that section's own caveats. */}
      {showFilterBar ? (
        <AnalyticsFilterBar
          departments={options.data?.departments ?? []}
          locations={options.data?.locations ?? []}
          optionsLoading={options.isLoading}
          hide={["source"]}
        />
      ) : null}

      <div className="mb-3 mt-5">
        <h2 className="font-display text-lg font-semibold">{t("admin.hrcomp.title")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.hrcomp.subtitle")}</p>
      </div>

      {/* ═══ HEADLINE ═══════════════════════════════════════════════════════
          Ten tiles over eight relations. Each reads its OWN query result, so a
          relation that is unreachable costs one em dash instead of the row. */}
      <h3 className="sr-only">{t("admin.hrcomp.headline")}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          label={t("admin.hrcomp.kpi.docComplete")}
          value={orDash(documents.error, formatPercent(docs?.complete.pct ?? null))}
          hint={t("admin.hrcomp.kpi.docCompleteHint", {
            valid: formatNumber(docs?.valid ?? 0),
            total: formatNumber(docs?.requirements ?? 0),
          })}
          to={withFilters("/admin/documents/repository", filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.docExpiring")}
          value={orDash(documents.error, formatNumber(docs?.expiringSoon ?? 0))}
          tone={(docs?.expiringSoon ?? 0) > 0 ? "warn" : undefined}
          hint={t("admin.hrcomp.kpi.docExpiringHint", { days: DOCUMENT_EXPIRY_WINDOW_DAYS })}
          to={withFilters(ADMIN_ROUTES.documentExpiry, filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.docMissing")}
          value={orDash(documents.error, formatNumber(docs?.missing ?? 0))}
          tone={(docs?.missing ?? 0) > 0 ? "warn" : undefined}
          hint={t("admin.hrcomp.kpi.docMissingHint", {
            total: formatNumber(docs?.requirements ?? 0),
          })}
          to={withFilters("/admin/documents/repository", filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.docExpired")}
          value={orDash(documents.error, formatNumber(docs?.expired ?? 0))}
          tone={(docs?.expired ?? 0) > 0 ? "danger" : undefined}
          hint={t("admin.hrcomp.kpi.docExpiredHint")}
          to={withFilters(ADMIN_ROUTES.documentExpiry, filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.policyRate")}
          value={orDash(policies.error, formatPercent(policy?.acknowledgedRate.pct ?? null))}
          hint={t("admin.hrcomp.kpi.policyRateHint", {
            ack: formatNumber(policy?.acknowledged ?? 0),
            assigned: formatNumber(policy?.assigned ?? 0),
          })}
          to={withFilters("/admin/comms/acknowledgements", filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.gateBlocked")}
          value={orDash(gaps.error, formatNumber(gapSummary?.chaseable ?? 0))}
          tone={(gapSummary?.chaseable ?? 0) > 0 ? "warn" : undefined}
          hint={t("admin.hrcomp.kpi.gateBlockedHint")}
          to={withFilters(ADMIN_ROUTES.kioskEnrolment, filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.slaBreaches")}
          value={orDash(breaches.error, formatNumber(sla?.breached ?? 0))}
          tone={(sla?.breached ?? 0) > 0 ? "warn" : undefined}
          hint={t("admin.hrcomp.kpi.slaBreachesHint", {
            breached: formatNumber(sla?.breached ?? 0),
            decided: formatNumber(sla?.decided ?? 0),
          })}
          to={withFilters(ADMIN_ROUTES.workflowSla, filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.exceptions")}
          value={orDash(exceptions.error, formatNumber(queue?.total ?? 0))}
          tone={(queue?.critical ?? 0) > 0 ? "danger" : undefined}
          hint={t("admin.hrcomp.kpi.exceptionsHint")}
          to={withFilters(ADMIN_ROUTES.alerts, filters)}
        />
        <KpiTile
          label={t("admin.hrcomp.kpi.assetsExited")}
          value={orDash(custody.error, formatNumber(kit?.heldByExited ?? 0))}
          tone={(kit?.heldByExited ?? 0) > 0 ? "danger" : undefined}
          hint={t("admin.hrcomp.kpi.assetsExitedHint")}
          to={withFilters("/admin/assets/exit-liability", filters)}
        />
        {/* Labelled as YOURS, because the database publishes no organisation-wide
            equivalent and a reader must not take this for one. */}
        <KpiTile
          label={t("admin.hrcomp.kpi.ownOverdue")}
          value={orDash(ownOverdue.error, formatNumber(ownOverdue.data?.overdue ?? 0))}
          tone={(ownOverdue.data?.overdue ?? 0) > 0 ? "warn" : undefined}
          hint={t("admin.hrcomp.kpi.ownOverdueHint", {
            overdue: formatNumber(ownOverdue.data?.overdue ?? 0),
            pending: formatNumber(ownOverdue.data?.pending ?? 0),
          })}
          to={withFilters("/me/approvals", filters)}
        />
      </div>

      {/* ── Where the headline came from ──────────────────────────────────────
             The four document tiles are five `count=exact` HEADs over
             `v_document_compliance`, so their scope caveats are printed HERE,
             against the numbers, and the lapsing list below prints only its own
             truncation warning rather than repeating them. The own-queue sentence
             has no section of its own and must not be inferred from the word
             "your" on a tile. */}
      <div className="mt-3">
        <SectionCaveats provenance={documents.data?.provenance} />
        <SectionCaveats provenance={ownOverdue.data?.provenance} />
        <SectionBasis provenance={documents.data?.provenance} />
      </div>

      {/* The gap tile is bucketed in the browser from a capped page, so when the
          cap bites it is a FLOOR. Said next to the tile, not in a footnote. */}
      {gapSummary?.partial === true ? (
        <Notice tone="warning" className="mt-3">
          {t("admin.hrcomp.kpi.gateBlockedPartial", {
            scanned: formatNumber(gapSummary.scanned),
            total: formatNumber(gapSummary.total),
          })}
        </Notice>
      ) : null}

      {/* The four status counts must add up to the unnarrowed one. When they do
          not, the deployed view has grown an arm this screen cannot name. */}
      {(docs?.unclassified ?? 0) > 0 ? (
        <Notice tone="warning" className="mt-3">
          {t("admin.hrcomp.doc.drift", { n: formatNumber(docs?.unclassified ?? 0) })}
        </Notice>
      ) : null}

      {/* ═══ DOCUMENTS — the action list ════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.doc.title")}
        icon={FileWarning}
        caption={t("admin.hrcomp.doc.caption")}
      >
        {/* Same relation as the tiles above, so only the cap is news here. */}
        <SectionCaveats provenance={expiring.data?.provenance} warningsOnly />
        <StateBoundary
          loading={expiring.isLoading}
          error={expiring.error ?? undefined}
          onRetry={() => void expiring.refetch()}
          isEmpty={expiring.isSuccess && expiring.data.rows.length === 0}
          empty={
            <EmptyState
              icon={FileWarning}
              title={t("admin.hrcomp.doc.empty.title", { days: DOCUMENT_EXPIRY_WINDOW_DAYS })}
              hint={t("admin.hrcomp.doc.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <DataGrid
            columns={expiringColumns()}
            rows={expiring.data?.rows ?? []}
            // Employee × required document type IS the grain of this view, so both
            // ids are needed for a key that is unique on a person with two lapsing
            // certificates.
            rowKey={(row) => `${row.employee_id}:${row.document_type_id}`}
            pageSize={10}
            onRowClick={(row) => openPerson(row.employee_code)}
          />
        </StateBoundary>
        <SectionBasis provenance={expiring.data?.provenance} />
      </PanelSection>

      {/* ═══ POLICY ACKNOWLEDGEMENT ═════════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.pol.title")}
        icon={ScrollText}
        provenance={policies.data?.provenance}
      >
        <StateBoundary
          loading={policies.isLoading}
          error={policies.error ?? undefined}
          onRetry={() => void policies.refetch()}
          isEmpty={policies.isSuccess && (policy?.policies ?? 0) === 0}
          empty={
            <EmptyState
              icon={ScrollText}
              title={t("admin.hrcomp.pol.empty.title")}
              hint={t("admin.hrcomp.pol.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile
              label={t("admin.hrcomp.pol.rate")}
              value={formatPercent(policy?.acknowledgedRate.pct ?? null)}
              hint={t("admin.hrcomp.pol.rateHint", {
                assigned: formatNumber(policy?.assigned ?? 0),
                policies: formatNumber(policy?.policies ?? 0),
              })}
              to={withFilters("/admin/comms/acknowledgements", filters)}
            />
            {/* Beside the pooled rate, never instead of it: when the two disagree
                a heavily-assigned policy is dragging one of them, and that gap is
                the story. */}
            <KpiTile
              label={t("admin.hrcomp.pol.meanPolicy")}
              value={formatPercent(policy?.meanPolicyPct ?? null)}
              hint={t("admin.hrcomp.pol.meanPolicyHint", {
                policies: formatNumber(policy?.policiesWithAssignees ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.hrcomp.pol.outstanding")}
              value={formatNumber(policy?.outstanding ?? 0)}
              tone={(policy?.outstanding ?? 0) > 0 ? "warn" : undefined}
              hint={t("admin.hrcomp.pol.outstandingHint")}
            />
            <KpiTile
              label={t("admin.hrcomp.pol.overdue")}
              value={formatNumber(policy?.overdue ?? 0)}
              tone={(policy?.overdue ?? 0) > 0 ? "danger" : undefined}
              hint={t("admin.hrcomp.pol.overdueHint")}
            />
          </div>

          <h4 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("admin.hrcomp.pol.worstTitle")}
          </h4>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            {t("admin.hrcomp.pol.worstCaption")}
          </p>
          {/* No `onRowClick`. There is no route that takes ONE policy document as
              a parameter, and a row click that lands every row on the same screen
              looks like a per-policy drill and is not one. The tile above links to
              the acknowledgement console; this table stays a table. */}
          <DataGrid
            columns={policyColumns()}
            rows={policy?.worst ?? []}
            rowKey={(row) => row.document_id}
            pageSize={10}
          />
        </StateBoundary>
      </PanelSection>

      {/* WHO has not acknowledged. A rate on its own names nobody, and nobody is
          who a chase list has to be addressed to. Its own relation, its own
          boundary — `document_acknowledgements`, not the aggregate view. */}
      <PanelSection
        title={t("admin.hrcomp.pol.openTitle")}
        icon={ClipboardList}
        caption={t("admin.hrcomp.pol.openCaption")}
        provenance={unacknowledged.data?.provenance}
      >
        <StateBoundary
          loading={unacknowledged.isLoading}
          error={unacknowledged.error ?? undefined}
          onRetry={() => void unacknowledged.refetch()}
          isEmpty={unacknowledged.isSuccess && unacknowledged.data.rows.length === 0}
          empty={
            <EmptyState
              icon={ClipboardList}
              title={t("admin.hrcomp.pol.openEmpty.title")}
              hint={t("admin.hrcomp.pol.openEmpty.hint")}
            />
          }
          skeletonRows={2}
        >
          <DataGrid
            columns={unacknowledgedColumns(labels.data)}
            rows={unacknowledged.data?.rows ?? []}
            rowKey={(row) => row.id}
            pageSize={10}
            onRowClick={(row) => openPerson(labels.data?.get(row.employee_id)?.code)}
          />
        </StateBoundary>
      </PanelSection>

      {/* ═══ BIOMETRIC COVERAGE ═════════════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.bio.title")}
        icon={ScanFace}
        provenance={gaps.data?.provenance}
      >
        <StateBoundary
          loading={gaps.isLoading}
          error={gaps.error ?? undefined}
          onRetry={() => void gaps.refetch()}
          isEmpty={gaps.isSuccess && (gapSummary?.total ?? 0) === 0}
          empty={
            <EmptyState
              icon={ScanFace}
              title={t("admin.hrcomp.bio.empty.title")}
              hint={t("admin.hrcomp.bio.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3">
            <KpiTile
              label={t("admin.hrcomp.bio.chaseable")}
              value={formatNumber(gapSummary?.chaseable ?? 0)}
              tone={(gapSummary?.chaseable ?? 0) > 0 ? "warn" : undefined}
              hint={t("admin.hrcomp.bio.chaseableHint")}
              to={withFilters(ADMIN_ROUTES.kioskEnrolment, filters)}
            />
            {/* No tone at all. A withdrawal is a lawful choice, and colouring it
                the same as a to-do is how somebody gets chased for one. */}
            <KpiTile
              label={t("admin.hrcomp.bio.withdrawn")}
              value={formatNumber(gapSummary?.withdrawn ?? 0)}
              hint={t("admin.hrcomp.bio.withdrawnHint")}
              to={withFilters("/admin/kiosk/consent", filters)}
            />
          </div>

          <div className="mt-4">
            <RankedBarsChart
              title={t("admin.hrcomp.bio.chartTitle")}
              caption={barsCaption(
                t("admin.hrcomp.bio.chartCaption"),
                gapSummary?.byKind.length ?? 0,
              )}
              measure={{ key: "people", label: t("admin.hrcomp.bio.series") }}
              points={gapPoints}
              format={countFormat}
              xHeader={t("admin.hrcomp.bio.col.reason")}
              select={{
                selectLabel: (label) => t("admin.hrcomp.drill", { name: label }),
                onSelect: (id) => {
                  // The withdrawal register, not the enrolment queue: these people
                  // are not waiting to be booked in and must never appear on a
                  // screen whose purpose is to book people in.
                  void navigate(
                    withFilters(
                      id === WITHDRAWN_GAP ? "/admin/kiosk/consent" : ADMIN_ROUTES.kioskEnrolment,
                      filters,
                    ),
                  );
                },
              }}
            />
          </div>

          <div className="mt-4">
            <DataGrid
              columns={gapColumns()}
              rows={gapSummary?.rows ?? []}
              rowKey={(row) => row.employee_id}
              pageSize={10}
              onRowClick={(row) => openPerson(row.employee_code)}
            />
          </div>
        </StateBoundary>
      </PanelSection>

      {/* ═══ GATE HEALTH ════════════════════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.gate.title")}
        icon={Gauge}
        provenance={gate.data?.provenance}
      >
        <StateBoundary
          loading={gate.isLoading}
          error={gate.error ?? undefined}
          onRetry={() => void gate.refetch()}
          isEmpty={gate.isSuccess && (gateSummary?.deviceDays ?? 0) === 0}
          empty={
            <EmptyState
              icon={Gauge}
              title={t("admin.hrcomp.gate.empty.title")}
              hint={t("admin.hrcomp.gate.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <KpiTile
              label={t("admin.hrcomp.gate.matchRate")}
              value={formatPercent(gateSummary?.matchRate.pct ?? null)}
              hint={t("admin.hrcomp.gate.matchRateHint", {
                matched: formatNumber(gateSummary?.matched ?? 0),
                attempts: formatNumber(gateSummary?.attempts ?? 0),
              })}
            />
            {/* An OBSERVED extreme with the device-day it came from, because there
                is no p95 of the window: percentiles do not pool. */}
            <KpiTile
              label={t("admin.hrcomp.gate.p95")}
              value={msText(gateSummary?.worstP95?.ms)}
              hint={
                gateSummary?.worstP95 == null
                  ? t("admin.hrcomp.gate.p95None")
                  : t("admin.hrcomp.gate.p95Hint", {
                      device: gateSummary.worstP95.deviceCode,
                      date: fmtCivilDate(gateSummary.worstP95.istDate),
                    })
              }
            />
            <KpiTile
              label={t("admin.hrcomp.gate.meanP95")}
              value={msText(gateSummary?.meanDeviceDayP95Ms)}
              hint={t("admin.hrcomp.gate.meanP95Hint", {
                n: formatNumber(gateSummary?.p95Samples ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.hrcomp.gate.meanP50")}
              value={msText(gateSummary?.meanDeviceDayP50Ms)}
              hint={t("admin.hrcomp.gate.meanP50Hint", {
                n: formatNumber(gateSummary?.p50Samples ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.hrcomp.gate.replays")}
              value={formatNumber(gateSummary?.offlineReplays ?? 0)}
              hint={t("admin.hrcomp.gate.replaysHint", {
                n: formatNumber(gateSummary?.deviceDays ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.hrcomp.gate.devices")}
              value={formatNumber(gateSummary?.devices ?? 0)}
              hint={t("admin.hrcomp.gate.devicesHint", {
                devices: formatNumber(gateSummary?.devices ?? 0),
                deviceDays: formatNumber(gateSummary?.deviceDays ?? 0),
              })}
              to={withFilters(ADMIN_ROUTES.kioskDevices, filters)}
            />
          </div>

          <div className="mt-3 space-y-2">
            {(gateSummary?.lowVolumeDeviceDays ?? 0) > 0 ? (
              <Notice tone="info">
                {t("admin.hrcomp.gate.lowVolume", {
                  n: formatNumber(gateSummary?.lowVolumeDeviceDays ?? 0),
                  min: MIN_ATTEMPTS_FOR_RANKING,
                })}
              </Notice>
            ) : null}
            {(gateSummary?.inactiveDevices ?? 0) > 0 ? (
              <Notice tone="warning">
                {t("admin.hrcomp.gate.inactive", {
                  n: formatNumber(gateSummary?.inactiveDevices ?? 0),
                })}
              </Notice>
            ) : null}
          </div>

          <h4 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("admin.hrcomp.gate.worstTitle")}
          </h4>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            {t("admin.hrcomp.gate.worstCaption")}
          </p>
          {/* No `onRowClick`: no screen takes one device-DAY as a parameter, and
              sending every row to the device list would dress a constant link up
              as a drill-through. The "Devices seen" tile carries that link. */}
          <DataGrid
            columns={gateColumns()}
            rows={gateSummary?.worstDeviceDays ?? []}
            // Device × IST day is the view's GROUP BY, so both parts are the key.
            rowKey={(row) => `${row.kiosk_device_id}:${row.ist_date}`}
            pageSize={10}
          />
        </StateBoundary>
      </PanelSection>

      {/* ═══ APPROVAL SLA BREACHES ══════════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.sla.title")}
        icon={Workflow}
        provenance={breaches.data?.provenance}
      >
        <StateBoundary
          loading={breaches.isLoading}
          error={breaches.error ?? undefined}
          onRetry={() => void breaches.refetch()}
          isEmpty={breaches.isSuccess && (sla?.pairs ?? 0) === 0}
          empty={
            <EmptyState
              icon={Workflow}
              title={t("admin.hrcomp.sla.empty.title")}
              hint={t("admin.hrcomp.sla.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile
              label={t("admin.hrcomp.sla.breached")}
              value={formatNumber(sla?.breached ?? 0)}
              tone={(sla?.breached ?? 0) > 0 ? "warn" : "success"}
              hint={t("admin.hrcomp.sla.breachedHint")}
              to={withFilters(ADMIN_ROUTES.workflowSla, filters)}
            />
            <KpiTile
              label={t("admin.hrcomp.sla.rate")}
              value={formatPercent(sla?.breachRate.pct ?? null)}
              hint={t("admin.hrcomp.sla.rateHint", {
                breached: formatNumber(sla?.breached ?? 0),
                decided: formatNumber(sla?.decided ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.hrcomp.sla.approvers")}
              value={ofTotal(sla?.approversBreaching ?? 0, sla?.approvers ?? 0)}
              hint={t("admin.hrcomp.sla.approversHint", {
                breaching: formatNumber(sla?.approversBreaching ?? 0),
                approvers: formatNumber(sla?.approvers ?? 0),
              })}
            />
            {/* The mean of every decision, recovered by weighting each row's own
                average by its `decided` — not a mean of means. */}
            <KpiTile
              label={t("admin.hrcomp.sla.hours")}
              value={fmtDurationFromHours(sla?.pooledHoursToDecide ?? null)}
              hint={t("admin.hrcomp.sla.hoursHint", {
                n: formatNumber(sla?.hoursBasis ?? 0),
              })}
            />
          </div>

          {(sla?.breached ?? 0) === 0 ? (
            <div className="mt-4">
              <EmptyState
                icon={ShieldCheck}
                title={t("admin.hrcomp.sla.clean.title")}
                hint={t("admin.hrcomp.sla.clean.hint", {
                  decided: formatNumber(sla?.decided ?? 0),
                })}
              />
            </div>
          ) : (
            <>
              <h4 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("admin.hrcomp.sla.worstTitle")}
              </h4>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">
                {t("admin.hrcomp.sla.worstCaption")}
              </p>
              {/* Each row IS a person, but the person here is the DECIDER, and
                  `filters.employeeId` means "the employee this data is about" on
                  every other section of this panel. Opening the approver's record
                  from a breach row would answer a different question than the one
                  the row asks, so the row does not navigate. */}
              <DataGrid
                columns={slaColumns()}
                rows={sla?.worst ?? []}
                // Approver × request type is the view's grain; one approver appears
                // once per type they decide.
                rowKey={(row) => `${row.approver_employee_id}:${row.request_type_code}`}
                pageSize={10}
              />
              <div className="mt-4">
                {/* The same breaches rolled to the request type: this is how a slow
                    person is told apart from a slow process. `decided` rides along
                    in the table fallback as the denominator, never as a bar — and
                    there is no `select`, because no screen takes a request type
                    code as a filter and a bar that always opens the same page is
                    not a drill-through. */}
                <RankedBarsChart
                  title={t("admin.hrcomp.sla.byTypeTitle")}
                  caption={barsCaption(
                    t("admin.hrcomp.sla.byTypeCaption"),
                    sla?.byRequestType.length ?? 0,
                  )}
                  measure={{ key: "breached", label: t("admin.hrcomp.sla.series") }}
                  context={{ key: "decided", label: t("admin.hrcomp.sla.col.decided") }}
                  points={slaTypePoints}
                  format={countFormat}
                  xHeader={t("admin.hrcomp.sla.col.type")}
                />
              </div>
            </>
          )}
        </StateBoundary>
      </PanelSection>

      {/* ═══ OPEN EXCEPTIONS ════════════════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.exc.title")}
        icon={AlertTriangle}
        provenance={exceptions.data?.provenance}
      >
        <StateBoundary
          loading={exceptions.isLoading}
          error={exceptions.error ?? undefined}
          onRetry={() => void exceptions.refetch()}
          isEmpty={exceptions.isSuccess && (queue?.total ?? 0) === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.hrcomp.exc.empty.title")}
              hint={t("admin.hrcomp.exc.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            <KpiTile
              label={t("admin.hrcomp.exc.total")}
              value={formatNumber(queue?.total ?? 0)}
              hint={t("admin.hrcomp.exc.totalHint")}
              to={withFilters(ADMIN_ROUTES.alerts, filters)}
            />
            <KpiTile
              label={t("admin.hrcomp.exc.critical")}
              value={formatNumber(queue?.critical ?? 0)}
              tone={(queue?.critical ?? 0) > 0 ? "danger" : "success"}
              hint={t("admin.hrcomp.exc.criticalHint", {
                scanned: formatNumber(queue?.scanned ?? 0),
              })}
              to={withFilters(ADMIN_ROUTES.alerts, filters)}
            />
            <KpiTile
              label={t("admin.hrcomp.exc.people")}
              value={formatNumber(queue?.employeesAffected ?? 0)}
              hint={t("admin.hrcomp.exc.peopleHint")}
            />
          </div>

          {/* The breakdown is a capped page; the totals above are the database's.
              A growing problem must not plateau at 300 and look stable. */}
          {queue?.partial === true ? (
            <Notice tone="warning" className="mt-3">
              {t("admin.hrcomp.exc.sample", {
                scanned: formatNumber(queue.scanned),
                total: formatNumber(queue.total),
              })}
            </Notice>
          ) : null}

          <h4 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("admin.hrcomp.exc.severityTitle")}
          </h4>
          {/* A list rather than four tiles: `bySeverity` keeps its zero buckets on
              purpose, and an empty bucket deserves a line, not a headline. */}
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            {(queue?.bySeverity ?? []).map((bucket) => (
              <div key={bucket.key} className="flex items-baseline gap-2 text-sm">
                <dt className="min-w-0 flex-1 truncate text-muted-foreground">
                  {bucketLabel(SEVERITY_LABEL, bucket.key)}
                </dt>
                <dd className="num shrink-0 font-medium">{formatNumber(bucket.count)}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4">
            {/* No `select`: `/admin/alerts` owns the kind filter and this panel has
                no vocabulary for its query param, so a bar cannot open its own
                kind. The tiles above link to the feed; the bars are a picture and
                every bucket is also a row in the figure's table fallback. */}
            <RankedBarsChart
              title={t("admin.hrcomp.exc.byKindTitle")}
              caption={barsCaption(
                t("admin.hrcomp.exc.byKindCaption"),
                queue?.byKind.length ?? 0,
              )}
              measure={{ key: "exceptions", label: t("admin.hrcomp.exc.series") }}
              points={kindPoints}
              format={countFormat}
              xHeader={t("admin.hrcomp.exc.col.kind")}
            />
          </div>
        </StateBoundary>
      </PanelSection>

      {/* ═══ STATUTORY / COMPLETENESS / ENROLMENT STAMPS ═════════════════════
          ONE read of `v_admin_employee` behind three blocks, so they cannot
          disagree about how many people there are — and therefore ONE empty
          state, ONE caveat list and ONE basis line, printed here rather than
          three times below. */}
      <StateBoundary
        loading={workforce.isLoading}
        error={workforce.error ?? undefined}
        onRetry={() => void workforce.refetch()}
        isEmpty={workforce.isSuccess && (staff?.headcount ?? 0) === 0}
        empty={
          <div className="mt-4">
            <EmptyState
              icon={UserRound}
              title={t("admin.hrcomp.wf.empty.title")}
              hint={t("admin.hrcomp.wf.empty.hint")}
            />
          </div>
        }
        skeletonRows={3}
      >
        <div className="mt-4">
          <SectionCaveats provenance={workforce.data?.provenance} />
        </div>

        <PanelSection
          title={t("admin.hrcomp.stat.title")}
          icon={ShieldCheck}
          caption={t("admin.hrcomp.stat.caption", {
            n: formatNumber(staff?.payrollPopulation ?? 0),
          })}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              {/* No row click: applicability is a flag on a person, and no screen
                  takes "everybody PF applies to" as a filter. A link no screen
                  honours is worse than a table that admits it is a table. */}
              <DataGrid
                columns={statutoryColumns()}
                rows={staff?.statutory ?? []}
                // Four fixed rows — a pager would be furniture around a quartet.
                rowKey={(row) => row.code}
                pageSize={10}
              />
              {statutoryNotRecorded(staff?.statutory) > 0 ? (
                <Notice tone="warning" className="mt-3">
                  {t("admin.hrcomp.stat.notRecorded", {
                    n: formatNumber(statutoryNotRecorded(staff?.statutory)),
                  })}
                </Notice>
              ) : null}
            </div>
            <div>
              <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("admin.hrcomp.stat.regimeTitle")}
              </h4>
              <DonutChart
                slices={regimeSlices}
                title={t("admin.hrcomp.stat.regimeTitle")}
                // The centre carries the DENOMINATOR, never a percentage: the
                // slices are already the proportions, and what a reader cannot
                // infer from them is what they are a proportion OF.
                centreValue={formatNumber(staff?.payrollPopulation ?? 0)}
                centreCaption={t("admin.hrcomp.stat.regimeCentre")}
                valueHeader={t("admin.hrcomp.bio.series")}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                {t("admin.hrcomp.stat.regimeCaption")}
              </p>
            </div>
          </div>
        </PanelSection>

        {/* No section caption: the figure below carries the same sentence, and the
            population is a fact that needs stating once. */}
        <PanelSection title={t("admin.hrcomp.comp.title")} icon={UserRound}>
          <div className="grid grid-cols-2 gap-3">
            <KpiTile
              label={t("admin.hrcomp.comp.mean")}
              value={formatPercent(staff?.meanCompletenessPct ?? null)}
              hint={t("admin.hrcomp.comp.meanHint", {
                n: formatNumber(staff?.completenessSamples ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.hrcomp.comp.done")}
              value={formatNumber(staff?.fullyComplete ?? 0)}
              hint={t("admin.hrcomp.comp.doneHint", {
                n: formatNumber(staff?.fullyComplete ?? 0),
                total: formatNumber(staff?.headcount ?? 0),
              })}
            />
          </div>
          {/* No `select`: `AnalyticsFilters` has no completeness dimension, so a
              band cannot narrow anything. The bars are a picture and say so. */}
          <div className="mt-4">
            <RankedBarsChart
              title={t("admin.hrcomp.comp.title")}
              caption={barsCaption(
                t("admin.hrcomp.comp.chartCaption", {
                  n: formatNumber(staff?.headcount ?? 0),
                }),
                staff?.completeness.length ?? 0,
              )}
              measure={{ key: "people", label: t("admin.hrcomp.comp.series") }}
              points={completenessPoints}
              format={countFormat}
              xHeader={t("admin.hrcomp.comp.col.band")}
            />
          </div>
        </PanelSection>

        <PanelSection
          title={t("admin.hrcomp.stamp.title")}
          icon={Fingerprint}
          caption={t("admin.hrcomp.stamp.hint", {
            n: formatNumber(staff?.attendancePopulation ?? 0),
          })}
        >
          {/* All three carry their denominator IN the value, so none needs a hint
              repeating what the caption above already states: these are stamps on
              the employee record, counted over the people the gate applies to, and
              a DIFFERENT fact from the consent-and-template test further up. */}
          <div className="grid grid-cols-3 gap-3">
            <KpiTile
              label={t("admin.hrcomp.stamp.face")}
              value={ofTotal(staff?.faceStamped ?? 0, staff?.attendancePopulation ?? 0)}
            />
            <KpiTile
              label={t("admin.hrcomp.stamp.fingerprint")}
              value={ofTotal(staff?.fingerprintStamped ?? 0, staff?.attendancePopulation ?? 0)}
            />
            <KpiTile
              label={t("admin.hrcomp.stamp.none")}
              value={ofTotal(staff?.noBiometricStamp ?? 0, staff?.attendancePopulation ?? 0)}
              tone={(staff?.noBiometricStamp ?? 0) > 0 ? "warn" : undefined}
            />
          </div>
        </PanelSection>

        {/* ONE basis line for the one read behind all three blocks above. Repeating
            it per block would read as three relations where there is one. */}
        <SectionBasis provenance={workforce.data?.provenance} />
      </StateBoundary>

      {/* ═══ ASSET CUSTODY ══════════════════════════════════════════════════ */}
      <PanelSection
        title={t("admin.hrcomp.asset.title")}
        icon={Package}
        provenance={custody.data?.provenance}
      >
        <StateBoundary
          loading={custody.isLoading}
          error={custody.error ?? undefined}
          onRetry={() => void custody.refetch()}
          isEmpty={custody.isSuccess && (kit?.open ?? 0) === 0}
          empty={
            <EmptyState
              icon={Package}
              title={t("admin.hrcomp.asset.empty.title")}
              hint={t("admin.hrcomp.asset.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile
              label={t("admin.hrcomp.asset.open")}
              value={formatNumber(kit?.open ?? 0)}
              hint={t("admin.hrcomp.asset.openHint")}
              to={withFilters("/admin/assets/allocations", filters)}
            />
            <KpiTile
              label={t("admin.hrcomp.asset.overdue")}
              value={formatNumber(kit?.returnOverdue ?? 0)}
              tone={(kit?.returnOverdue ?? 0) > 0 ? "warn" : undefined}
              hint={t("admin.hrcomp.asset.overdueHint")}
              to={withFilters("/admin/assets/returns", filters)}
            />
            <KpiTile
              label={t("admin.hrcomp.asset.exited")}
              value={formatNumber(kit?.heldByExited ?? 0)}
              tone={(kit?.heldByExited ?? 0) > 0 ? "danger" : undefined}
              hint={t("admin.hrcomp.asset.exitedHint")}
              to={withFilters("/admin/assets/exit-liability", filters)}
            />
            {/* Counted, not folded into `current`. An id this admin's scope cannot
                resolve is unknown — assuming employment would suppress exactly the
                finding the join exists to produce. */}
            <KpiTile
              label={t("admin.hrcomp.asset.unknown")}
              value={formatNumber(kit?.heldByUnknown ?? 0)}
              tone={(kit?.heldByUnknown ?? 0) > 0 ? "warn" : undefined}
              hint={t("admin.hrcomp.asset.unknownHint")}
            />
          </div>

          {/* The `count=exact` total covers the whole register; the verdicts below
              were joined over a capped page. Both numbers, said plainly. */}
          {kit?.partial === true ? (
            <Notice tone="warning" className="mt-3">
              {t("admin.hrcomp.partial", {
                scanned: formatNumber(kit.scanned),
                total: formatNumber(kit.open),
              })}
            </Notice>
          ) : null}

          <h4 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("admin.hrcomp.asset.findingTitle")}
          </h4>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            {t("admin.hrcomp.asset.findingCaption")}
          </p>
          {(kit?.exitedRows.length ?? 0) === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.hrcomp.asset.clean.title")}
              hint={t("admin.hrcomp.asset.clean.hint")}
            />
          ) : (
            <DataGrid
              columns={custodyColumns()}
              rows={kit?.exitedRows ?? []}
              rowKey={(row) => row.allocation_id}
              pageSize={10}
              onRowClick={(row) => openPerson(row.employee_code)}
            />
          )}
        </StateBoundary>
      </PanelSection>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Denominators that are not row counts
// -----------------------------------------------------------------------------

/**
 * How many people on payroll have NO `employee_statutory` row at all.
 *
 * The four flags are `NOT NULL` on that table and reach `v_admin_employee`
 * through a LEFT JOIN, so a person with no row is NULL on all four and every
 * `notRecorded` count is the same number. The MAX is taken rather than the first
 * arm so that if they ever do diverge — a column dropped, a view rewritten — this
 * reports the larger figure ("at least this many") instead of quietly picking the
 * smallest one.
 */
function statutoryNotRecorded(flags: readonly FlagCoverage[] | undefined): number {
  return (flags ?? []).reduce((worst, flag) => Math.max(worst, flag.notRecorded), 0);
}

// -----------------------------------------------------------------------------
// Grid columns
// -----------------------------------------------------------------------------

function expiringColumns(): DataGridColumn<DocumentExpiryRow>[] {
  return [
    {
      key: "person",
      header: t("admin.hrcomp.doc.col.person"),
      render: (row) => <PersonCell name={row.display_name} code={row.employee_code} />,
      sortable: true,
      sortValue: (row) => row.display_name,
    },
    {
      key: "department",
      header: t("admin.hrcomp.doc.col.department"),
      hideBelow: "md",
      render: (row) => dash(row.department_name),
      sortable: true,
      sortValue: (row) => row.department_name ?? "",
    },
    {
      key: "document",
      header: t("admin.hrcomp.doc.col.document"),
      render: (row) => row.document_type_name,
      sortable: true,
      sortValue: (row) => row.document_type_name,
    },
    {
      key: "expires",
      header: t("admin.hrcomp.doc.col.expires"),
      // The status predicate guarantees a non-null expiry on every row here, but
      // `fmtCivilDate` is null-safe anyway: an em dash beats an exception.
      render: (row) => fmtCivilDate(row.expiry_date),
      sortable: true,
      sortValue: (row) => row.expiry_date ?? "",
    },
    {
      key: "status",
      header: t("admin.hrcomp.doc.col.status"),
      hideBelow: "sm",
      // The shared chip map, so `expiring_soon` reads the same here as on the
      // repository, the pending queue and the expiry tracker (D-10).
      render: (row) => <StatusChip status={row.compliance_status} map={COMPLIANCE_CHIP} />,
    },
  ];
}

function policyColumns(): DataGridColumn<PolicyAckRow>[] {
  return [
    {
      key: "policy",
      header: t("admin.hrcomp.pol.col.policy"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.document_title}</span>
          <span className="text-xs text-muted-foreground">{row.document_type_name}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.document_title,
    },
    {
      key: "assigned",
      header: t("admin.hrcomp.pol.col.assigned"),
      align: "right",
      render: (row) => formatNumber(row.assigned),
      sortable: true,
      sortValue: (row) => row.assigned,
    },
    {
      key: "acknowledged",
      header: t("admin.hrcomp.pol.col.acknowledged"),
      align: "right",
      render: (row) => formatNumber(row.acknowledged),
      sortable: true,
      sortValue: (row) => row.acknowledged,
    },
    {
      key: "share",
      header: t("admin.hrcomp.pol.col.share"),
      align: "right",
      // NOT `?? 0`: the view NULLIFs the denominator, so a policy nobody was
      // assigned has no share — and printing 0% would put it at the bottom of a
      // list it does not belong in at all.
      render: (row) => formatPercent(row.acknowledged_pct),
      sortable: true,
      sortValue: (row) => row.acknowledged_pct,
    },
    {
      key: "overdue",
      header: t("admin.hrcomp.pol.col.overdue"),
      align: "right",
      hideBelow: "md",
      render: (row) =>
        row.overdue > 0 ? (
          <span className="text-destructive">{formatNumber(row.overdue)}</span>
        ) : (
          <span className="text-muted-foreground">{formatNumber(0)}</span>
        ),
      sortable: true,
      sortValue: (row) => row.overdue,
    },
    {
      key: "due",
      header: t("admin.hrcomp.pol.col.due"),
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.earliest_open_due_on),
      sortable: true,
      sortValue: (row) => row.earliest_open_due_on ?? "",
    },
  ];
}

/**
 * `document_acknowledgements` is a join table: it carries `employee_id` and no
 * name, so the label comes from the ONE shared directory map every admin screen
 * uses. An id outside admin scope says so rather than printing a uuid.
 */
function unacknowledgedColumns(labels: EmployeeLabelMap | undefined): DataGridColumn<AdminAck>[] {
  return [
    {
      key: "person",
      header: t("admin.hrcomp.pol.col.person"),
      render: (row) => {
        const label = labels?.get(row.employee_id);
        if (label === undefined) {
          return labels === undefined ? (
            <span className="text-muted-foreground">{t("app.loading")}</span>
          ) : (
            <span className="text-muted-foreground">{t("admin.person.outOfScope")}</span>
          );
        }
        return <PersonCell name={label.name} code={label.code} secondary={label.department} />;
      },
      sortable: true,
      sortValue: (row) => labels?.get(row.employee_id)?.name ?? "",
    },
    {
      key: "policy",
      header: t("admin.hrcomp.pol.col.policy"),
      render: (row) => dash(row.documents?.title),
      sortable: true,
      sortValue: (row) => row.documents?.title ?? "",
    },
    {
      key: "state",
      header: t("admin.hrcomp.pol.col.state"),
      render: (row) => <StatusChip status={row.status} map={ACK_STATUS_CHIP} />,
      sortable: true,
      sortValue: (row) => row.status,
    },
    {
      key: "due",
      header: t("admin.hrcomp.pol.col.due"),
      render: (row) => fmtCivilDate(row.due_on),
      sortable: true,
      // Nulls sort LAST here, as they do in the read: a policy with no deadline
      // must not squat above one that has a date on it. `DataGrid` coerces a null
      // accessor to '' — which sorts first — so a far-future civil date is the
      // sentinel. It is a real comparable date rather than a sentinel codepoint,
      // whose position under ICU collation is not something to bet a sort on.
      sortValue: (row) => row.due_on ?? "9999-12-31",
    },
    {
      key: "opened",
      header: t("admin.hrcomp.pol.col.opened"),
      hideBelow: "md",
      // "Never opened" is a different conversation from "read it and did not
      // sign", so the two are not collapsed into one blank cell.
      render: (row) =>
        row.first_opened_at === null ? (
          <span className="text-muted-foreground">{t("admin.hrcomp.pol.opened.no")}</span>
        ) : (
          <span>{t("admin.hrcomp.pol.opened.yes")}</span>
        ),
      sortable: true,
      sortValue: (row) => (row.first_opened_at === null ? 0 : 1),
    },
  ];
}

function gapColumns(): DataGridColumn<EnrolmentGapRow>[] {
  return [
    {
      key: "person",
      header: t("admin.hrcomp.bio.col.person"),
      render: (row) => <PersonCell name={row.display_name} code={row.employee_code} />,
      sortable: true,
      sortValue: (row) => row.display_name,
    },
    {
      key: "department",
      header: t("admin.hrcomp.bio.col.department"),
      hideBelow: "md",
      render: (row) => dash(row.department_name),
      sortable: true,
      sortValue: (row) => row.department_name ?? "",
    },
    {
      key: "reason",
      header: t("admin.hrcomp.bio.col.reason"),
      // The VIEW's verdict, rendered as text and not as a red chip. A withdrawn
      // consent in this column is a fact about a right somebody exercised.
      render: (row) =>
        row.gap_kind === null
          ? bucketLabel(GAP_KIND_LABEL, GAP_KIND_UNKNOWN)
          : bucketLabel(GAP_KIND_LABEL, row.gap_kind),
      sortable: true,
      sortValue: (row) => row.gap_kind ?? "",
    },
    {
      key: "joined",
      header: t("admin.hrcomp.bio.col.joined"),
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.date_of_join),
      sortable: true,
      sortValue: (row) => row.date_of_join,
    },
  ];
}

function gateColumns(): DataGridColumn<KioskHealthRow>[] {
  return [
    {
      key: "device",
      header: t("admin.hrcomp.gate.col.device"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.label}</span>
          <span className="num text-xs text-muted-foreground">{row.device_code}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.device_code,
    },
    {
      key: "date",
      header: t("admin.hrcomp.gate.col.date"),
      render: (row) => fmtCivilDate(row.ist_date),
      sortable: true,
      sortValue: (row) => row.ist_date,
    },
    {
      key: "attempts",
      header: t("admin.hrcomp.gate.col.attempts"),
      align: "right",
      // The denominator sits beside the rate in every row, because a rate without
      // one ranks the tablet nobody used.
      render: (row) => formatNumber(row.total_attempts),
      sortable: true,
      sortValue: (row) => row.total_attempts,
    },
    {
      key: "matched",
      header: t("admin.hrcomp.gate.col.matched"),
      align: "right",
      hideBelow: "sm",
      render: (row) => formatNumber(row.matched),
      sortable: true,
      sortValue: (row) => row.matched,
    },
    {
      key: "rate",
      header: t("admin.hrcomp.gate.col.rate"),
      align: "right",
      // The view's own per-row percentage, untoned. A colour here would need a
      // threshold, and "below 90% is bad" is a rule nobody in this product has
      // set — the list is already ordered worst-first and says so in its caption.
      render: (row) => formatPercent(row.match_success_pct),
      sortable: true,
      sortValue: (row) => row.match_success_pct,
    },
    {
      key: "p95",
      header: t("admin.hrcomp.gate.col.p95"),
      align: "right",
      hideBelow: "md",
      render: (row) => msText(row.p95_latency_ms),
      sortable: true,
      sortValue: (row) => row.p95_latency_ms,
    },
  ];
}

function slaColumns(): DataGridColumn<ApprovalSlaLike>[] {
  return [
    {
      key: "approver",
      header: t("admin.hrcomp.sla.col.approver"),
      render: (row) => (
        <PersonCell name={row.approver_display_name} code={row.approver_employee_code} />
      ),
      sortable: true,
      sortValue: (row) => row.approver_display_name,
    },
    {
      key: "type",
      header: t("admin.hrcomp.sla.col.type"),
      render: (row) => row.request_type_name,
      sortable: true,
      sortValue: (row) => row.request_type_name,
    },
    {
      key: "breached",
      header: t("admin.hrcomp.sla.col.breached"),
      align: "right",
      // The measure, first among the counts and toned when non-zero.
      render: (row) =>
        row.breached > 0 ? (
          <span className="text-destructive">{formatNumber(row.breached)}</span>
        ) : (
          <span className="text-muted-foreground">{formatNumber(0)}</span>
        ),
      sortable: true,
      sortValue: (row) => row.breached,
    },
    {
      key: "decided",
      header: t("admin.hrcomp.sla.col.decided"),
      align: "right",
      render: (row) => formatNumber(row.decided),
      sortable: true,
      sortValue: (row) => row.decided,
    },
    {
      key: "onTime",
      header: t("admin.hrcomp.sla.col.onTime"),
      align: "right",
      hideBelow: "md",
      render: (row) => formatNumber(row.on_time),
      sortable: true,
      sortValue: (row) => row.on_time,
    },
    {
      key: "avgHours",
      header: t("admin.hrcomp.sla.col.avgHours"),
      align: "right",
      hideBelow: "lg",
      // The server states this in decimal hours; DR-21 forbids printing '18.5'
      // beside a '7h 50m' elsewhere on the same screen, so it is converted.
      render: (row) => fmtDurationFromHours(row.avg_hours_to_decide),
      sortable: true,
      sortValue: (row) => row.avg_hours_to_decide,
    },
  ];
}

function statutoryColumns(): DataGridColumn<FlagCoverage>[] {
  return [
    {
      key: "head",
      header: t("admin.hrcomp.stat.col.head"),
      render: (row) => t(FLAG_LABEL[row.code]),
    },
    {
      key: "applicable",
      header: t("admin.hrcomp.stat.col.applicable"),
      align: "right",
      render: (row) => formatNumber(row.applicable),
      sortable: true,
      sortValue: (row) => row.applicable,
    },
    {
      key: "notApplicable",
      header: t("admin.hrcomp.stat.col.notApplicable"),
      align: "right",
      hideBelow: "sm",
      render: (row) => formatNumber(row.notApplicable),
      sortable: true,
      sortValue: (row) => row.notApplicable,
    },
    {
      key: "notRecorded",
      header: t("admin.hrcomp.stat.col.notRecorded"),
      align: "right",
      // Out of the share's denominator on purpose, and toned so it reads as the
      // finding it is: "we never filed it" is not "it does not apply".
      render: (row) =>
        row.notRecorded > 0 ? (
          <span className="text-warning">{formatNumber(row.notRecorded)}</span>
        ) : (
          <span className="text-muted-foreground">{formatNumber(0)}</span>
        ),
      sortable: true,
      sortValue: (row) => row.notRecorded,
    },
    {
      key: "share",
      header: t("admin.hrcomp.stat.col.share"),
      align: "right",
      // The two columns it divided are right there, and the section caption names
      // the population — so this percentage is checkable on the row it sits in.
      render: (row) => formatPercent(row.share.pct),
      sortable: true,
      sortValue: (row) => row.share.pct,
    },
  ];
}

function custodyColumns(): DataGridColumn<CustodyHolderRow>[] {
  return [
    {
      key: "asset",
      header: t("admin.hrcomp.asset.col.asset"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.asset_name}</span>
          <span className="num text-xs text-muted-foreground">{row.asset_tag}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.asset_name,
    },
    {
      key: "holder",
      header: t("admin.hrcomp.asset.col.holder"),
      render: (row) => <PersonCell name={row.display_name} code={row.employee_code} />,
      sortable: true,
      sortValue: (row) => row.display_name ?? "",
    },
    {
      key: "department",
      header: t("admin.hrcomp.asset.col.department"),
      hideBelow: "lg",
      render: (row) => dash(row.department_name),
      sortable: true,
      sortValue: (row) => row.department_name ?? "",
    },
    {
      key: "state",
      header: t("admin.hrcomp.asset.col.state"),
      render: (row) => <StatusChip status={row.verdict} map={VERDICT_CHIP} />,
      sortable: true,
      sortValue: (row) => row.verdict,
    },
    {
      key: "days",
      header: t("admin.hrcomp.asset.col.days"),
      align: "right",
      hideBelow: "sm",
      // `days_in_custody` is the view's own count. Nothing here subtracts dates.
      render: (row) => dash(row.days_in_custody, formatNumber),
      sortable: true,
      sortValue: (row) => row.days_in_custody,
    },
    {
      key: "lastDay",
      header: t("admin.hrcomp.asset.col.lastDay"),
      hideBelow: "md",
      render: (row) => fmtCivilDate(row.lastWorkingDay),
      sortable: true,
      sortValue: (row) => row.lastWorkingDay ?? "",
    },
  ];
}
